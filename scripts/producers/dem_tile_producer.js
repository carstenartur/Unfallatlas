#!/usr/bin/env node
'use strict';

/**
 * scripts/producers/dem_tile_producer.js
 *
 * Downloads SRTM 1°×1° HGT elevation tiles for the cities listed in
 * `cities.txt` and caches them under `$ENRICH_DEM_TILES_DIR` (default
 * `.enrichment-cache/dem-tiles/`). Once present, the tiles are consumed
 * by `makeLocalElevationSampler` in `dem_producer.js` to replace all
 * Open-Meteo API calls with in-process tile lookups.
 *
 * Tile source
 * -----------
 * AWS Open Data SRTM HTTPS mirror — no API key, no login:
 *   https://s3.amazonaws.com/elevation-tiles-prod/skadi/<NS><lat:02d>/<name>.hgt.gz
 *
 * These are SRTM1 tiles (1 arc-second ≈ 30 m resolution), 3601×3601
 * Int16 samples, big-endian. No-data marker: −32768.
 *
 * Cache key: `dem-tiles-1.0.0-YYYY` — SRTM data is essentially static.
 * `save-always: true` in the workflow so a partial download persists.
 *
 * CLI
 * ---
 *   node scripts/producers/dem_tile_producer.js [--city <name>]
 *                                               [--out-dir <path>]
 *                                               [--force]
 *
 * Logging (human-readable):
 *   [dem-tile-producer] downloading N50E007.hgt.gz (city hannover) ...
 *   [dem-tile-producer] N50E007 cached — skipping
 *   [dem-tile-producer] done: 12 downloaded, 8 cached, 0 errors
 */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const PRODUCER_VERSION = '1.0.0';

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Tile naming (SRTM 1°×1° convention)
// ---------------------------------------------------------------------------

/**
 * Return the SRTM tile name (e.g. "N50E007") for the tile that contains
 * (lat, lon). The tile covers [floor(lat), floor(lat)+1) × [floor(lon), floor(lon)+1).
 */
