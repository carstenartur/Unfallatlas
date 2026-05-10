'use strict';

/**
 * Tests for scripts/producers/dem_tile_producer.js
 *
 * Covers:
 *   1. tileName — correct SRTM tile name derivation for N/S/E/W.
 *   2. tilesForBbox — correct tile set enumeration for a given bbox.
 *   3. bboxFromFeatureCollection — re-export matches osm_producer.
 *   4. downloadTile — caching (second call with existing file → 0 fetch calls),
 *      success path, error handling.
 *   5. downloadTilesForCities — integration: reads geojson, computes tiles,
 *      delegates to downloadTile.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const zlib = require('zlib');

const tile = require('../../scripts/producers/dem_tile_producer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fc(features) { return { type: 'FeatureCollection', features }; }
function pt(lon, lat) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {},
  };
}

/** Build a minimal valid HGT buffer (SRTM3 1201×1201, all zeros). */
function makeHgtBuf(side) {
  const s = side || 1201;
  return Buffer.alloc(s * s * 2, 0);
}

/** Gzip a buffer synchronously. */
function gzip(buf) {
  return zlib.gzipSync(buf);
}

// ---------------------------------------------------------------------------
// 1. tileName
// ---------------------------------------------------------------------------

describe('dem_tile_producer — tileName', () => {
  test('positive lat + lon (Germany)', () => {
    expect(tile.tileName(50.5, 7.3)).toBe('N50E007');
    expect(tile.tileName(50,   7  )).toBe('N50E007');
    expect(tile.tileName(51.999, 13.999)).toBe('N51E013');
  });

  test('zero lat / zero lon', () => {
    expect(tile.tileName(0, 0)).toBe('N00E000');
    expect(tile.tileName(0.9, 0.9)).toBe('N00E000');
  });

  test('southern hemisphere', () => {
    expect(tile.tileName(-10.1, 20.5)).toBe('S11E020');
  });

  test('western hemisphere', () => {
    expect(tile.tileName(48, -122.3)).toBe('N48W123');
  });

  test('pads lat to 2 digits and lon to 3 digits', () => {
    expect(tile.tileName(5, 7)).toBe('N05E007');
    expect(tile.tileName(50, 70)).toBe('N50E070');
  });
});

// ---------------------------------------------------------------------------
// 2. tilesForBbox
// ---------------------------------------------------------------------------

