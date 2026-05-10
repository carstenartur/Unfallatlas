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
 *         out/ways_<city>.json                  (per-way attribute table
 *                                                + generalised geometries
 *                                                — see "geometries" block)
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
  'road_slope_class',
  'road_slope_method',
  'road_slope_sample_count',
  'road_slope_confidence',
  'road_slope_max_abs_percent',
  'road_slope_missing_reason',
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

/**
 * Summarise the per-way slope signal for the validator gate.
 *
 * Iterates the full-network ways assembled for v3 context tiles and
 * returns a compact report suitable for embedding in the per-city
 * enrichment meta sidecar:
 *   - totalWays           how many ways the slope layer can render
 *   - withSlope           ways with a numeric `road_slope_percent`
 *   - noSlopeSignal       ways without a slope signal (rendered grey)
 *   - coveragePercent     `withSlope / totalWays * 100`, 1 dp
 *   - classCounts         histogram per `road_slope_class`
 *   - missingReasonCounts histogram per `road_slope_missing_reason`
 *   - methodCounts        histogram per `road_slope_method`
 *   - confidenceCounts    histogram per `road_slope_confidence`
 *   - veryStepShare       fraction of *signal* ways classified
 *                         `very_steep`; a runaway value here is the
 *                         most reliable single-number tell-tale that
 *                         endpoint-noise has crept back in.
 *
 * Pure / synchronous; tests can call directly.
 */
function summarizeSlopeQuality(fullWays) {
  const out = {
    totalWays: 0,
    withSlope: 0,
    noSlopeSignal: 0,
    coveragePercent: 0,
    classCounts: { flat: 0, gentle: 0, moderate: 0, steep: 0, very_steep: 0 },
    missingReasonCounts: {},
    methodCounts: {},
    confidenceCounts: {},
    veryStepShare: 0,
  };
  if (!Array.isArray(fullWays) || fullWays.length === 0) return out;
  for (const w of fullWays) {
    out.totalWays++;
    const a = (w && w.attrs) || {};
    if (Number.isFinite(a.road_slope_percent)) {
      out.withSlope++;
      const cls = a.road_slope_class || classifySlope(a.road_slope_percent);
      if (cls && cls in out.classCounts) out.classCounts[cls]++;
    } else {
      out.noSlopeSignal++;
      const r = a.road_slope_missing_reason || 'unknown';
      out.missingReasonCounts[r] = (out.missingReasonCounts[r] || 0) + 1;
    }
    if (a.road_slope_method) {
      out.methodCounts[a.road_slope_method] = (out.methodCounts[a.road_slope_method] || 0) + 1;
    }
    if (a.road_slope_confidence) {
      out.confidenceCounts[a.road_slope_confidence] = (out.confidenceCounts[a.road_slope_confidence] || 0) + 1;
    }
  }
  out.coveragePercent = out.totalWays > 0
    ? Math.round((out.withSlope / out.totalWays) * 1000) / 10
    : 0;
  out.veryStepShare = out.withSlope > 0
    ? Math.round((out.classCounts.very_steep / out.withSlope) * 1000) / 10
    : 0;
  return out;
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
// Geometry generalization (Douglas–Peucker)
//
// The producer (`scripts/producers/osm_producer.js`) ships the full
// per-way polyline. We generalise it once at enrichment time so the
// front-end "Straßensteigung" / "Verkehrsbelastung" map overlays can
// render thousands of road segments in a single canvas pass without
// blowing up the on-disk `ways_<city>.json`.
//
// The default tolerance (~3 m) is generous enough to absorb OSM node
// jitter while preserving curvature; raise via opts.geomToleranceM
// (e.g. 10 m for very dense cities).
// ---------------------------------------------------------------------------

const DEFAULT_GEOM_TOLERANCE_M = 3;
const COORD_DECIMALS = 5; // ≈ 1.1 m — same precision as POINT_LOOKUP_PRECISION
const COORD_SCALE = Math.pow(10, COORD_DECIMALS);

// Equirectangular metres-per-degree at mid-European latitude (50°N).
// Plenty accurate for sub-kilometre Douglas–Peucker tolerance.
const M_PER_DEG_LAT = 111_320;
function mPerDegLon(latDeg) {
  return Math.cos((latDeg * Math.PI) / 180) * M_PER_DEG_LAT;
}

// Perpendicular distance (metres) from point P to segment AB.
function perpendicularDistanceM(p, a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const mxLon = mPerDegLon(lat0);
  const ax = (a.lon) * mxLon, ay = a.lat * M_PER_DEG_LAT;
  const bx = (b.lon) * mxLon, by = b.lat * M_PER_DEG_LAT;
  const px = (p.lon) * mxLon, py = p.lat * M_PER_DEG_LAT;
  const dx = bx - ax, dy = by - ay;
  const seg2 = dx * dx + dy * dy;
  if (seg2 === 0) {
    const ex = px - ax, ey = py - ay;
    return Math.sqrt(ex * ex + ey * ey);
  }
  // Project P onto AB, clamp to segment, then measure.
  let t = ((px - ax) * dx + (py - ay) * dy) / seg2;
  if (t < 0) t = 0; else if (t > 1) t = 1;
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

function douglasPeucker(points, toleranceM) {
  if (!Array.isArray(points) || points.length <= 2) return points || [];
  // Iterative DP — no recursion-depth risk on long ways.
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let maxD = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = perpendicularDistanceM(points[k], points[i], points[j]);
      if (d > maxD) { maxD = d; idx = k; }
    }
    if (idx !== -1 && maxD > toleranceM) {
      keep[idx] = 1;
      stack.push([i, idx], [idx, j]);
    }
  }
  const out = [];
  for (let k = 0; k < points.length; k++) if (keep[k]) out.push(points[k]);
  return out;
}