function tileName(lat, lon) {
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
 * Return the set of tile names needed to fully cover `bbox`.
 * `bbox` is {minLat, maxLat, minLon, maxLon} (same shape as in osm_producer.js).
 */
function tilesForBbox(bbox) {
  if (!bbox) return [];
  const minLat = Math.floor(bbox.minLat);
  const maxLat = Math.floor(bbox.maxLat);
  const minLon = Math.floor(bbox.minLon);
  const maxLon = Math.floor(bbox.maxLon);
  const names = [];
  for (let lat = minLat; lat <= maxLat; lat++) {
    for (let lon = minLon; lon <= maxLon; lon++) {
      names.push(tileName(lat, lon));
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Bounding-box helpers (local copy — keeps this script self-contained)
// ---------------------------------------------------------------------------

function bboxFromFeatureCollection(fc) {
  if (!fc || !Array.isArray(fc.features)) return null;
  let minLat = Infinity, maxLat = -Infinity;
  let minLon = Infinity, maxLon = -Infinity;
  for (const f of fc.features) {
    const c = f && f.geometry && f.geometry.coordinates;
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = +c[0], lat = +c[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  if (!Number.isFinite(minLat)) return null;
  return { minLat, maxLat, minLon, maxLon };
}

// ---------------------------------------------------------------------------
// City slug / cities.txt — kept in sync with dem_producer.js
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
// Tile download
// ---------------------------------------------------------------------------

// Valid decompressed byte sizes for SRTM tiles (Int16, big-endian).
const SRTM1_BYTES = 3601 * 3601 * 2; // ~26 MB — SRTM1 (1″ ≈ 30 m)
const SRTM3_BYTES = 1201 * 1201 * 2; // ~2.9 MB — SRTM3 (3″ ≈ 90 m)
function tileUrls(name) {
  const lat = parseInt(name.slice(1, 3), 10);
  const ns = name[0]; // 'N' or 'S'
  const dir = ns + String(lat).padStart(2, '0');
  return [
    // AWS Open Data SRTM HTTPS mirror (primary, no auth)
    `https://s3.amazonaws.com/elevation-tiles-prod/skadi/${dir}/${name}.hgt.gz`,
  ];
}

/**
 * Download a single tile (identified by its SRTM name such as "N50E007")
 * into `tilesDir` as `<name>.hgt`.
 *
 * Returns { name, cached, downloaded, bytes, error }.
 *
 * opts:
 *   fetch       — injectable fetch implementation (for tests)
 *   force       — re-download even if the file already exists
 *   silent      — suppress console output
 *   timeout     — per-request timeout in ms (default: 60 000)
 */
async function downloadTile(name, tilesDir, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) throw new Error('No fetch implementation available — pass opts.fetch');

  const outPath = path.join(tilesDir, name + '.hgt');

  if (!o.force && fs.existsSync(outPath)) {
    if (!o.silent) console.log(`[dem-tile-producer] ${name} cached — skipping`);
    return { name, cached: true, downloaded: false };
  }

  const urls = tileUrls(name);
  let lastErr = null;

  for (const url of urls) {
    if (!o.silent) {
      const city = o.city ? ` (city ${o.city})` : '';
      console.log(`[dem-tile-producer] downloading ${name}.hgt.gz${city} ...`);
    }
    const timeout = o.timeout || DEFAULT_DOWNLOAD_TIMEOUT_MS;
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;
    try {
      const resp = await fetchImpl(url, {
        method: 'GET',
        signal: ctrl ? ctrl.signal : undefined,
        headers: { 'User-Agent': 'Unfallatlas-DEM-TileProducer/' + PRODUCER_VERSION },
      });
      if (!resp.ok) {
        lastErr = new Error(`HTTP ${resp.status} for ${name} from ${url}`);
        continue;
      }
      const gzBuf = Buffer.from(await resp.arrayBuffer());
      const hgtBuf = zlib.gunzipSync(gzBuf);
      // Validate decompressed size against known SRTM tile sizes.
      if (hgtBuf.length !== SRTM1_BYTES && hgtBuf.length !== SRTM3_BYTES) {
        lastErr = new Error(
          `Unexpected tile size ${hgtBuf.length} bytes for ${name} (expected ${SRTM1_BYTES} or ${SRTM3_BYTES})`,
        );
        continue;
      }
      if (!fs.existsSync(tilesDir)) fs.mkdirSync(tilesDir, { recursive: true });
      // Atomic write: write to a temp file first, then rename so an
      // interrupted write doesn't leave a truncated/corrupt .hgt file
      // that would be incorrectly treated as cached on the next run.
      const tmpPath = outPath + '.tmp';
      fs.writeFileSync(tmpPath, hgtBuf);
      fs.renameSync(tmpPath, outPath);
      if (!o.silent) {
        const mb = (hgtBuf.length / 1_048_576).toFixed(1);
        console.log(`[dem-tile-producer] ${name}.hgt saved (${mb} MB uncompressed)`);
      }
      return { name, cached: false, downloaded: true, bytes: hgtBuf.length };
    } catch (e) {
      lastErr = e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { name, cached: false, downloaded: false, error: lastErr };
}

/**
 * Compute the tiles needed for a set of city slugs, download any that
 * are missing, and return a summary.
 *
 * opts:
 *   fetch, force, silent, timeout  — passed through to downloadTile
 */
async function downloadTilesForCities(repoRoot, citySlugs, tilesDir, opts) {
  const o = opts || {};
  const tileSet = new Set();

  for (const slug of citySlugs) {
    const geojsonPath = path.join(repoRoot, 'out', `output_all_years_${slug}.geojson`);
    if (!fs.existsSync(geojsonPath)) {
      if (!o.silent) console.warn(`[dem-tile-producer] ${slug}: no geojson, skipping tile computation`);
      continue;
    }
    let fc;
    try { fc = JSON.parse(fs.readFileSync(geojsonPath, 'utf8')); }
    catch (e) {
      if (!o.silent) console.warn(`[dem-tile-producer] ${slug}: invalid geojson, skipping`);
      continue;
    }
    const bbox = bboxFromFeatureCollection(fc);
    if (!bbox) {
      if (!o.silent) console.warn(`[dem-tile-producer] ${slug}: no usable coordinates, skipping`);
      continue;
    }
    for (const t of tilesForBbox(bbox)) tileSet.add(t);
  }

  const tiles = [...tileSet].sort();
  const summary = { downloaded: 0, cached: 0, errors: 0, tiles: [] };

  for (const name of tiles) {
    const result = await downloadTile(name, tilesDir, { ...o, city: undefined });
    summary.tiles.push(result);
    if (result.error) {
      summary.errors++;
      if (!o.silent) console.error(`[dem-tile-producer] ${name}: ERROR ${result.error.message}`);
    } else if (result.cached) {
      summary.cached++;
    } else {
      summary.downloaded++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    cities: [],
    outDir: process.env.ENRICH_DEM_TILES_DIR || '.enrichment-cache/dem-tiles',
    force: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--city')          opts.cities.push(argv[++i]);
    else if (a === '--out-dir')  opts.outDir = argv[++i];
    else if (a === '--force')    opts.force = true;
    else if (a === '--json')     opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a.startsWith('--')) console.warn(`[dem-tile-producer] unknown flag ignored: ${a}`);
  }
  return opts;
}

function printHelp() {
  process.stdout.write(
`Usage: node scripts/producers/dem_tile_producer.js [options]

  --city <name>    download tiles for this city only (repeatable);
                   default: every city in cities.txt
  --out-dir <path> tile output directory (default: $ENRICH_DEM_TILES_DIR
                   or .enrichment-cache/dem-tiles)
  --force          re-download even if the tile file already exists
  --json           emit machine-readable summary

Tiles are downloaded from the AWS Open Data SRTM HTTPS mirror:
  https://s3.amazonaws.com/elevation-tiles-prod/skadi/

Each tile is an SRTM1 1°×1° HGT file (3601×3601 Int16 big-endian samples,
~26 MB uncompressed). Tiles cover Germany with roughly 30 tiles.

Environment:
  ENRICH_DEM_TILES_DIR    fallback for --out-dir
`);
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { printHelp(); return 0; }

  const repoRoot = path.resolve(__dirname, '..', '..');
  let citySlugs = opts.cities.map(slugCity);
  if (citySlugs.length === 0) citySlugs = readCitiesTxt(repoRoot).map(slugCity);
  if (citySlugs.length === 0) {
    console.error('[dem-tile-producer] no cities to process (cities.txt empty and no --city given)');
    return 2;
  }

  const summary = await downloadTilesForCities(repoRoot, citySlugs, opts.outDir, {
    force: opts.force,
    silent: opts.json,
  });

  if (!opts.json) {
    console.log(
      `[dem-tile-producer] done: ${summary.downloaded} downloaded, ` +
      `${summary.cached} cached, ${summary.errors} errors`,
    );
  } else {
    process.stdout.write(JSON.stringify({ producer: 'dem-tiles', producerVersion: PRODUCER_VERSION, ...summary }, null, 2) + '\n');
  }

  return summary.errors > 0 ? 1 : 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(c => process.exit(c)).catch(e => {
    console.error('[dem-tile-producer] fatal:', e);
    process.exit(1);
  });
}

module.exports = {
  PRODUCER_VERSION,
  tileName,
  tilesForBbox,
  bboxFromFeatureCollection,
  slugCity,
  readCitiesTxt,
  downloadTile,
  downloadTilesForCities,
  tileUrls,
  parseArgs,
  main,
};
