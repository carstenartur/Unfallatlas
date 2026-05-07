#!/usr/bin/env node
'use strict';

/**
 * scripts/producers/osm_producer.js
 *
 * First working producer for the GitHub Actions enrichment workflow.
 * Generates the `osm_<city>.json` files that
 * `scripts/enrich_geojson.js`'s `loadOsmProvider` consumes (see
 * `docs/enrichment.md`).
 *
 * For each city listed in `cities.txt` (or supplied via --city) the
 * producer:
 *
 *   1. Reads `out/output_all_years_<slug>.geojson`.
 *   2. Computes the bounding box of the accident points.
 *   3. Queries the public Overpass API for `way[highway]` features
 *      (with geometry) inside that bbox.
 *   4. Snaps every accident point to the nearest way (capped at a
 *      configurable max-distance, default 50 m) and emits the
 *      `osm_<slug>.json` payload expected by the enrichment script:
 *
 *        {
 *          ways:  { "<wayId>": { highway, maxspeed, lanes, surface,
 *                                cycleway, osm_incline } },
 *          index: [ { lat, lon, way_id } ],
 *          source:      "OpenStreetMap (Overpass)",
 *          extractDate: "YYYY-MM-DD"
 *        }
 *
 * The output directory is taken from --out-dir, $ENRICH_OSM_DATA_DIR
 * or defaults to `.enrichment-cache/osm`. Re-running the producer is
 * idempotent: each city overwrites its own file.
 *
 * Design notes
 * ------------
 * - DEM and traffic producers are *not* implemented yet; this PR only
 *   wires up OSM. Subsequent producers can sit next to this file and
 *   share the same CLI shape.
 * - Pure helpers (bbox computation, Overpass response parsing, way
 *   normalisation, nearest-way snap) are exported so
 *   `tests/unit/osmProducer.test.js` can exercise them without going
 *   to the network.
 * - The Overpass call itself is wrapped in `fetchOverpass`, which is
 *   injectable via `opts.fetchOverpass(query)`. Tests stub it; the
 *   CLI uses the built-in `fetch` of Node 20+ with retry/backoff.
 */

const fs   = require('fs');
const path = require('path');

const PRODUCER_VERSION = '1.0.0';

const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';
const DEFAULT_OVERPASS_TIMEOUT_MS = 180_000;
const DEFAULT_OVERPASS_RETRIES = 3;
const DEFAULT_OVERPASS_BACKOFF_MS = 5_000;
const DEFAULT_INTER_CITY_DELAY_MS = 2_000;

// 50 m is generous enough to absorb both the 1.1 m grid bucketing in
// `enrich_geojson.js`'s OSM provider and the typical horizontal error
// of the published Unfallatlas coordinates (~10-20 m).
const DEFAULT_MAX_SNAP_DISTANCE_M = 50;

// ---------------------------------------------------------------------------
// City list / slugging — kept independent of `scripts/enrich_geojson.js`'s
// internals to avoid a circular dependency, but identical in behaviour.
// Both must agree on the slug rule, otherwise the enrichment step would
// look for the wrong filename.
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

// ---------------------------------------------------------------------------
// Bounding box
// ---------------------------------------------------------------------------

/**
 * Compute the lat/lon bounding box of all Point features in a
 * GeoJSON FeatureCollection. Returns null if there are no usable
 * coordinates.
 */
