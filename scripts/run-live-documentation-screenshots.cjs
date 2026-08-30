'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'tests/e2e/screenshots.spec.js');
const GENERATED = path.join(ROOT, 'tests/e2e/screenshots.live.generated.spec.js');

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) {
    if (
      label === 'live page readiness' &&
      source.includes("  await page.goto('/werkbank_v2.html' + params, { waitUntil: 'domcontentloaded' });")
    ) return source;
    throw new Error(`[live-screenshots] Missing transform anchor: ${label}`);
  }
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`[live-screenshots] Ambiguous transform anchor: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function buildLiveSpec(source) {
  const provenanceSupport = String.raw`
const LIVE_BASEMAP_PROVENANCE = new WeakMap();
const LIVE_APPLICATION_ORIGIN = new URL(process.env.BASE_URL || 'http://localhost:8000').origin;
const LIVE_TILE_REQUEST_TIMEOUT_MS = 8000;
const LIVE_TILE_PROVENANCE_TIMEOUT_MS = 30000;
const LIVE_TILE_STABLE_SAMPLES = 3;
const LIVE_TILE_SAMPLE_INTERVAL_MS = 250;
const LIVE_TILE_COVERAGE_STEP_PX = 32;
const LIVE_SCREENSHOT_CAPTURE_ATTEMPTS = 3;

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