describe('dem_tile_producer — tilesForBbox', () => {
  test('single tile when bbox fits entirely in one degree cell', () => {
    const bbox = { minLat: 50.1, maxLat: 50.9, minLon: 7.2, maxLon: 7.8 };
    expect(tile.tilesForBbox(bbox)).toEqual(['N50E007']);
  });

  test('covers all tiles for a multi-degree bbox', () => {
    const bbox = { minLat: 50, maxLat: 51, minLon: 7, maxLon: 8 };
    const names = tile.tilesForBbox(bbox);
    // Should include all four corner tiles.
    expect(names).toContain('N50E007');
    expect(names).toContain('N50E008');
    expect(names).toContain('N51E007');
    expect(names).toContain('N51E008');
    expect(names).toHaveLength(4);
  });

  test('Germany coverage (approx 9×10 = 90 tiles)', () => {
    // Roughly the German bounding box.
    const bbox = { minLat: 47, maxLat: 55, minLon: 6, maxLon: 15 };
    const names = tile.tilesForBbox(bbox);
    // Lat tiles: floor(47)..floor(55) = 47..55 = 9 values
    // Lon tiles: floor(6)..floor(15)  =  6..15 = 10 values → 9 × 10 = 90
    expect(names.length).toBe(9 * 10);
  });

  test('returns [] for null bbox', () => {
    expect(tile.tilesForBbox(null)).toEqual([]);
    expect(tile.tilesForBbox(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. bboxFromFeatureCollection
// ---------------------------------------------------------------------------

describe('dem_tile_producer — bboxFromFeatureCollection', () => {
  test('computes correct bbox from a FeatureCollection', () => {
    const bb = tile.bboxFromFeatureCollection(fc([
      pt(7.0, 50.0),
      pt(8.0, 51.0),
    ]));
    expect(bb).toEqual({ minLat: 50, maxLat: 51, minLon: 7, maxLon: 8 });
  });

  test('returns null on empty / malformed input', () => {
    expect(tile.bboxFromFeatureCollection(null)).toBeNull();
    expect(tile.bboxFromFeatureCollection(fc([]))).toBeNull();
  });

  test('outlierClipPercentile clips a single distant outlier on a large dataset', () => {
    // Same Dresden-shaped scenario as the osm_producer test: 200 in-cluster
    // points + one stray ~400 km away. Without clipping the stray would
    // expand the SRTM tile-download set across multiple unrelated regions.
    const features = [];
    for (let i = 0; i < 200; i++) {
      features.push(pt(13.70 + (i % 20) * 0.01, 51.04 + Math.floor(i / 20) * 0.01));
    }
    features.push(pt(8.41, 49.01)); // stray, far southwest
    const raw     = tile.bboxFromFeatureCollection(fc(features));
    const clipped = tile.bboxFromFeatureCollection(fc(features), { outlierClipPercentile: 0.005 });
    expect(raw.minLat).toBeCloseTo(49.01);
    expect(clipped.minLat).toBeGreaterThanOrEqual(51.04);
    expect(clipped.minLon).toBeGreaterThanOrEqual(13.70);
    expect(clipped.maxLon).toBeLessThanOrEqual(13.90);
  });

  test('outlierClipPercentile is a no-op on tiny inputs (under outlierClipMinSamples)', () => {
    const features = [pt(7.0, 50.0), pt(8.0, 51.0)];
    expect(tile.bboxFromFeatureCollection(fc(features), { outlierClipPercentile: 0.005 }))
      .toEqual({ minLat: 50, maxLat: 51, minLon: 7, maxLon: 8 });
  });

  test('bboxStatsFromFeatureCollection returns raw + clipped from a single pass', () => {
    const features = [];
    for (let i = 0; i < 200; i++) {
      features.push(pt(13.70 + (i % 20) * 0.01, 51.04 + Math.floor(i / 20) * 0.01));
    }
    features.push(pt(8.41, 49.01));
    const stats = tile.bboxStatsFromFeatureCollection(fc(features), { outlierClipPercentile: 0.005 });
    expect(stats.n).toBe(201);
    expect(stats.raw.minLat).toBeCloseTo(49.01);
    expect(stats.clipped.minLat).toBeGreaterThanOrEqual(51.04);
    expect(stats.clipped).not.toBe(stats.raw);
  });
});

describe('dem_tile_producer — parseArgs', () => {
  test('default --bbox-outlier-clip is the documented DEFAULT_BBOX_OUTLIER_CLIP', () => {
    const opts = tile.parseArgs([]);
    expect(opts.bboxOutlierClipPercentile).toBeCloseTo(0.005);
  });

  test('--bbox-outlier-clip 0 disables clipping', () => {
    const opts = tile.parseArgs(['--bbox-outlier-clip', '0']);
    expect(opts.bboxOutlierClipPercentile).toBe(0);
  });

  test('--bbox-outlier-clip parses a custom percentile', () => {
    const opts = tile.parseArgs(['--bbox-outlier-clip', '0.01']);
    expect(opts.bboxOutlierClipPercentile).toBeCloseTo(0.01);
  });
});

// ---------------------------------------------------------------------------
// 4. downloadTile
// ---------------------------------------------------------------------------

describe('dem_tile_producer — downloadTile', () => {
  test('skips download and returns cached:true when .hgt file exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-tile-'));
    try {
      fs.writeFileSync(path.join(tmp, 'N50E007.hgt'), makeHgtBuf(1201));
      let fetchCalls = 0;
      const stubFetch = async () => { fetchCalls++; return {}; };
      const r = await tile.downloadTile('N50E007', tmp, { fetch: stubFetch, silent: true });
      expect(r.cached).toBe(true);
      expect(r.downloaded).toBe(false);
      expect(fetchCalls).toBe(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('downloads, decompresses, and writes .hgt when file is absent', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-tile-'));
    try {
      const hgtBuf = makeHgtBuf(1201);
      const gzBuf  = gzip(hgtBuf);
      const stubFetch = async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => gzBuf.buffer.slice(gzBuf.byteOffset, gzBuf.byteOffset + gzBuf.byteLength),
      });
      const r = await tile.downloadTile('N50E007', tmp, {
        fetch: stubFetch,
        silent: true,
      });
      expect(r.downloaded).toBe(true);
      expect(r.error).toBeUndefined();
      const written = fs.readFileSync(path.join(tmp, 'N50E007.hgt'));
      expect(written.length).toBe(hgtBuf.length);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns error when all sources fail (non-ok HTTP response)', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-tile-'));
    try {
      const stubFetch = async () => ({ ok: false, status: 404 });
      const r = await tile.downloadTile('N50E007', tmp, {
        fetch: stubFetch,
        silent: true,
      });
      expect(r.downloaded).toBe(false);
      expect(r.error).toBeDefined();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('force:true re-downloads even when .hgt file exists', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-tile-'));
    try {
      const existingBuf = Buffer.from('old');
      fs.writeFileSync(path.join(tmp, 'N50E007.hgt'), existingBuf);
      const hgtBuf = makeHgtBuf(1201);
      const gzBuf  = gzip(hgtBuf);
      let fetchCalls = 0;
      const stubFetch = async () => {
        fetchCalls++;
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => gzBuf.buffer.slice(gzBuf.byteOffset, gzBuf.byteOffset + gzBuf.byteLength),
        };
      };
      const r = await tile.downloadTile('N50E007', tmp, {
        fetch: stubFetch,
        force: true,
        silent: true,
      });
      expect(fetchCalls).toBe(1);
      expect(r.downloaded).toBe(true);
      const written = fs.readFileSync(path.join(tmp, 'N50E007.hgt'));
      expect(written.length).toBe(hgtBuf.length); // new content, not 'old'
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. downloadTilesForCities
// ---------------------------------------------------------------------------

describe('dem_tile_producer — downloadTilesForCities', () => {
  test('reads geojson, computes required tiles, calls downloadTile for each', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-tile-'));
    const repoRoot  = path.join(tmp, 'repo');
    const tilesDir  = path.join(tmp, 'tiles');
    fs.mkdirSync(path.join(repoRoot, 'out'), { recursive: true });
    fs.mkdirSync(tilesDir, { recursive: true });

    // City with 2 accident points that fit in N50E007 only.
    fs.writeFileSync(
      path.join(repoRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(fc([pt(7.1, 50.1), pt(7.5, 50.5)])),
    );

    // Pre-create the tile file so downloadTile returns cached:true (0 downloads).
    const hgtPath = path.join(tilesDir, 'N50E007.hgt');
    fs.writeFileSync(hgtPath, makeHgtBuf(1201));

    let fetchCalls = 0;
    const stubFetch = async () => { fetchCalls++; return { ok: false, status: 404 }; };

    const summary = await tile.downloadTilesForCities(
      repoRoot, ['bonn'], tilesDir, { fetch: stubFetch, silent: true },
    );

    expect(summary.errors).toBe(0);
    expect(summary.cached).toBe(1);
    expect(summary.downloaded).toBe(0);
    expect(fetchCalls).toBe(0); // tile was pre-cached → no network calls
  });

  test('skips cities whose geojson is missing', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dem-tile-'));
    try {
      const summary = await tile.downloadTilesForCities(
        tmp, ['nowhere'], path.join(tmp, 'tiles'), { silent: true },
      );
      expect(summary.errors).toBe(0);
      expect(summary.tiles).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6. tileUrls
// ---------------------------------------------------------------------------

describe('dem_tile_producer — tileUrls', () => {
  test('returns at least one URL per tile name', () => {
    const urls = tile.tileUrls('N50E007');
    expect(urls.length).toBeGreaterThanOrEqual(1);
    for (const u of urls) {
      expect(u).toMatch(/N50.*E007/);
    }
  });

  test('URL contains the tile name for N50E007', () => {
    const urls = tile.tileUrls('N50E007');
    expect(urls[0]).toContain('N50E007');
  });
});
