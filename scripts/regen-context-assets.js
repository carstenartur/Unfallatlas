#!/usr/bin/env node
/**
 * Generate review-only context-media candidates from a real Unfallatlas
 * container. This command never writes canonical documentation assets.
 *
 * A successful run is published below:
 *   `.build/doc-media/context/run-<timestamp>/`
 *
 * The run fails closed unless all of the following are true:
 * - semantic data/render readiness reports non-empty Hannover accident data,
 * - context controls and the requested chips are visible and active,
 * - a deterministic clustered accident marker can open a popup containing
 *   `Kontextdaten`,
 * - every PNG is exactly 1280x640 and remains within 600 KiB,
 * - the animated GIF is structurally valid and remains within 10 MiB.
 *
 * Promotion into `docs/` is deliberately a separate, reviewed change that
 * must also update `docs/media-manifest.json` and all Markdown consumers.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const {
  startUnfallatlasContainer,
  isDockerAvailable,
  REPO_ROOT
} = require('../tests/integration/lib/startUnfallatlasContainer');
const { assertAnimatedShape } = require('./regen-readme-demo');
const { dimensions, inspectMedia } = require('./validate-doc-media');

const CONTEXT_BODY = Object.freeze({
  city: 'Hannover',
  ctxSlope: 'steep,very_steep',
  ctxTraffic: 'high,very_high',
  ctxOnlyMatched: '1',
  showCluster: '1',
  showHeatmap: '0',
  centerLat: '52.375900',
  centerLon: '9.732000',
  zoom: '13'
});

const CONTEXT_QS = new URLSearchParams(CONTEXT_BODY).toString();
const CANDIDATE_PARENT = path.join(REPO_ROOT, '.build', 'doc-media', 'context');
const VIEWPORT = Object.freeze({ width: 1280, height: 640 });
const GIF_BUDGET_BYTES = 10 * 1024 * 1024;
const PNG_BUDGET_BYTES = 600 * 1024;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[regen-context-assets]', ...args);
}

function outputPaths(root) {
  const screenshots = path.join(root, 'screenshots');
  return {
    root,
    screenshots,
    gif: path.join(root, 'demo-context.gif'),
    filter: path.join(screenshots, '17-kontext-filter.png'),
    popup: path.join(screenshots, '18-popup-kontextdaten.png'),
    traffic: path.join(screenshots, '19-kontext-traffic-proxy.png'),
    report: path.join(root, 'candidate-report.json'),
  };
}

async function fetchGif(baseUrl) {
  log(`POST ${baseUrl}/api/export-video`);
  const res = await fetch(`${baseUrl}/api/export-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CONTEXT_BODY)
  });
  if (!res.ok) {
    const responseText = await res.text().catch(() => '');
    throw new Error(
      `POST /api/export-video -> HTTP ${res.status} ${res.statusText}` +
      (responseText ? `; ${responseText.slice(0, 500)}` : '')
    );
  }
  const gif = Buffer.from(await res.arrayBuffer());
  assertAnimatedShape(gif, 'gif');
  return gif;
}

async function assertContextControls(page) {
  const section = page.locator('#ctxFilterSection');
  await section.waitFor({ state: 'visible', timeout: 60_000 });
  if (await page.locator('#ctxFilterEmpty').isVisible()) {
    throw new Error('Hannover exposed the context empty-state instead of enriched context controls');
  }
  for (const selector of ['#ctxSlopeRow', '#ctxTrafficRow', '#ctxOnlyMatchedRow']) {
    await page.locator(selector).waitFor({ state: 'visible', timeout: 10_000 });
  }
  const state = await page.evaluate(() => ({
    slope: Array.from(document.querySelectorAll('input[data-ctx-slope]:checked')).map(el => el.dataset.ctxSlope).sort(),
    traffic: Array.from(document.querySelectorAll('input[data-ctx-traffic]:checked')).map(el => el.dataset.ctxTraffic).sort(),
    onlyMatched: document.getElementById('ctxOnlyMatched')?.checked === true,
  }));
  if (state.slope.join(',') !== 'steep,very_steep' ||
      state.traffic.join(',') !== 'high,very_high' || !state.onlyMatched) {
    throw new Error(`context controls do not reflect the requested scenario: ${JSON.stringify(state)}`);
  }
  return state;
}

async function openDeterministicContextPopup(page) {
  const selected = await page.evaluate(async () => {
    const map = window._uaMap;
    const materialize = window.UA && window.UA.materializeAccidentPopup;
    if (!map || typeof materialize !== 'function') {
      throw new Error('map or popup materializer is unavailable');
    }

    const visited = new Set();
    const owners = [];
    map.eachLayer(layer => {
      if (layer && layer._uaPopupCtx && typeof layer.eachLayer === 'function') owners.push(layer);
    });
    const candidates = [];
    for (const owner of owners) {
      owner.eachLayer(marker => {
        if (!marker || visited.has(marker) || !marker._uaProps || typeof marker.getLatLng !== 'function') return;
        visited.add(marker);
        const props = marker._uaProps;
        const hasContext = props.slope_class != null || props.traffic_proxy_class != null ||
          props.osm_way_id != null || props.osm_highway != null;
        if (!hasContext) return;
        const numericId = Number(props.id);
        candidates.push({
          marker,
          owner,
          id: Number.isFinite(numericId) ? numericId : Number(marker._leaflet_id),
          leafletId: Number(marker._leaflet_id),
          latLng: marker.getLatLng(),
        });
      });
    }
    candidates.sort((a, b) => (a.id - b.id) || (a.leafletId - b.leafletId));
    const picked = candidates[0];
    if (!picked || !picked.latLng) throw new Error('no filtered accident marker with context properties was found');

    map.setView(picked.latLng, Math.max(17, map.getZoom()));
    await new Promise(resolve => setTimeout(resolve, 300));
    await new Promise((resolve, reject) => {
      const reveal = () => {
        try {
          materialize.call(picked.owner, {
            layer: picked.marker,
            propagatedFrom: picked.marker,
            sourceTarget: picked.marker,
            target: picked.owner,
          });
          if (!picked.marker.getPopup || !picked.marker.getPopup()) {
            reject(new Error(`marker ${picked.id} did not materialize a popup`));
            return;
          }
          picked.marker.openPopup();
          resolve();
        } catch (error) { reject(error); }
      };
      if (typeof picked.owner.zoomToShowLayer === 'function') picked.owner.zoomToShowLayer(picked.marker, reveal);
      else reveal();
    });
    return { id: picked.id, leafletId: picked.leafletId, lat: picked.latLng.lat, lng: picked.latLng.lng };
  });

  const popup = page.locator('.leaflet-popup-content');
  await popup.waitFor({ state: 'visible', timeout: 15_000 });
  const popupText = await popup.innerText();
  if (!/Kontextdaten/i.test(popupText)) {
    throw new Error(`marker ${selected.id} popup does not contain Kontextdaten: ${popupText.slice(0, 500)}`);
  }
  return selected;
}

async function captureScreenshots(baseUrl, outputs) {
  const {
    assertStableScreenshotSnapshot,
    waitForMapTiles,
    waitForFonts,
    waitForScreenshotReady,
  } = await import('../tests/e2e/helpers.js');
  const browser = await chromium.launch();
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    const standardTile = fs.readFileSync(path.join(REPO_ROOT, 'tests', 'e2e', 'fixtures', 'map-tiles', 'standard.svg'));
    const unexpectedExternalImages = [];
    await page.route(/^https:\/\//, async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname)) {
        await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: standardTile });
        return;
      }
      if (request.resourceType() === 'image') {
        unexpectedExternalImages.push(request.url());
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    page.on('pageerror', error => pageErrors.push(error.message));
    log(`browse ${baseUrl}/werkbank_v2.html?${CONTEXT_QS}`);
    const response = await page.goto(`${baseUrl}/werkbank_v2.html?${CONTEXT_QS}`);
    if (!response || !response.ok()) throw new Error(`Werkbank navigation failed with HTTP ${response && response.status()}`);

    const readinessCriteria = {
      city: 'Hannover',
      layers: ['cluster'],
      minLoaded: 1,
      minFiltered: 1,
      minViewport: 1,
      requireCompleteCoverage: true,
      timeout: 60_000,
    };
    const initialReadiness = await waitForScreenshotReady(page, readinessCriteria);
    const readiness = {};
    const captureStable = async (file, label) => {
      await waitForMapTiles(page, 30_000);
      await waitForFonts(page);
      const before = await waitForScreenshotReady(page, readinessCriteria);
      await page.screenshot({ path: file, fullPage: false });
      const after = await waitForScreenshotReady(page, readinessCriteria);
      assertStableScreenshotSnapshot(before, after, readinessCriteria, label);
      readiness[label] = after;
    };
    const controls = await assertContextControls(page);
    await page.locator('#ctxFilterSection').scrollIntoViewIfNeeded();
    await captureStable(outputs.filter, 'filter');
    assertStableScreenshotSnapshot(initialReadiness, readiness.filter, readinessCriteria, 'filter');
    log(`wrote ${outputs.filter}`);

    await page.locator('#collapseBtn').click();
    await page.locator('#panel.collapsed').waitFor({ state: 'visible', timeout: 10_000 });
    await captureStable(outputs.traffic, 'traffic');
    log(`wrote ${outputs.traffic}`);

    const marker = await openDeterministicContextPopup(page);
    await captureStable(outputs.popup, 'popup');
    log(`wrote ${outputs.popup} (marker id=${marker.id})`);

    if (unexpectedExternalImages.length) {
      throw new Error(`unmocked external images requested: ${unexpectedExternalImages.join(' | ')}`);
    }
    if (pageErrors.length) throw new Error(`browser page errors: ${pageErrors.join(' | ')}`);
    return { readiness, controls, marker, pageErrors };
  } finally {
    await browser.close();
  }
}

function describeFile(file) {
  const stat = fs.statSync(file);
  return {
    path: path.basename(file),
    bytes: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  };
}

function assertBudget(file, budget) {
  const stat = fs.statSync(file);
  if (stat.size > budget) {
    throw new Error(`${path.relative(REPO_ROOT, file)} = ${stat.size} bytes > budget ${budget} bytes`);
  }
  log(`size OK: ${path.relative(REPO_ROOT, file)} = ${stat.size} bytes (budget ${budget})`);
}

function assertPngCandidate(file) {
  assertBudget(file, PNG_BUDGET_BYTES);
  const actual = dimensions(file);
  if (actual.width !== VIEWPORT.width || actual.height !== VIEWPORT.height) {
    throw new Error(
      `${path.relative(REPO_ROOT, file)} = ${actual.width}x${actual.height}; expected ${VIEWPORT.width}x${VIEWPORT.height}`
    );
  }
  return { ...describeFile(file), dimensions: actual };
}

function assertGifCandidate(file) {
  assertBudget(file, GIF_BUDGET_BYTES);
  const inspected = inspectMedia(file);
  if (inspected.format !== 'gif' || inspected.animated !== true) {
    throw new Error(`${path.relative(REPO_ROOT, file)} is not a structurally valid animated GIF`);
  }
  return {
    ...describeFile(file),
    dimensions: { width: inspected.width, height: inspected.height },
    animated: true,
  };
}

async function main() {
  const probe = await isDockerAvailable();
  if (!probe.available) throw new Error(`Docker not available: ${probe.reason}`);

  fs.mkdirSync(CANDIDATE_PARENT, { recursive: true });
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const stagingRoot = path.join(CANDIDATE_PARENT, `.tmp-${runId}-${process.pid}`);
  const finalRoot = path.join(CANDIDATE_PARENT, `run-${runId}`);
  const outputs = outputPaths(stagingRoot);
  fs.mkdirSync(outputs.screenshots, { recursive: true });

  try {
    const handle = await startUnfallatlasContainer();
    let capture;
    try {
      const gif = await fetchGif(handle.baseUrl);
      fs.writeFileSync(outputs.gif, gif);
      log(`wrote ${outputs.gif} (${gif.length} bytes)`);
      capture = await captureScreenshots(handle.baseUrl, outputs);
    } finally {
      await handle.stop();
    }

    const files = {
      gif: assertGifCandidate(outputs.gif),
      filter: assertPngCandidate(outputs.filter),
      popup: assertPngCandidate(outputs.popup),
      traffic: assertPngCandidate(outputs.traffic),
    };
    const report = {
      schemaVersion: 1,
      status: 'review-candidate',
      promoted: false,
      viewport: VIEWPORT,
      budgets: { gifBytes: GIF_BUDGET_BYTES, pngBytes: PNG_BUDGET_BYTES },
      source: { scenario: CONTEXT_BODY, baseUrl: 'container-local' },
      capture,
      files,
      reviewGate: 'Promote only in a separate change that updates docs/media-manifest.json and every Markdown consumer.',
    };
    fs.writeFileSync(outputs.report, `${JSON.stringify(report, null, 2)}\n`);
    fs.renameSync(stagingRoot, finalRoot);
    log(`review candidates ready: ${path.relative(REPO_ROOT, finalRoot)}`);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[regen-context-assets]', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = {
  CONTEXT_BODY,
  VIEWPORT,
  assertBudget,
  assertContextControls,
  assertGifCandidate,
  assertPngCandidate,
  captureScreenshots,
  fetchGif,
  main,
  openDeterministicContextPopup,
  outputPaths,
};
