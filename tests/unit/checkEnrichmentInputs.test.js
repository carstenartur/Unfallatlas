'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const preflight = require('../../scripts/check-enrichment-inputs');

const FINGERPRINT = 'a'.repeat(64);

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

describe('check-enrichment-inputs', () => {
  let root;
  let dirs;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-enrichment-preflight-'));
    dirs = {
      osmDir: path.join(root, 'osm'),
      demDir: path.join(root, 'dem'),
      trafficDir: path.join(root, 'traffic'),
    };
    writeJson(path.join(dirs.osmDir, 'osm_bonn.json'), {
      producerVersion: preflight.CURRENT_PRODUCER_VERSIONS.osm,
      inputFingerprint: FINGERPRINT,
      coverage: 'full',
      index: [],
      ways: { W1: { highway: 'residential' } },
      wayGeometries: { W1: [{ lat: 50, lon: 7 }, { lat: 50.001, lon: 7.001 }] },
    });
    writeJson(path.join(dirs.demDir, 'dem_bonn.json'), {
      producerVersion: preflight.CURRENT_PRODUCER_VERSIONS.dem,
      inputFingerprint: FINGERPRINT,
      points: [{ lat: 50, lon: 7, elevation_m: 100 }],
      wayElevations: { W1: { road_slope_percent: 1.2 } },
    });
    writeJson(path.join(dirs.trafficDir, 'traffic_bonn.json'), {
      source: 'OSM-highway-class-proxy',
      producerVersion: preflight.CURRENT_PRODUCER_VERSIONS.traffic,
      datasetVersion: preflight.CURRENT_PRODUCER_VERSIONS.traffic,
      inputFingerprint: FINGERPRINT,
      measurementType: 'proxy',
      ways: {
        W1: {
          measurementType: 'proxy',
          proxyClass: 'low',
          highwayClass: 'residential',
          confidence: 'low',
        },
      },
    });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('accepts complete OSM, DEM and traffic datasets for the current accident input', () => {
    const result = preflight.validateCityInputs('Bonn', dirs, { expectedFingerprint: FINGERPRINT });
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  test('fails before enrichment when one producer file is missing', () => {
    fs.unlinkSync(path.join(dirs.demDir, 'dem_bonn.json'));
    const result = preflight.validateCityInputs('Bonn', dirs, { expectedFingerprint: FINGERPRINT });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/dem: missing/);
  });

  test('rejects matched-only OSM cache pretending to be usable', () => {
    writeJson(path.join(dirs.osmDir, 'osm_bonn.json'), {
      producerVersion: preflight.CURRENT_PRODUCER_VERSIONS.osm,
      inputFingerprint: FINGERPRINT,
      ways: { W1: {} },
      index: [],
      wayGeometries: { W1: [] },
    });
    const result = preflight.validateCityInputs('Bonn', dirs, { expectedFingerprint: FINGERPRINT });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/coverage/);
  });

  test('rejects a structurally valid cache from an older producer version', () => {
    const file = path.join(dirs.demDir, 'dem_bonn.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.producerVersion = '0.9.0';
    writeJson(file, data);
    const result = preflight.validateCityInputs('Bonn', dirs, { expectedFingerprint: FINGERPRINT });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/producer version/);
  });

  test('rejects caches generated from a different accident GeoJSON', () => {
    const result = preflight.validateCityInputs('Bonn', dirs, { expectedFingerprint: 'b'.repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/inputFingerprint does not match/);
  });

  test('rejects numeric values smuggled into a qualitative traffic proxy', () => {
    const file = path.join(dirs.trafficDir, 'traffic_bonn.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.ways.W1.value = 800;
    data.ways.W1.unit = 'Kfz/24 h';
    writeJson(file, data);

    const result = preflight.validateCityInputs('Bonn', dirs, { expectedFingerprint: FINGERPRINT });
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/value is forbidden for a proxy/);
    expect(result.problems.join('\n')).toMatch(/unit is forbidden for a proxy/);
  });

  test('fingerprint is unchanged when core and post-enrichment provider fields are added', () => {
    const rawFile = path.join(root, 'raw.geojson');
    const enrichedFile = path.join(root, 'enriched.geojson');
    const baseFeature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [7.1, 50.7] },
      properties: { id: 'A1', ukategorie: '2', istrad: '1' },
    };
    writeJson(rawFile, {
      type: 'FeatureCollection',
      features: [baseFeature],
    });
    writeJson(enrichedFile, {
      type: 'FeatureCollection',
      properties: {
        enrichmentDicts: { highway: ['residential'] },
        enrichmentSummary: { matched: 1 },
      },
      features: [{
        ...baseFeature,
        properties: {
          ...baseFeature.properties,
          matched_way_id: 'W1',
          elevation_m: 100.1,
          slope_percent: 2.3,
          slope_class: 'gentle',
          highway: 0,
          traffic_measurement_type: 'proxy',
          traffic_proxy_class: 'low',
          traffic_volume_source: 'OSM-highway-class-proxy',
          traffic_volume_confidence: 'low',
          traffic_proxy_basis: 'highway=residential',
          road_slope_source_id: 'hannover.dgm1',
          road_slope_source: 'Digitales Geländemodell DGM1',
          road_slope_resolution_m: 1,
          road_slope_profile_window_m: 50,
          road_slope_direction: 'uphill_along_geometry',
          road_slope_quality: 'high',
          road_slope_reliable_for_road: true,
          road_slope_residual_mad_m: 0.02,
          road_slope_uncertainty_percent: 0.2,
          road_slope_uncertainty_reasons: [],
        },
      }],
    });

    expect(preflight.fingerprintJsonArtifact(enrichedFile))
      .toBe(preflight.fingerprintJsonArtifact(rawFile));
  });

  test('fingerprint changes when an official accident value changes', () => {
    const first = path.join(root, 'first.geojson');
    const second = path.join(root, 'second.geojson');
    writeJson(first, {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] }, properties: { id: 'A1', ukategorie: '2' } }],
    });
    writeJson(second, {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] }, properties: { id: 'A1', ukategorie: '1' } }],
    });
    expect(preflight.fingerprintJsonArtifact(first))
      .not.toBe(preflight.fingerprintJsonArtifact(second));
  });
});