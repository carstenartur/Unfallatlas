'use strict';

const { readFileSync } = require('node:fs');
const { gzipSync } = require('node:zlib');
const { test, expect } = require('@playwright/test');
const {
  VIDEO_EXPORT_CONTEXT_PARAMS,
  createVideoExportContextFixture,
} = require('../fixtures/videoExportContextFixture');

// Use the same state and accident data as the video-export container test.
// Live accident totals would change the number of PDF evidence maps.
const CONTEXT_URL =
  '/werkbank_v2.html?' + new URLSearchParams(VIDEO_EXPORT_CONTEXT_PARAMS).toString() +
  '&severity=all' +
  '&includeCyclist=1&includePedestrian=1&includeCar=1' +
  '&includeMotorcycle=0&includeGkfz=0&includeSonstig=0' +
  '&involvementMode=or&hourFrom=0&hourTo=23' +
  '&dayType=all&roadCondition=all' +
  '&maxPoints=100000&viewportPaddingPct=20&heatRadius=25' +
  '&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0';

async function routeVideoExportInputs(page) {
  const { geojson, ways, meta } = createVideoExportContextFixture();
  const resources = {
    'output_all_years_bonn.geojson': geojson,
    'ways_bonn.json': ways,
    'output_all_years_bonn.enrichment.meta.json': meta,
  };
  // Match the container fixture, which removes Bonn's published tile indexes.
  await page.route(/\/out\/(?:accidenttiles|ctxtiles)\/bonn\//, route =>
    route.fulfill({ status: 404, body: '' }));
  for (const [name, json] of Object.entries(resources)) {
    const body = gzipSync(JSON.stringify(json));
    await page.route(`**/out/${name}.gz`, route =>
      route.fulfill({ contentType: 'application/gzip', body }));
    await page.route(`**/out/${name}`, route => route.fulfill({ status: 404, body: '' }));
  }
  const headers = { 'access-control-allow-origin': '*' };
  await page.route(/^https:\/\/(?:[a-z]+\.)?tile\.openstreetmap\.org\//i, route => route.fulfill({
    path: require.resolve('./fixtures/map-tiles/standard.svg'), contentType: 'image/svg+xml', headers,
  }));
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({
    path: require.resolve('./fixtures/network/nominatim-reverse-bonn.json'), contentType: 'application/json', headers,
  }));
  await page.route('https://overpass-api.de/**', route => route.abort('blockedbyclient'));
}

async function waitForWorkbench(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#citySel');
    const ctx = window.UA?.getRuntimeContext?.();
    return select && select.options.length > 1 && ctx && Array.isArray(ctx.allPts) && ctx.allPts.length > 0;
  }, null, { timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.UA?.exportProvenanceReady), null, {
    timeout: 30_000,
  });
  await page.evaluate(async () => {
    await window.UA.exportProvenanceReady;
    if (window.UA.exportProvenanceError) throw window.UA.exportProvenanceError;
    if (window.UA.__documentExportProvenanceInstalled !== true) {
      throw new Error('Document export provenance was not installed');
    }
    if (window.UA.__documentExportPrewarmInstalled !== true) {
      throw new Error('Document export provenance prewarm was not installed');
    }
  });
}

async function waitForDownloadOrVisibleFailure(page, button, dialogMessages) {
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 })
    .then(download => ({ download }));
  const dialogPromise = page.waitForEvent('dialog', { timeout: 90_000 })
    .then(dialog => ({ error: dialog.message() }));
  const failurePromise = page.waitForFunction(() => {
    const text = String(document.querySelector('#exportProgress')?.textContent || '');
    return /^Fehler:/i.test(text) ? text : false;
  }, null, { timeout: 90_000 }).then(handle => handle.jsonValue())
    .then(error => ({ error }));

  await button.click();
  const outcome = await Promise.race([downloadPromise, failurePromise, dialogPromise]);
  if (outcome.error) {
    const dialogSuffix = dialogMessages.length ? ` Dialog: ${dialogMessages.join(' | ')}` : '';
    throw new Error(`${outcome.error}${dialogSuffix}`);
  }
  return outcome.download;
}

