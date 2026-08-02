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

function readWorkflow(name) {
  return fs.readFileSync(path.join(ROOT, '.github', 'workflows', name), 'utf8');
}

function expectManualForceDefault(workflow) {
  expect(workflow).toMatch(
    /workflow_dispatch:\s*\n\s+inputs:[\s\S]*?force:\s*\n[\s\S]*?type:\s*boolean[\s\S]*?default:\s*true/
  );
}

describe('manual data refresh semantics', () => {
  let tempRoot;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-accident-refresh-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  test('parses an explicit forced accident refresh', () => {
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

  test('accident repair mode skips a valid artifact but force mode never does', () => {
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

  test('repair mode regenerates a city when any requested official year is absent', () => {
    const outDir = path.join(tempRoot, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const fixture = {
      type: 'FeatureCollection',
      features: Array.from({ length: 10 }, (_, index) => ({
        type: 'Feature',
        properties: { year: 2024, index },
        geometry: null,
      })),
    };
    fs.writeFileSync(
      path.join(outDir, 'output_all_years_bonn.geojson.gz'),
      zlib.gzipSync(Buffer.from(JSON.stringify(fixture)))
    );

    expect(shouldRegenerateCity(outDir, 'Bonn', 10, false, [2024])).toBe(false);
    expect(shouldRegenerateCity(outDir, 'Bonn', 10, false, [2024, 2025])).toBe(true);
  });

  test('the accident Actions form defaults to a real forced download', () => {
    const workflow = readWorkflow('generate-and-commit.yml');
    expectManualForceDefault(workflow);
    expect(workflow).toContain('ARGS+=(--force)');
    expect(workflow).toContain('all configured cities will be downloaded and regenerated');
  });

  test('the POI Actions form defaults to fresh OSM downloads', () => {
    const workflow = readWorkflow('fetchpoi.yml');
    expectManualForceDefault(workflow);
    expect(workflow).toContain('FORCED REFRESH: every configured city will be downloaded from OSM again.');
    expect(workflow).toContain('rm -f "$OUTFILE" "${OUTFILE}.gz"');
    expect(workflow).toContain('"$POI_SCRIPT" "$CITY"');
  });

  test('the context Actions form defaults to rebuilding source data', () => {
    const workflow = readWorkflow('enrich.yml');
    expectManualForceDefault(workflow);
    expect(workflow).toContain("description: 'Vorhandene OSM-, Steigungs- und Verkehrsdaten neu abrufen und ersetzen'");
    expect(workflow).toContain("FORCE_CONTEXT: ${{ inputs.force == true");
    expect(workflow).toContain('-Dcontext.force="${FORCE_CONTEXT:-false}"');
  });
});
