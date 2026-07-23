import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import documentationContract from '../../scripts/documentation-deeplink-contract.cjs';
import localizedCount from '../../scripts/parse-localized-count.cjs';

const { validateDocumentationLinks } = documentationContract;
const { visibleCountFromStatus } = localizedCount;
const scenarios = validateDocumentationLinks(process.cwd()).liveScenarios;
const outputDir = resolve(process.cwd(), 'out/qa/documentation-live-links');
mkdirSync(outputDir, { recursive: true });

function approximately(actual, expected, tolerance, label) {
  expect(Math.abs(Number(actual) - Number(expected)), label)
    .toBeLessThanOrEqual(Number(tolerance));
}

async function readLiveState(page) {
  return page.evaluate(() => {
    const ctx = window.UA?.getRuntimeContext?.();
    if (!ctx?.map || !ctx.ui) throw new Error('Live runtime context is unavailable');
    const selection = ctx.selectionBounds?.getSouth
      ? {
          south: ctx.selectionBounds.getSouth(), west: ctx.selectionBounds.getWest(),
          north: ctx.selectionBounds.getNorth(), east: ctx.selectionBounds.getEast(),
        }
      : null;
    const selectionCount = selection && Array.isArray(ctx.filteredAll)
      ? ctx.filteredAll.filter((p) => p && p.lat >= selection.south && p.lat <= selection.north &&
          p.lon >= selection.west && p.lon <= selection.east).length
      : 0;
    let visiblePoiLayers = 0;
    const visited = new Set();
    const visit = (layer) => {
      if (!layer || visited.has(layer)) return;
      visited.add(layer);
      let popup = '';
      try {
        const content = layer.getPopup?.()?.getContent?.();
        popup = typeof content === 'string' ? content : '';
      } catch (_) {}
      const iconHtml = String(layer.options?.icon?.options?.html || '');
      if ((/🏫|🧒/.test(iconHtml) || /Schule|Kindergarten/i.test(popup)) &&
          (!ctx.map.hasLayer || ctx.map.hasLayer(layer))) visiblePoiLayers += 1;
      for (const child of layer.getLayers?.() || []) visit(child);
    };
    ctx.map.eachLayer?.(visit);

    const center = ctx.map.getCenter();
    const stat = String(document.getElementById('stat')?.textContent || '').replace(/\s+/g, ' ').trim();
    const modal = document.getElementById('modalOverlay');
    const previewNotice = document.getElementById('publicPreviewNotice');
    const wordButton = document.getElementById('btnExportWord');
    const pdfButton = document.getElementById('btnExportPDF');
    const antragGroup = document.getElementById('exportGroupAntrag');
    return {
      city: ctx.CITY_RAW,
      allPoints: ctx.allPts?.length ?? -1,
      viewportPoints: ctx.viewportPts?.length ?? -1,
      selectionCount,
      involvementMode: ctx.involvementMode,
      showCluster: Boolean(ctx.showCluster), showHeatmap: Boolean(ctx.showHeatmap),
      showSchools: Boolean(ctx.showSchools), showKindergartens: Boolean(ctx.showKindergartens),
      showArgumentation: Boolean(ctx.showArgumentation),
      clusterLayerVisible: Boolean(ctx.clusterLayer && ctx.map.hasLayer(ctx.clusterLayer)),
      heatLayerVisible: Boolean(ctx.heatLayer && ctx.map.hasLayer(ctx.heatLayer)),
      selection,
      drawnLayerCount: ctx.drawnItems?.getLayers?.().length || 0,
      center: { lat: center.lat, lon: center.lng }, zoom: ctx.map.getZoom(),
      poiFeatures: ctx.poiData?.features?.length || 0,
      visiblePoiLayers,
      controls: {
        city: document.getElementById('citySel')?.value || null,
        hourFrom: Number(document.getElementById('hFrom')?.value),
        hourTo: Number(document.getElementById('hTo')?.value),
        bike: Boolean(document.getElementById('incBike')?.checked),
        pedestrian: Boolean(document.getElementById('incPed')?.checked),
        car: Boolean(document.getElementById('incCar')?.checked),
        motorcycle: Boolean(document.getElementById('incMoto')?.checked),
      },
      export: {
        open: Boolean(modal && getComputedStyle(modal).display !== 'none' && !modal.hidden),
        progress: String(document.getElementById('exportProgress')?.textContent || '').trim(),
        textLength: String(document.getElementById('exportHtml')?.textContent || '').trim().length,
        publicPreview: document.documentElement.dataset.distributionProfile || null,
        noticeVisible: Boolean(previewNotice && !previewNotice.hidden && getComputedStyle(previewNotice).display !== 'none'),
        noticeText: String(previewNotice?.textContent || '').replace(/\s+/g, ' ').trim(),
        antragGroupHidden: Boolean(antragGroup && (antragGroup.hidden || getComputedStyle(antragGroup).display === 'none')),
        wordDisabled: Boolean(wordButton?.disabled),
        pdfDisabled: Boolean(pdfButton?.disabled),
      },
      stat,
    };
  });
}

