'use strict';

/**
 * Tests for scripts/producers/traffic_producer.js
 *
 * Pure-helper coverage (highway → DTV proxy lookup, dataset assembly)
 * plus an end-to-end produceCity test that reads an osm_<slug>.json
 * fixture and a round-trip contract test that runs the producer's
 * output through `enrich_geojson.enrichCity` and asserts the per-feature
 * `traffic_proxy_class` lands.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const traffic = require('../../scripts/producers/traffic_producer.js');

function fc(features) { return { type: 'FeatureCollection', features }; }
function pt(id, lon, lat) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id: String(id) },
  };
}

describe('traffic_producer — slugCity', () => {
  test('matches the enrich_geojson convention', () => {
    expect(traffic.slugCity('Bonn')).toBe('bonn');
    expect(traffic.slugCity('Düsseldorf')).toBe('duesseldorf');
  });
});

describe('traffic_producer — dtvFromHighway', () => {
  test('looks up known highway classes', () => {
    expect(traffic.dtvFromHighway('motorway')).toBe(50000);
    expect(traffic.dtvFromHighway('primary')).toBe(18000);
    expect(traffic.dtvFromHighway('residential')).toBe(800);
    expect(traffic.dtvFromHighway('living_street')).toBe(200);
  });

  test('case-insensitive', () => {
    expect(traffic.dtvFromHighway('PRIMARY')).toBe(18000);
    expect(traffic.dtvFromHighway('Residential')).toBe(800);
  });

  test('returns undefined for unknown / missing tags', () => {
    expect(traffic.dtvFromHighway(undefined)).toBeUndefined();
    expect(traffic.dtvFromHighway(null)).toBeUndefined();
    expect(traffic.dtvFromHighway('cyberhighway')).toBeUndefined();
    expect(traffic.dtvFromHighway('')).toBeUndefined();
  });

  test('proxy values respect the documented DTV ordering', () => {
    expect(traffic.dtvFromHighway('motorway')).toBeGreaterThan(traffic.dtvFromHighway('primary'));
    expect(traffic.dtvFromHighway('primary')).toBeGreaterThan(traffic.dtvFromHighway('secondary'));
    expect(traffic.dtvFromHighway('secondary')).toBeGreaterThan(traffic.dtvFromHighway('tertiary'));
    expect(traffic.dtvFromHighway('tertiary')).toBeGreaterThan(traffic.dtvFromHighway('residential'));
  });
});

describe('traffic_producer — buildTrafficDataset', () => {
  test('emits the schema consumed by loadTrafficProvider', () => {
    const ds = traffic.buildTrafficDataset({
      '1': { highway: 'residential' },
      '2': { highway: 'primary' },
      '3': { highway: 'unknown_class' }, // dropped
      '4': { /* no highway */ },        // dropped
    }, { year: 2024, extractDate: '2026-05-07' });
    expect(ds.source).toBe('OSM-highway-proxy');
    expect(ds.datasetVersion).toBe(traffic.PRODUCER_VERSION);
    expect(ds.extractDate).toBe('2026-05-07');
    expect(Object.keys(ds.ways).sort()).toEqual(['1', '2']);
    expect(ds.ways['1']).toEqual({ value: 800,   unit: 'DTV', year: 2024, confidence: 'low' });
    expect(ds.ways['2']).toEqual({ value: 18000, unit: 'DTV', year: 2024, confidence: 'low' });
  });

  test('honours custom unit / confidence / source / dtvLookup', () => {
    const ds = traffic.buildTrafficDataset({ '1': { highway: 'residential' } }, {
      source: 'CustomCounts',
      datasetVersion: '2025.1',
      unit: 'AADT',
      confidence: 'medium',
      dtvLookup: () => 12345,
    });
    expect(ds.source).toBe('CustomCounts');
    expect(ds.datasetVersion).toBe('2025.1');
    expect(ds.ways['1']).toEqual({ value: 12345, unit: 'AADT', year: expect.any(Number), confidence: 'medium' });
  });

  test('returns an empty ways table when the OSM input is empty', () => {
    expect(traffic.buildTrafficDataset({}).ways).toEqual({});
    expect(traffic.buildTrafficDataset(null).ways).toEqual({});
  });

  test('defaults year to the current UTC calendar year', () => {
    const ds = traffic.buildTrafficDataset({ '1': { highway: 'primary' } });
    expect(ds.ways['1'].year).toBe(new Date().getUTCFullYear());
  });
});

