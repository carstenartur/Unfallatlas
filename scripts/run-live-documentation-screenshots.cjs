'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'tests/e2e/screenshots.spec.js');
const GENERATED = path.join(ROOT, 'tests/e2e/screenshots.live.generated.spec.js');

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`[live-screenshots] Missing transform anchor: ${label}`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`[live-screenshots] Ambiguous transform anchor: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function buildLiveSpec(source) {
  const provenanceSupport = String.raw`
const LIVE_BASEMAP_PROVENANCE = new WeakMap();
const LIVE_APPLICATION_ORIGIN = new URL(process.env.BASE_URL || 'http://localhost:8000').origin;

function classifyLiveBasemapUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') return null;
  if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname) &&
      /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname)) return 'standard';
  if (/(^|\.)basemaps\.cartocdn\.com$/i.test(url.hostname) &&
      /^\/light_only_labels\/\d+\/\d+\/\d+(?:@2x)?\.png$/.test(url.pathname)) return 'labels';
  if ((url.hostname === 'www.bonn.de' &&
       url.pathname === '/stadtplan-wms/services/orthofoto/MapServer/WMSServer') ||
      (url.hostname === 'www.wms.nrw.de' && url.pathname === '/geobasis/wms_nw_dop') ||
      (url.hostname === 'opendata.lgln.niedersachsen.de' &&
       url.pathname === '/doorman/noauth/dop_wms') ||
      (url.hostname === 'sg.geodatenzentrum.de' && url.pathname === '/wms_dop20') ||
      (url.hostname === 'server.arcgisonline.com' &&
       /^\/ArcGIS\/rest\/services\/World_Imagery\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(url.pathname))) {
    return 'orthophoto';
  }
  return null;
}

function requiredLiveBasemapKinds(testTitle) {
  if (testTitle.startsWith('23 ')) return ['orthophoto', 'labels'];
  if (testTitle.startsWith('22 ') || testTitle.startsWith('24 ')) return ['orthophoto'];
  return ['standard'];
}

async function readVisibleLiveBasemapTiles(page) {
  const observedTiles = await page.locator('.leaflet-map-pane img.leaflet-tile').evaluateAll(images => images.map(image => {
    const rect = image.getBoundingClientRect();
    const style = getComputedStyle(image);
    return {
      url: image.currentSrc || image.src || '',
      complete: image.complete === true,
      naturalWidth: Number(image.naturalWidth) || 0,
      naturalHeight: Number(image.naturalHeight) || 0,
      rectWidth: rect.width,
      rectHeight: rect.height,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity || '1'),
      className: image.className || ''
    };
  }));
  const seen = new Set();
  const visibleTiles = [];
  for (const observation of observedTiles) {
    if (!observation.url || observation.complete !== true ||
        observation.naturalWidth <= 0 || observation.naturalHeight <= 0 ||
        observation.rectWidth <= 0 || observation.rectHeight <= 0 ||
        observation.display === 'none' || observation.visibility === 'hidden' ||
        observation.opacity <= 0) continue;
    const url = new URL(observation.url).href;
    const kind = classifyLiveBasemapUrl(url);
    if (!kind || seen.has(url)) continue;
    seen.add(url);
    visibleTiles.push({ kind, url });
  }
  return { visibleTiles, observedTiles };
}

async function assertLiveBasemapProvenance(page) {
  const live = LIVE_BASEMAP_PROVENANCE.get(page);
  if (!live) throw new Error('Documentation screenshot has no live basemap provenance context');
  const observed = await readVisibleLiveBasemapTiles(page);
  live.visibleTiles = observed.visibleTiles;
  live.observedTiles = observed.observedTiles;
  const successfulUrls = new Set(live.successfulResponses.map(response => new URL(response.url).href));
  const missingKinds = live.requiredKinds.filter(kind => !live.visibleTiles.some(tile =>
    tile.kind === kind && successfulUrls.has(tile.url)
  ));
  if (missingKinds.length > 0) {
    throw new Error(
      'Documentation screenshot lacks visible successful real basemap tiles for: ' +
      missingKinds.join(', ') + String.fromCharCode(10) +
      'Visible real basemap tiles: ' + JSON.stringify(live.visibleTiles, null, 2) + String.fromCharCode(10) +
      'Observed Leaflet tile images: ' + JSON.stringify(live.observedTiles, null, 2) + String.fromCharCode(10) +
      'Observed successful real basemap responses: ' + JSON.stringify(live.successfulResponses, null, 2)
    );
  }
  return live;
}

