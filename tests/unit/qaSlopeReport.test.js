'use strict';

/**
 * Tests for scripts/qa-slope-report.js (PR-berlin-slope-qa).
 *
 * Pure-helper coverage (bbox math + intersection) plus an end-to-end
 * `assembleReport` call against a synthetic out/ctxtiles/<slug>/
 * directory, so the report's tile-only fallback path is exercised
 * without needing the (large, not-in-repo) DEM tiles or osm.json.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const qa = require('../../scripts/qa-slope-report.js');

function mktmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qa-slope-'));
}

function lonToTileX(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z));
}

function writeMiniCity(repoRoot, slug) {
  // Build a tiny ctxtiles dataset around Berlin centre with three ways
  // — one flat, one steep, one very_steep — so the report's class
  // histogram + length computation can be asserted deterministically.
  const baseDir = path.join(repoRoot, 'out', 'ctxtiles', slug);
  const z = 13;
  const lat = 52.521463, lon = 13.379320;
  const tx = lonToTileX(lon, z), ty = latToTileY(lat, z);
  const tileDir = path.join(baseDir, String(tx));
  fs.mkdirSync(tileDir, { recursive: true });

  // ~100 m to the north using the same haversine the script uses.
  const dLat = 100 / 111320;
  const ways = {
    'WFLAT': {
      highway: 0, road_slope_percent: 0.5, road_slope_class: 'flat',
      road_slope_method: 'median_segments', road_slope_sample_count: 5,
      road_slope_confidence: 'high', road_slope_max_abs_percent: 1.0,
    },
    'WSTEEP': {
      highway: 1, road_slope_percent: 8.2, road_slope_class: 'steep',
      road_slope_method: 'median_segments', road_slope_sample_count: 4,
      road_slope_confidence: 'medium', road_slope_max_abs_percent: 9.1,
    },
    'WVERY': {
      highway: 0, road_slope_percent: 12.5, road_slope_class: 'very_steep',
      road_slope_method: 'median_segments', road_slope_sample_count: 1,
      road_slope_confidence: 'low', road_slope_max_abs_percent: 12.5,
      road_slope_low_sample: true,
    },
  };
  const geometries = {
    'WFLAT':  [lat,        lon,        lat + dLat, lon],
    'WSTEEP': [lat + 0.001, lon,       lat + 0.001 + dLat, lon],
    'WVERY':  [lat + 0.002, lon,       lat + 0.002 + dLat, lon],
  };
  fs.writeFileSync(path.join(tileDir, `${ty}.json`), JSON.stringify({ ways, geometries }));
  // Index with dicts so the highway int decodes to a string.
  const index = {
    schemaVersion: 3, citySlug: slug, tileScheme: 'slippy-z13',
    coverage: 'full', z, tiles: [{ x: tx, y: ty, wayCount: 3, bytes: 0 }],
    dicts: { highway: ['residential', 'tertiary'] },
  };
  fs.writeFileSync(path.join(baseDir, 'index.json'), JSON.stringify(index));
  return { lat, lon };
}

describe('qa-slope-report — viewport bbox math', () => {
  test('bboxFromViewport produces a bbox that contains the centre point', () => {
    const b = qa.bboxFromViewport(52.521463, 13.379320, 16, { w: 1280, h: 800 });
    expect(b.south).toBeLessThan(52.521463);
    expect(b.north).toBeGreaterThan(52.521463);
    expect(b.west).toBeLessThan(13.379320);
    expect(b.east).toBeGreaterThan(13.379320);
    // At z=16 the 1280×800 window covers a fraction of a degree.
    expect(b.north - b.south).toBeGreaterThan(0);
    expect(b.north - b.south).toBeLessThan(0.05);
    expect(b.east - b.west).toBeGreaterThan(0);
    expect(b.east - b.west).toBeLessThan(0.05);
  });

  test('bboxIntersectsLatLngs accepts overlap and rejects fully-outside polylines', () => {
    const bbox = { south: 50, west: 7, north: 51, east: 8 };
    expect(qa.bboxIntersectsLatLngs(bbox, [[50.5, 7.5], [50.6, 7.6]])).toBe(true);
    expect(qa.bboxIntersectsLatLngs(bbox, [[60, 0], [61, 1]])).toBe(false);
    expect(qa.bboxIntersectsLatLngs(bbox, [])).toBe(false);
  });
});

describe('qa-slope-report — assembleReport (tile-only fallback)', () => {
  test('emits one row per way in the viewport with the producer attrs intact', () => {
    const root = mktmp();
    const c = writeMiniCity(root, 'testcity');
    const report = qa.assembleReport({
      city: 'testcity',
      centerLat: c.lat,
      centerLon: c.lon,
      zoom: 16,
      viewportPx: { w: 1280, h: 800 },
      repoRoot: root,
    });
    expect(report.ok).toBe(true);
    expect(report.totalWays).toBe(3);
    expect(report.fullDiagnosticAvailable).toBe(false);
    // Class histogram preserves the producer's class assignment —
    // critically, no spurious very_steep counts.
    expect(report.classCounts).toEqual(expect.objectContaining({
      flat: 1, steep: 1, very_steep: 1, no_signal: 0,
    }));
    const ids = report.rows.map(r => r.way_id).sort();
    expect(ids).toEqual(['WFLAT', 'WSTEEP', 'WVERY']);
    // Every row carries the per-way diagnostic columns the issue asks
    // for, even in the tile-only fallback (segment_* arrays are
    // empty when no DEM is available locally).
    for (const r of report.rows) {
      expect(r).toEqual(expect.objectContaining({
        way_id: expect.any(String),
        geometry_length_m: expect.any(Number),
        road_slope_percent: expect.any(Number),
        road_slope_class: expect.any(String),
        road_slope_method: 'median_segments',
        road_slope_confidence: expect.any(String),
        segment_slopes_percent: expect.any(Array),
        segment_lengths_m: expect.any(Array),
        elevation_deltas_m: expect.any(Array),
        dem_samples_m: expect.any(Array),
      }));
      // Polyline length is ≈ 100 m (haversine of the synthetic dLat).
      expect(r.geometry_length_m).toBeGreaterThan(80);
      expect(r.geometry_length_m).toBeLessThan(120);
    }
    // The very_steep row was tagged road_slope_low_sample by the
    // producer; the report must surface that flag for the renderer.
    const v = report.rows.find(r => r.way_id === 'WVERY');
    expect(v.road_slope_low_sample).toBe(true);
  });

  test('returns ok=false when the city has no tile index', () => {
    const root = mktmp();
    const r = qa.assembleReport({
      city: 'unknown', centerLat: 52, centerLon: 13, zoom: 16,
      viewportPx: { w: 1280, h: 800 }, repoRoot: root,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/tile index not found/);
  });

  test('CSV summary table renders the histogram', () => {
    const root = mktmp();
    const c = writeMiniCity(root, 'testcity');
    const report = qa.assembleReport({
      city: 'testcity', centerLat: c.lat, centerLon: c.lon, zoom: 16,
      viewportPx: { w: 1280, h: 800 }, repoRoot: root,
    });
    const summaryText = qa.summaryTable(report);
    expect(summaryText).toMatch(/ways in viewport: 3/);
    expect(summaryText).toMatch(/very_steep\s+1/);
    expect(summaryText).toMatch(/flat\s+1/);
  });
});