function bboxFromFeatureCollection(fc) {
  if (!fc || !Array.isArray(fc.features) || fc.features.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  let n = 0;
  for (const f of fc.features) {
    const c = f && f.geometry && f.geometry.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = +c[0], lat = +c[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    n++;
  }
  if (n === 0) return null;
  return { minLat, minLon, maxLat, maxLon };
}

/**
 * Pad a bbox by a small margin (in degrees) so points exactly on a
 * city boundary still match a way that lies just outside the convex
 * hull of the accident points.
 */
function padBbox(bbox, marginDeg = 0.005) {
  if (!bbox) return null;
  return {
    minLat: bbox.minLat - marginDeg,
    minLon: bbox.minLon - marginDeg,
    maxLat: bbox.maxLat + marginDeg,
    maxLon: bbox.maxLon + marginDeg,
  };
}

// ---------------------------------------------------------------------------
// Overpass query / response parsing
// ---------------------------------------------------------------------------

function buildOverpassQuery(bbox, opts) {
  const timeoutS = Math.max(30, Math.floor((opts && opts.timeoutMs ? opts.timeoutMs : DEFAULT_OVERPASS_TIMEOUT_MS) / 1000));
  // Overpass bbox order: (south, west, north, east).
  const b = `(${bbox.minLat},${bbox.minLon},${bbox.maxLat},${bbox.maxLon})`;
  return [
    `[out:json][timeout:${timeoutS}];`,
    `(`,
    `  way["highway"]${b};`,
    `);`,
    // `out geom` inlines the way's node coordinates so we don't need a
    // second roundtrip to resolve node refs.
    `out tags geom;`,
  ].join('\n');
}

/**
 * Convert a raw Overpass JSON response into the internal way list
 * used by the snap/normalise stages.
 *
 * Returned shape: [{ id, tags, geometry: [{lat,lon}, ...] }, ...]
 */
function parseOverpassResponse(json) {
  if (!json || !Array.isArray(json.elements)) return [];
  const out = [];
  for (const el of json.elements) {
    if (!el || el.type !== 'way') continue;
    if (el.id == null) continue;
    const geom = Array.isArray(el.geometry) ? el.geometry : [];
    if (geom.length < 2) continue;
    const coords = [];
    for (const g of geom) {
      if (typeof g?.lat === 'number' && typeof g?.lon === 'number') {
        coords.push({ lat: g.lat, lon: g.lon });
      }
    }
    if (coords.length < 2) continue;
    out.push({
      id: String(el.id),
      tags: el.tags || {},
      geometry: coords,
    });
  }
  return out;
}

/**
 * Normalise an OSM way's tag set into the field shape expected by
 * `loadOsmProvider` in `scripts/enrich_geojson.js`. Drops everything
 * that's null/undefined so JSON.stringify omits the keys.
 */
function normalizeWay(way) {
  const t = way.tags || {};
  const obj = {
    highway:     t.highway     != null ? String(t.highway)     : undefined,
    maxspeed:    parseMaxspeed(t.maxspeed),
    lanes:       parseInteger(t.lanes),
    surface:     t.surface     != null ? String(t.surface)     : undefined,
    cycleway:    t.cycleway    != null ? String(t.cycleway)    : undefined,
    osm_incline: t.incline     != null ? String(t.incline)     : undefined,
  };
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

function parseMaxspeed(v) {
  if (v == null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'none' || s === 'signals' || s === 'variable') return undefined;
  if (s === 'walk') return 7;
  const mph = s.match(/^(\d+(?:\.\d+)?)\s*mph$/);
  if (mph) return Math.round(Number(mph[1]) * 1.60934);
  const km = s.match(/^(\d+(?:\.\d+)?)\s*(?:km\/?h)?$/);
  if (km) return Math.round(Number(km[1]));
  return undefined;
}

function parseInteger(v) {
  if (v == null) return undefined;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : undefined;
}

// ---------------------------------------------------------------------------
// Geometry: nearest-way snap
//
// We use an equirectangular approximation. Across a single German
// city the resulting distance error is well below the snap budget
// (50 m), so the approximation is fine for nearest-way ranking.
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 111_320;

function metersPerDegLon(lat) {
  return M_PER_DEG_LAT * Math.cos(lat * Math.PI / 180);
}

/**
 * Squared distance (in m²) from a point to the segment (a, b), all in
 * lat/lon degrees. Squared so the inner loop avoids sqrt.
 */
function pointToSegmentDistSqM(lat, lon, a, b) {
  const mLat = M_PER_DEG_LAT;
  const mLon = metersPerDegLon(lat);
  const px = (lon - a.lon) * mLon;
  const py = (lat - a.lat) * mLat;
  const dx = (b.lon - a.lon) * mLon;
  const dy = (b.lat - a.lat) * mLat;
  const segLenSq = dx * dx + dy * dy;
  let t = segLenSq > 0 ? (px * dx + py * dy) / segLenSq : 0;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = t * dx;
  const cy = t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

/**
 * Return the nearest way to (lat, lon), capped at maxDistanceM. Falls
 * back to a linear scan when no spatial index is supplied — the index
 * is built once per city by `buildWayIndex`.
 */
function nearestWay(lat, lon, ways, opts) {
  const maxD = (opts && opts.maxDistanceM) || DEFAULT_MAX_SNAP_DISTANCE_M;
  const maxDSq = maxD * maxD;
  let bestId = null;
  let bestDSq = maxDSq;
  for (const w of ways) {
    const g = w.geometry;
    for (let i = 1; i < g.length; i++) {
      const dSq = pointToSegmentDistSqM(lat, lon, g[i - 1], g[i]);
      if (dSq < bestDSq) {
        bestDSq = dSq;
        bestId = w.id;
      }
    }
  }
  if (bestId == null) return null;
  return { way_id: bestId, distance_m: Math.sqrt(bestDSq) };
}

/**
 * Build a coarse lat/lon grid index over all way segments to keep
 * the per-feature snap O(features × candidates-in-cell) instead of
 * O(features × all-segments).
 */
function buildWayIndex(ways, cellSizeDeg = 0.005) {
  const grid = new Map();
  function cellKey(lat, lon) {
    return `${Math.floor(lat / cellSizeDeg)},${Math.floor(lon / cellSizeDeg)}`;
  }
  for (const w of ways) {
    const g = w.geometry;
    for (let i = 1; i < g.length; i++) {
      const a = g[i - 1], b = g[i];
      const minLat = Math.min(a.lat, b.lat);
      const maxLat = Math.max(a.lat, b.lat);
      const minLon = Math.min(a.lon, b.lon);
      const maxLon = Math.max(a.lon, b.lon);
      const lat0 = Math.floor(minLat / cellSizeDeg);
      const lat1 = Math.floor(maxLat / cellSizeDeg);
      const lon0 = Math.floor(minLon / cellSizeDeg);
      const lon1 = Math.floor(maxLon / cellSizeDeg);
      for (let la = lat0; la <= lat1; la++) {
        for (let lo = lon0; lo <= lon1; lo++) {
          const key = `${la},${lo}`;
          let bucket = grid.get(key);
          if (!bucket) { bucket = []; grid.set(key, bucket); }
          bucket.push({ id: w.id, a, b });
        }
      }
    }
  }
  return { grid, cellSizeDeg, cellKey };
}

function nearestWayIndexed(lat, lon, index, opts) {
  const maxD = (opts && opts.maxDistanceM) || DEFAULT_MAX_SNAP_DISTANCE_M;
  const maxDSq = maxD * maxD;
  const cs = index.cellSizeDeg;
  // Search the 3×3 neighbourhood — enough so a point near a cell
  // boundary still sees segments that fall into the adjacent cell.
  const lat0 = Math.floor(lat / cs);
  const lon0 = Math.floor(lon / cs);
  let bestId = null;
  let bestDSq = maxDSq;
  for (let la = lat0 - 1; la <= lat0 + 1; la++) {
    for (let lo = lon0 - 1; lo <= lon0 + 1; lo++) {
      const bucket = index.grid.get(`${la},${lo}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        const dSq = pointToSegmentDistSqM(lat, lon, seg.a, seg.b);
        if (dSq < bestDSq) {
          bestDSq = dSq;
          bestId = seg.id;
        }
      }
    }
  }
  if (bestId == null) return null;
  return { way_id: bestId, distance_m: Math.sqrt(bestDSq) };
}

// ---------------------------------------------------------------------------
// Dataset assembly
// ---------------------------------------------------------------------------

/**
 * Combine the raw Overpass result with the accident GeoJSON into the
 * final `osm_<city>.json` payload.
 *
 * @param {object} fc           accident FeatureCollection
 * @param {Array}  ways         output of parseOverpassResponse(...)
 * @param {object} [opts]
 * @param {number} [opts.maxDistanceM]   snap cap (m), default 50
 * @param {string} [opts.extractDate]    ISO date for provenance
 * @param {string} [opts.source]         provenance label
 */
function buildOsmDataset(fc, ways, opts) {
  const o = opts || {};
  const index = buildWayIndex(ways);
  const wayTable = {};
  const usedWays = new Set();
  const indexEntries = [];

  if (fc && Array.isArray(fc.features)) {
    for (const f of fc.features) {
      const c = f && f.geometry && f.geometry.coordinates;
      if (!Array.isArray(c) || c.length < 2) continue;
      const lon = +c[0], lat = +c[1];
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const hit = nearestWayIndexed(lat, lon, index, { maxDistanceM: o.maxDistanceM });
      if (!hit) continue;
      indexEntries.push({ lat, lon, way_id: hit.way_id });
      usedWays.add(hit.way_id);
    }
  }

  // Only emit the ways that the accident points actually snapped to.
  // The bbox query inevitably returns far more ways than we need, and
  // shipping them all would bloat the producer cache for no
  // downstream benefit — `enrich_geojson.js` only ever reads ways
  // whose ids appear in the index.
  for (const w of ways) {
    if (!usedWays.has(w.id)) continue;
    wayTable[w.id] = normalizeWay(w);
  }

  return {
    source:      o.source      || 'OpenStreetMap (Overpass)',
    extractDate: o.extractDate || new Date().toISOString().slice(0, 10),
    ways:        wayTable,
    index:       indexEntries,
  };
}

// ---------------------------------------------------------------------------
// Network: Overpass call with retry/backoff
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function fetchOverpass(query, opts) {
  const o = opts || {};
  const endpoint = o.endpoint || process.env.OVERPASS_ENDPOINT || DEFAULT_OVERPASS_ENDPOINT;
  const retries  = Number.isFinite(o.retries) ? o.retries : DEFAULT_OVERPASS_RETRIES;
  const backoff  = Number.isFinite(o.backoffMs) ? o.backoffMs : DEFAULT_OVERPASS_BACKOFF_MS;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_OVERPASS_TIMEOUT_MS;
  const fetchImpl = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('No fetch() available — Node 18+ required, or pass opts.fetch');

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // Overpass returns 429/504 under load; exponential backoff is
      // recommended by the operators.
      const wait = backoff * Math.pow(2, attempt - 1);
      console.warn(`[osm-producer] Overpass retry ${attempt}/${retries} after ${wait} ms (${lastErr?.message || 'previous attempt failed'})`);
      await sleep(wait);
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let nonRetryable = false;
    try {
      const resp = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent':   'Unfallatlas-OSM-Producer/' + PRODUCER_VERSION,
        },
        body: 'data=' + encodeURIComponent(query),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!resp.ok) {
        lastErr = new Error(`Overpass HTTP ${resp.status}`);
        // 4xx (except 429) are not worth retrying. Mark the error as
        // non-retryable and rethrow so the surrounding catch can
        // bubble it out instead of looping.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          nonRetryable = true;
          throw lastErr;
        }
        continue;
      }
      const json = await resp.json();
      return json;
    } catch (e) {
      lastErr = e;
      if (nonRetryable) throw lastErr;
      // AbortError + network errors → retry.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Overpass call failed for unknown reason');
}

// ---------------------------------------------------------------------------
// Per-city produce
// ---------------------------------------------------------------------------

async function produceCity(repoRoot, citySlug, opts) {
  const o = opts || {};
  const inputFile = path.join(repoRoot, 'out', `output_all_years_${citySlug}.geojson`);
  if (!fs.existsSync(inputFile)) {
    return { citySlug, skipped: true, reason: 'no input geojson' };
  }
  let fc;
  try {
    fc = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (e) {
    return { citySlug, skipped: true, reason: `invalid input geojson: ${e.message}` };
  }
  const bbox = padBbox(bboxFromFeatureCollection(fc), o.bboxMarginDeg);
  if (!bbox) {
    return { citySlug, skipped: true, reason: 'no usable coordinates' };
  }

  const query = buildOverpassQuery(bbox, { timeoutMs: o.overpassTimeoutMs });
  const fetchFn = o.fetchOverpass || ((q) => fetchOverpass(q, {
    endpoint:  o.endpoint,
    retries:   o.retries,
    backoffMs: o.backoffMs,
    timeoutMs: o.overpassTimeoutMs,
  }));
  const raw = await fetchFn(query);
  const ways = parseOverpassResponse(raw);

  const dataset = buildOsmDataset(fc, ways, {
    maxDistanceM: o.maxDistanceM,
    extractDate:  o.extractDate,
  });

  const outDir = o.outDir;
  if (!outDir) throw new Error('produceCity: opts.outDir required');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `osm_${citySlug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dataset));

  return {
    citySlug,
    skipped: false,
    counts: {
      features:    fc.features.length,
      candidates:  ways.length,
      matched:     dataset.index.length,
      ways:        Object.keys(dataset.ways).length,
    },
    bbox,
    outFile,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    cities: [],
    outDir: process.env.ENRICH_OSM_DATA_DIR || '.enrichment-cache/osm',
    maxDistanceM: DEFAULT_MAX_SNAP_DISTANCE_M,
    interCityDelayMs: DEFAULT_INTER_CITY_DELAY_MS,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--city')              opts.cities.push(argv[++i]);
    else if (a === '--out-dir')      opts.outDir = argv[++i];
    else if (a === '--max-distance') opts.maxDistanceM = Number(argv[++i]);
    else if (a === '--delay')        opts.interCityDelayMs = Number(argv[++i]);
    else if (a === '--json')         opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--'))     console.warn(`[osm-producer] unknown flag ignored: ${a}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
`Usage: node scripts/producers/osm_producer.js [options]

  --city <name>          produce only this city (repeatable);
                         default: every city listed in cities.txt
  --out-dir <path>       output directory (default: $ENRICH_OSM_DATA_DIR
                         or .enrichment-cache/osm)
  --max-distance <m>     max snap distance for accident → way (default: ${DEFAULT_MAX_SNAP_DISTANCE_M})
  --delay <ms>           politeness delay between cities (default: ${DEFAULT_INTER_CITY_DELAY_MS})
  --json                 emit machine-readable summary

Environment:
  ENRICH_OSM_DATA_DIR    fallback for --out-dir
  OVERPASS_ENDPOINT      override Overpass endpoint (default: ${DEFAULT_OVERPASS_ENDPOINT})
`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  const repoRoot = path.resolve(__dirname, '..', '..');
  let citySlugs = opts.cities.map(slugCity);
  if (citySlugs.length === 0) citySlugs = readCitiesTxt(repoRoot).map(slugCity);
  if (citySlugs.length === 0) {
    console.error('[osm-producer] no cities to process (cities.txt empty and no --city given)');
    return 2;
  }

  const summary = { producer: 'osm', producerVersion: PRODUCER_VERSION, cities: [] };
  let exit = 0;
  for (let i = 0; i < citySlugs.length; i++) {
    const slug = citySlugs[i];
    if (i > 0 && opts.interCityDelayMs > 0) await sleep(opts.interCityDelayMs);
    try {
      const r = await produceCity(repoRoot, slug, opts);
      summary.cities.push(r);
      if (!opts.json) {
        if (r.skipped) {
          console.log(`[osm-producer] ${slug}: SKIP (${r.reason})`);
        } else {
          console.log(
            `[osm-producer] ${slug}: ${r.counts.matched}/${r.counts.features} features matched, ` +
            `${r.counts.ways} ways kept (of ${r.counts.candidates} in bbox) → ${r.outFile}`
          );
        }
      }
    } catch (e) {
      // One city's failure must not abort the whole producer run —
      // the enrichment script silently no-ops on missing files.
      exit = 1;
      const errEntry = { citySlug: slug, skipped: true, reason: `error: ${e.message}` };
      summary.cities.push(errEntry);
      if (!opts.json) console.error(`[osm-producer] ${slug}: ERROR ${e.message}`);
    }
  }
  if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return exit;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error('[osm-producer] fatal:', e);
    process.exit(1);
  });
}

module.exports = {
  PRODUCER_VERSION,
  DEFAULT_MAX_SNAP_DISTANCE_M,
  slugCity,
  readCitiesTxt,
  bboxFromFeatureCollection,
  padBbox,
  buildOverpassQuery,
  parseOverpassResponse,
  normalizeWay,
  parseMaxspeed,
  parseInteger,
  pointToSegmentDistSqM,
  nearestWay,
  buildWayIndex,
  nearestWayIndexed,
  buildOsmDataset,
  fetchOverpass,
  produceCity,
  parseArgs,
  main,
};