function roundCoord(n) {
  return Math.round(n * COORD_SCALE) / COORD_SCALE;
}

/**
 * Encode a generalised polyline as a flat `[lat, lon, lat, lon, ...]`
 * array of 5-decimal numbers. Flat-array encoding is roughly 2× smaller
 * gzipped than the equivalent `[{lat,lon},...]` representation while
 * remaining trivial to decode in the browser.
 */
function encodeGeometry(points) {
  const out = new Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    out[i * 2]     = roundCoord(points[i].lat);
    out[i * 2 + 1] = roundCoord(points[i].lon);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Slippy-map tiling for the full-network context layer (v3 schema)
//
// The matched-only `ways_<city>.json` payload (v1/v2) was small enough to
// ship as one monolithic file because it only carried ways an accident
// snapped to. The PRODUCER_VERSION 1.2.0 OSM dataset now ships the entire
// bbox road network — for Berlin that grows the per-way table from
// ~8 MB to an estimated 50–80 MB. Shipping that as a single fetch on
// page load would blow the gzipped-size CI gate and waste bandwidth on
// areas the user never pans into.
//
// Solution: write the per-way attrs + simplified geometry into per-tile
// JSON files at a fixed slippy-tile zoom (Z=13 ≈ 5 km × 3 km in DE).
// The browser-side loader (`UA.contextLayers.loadTilesForBbox`) then
// fetches only the tiles intersecting the current viewport.
//
// Tile layout on disk:
//   out/ctxtiles/<slug>/index.json     ← manifest (tile list + dicts +
//                                        wayId → tile reverse index)
//   out/ctxtiles/<slug>/<x>/<y>.json   ← per-tile { ways, geometries }
//
// Each tile uses the same `{ways:{wayId:attrs}, geometries:{wayId:[lat,lon,...]}}`
// shape as the v2 ways file, so the existing `UA.contextRoadLayer.buildLayer`
// + `UA.contextLayers.resolveWay` codepaths work unchanged on a merged
// tile state.
// ---------------------------------------------------------------------------

const CTX_TILE_ZOOM = 13;

function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
}
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
      Math.pow(2, z)
  );
}
function tileXToLon(x, z) {
  return (x / Math.pow(2, z)) * 360 - 180;
}
function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

/**
 * Return every (x,y) tile coordinate covered by the *vertex bounding
 * box* of the polyline at zoom z. This is a deliberate over-approximation
 * — a long, gently-curving way that only clips the corner of an
 * intermediate tile is still emitted into that tile too. The cost is
 * a small amount of disk duplication; the benefit is a trivial
 * implementation that is easy to verify and that guarantees the
 * front-end never misses a way for its viewport (no segment-vs-tile
 * traversal needed). See plan §1.
 */
