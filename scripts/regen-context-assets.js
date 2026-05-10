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
  const { waitForMapTiles, waitForFonts } = await import('../tests/e2e/helpers.js');
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    log(`browse ${baseUrl}/werkbank_v2.html${CONTEXT_QS}`);
    await page.goto(`${baseUrl}/werkbank_v2.html${CONTEXT_QS}`);
    await page.waitForLoadState('networkidle');
    await waitForMapTiles(page);
    await waitForFonts(page);

    // 17 — Kontext-Filter-Sektion (komplette Seite, der Filter ist links)
    if (await page.locator('#ctxFilterSection').count() > 0) {
      await page.locator('#ctxFilterSection').scrollIntoViewIfNeeded();
    }
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.screenshot({ path: PNG_FILTER, fullPage: false });
    log(`wrote ${PNG_FILTER}`);

    // 19 — Verkehrsproxy-Filter (gleiches Layout, sichtbar markierter
    // Verkehrs-Chip). Wir nehmen denselben Viewport, der Unterschied
    // zwischen 17 und 19 liegt im aktiven Filter — die URL setzt beide,
    // sodass das zweite Bild den vollen aktiven Stand dokumentiert.
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.screenshot({ path: PNG_TRAFFIC, fullPage: false });
    log(`wrote ${PNG_TRAFFIC}`);

    // 18 — Popup mit Kontextdaten. Marker mit kleinster matchender
    // accident-id (UA._uaProps.id) wählen, damit reproduzierbar. Werkbank_v2
    // bindet `_uaProps` auf jeden L.circleMarker (siehe ua.map_v2.js
    // `m._uaProps = p.props`); ein `layer.feature` existiert dort nicht.
    // Wir verwenden _leaflet_id als stabilen Fallback und vergleichen
    // immer numerisch.
    const markerInfo = await page.evaluate(() => {
      try {
        // eslint-disable-next-line no-undef
        const m = window.map || (window.UA && window.UA.ctx && window.UA.ctx.map);
        if (!m) return null;
        const pickId = (layer) => {
          const props = layer && layer._uaProps;
          if (props && props.id != null) {
            const n = Number(props.id);
            if (!Number.isNaN(n)) return n;
          }
          return Number(layer && layer._leaflet_id);
        };
        let best = null;
        m.eachLayer((layer) => {
          if (!layer.getPopup || !layer.getLatLng) return;
          const p = layer.getPopup();
          if (!p) return;
          const html = p.getContent && p.getContent();
          if (typeof html !== 'string' || !/Kontextdaten/i.test(html)) return;
          const id = pickId(layer);
          if (!Number.isFinite(id)) return;
          if (best === null || id < best.id) {
            const ll = layer.getLatLng();
            best = { id, leafletId: layer._leaflet_id, lat: ll && ll.lat, lng: ll && ll.lng };
          }
        });
        return best;
      } catch (_) { return null; }
    });
    if (markerInfo && markerInfo.lat != null) {
      const opened = await page.evaluate((info) => {
        // eslint-disable-next-line no-undef
        const m = window.map || (window.UA && window.UA.ctx && window.UA.ctx.map);
        if (!m) return false;
        let hit = false;
        m.eachLayer((layer) => {
          if (hit || !layer.getLatLng || !layer.openPopup) return;
          if (layer._leaflet_id === info.leafletId) {
            layer.openPopup();
            hit = true;
          }
        });
        return hit;
      }, markerInfo);
      if (!opened) {
        log(`WARN: marker with id=${markerInfo.id} (_leaflet_id=${markerInfo.leafletId}) vanished before openPopup`);
      }
      await page.waitForTimeout(500);
      await waitForMapTiles(page);
      await waitForFonts(page);
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
