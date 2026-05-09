#!/usr/bin/env node
'use strict';

/**
 * scripts/producers/dem_producer.js
 *
 * Producer for the DEM (digital elevation model) enrichment stage.
 * Generates the `dem_<city>.json` files that
 * `scripts/enrich_geojson.js`'s `loadDemProvider` consumes (see
 * `docs/enrichment.md`).
 *
 * For each city listed in `cities.txt` (or supplied via --city) the
 * producer:
 *
 *   1. Reads `out/output_all_years_<slug>.geojson`.
 *   2. Deduplicates accident coordinates at 5dp (≈ 1.1 m) — the same
 *      bucketing the enricher uses to look points up.
 *   3. DEFAULT: samples elevation from locally-cached SRTM 1°×1° HGT
 *      tiles (downloaded by `dem_tile_producer.js`). One lookup per
 *      point; slope comes from the pixel gradient within the same tile.
 *      API FALLBACK: when `--use-api` is passed or no tile directory
 *      is set, falls back to the Open-Meteo API (5 HTTP samples per
 *      point — the original behaviour).
 *   4. Optionally enriches per-way data: when `osm_<slug>.json` is
 *      available (typically produced by `osm_producer.js`), the mean
 *      grade between each way's first and last node is computed and
 *      written to `wayElevations[<wayId>].road_slope_percent`.
 *   5. Writes the on-disk payload expected by `loadDemProvider`:
 *
 *        {
 *          source:        "SRTM Local Tiles",    // or "OpenMeteo SRTM"
 *          resolution_m:  30,                    // or 90 for API
 *          extractDate:   "YYYY-MM-DD",
 *          points:        [ { lat, lon, elevation_m, slope_percent, confidence } ],
 *          wayElevations: { "<wayId>": { road_slope_percent } }
 *        }
 *
 * Local tile sampling (default)
 * -----------------------------
 * Reads SRTM1 HGT tiles from `$ENRICH_DEM_TILES_DIR` (or `--tiles-dir`).
 * Each tile is a 3601×3601 Int16 big-endian binary file. Elevation is
 * bilinearly interpolated from the four surrounding pixels; slope is
 * computed from the adjacent pixel gradient (1 pixel ≈ 30 m) — so only
 * ONE lookup is required per point instead of the five the API path needs.
 * An LRU cache keeps up to 10 tiles in memory (~260 MB).
 *
 * HTTP API fallback
 * -----------------
 * Open-Meteo's free Elevation API
 * (https://open-meteo.com/en/docs/elevation-api), no API key, returns
 * SRTM-derived values at ~90 m horizontal resolution. Up to 100
 * lat/lon pairs per request. The endpoint is overridable via
 * `$OPEN_METEO_ELEVATION_ENDPOINT`, the function is fully injectable
 * via `opts.fetchElevations` so unit tests don't touch the network.
 *
 * Output dir defaults to `$ENRICH_DEM_DATA_DIR`, then
 * `.enrichment-cache/dem`. Re-running the producer is idempotent: each
 * city overwrites its own file.
 */

const fs   = require('fs');
const path = require('path');

const PRODUCER_VERSION = '1.0.0';

const DEFAULT_ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
const DEFAULT_ELEVATION_TIMEOUT_MS = 60_000;
const DEFAULT_ELEVATION_RETRIES   = 5;
const DEFAULT_ELEVATION_BACKOFF_MS = 5_000;
// Open-Meteo rate-limits aggressively (HTTP 429 + transient connection
// resets afterwards). When a 429 fires we wait significantly longer than
// generic transient errors before retrying. `Retry-After` (when present)
// overrides this, capped to MAX_RATE_LIMIT_BACKOFF_MS so a misbehaving
// proxy can't stall the whole job.
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 30_000;
const MAX_RATE_LIMIT_BACKOFF_MS     = 5 * 60_000;
// After a city fails with a rate-limit-related error we cool down before
// touching the API again, so the next city doesn't immediately get
// "fetch failed" because the upstream is still blocking the runner IP.
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const DEFAULT_INTER_CITY_DELAY_MS   = 5_000;
const DEFAULT_INTER_BATCH_DELAY_MS  = 250;
const DEFAULT_BATCH_SIZE = 100;

// Distance in degrees between a point and its cardinal neighbours used
// to compute the local slope. ~30 m at German latitudes — small enough
// to capture road-scale variation, large enough that SRTM's 90 m
// resolution still yields a non-zero gradient for genuinely steep
// neighbourhoods.
const NEIGHBOUR_OFFSET_M = 30;

// Default DEM source label written into both the on-disk payload and
// (transitively) into every accident's `slope_source` field.
const DEFAULT_SOURCE = 'OpenMeteo SRTM';
const DEFAULT_RESOLUTION_M = 90;

// Source label and resolution used when local SRTM tiles are available.
const LOCAL_SOURCE = 'SRTM Local Tiles';
const LOCAL_RESOLUTION_M = 30; // SRTM1 is 1 arc-second ≈ 30 m

// SRTM HGT tile constants
// SRTM1: 3601×3601 Int16 samples per 1°×1° tile.
const SRTM1_SIDE = 3601;
// SRTM3: 1201×1201 Int16 samples per 1°×1° tile.
const SRTM3_SIDE = 1201;
// Maximum number of tiles to keep in the LRU in-memory cache.
// ~26 MB per SRTM1 tile (3601×3601 × 2 bytes) × 10 = ~260 MB total.
const MAX_CACHED_TILES = 10;
// SRTM no-data marker.
const SRTM_NO_DATA = -32768;

const M_PER_DEG_LAT = 111_320;

// ---------------------------------------------------------------------------
// City list / slugging — kept in sync with osm_producer.js + enrich_geojson.js.
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
// Coordinate handling
// ---------------------------------------------------------------------------

