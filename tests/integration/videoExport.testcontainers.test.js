/**
 * Integration tests against a real Unfallwerkbank production container.
 *
 * The suite verifies both the video-export endpoint and the user-visible
 * context overlays. Browser assertions deliberately use DOM and canvas output;
 * private globals such as `window.map` are not part of the product contract.
 */
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const {
  isDockerAvailable,
  startUnfallatlasContainer,
} = require('./lib/startUnfallatlasContainer');
const videoExportContract = require('../../js/ua.video-export-contract.js');
const {
  VIDEO_EXPORT_CONTEXT_PARAMS,
} = require('../fixtures/videoExportContextFixture');

const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const GIF_BUDGET_BYTES = 10 * 1024 * 1024;
const WEBP_BUDGET_BYTES = 18 * 1024 * 1024;
const APNG_BUDGET_BYTES = 30 * 1024 * 1024;
const CONTEXT_BROWSER_TIMEOUT_MS = 120_000;
const REQUIRE_SHIPPED_CONTEXT = process.env.CONTEXT_E2E_REQUIRE_SHIPPED === '1' ||
  Boolean(process.env.UNFALLATLAS_IMAGE);

const CONTEXT_BODY = VIDEO_EXPORT_CONTEXT_PARAMS;
const EXPECTED_STATE = videoExportContract.fromLegacyParams(CONTEXT_BODY);
const EXPECTED_STATE_SHA256 = crypto.createHash('sha256')
  .update(videoExportContract.stableStringify(EXPECTED_STATE), 'utf8')
  .digest('hex');

function dockerLikelyAvailable() {
  if (process.env.RUN_TESTCONTAINERS === '1') return true;
  if (process.env.DOCKER_HOST) return true;
  try { return fs.existsSync('/var/run/docker.sock'); } catch (_) { return false; }
}

const SUITE_DESCRIBE = dockerLikelyAvailable() ? describe : describe.skip;
if (SUITE_DESCRIBE === describe.skip) {
  console.warn(
    '[videoExport.testcontainers] Skipping suite — no Docker socket and DOCKER_HOST unset. ' +
    'Set RUN_TESTCONTAINERS=1 to force.'
  );
}

async function postExportVideo(baseUrl, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const body = opts.body || { state: videoExportContract.fromLegacyParams(CONTEXT_BODY) };
  if (opts.bodyFormat !== undefined) body.format = opts.bodyFormat;
  const url = new URL(`${baseUrl}/api/export-video`);
  if (opts.queryFormat !== undefined) url.searchParams.set('format', opts.queryFormat);
  try {
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      headers: Object.fromEntries(response.headers.entries()),
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Playwright serializes this function into the browser context. Keep it closed
// over browser globals only; no eval or test-only product globals are needed.
function browserPaletteCounter() {
  const slopePalette = [
    [255,255,178], [254,204,92], [253,141,60],
    [240,59,32], [189,0,38], [154,169,184], [189,189,189],
  ];
  const trafficPalette = [
    [42,157,143], [39,125,161], [58,90,152], [27,27,94],
  ];
  const closeTo = (r, g, b, palette) => palette.some(([pr, pg, pb]) =>
    Math.abs(r - pr) <= 8 && Math.abs(g - pg) <= 8 && Math.abs(b - pb) <= 8
  );
  const counts = { canvases: 0, slopePixels: 0, trafficPixels: 0 };
  for (const canvas of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
    if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) continue;
    const style = getComputedStyle(canvas);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    let pixels;
    try {
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) continue;
      pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    } catch (_) {
      continue;
    }
    counts.canvases += 1;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 80) continue;
      const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
      if (closeTo(r, g, b, slopePalette)) counts.slopePixels += 1;
      if (closeTo(r, g, b, trafficPalette)) counts.trafficPixels += 1;
    }
  }
  return counts;
}

