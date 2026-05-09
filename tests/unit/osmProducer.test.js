'use strict';

/**
 * Tests for scripts/producers/osm_producer.js
 *
 * Pure-helper coverage (bbox, Overpass parsing, way normalisation,
 * nearest-way snap, dataset assembly) plus an end-to-end produceCity
 * test with a stubbed fetchOverpass that proves the on-disk payload
 * is shape-compatible with `loadOsmProvider` in
 * `scripts/enrich_geojson.js`.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const osm = require('../../scripts/producers/osm_producer.js');

function fc(features) { return { type: 'FeatureCollection', features }; }
function pt(id, lon, lat) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id: String(id) },
  };
}

describe('osm_producer — slugCity', () => {
  test('matches the enrich_geojson convention', () => {
    expect(osm.slugCity('Bonn')).toBe('bonn');
    expect(osm.slugCity('Düsseldorf')).toBe('duesseldorf');
    expect(osm.slugCity('Frankfurt am Main')).toBe('frankfurt_am_main');
    expect(osm.slugCity('Nürnberg')).toBe('nuernberg');
  });
});

describe('osm_producer — bboxFromFeatureCollection', () => {
  test('returns null on empty / malformed input', () => {
    expect(osm.bboxFromFeatureCollection(null)).toBeNull();
    expect(osm.bboxFromFeatureCollection(fc([]))).toBeNull();
    expect(osm.bboxFromFeatureCollection(fc([pt(1, 'x', 'y')]))).toBeNull();
  });

  test('computes min/max lat/lon over all valid points', () => {
    const b = osm.bboxFromFeatureCollection(fc([
      pt(1, 7.10, 50.70),
      pt(2, 7.20, 50.80),
      pt(3, 7.05, 50.65),
      // Malformed point is skipped, not counted.
      { type: 'Feature', geometry: null, properties: {} },
    ]));
    expect(b).toEqual({ minLat: 50.65, minLon: 7.05, maxLat: 50.80, maxLon: 7.20 });
  });

  test('padBbox expands by the requested margin', () => {
    const b = { minLat: 50, minLon: 7, maxLat: 51, maxLon: 8 };
    expect(osm.padBbox(b, 0.01)).toEqual({
      minLat: 49.99, minLon: 6.99, maxLat: 51.01, maxLon: 8.01,
    });
    expect(osm.padBbox(null)).toBeNull();
  });
});

describe('osm_producer — buildOverpassQuery', () => {
  test('emits a way[highway] bbox query with the documented order', () => {
    const q = osm.buildOverpassQuery({ minLat: 50, minLon: 7, maxLat: 51, maxLon: 8 }, {});
    expect(q).toMatch(/\[out:json\]\[timeout:\d+\];/);
    expect(q).toMatch(/way\["highway"\]\(50,7,51,8\)/);
    expect(q).toMatch(/out tags geom;/);
  });
});

describe('osm_producer — parseOverpassResponse / normalizeWay', () => {
  test('parses ways with inline geometry, drops bad ones', () => {
    const ways = osm.parseOverpassResponse({
      elements: [
        { type: 'node', id: 99 },                        // ignored
        { type: 'way', id: 1, tags: { highway: 'residential' },
          geometry: [{ lat: 50, lon: 7 }, { lat: 50.001, lon: 7.001 }] },
        { type: 'way', id: 2, tags: {}, geometry: [{ lat: 50, lon: 7 }] }, // too short
        { type: 'way', id: 3 }, // no geometry
      ],
    });
    expect(ways).toHaveLength(1);
    expect(ways[0].id).toBe('1');
    expect(ways[0].geometry).toHaveLength(2);
  });

  test('normalizeWay maps OSM tags to the enrich_geojson schema', () => {
    expect(osm.normalizeWay({ tags: {
      highway: 'residential', maxspeed: '30', lanes: '2',
      surface: 'asphalt', cycleway: 'lane', incline: '5%',
    }})).toEqual({
      highway: 'residential', maxspeed: 30, lanes: 2,
      surface: 'asphalt', cycleway: 'lane', osm_incline: '5%',
    });
  });

  test('normalizeWay drops null fields', () => {
    expect(osm.normalizeWay({ tags: { highway: 'tertiary' } })).toEqual({ highway: 'tertiary' });
  });

  test('parseMaxspeed handles km/h, mph, walk, signals, none', () => {
    expect(osm.parseMaxspeed('50')).toBe(50);
    expect(osm.parseMaxspeed('50 km/h')).toBe(50);
    expect(osm.parseMaxspeed('30 mph')).toBe(48);
    expect(osm.parseMaxspeed('walk')).toBe(7);
    expect(osm.parseMaxspeed('none')).toBeUndefined();
    expect(osm.parseMaxspeed('signals')).toBeUndefined();
    expect(osm.parseMaxspeed(null)).toBeUndefined();
  });
});

describe('osm_producer — nearest-way snap', () => {
  // A simple east-west way at lat=50.000, lon 7.000 → 7.001 (~71 m at lat 50).
  const ways = [{
    id: 'w1', tags: { highway: 'residential' },
    geometry: [{ lat: 50, lon: 7 }, { lat: 50, lon: 7.001 }],
  }, {
    id: 'w2', tags: { highway: 'residential' },
    geometry: [{ lat: 50.01, lon: 7 }, { lat: 50.01, lon: 7.001 }], // ~1.1 km north
  }];

  test('point on the way snaps with ~0 m distance', () => {
    const hit = osm.nearestWay(50.0, 7.0005, ways, { maxDistanceM: 50 });
    expect(hit).not.toBeNull();
    expect(hit.way_id).toBe('w1');
    expect(hit.distance_m).toBeLessThan(1);
  });

  test('point > maxDistanceM returns null', () => {
    expect(osm.nearestWay(50.005, 7.0005, ways, { maxDistanceM: 50 })).toBeNull();
  });

  test('chooses the closer of two parallel ways', () => {
    const hit = osm.nearestWay(50.0001, 7.0005, ways, { maxDistanceM: 200 });
    expect(hit.way_id).toBe('w1');
  });

  test('indexed snap agrees with linear-scan snap', () => {
    const idx = osm.buildWayIndex(ways);
    const linear = osm.nearestWay(50.0, 7.0005, ways, { maxDistanceM: 50 });
    const indexed = osm.nearestWayIndexed(50.0, 7.0005, idx, { maxDistanceM: 50 });
    expect(indexed.way_id).toBe(linear.way_id);
    expect(indexed.distance_m).toBeCloseTo(linear.distance_m, 3);
  });
});

describe('osm_producer — buildOsmDataset', () => {
  const ways = [
    { id: '1', tags: { highway: 'residential', maxspeed: '30' },
      geometry: [{ lat: 50, lon: 7 }, { lat: 50, lon: 7.001 }] },
    { id: '2', tags: { highway: 'unclassified' }, // far-away way: should be pruned
      geometry: [{ lat: 51, lon: 8 }, { lat: 51, lon: 8.001 }] },
  ];

  test('emits the schema consumed by loadOsmProvider', () => {
    const ds = osm.buildOsmDataset(
      fc([pt('a', 7.0005, 50.0), pt('b', 7.0006, 50.00001)]),
      ways,
      { maxDistanceM: 50, extractDate: '2026-05-07' },
    );
    expect(ds.source).toBe('OpenStreetMap (Overpass)');
    expect(ds.producerVersion).toBe(osm.PRODUCER_VERSION);
    expect(ds.extractDate).toBe('2026-05-07');
    expect(ds.index).toEqual([
      { lat: 50.0,     lon: 7.0005, way_id: '1' },
      { lat: 50.00001, lon: 7.0006, way_id: '1' },
    ]);
    // Way 2 is in the bbox query result but no accident snapped to
    // it, so it must NOT bloat the on-disk payload.
    expect(Object.keys(ds.ways)).toEqual(['1']);
    expect(ds.ways['1']).toEqual({ highway: 'residential', maxspeed: 30 });
  });

  test('points outside snap distance are dropped', () => {
    const ds = osm.buildOsmDataset(
      fc([pt('far', 8.5, 51.5)]),
      ways,
      { maxDistanceM: 50 },
    );
    expect(ds.index).toEqual([]);
    expect(ds.ways).toEqual({});
  });
});

describe('osm_producer — produceCity (end-to-end with stubbed Overpass)', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-producer-'));
    fs.mkdirSync(path.join(tmpRoot, 'out'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('reads cities.txt-style input, queries Overpass, writes osm_<slug>.json', async () => {
    const inputFc = fc([pt(1, 7.0005, 50.0), pt(2, 7.0008, 50.00002)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(inputFc),
    );

    let capturedQuery = null;
    const stubFetch = async (q) => {
      capturedQuery = q;
      return {
        version: 0.6,
        elements: [
          { type: 'way', id: 100, tags: { highway: 'residential', maxspeed: '30' },
            geometry: [{ lat: 50, lon: 7 }, { lat: 50, lon: 7.001 }] },
        ],
      };
    };

    const outDir = path.join(tmpRoot, 'cache');
    const r = await osm.produceCity(tmpRoot, 'bonn', {
      outDir,
      fetchOverpass: stubFetch,
      maxDistanceM: 50,
      extractDate: '2026-05-07',
    });

    expect(r.skipped).toBeFalsy();
    expect(r.counts).toEqual({ features: 2, candidates: 1, matched: 2, ways: 1 });

    // The query must contain the bbox that bounds the input points.
    expect(capturedQuery).toMatch(/way\["highway"\]\(/);

    const written = JSON.parse(
      fs.readFileSync(path.join(outDir, 'osm_bonn.json'), 'utf8'),
    );
    expect(written.source).toBe('OpenStreetMap (Overpass)');
    expect(written.extractDate).toBe('2026-05-07');
    expect(written.ways['100']).toEqual({ highway: 'residential', maxspeed: 30 });
    expect(written.index).toHaveLength(2);
    expect(written.index[0].way_id).toBe('100');
  });

  test('skips cleanly when the city geojson is missing', async () => {
    const r = await osm.produceCity(tmpRoot, 'nirgendwo', {
      outDir: path.join(tmpRoot, 'cache'),
      fetchOverpass: async () => { throw new Error('must not be called'); },
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/no input geojson/);
  });

  test('resume: skips when osm_<slug>.json already exists in outDir', async () => {
    const inputFc = fc([pt(1, 7.0005, 50.0)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(inputFc),
    );
    const outDir = path.join(tmpRoot, 'cache');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'osm_bonn.json'), '{"sentinel":true}');

    const r = await osm.produceCity(tmpRoot, 'bonn', {
      outDir,
      fetchOverpass: async () => { throw new Error('must not be called'); },
    });
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/already cached/);
    // Existing payload must not be overwritten by the resume guard.
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'osm_bonn.json'), 'utf8')))
      .toEqual({ sentinel: true });
  });

  test('force: re-runs even when osm_<slug>.json already exists', async () => {
    const inputFc = fc([pt(1, 7.0005, 50.0)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(inputFc),
    );
    const outDir = path.join(tmpRoot, 'cache');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'osm_bonn.json'), '{"sentinel":true}');

    let called = 0;
    const stubFetch = async () => {
      called += 1;
      return {
        version: 0.6,
        elements: [
          { type: 'way', id: 200, tags: { highway: 'residential' },
            geometry: [{ lat: 50, lon: 7 }, { lat: 50, lon: 7.001 }] },
        ],
      };
    };

    const r = await osm.produceCity(tmpRoot, 'bonn', {
      outDir,
      force: true,
      fetchOverpass: stubFetch,
    });
    expect(r.skipped).toBeFalsy();
    expect(called).toBeGreaterThan(0);
    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'osm_bonn.json'), 'utf8'));
    expect(written.sentinel).toBeUndefined();
    expect(written.ways['200']).toBeTruthy();
  });

  test('produced osm_<slug>.json is consumable by enrich_geojson loadOsmProvider', async () => {
    // Round-trip test: we build an osm_<slug>.json, point
    // ENRICH_OSM_DATA_DIR at its directory, run enrichCity, and
    // assert that the way is matched. This nails the contract
    // between the two scripts.
    const inputFc = fc([pt(1, 7.0005, 50.0)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(inputFc),
    );
    const outDir = path.join(tmpRoot, 'cache');
    const r = await osm.produceCity(tmpRoot, 'bonn', {
      outDir,
      fetchOverpass: async () => ({
        elements: [
          { type: 'way', id: 200, tags: { highway: 'residential', surface: 'asphalt' },
            geometry: [{ lat: 50, lon: 7 }, { lat: 50, lon: 7.001 }] },
        ],
      }),
    });
    expect(r.skipped).toBeFalsy();
    expect(r.counts.matched).toBe(1);

    // The producer's index uses raw lat/lon, but loadOsmProvider
    // buckets at 5dp; our two values round-trip to the same key.
    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'osm_bonn.json'), 'utf8'));
    const expectedKey = `${(50.0).toFixed(5)},${(7.0005).toFixed(5)}`;
    const indexedKeys = written.index.map(e => `${e.lat.toFixed(5)},${e.lon.toFixed(5)}`);
    expect(indexedKeys).toContain(expectedKey);

    // Now exercise the actual consumer.
    const enrich = require('../../scripts/enrich_geojson.js');
    const fcCopy = JSON.parse(JSON.stringify(inputFc));
    const prevEnv = process.env.ENRICH_OSM_DATA_DIR;
    process.env.ENRICH_OSM_DATA_DIR = outDir;
    try {
      const { ways, meta } = enrich.enrichCity(fcCopy, 'bonn', { useOsm: true, useDem: false, useTraffic: false });
      expect(meta.counts.matchedToWay).toBe(1);
      expect(Object.keys(ways)).toEqual(['200']);
      expect(fcCopy.features[0].properties.matched_way_id).toBe('200');
      expect(fcCopy.features[0].properties.road_context_source).toBe('osm');
    } finally {
      if (prevEnv === undefined) delete process.env.ENRICH_OSM_DATA_DIR;
      else process.env.ENRICH_OSM_DATA_DIR = prevEnv;
    }
  });

  test('keeps the full per-way polyline for ways the index touches, drops the rest', async () => {
    // Two accidents — both snap to way #200. Way #999 is in the
    // bbox response but no accident references it, so it must NOT
    // appear in the `wayGeometries` table (size guard from §C).
    const inputFc = fc([pt(1, 7.0001, 50.0), pt(2, 7.0009, 50.0)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_bonn.geojson'),
      JSON.stringify(inputFc),
    );
    const outDir = path.join(tmpRoot, 'cache');
    const r = await osm.produceCity(tmpRoot, 'bonn', {
      outDir,
      fetchOverpass: async () => ({
        elements: [
          { type: 'way', id: 200, tags: { highway: 'residential' },
            geometry: [
              { lat: 50, lon: 7.000 },
              { lat: 50, lon: 7.0005 },
              { lat: 50, lon: 7.0010 },
              { lat: 50, lon: 7.0015 },
            ] },
          { type: 'way', id: 999, tags: { highway: 'service' },
            geometry: [
              { lat: 50.5, lon: 8.0 },
              { lat: 50.5, lon: 8.001 },
            ] },
        ],
      }),
    });
    expect(r.skipped).toBeFalsy();
    const written = JSON.parse(fs.readFileSync(path.join(outDir, 'osm_bonn.json'), 'utf8'));
    expect(written.wayGeometries).toBeTruthy();
    // Way 200 is matched → full vertex list is preserved (4 nodes,
    // not just the 2 endpoints we used to ship).
    expect(written.wayGeometries['200']).toHaveLength(4);
    expect(written.wayGeometries['200'][1]).toEqual({ lat: 50, lon: 7.0005 });
    // Way 999 is unreferenced → not emitted at all.
    expect(written.wayGeometries['999']).toBeUndefined();
    expect(written.ways['999']).toBeUndefined();
  });
});

describe('osm_producer — fetchOverpass retry policy', () => {
  test('retries on 429 then succeeds', async () => {
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      if (calls < 2) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ elements: [] }) };
    };
    const r = await osm.fetchOverpass('q', { fetch: stubFetch, retries: 3, backoffMs: 1, timeoutMs: 1000 });
    expect(r).toEqual({ elements: [] });
    expect(calls).toBe(2);
  });

  test('does NOT retry on non-429 4xx (fast-fail)', async () => {
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      return { ok: false, status: 400, json: async () => ({}) };
    };
    await expect(
      osm.fetchOverpass('q', { fetch: stubFetch, retries: 3, backoffMs: 1, timeoutMs: 1000 })
    ).rejects.toThrow(/HTTP 400/);
    // Critical: only one HTTP call, not 4 (= 1 + 3 retries).
    expect(calls).toBe(1);
  });

  test('retries network errors then surfaces last error', async () => {
    let calls = 0;
    const stubFetch = async () => {
      calls++;
      throw new Error('ECONNRESET');
    };
    await expect(
      osm.fetchOverpass('q', { fetch: stubFetch, retries: 2, backoffMs: 1, timeoutMs: 1000 })
    ).rejects.toThrow(/ECONNRESET/);
    expect(calls).toBe(3); // initial + 2 retries
  });
});

describe('osm_producer — parseArgs', () => {
  test('parses CLI flags, falls back to env / defaults', () => {
    const prev = process.env.ENRICH_OSM_DATA_DIR;
    process.env.ENRICH_OSM_DATA_DIR = '/tmp/x';
    try {
      const opts = osm.parseArgs(['--city', 'Bonn', '--max-distance', '25']);
      expect(opts.cities).toEqual(['Bonn']);
      expect(opts.outDir).toBe('/tmp/x');
      expect(opts.maxDistanceM).toBe(25);
    } finally {
      if (prev === undefined) delete process.env.ENRICH_OSM_DATA_DIR;
      else process.env.ENRICH_OSM_DATA_DIR = prev;
    }
  });

  test('--force flips the resume guard off', () => {
    expect(osm.parseArgs([]).force).toBeFalsy();
    expect(osm.parseArgs(['--force']).force).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// New tests for tiling / dedup / adaptive subdivision
// ---------------------------------------------------------------------------

describe('osm_producer — tileBbox', () => {
  test('produces N×M sub-bboxes that exactly cover the original bbox', () => {
    const orig = { minLat: 50.0, minLon: 7.0, maxLat: 51.0, maxLon: 8.0 };
    const tiles = osm.tileBbox(orig, 2, 3); // 2 columns, 3 rows = 6 tiles
    expect(tiles).toHaveLength(6);

    // Union of all tiles must cover the original extent exactly.
    const minLat = Math.min(...tiles.map(t => t.minLat));
    const maxLat = Math.max(...tiles.map(t => t.maxLat));
    const minLon = Math.min(...tiles.map(t => t.minLon));
    const maxLon = Math.max(...tiles.map(t => t.maxLon));
    expect(minLat).toBeCloseTo(orig.minLat, 10);
    expect(maxLat).toBeCloseTo(orig.maxLat, 10);
    expect(minLon).toBeCloseTo(orig.minLon, 10);
    expect(maxLon).toBeCloseTo(orig.maxLon, 10);
  });

  test('1×1 returns a single tile identical to the original bbox', () => {
    const orig = { minLat: 49.0, minLon: 6.5, maxLat: 50.0, maxLon: 7.5 };
    const tiles = osm.tileBbox(orig, 1, 1);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual(orig);
  });

  test('all tiles have equal dimensions', () => {
    const orig = { minLat: 50.0, minLon: 7.0, maxLat: 51.0, maxLon: 9.0 };
    const tiles = osm.tileBbox(orig, 4, 4);
    const latH = (orig.maxLat - orig.minLat) / 4;
    const lonW = (orig.maxLon - orig.minLon) / 4;
    for (const t of tiles) {
      expect(t.maxLat - t.minLat).toBeCloseTo(latH, 10);
      expect(t.maxLon - t.minLon).toBeCloseTo(lonW, 10);
    }
  });

  test('returns [] for a null bbox', () => {
    expect(osm.tileBbox(null, 2, 2)).toEqual([]);
  });
});

describe('osm_producer — mergeOverpassResponses', () => {
  test('deduplicates elements with the same type/id across responses', () => {
    const r1 = { elements: [
      { type: 'way', id: 1, tags: { highway: 'primary' } },
      { type: 'way', id: 2, tags: { highway: 'secondary' } },
    ] };
    const r2 = { elements: [
      { type: 'way', id: 2, tags: { highway: 'secondary' } }, // duplicate
      { type: 'way', id: 3, tags: { highway: 'tertiary' } },
    ] };
    const merged = osm.mergeOverpassResponses([r1, r2]);
    expect(merged.elements).toHaveLength(3);
    expect(merged.elements.map(e => e.id)).toEqual([1, 2, 3]);
  });

  test('first-occurrence geometry wins for duplicates', () => {
    const r1 = { elements: [{ type: 'way', id: 99, tags: { highway: 'primary' } }] };
    const r2 = { elements: [{ type: 'way', id: 99, tags: { highway: 'secondary' } }] };
    const merged = osm.mergeOverpassResponses([r1, r2]);
    expect(merged.elements).toHaveLength(1);
    expect(merged.elements[0].tags.highway).toBe('primary');
  });

  test('handles empty / missing elements arrays gracefully', () => {
    expect(osm.mergeOverpassResponses([]).elements).toHaveLength(0);
    expect(osm.mergeOverpassResponses([{}, { elements: [] }]).elements).toHaveLength(0);
  });

  test('nodes and ways with the same id are kept separately', () => {
    const r1 = { elements: [{ type: 'node', id: 5, lat: 50, lon: 7 }] };
    const r2 = { elements: [{ type: 'way',  id: 5, tags: {}, geometry: [] }] };
    const merged = osm.mergeOverpassResponses([r1, r2]);
    expect(merged.elements).toHaveLength(2);
  });
});

describe('osm_producer — produceCity tiling', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osm-tiling-'));
    fs.mkdirSync(path.join(tmpRoot, 'out'));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('2×2 default tiling: fetchOverpass is called 4 times and all ways are merged', async () => {
    const inputFc = fc([pt(1, 7.0005, 50.0), pt(2, 7.0008, 50.00002)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_tilecity.geojson'),
      JSON.stringify(inputFc),
    );

    let callCount = 0;
    // Each tile returns a distinct way — 4 tiles → 4 unique ways.
    const stubFetch = async () => {
      const id = 500 + (++callCount);
      return {
        version: 0.6,
        elements: [{
          type: 'way', id,
          tags: { highway: 'residential' },
          geometry: [{ lat: 50.0, lon: 7.0 }, { lat: 50.0, lon: 7.001 }],
        }],
      };
    };

    const r = await osm.produceCity(tmpRoot, 'tilecity', {
      outDir: path.join(tmpRoot, 'cache'),
      fetchOverpass: stubFetch,
      interTileDelayMs: 0,
    });

    expect(callCount).toBe(4);
    expect(r.skipped).toBeFalsy();
    // 4 unique ways from 4 tiles, all deduplicated.
    expect(r.counts.candidates).toBe(4);
    expect(r.tiles.initial).toBe(4);
    expect(r.tiles.leafTiles).toBe(4);
    expect(r.tiles.elements).toBe(4);
  });

  test('adaptive subdivision: V8 string error triggers recursive 2×2 split, producer does not abort', async () => {
    // Points far apart so each 2×2 tile is ~0.05 deg — large enough to split
    // (MIN_TILE_DEG = 0.02, so each sub-tile would be ~0.025 ≥ 0.02 → allowed).
    const inputFc = fc([pt(1, 7.0, 50.0), pt(2, 7.1, 50.1)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_splitcity.geojson'),
      JSON.stringify(inputFc),
    );

    let callCount = 0;
    // The very first tile fetch throws the V8 string error; all others succeed.
    const stubFetch = async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Cannot create a string longer than 0x1fffffe8 characters');
      }
      return {
        version: 0.6,
        elements: [{
          type: 'way', id: 600 + callCount,
          tags: { highway: 'residential' },
          geometry: [{ lat: 50.0, lon: 7.0 }, { lat: 50.0, lon: 7.001 }],
        }],
      };
    };

    const r = await osm.produceCity(tmpRoot, 'splitcity', {
      outDir: path.join(tmpRoot, 'cache'),
      fetchOverpass: stubFetch,
      interTileDelayMs: 0,
    });

    // Should NOT abort.
    expect(r.skipped).toBeFalsy();
    // Tile 0 fails (call 1), then 4 sub-tiles + 3 remaining initial tiles = 8 Overpass calls.
    expect(callCount).toBe(8);
    // 3 unchanged initial tiles + 4 leaf sub-tiles replacing the failed one = 7 leaf tiles.
    expect(r.tiles.leafTiles).toBe(7);
    expect(r.tiles.initial).toBe(4);
  });

  test('min-tile escalation: error is re-thrown once tiles become too small to subdivide', async () => {
    // Single point → tiny bbox after padBbox → each 2×2 tile is ≈0.005 deg.
    // Subdividing would yield 0.0025 deg < MIN_TILE_DEG (0.02), so the error escalates.
    const inputFc = fc([pt(1, 7.0005, 50.0)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_mintilecity.geojson'),
      JSON.stringify(inputFc),
    );

    const stubFetch = async () => {
      throw new Error('Cannot create a string longer than 0x1fffffe8 characters');
    };

    await expect(
      osm.produceCity(tmpRoot, 'mintilecity', {
        outDir: path.join(tmpRoot, 'cache'),
        fetchOverpass: stubFetch,
        interTileDelayMs: 0,
      })
    ).rejects.toThrow(/Cannot create a string longer than/);
  });

  test('streaming dedup: 4 tiles sharing the same 2 Way-IDs produce exactly 2 ways and correct totalElements count', async () => {
    // Two points far enough apart that each matches a distinct way.
    const inputFc = fc([pt(1, 7.0005, 50.0), pt(2, 7.0005, 50.1)]);
    fs.writeFileSync(
      path.join(tmpRoot, 'out', 'output_all_years_dedupcity.geojson'),
      JSON.stringify(inputFc),
    );

    // Every tile returns the same 2 Way-IDs — they should be deduplicated
    // down to exactly 2 ways in the output.
    const stubFetch = async () => ({
      version: 0.6,
      elements: [
        {
          type: 'way', id: 101,
          tags: { highway: 'primary' },
          geometry: [{ lat: 50.0, lon: 7.0 }, { lat: 50.0, lon: 7.001 }],
        },
        {
          type: 'way', id: 102,
          tags: { highway: 'secondary' },
          geometry: [{ lat: 50.1, lon: 7.0 }, { lat: 50.1, lon: 7.001 }],
        },
      ],
    });

    const r = await osm.produceCity(tmpRoot, 'dedupcity', {
      outDir: path.join(tmpRoot, 'cache'),
      fetchOverpass: stubFetch,
      interTileDelayMs: 0,
    });

    expect(r.skipped).toBeFalsy();
    // 4 tiles × 2 elements each = 8 total elements before dedup.
    expect(r.tiles.elements).toBe(8);
    // After dedup only 2 unique ways should survive as candidates.
    expect(r.counts.candidates).toBe(2);
    // Both ways were snapped to by the two distinct accident points.
    const written = JSON.parse(fs.readFileSync(
      path.join(tmpRoot, 'cache', 'osm_dedupcity.json'), 'utf8',
    ));
    expect(Object.keys(written.ways)).toHaveLength(2);
  });
});
