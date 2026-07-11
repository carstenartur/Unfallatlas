'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const { main } = require('../../scripts/build-static-data');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ua-build-static-'));
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

  test('builds gzip-only artefacts and writes data-manifest.json', () => {
    const inputDir = path.join(root, '.build/enriched');
    const poiDir = path.join(root, 'out');
    const outputDir = path.join(root, '_site/out');

    fs.mkdirSync(path.join(inputDir, 'ctxtiles/hannover/10'), { recursive: true });
    fs.mkdirSync(poiDir, { recursive: true });

    fs.writeFileSync(
      path.join(inputDir, 'output_all_years_hannover.geojson'),
      JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [9, 52] }, properties: { id: '1' } }] })
    );
    fs.writeFileSync(path.join(inputDir, 'ways_hannover.json'), JSON.stringify({ schemaVersion: 2, ways: {} }));
    fs.writeFileSync(path.join(inputDir, 'output_all_years_hannover.enrichment.meta.json'), JSON.stringify({ counts: { withElevation: 1, withTrafficProxy: 1, contextTiles: 1 }, slope: { withSlope: 1 } }));
    fs.writeFileSync(path.join(inputDir, 'ctxtiles/hannover/index.json'), JSON.stringify({ schemaVersion: 3, tiles: [{ x: 10, y: 10 }] }));
    fs.writeFileSync(path.join(inputDir, 'ctxtiles/hannover/10/10.json'), JSON.stringify({ schemaVersion: 3, ways: {}, geometries: {} }));
    fs.writeFileSync(path.join(poiDir, 'poi_hannover.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));

    main([
      '--root', root,
      '--input-dir', '.build/enriched',
      '--poi-dir', 'out',
      '--output-dir', '_site/out',
      '--gzip-only',
      '--manifest', '_site/out/data-manifest.json',
    ]);

    expect(fs.existsSync(path.join(outputDir, 'output_all_years_hannover.geojson.gz'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'ways_hannover.json.gz'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'poi_hannover.geojson.gz'))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, 'data-manifest.json'))).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'data-manifest.json'), 'utf8'));
    expect(manifest.dataMode).toBe('gzip-only');
    expect(manifest.cities.hannover.accidents.gzipPath).toBe('out/output_all_years_hannover.geojson.gz');
    expect(manifest.cities.hannover.enrichment.hasElevation).toBe(true);

    const unzipped = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(outputDir, 'output_all_years_hannover.geojson.gz'))).toString('utf8'));
    expect(unzipped.features).toHaveLength(1);
  });
});
