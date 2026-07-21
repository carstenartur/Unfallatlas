'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildLiveSpec, replaceOnce } = require('../../scripts/run-live-documentation-screenshots.cjs');

const ROOT = path.resolve(__dirname, '../..');
const SCREENSHOT_SPEC = path.join(ROOT, 'tests/e2e/screenshots.spec.js');
const PLAYWRIGHT_CONFIG = path.join(ROOT, 'playwright.config.js');
const LIVE_RUNNER = path.join(ROOT, 'scripts/run-live-documentation-screenshots.cjs');

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
    expect(transformed).toContain('response.status() >= 200');
    expect(transformed).toContain('/^image\\/(?:png|jpe?g|webp)(?:;|$)/');
    expect(transformed).toContain('Documentation screenshot lacks visible successful real basemap tiles for:');
    expect(transformed).toContain("source: 'live'");
    expect(transformed).toContain('visibleTiles: live.visibleTiles.map');
    expect(transformed).toContain('successfulResponses: live.successfulResponses.map');
  });

  test('binds successful responses to currently visible Leaflet tiles', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));

    expect(transformed).toContain("page.locator('.leaflet-tile-pane img.leaflet-tile-loaded')");
    expect(transformed).toContain('image.getBoundingClientRect()');
    expect(transformed).toContain('style.visibility');
    expect(transformed).toContain('successfulUrls.has(tile.url)');
    expect(transformed).toContain('live.visibleTiles = visibleTiles;');
    expect(transformed).toContain('await assertLiveBasemapProvenance(page)');
    expect(transformed).toContain('async function assertNoUnexpectedExternalRequests(page)');
  });

  test('intercepts HTTP and HTTPS while allowing only the exact first-party origin and HTTPS tile paths', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));

    expect(transformed).toContain(
      "const LIVE_APPLICATION_ORIGIN = new URL(process.env.BASE_URL || 'http://localhost:8000').origin;"
    );
    expect(transformed).toContain('await page.route(/^https?:\\/\\//');
    expect(transformed).toContain('const requestUrl = new URL(request.url());');
    expect(transformed).toContain('if (requestUrl.origin === LIVE_APPLICATION_ORIGIN) {');
    expect(transformed).toContain("if (url.protocol !== 'https:') return null;");
    expect(transformed).toContain('/^\\/\\d+\\/\\d+\\/\\d+\\.png$/');
    expect(transformed).toContain('/^\\/light_only_labels\\/\\d+\\/\\d+\\/\\d+(?:@2x)?\\.png$/');
    expect(transformed).not.toContain("url.pathname.startsWith('/light_only_labels/')");
    expect(transformed).not.toContain("if (/(^|\\.)tile\\.openstreetmap\\.org$/i.test(url.hostname)) return 'standard';");
  });

  test('emits syntactically valid ESM', () => {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-live-spec-'));
    const generatedFile = path.join(temporaryRoot, 'screenshots.live.generated.spec.mjs');
    try {
      fs.writeFileSync(generatedFile, buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8')));
      const result = spawnSync(process.execPath, ['--check', generatedFile], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
    } finally {
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test('keeps deterministic accident-service fixtures while refusing unknown external input', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));

    expect(transformed).toContain('DETERMINISTIC_EXTERNAL_DATA.nominatim[nominatimFixture]');
    expect(transformed).toContain('DETERMINISTIC_EXTERNAL_DATA.overpass[overpassFixture]');
    expect(transformed).toContain("await route.abort('blockedbyclient');");
  });

  test('isolates generated live specs from the hermetic Chromium project', () => {
    const config = fs.readFileSync(PLAYWRIGHT_CONFIG, 'utf8');
    const runner = fs.readFileSync(LIVE_RUNNER, 'utf8');

    expect(config).toMatch(/name:\s*'chromium'[\s\S]*testIgnore:[\s\S]*screenshots\\\.live\\\.generated\\\.spec/);
    expect(config).toMatch(/name:\s*'documentation-live'[\s\S]*testMatch:\s*\/screenshots\\\.live\\\.generated\\\.spec\//);
    expect(runner).toContain("'--project=documentation-live'");
    expect(runner).not.toContain("'--project=chromium'");
  });

  test('fails closed when the canonical screenshot spec drifts', () => {
    expect(() => buildLiveSpec('const unrelated = true;')).toThrow('Missing transform anchor');
    expect(() => replaceOnce('x x', 'x', 'y', 'duplicate')).toThrow('Ambiguous transform anchor');
  });
});
