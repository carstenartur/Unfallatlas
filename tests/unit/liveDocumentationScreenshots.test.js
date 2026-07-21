'use strict';

const fs = require('fs');
const path = require('path');

const { buildLiveSpec, replaceOnce } = require('../../scripts/run-live-documentation-screenshots.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SCREENSHOT_SPEC = path.join(ROOT, 'tests/e2e/screenshots.spec.js');

describe('live documentation screenshot boundary', () => {
  test('uses real cartographic responses for publishable screenshots only', () => {
    const source = fs.readFileSync(SCREENSHOT_SPEC, 'utf8');
    const transformed = buildLiveSpec(source);
    const documentationSection = transformed.slice(
      transformed.indexOf("test.describe('Werkbank V2 – Dokumentations-Screenshots'"),
      transformed.indexOf("test.describe('Werkbank V2 – PDF-Export Rendering'")
    );
    const pdfSection = transformed.slice(
      transformed.indexOf("test.describe('Werkbank V2 – PDF-Export Rendering'")
    );

    expect(documentationSection).toContain('await setupLiveBasemapTiles(page, {');
    expect(documentationSection).not.toContain('await setupDeterministicBasemapTiles(page, {');
    expect(pdfSection).toContain('await setupDeterministicBasemapTiles(page);');

    expect(transformed).toContain("return ['orthophoto', 'labels'];");
    expect(transformed).toContain("return ['orthophoto'];");
    expect(transformed).toContain("return ['standard'];");
    expect(transformed).toContain('await route.continue();');
    expect(transformed).toMatch(/response\.status\(\) >= 200[\s\S]*image\\\/\(\?:png\|jpe\?g\|webp\)/);
    expect(transformed).toContain('Documentation screenshot lacks successful real basemap responses for:');
  });

  test('keeps deterministic accident-service fixtures while refusing unknown external input', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));

    expect(transformed).toContain('DETERMINISTIC_EXTERNAL_DATA.nominatim[nominatimFixture]');
    expect(transformed).toContain('DETERMINISTIC_EXTERNAL_DATA.overpass[overpassFixture]');
    expect(transformed).toContain("await route.abort('blockedbyclient');");
    expect(transformed).not.toContain("contentType: 'image/svg+xml', body: DETERMINISTIC_MAP_TILES.orthophoto\n      });\n      return;\n    }\n    if (nominatimFixture)");
  });

  test('fails closed when the canonical screenshot spec drifts', () => {
    expect(() => buildLiveSpec('const unrelated = true;')).toThrow('Missing transform anchor');
    expect(() => replaceOnce('x x', 'x', 'y', 'duplicate')).toThrow('Ambiguous transform anchor');
  });
});
