#!/usr/bin/env node
/**
 * Regenerate the context-data documentation assets from a real
 * `unfallatlas` container.
 *
 * The container, the URL and the body are the same ones the
 * `videoExport.testcontainers` integration test uses — single source of
 * truth for "what the docs depict" and "what we test".
 *
 * Outputs:
 *   - `docs/demo-context.gif`              (POST /api/export-video)
 *   - `docs/screenshots/17-kontext-filter.png`
 *   - `docs/screenshots/18-popup-kontextdaten.png`
 *   - `docs/screenshots/19-kontext-traffic-proxy.png`
 *
 * Image source (same as the test): `UNFALLATLAS_IMAGE` env var, else
 * a local `docker build` from the repo root.
 *
 * Marker selection for the popup PNG is deterministic — the smallest
 * matching feature `id` after the context filter is applied — so the
 * captured screenshot is reproducible.
 *
 * File-size budgets:
 *   - GIF ≤ 4 MB
 *   - PNG ≤ 600 KB each
 * Exits non-zero on overflow.
 *
 * Run with: `npm run regen:context-assets`
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const {
  startUnfallatlasContainer,
  isDockerAvailable,
  REPO_ROOT
} = require('../tests/integration/lib/startUnfallatlasContainer');

const CONTEXT_BODY = {
  city: 'Hannover',
  ctxSlope: 'steep,very_steep',
  ctxTraffic: 'high,very_high',
  ctxOnlyMatched: '1',
  zoom: '13'
};

const CONTEXT_QS =
  '?city=Hannover' +
  '&ctxSlope=steep,very_steep' +
  '&ctxTraffic=high,very_high' +
  '&ctxOnlyMatched=1' +
  '&zoom=13';

const DOCS_DIR = path.join(REPO_ROOT, 'docs');
const SCREEN_DIR = path.join(DOCS_DIR, 'screenshots');
const GIF_PATH = path.join(DOCS_DIR, 'demo-context.gif');
const PNG_FILTER = path.join(SCREEN_DIR, '17-kontext-filter.png');
const PNG_POPUP = path.join(SCREEN_DIR, '18-popup-kontextdaten.png');
const PNG_TRAFFIC = path.join(SCREEN_DIR, '19-kontext-traffic-proxy.png');

const GIF_BUDGET_BYTES = 4 * 1024 * 1024;
const PNG_BUDGET_BYTES = 600 * 1024;

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[regen-context-assets]', ...args);
}

async function fetchGif(baseUrl) {
  log(`POST ${baseUrl}/api/export-video`);
  const res = await fetch(`${baseUrl}/api/export-video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CONTEXT_BODY)
  });
  if (res.status !== 200) {
    throw new Error(`POST /api/export-video → HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function captureScreenshots(baseUrl) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    log(`browse ${baseUrl}/werkbank_v2.html${CONTEXT_QS}`);
    await page.goto(`${baseUrl}/werkbank_v2.html${CONTEXT_QS}`);
    await page.waitForLoadState('networkidle');

    // 17 — Kontext-Filter-Sektion (komplette Seite, der Filter ist links)
    if (await page.locator('#ctxFilterSection').count() > 0) {
      await page.locator('#ctxFilterSection').scrollIntoViewIfNeeded();
    }
    await page.screenshot({ path: PNG_FILTER, fullPage: false });
    log(`wrote ${PNG_FILTER}`);

    // 19 — Verkehrsproxy-Filter (gleiches Layout, sichtbar markierter
    // Verkehrs-Chip). Wir nehmen denselben Viewport, der Unterschied
    // zwischen 17 und 19 liegt im aktiven Filter — die URL setzt beide,
    // sodass das zweite Bild den vollen aktiven Stand dokumentiert.
    await page.screenshot({ path: PNG_TRAFFIC, fullPage: false });
    log(`wrote ${PNG_TRAFFIC}`);

    // 18 — Popup mit Kontextdaten. Marker mit kleinster matchender
    // feature-id wählen, damit reproduzierbar.
    const markerInfo = await page.evaluate(() => {
      // The map exposes a global `map` reference in werkbank_v2; iterate
      // visible markers, find smallest feature id that has a context
      // block in its bound popup.
      try {
        // eslint-disable-next-line no-undef
        const m = window.map || (window.UA && window.UA.ctx && window.UA.ctx.map);
        if (!m) return null;
        let best = null;
        m.eachLayer((layer) => {
          if (!layer.getPopup) return;
          const p = layer.getPopup && layer.getPopup();
          if (!p) return;
          const html = p.getContent && p.getContent();
          if (typeof html !== 'string' || !/Kontextdaten/i.test(html)) return;
          const id = (layer.feature && layer.feature.id) || layer._leaflet_id;
          if (best === null || id < best.id) {
            const ll = layer.getLatLng && layer.getLatLng();
            best = { id, lat: ll && ll.lat, lng: ll && ll.lng };
          }
        });
        return best;
      } catch (_) { return null; }
    });
    if (markerInfo && markerInfo.lat != null) {
      await page.evaluate((info) => {
        // eslint-disable-next-line no-undef
        const m = window.map || (window.UA && window.UA.ctx && window.UA.ctx.map);
        if (!m) return;
        m.eachLayer((layer) => {
          if (layer.getLatLng && layer.feature && layer.feature.id === info.id) {
            layer.openPopup();
          }
        });
      }, markerInfo);
      await page.waitForTimeout(500);
      await page.screenshot({ path: PNG_POPUP, fullPage: false });
      log(`wrote ${PNG_POPUP} (marker id=${markerInfo.id})`);
    } else {
      log(`WARN: no marker with Kontextdaten found — skipping ${PNG_POPUP}`);
    }
  } finally {
    await browser.close();
  }
}

function assertBudget(filePath, budget) {
  const stat = fs.statSync(filePath);
  if (stat.size > budget) {
    throw new Error(
      `${path.relative(REPO_ROOT, filePath)} = ${stat.size} bytes > budget ${budget} bytes`
    );
  }
  log(`size OK: ${path.relative(REPO_ROOT, filePath)} = ${stat.size} bytes (budget ${budget})`);
}

async function main() {
  const probe = await isDockerAvailable();
  if (!probe.available) {
    // eslint-disable-next-line no-console
    console.error(`[regen-context-assets] Docker not available: ${probe.reason}`);
    process.exit(2);
  }
  fs.mkdirSync(SCREEN_DIR, { recursive: true });

  const handle = await startUnfallatlasContainer();
  try {
    const gif = await fetchGif(handle.baseUrl);
    fs.writeFileSync(GIF_PATH, gif);
    log(`wrote ${GIF_PATH} (${gif.length} bytes)`);

    await captureScreenshots(handle.baseUrl);
  } finally {
    await handle.stop();
  }

  assertBudget(GIF_PATH, GIF_BUDGET_BYTES);
  for (const png of [PNG_FILTER, PNG_TRAFFIC, PNG_POPUP]) {
    if (fs.existsSync(png)) assertBudget(png, PNG_BUDGET_BYTES);
  }
  log('done.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[regen-context-assets]', err);
  process.exit(1);
});
