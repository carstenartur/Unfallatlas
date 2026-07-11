'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { main } = require('../../scripts/validate-static-data');

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
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'output_all_years_hannover.geojson.gz'), 'x');
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

    expect(() => main(['--dir', outDir, '--gzip-only', '--require-city', 'hannover'])).not.toThrow();
  });
});
