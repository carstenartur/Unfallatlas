'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { main } = require('../../scripts/build-static-data');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ua-build-static-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

function gunzipJson(filePath) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(filePath)).toString('utf8'));
}

describe('build-static-data', () => {
  let root;

  beforeEach(() => {
    root = mkTmp();
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('builds gzip-only city, context and accident-tile artefacts', () => {
    const inputDir = path.join(root, '.build/enriched');
    const poiDir = path.join(root, 'out');
    const outputDir = path.join(root, '_site/out');

    writeJson(
      path.join(inputDir, 'output_all_years_hannover.geojson'),
      { type: 'FeatureCollection', features: [{
        type: 'Feature', geometry: { type: 'Point', coordinates: [9, 52] },
        properties: { id: '1' },
      }] }
    );
    writeJson(path.join(inputDir, 'ways_hannover.json'), { schemaVersion: 2, ways: {} });
    writeJson(
      path.join(inputDir, 'output_all_years_hannover.enrichment.meta.json'),
      { counts: { withElevation: 1, withTrafficProxy: 1, contextTiles: 1 }, slope: { withSlope: 1 } }
    );
    writeJson(
      path.join(inputDir, 'ctxtiles/hannover/index.json'),
      { schemaVersion: 3, tiles: [{ x: 10, y: 10 }] }
    );
    writeJson(
      path.join(inputDir, 'ctxtiles/hannover/10/10.json'),
      { schemaVersion: 3, ways: {}, geometries: {} }
    );
    writeJson(
      path.join(inputDir, 'accidenttiles/hannover/index.json'),
      {
        schemaVersion: 1,
        city: 'hannover',
        z: 13,
        totalCount: 1,
        sourceFingerprint: 'fingerprint-1',
        tiles: [{ x: 4300, y: 2680, count: 1 }],
      }
    );
    writeJson(
      path.join(inputDir, 'accidenttiles/hannover/13/4300/2680.json'),
      {
        schemaVersion: 1,
        city: 'hannover', z: 13, x: 4300, y: 2680,
        type: 'FeatureCollection',
        features: [{
          type: 'Feature', geometry: { type: 'Point', coordinates: [9, 52] },
          properties: { id: '1' },
        }],
      }
    );
    writeJson(
      path.join(poiDir, 'poi_hannover.geojson'),
      { type: 'FeatureCollection', features: [] }
    );

    main([
      '--root', root,
      '--input-dir', '.build/enriched',
      '--poi-dir', 'out',
      '--output-dir', '_site/out',
      '--gzip-only',
      '--manifest', '_site/out/data-manifest.json',
    ]);

    for (const relative of [
      'output_all_years_hannover.geojson.gz',
      'ways_hannover.json.gz',
      'poi_hannover.geojson.gz',
      'ctxtiles/hannover/index.json.gz',
      'ctxtiles/hannover/10/10.json.gz',
      'accidenttiles/hannover/index.json.gz',
      'accidenttiles/hannover/13/4300/2680.json.gz',
      'data-manifest.json',
    ]) {
      expect(fs.existsSync(path.join(outputDir, relative))).toBe(true);
    }

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'data-manifest.json'), 'utf8'));
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.dataMode).toBe('gzip-only');
    expect(manifest.generatedAt).toBeNull();
    expect(manifest.cities.hannover.accidents.gzipPath)
      .toBe('out/output_all_years_hannover.geojson.gz');
    expect(manifest.cities.hannover.enrichment.hasElevation).toBe(true);
    expect(manifest.cities.hannover.accidentTiles).toEqual({
      manifestPath: 'out/accidenttiles/hannover/index.json.gz',
      z: 13,
      tiles: 1,
      features: 1,
      sourceFingerprint: 'fingerprint-1',
    });

    expect(gunzipJson(path.join(outputDir, 'output_all_years_hannover.geojson.gz')).features)
      .toHaveLength(1);
    expect(gunzipJson(path.join(outputDir, 'accidenttiles/hannover/index.json.gz')).totalCount)
      .toBe(1);
    expect(gunzipJson(path.join(outputDir, 'accidenttiles/hannover/13/4300/2680.json.gz')).features)
      .toHaveLength(1);

    const rawJsonFiles = [];
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(absolute);
        else if (/\.json$|\.geojson$/.test(entry.name)
          && entry.name !== 'data-manifest.json') rawJsonFiles.push(absolute);
      }
    };
    walk(outputDir);
    expect(rawJsonFiles).toEqual([]);
  });
});