function tilesForPolyline(points, z) {
  if (!Array.isArray(points) || points.length === 0) return [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) continue;
    const x = lonToTileX(p.lon, z), y = latToTileY(p.lat, z);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return [];
  const out = [];
  for (let x = minX; x <= maxX; x++) {
    for (let y = minY; y <= maxY; y++) {
      out.push([x, y]);
    }
  }
  return out;
}

/**
 * Build the per-tile payload + manifest for a city.
 *
 * @param {object[]}  fullWays   [{ id, attrs, geom }] — `attrs` is a
 *                               raw (string/number) attrs row, `geom`
 *                               is the *generalised* polyline already
 *                               (a flat `[lat,lon,…]` array as produced
 *                               by `encodeGeometry`).
 * @returns {{ tiles: Map<string,{ways:object, geometries:object}>,
 *             manifest: object,
 *             dicts: object }}
 */
function buildContextTiles(fullWays, opts = {}) {
  const z = Number.isInteger(opts.zoom) ? opts.zoom : CTX_TILE_ZOOM;
  const tiles = new Map();   // "x/y" → { ways, geometries }
  const wayIndex = {};       // wayId → [x, y] (first tile only — used
                             //  for popup hydration, see resolveWayAcrossTiles)

  for (const w of fullWays) {
    const flat = w.geom;
    if (!Array.isArray(flat) || flat.length < 4 || (flat.length % 2) !== 0) continue;
    // Decode flat → points just for tile assignment; cheap.
    const pts = [];
    for (let i = 0; i < flat.length; i += 2) {
      pts.push({ lat: flat[i], lon: flat[i + 1] });
    }
    const txy = tilesForPolyline(pts, z);
    if (txy.length === 0) continue;
    wayIndex[w.id] = txy[0]; // canonical tile = first one
    for (const [x, y] of txy) {
      const key = `${x}/${y}`;
      let bucket = tiles.get(key);
      if (!bucket) { bucket = { x, y, ways: {}, geometries: {} }; tiles.set(key, bucket); }
      bucket.ways[w.id]       = w.attrs;
      bucket.geometries[w.id] = flat;
    }
  }

  // Build dictionaries across the full network so all tiles share the
  // same int codes (otherwise the popup hydration would have to ship
  // a per-tile dict too — wasteful).
  const dicts = {};
  for (const field of DICT_FIELDS) {
    const seen = new Map();
    for (const bucket of tiles.values()) {
      for (const wayId of Object.keys(bucket.ways)) {
        const v = bucket.ways[wayId][field];
        if (v == null) continue;
        const key = String(v);
        if (!seen.has(key)) seen.set(key, seen.size);
      }
    }
    if (seen.size > 0) {
      const arr = new Array(seen.size);
      for (const [v, i] of seen.entries()) arr[i] = v;
      dicts[field] = arr;
    }
  }
  // Apply dict coding in place. We pre-build a value→index map per
  // field so the inner loop is O(1) per (way, field) instead of an
  // O(|dict|) `indexOf` scan — matters for full-network cities where
  // tens of thousands of ways × ~half a dozen dict fields would
  // otherwise dominate enrichment runtime.
  const dictIndex = {};
  for (const field of DICT_FIELDS) {
    const dict = dicts[field];
    if (!dict) continue;
    const idxMap = new Map();
    for (let i = 0; i < dict.length; i++) idxMap.set(dict[i], i);
    dictIndex[field] = idxMap;
  }
  for (const bucket of tiles.values()) {
    for (const wayId of Object.keys(bucket.ways)) {
      const row = bucket.ways[wayId];
      for (const field of DICT_FIELDS) {
        const idxMap = dictIndex[field];
        const v = row[field];
        if (v == null || !idxMap) continue;
        const idx = idxMap.get(String(v));
        if (typeof idx === 'number') row[field] = idx;
      }
    }
  }

  const manifestTiles = [];
  for (const bucket of tiles.values()) {
    manifestTiles.push({
      x: bucket.x, y: bucket.y,
      wayCount: Object.keys(bucket.ways).length,
    });
  }
  manifestTiles.sort((a, b) => (a.x - b.x) || (a.y - b.y));

  const manifest = {
    schemaVersion: 3,
    z,
    coverage: 'full',
    tiles: manifestTiles,
    wayIndex,
    dicts,
  };
  return { tiles, manifest, dicts };
}

/**
 * Persist tile payloads + manifest to disk under `out/ctxtiles/<slug>/`.
 * Replaces the directory's contents to stay idempotent across re-runs.
 */
