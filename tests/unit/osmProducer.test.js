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
});
