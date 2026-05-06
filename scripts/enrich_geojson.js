#!/usr/bin/env node
'use strict';

/**
 * scripts/enrich_geojson.js
 *
 * Bakes context information into the CI-preprocessed accident GeoJSON
 * files, so that the static web application gets elevation, OSM-road
 * and traffic context without paying any runtime cost.
 *
 * Input:  out/output_all_years_<city>.geojson
 * Output: out/output_all_years_<city>.geojson  (in-place, enriched)
 *         out/ways_<city>.json                  (per-way attribute table)
 *         out/output_all_years_<city>.enrichment.meta.json (sidecar)
 *
 * Design constraints (see plan §C):
 *   - Compact field encoding: 1-decimal floats, drop nulls.
 *   - High-cardinality categoricals (highway, surface, …) are emitted as
 *     short integer codes resolved against a top-level
 *     `properties.enrichmentDicts` lookup table.
 *   - Per-way attributes (highway, maxspeed, lanes, surface, cycleway,
 *     osm_incline, road-segment slope, traffic_*) live in the companion
 *     `ways_<city>.json` keyed by `matched_way_id`. Each accident
 *     feature only carries `matched_way_id` so the *initial* GeoJSON
 *     payload is essentially the same size as today.
 *   - The script is idempotent: re-running it on already-enriched files
 *     produces a stable result. Pre-existing enrichment fields are
 *     stripped at the start of each run before the providers add fresh
 *     values.
 *
 * Providers (OSM road-match, DEM elevation/slope, traffic counts) are
 * pluggable. The skeleton ships with offline file-based providers driven
 * by env vars (ENRICH_OSM_DATA_DIR / ENRICH_DEM_DATA_DIR /
 * ENRICH_TRAFFIC_DATA_DIR). When a directory is missing or does not
 * contain a per-city dataset, that stage is silently skipped — every
 * field is optional, so the workflow keeps working even when a single
 * source is temporarily unavailable.
 *
 * Usage:
 *
 *     node scripts/enrich_geojson.js                    # all cities from cities.txt
 *     node scripts/enrich_geojson.js --city Bonn         # one city
 *     node scripts/enrich_geojson.js --no-osm --no-dem   # skip stages
 *     node scripts/enrich_geojson.js --json              # machine-readable summary
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ENRICHMENT_SCRIPT_VERSION = '1.0.0';

// Field groups (used for stripping previous enrichment + provenance).
const PER_FEATURE_FIELDS = [
  'matched_way_id',
  'road_context_source',
  'elevation_m',
  'slope_percent',
  'slope_abs_percent',
  'slope_class',
  'slope_source',
  'slope_confidence',
  'traffic_proxy_class',
];

const PER_WAY_FIELDS = [
  'highway',
  'maxspeed',
  'lanes',
  'surface',
  'cycleway',
  'osm_incline',
  'road_slope_percent',
  'traffic_volume_value',
  'traffic_volume_unit',
  'traffic_volume_year',
  'traffic_volume_source',
  'traffic_volume_confidence',
];

// Categorical fields that benefit from int-code encoding via enrichmentDicts.
// These live in ways_<city>.json (per-way), but the dict is shared at the
// FeatureCollection top level for symmetry with future per-feature dicts.
const DICT_FIELDS = ['highway', 'surface', 'cycleway'];

// Slope thresholds (percent). Documented in docs/enrichment.md.
const SLOPE_CLASS_THRESHOLDS = [
  { max: 2,  cls: 'flat'      },
  { max: 4,  cls: 'gentle'    },
  { max: 6,  cls: 'moderate'  },
  { max: 10, cls: 'steep'     },
  { max: Infinity, cls: 'very_steep' },
];

// Traffic-volume → proxy-class thresholds (DTV vehicles/day). Documented.
const TRAFFIC_PROXY_THRESHOLDS = [
  { max: 1000,  cls: 'low'        },
  { max: 5000,  cls: 'medium'     },
  { max: 15000, cls: 'high'       },
  { max: Infinity, cls: 'very_high' },
];

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function slugCity(name) {
  return String(name)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readCitiesTxt(repoRoot) {
  const p = path.join(repoRoot, 'cities.txt');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8')
    .split('\n')
    .map(l => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function round1(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.round(n * 10) / 10;
}

function classifyFromThresholds(value, thresholds) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const v = Math.abs(value);
  for (const t of thresholds) if (v <= t.max) return t.cls;
  return undefined;
}

function classifySlope(percent) {
  return classifyFromThresholds(percent, SLOPE_CLASS_THRESHOLDS);
}

function classifyTrafficProxy(dtv) {
  return classifyFromThresholds(dtv, TRAFFIC_PROXY_THRESHOLDS);
}

function gzippedSize(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const raw = fs.readFileSync(filePath);
  return zlib.gzipSync(raw, { level: 9 }).length;
}

// Strip writes "undefined" instead of "null" so that JSON.stringify drops
// the key entirely. Keeps the on-disk payload tight (see plan §C.1).
function stripUndefined(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

// ---------------------------------------------------------------------------
// Providers
//
// Each provider receives (citySlug, providerOpts) and returns either a
// per-feature lookup (lat,lon,props) → partial enrichment, or a per-way
// table. When the provider data is not available, returns null and the
// stage is skipped — the corresponding fields stay undefined.
//
// All providers are file-based to keep the script CI-friendly: real
// sources (Overpass, SRTM30, BASt SDV) are downloaded once per workflow
// run by an outer step (cached via actions/cache) and dropped into the
// directories named by the env vars.
// ---------------------------------------------------------------------------

// Precision (decimal places) used to bucket lat/lon when looking up
// per-point provider data. 5 dp ≈ 1.1 m at German latitudes — enough
// to distinguish adjacent road segments without false bucket joins.
const POINT_LOOKUP_PRECISION = 5;

function pointKey(lat, lon) {
  return `${lat.toFixed(POINT_LOOKUP_PRECISION)},${lon.toFixed(POINT_LOOKUP_PRECISION)}`;
}

function loadOsmProvider(citySlug) {
  const dir = process.env.ENRICH_OSM_DATA_DIR;
  if (!dir) return null;
  const file = path.join(dir, `osm_${citySlug}.json`);
  if (!fs.existsSync(file)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.warn(`[enrich] OSM data for ${citySlug} unreadable: ${e.message}`); return null; }
  // Expected shape: { ways: { "<wayId>": {highway, maxspeed, lanes, surface, cycleway, osm_incline} },
  //                   index: [{lat, lon, way_id}], source: "...", extractDate: "..." }
  const wayIndex = new Map();
  if (Array.isArray(data.index)) {
    for (const e of data.index) {
      if (typeof e?.lat === 'number' && typeof e?.lon === 'number' && e.way_id != null) {
        wayIndex.set(pointKey(e.lat, e.lon), String(e.way_id));
      }
    }
  }
  return {
    name: 'osm',
    source: data.source || 'OpenStreetMap (Overpass)',
    extractDate: data.extractDate || null,
    matchFeature(lat, lon) {
      const wayId = wayIndex.get(pointKey(lat, lon));
      if (!wayId) return null;
      return { matched_way_id: wayId, road_context_source: 'osm' };
    },
    wayAttributes(wayId) {
      const w = data.ways && data.ways[wayId];
      if (!w) return null;
      return stripUndefined({
        highway:      w.highway      != null ? String(w.highway) : undefined,
        maxspeed:     Number.isFinite(+w.maxspeed) ? +w.maxspeed : undefined,
        lanes:        Number.isFinite(+w.lanes)    ? +w.lanes    : undefined,
        surface:      w.surface      != null ? String(w.surface) : undefined,
        cycleway:     w.cycleway     != null ? String(w.cycleway): undefined,
        osm_incline:  w.osm_incline  != null ? String(w.osm_incline) : undefined,
      });
    },
  };
}

function loadDemProvider(citySlug) {
  const dir = process.env.ENRICH_DEM_DATA_DIR;
  if (!dir) return null;
  const file = path.join(dir, `dem_${citySlug}.json`);
  if (!fs.existsSync(file)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.warn(`[enrich] DEM data for ${citySlug} unreadable: ${e.message}`); return null; }
  // Expected shape: { source, resolution_m, points: [{lat, lon, elevation_m, slope_percent, confidence}],
  //                   wayElevations: { "<wayId>": {road_slope_percent} } }
  const pointIndex = new Map();
  if (Array.isArray(data.points)) {
    for (const p of data.points) {
      if (typeof p?.lat === 'number' && typeof p?.lon === 'number') {
        pointIndex.set(pointKey(p.lat, p.lon), p);
      }
    }
  }
  return {
    name: 'dem',
    source: data.source || 'SRTM30',
    resolutionM: data.resolution_m || null,
    elevateFeature(lat, lon) {
      const p = pointIndex.get(pointKey(lat, lon));
      if (!p) return null;
      const elev = round1(p.elevation_m);
      const slope = round1(p.slope_percent);
      return stripUndefined({
        elevation_m:        elev,
        slope_percent:      slope,
        slope_abs_percent:  slope != null ? Math.abs(slope) : undefined,
        slope_class:        classifySlope(slope),
        slope_source:       data.source || 'SRTM30',
        slope_confidence:   p.confidence || undefined,
      });
    },
    wayElevation(wayId) {
      const w = data.wayElevations && data.wayElevations[wayId];
      if (!w) return null;
      return stripUndefined({ road_slope_percent: round1(w.road_slope_percent) });
    },
  };
}

function loadTrafficProvider(citySlug) {
  const dir = process.env.ENRICH_TRAFFIC_DATA_DIR;
  if (!dir) return null;
  const file = path.join(dir, `traffic_${citySlug}.json`);
  if (!fs.existsSync(file)) return null;
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.warn(`[enrich] Traffic data for ${citySlug} unreadable: ${e.message}`); return null; }
  // Expected shape: { source, datasetVersion,
  //                   ways: { "<wayId>": { value, unit, year, confidence } } }
  return {
    name: 'traffic',
    source: data.source || null,
    datasetVersion: data.datasetVersion || null,
    wayTraffic(wayId) {
      const w = data.ways && data.ways[wayId];
      if (!w || !Number.isFinite(+w.value)) return null;
      const value = +w.value;
      return stripUndefined({
        traffic_volume_value:      value,
        traffic_volume_unit:       w.unit || 'DTV',
        traffic_volume_year:       Number.isFinite(+w.year) ? +w.year : undefined,
        traffic_volume_source:     data.source || undefined,
        traffic_volume_confidence: w.confidence || undefined,
        // Per-feature companion (denormalised onto the accident itself)
        // is computed in enrichCity once we know the way's class.
        _proxy_class:              classifyTrafficProxy(value),
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Core enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a single city in memory. Returns
 *   { geojson, ways, meta, stats }
 *
 * @param {object}  geojson      Parsed FeatureCollection (mutated in place).
 * @param {string}  citySlug     normalised slug, e.g. "bonn".
 * @param {object}  opts
 * @param {boolean} opts.useOsm
 * @param {boolean} opts.useDem
 * @param {boolean} opts.useTraffic
 * @param {object}  opts.providers   Provider overrides for tests.
 */
