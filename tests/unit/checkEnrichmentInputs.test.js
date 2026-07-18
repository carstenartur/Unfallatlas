'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const preflight = require('../../scripts/check-enrichment-inputs');

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
      producerVersion: '1.2.0', coverage: 'full', index: [],
      ways: { W1: { highway: 'residential' } },
      wayGeometries: { W1: [{ lat: 50, lon: 7 }, { lat: 50.001, lon: 7.001 }] },
    });
    writeJson(path.join(dirs.demDir, 'dem_bonn.json'), {
      producerVersion: '1.1.0', points: [{ lat: 50, lon: 7, elevation_m: 100 }],
      wayElevations: { W1: { road_slope_percent: 1.2 } },
    });
    writeJson(path.join(dirs.trafficDir, 'traffic_bonn.json'), {
      source: 'OSM-highway-proxy', datasetVersion: '1.0.0',
      ways: { W1: { value: 800, unit: 'DTV' } },
    });
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('accepts complete OSM, DEM and traffic datasets', () => {
    const result = preflight.validateCityInputs('Bonn', dirs);
    expect(result.ok).toBe(true);
    expect(result.problems).toEqual([]);
  });

  test('fails before enrichment when one producer file is missing', () => {
    fs.unlinkSync(path.join(dirs.demDir, 'dem_bonn.json'));
    const result = preflight.validateCityInputs('Bonn', dirs);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/dem: missing/);
  });

  test('rejects matched-only OSM cache pretending to be usable', () => {
    writeJson(path.join(dirs.osmDir, 'osm_bonn.json'), {
      producerVersion: '1.1.0', ways: { W1: {} }, index: [], wayGeometries: { W1: [] },
    });
    const result = preflight.validateCityInputs('Bonn', dirs);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/coverage/);
  });
});
