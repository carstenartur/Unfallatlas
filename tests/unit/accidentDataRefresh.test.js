'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  parseArgs,
  shouldRegenerateCity,
} = require('../../scripts/generate-accident-data');

const ROOT = path.resolve(__dirname, '../..');

describe('manual accident data refresh', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-accident-refresh-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('parses an explicit forced refresh', () => {
    const args = parseArgs([
      '--root', tempRoot,
      '--cities-file', 'cities.txt',
      '--out-dir', 'out',
      '--temp-root', '.build/raw',
      '--min-features', '10',
      '--force',
    ]);

    expect(args.force).toBe(true);
    expect(args.minFeatures).toBe(10);
    expect(args.outDir).toBe(path.join(tempRoot, 'out'));
  });

  test('repair mode skips a valid existing artifact but force mode never does', () => {
    const outDir = path.join(tempRoot, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const fixture = {
      type: 'FeatureCollection',
      features: Array.from({ length: 10 }, (_, index) => ({
        type: 'Feature',
        properties: { index },
        geometry: null,
      })),
    };
    fs.writeFileSync(
      path.join(outDir, 'output_all_years_bonn.geojson.gz'),
      zlib.gzipSync(Buffer.from(JSON.stringify(fixture)))
    );

    expect(shouldRegenerateCity(outDir, 'Bonn', 10, false)).toBe(false);
    expect(shouldRegenerateCity(outDir, 'Bonn', 10, true)).toBe(true);
  });

  test('the Actions form defaults to a real forced download', () => {
    const workflow = fs.readFileSync(
      path.join(ROOT, '.github', 'workflows', 'generate-and-commit.yml'),
      'utf8'
    );

    expect(workflow).toMatch(/force:\s*\n\s+description:/);
    expect(workflow).toMatch(/type:\s*boolean/);
    expect(workflow).toMatch(/default:\s*true/);
    expect(workflow).toContain('ARGS+=(--force)');
    expect(workflow).toContain('all configured cities will be downloaded and regenerated');
  });
});