function roundedTileMetric(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function sampleCoverageAxis(start, end) {
  const span = end - start;
  if (!(span > 0)) return [];
  const values = [start + Math.min(1, span / 2)];
  for (let value = start + LIVE_TILE_COVERAGE_STEP_PX / 2;
       value < end;
       value += LIVE_TILE_COVERAGE_STEP_PX) {
    values.push(value);
  }
  values.push(end - Math.min(1, span / 2));
  return [...new Set(values.map(roundedTileMetric))].sort((left, right) => left - right);
}

function coverageForKind(kind, mapRect, readyTiles, invalidTiles) {
  const candidates = readyTiles.filter(tile => tile.kind === kind);
  const invalid = invalidTiles.filter(tile => tile.kind === kind);
  const xSamples = mapRect ? sampleCoverageAxis(mapRect.left, mapRect.right) : [];
  const ySamples = mapRect ? sampleCoverageAxis(mapRect.top, mapRect.bottom) : [];
  const uncovered = [];
  let uncoveredCount = 0;
  const tolerance = 1.5;
  for (const y of ySamples) {
    for (const x of xSamples) {
      const covered = candidates.some(tile =>
        x >= tile.left - tolerance && x <= tile.right + tolerance &&
        y >= tile.top - tolerance && y <= tile.bottom + tolerance
      );
      if (covered) continue;
      uncoveredCount += 1;
      if (uncovered.length < 24) uncovered.push({ x, y });
    }
  }
  return {
    kind,
    complete: candidates.length > 0 && invalid.length === 0 &&
      xSamples.length > 0 && ySamples.length > 0 && uncoveredCount === 0,
    readyTiles: candidates.length,
    invalidTiles: invalid.length,
    samplePoints: xSamples.length * ySamples.length,
    uncoveredCount,
    uncovered
  };
}

function liveTileSignature(mapRect, readyTiles) {
  const tiles = readyTiles.map(tile => ({
    kind: tile.kind,
    url: tile.url,
    layerKey: tile.layerKey,
    left: roundedTileMetric(tile.left - mapRect.left),
    top: roundedTileMetric(tile.top - mapRect.top),
    width: roundedTileMetric(tile.rectWidth),
    height: roundedTileMetric(tile.rectHeight)
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    mapWidth: roundedTileMetric(mapRect.width),
    mapHeight: roundedTileMetric(mapRect.height),
    tiles
  });
}

async function readVisibleLiveBasemapTiles(page) {
  const observed = await page.locator('.leaflet-map-pane img.leaflet-tile').evaluateAll(images => {
    const mapElement = document.querySelector('.leaflet-container');
    const rawMapRect = mapElement && mapElement.getBoundingClientRect();
    const viewportWidth = Number(window.innerWidth) || document.documentElement.clientWidth || 0;
    const viewportHeight = Number(window.innerHeight) || document.documentElement.clientHeight || 0;
    const left = rawMapRect ? Math.max(0, rawMapRect.left) : 0;
    const top = rawMapRect ? Math.max(0, rawMapRect.top) : 0;
    const right = rawMapRect ? Math.min(viewportWidth, rawMapRect.right) : 0;
    const bottom = rawMapRect ? Math.min(viewportHeight, rawMapRect.bottom) : 0;
    const mapRect = rawMapRect && right > left && bottom > top
      ? { left, top, right, bottom, width: right - left, height: bottom - top }
      : null;
    const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
      ? window.UA.getRuntimeContext()
      : null;
    const map = window._uaMap || ctx && ctx.map;
    const draggable = map && map.dragging && map.dragging._draggable;
    const animationState = {
      zoom: Boolean(
        map && map._animatingZoom ||
        mapElement && mapElement.classList.contains('leaflet-zoom-anim')
      ),
      pan: Boolean(map && map._panAnim && map._panAnim._inProgress),
      drag: Boolean(draggable && draggable._moving)
    };
    animationState.active = animationState.zoom || animationState.pan || animationState.drag;
    const layerElements = [...document.querySelectorAll('.leaflet-map-pane .leaflet-layer')];

    const visualState = element => {
      let opacity = 1;
      let current = element;
      while (current && current.nodeType === 1) {
        const style = getComputedStyle(current);
        if (style.display === 'none' || style.visibility === 'hidden') {
          return { visible: false, opacity: 0 };
        }
        const ownOpacity = Number.parseFloat(style.opacity);
        if (Number.isFinite(ownOpacity)) opacity *= ownOpacity;
        if (current === mapElement) break;
        current = current.parentElement;
      }
      return { visible: opacity > 0.01, opacity };
    };

    const observedTiles = images.map(image => {
      const rect = image.getBoundingClientRect();
      const visual = visualState(image);
      const className = String(image.className || '');
      const layer = image.closest('.leaflet-layer');
      const pane = image.closest('.leaflet-pane');
      const intersectsMap = Boolean(mapRect &&
        rect.right > mapRect.left + 0.5 && rect.left < mapRect.right - 0.5 &&
        rect.bottom > mapRect.top + 0.5 && rect.top < mapRect.bottom - 0.5);
      return {
        url: image.currentSrc || image.src || '',
        complete: image.complete === true,
        naturalWidth: Number(image.naturalWidth) || 0,
        naturalHeight: Number(image.naturalHeight) || 0,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        rectWidth: rect.width,
        rectHeight: rect.height,
        display: getComputedStyle(image).display,
        visibility: getComputedStyle(image).visibility,
        opacity: visual.opacity,
        effectivelyVisible: visual.visible,
        intersectsMap,
        loading: /\bleaflet-tile-loading\b/.test(className),
        error: /\bleaflet-tile-error\b/.test(className),
        className,
        layerKey: layer
          ? 'layer-' + layerElements.indexOf(layer)
          : 'pane-' + String(pane && pane.className || 'unknown')
      };
    });
    return { mapRect, animationState, observedTiles };
  });

  const live = LIVE_BASEMAP_PROVENANCE.get(page);
  const successfulUrls = new Set((live && live.successfulResponses || []).map(response =>
    new URL(response.url).href
  ));
  const requiredKinds = live && Array.isArray(live.requiredKinds) ? live.requiredKinds : [];
  const normalized = observed.observedTiles.map(tile => {
    let url = '';
    let kind = null;
    try {
      url = new URL(tile.url).href;
      kind = classifyLiveBasemapUrl(url);
    } catch (_) {
      url = String(tile.url || '');
    }
    const required = Boolean(kind && requiredKinds.includes(kind));
    const visible = required && tile.effectivelyVisible && tile.intersectsMap;
    const decoded = tile.complete === true && tile.naturalWidth > 0 && tile.naturalHeight > 0;
    const successful = Boolean(url && successfulUrls.has(url));
    return {
      ...tile,
      kind,
      url,
      required,
      visible,
      decoded,
      successful,
      ready: visible && decoded && successful && !tile.loading && !tile.error &&
        tile.rectWidth > 0 && tile.rectHeight > 0
    };
  });
  const visibleRequiredTiles = normalized.filter(tile => tile.visible);
  const readyTiles = visibleRequiredTiles.filter(tile => tile.ready);
  const invalidTiles = visibleRequiredTiles.filter(tile => !tile.ready);
  const coverageByKind = Object.fromEntries(requiredKinds.map(kind => [
    kind,
    coverageForKind(kind, observed.mapRect, readyTiles, invalidTiles)
  ]));
  const missingKinds = requiredKinds.filter(kind => !coverageByKind[kind].complete);
  const tileSignature = observed.mapRect && readyTiles.length > 0
    ? liveTileSignature(observed.mapRect, readyTiles)
    : null;
  return {
    mapRect: observed.mapRect,
    animationState: observed.animationState,
    visibleTiles: readyTiles,
    observedTiles: normalized,
    invalidTiles,
    coverageByKind,
    missingKinds,
    tileSignature,
    ready: Boolean(
      observed.mapRect &&
      !observed.animationState.active &&
      missingKinds.length === 0 &&
      tileSignature
    )
  };
}

function missingLiveBasemapKinds(live) {
  return live.requiredKinds.filter(kind =>
    !live.coverageByKind || !live.coverageByKind[kind] ||
    live.coverageByKind[kind].complete !== true
  );
}

async function assertLiveBasemapProvenance(page, options = {}) {
  const live = LIVE_BASEMAP_PROVENANCE.get(page);
  if (!live) throw new Error('Documentation screenshot has no live basemap provenance context');
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, Number(options.timeoutMs))
    : LIVE_TILE_PROVENANCE_TIMEOUT_MS;
  const requiredStableSamples = Number.isFinite(options.stableSamples)
    ? Math.max(1, Math.floor(Number(options.stableSamples)))
    : LIVE_TILE_STABLE_SAMPLES;
  const expectedSignature = options.expectedSignature == null
    ? null
    : String(options.expectedSignature);
  const deadline = Date.now() + timeoutMs;
  let missingKinds = live.requiredKinds.slice();
  let previousSignature = null;
  let stableSamples = 0;

  do {
    const observed = await readVisibleLiveBasemapTiles(page);
    live.visibleTiles = observed.visibleTiles;
    live.observedTiles = observed.observedTiles;
    live.invalidTiles = observed.invalidTiles;
    live.coverageByKind = observed.coverageByKind;
    live.animationState = observed.animationState;
    live.mapRect = observed.mapRect;
    live.tileSignature = observed.tileSignature;
    missingKinds = missingLiveBasemapKinds(live);
    const expectedSignatureMatches = !expectedSignature ||
      observed.tileSignature === expectedSignature;
    if (observed.ready && expectedSignatureMatches) {
      stableSamples = observed.tileSignature === previousSignature
        ? stableSamples + 1
        : 1;
      live.stableSamples = Math.max(Number(live.stableSamples) || 0, stableSamples);
      if (stableSamples >= requiredStableSamples) return live;
    } else {
      stableSamples = 0;
    }
    previousSignature = observed.tileSignature;
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(LIVE_TILE_SAMPLE_INTERVAL_MS);
  } while (true);

  throw new Error(
    'Documentation screenshot lacks complete stable real basemap coverage for: ' +
    missingKinds.join(', ') + String.fromCharCode(10) +
    'Expected tile signature: ' + JSON.stringify(expectedSignature) + String.fromCharCode(10) +
    'Observed tile signature: ' + JSON.stringify(live.tileSignature || null) + String.fromCharCode(10) +
    'Stable samples: ' + String(live.stableSamples || 0) + '/' + String(requiredStableSamples) +
      String.fromCharCode(10) +
    'Leaflet animation state: ' + JSON.stringify(live.animationState || null, null, 2) +
      String.fromCharCode(10) +
    'Coverage by kind: ' + JSON.stringify(live.coverageByKind || null, null, 2) +
      String.fromCharCode(10) +
    'Invalid visible Leaflet tiles: ' + JSON.stringify(live.invalidTiles || [], null, 2) +
      String.fromCharCode(10) +
    'Visible ready real basemap tiles: ' + JSON.stringify(live.visibleTiles, null, 2) +
      String.fromCharCode(10) +
    'Observed Leaflet tile images: ' + JSON.stringify(live.observedTiles, null, 2) +
      String.fromCharCode(10) +
    'Observed successful real basemap responses: ' +
      JSON.stringify(live.successfulResponses, null, 2)
  );
}

async function proxyLiveBasemapRequest(route, kind) {
  try {
    const response = await route.fetch({
      timeout: LIVE_TILE_REQUEST_TIMEOUT_MS,
      maxRetries: 1
    });
    const contentType = String(response.headers()['content-type'] || '').toLowerCase();
    if (response.ok() && /^image\/(?:png|jpe?g|webp)(?:;|$)/.test(contentType)) {
      await route.fulfill({ response });
      return;
    }
    const responseStatus = Number(response.status()) || 502;
    await route.fulfill({
      status: responseStatus >= 400 ? responseStatus : 502,
      contentType: 'text/plain; charset=utf-8',
      body: 'Invalid live ' + kind + ' tile response: status=' + responseStatus +
        ', content-type=' + (contentType || 'missing')
    });
  } catch (error) {
    await route.fulfill({
      status: 504,
      contentType: 'text/plain; charset=utf-8',
      body: 'Timed out while loading live ' + kind + ' tile: ' +
        String(error && error.message || error)
    });
  }
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
    observedTiles: [],
    invalidTiles: [],
    coverageByKind: {},
    animationState: null,
    mapRect: null,
    tileSignature: null,
    stableSamples: 0
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
      await proxyLiveBasemapRequest(route, basemapKind);
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
  let assertionError = null;
  let live = null;
  let snapshot = null;
  let captureAttempts = 0;

  for (let attempt = 1; attempt <= LIVE_SCREENSHOT_CAPTURE_ATTEMPTS; attempt += 1) {
    captureAttempts = attempt;
    assertionError = null;
    let beforeLive = null;
    try {
      beforeLive = await assertLiveBasemapProvenance(page);
      live = beforeLive;
    } catch (error) {
      assertionError = error;
      live = LIVE_BASEMAP_PROVENANCE.get(page);
      snapshot = await baseCaptureDataScreenshot(page, options);
      break;
    }

    snapshot = await baseCaptureDataScreenshot(page, options);
    try {
      live = await assertLiveBasemapProvenance(page, {
        timeoutMs: 1000,
        stableSamples: 1,
        expectedSignature: beforeLive.tileSignature
      });
      break;
    } catch (error) {
      assertionError = error;
      live = LIVE_BASEMAP_PROVENANCE.get(page);
      if (attempt === LIVE_SCREENSHOT_CAPTURE_ATTEMPTS) break;
    }
  }

  const basename = options.path.split('/').pop().replace(/\.png$/i, '');
  const evidencePath = resolve(process.cwd(), 'out/qa/screenshot-readiness', basename + '.json');
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  evidence.cartography = {
    source: 'live',
    requiredKinds: live && live.requiredKinds ? live.requiredKinds.slice() : [],
    requiredStableSamples: LIVE_TILE_STABLE_SAMPLES,
    visibleTiles: live && live.visibleTiles ? live.visibleTiles.map(tile => ({ ...tile })) : [],
    observedTiles: live && live.observedTiles ? live.observedTiles.map(tile => ({ ...tile })) : [],
    invalidTiles: live && live.invalidTiles ? live.invalidTiles.map(tile => ({ ...tile })) : [],
    coverageByKind: live && live.coverageByKind ? JSON.parse(JSON.stringify(live.coverageByKind)) : {},
    animationState: live && live.animationState ? { ...live.animationState } : null,
    mapRect: live && live.mapRect ? { ...live.mapRect } : null,
    tileSignature: live && live.tileSignature || null,
    stableSamples: live && live.stableSamples || 0,
    captureAttempts,
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
    "  await page.goto('/werkbank_v2.html' + params);\n  await page.waitForLoadState('networkidle');",
    "  await page.goto('/werkbank_v2.html' + params, { waitUntil: 'domcontentloaded' });",
    'live page readiness'
  );
  transformed = replaceOnce(
    transformed,
    "    document.documentElement.dataset.mapSourceMode = 'fixture';",
    "    document.documentElement.dataset.mapSourceMode = 'live';",
    'live map source mode'
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