function enrichCity(geojson, citySlug, opts = {}) {
  const useOsm     = opts.useOsm     !== false;
  const useDem     = opts.useDem     !== false;
  const useTraffic = opts.useTraffic !== false;

  const osm     = useOsm     ? (opts.providers?.osm     || loadOsmProvider(citySlug))     : null;
  const dem     = useDem     ? (opts.providers?.dem     || loadDemProvider(citySlug))     : null;
  const traffic = useTraffic ? (opts.providers?.traffic || loadTrafficProvider(citySlug)) : null;

  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error(`enrichCity(${citySlug}): not a FeatureCollection`);
  }

  // Strip prior enrichment fields so the script is idempotent. We do NOT
  // touch other accident properties (see plan §C.6 — loader on the hot
  // path stays unchanged, accident schema is invariant).
  for (const f of geojson.features) {
    if (!f || !f.properties) continue;
    for (const k of PER_FEATURE_FIELDS) delete f.properties[k];
  }
  if (geojson.properties && typeof geojson.properties === 'object') {
    delete geojson.properties.enrichmentDicts;
    delete geojson.properties.enrichmentSummary;
  }

  // Collect way attributes lazily, only for ways we actually touch.
  const ways = {};

  let nMatched = 0, nElevated = 0, nTraffic = 0;

  for (const f of geojson.features) {
    if (!f || f.geometry?.type !== 'Point') continue;
    const [lon, lat] = f.geometry.coordinates || [];
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;

    const props = f.properties = f.properties || {};

    let wayId = null;
    if (osm) {
      const m = osm.matchFeature(lat, lon);
      if (m) {
        wayId = m.matched_way_id;
        props.matched_way_id     = wayId;
        props.road_context_source = m.road_context_source;
        nMatched++;
      }
    }

    if (dem) {
      const e = dem.elevateFeature(lat, lon);
      if (e) {
        Object.assign(props, e);
        nElevated++;
      }
    }

    if (wayId) {
      const w = ways[wayId] || (ways[wayId] = {});
      if (osm) {
        const a = osm.wayAttributes(wayId);
        if (a) Object.assign(w, a);
      }
      if (dem) {
        const a = dem.wayElevation(wayId);
        if (a) Object.assign(w, a);
      }
      if (traffic) {
        const t = traffic.wayTraffic(wayId);
        if (t) {
          const proxyClass = t._proxy_class;
          delete t._proxy_class;
          Object.assign(w, t);
          if (proxyClass) {
            // Per-feature proxy class is the only traffic crumb we
            // denormalise onto the accident itself, because the UI
            // colours points by it without paying the lazy-load cost.
            props.traffic_proxy_class = proxyClass;
            nTraffic++;
          }
        }
      }
      stripUndefined(w);
    }

    stripUndefined(props);
  }

  // Build int-code dictionaries for high-cardinality categorical way fields
  // (see plan §C.1). We rewrite the values in `ways` to small integers and
  // emit the lookup table at the FeatureCollection top level so the loader
  // (js/ua.context_layers.js) can resolve them on read.
  const dicts = {};
  for (const field of DICT_FIELDS) {
    const seen = new Map();
    for (const wayId of Object.keys(ways)) {
      const v = ways[wayId][field];
      if (v == null) continue;
      const key = String(v);
      if (!seen.has(key)) seen.set(key, seen.size);
      ways[wayId][field] = seen.get(key);
    }
    if (seen.size > 0) {
      // Materialise as a positional array; index = code.
      const arr = new Array(seen.size);
      for (const [v, i] of seen.entries()) arr[i] = v;
      dicts[field] = arr;
    }
  }
  if (Object.keys(dicts).length > 0) {
    geojson.properties = geojson.properties || {};
    geojson.properties.enrichmentDicts = dicts;
  }

  const meta = {
    schemaVersion: 1,
    enrichmentScriptVersion: ENRICHMENT_SCRIPT_VERSION,
    citySlug,
    generatedAt: new Date().toISOString(),
    sources: stripUndefined({
      osm: osm     ? stripUndefined({ source: osm.source, extractDate: osm.extractDate }) : undefined,
      dem: dem     ? stripUndefined({ source: dem.source, resolutionM: dem.resolutionM }) : undefined,
      traffic: traffic ? stripUndefined({ source: traffic.source, datasetVersion: traffic.datasetVersion }) : undefined,
    }),
    counts: {
      features: geojson.features.length,
      matchedToWay: nMatched,
      withElevation: nElevated,
      withTrafficProxy: nTraffic,
      ways: Object.keys(ways).length,
    },
    dictFields: Object.keys(dicts),
  };

  return { geojson, ways, meta };
}

