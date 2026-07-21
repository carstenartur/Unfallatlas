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

function classifyLiveBasemapUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname)) return 'standard';
  if (/(^|\.)basemaps\.cartocdn\.com$/i.test(url.hostname) &&
      url.pathname.startsWith('/light_only_labels/')) return 'labels';
  if ((url.hostname === 'www.bonn.de' &&
       url.pathname.startsWith('/stadtplan-wms/services/orthofoto/MapServer/WMSServer')) ||
      (url.hostname === 'www.wms.nrw.de' && url.pathname.startsWith('/geobasis/wms_nw_dop')) ||
      (url.hostname === 'opendata.lgln.niedersachsen.de' &&
       url.pathname.startsWith('/doorman/noauth/dop_wms')) ||
      (url.hostname === 'sg.geodatenzentrum.de' && url.pathname.startsWith('/wms_dop20')) ||
      (url.hostname === 'server.arcgisonline.com' &&
       url.pathname.startsWith('/ArcGIS/rest/services/World_Imagery/MapServer/tile/'))) {
    return 'orthophoto';
  }
  return null;
}

function requiredLiveBasemapKinds(testTitle) {
  if (testTitle.startsWith('23 ')) return ['orthophoto', 'labels'];
  if (testTitle.startsWith('22 ') || testTitle.startsWith('24 ')) return ['orthophoto'];
  return ['standard'];
}

function assertLiveBasemapProvenance(page) {
  const live = LIVE_BASEMAP_PROVENANCE.get(page);
  if (!live) throw new Error('Documentation screenshot has no live basemap provenance context');
  const missingKinds = live.requiredKinds.filter(
    kind => !live.successfulResponses.some(response => response.kind === kind)
  );
  if (missingKinds.length > 0) {
    throw new Error(\`Documentation screenshot lacks successful real basemap responses for: \${missingKinds.join(', ')}\n\` +
      \`Observed real basemap responses: \${JSON.stringify(live.successfulResponses, null, 2)}\`);
  }
  return live;
}

async function setupLiveBasemapTiles(page, options = {}) {
  const { orthophotoAvailable = true, requiredKinds = ['standard'] } = options;
  const unexpectedExternalRequests = [];
  const successfulResponses = [];
  UNEXPECTED_EXTERNAL_REQUESTS.set(page, unexpectedExternalRequests);
  LIVE_BASEMAP_PROVENANCE.set(page, { requiredKinds, successfulResponses });

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

  await page.route(/^https:\/\//, async route => {
    const request = route.request();
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
  const live = assertLiveBasemapProvenance(page);
  const basename = options.path.split('/').pop().replace(/\.png$/i, '');
  const evidencePath = resolve(process.cwd(), 'out/qa/screenshot-readiness', basename + '.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  evidence.cartography = {
    source: 'live',
    requiredKinds: live.requiredKinds.slice(),
    successfulResponses: live.successfulResponses.map(response => ({ ...response }))
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
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
    'function assertNoUnexpectedExternalRequests(page) {\n  if (LIVE_BASEMAP_PROVENANCE.has(page)) assertLiveBasemapProvenance(page);\n',
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
