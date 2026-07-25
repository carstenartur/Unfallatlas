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
    expect(transformed).toContain('visibleTiles: live && live.visibleTiles');
    expect(transformed).toContain('observedTiles: live && live.observedTiles');
    expect(transformed).toContain('successfulResponses: live && live.successfulResponses');
  });

  test('does not use network-idle as the readiness contract for live map pages', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));
    const loadPageStart = transformed.indexOf("async function loadPage(page, params = '') {");
    const loadPageEnd = transformed.indexOf('\n}\n\n/** Hilfsfunktion: Warten bis Städte geladen sind', loadPageStart) + 2;
    const liveLoadPage = transformed.slice(loadPageStart, loadPageEnd);

    expect(loadPageStart).toBeGreaterThanOrEqual(0);
    expect(loadPageEnd).toBeGreaterThan(loadPageStart);
    expect(liveLoadPage).toContain("waitUntil: 'domcontentloaded'");
    expect(liveLoadPage).not.toContain("waitForLoadState('networkidle')");
  });

  test('bounds live tile requests and advances the application fallback chain on provider stalls', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));

    expect(transformed).toContain('const LIVE_TILE_REQUEST_TIMEOUT_MS = 8000;');
    expect(transformed).toContain('const LIVE_TILE_PROVENANCE_TIMEOUT_MS = 30000;');
    expect(transformed).toContain('const response = await route.fetch({');
    expect(transformed).toContain('timeout: LIVE_TILE_REQUEST_TIMEOUT_MS');
    expect(transformed).toContain('maxRetries: 1');
    expect(transformed).toContain('await route.fulfill({ response });');
    expect(transformed).toContain('status: 504');
    expect(transformed).toContain('await proxyLiveBasemapRequest(route, basemapKind);');
  });

  test('waits for decoded live tiles before and after taking the screenshot', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));
    const captureStart = transformed.indexOf('async function captureDataScreenshot(page, options) {');
    const captureEnd = transformed.indexOf('\n}\n', captureStart) + 3;
    const captureFunction = transformed.slice(captureStart, captureEnd);
    const firstProvenanceCheck = captureFunction.indexOf('live = await assertLiveBasemapProvenance(page);');
    const baseCapture = captureFunction.indexOf('const snapshot = await baseCaptureDataScreenshot(page, options);');
    const secondProvenanceCheck = captureFunction.indexOf(
      'live = await assertLiveBasemapProvenance(page, { timeoutMs: 1000 });'
    );

    expect(firstProvenanceCheck).toBeGreaterThanOrEqual(0);
    expect(baseCapture).toBeGreaterThan(firstProvenanceCheck);
    expect(secondProvenanceCheck).toBeGreaterThan(baseCapture);
    expect(transformed).toContain('await page.waitForTimeout(250);');
  });

  test('binds successful responses to currently visible decoded Leaflet images in all map panes', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));

    expect(transformed).toContain("page.locator('.leaflet-map-pane img.leaflet-tile')");
    expect(transformed).not.toContain("page.locator('.leaflet-tile-pane img')");
    expect(transformed).not.toContain("page.locator('.leaflet-tile-pane img.leaflet-tile-loaded')");
    expect(transformed).toContain('image.complete === true');
    expect(transformed).toContain('naturalWidth: Number(image.naturalWidth) || 0');
    expect(transformed).toContain('naturalHeight: Number(image.naturalHeight) || 0');
    expect(transformed).toContain('image.getBoundingClientRect()');
    expect(transformed).toContain('style.visibility');
    expect(transformed).toContain('successfulUrls.has(tile.url)');
    expect(transformed).toContain('live.visibleTiles = observed.visibleTiles;');
    expect(transformed).toContain('live.observedTiles = observed.observedTiles;');
    expect(transformed).toContain('await assertLiveBasemapProvenance(page)');
    expect(transformed).toContain('async function assertNoUnexpectedExternalRequests(page)');
  });

  test('retains cartography diagnostics before rejecting an invalid candidate', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));

    expect(transformed).toContain('let assertionError = null;');
    expect(transformed).toContain('assertionError = error;');
    expect(transformed).toContain('valid: assertionError == null');
    expect(transformed).toContain('error: assertionError && assertionError.message || null');
    expect(transformed).toContain('if (assertionError) throw assertionError;');
  });

  test('intercepts HTTP and HTTPS while allowing only the exact first-party origin and HTTPS tile paths', () => {
    const transformed = buildLiveSpec(fs.readFileSync(SCREENSHOT_SPEC, 'utf8'));
    const liveClassifier = transformed.slice(
      transformed.indexOf('function classifyLiveBasemapUrl(rawUrl) {'),
      transformed.indexOf('function requiredLiveBasemapKinds(testTitle) {')
    );

    expect(transformed).toContain(
      "const LIVE_APPLICATION_ORIGIN = new URL(process.env.BASE_URL || 'http://localhost:8000').origin;"
    );
    expect(transformed).toContain('await page.route(/^https?:\\/\\//');
    expect(transformed).toContain('const requestUrl = new URL(request.url());');
    expect(transformed).toContain('if (requestUrl.origin === LIVE_APPLICATION_ORIGIN) {');
    expect(liveClassifier).toContain("if (url.protocol !== 'https:') return null;");
    expect(liveClassifier).toContain('/^\\/\\d+\\/\\d+\\/\\d+\\.png$/');
    expect(liveClassifier).toContain('/^\\/light_only_labels\\/\\d+\\/\\d+\\/\\d+(?:@2x)?\\.png$/');
    expect(liveClassifier).not.toContain("url.pathname.startsWith('/light_only_labels/')");
    expect(liveClassifier).not.toContain("if (/(^|\\.)tile\\.openstreetmap\\.org$/i.test(url.hostname)) return 'standard';");
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
