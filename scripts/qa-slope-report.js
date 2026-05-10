#!/usr/bin/env node
/**
 * scripts/qa-slope-report.js
 *
 * PR-berlin-slope-qa: per-viewport slope-quality report. Restricted to
 * the ways whose geometry intersects a viewport bbox (default: Berlin
 * Mitte at z=16) so the on-screen slope colours can be verified
 * one-way-at-a-time against `road_slope_percent` and (when available)
 * the per-segment elevation deltas the producer used.
 *
 * Two data sources, in priority order:
 *
 *   1. **Full diagnostic** — when the producer artefacts are still on
 *      disk (`out/osm_<slug>.json` for polylines, `ENRICH_DEM_TILES_DIR`
 *      for SRTM tiles), we re-run `_sampleAlongPolyline` +
 *      `makeLocalElevationSampler` from `scripts/producers/dem_producer.js`
 *      so the report shows the *exact* numbers the producer used.
 *
 *   2. **Tile-only fallback** — when those artefacts aren't checked
 *      in (typical for the public repo), the report still emits one
 *      row per way with the per-way attrs from
 *      `out/ctxtiles/<slug>/<x>/<y>.json` (way_id, road_slope_percent,
 *      road_slope_class, road_slope_method, road_slope_sample_count,
 *      road_slope_confidence, road_slope_max_abs_percent, geometry
 *      length) — segment_slopes_percent and dem_samples_m are then
 *      empty arrays.
 *
 * Outputs:
 *   out/qa/slope_<slug>.json   ← full diagnostic
 *   out/qa/slope_<slug>.csv    ← flat CSV (per-way columns; the
 *                                segment arrays are JSON-encoded)
 *
 * Usage:
 *   node scripts/qa-slope-report.js [--city berlin] \
 *     [--center-lat 52.521463 --center-lon 13.379320 --zoom 16] \
 *     [--bbox south,west,north,east]
 *   npm run qa:slope            # alias with the Berlin defaults
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const dem    = require('./producers/dem_producer.js');
const enrich = require('./enrich_geojson.js');

const REPO_ROOT = path.resolve(__dirname, '..');

// Berlin Mitte (Brandenburger Tor). Same defaults the issue requested.
const DEFAULTS = {
  city: 'berlin',
  centerLat: 52.521463,
  centerLon: 13.379320,
  zoom: 16,
  // 1280×800 viewport @ z=16 ~= 0.0125° lat × 0.029° lon. Accept an
  // override via --viewport-px=W,H so screenshots can be matched.
  viewportPx: { w: 1280, h: 800 },
};

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const out = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--city')         out.city      = next();
    else if (a === '--center-lat') out.centerLat = parseFloat(next());
    else if (a === '--center-lon') out.centerLon = parseFloat(next());
    else if (a === '--zoom')    out.zoom      = parseFloat(next());
    else if (a === '--bbox') {
      const parts = String(next()).split(',').map(Number);
      if (parts.length === 4 && parts.every(Number.isFinite)) {
        out.bbox = { south: parts[0], west: parts[1], north: parts[2], east: parts[3] };
      }
    }
    else if (a === '--viewport-px') {
      const parts = String(next()).split(',').map(Number);
      if (parts.length === 2) out.viewportPx = { w: parts[0], h: parts[1] };
    }
    else if (a === '--out-dir') out.outDir = next();
    else if (a === '--repo-root') out.repoRoot = path.resolve(next());
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node scripts/qa-slope-report.js [--city slug] [--center-lat N --center-lon E --zoom Z] [--bbox S,W,N,E] [--viewport-px W,H]');
      process.exit(0);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Viewport bbox math
//
// Web-Mercator pixel-space → degree extents for a `viewportPx` window
// centred on (lat, lon). Mirrors Leaflet's tile sizing (256 px tiles,
// scale = 2^zoom). Only used as a fallback when --bbox is not given.

function bboxFromViewport(centerLat, centerLon, zoom, viewportPx) {
  const tileSize = 256;
  const worldPx  = tileSize * Math.pow(2, zoom);
  const latRad   = centerLat * Math.PI / 180;

  const cx = (centerLon + 180) / 360 * worldPx;
  const cy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * worldPx;

  const halfW = viewportPx.w / 2;
  const halfH = viewportPx.h / 2;

  const pxToLon = (px) => (px / worldPx) * 360 - 180;
  const pxToLat = (px) => {
    const n = Math.PI - 2 * Math.PI * (px / worldPx);
    return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };

  const west  = pxToLon(cx - halfW);
  const east  = pxToLon(cx + halfW);
  const north = pxToLat(cy - halfH);
  const south = pxToLat(cy + halfH);
  return { south, west, north, east };
}

function bboxIntersectsLatLngs(bbox, latlngs) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const ll of latlngs) {
    const lat = ll[0], lon = ll[1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
  }
  if (!Number.isFinite(minLat)) return false;
  return !(maxLat < bbox.south || minLat > bbox.north || maxLon < bbox.west || minLon > bbox.east);
}

// ---------------------------------------------------------------------------
// Tile-only fallback: read attrs + geometry directly from the per-tile
// payloads. Decodes int-coded categoricals via the index dicts so the
// report shows human-readable highway tags.

function loadTilesForBbox(repoRoot, slug, bbox) {
  const baseDir = path.join(repoRoot, 'out', 'ctxtiles', slug);
  const indexPath = path.join(baseDir, 'index.json');
  if (!fs.existsSync(indexPath)) {
    return { ok: false, error: `tile index not found at ${path.relative(repoRoot, indexPath)}`, ways: [], dicts: {} };
  }
  let index;
  try { index = JSON.parse(fs.readFileSync(indexPath, 'utf8')); }
  catch (e) { return { ok: false, error: `tile index unreadable: ${e.message}`, ways: [], dicts: {} }; }
  const dicts = index.dicts || {};
  const z = Number.isInteger(index.z) ? index.z : 13;

  // Tiles touched by the bbox.
  const minTx = enrich.lonToTileX(bbox.west,  z);
  const maxTx = enrich.lonToTileX(bbox.east,  z);
  // latToTileY decreases as lat increases, so swap.
  const minTy = enrich.latToTileY(bbox.north, z);
  const maxTy = enrich.latToTileY(bbox.south, z);

  const seen = new Set();
  const ways = [];
  for (let x = minTx; x <= maxTx; x++) {
    for (let y = minTy; y <= maxTy; y++) {
      const tileFile = path.join(baseDir, String(x), `${y}.json`);
      if (!fs.existsSync(tileFile)) continue;
      let payload;
      try { payload = JSON.parse(fs.readFileSync(tileFile, 'utf8')); }
      catch (e) {
        console.warn(`[qa-slope] skipping unreadable tile ${path.relative(repoRoot, tileFile)}: ${e.message}`);
        continue;
      }
      const tWays = payload.ways || {};
      const tGeom = payload.geometries || {};
      for (const wayId of Object.keys(tWays)) {
        if (seen.has(wayId)) continue;
        const flat = tGeom[wayId];
        if (!Array.isArray(flat) || flat.length < 4 || (flat.length % 2) !== 0) continue;
        const latlngs = [];
        for (let i = 0; i < flat.length; i += 2) latlngs.push([flat[i], flat[i + 1]]);
        if (!bboxIntersectsLatLngs(bbox, latlngs)) continue;
        seen.add(wayId);
        // Decode dict-coded fields for human-readable output.
        const raw = tWays[wayId] || {};
        const decoded = {};
        for (const k of Object.keys(raw)) {
          const v = raw[k];
          const dict = dicts[k];
          decoded[k] = (Array.isArray(dict) && Number.isInteger(v) && v >= 0 && v < dict.length)
            ? dict[v] : v;
        }
        ways.push({ wayId, attrs: decoded, latlngs });
      }
    }
  }
  return { ok: true, ways, dicts };
}

// Geometry length in metres (haversine) — uses the dem_producer helper
// so length values match the producer's slope math exactly.
function polylineLengthM(latlngs) {
  let total = 0;
  for (let i = 1; i < latlngs.length; i++) {
    total += dem._haversineMeters(latlngs[i - 1][0], latlngs[i - 1][1], latlngs[i][0], latlngs[i][1]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Full-diagnostic mode: re-run the producer's sampler on the geometries
// it actually used (osm_<slug>.json) and emit per-segment slopes,
// elevation deltas, and DEM sample points.

function runFullDiagnostic(repoRoot, slug, bbox) {
  const osmDir = path.join(repoRoot, 'out');
  const spans = dem.readOsmWaySpans(osmDir, slug);
  if (!spans || spans.length === 0) return null;

  const tilesDir = process.env.ENRICH_DEM_TILES_DIR;
  let sampler = null;
  if (tilesDir && fs.existsSync(tilesDir)) {
    try { sampler = dem.makeLocalElevationSampler(tilesDir); }
    catch (e) { console.warn('[qa-slope] makeLocalElevationSampler failed:', e.message); }
  }
  if (!sampler) return null;

  const stepM = dem.WAY_SLOPE_SAMPLE_STEP_M;
  const minSegM = dem.WAY_SLOPE_MIN_SEGMENT_M;

  // Pre-filter spans to the bbox so we don't run the full network.
  const inBbox = spans.filter(span => {
    const ll = span.points.map(p => [p.lat, p.lon]);
    return bboxIntersectsLatLngs(bbox, ll);
  });
  if (inBbox.length === 0) return { ways: [], stepM, minSegM };

  const out = [];
  for (const span of inBbox) {
    const samples = dem._sampleAlongPolyline(span.points, stepM);
    if (samples.length < 2) continue;
    const totalLengthM = samples[samples.length - 1].distM;
    const elevs = samples.map(s => sampler(s.lat, s.lon));
    const segSlopes = [], segLengths = [], segDeltas = [];
    for (let i = 1; i < samples.length; i++) {
      const eA = elevs[i - 1], eB = elevs[i];
      const dist = samples[i].distM - samples[i - 1].distM;
      if (!Number.isFinite(eA) || !Number.isFinite(eB)) continue;
      if (dist < minSegM) continue;
      segSlopes.push(Math.round(((eB - eA) / dist) * 1000) / 10);
      segLengths.push(Math.round(dist * 10) / 10);
      segDeltas.push(Math.round((eB - eA) * 100) / 100);
    }
    out.push({
      wayId: span.wayId,
      latlngs: span.points.map(p => [p.lat, p.lon]),
      diag: {
        totalLengthM: Math.round(totalLengthM * 10) / 10,
        sampleCount: samples.length,
        usedSegmentCount: segSlopes.length,
        segmentSlopesPercent: segSlopes,
        segmentLengthsM: segLengths,
        elevationDeltasM: segDeltas,
        demSamplesM: samples.map((s, i) => ({
          lat: Math.round(s.lat * 1e6) / 1e6,
          lon: Math.round(s.lon * 1e6) / 1e6,
          elevM: Number.isFinite(elevs[i]) ? Math.round(elevs[i] * 100) / 100 : null,
          distM: Math.round(s.distM * 10) / 10,
        })),
      },
    });
  }
  return { ways: out, stepM, minSegM };
}

// ---------------------------------------------------------------------------
// Report assembly

function assembleReport(args) {
  const repoRoot = args.repoRoot || REPO_ROOT;
  const bbox = args.bbox || bboxFromViewport(args.centerLat, args.centerLon, args.zoom, args.viewportPx);

  const tileResult = loadTilesForBbox(repoRoot, args.city, bbox);
  if (!tileResult.ok) {
    return { ok: false, error: tileResult.error, bbox };
  }
  const tileWaysById = new Map();
  for (const w of tileResult.ways) tileWaysById.set(String(w.wayId), w);

  // Try the full-diagnostic path; merge per-way DEM samples back in
  // when available. Tile data still gives us the canonical
  // road_slope_percent / class / confidence values written by the
  // producer. `runFullDiagnostic` already logs its own warnings, so
  // this catch is a last-resort safety net for unexpected
  // (programmer-error) exceptions only.
  let fullDiag = null;
  try { fullDiag = runFullDiagnostic(repoRoot, args.city, bbox); }
  catch (e) { console.warn('[qa-slope] runFullDiagnostic threw:', e.message); }
  const diagById = new Map();
  if (fullDiag && Array.isArray(fullDiag.ways)) {
    for (const d of fullDiag.ways) diagById.set(String(d.wayId), d);
  }

  const rows = [];
  const classCounts = { flat: 0, gentle: 0, moderate: 0, steep: 0, very_steep: 0, no_signal: 0 };
  for (const w of tileResult.ways) {
    const a = w.attrs || {};
    const lengthM = polylineLengthM(w.latlngs);
    const cls = (typeof a.road_slope_class === 'string' && classCounts[a.road_slope_class] != null)
      ? a.road_slope_class : 'no_signal';
    classCounts[cls] = (classCounts[cls] || 0) + 1;
    const diag = diagById.get(String(w.wayId));
    rows.push({
      way_id: String(w.wayId),
      highway: a.highway != null ? a.highway : null,
      geometry_length_m: Math.round(lengthM * 10) / 10,
      road_slope_percent:        Number.isFinite(a.road_slope_percent) ? a.road_slope_percent : null,
      road_slope_class:          a.road_slope_class || null,
      road_slope_max_abs_percent: Number.isFinite(a.road_slope_max_abs_percent) ? a.road_slope_max_abs_percent : null,
      road_slope_method:         a.road_slope_method || null,
      road_slope_sample_count:   Number.isFinite(a.road_slope_sample_count) ? a.road_slope_sample_count : null,
      road_slope_confidence:     a.road_slope_confidence || null,
      road_slope_low_sample:     a.road_slope_low_sample === true || null,
      road_slope_missing_reason: a.road_slope_missing_reason || null,
      // Producer-replay diagnostics (only when full-diagnostic mode ran):
      segment_slopes_percent: diag ? diag.diag.segmentSlopesPercent : [],
      segment_lengths_m:      diag ? diag.diag.segmentLengthsM      : [],
      elevation_deltas_m:     diag ? diag.diag.elevationDeltasM     : [],
      dem_samples_m:          diag ? diag.diag.demSamplesM          : [],
    });
  }
  rows.sort((a, b) => a.way_id.localeCompare(b.way_id));

  return {
    ok: true,
    bbox,
    city: args.city,
    center: { lat: args.centerLat, lon: args.centerLon, zoom: args.zoom },
    fullDiagnosticAvailable: !!fullDiag,
    fullDiagnosticParams: fullDiag ? { stepM: fullDiag.stepM, minSegM: fullDiag.minSegM } : null,
    classCounts,
    totalWays: rows.length,
    rows,
  };
}

// ---------------------------------------------------------------------------
// CSV writer (escape quotes / embed JSON for array columns)

function csvEscape(v) {
  if (v == null) return '';
  if (Array.isArray(v) || typeof v === 'object') v = JSON.stringify(v);
  const s = String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function writeCsv(file, rows) {
  if (rows.length === 0) {
    fs.writeFileSync(file, '');
    return;
  }
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map(c => csvEscape(r[c])).join(','));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function summaryTable(report) {
  const lines = [];
  lines.push(`QA slope report — ${report.city}`);
  lines.push(`viewport bbox: south=${report.bbox.south.toFixed(5)} west=${report.bbox.west.toFixed(5)} north=${report.bbox.north.toFixed(5)} east=${report.bbox.east.toFixed(5)}`);
  if (report.center) {
    lines.push(`center: lat=${report.center.lat} lon=${report.center.lon} zoom=${report.center.zoom}`);
  }
  lines.push(`ways in viewport: ${report.totalWays}`);
  lines.push(`full-diagnostic mode: ${report.fullDiagnosticAvailable ? 'yes (DEM tiles + osm.json available)' : 'no (tile-only fallback)'}`);
  lines.push('class histogram:');
  const order = ['flat', 'gentle', 'moderate', 'steep', 'very_steep', 'no_signal'];
  for (const k of order) {
    const n = report.classCounts[k] || 0;
    const pct = report.totalWays > 0 ? (n / report.totalWays * 100).toFixed(1) : '0.0';
    lines.push(`  ${k.padEnd(11)} ${String(n).padStart(6)}  ${pct}%`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Entrypoint

function main(argv) {
  const args = parseArgs(argv);
  const report = assembleReport(args);
  if (!report.ok) {
    console.error(`[qa-slope] ${report.error}`);
    process.exitCode = 1;
    return;
  }
  const repoRoot = args.repoRoot || REPO_ROOT;
  const outDir = args.outDir || path.join(repoRoot, 'out', 'qa');
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, `slope_${args.city}.json`);
  const csvPath  = path.join(outDir, `slope_${args.city}.csv`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  writeCsv(csvPath, report.rows);
  console.log(summaryTable(report));
  console.log('');
  console.log(`wrote ${path.relative(repoRoot, jsonPath)}`);
  console.log(`wrote ${path.relative(repoRoot, csvPath)}`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseArgs,
  bboxFromViewport,
  bboxIntersectsLatLngs,
  loadTilesForBbox,
  polylineLengthM,
  assembleReport,
  summaryTable,
  DEFAULTS,
};
