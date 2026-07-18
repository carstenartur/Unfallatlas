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
      source: 'OSM-highway-proxy',
      datasetVersion: preflight.CURRENT_PRODUCER_VERSIONS.traffic,
      inputFingerprint: FINGERPRINT,
      ways: { W1: { value: 800, unit: 'DTV' } },
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
});
