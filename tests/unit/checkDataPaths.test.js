'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { validateDataPaths } = require('../../scripts/check-data-paths');

function writeArtifact(root, relPath, value, options) {
  const opts = options || {};
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (opts.gzip) {
    fs.writeFileSync(abs, zlib.gzipSync(Buffer.from(text, 'utf8')));
  } else {
    fs.writeFileSync(abs, text);
  }
}

function featureCollection(featureCount) {
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: featureCount }, (_, index) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [index, index] },
      properties: { id: index + 1 },
    })),
  };
}

describe('check-data-paths', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-check-data-paths-'));
    fs.writeFileSync(path.join(root, 'cities.txt'), 'Hannover\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('detects raw duplicate in gzip-only mode', () => {
    writeArtifact(root, 'out/output_all_years_hannover.geojson', featureCollection(3));
    writeArtifact(root, 'out/output_all_years_hannover.geojson.gz', featureCollection(3), { gzip: true });

    const result = validateDataPaths({
      repoRoot: root,
      dir: 'out',
      citiesFile: 'cities.txt',
      gzipOnly: true,
      minFeatures: 1,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors.join('\n')).toMatch(/Raw artefact exists in gzip-only mode/);
  });

  test('detects broken gzip/json payloads', () => {
    writeArtifact(root, 'out/output_all_years_hannover.geojson.gz', 'not-json', { gzip: true });

    const result = validateDataPaths({
      repoRoot: root,
      dir: 'out',
      citiesFile: 'cities.txt',
      gzipOnly: true,
      minFeatures: 1,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors.join('\n')).toMatch(/JSON parse error/);
  });

  test('detects too few features', () => {
    writeArtifact(root, 'out/output_all_years_hannover.geojson.gz', featureCollection(2), { gzip: true });

    const result = validateDataPaths({
      repoRoot: root,
      dir: 'out',
      citiesFile: 'cities.txt',
      gzipOnly: true,
      minFeatures: 10,
    });

    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].errors.join('\n')).toMatch(/below required minimum 10/);
  });

  test('passes for valid gzip-only artefacts for every city in cities.txt', () => {
    fs.writeFileSync(path.join(root, 'cities.txt'), 'Hannover\nBonn\n');
    writeArtifact(root, 'out/output_all_years_hannover.geojson.gz', featureCollection(10), { gzip: true });
    writeArtifact(root, 'out/output_all_years_bonn.geojson.gz', featureCollection(12), { gzip: true });

    const result = validateDataPaths({
      repoRoot: root,
      dir: 'out',
      citiesFile: 'cities.txt',
      gzipOnly: true,
      minFeatures: 10,
    });

    expect(result.failures).toHaveLength(0);
    expect(result.checkedCities).toBe(2);
  });
});