describe('traffic_producer — readOsmWays', () => {
  test('returns the ways table from osm_<slug>.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
    try {
      fs.writeFileSync(path.join(tmp, 'osm_bonn.json'), JSON.stringify({
        ways: { '1': { highway: 'residential' } }, index: [],
      }));
      expect(traffic.readOsmWays(tmp, 'bonn')).toEqual({ '1': { highway: 'residential' } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('returns null when the file is missing or unreadable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
    try {
      expect(traffic.readOsmWays(tmp, 'nowhere')).toBeNull();
      expect(traffic.readOsmWays(null, 'bonn')).toBeNull();
      fs.writeFileSync(path.join(tmp, 'osm_garbage.json'), '{not json');
      expect(traffic.readOsmWays(tmp, 'garbage')).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('traffic_producer — produceCity', () => {
  test('reads osm cache, writes traffic_<slug>.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
    const osmDir = path.join(tmp, 'osm');
    const outDir = path.join(tmp, 'traffic');
    fs.mkdirSync(osmDir, { recursive: true });
    fs.writeFileSync(path.join(osmDir, 'osm_bonn.json'), JSON.stringify({
      ways: {
        '100': { highway: 'residential' },
        '200': { highway: 'primary'    },
      },
      index: [],
    }));

    try {
      const r = traffic.produceCity(tmp, 'bonn', { outDir, osmDir });
      expect(r.skipped).toBeFalsy();
      expect(r.counts).toEqual({ candidateWays: 2, taggedWays: 2 });
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'traffic_bonn.json'), 'utf8'));
      expect(written.source).toBe('OSM-highway-proxy');
      expect(Object.keys(written.ways).sort()).toEqual(['100', '200']);
      expect(written.ways['100'].value).toBe(800);
      expect(written.ways['200'].value).toBe(18000);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('skips cleanly when the OSM cache for the city is missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
    try {
      const r = traffic.produceCity(tmp, 'bonn', { outDir: tmp, osmDir: tmp });
      expect(r.skipped).toBe(true);
      expect(r.reason).toMatch(/no osm cache/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('resume: skips when traffic_<slug>.json already exists in outDir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
    const osmDir = path.join(tmp, 'osm');
    const outDir = path.join(tmp, 'traffic');
    fs.mkdirSync(osmDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(osmDir, 'osm_bonn.json'), JSON.stringify({
      ways: { '100': { highway: 'residential' } },
      index: [],
    }));
    fs.writeFileSync(path.join(outDir, 'traffic_bonn.json'), '{"sentinel":true}');
    try {
      const r = traffic.produceCity(tmp, 'bonn', { outDir, osmDir });
      expect(r.skipped).toBe(true);
      expect(r.reason).toMatch(/already cached/);
      expect(JSON.parse(fs.readFileSync(path.join(outDir, 'traffic_bonn.json'), 'utf8')))
        .toEqual({ sentinel: true });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('force: re-runs even when traffic_<slug>.json already exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
    const osmDir = path.join(tmp, 'osm');
    const outDir = path.join(tmp, 'traffic');
    fs.mkdirSync(osmDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(osmDir, 'osm_bonn.json'), JSON.stringify({
      ways: { '100': { highway: 'residential' } },
      index: [],
    }));
    fs.writeFileSync(path.join(outDir, 'traffic_bonn.json'), '{"sentinel":true}');
    try {
      const r = traffic.produceCity(tmp, 'bonn', { outDir, osmDir, force: true });
      expect(r.skipped).toBeFalsy();
      const written = JSON.parse(fs.readFileSync(path.join(outDir, 'traffic_bonn.json'), 'utf8'));
      expect(written.sentinel).toBeUndefined();
      expect(written.ways['100'].value).toBe(800);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test('produced traffic_<slug>.json is consumable by enrich_geojson loadTrafficProvider', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traffic-prod-'));
    const osmDir     = path.join(tmp, 'osm');
    const trafficDir = path.join(tmp, 'traffic');
    fs.mkdirSync(osmDir, { recursive: true });

    // OSM cache: one residential way with one accident snapped to it.
    fs.writeFileSync(path.join(osmDir, 'osm_bonn.json'), JSON.stringify({
      ways:  { '100': { highway: 'residential' } },
      index: [{ lat: 50.0, lon: 7.0, way_id: '100' }],
      source: 'OpenStreetMap (Overpass)',
    }));

    try {
      const r = traffic.produceCity(tmp, 'bonn', { outDir: trafficDir, osmDir });
      expect(r.skipped).toBeFalsy();

      // Now exercise the enricher: traffic + OSM together should
      // attach `traffic_proxy_class` to the matched accident feature.
      const enrich = require('../../scripts/enrich_geojson.js');
      const fcCopy = fc([pt(1, 7.0, 50.0)]);
      const prevOsm     = process.env.ENRICH_OSM_DATA_DIR;
      const prevTraffic = process.env.ENRICH_TRAFFIC_DATA_DIR;
      process.env.ENRICH_OSM_DATA_DIR     = osmDir;
      process.env.ENRICH_TRAFFIC_DATA_DIR = trafficDir;
      try {
        const { ways, meta } = enrich.enrichCity(fcCopy, 'bonn', {
          useOsm: true, useDem: false, useTraffic: true,
        });
        expect(meta.counts.matchedToWay).toBe(1);
        expect(meta.counts.withTrafficProxy).toBe(1);
        // 800 DTV → "low" proxy class.
        expect(fcCopy.features[0].properties.traffic_proxy_class).toBe('low');
        // Per-way fields landed in ways_<city>.json.
        expect(ways['100'].traffic_volume_value).toBe(800);
        expect(ways['100'].traffic_volume_unit).toBe('DTV');
        expect(ways['100'].traffic_volume_source).toBe('OSM-highway-proxy');
      } finally {
        if (prevOsm     === undefined) delete process.env.ENRICH_OSM_DATA_DIR;
        else process.env.ENRICH_OSM_DATA_DIR = prevOsm;
        if (prevTraffic === undefined) delete process.env.ENRICH_TRAFFIC_DATA_DIR;
        else process.env.ENRICH_TRAFFIC_DATA_DIR = prevTraffic;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('traffic_producer — parseArgs', () => {
  test('parses CLI flags, falls back to env / defaults', () => {
    const prevOut = process.env.ENRICH_TRAFFIC_DATA_DIR;
    const prevOsm = process.env.ENRICH_OSM_DATA_DIR;
    process.env.ENRICH_TRAFFIC_DATA_DIR = '/tmp/t';
    process.env.ENRICH_OSM_DATA_DIR     = '/tmp/o';
    try {
      const opts = traffic.parseArgs(['--city', 'Bonn', '--year', '2024']);
      expect(opts.cities).toEqual(['Bonn']);
      expect(opts.outDir).toBe('/tmp/t');
      expect(opts.osmDir).toBe('/tmp/o');
      expect(opts.year).toBe(2024);
    } finally {
      if (prevOut === undefined) delete process.env.ENRICH_TRAFFIC_DATA_DIR;
      else process.env.ENRICH_TRAFFIC_DATA_DIR = prevOut;
      if (prevOsm === undefined) delete process.env.ENRICH_OSM_DATA_DIR;
      else process.env.ENRICH_OSM_DATA_DIR = prevOsm;
    }
  });

  test('--force flips the resume guard off', () => {
    expect(traffic.parseArgs([]).force).toBeFalsy();
    expect(traffic.parseArgs(['--force']).force).toBe(true);
  });
});