// Match `pointKey` in scripts/enrich_geojson.js (5 decimals ≈ 1.1 m).
const POINT_LOOKUP_PRECISION = 5;
function quantize(n) {
  return Number(n.toFixed(POINT_LOOKUP_PRECISION));
}

/**
 * Walk a FeatureCollection and return one entry per *unique* point at
 * 5dp precision. Accidents that share a 5 dp bucket are coalesced —
 * the enricher will look any of them up via the same key.
 */
function uniquePointsFromFeatureCollection(fc) {
  if (!fc || !Array.isArray(fc.features)) return [];
  const seen = new Map();
  for (const f of fc.features) {
    const c = f && f.geometry && f.geometry.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = +c[0], lat = +c[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const qLat = quantize(lat);
    const qLon = quantize(lon);
    const key = `${qLat},${qLon}`;
    if (!seen.has(key)) seen.set(key, { lat: qLat, lon: qLon });
  }
  return [...seen.values()];
}

/**
 * Build the 5-sample query (centre + 4 cardinal neighbours) used to
 * derive elevation + signed slope at one accident point. The neighbour
 * offsets are computed in metres → degrees so the EW step shrinks
 * correctly at higher latitudes.
 */
function buildSampleSet(point, offsetM = NEIGHBOUR_OFFSET_M) {
  const dLat = offsetM / M_PER_DEG_LAT;
  const cosLat = Math.cos(point.lat * Math.PI / 180);
  // Defensive: avoid division-by-zero at the poles. Real input is
  // German cities so this branch never fires in practice.
  const dLon = cosLat > 1e-6 ? offsetM / (M_PER_DEG_LAT * cosLat) : dLat;
  return [
    { role: 'c', lat: point.lat,        lon: point.lon        },
    { role: 'n', lat: point.lat + dLat, lon: point.lon        },
    { role: 's', lat: point.lat - dLat, lon: point.lon        },
    { role: 'e', lat: point.lat,        lon: point.lon + dLon },
    { role: 'w', lat: point.lat,        lon: point.lon - dLon },
  ];
}

/**
 * Compute signed slope percent from 4 cardinal-neighbour elevations
 * sampled at `offsetM` from the centre. The returned value is the
 * steepest of the NS / EW components (with sign), which best matches
 * the slope a vehicle would actually climb/descend at that point.
 *
 * Returns undefined when neighbour data is missing.
 */
function computeSlopePercent(samples, offsetM = NEIGHBOUR_OFFSET_M) {
  const eN = samples.n, eS = samples.s, eE = samples.e, eW = samples.w;
  if (![eN, eS, eE, eW].every(Number.isFinite)) return undefined;
  const gNS = (eN - eS) / (2 * offsetM);   // positive → uphill to north
  const gEW = (eE - eW) / (2 * offsetM);   // positive → uphill to east
  // Signed steepest-axis slope, expressed as percent grade.
  const dominant = Math.abs(gNS) >= Math.abs(gEW) ? gNS : gEW;
  return dominant * 100;
}

function round1(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------------
// Local SRTM tile sampling (zero network calls in the hot path)
// ---------------------------------------------------------------------------

/**
 * Return the SRTM tile name (e.g. "N50E007") for the tile containing
 * (lat, lon). Used internally; also exported so tests can exercise it.
 */
function makeTileName(lat, lon) {
  const tileLat = Math.floor(lat);
  const tileLon = Math.floor(lon);
  const ns = tileLat >= 0 ? 'N' : 'S';
  const ew = tileLon >= 0 ? 'E' : 'W';
  return (
    ns + String(Math.abs(tileLat)).padStart(2, '0') +
    ew + String(Math.abs(tileLon)).padStart(3, '0')
  );
}

/**
 * Create a local elevation sampler backed by SRTM HGT tile files in
 * `tilesDir`. Returns an object with two methods:
 *
 *   sampleElevation(lat, lon)
 *     Bilinearly interpolated elevation in metres, or undefined if the
 *     tile file is absent or the pixel is marked no-data (−32768).
 *
 *   sampleElevationWithSlope(lat, lon)
 *     Elevation + signed slope percent in a SINGLE tile access.
 *     The slope is derived from the gradient between adjacent pixels
 *     in the tile (1 pixel ≈ 30 m for SRTM1), so no extra lookups are
 *     needed. Returns { elevation, slope } (slope may be undefined when
 *     any adjacent pixel is no-data or at the tile edge).
 *
 * Tiles are loaded lazily and kept in an LRU cache of at most
 * `MAX_CACHED_TILES` entries (≈ 260 MB for SRTM1).
 *
 * Tile format: raw Int16 big-endian, SRTM row-major order (row 0 =
 * northernmost row, col 0 = westernmost column). Supports both SRTM1
 * (3601×3601) and SRTM3 (1201×1201) files — the tile size is derived
 * from the file length.
 */
function makeLocalElevationSampler(tilesDir) {
  // name → { data: Int16Array, side: number } | null (null = tile absent)
  const cache = new Map();
  const order = []; // LRU insertion order (oldest first)

  function loadTile(name) {
    if (cache.has(name)) {
      // Refresh LRU position.
      const i = order.indexOf(name);
      if (i >= 0) order.splice(i, 1);
      order.push(name);
      return cache.get(name);
    }
    const hgtPath = path.join(tilesDir, name + '.hgt');
    let tile = null;
    if (fs.existsSync(hgtPath)) {
      const buf = fs.readFileSync(hgtPath);
      const nSamples = buf.length / 2;
      // Derive the tile side length from file size.
      let side;
      if (nSamples === SRTM1_SIDE * SRTM1_SIDE) {
        side = SRTM1_SIDE;
      } else if (nSamples === SRTM3_SIDE * SRTM3_SIDE) {
        side = SRTM3_SIDE;
      } else {
        const approx = Math.round(Math.sqrt(nSamples));
        if (approx * approx !== nSamples) {
          // Truncated or corrupt tile — don't cache bad data.
          console.warn(`[dem-producer] ${name}.hgt has unexpected byte count ${buf.length} — skipping tile`);
          cache.set(name, null);
          order.push(name);
          return null;
        }
        side = approx;
      }
      const data = new Int16Array(nSamples);
      for (let i = 0; i < nSamples; i++) {
        data[i] = buf.readInt16BE(i * 2);
      }
      tile = { data, side };
    }
    // LRU eviction.
    if (order.length >= MAX_CACHED_TILES) {
      const evict = order.shift();
      cache.delete(evict);
    }
    cache.set(name, tile);
    order.push(name);
    return tile;
  }

  /**
   * Bilinear interpolation within a single tile. Returns undefined when
   * any of the four surrounding pixels is SRTM_NO_DATA.
   */
  function bilinear(tile, yf, xf) {
    const { data, side } = tile;
    const n = side;
    const y0 = Math.min(Math.floor(yf), n - 2);
    const x0 = Math.min(Math.floor(xf), n - 2);
    const y1 = y0 + 1;
    const x1 = x0 + 1;
    const dy = yf - y0;
    const dx = xf - x0;
    const v00 = data[y0 * n + x0];
    const v01 = data[y0 * n + x1];
    const v10 = data[y1 * n + x0];
    const v11 = data[y1 * n + x1];
    if (v00 === SRTM_NO_DATA || v01 === SRTM_NO_DATA ||
        v10 === SRTM_NO_DATA || v11 === SRTM_NO_DATA) return undefined;
    return v00 * (1 - dx) * (1 - dy) +
           v01 *      dx  * (1 - dy) +
           v10 * (1 - dx) *      dy  +
           v11 *      dx  *      dy;
  }

  function sampleElevation(lat, lon) {
    const tileLat = Math.floor(lat);
    const tileLon = Math.floor(lon);
    const name = makeTileName(tileLat, tileLon);
    const tile = loadTile(name);
    if (!tile) return undefined;
    const { side } = tile;
    const n = side;
    const latFrac = lat - tileLat;
    const lonFrac = lon - tileLon;
    // SRTM: row 0 = northernmost → yf increases as lat decreases.
    const yf = (1 - latFrac) * (n - 1);
    const xf = lonFrac * (n - 1);
    return bilinear(tile, yf, xf);
  }

  /**
   * Return { elevation, slope } in a single tile access.
   * slope is the steepest signed slope percent derived from the
   * pixel-neighbour gradient (same formula as computeSlopePercent).
   */
  function sampleElevationWithSlope(lat, lon) {
    const tileLat = Math.floor(lat);
    const tileLon = Math.floor(lon);
    const name = makeTileName(tileLat, tileLon);
    const tile = loadTile(name);
    if (!tile) return { elevation: undefined, slope: undefined };

    const { data, side } = tile;
    const n = side;
    const latFrac = lat - tileLat;
    const lonFrac = lon - tileLon;
    const yf = (1 - latFrac) * (n - 1);
    const xf = lonFrac * (n - 1);

    // Bilinear elevation.
    const elevation = bilinear(tile, yf, xf);
    if (elevation === undefined) return { elevation: undefined, slope: undefined };

    // Nearest-pixel index for the gradient.
    const y = Math.min(Math.round(yf), n - 1);
    const x = Math.min(Math.round(xf), n - 1);

    // Adjacent pixels (clamped at tile boundary).
    const yn = Math.max(0, y - 1);
    const ys = Math.min(n - 1, y + 1);
    const xe = Math.min(n - 1, x + 1);
    const xw = Math.max(0, x - 1);

    const eN = data[yn * n + x];
    const eS = data[ys * n + x];
    const eE = data[y * n + xe];
    const eW = data[y * n + xw];

    if (eN === SRTM_NO_DATA || eS === SRTM_NO_DATA ||
        eE === SRTM_NO_DATA || eW === SRTM_NO_DATA) {
      return { elevation, slope: undefined };
    }

    // Ground distance for N-S gradient (in metres). Uses actual pixel
    // span (2 pixels when interior, 1 pixel at the edge).
    const pixelSizeLatM = (1 / (n - 1)) * M_PER_DEG_LAT;
    const cosLat = Math.cos(lat * Math.PI / 180);
    const pixelSizeLonM = (1 / (n - 1)) * M_PER_DEG_LAT *
                          // Clamp to a small epsilon to avoid E-W gradient distortion
                          // near the poles (cosLat approaches 0 at |lat| = 90°).
                          Math.max(cosLat, 1e-6);

    const distNS = (ys - yn) * pixelSizeLatM;
    const distEW = (xe - xw) * pixelSizeLonM;

    const gNS = distNS > 0 ? (eN - eS) / distNS : 0;
    const gEW = distEW > 0 ? (eE - eW) / distEW : 0;
    const dominant = Math.abs(gNS) >= Math.abs(gEW) ? gNS : gEW;
    const slope = dominant * 100;

    return { elevation, slope };
  }

  return { sampleElevation, sampleElevationWithSlope };
}

/**
 * Build the per-city DEM dataset from local-sampler results (1 result
 * per unique point). This is the counterpart to `buildDemDataset` for
 * the tile-sampling path.
 *
 * @param {Array<{lat,lon}>} points        deduplicated accident points
 * @param {Array<{elevation,slope}>} results  one entry per point
 * @param {object} [opts]
 *   - source         provenance label (default: LOCAL_SOURCE)
 *   - resolution_m   numeric DEM resolution (default: LOCAL_RESOLUTION_M)
 *   - extractDate    ISO date for provenance (default: today)
 *   - confidence     per-point confidence label (default: undefined)
 *   - wayElevations  optional { wayId: { road_slope_percent } } table
 */
function buildDemDatasetLocal(points, results, opts) {
  const o = opts || {};
  const out = {
    source:        o.source       || LOCAL_SOURCE,
    resolution_m:  o.resolution_m || LOCAL_RESOLUTION_M,
    extractDate:   o.extractDate  || new Date().toISOString().slice(0, 10),
    points:        [],
    wayElevations: o.wayElevations || {},
  };
  for (let i = 0; i < points.length; i++) {
    const { elevation, slope } = results[i] || {};
    if (!Number.isFinite(elevation)) continue;
    const entry = {
      lat: points[i].lat,
      lon: points[i].lon,
      elevation_m: round1(elevation),
    };
    if (Number.isFinite(slope)) entry.slope_percent = round1(slope);
    if (o.confidence) entry.confidence = o.confidence;
    out.points.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elevation fetch (Open-Meteo) with retry/backoff
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch elevations for an array of {lat, lon} samples. Returns an
 * array of numbers (or undefined for failed samples) in the same order.
 *
 * The request is split into batches of `batchSize` samples — Open-Meteo
 * accepts up to 100 coordinates per call. When `concurrency > 1`,
 * batches are dispatched via a small promise pool (workers pull the
 * next batch index off a shared cursor) so inter-batch wall-time
 * shrinks proportionally. The default of 1 preserves the original
 * sequential, politeness-first behaviour for callers that don't opt in.
 */
async function fetchElevations(samples, opts) {
  const o = opts || {};
  const endpoint  = o.endpoint  || process.env.OPEN_METEO_ELEVATION_ENDPOINT || DEFAULT_ELEVATION_ENDPOINT;
  const retries   = Math.max(0, Math.floor(
    Number.isFinite(o.retries) ? o.retries : DEFAULT_ELEVATION_RETRIES,
  ));
  const backoffMs = Number.isFinite(o.backoffMs) ? o.backoffMs : DEFAULT_ELEVATION_BACKOFF_MS;
  const rateLimitBackoffMs = Number.isFinite(o.rateLimitBackoffMs)
    ? o.rateLimitBackoffMs : DEFAULT_RATE_LIMIT_BACKOFF_MS;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_ELEVATION_TIMEOUT_MS;
  const batchSize = Math.max(1, Math.floor(
    Number.isFinite(o.batchSize) ? o.batchSize : DEFAULT_BATCH_SIZE,
  ));
  const interBatchDelayMs = Number.isFinite(o.interBatchDelayMs)
    ? o.interBatchDelayMs : DEFAULT_INTER_BATCH_DELAY_MS;
  const concurrency = Math.max(1, Math.floor(
    Number.isFinite(o.concurrency) ? o.concurrency : 1,
  ));
  const fetchImpl = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const onRateLimit = typeof o.onRateLimit === 'function' ? o.onRateLimit : null;
  const sleepImpl = typeof o.sleep === 'function' ? o.sleep : sleep;
  if (!fetchImpl) throw new Error('No fetch implementation available — pass opts.fetch');

  // Pre-compute batch boundaries so workers can pull off a shared
  // cursor regardless of `concurrency`.
  const batches = [];
  for (let i = 0; i < samples.length; i += batchSize) {
    batches.push({ start: i, end: Math.min(i + batchSize, samples.length) });
  }

  const out = new Array(samples.length);
  let cursor = 0;
  let firstError = null;

  async function processBatch(batchIndex) {
    const { start, end } = batches[batchIndex];
    const slice = samples.slice(start, end);
    const lats = slice.map(s => s.lat).join(',');
    const lons = slice.map(s => s.lon).join(',');
    const url  = `${endpoint}?latitude=${lats}&longitude=${lons}`;
    const data = await fetchWithRetry(fetchImpl, url, {
      retries, backoffMs, rateLimitBackoffMs, timeoutMs, onRateLimit, sleep: sleepImpl,
    });
    const elev = Array.isArray(data?.elevation) ? data.elevation : [];
    for (let j = 0; j < slice.length; j++) {
      const v = elev[j];
      out[start + j] = Number.isFinite(v) ? v : undefined;
    }
  }

  async function worker() {
    // Stop dispatching new batches once any sibling has failed so the
    // first error surfaces quickly instead of waiting for in-flight
    // batches that follow it.
    //
    // The politeness delay is applied *between* successive batches
    // handled by the same worker — never before its first fetch —
    // regardless of which global batch index that first fetch happens
    // to be. With concurrency=1 this still yields N-1 delays for N
    // batches; with concurrency>k each of the k workers gets its own
    // (M_w − 1) delays where M_w is how many batches that worker
    // handled. This mirrors the original sequential behaviour without
    // imposing a spurious "warm-up" sleep on workers that picked up
    // batch index ≥ 1 as their first task.
    let didFetch = false;
    while (cursor < batches.length && firstError == null) {
      const myIdx = cursor++;
      if (didFetch && interBatchDelayMs > 0) {
        await sleepImpl(interBatchDelayMs);
      }
      try {
        await processBatch(myIdx);
      } catch (e) {
        if (firstError == null) firstError = e;
        return;
      }
      didFetch = true;
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, batches.length || 1) }, worker);
  await Promise.all(workers);
  if (firstError != null) throw firstError;
  return out;
}

/**
 * Dedup a list of {lat, lon} samples by their quantised position
 * (5 dp ≈ 1.1 m, the same bucket the enricher uses to look points
 * up). Issues `fetchFn(uniqueSamples)` once and returns an array of
 * elevations that's index-aligned with the original `samples` —
 * duplicates pull from the same cached fetch result. At Open-Meteo's
 * SRTM 90 m resolution, a centre point and a neighbour ~30 m away
 * frequently quantise to the same cell, so on real city data this
 * typically halves the number of HTTP samples without changing the
 * output payload.
 */
async function fetchElevationsDedup(samples, fetchFn) {
  const indexByKey = new Map();   // qkey → index in `unique`
  const unique = [];
  const indices = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const key = `${quantize(s.lat)},${quantize(s.lon)}`;
    let idx = indexByKey.get(key);
    if (idx === undefined) {
      idx = unique.length;
      indexByKey.set(key, idx);
      unique.push({ lat: s.lat, lon: s.lon });
    }
    indices[i] = idx;
  }
  const elevations = await fetchFn(unique);
  if (!Array.isArray(elevations) || elevations.length !== unique.length) {
    throw new Error(
      `elevation provider returned ${elevations?.length} values, expected ${unique.length} (deduplicated)`,
    );
  }
  const out = new Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = elevations[indices[i]];
  return { elevations: out, uniqueCount: unique.length };
}

/**
 * Parse an HTTP `Retry-After` header value. The header may be either an
 * integer number of seconds or an HTTP-date. Returns the wait in ms,
 * capped to MAX_RATE_LIMIT_BACKOFF_MS, or undefined if the value can't
 * be parsed / is non-positive.
 */
function parseRetryAfterMs(headerValue) {
  if (headerValue == null) return undefined;
  const s = String(headerValue).trim();
  if (s === '') return undefined;
  if (/^\d+$/.test(s)) {
    const ms = Number(s) * 1000;
    if (!Number.isFinite(ms) || ms <= 0) return undefined;
    return Math.min(ms, MAX_RATE_LIMIT_BACKOFF_MS);
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return undefined;
  const ms = t - Date.now();
  if (ms <= 0) return undefined;
  return Math.min(ms, MAX_RATE_LIMIT_BACKOFF_MS);
}

/**
 * Read a header value from a fetch Response in a defensive way. The
 * test stubs use plain objects without a `headers` getter; real
 * `fetch` returns a `Headers` instance.
 */
function readHeader(resp, name) {
  if (!resp) return undefined;
  const h = resp.headers;
  if (!h) return undefined;
  if (typeof h.get === 'function') return h.get(name);
  // Plain-object fallback (case-insensitive).
  const lower = name.toLowerCase();
  for (const k of Object.keys(h)) {
    if (k.toLowerCase() === lower) return h[k];
  }
  return undefined;
}

async function fetchWithRetry(fetchImpl, url, opts) {
  const { retries, backoffMs, rateLimitBackoffMs, timeoutMs, onRateLimit } = opts;
  const sleepImpl = typeof opts.sleep === 'function' ? opts.sleep : sleep;
  let lastErr = null;
  let nextSleepMs = 0; // overridden by Retry-After when a 429 sets it.
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = nextSleepMs > 0
        ? nextSleepMs
        : backoffMs * Math.pow(2, attempt - 1);
      await sleepImpl(wait);
      nextSleepMs = 0;
    }

    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    let nonRetryable = false;
    try {
      const resp = await fetchImpl(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Unfallatlas-DEM-Producer/' + PRODUCER_VERSION },
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!resp.ok) {
        lastErr = new Error(`Elevation HTTP ${resp.status}`);
        lastErr.status = resp.status;
        // 4xx (except 429) are not worth retrying. Same fast-fail
        // convention as scripts/producers/osm_producer.js.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          nonRetryable = true;
          throw lastErr;
        }
        if (resp.status === 429) {
          if (onRateLimit) { try { onRateLimit(); } catch (_) { /* ignore */ } }
          const retryAfter = parseRetryAfterMs(readHeader(resp, 'retry-after'));
          // Use Retry-After when present, otherwise the dedicated
          // rate-limit backoff with mild exponential growth (capped).
          const fallback = Math.min(
            rateLimitBackoffMs * Math.pow(2, attempt),
            MAX_RATE_LIMIT_BACKOFF_MS,
          );
          nextSleepMs = retryAfter !== undefined ? retryAfter : fallback;
        }
        continue;
      }
      return await resp.json();
    } catch (e) {
      lastErr = e;
      if (nonRetryable) throw lastErr;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Elevation call failed for unknown reason');
}

// ---------------------------------------------------------------------------
// Per-way slope from OSM data
// ---------------------------------------------------------------------------

/**
 * Read `osm_<slug>.json` (when present) and return one sample-pair
 * per way: { wayId, start: {lat,lon}, end: {lat,lon} }. Returns []
 * when no OSM data is available — the per-way slope pass is then
 * skipped silently. The OSM producer writes a top-level
 * `wayGeometries` table holding each matched way's endpoints; older
 * caches without that field cause this function to return [].
 */
function readOsmWaySpans(osmDir, citySlug) {
  if (!osmDir) return [];
  const file = path.join(osmDir, `osm_${citySlug}.json`);
  if (!fs.existsSync(file)) return [];
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return []; }
  const out = [];
  const wg = data.wayGeometries;
  if (wg && typeof wg === 'object') {
    for (const wayId of Object.keys(wg)) {
      const g = wg[wayId];
      if (!Array.isArray(g) || g.length < 2) continue;
      const a = g[0], b = g[g.length - 1];
      if (Number.isFinite(a?.lat) && Number.isFinite(a?.lon)
       && Number.isFinite(b?.lat) && Number.isFinite(b?.lon)) {
        out.push({ wayId, start: a, end: b });
      }
    }
  }
  return out;
}

/**
 * Compute mean grade (percent) for a set of way spans, given centre
 * elevations at each endpoint. Returns a `{ wayId: { road_slope_percent } }`
 * lookup table. Spans below 5 m horizontal length are skipped — they
 * would amplify SRTM noise out of all proportion to the actual slope.
 */
function computeWayElevations(spans, startElevs, endElevs) {
  const out = {};
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    const eA = startElevs[i], eB = endElevs[i];
    if (!Number.isFinite(eA) || !Number.isFinite(eB)) continue;
    const dLatM = (span.end.lat - span.start.lat) * M_PER_DEG_LAT;
    const cosLat = Math.cos((span.start.lat + span.end.lat) / 2 * Math.PI / 180);
    const dLonM = (span.end.lon - span.start.lon) * M_PER_DEG_LAT * cosLat;
    const dist  = Math.sqrt(dLatM * dLatM + dLonM * dLonM);
    if (dist < 5) continue;
    const slope = ((eB - eA) / dist) * 100;
    out[span.wayId] = { road_slope_percent: round1(slope) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dataset assembly
// ---------------------------------------------------------------------------

/**
 * Wire raw elevation samples into the on-disk payload expected by
 * `loadDemProvider`. Pure / synchronous; tests can drive it without
 * touching the network.
 *
 * @param {Array<{lat,lon}>} points       deduplicated accident points
 * @param {Array<number|undefined>} elevations  one number per (point × 5 samples),
 *                                              flattened in the order returned
 *                                              by `buildSampleSet` (c, n, s, e, w).
 * @param {object} [opts]
 *   - source         provenance label (default: OpenMeteo SRTM)
 *   - resolution_m   numeric DEM resolution (default: 90)
 *   - extractDate    ISO date for provenance (default: today)
 *   - confidence     per-point confidence label (default: undefined)
 *   - offsetM        neighbour offset used to derive the slope (default: 30)
 *   - wayElevations  optional `{ wayId: { road_slope_percent } }` table
 */
function buildDemDataset(points, elevations, opts) {
  const o = opts || {};
  const offsetM = Number.isFinite(o.offsetM) ? o.offsetM : NEIGHBOUR_OFFSET_M;
  const out = {
    source:       o.source       || DEFAULT_SOURCE,
    resolution_m: o.resolution_m || DEFAULT_RESOLUTION_M,
    extractDate:  o.extractDate  || new Date().toISOString().slice(0, 10),
    points:       [],
    wayElevations: o.wayElevations || {},
  };
  for (let i = 0; i < points.length; i++) {
    const base = i * 5;
    const c = elevations[base + 0];
    const samples = {
      n: elevations[base + 1],
      s: elevations[base + 2],
      e: elevations[base + 3],
      w: elevations[base + 4],
    };
    if (!Number.isFinite(c)) continue;
    const slope = computeSlopePercent(samples, offsetM);
    const entry = {
      lat: points[i].lat,
      lon: points[i].lon,
      elevation_m: round1(c),
    };
    if (slope !== undefined) entry.slope_percent = round1(slope);
    if (o.confidence) entry.confidence = o.confidence;
    out.points.push(entry);
  }
  return out;
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
  // Resume support: if the per-city output already exists, skip the
  // (very expensive) elevation fetches. See osm_producer.js for the
  // motivation; here it matters even more because Open-Meteo
  // 429-cool-downs are 60 s each. Pass `force: true` (CLI: `--force`)
  // to bypass.
  const outDirEarly = o.outDir;
  if (outDirEarly && !o.force) {
    const existingOut = path.join(outDirEarly, `dem_${citySlug}.json`);
    if (fs.existsSync(existingOut)) {
      return { citySlug, skipped: true, reason: 'already cached', outFile: existingOut };
    }
  }
  let fc;
  try {
    fc = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (e) {
    return { citySlug, skipped: true, reason: `invalid input geojson: ${e.message}` };
  }
  const points = uniquePointsFromFeatureCollection(fc);
  if (points.length === 0) {
    return { citySlug, skipped: true, reason: 'no usable coordinates' };
  }

  const offsetM = Number.isFinite(o.offsetM) ? o.offsetM : NEIGHBOUR_OFFSET_M;
  const osmDir  = o.osmDir || process.env.ENRICH_OSM_DATA_DIR || null;
  const spans   = readOsmWaySpans(osmDir, citySlug);

  // ------------------------------------------------------------------
  // Determine which path to use: local tile sampler (default) or HTTP.
  // ------------------------------------------------------------------
  const tilesDir = o.tilesDir || process.env.ENRICH_DEM_TILES_DIR || null;
  const useLocalTiles = tilesDir && !o.useApi && !o.fetchElevations;

  if (useLocalTiles) {
    // LOCAL TILE PATH — zero network calls in the hot path.
    // One lookup per point gives elevation + slope from the pixel gradient.
    const sampler = makeLocalElevationSampler(tilesDir);
    const results = points.map(pt =>
      sampler.sampleElevationWithSlope(pt.lat, pt.lon),
    );

    // Per-way slope via local tile lookup at way endpoints.
    let wayElevations = {};
    if (spans.length > 0) {
      const startElevs = spans.map(s => sampler.sampleElevation(s.start.lat, s.start.lon));
      const endElevs   = spans.map(s => sampler.sampleElevation(s.end.lat, s.end.lon));
      wayElevations = computeWayElevations(spans, startElevs, endElevs);
    }

    const dataset = buildDemDatasetLocal(points, results, {
      source:       o.source,
      resolution_m: Number.isFinite(o.resolution_m) ? o.resolution_m : o.resolutionM,
      extractDate:  o.extractDate,
      confidence:   o.confidence,
      wayElevations,
    });

    const outDir = o.outDir;
    if (!outDir) throw new Error('produceCity: opts.outDir required');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `dem_${citySlug}.json`);
    fs.writeFileSync(outFile, JSON.stringify(dataset));

    const withElevation = dataset.points.length;
    return {
      citySlug,
      skipped: false,
      rateLimited: false,
      localTiles: true,
      counts: {
        uniquePoints:  points.length,
        withElevation,
        ways: Object.keys(wayElevations).length,
        // Local path: 1 lookup per unique point (no 5-sample expansion),
        // 2 lookups per way span (start + end endpoint).
        pointSamplesUnique: points.length,
        pointSamplesTotal:  points.length,
        waySamplesUnique:   spans.length * 2,
        waySamplesTotal:    spans.length * 2,
      },
      outFile,
    };
  }

  // ------------------------------------------------------------------
  // HTTP API PATH — original behaviour, kept for --use-api and tests.
  // ------------------------------------------------------------------
  let rateLimited = false;
  const onRateLimit = () => { rateLimited = true; };
  const fetchFn = o.fetchElevations || ((s) => fetchElevations(s, {
    endpoint:           o.endpoint,
    retries:            o.retries,
    backoffMs:          o.backoffMs,
    rateLimitBackoffMs: o.rateLimitBackoffMs,
    timeoutMs:          o.elevationTimeoutMs,
    batchSize:          o.batchSize,
    interBatchDelayMs:  o.interBatchDelayMs,
    concurrency:        o.concurrency,
    onRateLimit,
  }));

  // Per-point sample set (5 elevations each), flattened.
  const flatSamples = [];
  for (const pt of points) {
    for (const s of buildSampleSet(pt, offsetM)) flatSamples.push(s);
  }
  // Dedup at SRTM-grid precision (5 dp ≈ 1.1 m) before hitting the
  // network: a centre point and its ~30 m cardinal neighbours often
  // share a quantised cell, and so do nearby accidents' samples.
  const { elevations, uniqueCount: pointUniqueCount } =
    await fetchElevationsDedup(flatSamples, fetchFn);
  if (elevations.length !== flatSamples.length) {
    throw new Error(`elevation provider returned ${elevations.length} values, expected ${flatSamples.length}`);
  }

  // Per-way slope (best-effort): only when `osm_<slug>.json` is present.
  let wayElevations = {};
  let wayUniqueCount = 0;
  if (spans.length > 0) {
    const endpoints = [];
    for (const span of spans) endpoints.push(span.start, span.end);
    const dedup = await fetchElevationsDedup(endpoints, fetchFn);
    const elevs = dedup.elevations;
    wayUniqueCount = dedup.uniqueCount;
    const startElevs = [];
    const endElevs   = [];
    for (let i = 0; i < spans.length; i++) {
      startElevs.push(elevs[i * 2 + 0]);
      endElevs.push  (elevs[i * 2 + 1]);
    }
    wayElevations = computeWayElevations(spans, startElevs, endElevs);
  }

  const dataset = buildDemDataset(points, elevations, {
    source:       o.source,
    resolution_m: Number.isFinite(o.resolution_m) ? o.resolution_m : o.resolutionM,
    extractDate:  o.extractDate,
    confidence:   o.confidence,
    offsetM,
    wayElevations,
  });

  const outDir = o.outDir;
  if (!outDir) throw new Error('produceCity: opts.outDir required');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `dem_${citySlug}.json`);
  fs.writeFileSync(outFile, JSON.stringify(dataset));

  return {
    citySlug,
    skipped: false,
    rateLimited,
    localTiles: false,
    counts: {
      uniquePoints: points.length,
      withElevation: dataset.points.length,
      ways:          Object.keys(wayElevations).length,
      // How many distinct elevation samples we actually fetched after
      // dedup, vs. the naive 5×uniquePoints + 2×ways. Useful for
      // confirming the dedup ratio in CI logs.
      pointSamplesUnique: pointUniqueCount,
      pointSamplesTotal:  flatSamples.length,
      waySamplesUnique:   wayUniqueCount,
      waySamplesTotal:    spans.length * 2,
    },
    outFile,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    cities: [],
    outDir:   process.env.ENRICH_DEM_DATA_DIR   || '.enrichment-cache/dem',
    osmDir:   process.env.ENRICH_OSM_DATA_DIR   || null,
    tilesDir: process.env.ENRICH_DEM_TILES_DIR  || null,
    interCityDelayMs:    DEFAULT_INTER_CITY_DELAY_MS,
    rateLimitCooldownMs: DEFAULT_RATE_LIMIT_COOLDOWN_MS,
    json: false,
    useApi: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--city')                   opts.cities.push(argv[++i]);
    else if (a === '--out-dir')           opts.outDir = argv[++i];
    else if (a === '--osm-dir')           opts.osmDir = argv[++i];
    else if (a === '--tiles-dir')         opts.tilesDir = argv[++i];
    else if (a === '--use-api')           opts.useApi = true;
    else if (a === '--source')            opts.source = argv[++i];
    else if (a === '--resolution')        opts.resolution_m = Number(argv[++i]);
    else if (a === '--delay')             opts.interCityDelayMs = Number(argv[++i]);
    else if (a === '--inter-batch-delay') opts.interBatchDelayMs = Number(argv[++i]);
    else if (a === '--concurrency')       opts.concurrency = Number(argv[++i]);
    else if (a === '--retries')           opts.retries = Number(argv[++i]);
    else if (a === '--rate-limit-backoff') opts.rateLimitBackoffMs = Number(argv[++i]);
    else if (a === '--rate-limit-cooldown') opts.rateLimitCooldownMs = Number(argv[++i]);
    else if (a === '--force')             opts.force = true;
    else if (a === '--json')              opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--'))     console.warn(`[dem-producer] unknown flag ignored: ${a}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
`Usage: node scripts/producers/dem_producer.js [options]

  --city <name>          produce only this city (repeatable);
                         default: every city listed in cities.txt
  --out-dir <path>       output directory (default: $ENRICH_DEM_DATA_DIR
                         or .enrichment-cache/dem)
  --osm-dir <path>       directory holding osm_<slug>.json (used to
                         compute per-way road_slope_percent;
                         default: $ENRICH_OSM_DATA_DIR)
  --tiles-dir <path>     directory holding downloaded SRTM .hgt tiles
                         (default: $ENRICH_DEM_TILES_DIR). When set and
                         --use-api is not passed, tile sampling is used
                         instead of the Open-Meteo API.
  --use-api              force the HTTP API path even when --tiles-dir
                         is set (useful for debugging or offline gaps)
  --source <label>       provenance label written into each entry
                         (default: ${LOCAL_SOURCE} / ${DEFAULT_SOURCE})
  --resolution <m>       DEM resolution in metres written into the
                         payload (default: ${LOCAL_RESOLUTION_M} / ${DEFAULT_RESOLUTION_M})
  --delay <ms>           politeness delay between cities (default: ${DEFAULT_INTER_CITY_DELAY_MS})
  --inter-batch-delay <ms>
                         politeness delay between elevation batches
                         within a city (default: ${DEFAULT_INTER_BATCH_DELAY_MS})
  --concurrency <n>      number of elevation batches to dispatch in
                         parallel within a city (default: 1; Open-Meteo
                         tolerates up to ~4–5 concurrent requests when
                         combined with the inter-batch delay)
  --retries <n>          retries per elevation request (default: ${DEFAULT_ELEVATION_RETRIES})
  --rate-limit-backoff <ms>
                         base backoff after HTTP 429 when the server
                         doesn't send Retry-After (default: ${DEFAULT_RATE_LIMIT_BACKOFF_MS})
  --rate-limit-cooldown <ms>
                         extra cool-down before the next city after
                         this one tripped a 429 (default: ${DEFAULT_RATE_LIMIT_COOLDOWN_MS})
  --force                re-fetch every city even if dem_<slug>.json
                         already exists in the output directory
                         (default: resume — skip cities whose output
                         file is already present)
  --json                 emit machine-readable summary

Environment:
  ENRICH_DEM_DATA_DIR              fallback for --out-dir
  ENRICH_OSM_DATA_DIR              fallback for --osm-dir
  ENRICH_DEM_TILES_DIR             fallback for --tiles-dir (enables local
                                   tile sampling when set)
  OPEN_METEO_ELEVATION_ENDPOINT    override elevation API endpoint
                                   (default: ${DEFAULT_ELEVATION_ENDPOINT})
`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  const repoRoot = path.resolve(__dirname, '..', '..');
  let citySlugs = opts.cities.map(slugCity);
  if (citySlugs.length === 0) citySlugs = readCitiesTxt(repoRoot).map(slugCity);
  if (citySlugs.length === 0) {
    console.error('[dem-producer] no cities to process (cities.txt empty and no --city given)');
    return 2;
  }

  const summary = { producer: 'dem', producerVersion: PRODUCER_VERSION, cities: [] };
  let exit = 0;
  // When the upstream API rate-limits us, the connection is often
  // closed for a while afterwards (next requests get "fetch failed").
  // Wait at least `rateLimitCooldownMs` before touching it again.
  let coolDownUntil = 0;
  for (let i = 0; i < citySlugs.length; i++) {
    const slug = citySlugs[i];
    if (i > 0) {
      const baseDelay = opts.interCityDelayMs > 0 ? opts.interCityDelayMs : 0;
      const cooldown  = Math.max(0, coolDownUntil - Date.now());
      const wait = Math.max(baseDelay, cooldown);
      if (wait > 0) {
        if (cooldown > 0 && !opts.json) {
          console.log(`[dem-producer] cooling down ${Math.round(wait / 1000)}s after rate-limit before ${slug}`);
        }
        await sleep(wait);
      }
    }
    try {
      const r = await produceCity(repoRoot, slug, opts);
      summary.cities.push(r);
      if (r.rateLimited) {
        coolDownUntil = Date.now() + (opts.rateLimitCooldownMs || 0);
      }
      if (!opts.json) {
        if (r.skipped) {
          console.log(`[dem-producer] ${slug}: SKIP (${r.reason})`);
        } else {
          const dedupNote = (Number.isFinite(r.counts.pointSamplesUnique) && Number.isFinite(r.counts.pointSamplesTotal) && r.counts.pointSamplesTotal > 0)
            ? ` [${r.counts.pointSamplesUnique}/${r.counts.pointSamplesTotal} samples after dedup]`
            : '';
          console.log(
            `[dem-producer] ${slug}: ${r.counts.withElevation}/${r.counts.uniquePoints} unique points elevated, ` +
            `${r.counts.ways} ways with road_slope_percent${dedupNote} → ${r.outFile}`
          );
        }
      }
    } catch (e) {
      // One city's failure must not abort the whole producer run —
      // the enrichment script silently no-ops on missing files.
      exit = 1;
      const errEntry = { citySlug: slug, skipped: true, reason: `error: ${e.message}` };
      summary.cities.push(errEntry);
      if (!opts.json) console.error(`[dem-producer] ${slug}: ERROR ${e.message}`);
      // Cool down on any rate-limit-shaped failure so we don't immediately
      // re-trigger the upstream block on the next city.
      if (isRateLimitError(e)) {
        coolDownUntil = Date.now() + (opts.rateLimitCooldownMs || 0);
      }
    }
  }
  if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return exit;
}

function isRateLimitError(err) {
  if (!err) return false;
  if (err.status === 429) return true;
  const msg = String(err.message || err);
  // "HTTP 429" from fetchWithRetry, "fetch failed" cascade after 429.
  return /\b429\b/.test(msg) || /fetch failed/i.test(msg);
}

if (require.main === module) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error('[dem-producer] fatal:', e);
    process.exit(1);
  });
}

module.exports = {
  PRODUCER_VERSION,
  DEFAULT_SOURCE,
  DEFAULT_RESOLUTION_M,
  LOCAL_SOURCE,
  LOCAL_RESOLUTION_M,
  DEFAULT_RATE_LIMIT_BACKOFF_MS,
  DEFAULT_RATE_LIMIT_COOLDOWN_MS,
  DEFAULT_INTER_BATCH_DELAY_MS,
  MAX_RATE_LIMIT_BACKOFF_MS,
  NEIGHBOUR_OFFSET_M,
  SRTM_NO_DATA,
  slugCity,
  readCitiesTxt,
  quantize,
  uniquePointsFromFeatureCollection,
  buildSampleSet,
  computeSlopePercent,
  computeWayElevations,
  readOsmWaySpans,
  fetchElevations,
  fetchElevationsDedup,
  parseRetryAfterMs,
  isRateLimitError,
  makeTileName,
  makeLocalElevationSampler,
  buildDemDataset,
  buildDemDatasetLocal,
  produceCity,
  parseArgs,
  main,
};
