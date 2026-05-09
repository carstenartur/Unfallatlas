'use strict';

/**
 * Tests for the v3 tile-output path of scripts/enrich_geojson.js
 * (PRODUCER_VERSION 1.2.0+, schemaVersion 3 / "full road network"
 * context layer). See the slippy-tile section in enrich_geojson.js
 * for the disk-layout rationale.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const enrich = require('../../scripts/enrich_geojson.js');

function fc(features, props) {
  return { type: 'FeatureCollection', features, properties: props };
}
function pt(id, lon, lat) {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { id: String(id) } };
}

// A minimal full-coverage OSM provider stub. Distinct from the
// matched-only fixtures in enrichGeojson.test.js: this one exposes
// listWayIds() so enrichCity will build the per-tile fullWays array.
function fullOsmProvider() {
  const wayGeometries = {
    W1: [{ lat: 50.10, lon: 7.20 }, { lat: 50.10, lon: 7.205 }, { lat: 50.10, lon: 7.210 }],
    W2: [{ lat: 50.30, lon: 7.40 }, { lat: 50.30, lon: 7.405 }],
    W3: [{ lat: 51.50, lon: 8.00 }, { lat: 51.50, lon: 8.005 }], // far away → different tile
  };
  const wayAttrs = {
    W1: { highway: 'residential', maxspeed: 30, lanes: 2, surface: 'asphalt' },
    W2: { highway: 'secondary',   maxspeed: 50, lanes: 4, surface: 'asphalt' },
    W3: { highway: 'service' },
  };
  return {
    name: 'osm',
    source: 'OpenStreetMap (Overpass) test',
    producerVersion: '1.2.0',
    extractDate: '2026-05-09',
    coverage: 'full',
    matchFeature(lat, lon) {
      if (lat === 50.10 && lon === 7.20) return { matched_way_id: 'W1', road_context_source: 'osm' };
      return null;
    },
    wayAttributes(wayId) { return wayAttrs[wayId] || null; },
    wayGeometry(wayId)   { return wayGeometries[wayId] || null; },
    listWayIds()         { return Object.keys(wayAttrs); },
  };
}

describe('enrich_geojson — slippy-tile helpers', () => {
  test('lonToTileX/latToTileY round-trip the corner of the tile they identify', () => {
    const z = 13;
    const lat = 50.5, lon = 7.5;
    const x = enrich.lonToTileX(lon, z);
    const y = enrich.latToTileY(lat, z);
    expect(Number.isInteger(x)).toBe(true);
    expect(Number.isInteger(y)).toBe(true);
    // The identified tile's NW corner must be ≤ the input point.
    expect(enrich.tileXToLon(x, z)).toBeLessThanOrEqual(lon);
    expect(enrich.tileXToLon(x + 1, z)).toBeGreaterThan(lon);
    // y axis is inverted in slippy-map: increasing y == going south.
    expect(enrich.tileYToLat(y, z)).toBeGreaterThanOrEqual(lat);
    expect(enrich.tileYToLat(y + 1, z)).toBeLessThan(lat);
  });

  test('tilesForPolyline duplicates a way that crosses tile boundaries', () => {
    const z = 13;
    // Pick two points that straddle a tile boundary by construction.
    const p0 = { lat: 50.5, lon: 7.5 };
    const x0 = enrich.lonToTileX(p0.lon, z);
    const lonBoundary = enrich.tileXToLon(x0 + 1, z);
    const p1 = { lat: p0.lat, lon: lonBoundary + 0.0001 }; // just inside next tile east
    const tiles = enrich.tilesForPolyline([p0, p1], z);
    expect(tiles.length).toBeGreaterThanOrEqual(2);
    const xs = new Set(tiles.map(([x]) => x));
    expect(xs.size).toBeGreaterThanOrEqual(2);
  });
});

describe('enrich_geojson — buildContextTiles (schemaVersion 3)', () => {
  test('groups ways into per-tile buckets and shares one dict across tiles', () => {
    const fullWays = [
      { id: 'W1', attrs: { highway: 'residential', maxspeed: 30 },
        geom: enrich.encodeGeometry([{ lat: 50.10, lon: 7.20 }, { lat: 50.10, lon: 7.205 }]) },
      { id: 'W2', attrs: { highway: 'secondary' },
        geom: enrich.encodeGeometry([{ lat: 50.30, lon: 7.40 }, { lat: 50.30, lon: 7.405 }]) },
    ];
    const built = enrich.buildContextTiles(fullWays, { zoom: 13 });
    // Both ways map to a tile; manifest reports them.
    expect(built.manifest.schemaVersion).toBe(3);
    expect(built.manifest.z).toBe(13);
    expect(built.manifest.coverage).toBe('full');
    expect(built.manifest.tiles.length).toBeGreaterThanOrEqual(1);
    // wayIndex points each way at exactly one canonical tile.
    expect(built.manifest.wayIndex.W1).toBeDefined();
    expect(built.manifest.wayIndex.W2).toBeDefined();
    // Dictionaries are shared across tiles → the highway field is
    // present and contains both unique values.
    expect(built.dicts.highway).toEqual(expect.arrayContaining(['residential', 'secondary']));
    // The per-tile bucket carries int-coded categoricals for the dict
    // fields.
    let foundIntCoded = false;
    for (const bucket of built.tiles.values()) {
      for (const wayId of Object.keys(bucket.ways)) {
        const v = bucket.ways[wayId].highway;
        if (Number.isInteger(v)) foundIntCoded = true;
      }
    }
    expect(foundIntCoded).toBe(true);
  });
});

describe('enrich_geojson — enrichCityFile writes v3 envelope + ctxtiles when OSM coverage is "full"', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-tiles-'));
    fs.mkdirSync(path.join(tmpRoot, 'out'));
  });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('v3 ways envelope + per-tile JSON + index manifest are written; per-feature enrichment unchanged', () => {
    const inputFc = fc([
      pt('a', 7.20, 50.10),
      pt('b', 7.40, 50.30),
    ]);
    const inputPath = path.join(tmpRoot, 'out', 'output_all_years_testtiles.geojson');
    fs.writeFileSync(inputPath, JSON.stringify(inputFc));

    const r = enrich.enrichCityFile(tmpRoot, 'testtiles', {
      providers: { osm: fullOsmProvider(), dem: null, traffic: null },
    });
    expect(r.skipped).toBeFalsy();
    expect(r.contextTiles).toBeTruthy();
    expect(r.contextTiles.tileCount).toBeGreaterThan(0);

    // (a) Envelope: ways_<slug>.json now ships the v3 thin shape.
    const envelope = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'out', 'ways_testtiles.json'), 'utf8')
    );
    expect(envelope.schemaVersion).toBe(3);
    expect(envelope.coverage).toBe('full');
    expect(envelope.tileIndexUrl).toBe('out/ctxtiles/testtiles/index.json');
    // The legacy `ways`/`geometries` keys are NOT present in v3 — the
    // browser fetches them per-tile instead.
    expect(envelope.ways).toBeUndefined();
    expect(envelope.geometries).toBeUndefined();

    // (b) Manifest exists and lists every tile that was written.
    const manifestPath = path.join(tmpRoot, 'out', 'ctxtiles', 'testtiles', 'index.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.coverage).toBe('full');
    expect(manifest.z).toBe(13);
    expect(manifest.tiles.length).toBe(r.contextTiles.tileCount);
    for (const t of manifest.tiles) {
      expect(t).toEqual(expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), wayCount: expect.any(Number) }));
      // Each per-tile file must exist and decode as an object with
      // `ways` + `geometries` maps (the same shape as v2 ways file,
      // just per tile). The browser-side decoder reuses the existing
      // resolveWay / decodeGeometry codepaths on this shape.
      const tilePath = path.join(tmpRoot, 'out', 'ctxtiles', 'testtiles', String(t.x), `${t.y}.json`);
      expect(fs.existsSync(tilePath)).toBe(true);
      const tile = JSON.parse(fs.readFileSync(tilePath, 'utf8'));
      expect(tile.schemaVersion).toBe(3);
      expect(typeof tile.ways).toBe('object');
      expect(typeof tile.geometries).toBe('object');
      expect(Object.keys(tile.ways).length).toBe(t.wayCount);
    }

    // (c) wayIndex covers every way that has a geometry.
    expect(manifest.wayIndex.W1).toBeDefined();
    expect(manifest.wayIndex.W2).toBeDefined();
    expect(manifest.wayIndex.W3).toBeDefined();

    // (d) Per-feature enrichment unchanged: matched_way_id still set
    // for the snapped accident.
    const enriched = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    expect(enriched.features[0].properties.matched_way_id).toBe('W1');
    expect(enriched.features[0].properties.road_context_source).toBe('osm');
  });

  test('falls back to the v2 envelope when OSM provider has no listWayIds (legacy matched-only path)', () => {
    const inputFc = fc([pt('a', 7.20, 50.10)]);
    const inputPath = path.join(tmpRoot, 'out', 'output_all_years_legacy.geojson');
    fs.writeFileSync(inputPath, JSON.stringify(inputFc));

    const matchedOnlyOsm = {
      name: 'osm', source: 'test', extractDate: '2026-05-09',
      matchFeature(lat, lon) {
        if (lat === 50.10 && lon === 7.20) return { matched_way_id: 'W1', road_context_source: 'osm' };
        return null;
      },
      wayAttributes(id) { return id === 'W1' ? { highway: 'residential' } : null; },
      wayGeometry(id)   { return id === 'W1' ? [{ lat: 50.10, lon: 7.20 }, { lat: 50.10, lon: 7.205 }] : null; },
      // No listWayIds — older OSM cache.
    };

    const r = enrich.enrichCityFile(tmpRoot, 'legacy', {
      providers: { osm: matchedOnlyOsm, dem: null, traffic: null },
    });
    expect(r.skipped).toBeFalsy();
    expect(r.contextTiles).toBeNull();

    const envelope = JSON.parse(
      fs.readFileSync(path.join(tmpRoot, 'out', 'ways_legacy.json'), 'utf8')
    );
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.ways).toBeDefined();
    // No tile dir written — the browser stays on the v2 monolithic path.
    expect(fs.existsSync(path.join(tmpRoot, 'out', 'ctxtiles', 'legacy'))).toBe(false);
  });

  test('switching from full → matched-only between runs cleans up stale tile dir', () => {
    const inputFc = fc([pt('a', 7.20, 50.10)]);
    const inputPath = path.join(tmpRoot, 'out', 'output_all_years_swap.geojson');
    fs.writeFileSync(inputPath, JSON.stringify(inputFc));

    enrich.enrichCityFile(tmpRoot, 'swap', {
      providers: { osm: fullOsmProvider(), dem: null, traffic: null },
    });
    expect(fs.existsSync(path.join(tmpRoot, 'out', 'ctxtiles', 'swap'))).toBe(true);

    // Re-run with the matched-only provider — tile dir must be wiped.
    const matchedOnlyOsm = {
      name: 'osm', source: 'test', extractDate: '2026-05-09',
      matchFeature: () => null, wayAttributes: () => null, wayGeometry: () => null,
    };
    enrich.enrichCityFile(tmpRoot, 'swap', {
      providers: { osm: matchedOnlyOsm, dem: null, traffic: null },
    });
    expect(fs.existsSync(path.join(tmpRoot, 'out', 'ctxtiles', 'swap'))).toBe(false);
  });
});