function browserAssertionScript(city) {
  const safeCity = JSON.stringify(city);
  const counterSource = browserPaletteCounter.toString();
  return `
    const { chromium } = require('@playwright/test');
    const countPalettePixels = ${counterSource};

    (async () => {
      const city = ${safeCity};
      const browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));

      const url = new URL('http://127.0.0.1:8000/werkbank_v2.html');
      url.searchParams.set('city', city);
      url.searchParams.set('mapLayer', 'slope,traffic');
      url.searchParams.set('showCluster', '0');
      url.searchParams.set('showHeatmap', '0');
      url.searchParams.set('showSchools', '0');
      url.searchParams.set('showKindergartens', '0');
      url.searchParams.set('showArgumentation', '0');
      if (city.toLowerCase() === 'bonn') {
        url.searchParams.set('centerLat', '50.731000');
        url.searchParams.set('centerLon', '7.102000');
        url.searchParams.set('zoom', '15');
      }

      const response = await page.goto(url.toString(), {
        waitUntil: 'domcontentloaded',
        timeout: ${CONTEXT_BROWSER_TIMEOUT_MS},
      });
      if (!response || !response.ok()) throw new Error('Werkbank HTML was not served successfully');

      await page.waitForFunction(() => {
        const slope = document.querySelector('input[data-context-overlay="slope"]');
        const traffic = document.querySelector('input[data-context-overlay="traffic"]');
        return slope && traffic && !slope.disabled && !traffic.disabled;
      }, null, { timeout: ${CONTEXT_BROWSER_TIMEOUT_MS} });

      const slope = page.locator('input[data-context-overlay="slope"]');
      const traffic = page.locator('input[data-context-overlay="traffic"]');
      if (!(await slope.isChecked())) await slope.check();
      if (!(await traffic.isChecked())) await traffic.check();

      const deadline = Date.now() + ${CONTEXT_BROWSER_TIMEOUT_MS};
      let result = null;
      while (Date.now() < deadline) {
        const counts = await page.evaluate(countPalettePixels);
        const legends = await page.locator('.context-road-legend:visible').allTextContents();
        result = {
          ...counts,
          legendCount: legends.length,
          legendText: legends.join(' ').replace(/\\s+/g, ' ').trim(),
        };
        if (result.slopePixels >= 20
            && result.trafficPixels >= 20
            && result.legendCount === 2
            && result.legendText.includes('Straßensteigung')
            && result.legendText.includes('Verkehrsbelastung')) {
          break;
        }
        await page.waitForTimeout(250);
      }

      result = result || { canvases: 0, slopePixels: 0, trafficPixels: 0, legendCount: 0, legendText: '' };
      result.city = city;
      result.pageErrors = pageErrors;
      console.log('CONTEXT_E2E_RESULT=' + JSON.stringify(result));
      await browser.close();

      const ok = result.canvases > 0
        && result.slopePixels >= 20
        && result.trafficPixels >= 20
        && result.legendCount === 2
        && result.legendText.includes('Straßensteigung')
        && result.legendText.includes('Verkehrsbelastung')
        && result.pageErrors.length === 0;
      if (!ok) {
        console.error('Visible context contract failed: ' + JSON.stringify(result));
        process.exit(2);
      }
    })().catch(error => {
      console.error(error && error.stack ? error.stack : String(error));
      process.exit(1);
    });
  `;
}

function parseBrowserResult(output) {
  const line = String(output || '').split(/\r?\n/)
    .find(entry => entry.startsWith('CONTEXT_E2E_RESULT='));
  return line ? JSON.parse(line.slice('CONTEXT_E2E_RESULT='.length)) : null;
}

