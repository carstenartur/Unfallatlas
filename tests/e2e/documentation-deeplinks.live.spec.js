import { test, expect } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { validateDocumentationLinks } = require('../../scripts/documentation-deeplink-contract.cjs');
const contract = validateDocumentationLinks(process.cwd());
const outputDir = resolve(process.cwd(), 'out/qa/documentation-live-links');
mkdirSync(outputDir, { recursive: true });

function approximately(actual, expected, tolerance, label) {
  expect(Math.abs(Number(actual) - Number(expected)), label)
    .toBeLessThanOrEqual(Number(tolerance));
}

function parseLocalCount(text) {
  const match = String(text || '').match(/lokal\s+([\d.\s]+)\s+Unfälle/i);
  return match ? Number(match[1].replace(/\D/g, '')) || 0 : 0;
}

async function readLiveState(page) {
  return page.evaluate(() => {
    const UA = window.UA;
    const ctx = UA && typeof UA.getRuntimeContext === 'function'
      ? UA.getRuntimeContext()
      : null;
    if (!ctx || !ctx.map || !ctx.ui) throw new Error('Live runtime context is unavailable');

    const plainBounds = (bounds) => bounds && typeof bounds.getSouth === 'function'
      ? {
          south: bounds.getSouth(),
          west: bounds.getWest(),
          north: bounds.getNorth(),
          east: bounds.getEast(),
        }
      : null;
    const selection = plainBounds(ctx.selectionBounds);
    const selectionCount = selection && Array.isArray(ctx.filteredAll)
      ? ctx.filteredAll.filter((point) =>
          point && Number(point.lat) >= selection.south && Number(point.lat) <= selection.north &&
          Number(point.lon) >= selection.west && Number(point.lon) <= selection.east
        ).length
      : 0;

    const visited = new Set();
    let visiblePoiLayers = 0;
    function looksLikePoi(layer) {
      const props = layer && (
        layer.feature?.properties || layer.options?.__uaProps || layer._uaProps || layer.__uaProps
      ) || {};
      const amenity = String(props.amenity || props.type || props.kind || '').toLowerCase();
      const name = String(props.name || props.title || '').toLowerCase();
      const iconHtml = String(layer?.options?.icon?.options?.html || '').toLowerCase();
      let popup = '';
      try {
        const content = layer?.getPopup?.()?.getContent?.();
        popup = typeof content === 'string' ? content.toLowerCase() : '';
      } catch (_) {}
      return /school|kindergarten|childcare|kita|college/.test(`${amenity} ${name} ${iconHtml} ${popup}`) ||
        /🏫|🧒/.test(iconHtml);
    }
    function visit(layer) {
      if (!layer || visited.has(layer)) return;
      visited.add(layer);
      if (looksLikePoi(layer) && (!ctx.map.hasLayer || ctx.map.hasLayer(layer))) visiblePoiLayers += 1;
      if (typeof layer.getLayers === 'function') {
        for (const child of layer.getLayers()) visit(child);
      }
    }
    if (typeof ctx.map.eachLayer === 'function') ctx.map.eachLayer(visit);

    const center = ctx.map.getCenter();
    const modal = document.getElementById('modalOverlay');
    const exportProgress = document.getElementById('exportProgress');
    const exportHtml = document.getElementById('exportHtml');
    const stat = document.getElementById('stat');
    return {
      url: location.href,
      build: String(UA.BUILD || ''),
      city: ctx.CITY_RAW,
      allPoints: Array.isArray(ctx.allPts) ? ctx.allPts.length : -1,
      filteredPoints: Array.isArray(ctx.filteredAll) ? ctx.filteredAll.length : -1,
      viewportPoints: Array.isArray(ctx.viewportPts) ? ctx.viewportPts.length : -1,
      selectionCount,
      involvementMode: ctx.involvementMode,
      showCluster: Boolean(ctx.showCluster),
      showHeatmap: Boolean(ctx.showHeatmap),
      showSchools: Boolean(ctx.showSchools),
      showKindergartens: Boolean(ctx.showKindergartens),
      showArgumentation: Boolean(ctx.showArgumentation),
      clusterLayerVisible: Boolean(ctx.clusterLayer && ctx.map.hasLayer(ctx.clusterLayer)),
      heatLayerVisible: Boolean(ctx.heatLayer && ctx.map.hasLayer(ctx.heatLayer)),
      selection,
      drawnLayerCount: typeof ctx.drawnItems?.getLayers === 'function'
        ? ctx.drawnItems.getLayers().length
        : 0,
      center: { lat: center.lat, lon: center.lng },
      zoom: ctx.map.getZoom(),
      poiFeatures: Array.isArray(ctx.poiData?.features) ? ctx.poiData.features.length : 0,
      visiblePoiLayers,
      controls: {
        city: document.getElementById('citySel')?.value || null,
        severity: document.getElementById('severity')?.value || null,
        dayType: document.getElementById('dayType')?.value || null,
        roadCondition: document.getElementById('roadCondition')?.value || null,
        hourFrom: Number(document.getElementById('hFrom')?.value),
        hourTo: Number(document.getElementById('hTo')?.value),
        bike: Boolean(document.getElementById('incBike')?.checked),
        pedestrian: Boolean(document.getElementById('incPed')?.checked),
        car: Boolean(document.getElementById('incCar')?.checked),
        motorcycle: Boolean(document.getElementById('incMoto')?.checked),
      },
      export: {
        open: Boolean(modal && getComputedStyle(modal).display !== 'none' && !modal.hidden),
        progress: String(exportProgress?.textContent || '').trim(),
        textLength: String(exportHtml?.textContent || '').trim().length,
      },
      stat: String(stat?.textContent || '').replace(/\s+/g, ' ').trim(),
      localCount: (() => {
        const match = String(stat?.textContent || '').match(/lokal\s+([\d.\s]+)\s+Unfälle/i);
        return match ? Number(match[1].replace(/\D/g, '')) || 0 : 0;
      })(),
    };
  });
}

