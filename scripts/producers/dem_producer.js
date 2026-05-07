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
 *   3. For every unique point, samples elevation at 5 locations: the
 *      point itself plus four cardinal neighbours offset by ~30 m.
 *      The four neighbours give a local NS / EW gradient, from which
 *      the steepest signed slope (in percent) is derived.
 *   4. Optionally enriches per-way data: when `osm_<slug>.json` is
 *      available (typically produced by `osm_producer.js`), the mean
 *      grade between each way's first and last node is computed and
 *      written to `wayElevations[<wayId>].road_slope_percent`.
 *   5. Writes the on-disk payload expected by `loadDemProvider`:
 *
 *        {
 *          source:       "OpenMeteo SRTM",
 *          resolution_m: 90,
 *          points:        [ { lat, lon, elevation_m, slope_percent, confidence } ],
 *          wayElevations: { "<wayId>": { road_slope_percent } }
 *        }
 *
 * Elevation source
 * ----------------
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
const DEFAULT_ELEVATION_RETRIES   = 3;
const DEFAULT_ELEVATION_BACKOFF_MS = 5_000;
const DEFAULT_INTER_CITY_DELAY_MS = 1_000;
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
// Elevation fetch (Open-Meteo) with retry/backoff
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch elevations for an array of {lat, lon} samples. Returns an
 * array of numbers (or undefined for failed samples) in the same order.
 *
 * The request is split into batches of `batchSize` samples — Open-Meteo
 * accepts up to 100 coordinates per call.
 */
async function fetchElevations(samples, opts) {
  const o = opts || {};
  const endpoint  = o.endpoint  || process.env.OPEN_METEO_ELEVATION_ENDPOINT || DEFAULT_ELEVATION_ENDPOINT;
  const retries   = Number.isFinite(o.retries)   ? o.retries   : DEFAULT_ELEVATION_RETRIES;
  const backoffMs = Number.isFinite(o.backoffMs) ? o.backoffMs : DEFAULT_ELEVATION_BACKOFF_MS;
  const timeoutMs = Number.isFinite(o.timeoutMs) ? o.timeoutMs : DEFAULT_ELEVATION_TIMEOUT_MS;
  const batchSize = Number.isFinite(o.batchSize) ? o.batchSize : DEFAULT_BATCH_SIZE;
  const fetchImpl = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('No fetch implementation available — pass opts.fetch');

  const out = new Array(samples.length);
  for (let i = 0; i < samples.length; i += batchSize) {
    const slice = samples.slice(i, i + batchSize);
    const lats = slice.map(s => s.lat).join(',');
    const lons = slice.map(s => s.lon).join(',');
    const url  = `${endpoint}?latitude=${lats}&longitude=${lons}`;

    const data = await fetchWithRetry(fetchImpl, url, {
      retries, backoffMs, timeoutMs,
    });
    const elev = Array.isArray(data?.elevation) ? data.elevation : [];
    for (let j = 0; j < slice.length; j++) {
      const v = elev[j];
      out[i + j] = Number.isFinite(v) ? v : undefined;
    }
  }
  return out;
}

async function fetchWithRetry(fetchImpl, url, opts) {
  const { retries, backoffMs, timeoutMs } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(backoffMs * Math.pow(2, attempt - 1));

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
        // 4xx (except 429) are not worth retrying. Same fast-fail
        // convention as scripts/producers/osm_producer.js.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          nonRetryable = true;
          throw lastErr;
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
  const fetchFn = o.fetchElevations || ((s) => fetchElevations(s, {
    endpoint:  o.endpoint,
    retries:   o.retries,
    backoffMs: o.backoffMs,
    timeoutMs: o.elevationTimeoutMs,
    batchSize: o.batchSize,
  }));

  // Per-point sample set (5 elevations each), flattened.
  const flatSamples = [];
  for (const pt of points) {
    for (const s of buildSampleSet(pt, offsetM)) flatSamples.push(s);
  }
  const elevations = await fetchFn(flatSamples);
  if (!Array.isArray(elevations) || elevations.length !== flatSamples.length) {
    throw new Error(`elevation provider returned ${elevations?.length} values, expected ${flatSamples.length}`);
  }

  // Per-way slope (best-effort): only when `osm_<slug>.json` is present.
  const osmDir = o.osmDir || process.env.ENRICH_OSM_DATA_DIR || null;
  const spans = readOsmWaySpans(osmDir, citySlug);
  let wayElevations = {};
  if (spans.length > 0) {
    const endpoints = [];
    for (const span of spans) endpoints.push(span.start, span.end);
    const elevs = await fetchFn(endpoints);
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
    resolution_m: o.resolutionM,
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
    counts: {
      uniquePoints: points.length,
      withElevation: dataset.points.length,
      ways:          Object.keys(wayElevations).length,
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
    outDir: process.env.ENRICH_DEM_DATA_DIR || '.enrichment-cache/dem',
    osmDir: process.env.ENRICH_OSM_DATA_DIR || null,
    interCityDelayMs: DEFAULT_INTER_CITY_DELAY_MS,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--city')              opts.cities.push(argv[++i]);
    else if (a === '--out-dir')      opts.outDir = argv[++i];
    else if (a === '--osm-dir')      opts.osmDir = argv[++i];
    else if (a === '--delay')        opts.interCityDelayMs = Number(argv[++i]);
    else if (a === '--json')         opts.json = true;
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
  --delay <ms>           politeness delay between cities (default: ${DEFAULT_INTER_CITY_DELAY_MS})
  --json                 emit machine-readable summary

Environment:
  ENRICH_DEM_DATA_DIR              fallback for --out-dir
  ENRICH_OSM_DATA_DIR              fallback for --osm-dir
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
  for (let i = 0; i < citySlugs.length; i++) {
    const slug = citySlugs[i];
    if (i > 0 && opts.interCityDelayMs > 0) await sleep(opts.interCityDelayMs);
    try {
      const r = await produceCity(repoRoot, slug, opts);
      summary.cities.push(r);
      if (!opts.json) {
        if (r.skipped) {
          console.log(`[dem-producer] ${slug}: SKIP (${r.reason})`);
        } else {
          console.log(
            `[dem-producer] ${slug}: ${r.counts.withElevation}/${r.counts.uniquePoints} unique points elevated, ` +
            `${r.counts.ways} ways with road_slope_percent → ${r.outFile}`
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
    }
  }
  if (opts.json) process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return exit;
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
  NEIGHBOUR_OFFSET_M,
  slugCity,
  readCitiesTxt,
  quantize,
  uniquePointsFromFeatureCollection,
  buildSampleSet,
  computeSlopePercent,
  computeWayElevations,
  readOsmWaySpans,
  fetchElevations,
  buildDemDataset,
  produceCity,
  parseArgs,
  main,
};
