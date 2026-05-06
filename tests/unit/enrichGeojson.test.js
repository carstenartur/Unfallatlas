'use strict';

/**
 * Tests for scripts/enrich_geojson.js
 *
 * Covers the schema, the per-feature/per-way split, the
 * enrichmentDicts encoding, idempotency, and the file-on-disk wrapper
 * with hand-crafted offline-provider fixtures (no network).
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const enrich = require('../../scripts/enrich_geojson.js');

function fcWith(features) {
  return { type: 'FeatureCollection', features };
}

function ptFeature(id, lon, lat, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id: String(id), ukategorie: '2', ...extra },
  };
}

describe('enrich_geojson — pure helpers', () => {
  test('classifySlope thresholds match the documented bands', () => {
    expect(enrich.classifySlope(0)).toBe('flat');
    expect(enrich.classifySlope(1.9)).toBe('flat');
    expect(enrich.classifySlope(2.0)).toBe('flat');
    expect(enrich.classifySlope(3)).toBe('gentle');
    expect(enrich.classifySlope(-3)).toBe('gentle');     // sign-insensitive
    expect(enrich.classifySlope(5)).toBe('moderate');
    expect(enrich.classifySlope(8)).toBe('steep');
    expect(enrich.classifySlope(15)).toBe('very_steep');
    expect(enrich.classifySlope(undefined)).toBeUndefined();
    expect(enrich.classifySlope(NaN)).toBeUndefined();
  });

  test('classifyTrafficProxy thresholds match the documented bands', () => {
    expect(enrich.classifyTrafficProxy(500)).toBe('low');
    expect(enrich.classifyTrafficProxy(3000)).toBe('medium');
    expect(enrich.classifyTrafficProxy(10000)).toBe('high');
    expect(enrich.classifyTrafficProxy(20000)).toBe('very_high');
    expect(enrich.classifyTrafficProxy(undefined)).toBeUndefined();
  });

  test('slugCity normalises German diacritics like the converter', () => {
    expect(enrich.slugCity('Bonn')).toBe('bonn');
    expect(enrich.slugCity('Düsseldorf')).toBe('duesseldorf');
    expect(enrich.slugCity('Frankfurt am Main')).toBe('frankfurt_am_main');
    expect(enrich.slugCity('Nürnberg')).toBe('nuernberg');
  });
});

describe('enrich_geojson — enrichCity', () => {
  function fixedProviders() {
    return {
      osm: {
        name: 'osm',
        source: 'OpenStreetMap (Overpass) test',
        extractDate: '2026-01-10',
        matchFeature(lat, lon) {
          if (lat === 50.10000 && lon === 7.20000) return { matched_way_id: 'W1', road_context_source: 'osm' };
          if (lat === 50.20000 && lon === 7.30000) return { matched_way_id: 'W1', road_context_source: 'osm' };
          if (lat === 50.30000 && lon === 7.40000) return { matched_way_id: 'W2', road_context_source: 'osm' };
          return null;
        },
        wayAttributes(wayId) {
          if (wayId === 'W1') return { highway: 'residential', maxspeed: 30, lanes: 2, surface: 'asphalt' };
          if (wayId === 'W2') return { highway: 'secondary',   maxspeed: 50, lanes: 4, surface: 'asphalt' };
          return null;
        },
      },
      dem: {
        name: 'dem',
        source: 'SRTM30',
        resolutionM: 30,
        elevateFeature(lat, lon) {
          if (lat === 50.10000 && lon === 7.20000) return { elevation_m: 123.5, slope_percent: 7.1, slope_abs_percent: 7.1, slope_class: 'steep', slope_source: 'SRTM30' };
          if (lat === 50.20000 && lon === 7.30000) return { elevation_m: 100.0, slope_percent: -1.5,  slope_abs_percent: 1.5,  slope_class: 'flat',  slope_source: 'SRTM30' };
          return null;
        },
        wayElevation(wayId) {
          if (wayId === 'W1') return { road_slope_percent: 6.7 };
          return null;
        },
      },
      traffic: {
        name: 'traffic',
        source: 'BASt SDV (test)',
        datasetVersion: '2024',
        wayTraffic(wayId) {
          if (wayId === 'W1') return {
            traffic_volume_value: 8000, traffic_volume_unit: 'DTV',
            traffic_volume_year: 2024, traffic_volume_source: 'BASt SDV (test)',
            _proxy_class: 'high',
          };
          return null;
        },
      },
    };
  }

  test('writes per-feature fields, builds ways table, dict-codes categoricals', () => {
    const gj = fcWith([
      ptFeature(1, 7.20000, 50.10000),
      ptFeature(2, 7.30000, 50.20000),
      ptFeature(3, 7.40000, 50.30000),
      ptFeature(4, 7.99999, 50.99999),  // unmatched
    ]);

    const { ways, meta } = enrich.enrichCity(gj, 'testcity', { providers: fixedProviders() });

    // Per-feature: matched_way_id + elevation present, no leak of way-level fields.
    expect(gj.features[0].properties.matched_way_id).toBe('W1');
    expect(gj.features[0].properties.elevation_m).toBe(123.5);  // rounded to 1 decimal
    expect(gj.features[0].properties.slope_class).toBe('steep');
    expect(gj.features[0].properties.traffic_proxy_class).toBe('high');
    expect(gj.features[0].properties.highway).toBeUndefined();   // lives in ways_<city>.json

    // Unmatched feature has no enrichment fields at all.
    expect(gj.features[3].properties.matched_way_id).toBeUndefined();
    expect(gj.features[3].properties.elevation_m).toBeUndefined();

    // Ways table only contains touched ways.
    expect(Object.keys(ways).sort()).toEqual(['W1', 'W2']);

    // Dict-coded categoricals: highway is now an int code, top-level dict is present.
    expect(typeof ways.W1.highway).toBe('number');
    expect(typeof ways.W2.highway).toBe('number');
    expect(gj.properties.enrichmentDicts.highway).toEqual(expect.arrayContaining(['residential', 'secondary']));
    // Round-trip: the dict resolves correctly.
    const dict = gj.properties.enrichmentDicts.highway;
    expect(dict[ways.W1.highway]).toBe('residential');
    expect(dict[ways.W2.highway]).toBe('secondary');

    // Per-way attributes from all three providers merged correctly.
    expect(ways.W1.maxspeed).toBe(30);
    expect(ways.W1.road_slope_percent).toBe(6.7);
    expect(ways.W1.traffic_volume_value).toBe(8000);
    expect(ways.W1.traffic_volume_year).toBe(2024);

    // Meta contains provenance + counts + dictFields.
    expect(meta.schemaVersion).toBe(1);
    expect(meta.enrichmentScriptVersion).toBe(enrich.ENRICHMENT_SCRIPT_VERSION);
    expect(meta.counts.features).toBe(4);
    expect(meta.counts.matchedToWay).toBe(3);
    expect(meta.counts.withElevation).toBe(2);
    expect(meta.counts.withTrafficProxy).toBe(2);
    expect(meta.counts.ways).toBe(2);
    expect(meta.dictFields).toEqual(expect.arrayContaining(['highway']));
    expect(meta.sources.osm.source).toMatch(/Overpass/);
    expect(meta.sources.dem.source).toBe('SRTM30');
  });

  test('drops nulls — never writes "null" for absent enrichment values', () => {
    const gj = fcWith([ ptFeature(1, 7.0, 50.0) ]);
    enrich.enrichCity(gj, 'testcity', { providers: { osm: null, dem: null, traffic: null } });
    const json = JSON.stringify(gj);
    expect(json).not.toMatch(/"elevation_m":\s*null/);
    expect(json).not.toMatch(/"matched_way_id":\s*null/);
  });

  test('is idempotent: running twice with the same providers yields the same output', () => {
    const make = () => fcWith([
      ptFeature(1, 7.20000, 50.10000),
      ptFeature(2, 7.30000, 50.20000),
    ]);
    const gj1 = make();
    enrich.enrichCity(gj1, 'testcity', { providers: fixedProviders() });
    enrich.enrichCity(gj1, 'testcity', { providers: fixedProviders() });

    const gj2 = make();
    enrich.enrichCity(gj2, 'testcity', { providers: fixedProviders() });

    // Compare without volatile meta (generatedAt). The geojson + ways
    // tables themselves must be byte-identical between runs.
    expect(JSON.stringify(gj1.features)).toBe(JSON.stringify(gj2.features));
    expect(JSON.stringify(gj1.properties)).toBe(JSON.stringify(gj2.properties));
  });

  test('--no-osm / --no-dem / --no-traffic disable stages independently', () => {
    const gj = fcWith([ ptFeature(1, 7.20000, 50.10000) ]);
    enrich.enrichCity(gj, 'testcity', { useOsm: false, providers: fixedProviders() });
    expect(gj.features[0].properties.matched_way_id).toBeUndefined();
    expect(gj.features[0].properties.elevation_m).toBe(123.5);  // DEM still ran
  });

  test('skips non-Point features without crashing', () => {
    const gj = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1,1],[2,2]] }, properties: {} },
        ptFeature(1, 7.20000, 50.10000),
      ],
    };
    expect(() => enrich.enrichCity(gj, 'testcity', { providers: fixedProviders() })).not.toThrow();
    expect(gj.features[1].properties.matched_way_id).toBe('W1');
  });

  test('throws on non-FeatureCollection input', () => {
    expect(() => enrich.enrichCity({ type: 'Feature' }, 'x')).toThrow(/FeatureCollection/);
  });

  test('memoises per-way provider lookups: each way is enriched once even when many features match it', () => {
    // Three accidents on W1 + one on W2 → osm.wayAttributes /
    // dem.wayElevation / traffic.wayTraffic must each be called
    // exactly once per way, not once per accident.
    const calls = { osmWay: 0, demWay: 0, trafficWay: 0 };
    const providers = {
      osm: {
        source: 'OSM test',
        matchFeature: (lat) => (lat === 50.1)
          ? { matched_way_id: 'W1', road_context_source: 'osm' }
          : { matched_way_id: 'W2', road_context_source: 'osm' },
        wayAttributes: (wayId) => { calls.osmWay++; return { highway: 'residential' }; },
      },
      dem: {
        source: 'SRTM30',
        elevateFeature: () => null,
        wayElevation: (wayId) => { calls.demWay++; return { road_slope_percent: 1.2 }; },
      },
      traffic: {
        source: 'BASt SDV',
        wayTraffic: (wayId) => {
          calls.trafficWay++;
          return { traffic_volume_value: 5000, _proxy_class: 'medium' };
        },
      },
    };
    const gj = fcWith([
      ptFeature(1, 7.0, 50.1),  // → W1
      ptFeature(2, 7.0, 50.1),  // → W1
      ptFeature(3, 7.0, 50.1),  // → W1
      ptFeature(4, 7.0, 50.2),  // → W2
    ]);
    enrich.enrichCity(gj, 'testcity', { providers });
    // Two unique ways, so 2 calls per provider — not 4.
    expect(calls.osmWay).toBe(2);
    expect(calls.demWay).toBe(2);
    expect(calls.trafficWay).toBe(2);
    // But every accident on a traffic-bearing way still gets the
    // per-feature `traffic_proxy_class` denormalisation.
    expect(gj.features.map(f => f.properties.traffic_proxy_class))
      .toEqual(['medium', 'medium', 'medium', 'medium']);
  });
});

describe('enrich_geojson — file-on-disk wrapper', () => {
  let tmpRoot;
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-enrich-'));
    fs.mkdirSync(path.join(tmpRoot, 'out'));
  });
  afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

  test('with all providers off: rewrites only the geojson; no meta/ways spam', () => {
    const slug = 'bonn';
    const gj = fcWith([ ptFeature(1, 7.0, 50.0) ]);
    const p  = enrich.pathsForCity(tmpRoot, slug);
    fs.writeFileSync(p.geojson, JSON.stringify(gj));

    const r = enrich.enrichCityFile(tmpRoot, slug, { useOsm: false, useDem: false, useTraffic: false });
    expect(r.skipped).toBe(false);
    expect(r.wroteCompanions).toBe(false);
    expect(fs.existsSync(p.geojson)).toBe(true);
    // No meaningful enrichment → no spurious ways/meta files (otherwise
    // the weekly enrich.yml cron would commit a fresh `generatedAt`
    // timestamp on every run).
    expect(fs.existsSync(p.ways)).toBe(false);
    expect(fs.existsSync(p.meta)).toBe(false);

    // The geojson is still a valid FeatureCollection with the same
    // number of features. This is the regression that asserts the
    // existing js/ua.data_v2.js loader keeps working with no
    // enrichment data.
    const written = JSON.parse(fs.readFileSync(p.geojson, 'utf8'));
    expect(written.type).toBe('FeatureCollection');
    expect(written.features).toHaveLength(1);
    expect(written.features[0].properties.id).toBe('1');
  });

  test('with at least one provider: writes ways + meta sidecars', () => {
    const slug = 'bonn';
    const gj = fcWith([
      { type: 'Feature', geometry: { type: 'Point', coordinates: [7.20000, 50.10000] },
        properties: { id: '1' } },
    ]);
    const p  = enrich.pathsForCity(tmpRoot, slug);
    fs.writeFileSync(p.geojson, JSON.stringify(gj));

    const providers = {
      osm: {
        source: 'OSM test', extractDate: '2026-01-10',
        matchFeature: (lat, lon) => (lat === 50.1 && lon === 7.2)
          ? { matched_way_id: 'W1', road_context_source: 'osm' } : null,
        wayAttributes: () => ({ highway: 'residential', maxspeed: 30 }),
      },
      dem: null, traffic: null,
    };
    const r = enrich.enrichCityFile(tmpRoot, slug, { providers });
    expect(r.wroteCompanions).toBe(true);
    expect(fs.existsSync(p.ways)).toBe(true);
    expect(fs.existsSync(p.meta)).toBe(true);
  });

  test('cleans up stale companion files when a re-run drops back to no-provider state', () => {
    const slug = 'bonn';
    const gj = fcWith([ ptFeature(1, 7.0, 50.0) ]);
    const p  = enrich.pathsForCity(tmpRoot, slug);
    fs.writeFileSync(p.geojson, JSON.stringify(gj));
    // Pre-create a stale ways + meta file pretending a previous run
    // had enrichment data.
    fs.writeFileSync(p.ways, '{"W_old":{}}');
    fs.writeFileSync(p.meta, '{"old":true}');

    enrich.enrichCityFile(tmpRoot, slug, { useOsm: false, useDem: false, useTraffic: false });
    expect(fs.existsSync(p.ways)).toBe(false);
    expect(fs.existsSync(p.meta)).toBe(false);
  });

  test('returns skipped result when input geojson is missing', () => {
    const r = enrich.enrichCityFile(tmpRoot, 'doesnotexist', {});
    expect(r.skipped).toBe(true);
    expect(r.reason).toMatch(/no input/);
  });

  test('parseArgs handles the documented flags', () => {
    expect(enrich.parseArgs(['--no-osm', '--no-dem', '--no-traffic']))
      .toMatchObject({ useOsm: false, useDem: false, useTraffic: false });
    expect(enrich.parseArgs(['--city', 'Bonn', '--city', 'Köln']))
      .toMatchObject({ cities: ['Bonn', 'Köln'] });
    expect(enrich.parseArgs(['--json'])).toMatchObject({ json: true });
  });
});