function assertLoadedScenario(scenario, state) {
  const expected = scenario.expected;
  expect(state.city).toBe(expected.city);
  expect(state.controls.city).toBe(expected.city);
  expect(state.allPoints).toBeGreaterThanOrEqual(expected.minimumAllPoints || 0);
  expect(state.localCount || parseLocalCount(state.stat)).toBeGreaterThan(0);
  if (expected.minimumViewportPoints) {
    expect(state.viewportPoints).toBeGreaterThanOrEqual(expected.minimumViewportPoints);
  }
}

function assertState(scenario, state) {
  const expected = scenario.expected;
  assertLoadedScenario(scenario, state);

  for (const key of [
    'involvementMode', 'showCluster', 'showHeatmap',
    'showSchools', 'showKindergartens', 'showArgumentation',
  ]) {
    if (expected[key] !== undefined) expect(state[key], key).toBe(expected[key]);
  }
  if (expected.showCluster === true) expect(state.clusterLayerVisible).toBe(true);
  if (expected.showCluster === false) expect(state.clusterLayerVisible).toBe(false);
  if (expected.showHeatmap === true) expect(state.heatLayerVisible).toBe(true);
  if (expected.showHeatmap === false) expect(state.heatLayerVisible).toBe(false);

  if (expected.filters) {
    for (const [key, value] of Object.entries(expected.filters)) {
      expect(state.controls[key], `filter ${key}`).toBe(value);
    }
  }
  if (expected.hourFrom !== undefined) expect(state.controls.hourFrom).toBe(expected.hourFrom);
  if (expected.hourTo !== undefined) expect(state.controls.hourTo).toBe(expected.hourTo);
  if (expected.center) {
    approximately(state.center.lat, expected.center.lat, expected.center.tolerance, 'map latitude');
    approximately(state.center.lon, expected.center.lon, expected.center.tolerance, 'map longitude');
  }
  if (expected.zoom !== undefined) expect(state.zoom).toBe(expected.zoom);
  if (expected.selection) {
    expect(state.selection).not.toBeNull();
    for (const key of ['south', 'west', 'north', 'east']) {
      approximately(state.selection[key], expected.selection[key], expected.selection.tolerance, `selection ${key}`);
    }
    expect(state.drawnLayerCount).toBeGreaterThan(0);
  }
  if (expected.minimumSelectionPoints) {
    expect(state.selectionCount).toBeGreaterThanOrEqual(expected.minimumSelectionPoints);
  }
  if (expected.minimumPoiFeatures) {
    expect(state.poiFeatures).toBeGreaterThanOrEqual(expected.minimumPoiFeatures);
  }
  if (expected.minimumVisiblePoiLayers) {
    expect(state.visiblePoiLayers).toBeGreaterThanOrEqual(expected.minimumVisiblePoiLayers);
  }
  if (expected.exportOpen) expect(state.export.open).toBe(true);
  if (expected.exportReady) {
    expect(state.export.progress).toContain('Fertig');
    expect(state.export.textLength).toBeGreaterThan(100);
  }
}