function writeContextTiles(repoRoot, citySlug, fullWays, opts = {}) {
  const baseDir = path.join(repoRoot, 'out', 'ctxtiles', citySlug);
  // Wipe stale tile files from a previous run so a way that moved
  // tiles (or was removed entirely) doesn't leave a dangling fetch
  // target. Cheap — the dir is small and per-city.
  if (fs.existsSync(baseDir)) {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
  fs.mkdirSync(baseDir, { recursive: true });

  const built = buildContextTiles(fullWays, opts);
  // Per-tile files in <baseDir>/<x>/<y>.json
  for (const bucket of built.tiles.values()) {
    const xDir = path.join(baseDir, String(bucket.x));
    if (!fs.existsSync(xDir)) fs.mkdirSync(xDir, { recursive: true });
    const file = path.join(xDir, `${bucket.y}.json`);
    fs.writeFileSync(file, JSON.stringify({
      schemaVersion: 3,
      ways:       bucket.ways,
      geometries: bucket.geometries,
    }));
  }

  const manifest = buildContextTileManifestFromDisk(repoRoot, citySlug, {
    zoom:            Number.isInteger(opts.zoom) ? opts.zoom : CTX_TILE_ZOOM,
    generatedAt:     opts.generatedAt,
    producerVersion: opts.producerVersion || null,
    dicts:           built.dicts,
  });
  if (opts.source)      manifest.source      = opts.source;
  if (opts.extractDate) manifest.extractDate = opts.extractDate;

  fs.writeFileSync(path.join(baseDir, 'index.json'), JSON.stringify(manifest));

  return {
    tileCount: manifest.tiles.length,
    wayCount:  Object.keys(manifest.wayIndex || {}).length,
    indexPath: path.posix.join('ctxtiles', citySlug, 'index.json'),
    indexUrl:  path.posix.join('out', 'ctxtiles', citySlug, 'index.json'),
  };
}

/**
 * Reconstruct the tile manifest from what is physically present on disk
 * (`out/ctxtiles/<slug>/<x>/<y>.json`). This avoids schema drift between
 * producer/enrichment internals and what the browser can actually fetch
 * on static hosting (GitHub Pages has no directory listing).
 */
function buildContextTileManifestFromDisk(repoRoot, citySlug, opts = {}) {
  const z = Number.isInteger(opts.zoom) ? opts.zoom : CTX_TILE_ZOOM;
  const baseDir = path.join(repoRoot, 'out', 'ctxtiles', citySlug);
  const tiles = [];
  const wayIndex = {};
  const malformedTiles = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  if (fs.existsSync(baseDir)) {
    const xDirEntries = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && Number.isInteger(Number.parseInt(e.name, 10)))
      .sort((a, b) => Number.parseInt(a.name, 10) - Number.parseInt(b.name, 10));
    for (const xDirEnt of xDirEntries) {
      if (!xDirEnt.isDirectory()) continue;
      const x = Number.parseInt(xDirEnt.name, 10);
      if (!Number.isInteger(x)) continue;
      const xDir = path.join(baseDir, xDirEnt.name);
      const yFileEntries = fs.readdirSync(xDir, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.json$/i.test(e.name) && Number.isInteger(Number.parseInt(e.name.replace(/\.json$/i, ''), 10)))
        .sort((a, b) => {
          const ay = Number.parseInt(a.name.replace(/\.json$/i, ''), 10);
          const by = Number.parseInt(b.name.replace(/\.json$/i, ''), 10);
          return ay - by;
        });
      for (const yFileEnt of yFileEntries) {
        if (!yFileEnt.isFile() || !/\.json$/i.test(yFileEnt.name)) continue;
        const y = Number.parseInt(yFileEnt.name.replace(/\.json$/i, ''), 10);
        if (!Number.isInteger(y)) continue;
        const file = path.join(xDir, yFileEnt.name);
        let wayCount = 0;
        let payload = null;
        try {
          payload = JSON.parse(fs.readFileSync(file, 'utf8'));
          const wayIds = Object.keys((payload && payload.ways) || {});
          wayCount = wayIds.length;
          for (const wayId of wayIds) if (!(wayId in wayIndex)) wayIndex[wayId] = [x, y];
        } catch (e) {
          malformedTiles.push({ x, y, file, error: e && e.message ? e.message : String(e) });
          continue;
        }
        if (!payload || typeof payload !== 'object') continue;
        tiles.push({ x, y, wayCount, bytes: gzippedSize(file) });
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  tiles.sort((a, b) => (a.x - b.x) || (a.y - b.y));
  const bbox = Number.isFinite(minX)
    ? [
      tileXToLon(minX, z),
      tileYToLat(maxY + 1, z),
      tileXToLon(maxX + 1, z),
      tileYToLat(minY, z),
    ]
    : null;
  if (malformedTiles.length > 0) {
    for (const m of malformedTiles) {
      console.warn(`[enrich] malformed context tile skipped for ${citySlug} at ${m.x}/${m.y}: ${m.error}`);
    }
  }

  return stripUndefined({
    schemaVersion: 3,
    citySlug,
    tileScheme: `slippy-z${z}`,
    coverage: 'full',
    z,
    tiles,
    bbox,
    wayIndex,
    dicts: (opts && opts.dicts && typeof opts.dicts === 'object') ? opts.dicts : undefined,
    generatedAt: opts.generatedAt || new Date().toISOString(),
    producerVersion: opts.producerVersion || undefined,
  });
}

// ---------------------------------------------------------------------------
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
    producerVersion: data.producerVersion || null,
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
    wayGeometry(wayId) {
      const wg = data.wayGeometries;
      if (!wg) return null;
      const g = wg[wayId];
      if (!Array.isArray(g) || g.length < 2) return null;
      const out = [];
      for (const p of g) {
        if (Number.isFinite(p?.lat) && Number.isFinite(p?.lon)) {
          out.push({ lat: p.lat, lon: p.lon });
        }
      }
      return out.length >= 2 ? out : null;
    },
    // Full-network coverage (PRODUCER_VERSION 1.2.0+): the on-disk
    // OSM dataset now contains *every* way Overpass returned in the
    // city bbox, not only the ways an accident snapped to. Returning
    // the full id list lets enrichCity build the per-tile context
    // payload for the front-end's "Straßennetz" overlay independently
    // of accident locations.
    listWayIds() {
      return data.ways && typeof data.ways === 'object' ? Object.keys(data.ways) : [];
    },
    coverage: data.coverage || (data.coverage === undefined ? null : data.coverage),
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
    producerVersion: data.producerVersion || null,
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
      const slope = round1(w.road_slope_percent);
      // Derive road_slope_class once at enrichment time so the renderer
      // doesn't need to know the threshold table — and so the validator
      // can count signal vs no-signal ways without re-classifying.
      const cls = classifySlope(slope);
      return stripUndefined({
        road_slope_percent:         slope,
        road_slope_max_abs_percent: round1(w.road_slope_max_abs_percent),
        road_slope_class:           cls,
        road_slope_method:          w.road_slope_method || undefined,
        road_slope_sample_count:    Number.isFinite(w.road_slope_sample_count) ? w.road_slope_sample_count : undefined,
        road_slope_confidence:      w.road_slope_confidence || undefined,
        road_slope_missing_reason:  (slope == null) ? (w.road_slope_missing_reason || undefined) : undefined,
      });
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
    // Fall back to datasetVersion so the new provenance (UI tooltip,
    // meta sidecar) gets a stable version string for traffic sources
    // that only set datasetVersion and not the newer producerVersion
    // field (review feedback on first follow-up commit).
    producerVersion: data.producerVersion || data.datasetVersion || null,
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
 *   { geojson, ways, geometries, meta }
 *
 * - `geojson`     The mutated FeatureCollection (per-feature props enriched).
 * - `ways`        wayId → per-way attribute row (dict-coded for high-card fields).
 * - `geometries`  wayId → flat `[lat, lon, lat, lon, …]` generalised polyline,
 *                 5-decimal floats. Empty object when the OSM provider does
 *                 not expose `wayGeometry()` (older caches).
 * - `meta`        Sidecar payload (sources, counts, dictFields).
 *
 * @param {object}  geojson      Parsed FeatureCollection (mutated in place).
 * @param {string}  citySlug     normalised slug, e.g. "bonn".
 * @param {object}  opts
 * @param {boolean} opts.useOsm
 * @param {boolean} opts.useDem
 * @param {boolean} opts.useTraffic
 * @param {object}  opts.providers       Provider overrides for tests.
 * @param {number}  opts.geomToleranceM  Douglas–Peucker tolerance for the
 *                                       per-way polyline (default ≈ 3 m;
 *                                       set to 0 to disable generalisation).
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
  // Per-way provider lookups are memoised: each provider is called at
  // most once per way, regardless of how many accidents match it. The
  // per-feature `traffic_proxy_class` denormalisation lives in
  // wayProxyClass below so it can still be applied to every accident
  // that maps to a traffic-bearing way without re-invoking the
  // provider.
  const ways = {};
  const geometries = {};                // wayId → flat [lat,lon,lat,lon,...] (generalised)
  const wayEnriched   = new Set();   // wayIds for which OSM/DEM lookups already ran
  const wayProxyClass = new Map();   // wayId → traffic_proxy_class (or undefined)

  // Generalisation tolerance for the per-way polylines we ship in
  // ways_<city>.json. Documented default = ~3 m; raise for very dense
  // cities. Set to 0 to disable generalisation entirely (tests).
  const geomToleranceM = (typeof opts.geomToleranceM === 'number' && opts.geomToleranceM >= 0)
    ? opts.geomToleranceM
    : DEFAULT_GEOM_TOLERANCE_M;

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
      // First time we see this wayId: ask each provider once.
      if (!wayEnriched.has(wayId)) {
        wayEnriched.add(wayId);
        const w = ways[wayId] = ways[wayId] || {};
        if (osm) {
          const a = osm.wayAttributes(wayId);
          if (a) Object.assign(w, a);
          // Per-way polyline (full vertex list from the OSM producer)
          // → generalised + flat-encoded for the front-end overlay.
          if (typeof osm.wayGeometry === 'function') {
            const raw = osm.wayGeometry(wayId);
            if (Array.isArray(raw) && raw.length >= 2) {
              const simplified = geomToleranceM > 0
                ? douglasPeucker(raw, geomToleranceM)
                : raw;
              if (Array.isArray(simplified) && simplified.length >= 2) {
                geometries[wayId] = encodeGeometry(simplified);
              }
            }
          }
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
            wayProxyClass.set(wayId, proxyClass);
          }
        }
        stripUndefined(w);
      }

      // Per-feature proxy class is the only traffic crumb we
      // denormalise onto the accident itself, because the UI colours
      // points by it without paying the lazy-load cost. Apply on
      // every matching feature, using the cached per-way value.
      const proxyClass = wayProxyClass.get(wayId);
      if (proxyClass) {
        props.traffic_proxy_class = proxyClass;
        nTraffic++;
      }
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

  // ---------------------------------------------------------------------
  // Full-network context table (PRODUCER_VERSION 1.2.0+, schemaVersion 3)
  //
  // Independent of the matched-only `ways`/`geometries` returned above
  // (which power the legacy v2 ways file kept for backward compat). The
  // tile writer in enrichCityFile consumes this `fullWays` array and
  // splits it into per-Z/X/Y JSON files so the front-end overlay can
  // render road properties for the entire bbox network without loading
  // a single monolithic blob.
  //
  // Slope is looked up per way via `dem.wayElevation(wayId)` below. The
  // DEM producer (scripts/producers/dem_producer.js) computes
  // `road_slope_percent` for *every* way in `wayGeometries` — both the
  // local-tile path (`makeLocalElevationSampler`) and the HTTP API path
  // walk all way endpoints from `osm_<slug>.json`, not just those an
  // accident snapped to. So the v3 context tiles carry slope colouring
  // for the full bbox network whenever DEM data is available; ways
  // without a slope signal are rendered in neutral grey by the front-
  // end overlay (see SLOPE_NO_SIGNAL_COLOR in js/ua.context_road_layer.js).
  // ---------------------------------------------------------------------
  // Gate full-network tile production on an explicit `coverage:"full"`
  // signal from the OSM provider. Older / matched-only OSM caches still
  // expose `listWayIds()` (it's derived from `data.ways`), but emitting
  // a v3 / `coverage:"full"` envelope for them would mis-advertise the
  // dataset to the loader and break the v2 fallback path. See review
  // feedback on the post-PR-#261 follow-up.
  const fullWays = [];
  if (osm && osm.coverage === 'full' && typeof osm.listWayIds === 'function') {
    for (const wayId of osm.listWayIds()) {
      const a = osm.wayAttributes(wayId);
      if (!a) continue;
      const row = { ...a };
      if (traffic) {
        const t = traffic.wayTraffic(wayId);
        if (t) {
          delete t._proxy_class;
          Object.assign(row, t);
        }
      }
      // Mirror the matched-only enrichment so per-tile rows carry the
      // slope hint when DEM data happens to be available for an
      // unmatched way (rare but possible if the tile producer extends
      // coverage in the future).
      if (dem && typeof dem.wayElevation === 'function') {
        const e = dem.wayElevation(wayId);
        if (e) Object.assign(row, e);
      }
      stripUndefined(row);
      let geom = null;
      if (typeof osm.wayGeometry === 'function') {
        const raw = osm.wayGeometry(wayId);
        if (Array.isArray(raw) && raw.length >= 2) {
          const simplified = geomToleranceM > 0
            ? douglasPeucker(raw, geomToleranceM)
            : raw;
          if (Array.isArray(simplified) && simplified.length >= 2) {
            geom = encodeGeometry(simplified);
          }
        }
      }
      if (!geom) continue;
      fullWays.push({ id: wayId, attrs: row, geom });
    }
  }

  // -----------------------------------------------------------------
  // Slope-quality summary (drives the build-time validator gate so we
  // never silently deploy a city whose slope context layer is missing
  // or dominated by SRTM noise on residential streets).
  // -----------------------------------------------------------------
  const slopeQuality = summarizeSlopeQuality(fullWays);

  const meta = {
    schemaVersion: 3,
    enrichmentScriptVersion: ENRICHMENT_SCRIPT_VERSION,
    citySlug,
    generatedAt: new Date().toISOString(),
    sources: stripUndefined({
      osm: osm     ? stripUndefined({ source: osm.source, producerVersion: osm.producerVersion, extractDate: osm.extractDate, coverage: osm.coverage || undefined }) : undefined,
      dem: dem     ? stripUndefined({ source: dem.source, producerVersion: dem.producerVersion, resolutionM: dem.resolutionM }) : undefined,
      traffic: traffic ? stripUndefined({ source: traffic.source, producerVersion: traffic.producerVersion, datasetVersion: traffic.datasetVersion }) : undefined,
    }),
    counts: {
      features: geojson.features.length,
      matchedToWay: nMatched,
      withElevation: nElevated,
      withTrafficProxy: nTraffic,
      ways: Object.keys(ways).length,
      wayGeometries: Object.keys(geometries).length,
      fullWays: fullWays.length,
    },
    dictFields: Object.keys(dicts),
    slope: slopeQuality,
  };

  return { geojson, ways, geometries, fullWays, meta };
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

  const { ways, geometries, fullWays, meta } = enrichCity(geojson, citySlug, opts);

  // Write enriched GeoJSON. We deliberately write compact (no
  // indentation) — matches the existing on-disk format produced by
  // convertAmt2gmaps.sh, and is the smallest viable representation.
  fs.writeFileSync(p.geojson, JSON.stringify(geojson));

  // Two on-disk shapes for `ways_<city>.json`:
  //
  //   v3 (PRODUCER_VERSION 1.2.0 + full-network OSM dataset): a thin
  //       envelope that points the loader at the per-tile context
  //       payload under `out/ctxtiles/<slug>/`. The browser only
  //       fetches tiles intersecting the current viewport so Berlin's
  //       full road network stays fast.
  //
  //   v2 (matched-only fallback, used when the OSM dataset still
  //       carries the pre-1.2.0 matched-only shape — i.e. no
  //       `coverage:"full"` flag): the legacy
  //       `{ schemaVersion:2, ways:{…}, geometries:{…} }` blob.
  //
  // The loader (`js/ua.context_layers.js`) accepts both shapes plus
  // the legacy flat v1 form so caches stay readable while a new
  // producer rolls out.
  let waysPayload;
  let tileWriteResult = null;
  const wantsTiles = Array.isArray(fullWays) && fullWays.length > 0;
  if (wantsTiles) {
    tileWriteResult = writeContextTiles(repoRoot, citySlug, fullWays, {
      source:      meta.sources?.osm?.source,
      extractDate: meta.sources?.osm?.extractDate,
      generatedAt: meta.generatedAt,
      producerVersion: meta.sources?.osm?.producerVersion || null,
    });
    // Fail-fast guard: a v3 envelope with an empty / dictless tile
    // index is what produced the original "Bielefeld + mapLayer=slope
    // shows empty legend" bug. Refuse to ship a v3 ways file in that
    // case — the loader would fetch a 404 manifest (or a manifest
    // without `dicts`), the slope classifier would return null for
    // every way, and the UI would render "Layer nicht verfügbar
    // (alte Datenversion)" or an empty legend. Surface the failure at
    // CI time so the build never produces a broken v3 dataset.
    if (!tileWriteResult || tileWriteResult.tileCount === 0) {
      throw new Error(
        `[enrich] ${citySlug}: refusing to write v3 ways envelope — writeContextTiles produced 0 tiles ` +
        `from ${fullWays.length} fullWays. Check the OSM producer output.`
      );
    }
    const writtenIndex = path.join(
      repoRoot, 'out', 'ctxtiles', citySlug, 'index.json'
    );
    let writtenManifest = null;
    try { writtenManifest = JSON.parse(fs.readFileSync(writtenIndex, 'utf8')); }
    catch (_) { /* fall through to throw below */ }
    if (!writtenManifest || !writtenManifest.dicts ||
        typeof writtenManifest.dicts !== 'object' ||
        Object.keys(writtenManifest.dicts).length === 0) {
      throw new Error(
        `[enrich] ${citySlug}: refusing to write v3 ways envelope — tile manifest at ${writtenIndex} ` +
        'is missing or has an empty `dicts` block (per-tile int-coded attrs would be undecodable).'
      );
    }
    waysPayload = {
      schemaVersion: 3,
      coverage:      'full',
      tileIndexUrl:  `out/ctxtiles/${citySlug}/index.json`,
      generatedAt:   meta.generatedAt,
    };
    meta.counts.contextTiles = tileWriteResult.tileCount;
    meta.tileIndexPath = tileWriteResult.indexPath;
  } else {
    waysPayload = (geometries && Object.keys(geometries).length > 0)
      ? { schemaVersion: 2, ways, geometries }
      : { schemaVersion: 2, ways };
    // Wipe any previously-written tile dir so we don't leave stale
    // tiles behind when a city falls back to the matched-only path.
    const tileDir = path.join(repoRoot, 'out', 'ctxtiles', citySlug);
    if (fs.existsSync(tileDir)) fs.rmSync(tileDir, { recursive: true, force: true });
    delete meta.tileIndexPath;
  }

  // The companion ways file and the meta sidecar are only meaningful
  // when at least one provider produced data. Skipping them in the
  // no-provider case keeps the weekly enrich.yml cron a true no-op
  // (otherwise the always-fresh `generatedAt` timestamp would create
  // a new commit on every run even when nothing actually changed —
  // see the related guard in .github/workflows/enrich.yml).
  const hasEnrichment = Object.keys(ways).length > 0
    || (wantsTiles)
    || Object.keys(meta.sources || {}).length > 0;
  if (hasEnrichment) {
    fs.writeFileSync(p.ways, JSON.stringify(waysPayload));
    fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2) + '\n');
  } else {
    // Clean up any stale companion files from a previous run that did
    // have enrichment data — the script must be deterministic and
    // self-consistent.
    for (const stale of [p.ways, p.meta]) {
      if (fs.existsSync(stale)) fs.unlinkSync(stale);
    }
    const tileDir = path.join(repoRoot, 'out', 'ctxtiles', citySlug);
    if (fs.existsSync(tileDir)) fs.rmSync(tileDir, { recursive: true, force: true });
  }

  const sizeAfter = gzippedSize(p.geojson);
  return {
    citySlug, skipped: false, meta, wroteCompanions: hasEnrichment,
    contextTiles: tileWriteResult,
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
  DEFAULT_GEOM_TOLERANCE_M,
  slugCity,
  classifySlope,
  classifyTrafficProxy,
  summarizeSlopeQuality,
  douglasPeucker,
  encodeGeometry,
  // Slippy-tile helpers (PRODUCER_VERSION 1.2.0+, schemaVersion 3).
  CTX_TILE_ZOOM,
  lonToTileX,
  latToTileY,
  tileXToLon,
  tileYToLat,
  tilesForPolyline,
  buildContextTiles,
  buildContextTileManifestFromDisk,
  writeContextTiles,
  enrichCity,
  enrichCityFile,
  pathsForCity,
  parseArgs,
  main,
};
