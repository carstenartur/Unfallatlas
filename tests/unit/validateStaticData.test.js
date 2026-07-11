'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { parseArgs, validateStaticData } = require('../../scripts/validate-static-data');

function writeGzipJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8')));
}

describe('validate-static-data', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-validate-static-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('passes for gzip-only manifest + required city file', () => {
    const outDir = path.join(root, '_site/out');
    writeGzipJson(path.join(outDir, 'output_all_years_hannover.geojson.gz'), {
      type: 'FeatureCollection',
      features: [{ type: 'Feature' }],
    });
    fs.writeFileSync(
      path.join(outDir, 'data-manifest.json'),
      JSON.stringify({
        dataMode: 'gzip-only',
        cities: {
          hannover: {
            accidents: { gzipPath: 'out/output_all_years_hannover.geojson.gz' },
          },
        },
      })
    );

    const args = parseArgs(['--dir', outDir, '--gzip-only', '--require-city', 'hannover', '--min-features', '1']);
    expect(() => validateStaticData(args, { repoRoot: root })).not.toThrow();
  });

  test('can require all cities from a cities file', () => {
    const outDir = path.join(root, '_site/out');
    writeGzipJson(path.join(outDir, 'output_all_years_hannover.geojson.gz'), {
      type: 'FeatureCollection',
      features: [{ type: 'Feature' }, { type: 'Feature' }],
    });
    writeGzipJson(path.join(outDir, 'output_all_years_bonn.geojson.gz'), {
      type: 'FeatureCollection',
      features: [{ type: 'Feature' }, { type: 'Feature' }],
    });
    fs.writeFileSync(path.join(root, 'cities.txt'), 'Hannover\nBonn\n');
    fs.writeFileSync(
      path.join(outDir, 'data-manifest.json'),
      JSON.stringify({
        dataMode: 'gzip-only',
        cities: {
          hannover: {
            accidents: { gzipPath: 'out/output_all_years_hannover.geojson.gz' },
          },
          bonn: {
            accidents: { gzipPath: 'out/output_all_years_bonn.geojson.gz' },
          },
        },
      })
    );

    const args = parseArgs([
      '--dir', outDir,
      '--gzip-only',
      '--require-cities-file', 'cities.txt',
      '--min-features', '2',
    ]);

    const result = validateStaticData(args, { repoRoot: root });
    expect(result.cityCount).toBe(2);
  });

  test('fails when required cities file includes a city missing from the manifest', () => {
    const outDir = path.join(root, '_site/out');
    writeGzipJson(path.join(outDir, 'output_all_years_hannover.geojson.gz'), {
      type: 'FeatureCollection',
      features: [{ type: 'Feature' }],
    });
    fs.writeFileSync(path.join(root, 'cities.txt'), 'Hannover\nBonn\n');
    fs.writeFileSync(
      path.join(outDir, 'data-manifest.json'),
      JSON.stringify({
        dataMode: 'gzip-only',
        cities: {
          hannover: {
            accidents: { gzipPath: 'out/output_all_years_hannover.geojson.gz' },
          },
        },
      })
    );

    const args = parseArgs(['--dir', outDir, '--gzip-only', '--require-cities-file', 'cities.txt']);
    expect(() => validateStaticData(args, { repoRoot: root })).toThrow(/Missing accidents gzip entry/);
  });
});