function assertExactKnownMismatch(scenario, state) {
  assertLoadedScenario(scenario, state);
  const known = scenario.knownMismatch;
  expect(known).toBeTruthy();
  const differingFields = [];
  for (const [key, actual] of Object.entries(known.actual || {})) {
    expect(state[key], `known #${known.issue} actual ${key}`).toBe(actual);
    if (scenario.expected[key] !== actual) differingFields.push(key);
  }
  expect(differingFields.sort()).toEqual([
    'showArgumentation',
    'showHeatmap',
    'showKindergartens',
    'showSchools',
  ]);
  expect(state.clusterLayerVisible).toBe(true);
  expect(state.heatLayerVisible).toBe(true);
}

test.describe.serial('README screenshot deep links – published application', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  for (const scenario of contract.liveScenarios) {
    test(`${scenario.id}: ${scenario.description}`, async ({ page }, testInfo) => {
      test.setTimeout(120000);
      const diagnostics = {
        scenario: scenario.id,
        imagePath: scenario.imagePath,
        url: scenario.url,
        references: scenario.references,
        knownMismatch: scenario.knownMismatch || null,
        pageErrors: [],
        consoleErrors: [],
        sameOriginHttpErrors: [],
        externalRequestFailures: [],
        state: null,
      };
      const liveOrigin = new URL(scenario.url).origin;
      page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error?.stack || error)));
      page.on('console', (message) => {
        if (message.type() === 'error') diagnostics.consoleErrors.push(message.text());
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin === liveOrigin && response.status() >= 400) {
          diagnostics.sameOriginHttpErrors.push({ status: response.status(), url: response.url() });
        }
      });
      page.on('requestfailed', (request) => {
        const url = new URL(request.url());
        const item = { url: request.url(), failure: request.failure()?.errorText || 'unknown' };
        if (url.origin === liveOrigin) diagnostics.sameOriginHttpErrors.push(item);
        else diagnostics.externalRequestFailures.push(item);
      });

      await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await page.waitForFunction((city) => {
        const UA = window.UA;
        const ctx = UA && typeof UA.getRuntimeContext === 'function'
          ? UA.getRuntimeContext()
          : null;
        const citySelect = document.getElementById('citySel');
        const stat = String(document.getElementById('stat')?.textContent || '');
        return Boolean(
          ctx && ctx.map && ctx.ui && ctx.CITY_RAW === city &&
          Array.isArray(ctx.allPts) && ctx.allPts.length > 0 &&
          Array.isArray(ctx.filteredAll) && Array.isArray(ctx.viewportPts) &&
          citySelect && citySelect.value === city &&
          !/Daten werden geladen|wird geladen/i.test(stat)
        );
      }, scenario.expected.city, { timeout: 90000 });

      if (scenario.expected.exportReady) {
        await page.locator('#modalOverlay').waitFor({ state: 'visible', timeout: 60000 });
        await page.waitForFunction(() =>
          String(document.getElementById('exportProgress')?.textContent || '').includes('Fertig'),
        null, { timeout: 60000 });
      }
      await page.waitForTimeout(750);
      diagnostics.state = await readLiveState(page);

      const screenshotPath = resolve(outputDir, `${scenario.id}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const reportPath = resolve(outputDir, `${scenario.id}.json`);
      writeFileSync(reportPath, `${JSON.stringify(diagnostics, null, 2)}\n`);
      await testInfo.attach(`${scenario.id}-state`, {
        body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
        contentType: 'application/json',
      });

      expect(diagnostics.pageErrors, 'uncaught page errors').toEqual([]);
      expect(diagnostics.consoleErrors, 'console errors').toEqual([]);
      expect(diagnostics.sameOriginHttpErrors, 'live application HTTP/resource errors').toEqual([]);
      if (scenario.knownMismatch) assertExactKnownMismatch(scenario, diagnostics.state);
      else assertState(scenario, diagnostics.state);
    });
  }
});