function assertState(scenario, state) {
  const expected = scenario.expected;
  expect(state.city).toBe(expected.city);
  expect(state.controls.city).toBe(expected.city);
  expect(state.allPoints).toBeGreaterThanOrEqual(expected.minimumAllPoints || 0);
  expect(state.viewportPoints, 'accidents in the visible map viewport').toBeGreaterThan(0);
  expect(visibleCountFromStatus(state.stat), 'visible viewport accident count').toBe(state.viewportPoints);
  for (const key of ['involvementMode', 'showCluster', 'showHeatmap', 'showSchools', 'showKindergartens', 'showArgumentation']) {
    if (expected[key] !== undefined) expect(state[key], key).toBe(expected[key]);
  }
  if (expected.showCluster !== undefined) expect(state.clusterLayerVisible).toBe(expected.showCluster);
  if (expected.showHeatmap !== undefined) expect(state.heatLayerVisible).toBe(expected.showHeatmap);
  for (const [key, value] of Object.entries(expected.filters || {})) {
    expect(state.controls[key], `filter ${key}`).toBe(value);
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
  if (expected.minimumSelectionPoints) expect(state.selectionCount).toBeGreaterThanOrEqual(expected.minimumSelectionPoints);
  if (expected.minimumPoiFeatures) expect(state.poiFeatures).toBeGreaterThanOrEqual(expected.minimumPoiFeatures);
  if (expected.minimumVisiblePoiLayers) expect(state.visiblePoiLayers).toBeGreaterThanOrEqual(expected.minimumVisiblePoiLayers);
  if (expected.exportOpen) expect(state.export.open).toBe(true);
  if (expected.exportReady) {
    expect(state.export.progress).toContain('Fertig');
    expect(state.export.textLength).toBeGreaterThan(100);
  }
}

const publicDownloadContracts = [
  {
    id: 'csv', selector: '#btnExportCSV', extension: '.csv', minimumBytes: 30,
    validate(bytes) {
      const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
      expect(text.split(/\r?\n/).filter(Boolean).length).toBeGreaterThan(1);
      expect(/[;,]/.test(text.split(/\r?\n/, 1)[0])).toBe(true);
    },
    contentType: 'text/csv',
  },
  {
    id: 'geojson', selector: '#btnExportGeoJSON', extension: '.geojson', minimumBytes: 50,
    validate(bytes) {
      const value = JSON.parse(bytes.toString('utf8'));
      expect(value.type).toBe('FeatureCollection');
      expect(value.features?.length).toBeGreaterThan(0);
    },
    contentType: 'application/geo+json',
  },
  {
    id: 'kml', selector: '#btnExportKML', extension: '.kml', minimumBytes: 50,
    validate(bytes) {
      const text = bytes.toString('utf8');
      expect(text).toMatch(/<kml\b/i);
      expect(text).toMatch(/<Placemark\b/i);
    },
    contentType: 'application/vnd.google-earth.kml+xml',
  },
];

async function exercisePublicDownloads(page, scenario, diagnostics, testInfo) {
  expect(diagnostics.state.export.publicPreview).toBe('public-preview-core-v1');
  expect(diagnostics.state.export.noticeVisible).toBe(true);
  expect(diagnostics.state.export.noticeText).toMatch(/Word\/PDF.*deaktiviert/i);
  expect(diagnostics.state.export.antragGroupHidden).toBe(true);
  expect(diagnostics.state.export.wordDisabled).toBe(true);
  expect(diagnostics.state.export.pdfDisabled).toBe(true);

  for (const contract of publicDownloadContracts) {
    const button = page.locator(contract.selector);
    await expect(button).toBeVisible();
    await expect(button).toBeEnabled();
    const pending = page.waitForEvent('download', { timeout: 60000 });
    await button.click();
    const download = await pending;
    expect(await download.failure(), `${contract.id} download failure`).toBeNull();
    const filename = download.suggestedFilename();
    expect(filename.toLowerCase().endsWith(contract.extension)).toBe(true);
    const target = resolve(outputDir, `${scenario.id}-${contract.id}${contract.extension}`);
    await download.saveAs(target);
    const bytes = readFileSync(target);
    expect(bytes.length, `${contract.id} byte size`).toBeGreaterThanOrEqual(contract.minimumBytes);
    contract.validate(bytes);
    diagnostics.downloads.push({ id: contract.id, selector: contract.selector, filename, bytes: bytes.length });
    await testInfo.attach(`${scenario.id}-${contract.id}`, { path: target, contentType: contract.contentType });
  }
}

async function persistEvidence(page, scenario, diagnostics, testInfo) {
  diagnostics.evidenceErrors ||= [];
  if (!diagnostics.state) {
    try { diagnostics.state = await readLiveState(page); }
    catch (error) { diagnostics.evidenceErrors.push(`state: ${error?.message || error}`); }
  }
  try { await page.screenshot({ path: resolve(outputDir, `${scenario.id}.png`), fullPage: true }); }
  catch (error) { diagnostics.evidenceErrors.push(`screenshot: ${error?.message || error}`); }
  writeFileSync(resolve(outputDir, `${scenario.id}.json`), `${JSON.stringify(diagnostics, null, 2)}\n`);
  await testInfo.attach(`${scenario.id}-state`, {
    body: Buffer.from(JSON.stringify(diagnostics, null, 2)), contentType: 'application/json',
  });
}

test.describe.serial('README screenshot deep links – published application', () => {
  test.use({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
  for (const scenario of scenarios) {
    test(`${scenario.id}: ${scenario.description}`, async ({ page }, testInfo) => {
      test.setTimeout(scenario.expected.verifyDownloads ? 240000 : 120000);
      const diagnostics = {
        scenario: scenario.id, imagePath: scenario.imagePath, url: scenario.url,
        references: scenario.references, pageErrors: [], consoleErrors: [],
        sameOriginHttpErrors: [], externalRequestFailures: [], downloads: [], state: null, failure: null,
      };
      const liveOrigin = new URL(scenario.url).origin;
      page.on('pageerror', (error) => diagnostics.pageErrors.push(String(error?.stack || error)));
      page.on('console', (message) => { if (message.type() === 'error') diagnostics.consoleErrors.push(message.text()); });
      page.on('response', (response) => {
        let origin = null;
        try { origin = new URL(response.url()).origin; } catch (_) {}
        if (origin === liveOrigin && response.status() >= 400) diagnostics.sameOriginHttpErrors.push({ status: response.status(), url: response.url() });
      });
      page.on('requestfailed', (request) => {
        let origin = null;
        try { origin = new URL(request.url()).origin; } catch (_) {}
        const item = { url: request.url(), failure: request.failure()?.errorText || 'unknown' };
        (origin === liveOrigin ? diagnostics.sameOriginHttpErrors : diagnostics.externalRequestFailures).push(item);
      });
      try {
        await page.goto(scenario.url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await page.waitForFunction((city) => {
          const ctx = window.UA?.getRuntimeContext?.();
          const stat = String(document.getElementById('stat')?.textContent || '');
          return Boolean(ctx?.map && ctx.ui && ctx.CITY_RAW === city && ctx.allPts?.length > 0 &&
            Array.isArray(ctx.filteredAll) && Array.isArray(ctx.viewportPts) &&
            document.getElementById('citySel')?.value === city && !/Daten werden geladen|wird geladen/i.test(stat));
        }, scenario.expected.city, { timeout: 90000 });
        if (scenario.expected.exportReady) {
          await page.locator('#modalOverlay').waitFor({ state: 'visible', timeout: 60000 });
          await page.waitForFunction(() => String(document.getElementById('exportProgress')?.textContent || '').includes('Fertig'), null, { timeout: 60000 });
        }
        await page.waitForTimeout(750);
        diagnostics.state = await readLiveState(page);
        assertState(scenario, diagnostics.state);
        if (scenario.expected.verifyDownloads) await exercisePublicDownloads(page, scenario, diagnostics, testInfo);
        expect(diagnostics.pageErrors, 'uncaught page errors').toEqual([]);
        expect(diagnostics.consoleErrors, 'console errors').toEqual([]);
        expect(diagnostics.sameOriginHttpErrors, 'live application HTTP/resource errors').toEqual([]);
      } catch (error) {
        diagnostics.failure = { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || null };
        throw error;
      } finally {
        await persistEvidence(page, scenario, diagnostics, testInfo);
      }
    });
  }
});