// ---------------------------------------------------------------------------
// File I/O wrapper
// ---------------------------------------------------------------------------

function pathsForCity(repoRoot, citySlug) {
  const outDir = path.join(repoRoot, 'out');
  return {
    geojson: path.join(outDir, `output_all_years_${citySlug}.geojson`),
    ways:    path.join(outDir, `ways_${citySlug}.json`),
    meta:    path.join(outDir, `output_all_years_${citySlug}.enrichment.meta.json`),
  };
}

function enrichCityFile(repoRoot, citySlug, opts) {
  const p = pathsForCity(repoRoot, citySlug);
  if (!fs.existsSync(p.geojson)) {
    return { citySlug, skipped: true, reason: 'no input geojson' };
  }
  const sizeBefore = gzippedSize(p.geojson);
  const raw = fs.readFileSync(p.geojson, 'utf8');
  let geojson;
  try { geojson = JSON.parse(raw); }
  catch (e) { return { citySlug, skipped: true, reason: `invalid JSON: ${e.message}` }; }

  const { ways, meta } = enrichCity(geojson, citySlug, opts);

  // Write enriched GeoJSON. We deliberately write compact (no
  // indentation) — matches the existing on-disk format produced by
  // convertAmt2gmaps.sh, and is the smallest viable representation.
  fs.writeFileSync(p.geojson, JSON.stringify(geojson));
  fs.writeFileSync(p.ways, JSON.stringify(ways));
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + '\n');

  const sizeAfter = gzippedSize(p.geojson);
  return {
    citySlug, skipped: false, meta,
    sizes: { gzipBefore: sizeBefore, gzipAfter: sizeAfter, gzipDelta: sizeAfter - sizeBefore },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    cities: [],
    useOsm: true,
    useDem: true,
    useTraffic: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-osm')     opts.useOsm = false;
    else if (a === '--no-dem')     opts.useDem = false;
    else if (a === '--no-traffic') opts.useTraffic = false;
    else if (a === '--json')       opts.json = true;
    else if (a === '--city')       { opts.cities.push(argv[++i]); }
    else if (a === '--help' || a === '-h') { opts.help = true; }
    else if (a.startsWith('--')) { console.warn(`[enrich] unknown flag ignored: ${a}`); }
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
`Usage: node scripts/enrich_geojson.js [options]

  --city <name>     enrich only this city (repeatable)
                    default: every city listed in cities.txt
  --no-osm          skip OSM road-match stage
  --no-dem          skip DEM elevation/slope stage
  --no-traffic      skip traffic-volume stage
  --json            emit machine-readable summary

Provider data dirs (env vars; missing dir disables stage silently):
  ENRICH_OSM_DATA_DIR      → osm_<city>.json
  ENRICH_DEM_DATA_DIR      → dem_<city>.json
  ENRICH_TRAFFIC_DATA_DIR  → traffic_<city>.json
`
  );
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  const repoRoot = path.resolve(__dirname, '..');
  let citySlugs = opts.cities.map(slugCity);
  if (citySlugs.length === 0) citySlugs = readCitiesTxt(repoRoot).map(slugCity);
  if (citySlugs.length === 0) {
    console.error('[enrich] no cities to process (cities.txt empty and no --city given)');
    return 2;
  }

  const summary = { script: ENRICHMENT_SCRIPT_VERSION, cities: [] };
  for (const slug of citySlugs) {
    const r = enrichCityFile(repoRoot, slug, opts);
    summary.cities.push(r);
    if (!opts.json) {
      if (r.skipped) {
        console.log(`[enrich] ${slug}: SKIP (${r.reason})`);
      } else {
        const d = r.sizes.gzipDelta;
        const sign = d >= 0 ? '+' : '';
        console.log(
          `[enrich] ${slug}: ${r.meta.counts.features} features, ` +
          `${r.meta.counts.matchedToWay} matched, ` +
          `${r.meta.counts.withElevation} elevated, ` +
          `${r.meta.counts.withTrafficProxy} traffic, ` +
          `${r.meta.counts.ways} ways, ` +
          `gzip ${sign}${d}B`
        );
      }
    }
  }
  if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  ENRICHMENT_SCRIPT_VERSION,
  SLOPE_CLASS_THRESHOLDS,
  TRAFFIC_PROXY_THRESHOLDS,
  PER_FEATURE_FIELDS,
  PER_WAY_FIELDS,
  DICT_FIELDS,
  slugCity,
  classifySlope,
  classifyTrafficProxy,
  enrichCity,
  enrichCityFile,
  pathsForCity,
  parseArgs,
  main,
};