SUITE_DESCRIBE('POST /api/export-video — testcontainers integration', () => {
  let handle = null;
  let buildManifest = null;

  beforeAll(async () => {
    const probe = await isDockerAvailable();
    if (!probe.available) {
      throw new Error(
        `Docker daemon present but unreachable: ${probe.reason}. ` +
        'Either start Docker or unset RUN_TESTCONTAINERS / DOCKER_HOST.'
      );
    }
    handle = await startUnfallatlasContainer({
      buildArgs: REQUIRE_SHIPPED_CONTEXT ? {} : { VIDEO_EXPORT_INTEGRATION_FIXTURE: '1' },
    });
    const manifestResponse = await fetch(`${handle.baseUrl}/build-manifest.json`);
    if (!manifestResponse.ok) {
      throw new Error(`Could not read container build manifest: HTTP ${manifestResponse.status}`);
    }
    buildManifest = await manifestResponse.json();
  }, 10 * 60 * 1000);

  afterAll(async () => {
    if (handle) await handle.stop();
  });

  it('serves the canonical site artifact without exposing repository metadata', async () => {
    expect(buildManifest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(buildManifest.data).toEqual(expect.objectContaining({
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    if (!REQUIRE_SHIPPED_CONTEXT) {
      expect(buildManifest.data.cities.bonn.accidents.features).toBe(12);
    }

    const packageResponse = await fetch(`${handle.baseUrl}/package.json`);
    expect(packageResponse.status).toBe(404);
  });

  test.each([
    { request: {}, label: 'default', expectedContentType: /^image\/gif/i, expectedExt: 'gif', budget: GIF_BUDGET_BYTES },
    { request: { bodyFormat: 'gif' }, label: 'body:gif', expectedContentType: /^image\/gif/i, expectedExt: 'gif', budget: GIF_BUDGET_BYTES },
    { request: { bodyFormat: 'webp' }, label: 'body:webp', expectedContentType: /^image\/webp/i, expectedExt: 'webp', budget: WEBP_BUDGET_BYTES },
    { request: { bodyFormat: 'apng' }, label: 'body:apng', expectedContentType: /^image\/apng/i, expectedExt: 'apng', budget: APNG_BUDGET_BYTES },
    { request: { queryFormat: 'webp' }, label: 'query:webp', expectedContentType: /^image\/webp/i, expectedExt: 'webp', budget: WEBP_BUDGET_BYTES },
  ])('returns valid $expectedExt export ($label)', async ({ request, expectedContentType, expectedExt, budget }) => {
    const { status, contentType, headers, body } = await postExportVideo(handle.baseUrl, request);
    expect(status).toBe(200);
    expect(contentType).toMatch(expectedContentType);
    expect(body.length).toBeGreaterThanOrEqual(50 * 1024);
    expect(body.length).toBeLessThanOrEqual(budget);
    expect(headers['x-unfallatlas-artifact-sha256']).toBe(
      crypto.createHash('sha256').update(body).digest('hex')
    );
    expect(headers['x-unfallatlas-video-state-sha256']).toBe(EXPECTED_STATE_SHA256);
    expect(headers['x-unfallatlas-build-fingerprint']).toBe(buildManifest.fingerprint);
    expect(headers['x-unfallatlas-data-fingerprint']).toBe(buildManifest.data.fingerprint);
    expect(headers['x-unfallatlas-evidence-sha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(headers['content-digest']).toMatch(/^sha-256=:[A-Za-z0-9+/]+=*:\s*$/);
    expect(headers.digest).toMatch(/^SHA-256=[A-Za-z0-9+/]+=*$/);
    for (const name of [
      'x-unfallatlas-encoded-frames',
      'x-unfallatlas-encoded-accident-pixels',
      'x-unfallatlas-encoded-slope-pixels',
      'x-unfallatlas-encoded-traffic-pixels',
    ]) {
      expect(Number(headers[name])).toBeGreaterThan(0);
    }
    for (const name of [
      'x-unfallatlas-loaded-accidents',
      'x-unfallatlas-filtered-accidents',
      'x-unfallatlas-viewport-accidents',
      'x-unfallatlas-preview-accidents',
    ]) {
      if (REQUIRE_SHIPPED_CONTEXT) expect(Number(headers[name])).toBeGreaterThan(0);
      else expect(Number(headers[name])).toBe(12);
    }
    expect(headers['x-unfallatlas-pdf-completed']).toBe('true');

    if (expectedExt === 'gif') {
      expect(['GIF87a', 'GIF89a']).toContain(body.slice(0, 6).toString('ascii'));
      expect(body[body.length - 1]).toBe(0x3b);
    } else if (expectedExt === 'webp') {
      expect(body.slice(0, 4).toString('ascii')).toBe('RIFF');
      expect(body.slice(8, 12).toString('ascii')).toBe('WEBP');
      expect(body.includes(Buffer.from('VP8X', 'ascii'))).toBe(true);
      expect(body.includes(Buffer.from('ANIM', 'ascii'))).toBe(true);
    } else if (expectedExt === 'apng') {
      const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      expect(body.subarray(0, 8).equals(pngSignature)).toBe(true);
      expect(body.includes(Buffer.from('acTL', 'ascii'))).toBe(true);
    }
  }, 6 * 60 * 1000);

  it('rejects unsupported export format', async () => {
    const { status, body } = await postExportVideo(handle.baseUrl, { bodyFormat: 'mp4' });
    const json = JSON.parse(body.toString('utf8'));
    expect(status).toBe(400);
    expect(json).toEqual(expect.objectContaining({ error: 'unsupported_format' }));
    expect(json.supportedFormats).toEqual(['gif', 'webp', 'apng']);
  }, 60 * 1000);

  it('rejects a partial canonical viewport with stable 400 before browser work', async () => {
    const state = videoExportContract.fromLegacyParams(CONTEXT_BODY);
    state.viewport = { center: { lat: 52.3759 }, zoom: 13 };
    const startedAt = Date.now();
    const { status, body } = await postExportVideo(handle.baseUrl, { body: { state } });
    const elapsedMs = Date.now() - startedAt;
    const json = JSON.parse(body.toString('utf8'));
    expect(status).toBe(400);
    expect(json).toEqual(expect.objectContaining({
      error: 'incomplete_view',
      category: 'invalid_request',
      path: 'state.viewport',
    }));
    expect(elapsedMs).toBeLessThan(5000);
  }, 30 * 1000);

  it('renders slope and traffic context visibly in the production container', async () => {
    const city = String(process.env.CONTEXT_E2E_CITY || 'Bonn').trim();
    const execution = await handle.container.exec(['node', '-e', browserAssertionScript(city)]);
    const result = parseBrowserResult(execution.output);
    if (execution.exitCode !== 0) {
      throw new Error(
        `Context browser assertion failed (exit=${execution.exitCode}, shipped=${REQUIRE_SHIPPED_CONTEXT}, city=${city}).\n` +
        execution.output
      );
    }

    expect(result).not.toBeNull();
    expect(result.city).toBe(city);
    expect(result.canvases).toBeGreaterThan(0);
    expect(result.slopePixels).toBeGreaterThanOrEqual(20);
    expect(result.trafficPixels).toBeGreaterThanOrEqual(20);
    expect(result.legendCount).toBe(2);
    expect(result.legendText).toMatch(/Straßensteigung/);
    expect(result.legendText).toMatch(/Verkehrsbelastung/);
    expect(result.pageErrors).toEqual([]);
  }, 3 * 60 * 1000);

  it('container logs stay free of export-video error marker', async () => {
    const logs = await handle.getLogs();
    expect(logs).not.toMatch(/\[export-video\] Fehler/);
  });
});