async function scrollPreviewLikeVideoExporter(page) {
  await page.locator('#exportHtml').evaluate(async (element) => {
    const maxScroll = Math.max(0, element.scrollHeight - element.clientHeight);
    for (let step = 0; step <= 12; step += 1) {
      element.scrollTop = Math.round(maxScroll * (step / 12));
      await new Promise(resolve => setTimeout(resolve, 80));
    }
  });
}

test.describe('document provenance with context-filtered state', () => {
  test('creates a PDF with the exact state used by video export', async ({ page }) => {
    // PDF generation routinely takes more than Playwright's 30-second default
    // on a cold CI runner. Keep the outer budget above the helper's 90-second
    // download/failure contract so that the contract, not the framework default,
    // decides the result.
    test.setTimeout(120_000);

    const dialogMessages = [];
    page.on('dialog', async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });

    await routeVideoExportInputs(page);
    await page.goto(CONTEXT_URL, { waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);

    const runtime = await page.evaluate(() => {
      const ctx = window.UA.getRuntimeContext();
      const query = new URL(window.location.href).searchParams;
      return {
        loadedAccidents: ctx.allPts.length,
        contextSlopeClasses: Array.from(ctx.contextFilters?.slopeClasses || []).sort(),
        contextTrafficClasses: Array.from(ctx.contextFilters?.trafficClasses || []).sort(),
        onlyMatchedWays: ctx.contextFilters?.onlyMatchedWays === true,
        showCluster: ctx.showCluster,
        showHeatmap: ctx.showHeatmap,
        showOnlyAboveAverage: ctx.showOnlyAboveAverage,
        maxPoints: Number(query.get('maxPoints')),
        viewportPaddingPct: Number(query.get('viewportPaddingPct')),
        heatRadius: Number(query.get('heatRadius')),
      };
    });
    expect(runtime).toEqual({
      loadedAccidents: 12,
      contextSlopeClasses: ['steep', 'very_steep'],
      contextTrafficClasses: ['high', 'very_high'],
      onlyMatchedWays: true,
      showCluster: true,
      showHeatmap: false,
      showOnlyAboveAverage: false,
      maxPoints: 100000,
      viewportPaddingPct: 20,
      heatRadius: 25,
    });

    // The capture-phase listener on this button starts manifest construction in
    // parallel with the existing report-preview computation.
    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay .modal')).toBeVisible();

    const snapshot = await page.evaluate(async () => {
      const ctx = window.UA.getRuntimeContext();
      const result = await window.UA.documentExportPrewarmRuntime.prewarm(ctx);
      return {
        artifactId: result.manifest.artifactId,
        hash: result.sourceManifestSha256,
        filters: result.manifest.scenario.filters,
      };
    });
    expect(snapshot.artifactId).toMatch(/^unfallwerkbank-bonn-/);
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.filters.contextSlopeClasses).toEqual(['steep', 'very_steep']);
    expect(snapshot.filters.contextTrafficClasses).toEqual(['high', 'very_high']);
    expect(snapshot.filters.onlyMatchedWays).toBe(true);

    await expect(page.locator('#cbIncludeMap')).toBeChecked();

    const progress = page.locator('#exportProgress');
    await expect(progress).toHaveText('Fertig.', { timeout: 60_000 });
    await scrollPreviewLikeVideoExporter(page);
    // A later render can replace the preview while the exporter scrolls it.
    await expect(progress).toHaveText('Fertig.', { timeout: 60_000 });
    const download = await waitForDownloadOrVisibleFailure(
      page,
      page.locator('#btnExportPDF'),
      dialogMessages,
    );
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    expect(readFileSync(filePath).subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(dialogMessages).toEqual([]);
  });
});