async function setupLiveBasemapTiles(page, options = {}) {
  const { orthophotoAvailable = true, requiredKinds = ['standard'] } = options;
  const unexpectedExternalRequests = [];
  const successfulResponses = [];
  UNEXPECTED_EXTERNAL_REQUESTS.set(page, unexpectedExternalRequests);
  LIVE_BASEMAP_PROVENANCE.set(page, {
    requiredKinds,
    successfulResponses,
    visibleTiles: [],
    observedTiles: []
  });

  page.on('response', response => {
    const kind = classifyLiveBasemapUrl(response.url());
    if (!kind) return;
    const contentType = String(response.headers()['content-type'] || '').toLowerCase();
    if (response.status() >= 200 && response.status() < 300 &&
        /^image\/(?:png|jpe?g|webp)(?:;|$)/.test(contentType)) {
      successfulResponses.push({
        kind,
        status: response.status(),
        contentType,
        url: response.url()
      });
    }
  });

  await page.route(/^https?:\/\//, async route => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (requestUrl.origin === LIVE_APPLICATION_ORIGIN) {
      await route.continue();
      return;
    }
    const basemapKind = classifyLiveBasemapUrl(request.url());
    const nominatimFixture = classifyNominatimFixture(request.url());
    const overpassFixture = classifyOverpassFixture(
      request.url(),
      request.postDataBuffer() || request.postData()
    );

    if (basemapKind === 'orthophoto' && !orthophotoAvailable) {
      await route.fulfill({
        status: 503,
        contentType: 'text/plain; charset=utf-8',
        body: 'Orthophoto unavailable'
      });
      return;
    }
    if (basemapKind) {
      await route.continue();
      return;
    }
    if (nominatimFixture) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: DETERMINISTIC_EXTERNAL_DATA.nominatim[nominatimFixture]
      });
      return;
    }
    if (overpassFixture) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: DETERMINISTIC_EXTERNAL_DATA.overpass[overpassFixture]
      });
      return;
    }

    const postData = request.postDataBuffer();
    const diagnosticBody = postData ? ' body=' + postData.toString('utf8').slice(0, 240) : '';
    unexpectedExternalRequests.push(
      request.method() + ' ' + request.resourceType() + ' ' + request.url() + diagnosticBody
    );
    await route.abort('blockedbyclient');
  });
}

async function captureDataScreenshot(page, options) {
  const snapshot = await baseCaptureDataScreenshot(page, options);
  let assertionError = null;
  let live;
  try {
    live = await assertLiveBasemapProvenance(page);
  } catch (error) {
    assertionError = error;
    live = LIVE_BASEMAP_PROVENANCE.get(page);
  }
  const basename = options.path.split('/').pop().replace(/\.png$/i, '');
  const evidencePath = resolve(process.cwd(), 'out/qa/screenshot-readiness', basename + '.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  evidence.cartography = {
    source: 'live',
    requiredKinds: live && live.requiredKinds ? live.requiredKinds.slice() : [],
    visibleTiles: live && live.visibleTiles ? live.visibleTiles.map(tile => ({ ...tile })) : [],
    observedTiles: live && live.observedTiles ? live.observedTiles.map(tile => ({ ...tile })) : [],
    successfulResponses: live && live.successfulResponses
      ? live.successfulResponses.map(response => ({ ...response }))
      : [],
    valid: assertionError == null,
    error: assertionError && assertionError.message || null
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + String.fromCharCode(10));
  if (assertionError) throw assertionError;
  return snapshot;
}
`;

  let transformed = replaceOnce(
    source,
    "import { readFileSync } from 'node:fs';",
    "import { readFileSync, writeFileSync } from 'node:fs';",
    'filesystem import'
  );
  transformed = replaceOnce(
    transformed,
    '  captureDataScreenshot,\n',
    '  captureDataScreenshot as baseCaptureDataScreenshot,\n',
    'capture helper alias'
  );
  transformed = replaceOnce(
    transformed,
    'const UNEXPECTED_EXTERNAL_REQUESTS = new WeakMap();\n',
    `const UNEXPECTED_EXTERNAL_REQUESTS = new WeakMap();\n${provenanceSupport}`,
    'network provenance insertion'
  );
  transformed = replaceOnce(
    transformed,
    "    await setupDeterministicBasemapTiles(page, {\n      orthophotoAvailable: !testInfo.title.startsWith('25 ')\n    });",
    "    await setupLiveBasemapTiles(page, {\n      orthophotoAvailable: !testInfo.title.startsWith('25 '),\n      requiredKinds: requiredLiveBasemapKinds(testInfo.title)\n    });",
    'documentation beforeEach'
  );
  transformed = replaceOnce(
    transformed,
    'function assertNoUnexpectedExternalRequests(page) {\n',
    'async function assertNoUnexpectedExternalRequests(page) {\n  if (LIVE_BASEMAP_PROVENANCE.has(page)) await assertLiveBasemapProvenance(page);\n',
    'live provenance assertion'
  );

  return transformed;
}

function run() {
  if (fs.existsSync(GENERATED)) {
    throw new Error(`[live-screenshots] Refusing to overwrite existing generated spec: ${path.relative(ROOT, GENERATED)}`);
  }
  const source = fs.readFileSync(SOURCE, 'utf8');
  const transformed = buildLiveSpec(source);
  fs.writeFileSync(GENERATED, transformed, { flag: 'wx' });

  try {
    const packageEntry = require.resolve('@playwright/test');
    const cli = path.join(path.dirname(packageEntry), 'cli.js');
    const result = spawnSync(
      process.execPath,
      [cli, 'test', path.relative(ROOT, GENERATED).replace(/\\/g, '/'), '--project=documentation-live'],
      { cwd: ROOT, stdio: 'inherit', env: process.env }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exitCode = result.status == null ? 1 : result.status;
  } finally {
    fs.rmSync(GENERATED, { force: true });
  }
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { buildLiveSpec, replaceOnce };
