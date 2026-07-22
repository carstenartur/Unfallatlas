'use strict';

const { test, expect } = require('@playwright/test');

const CONTEXT_URL =
  '/werkbank_v2.html?city=Bonn' +
  '&ctxSlope=steep%2Cvery_steep' +
  '&ctxTraffic=high%2Cvery_high' +
  '&ctxOnlyMatched=1' +
  '&mapLayer=slope%2Ctraffic' +
  '&centerLat=50.731500&centerLon=7.102500&zoom=15';

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
  });
}

async function waitForDownloadOrVisibleFailure(page, button) {
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 })
    .then(download => ({ download }));
  const failurePromise = page.waitForFunction(() => {
    const text = String(document.querySelector('#exportProgress')?.textContent || '');
    return /^Fehler:/i.test(text) ? text : false;
  }, null, { timeout: 90_000 }).then(handle => handle.jsonValue())
    .then(error => ({ error }));

  await button.click();
  const outcome = await Promise.race([downloadPromise, failurePromise]);
  if (outcome.error) throw new Error(outcome.error);
  return outcome.download;
}

test.describe('document provenance with context-filtered state', () => {
  test('creates a PDF with the same context state used by video export', async ({ page }) => {
    await page.goto(CONTEXT_URL, { waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);

    const snapshot = await page.evaluate(async () => {
      const ctx = window.UA.getRuntimeContext();
      const result = await window.UA.documentExportProvenanceRuntime.createSnapshot(ctx);
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

    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay .modal')).toBeVisible();
    await page.waitForFunction(() => {
      const text = String(document.querySelector('#exportProgress')?.textContent || '');
      return text === 'Fertig.' || /^Fehler/i.test(text);
    }, null, { timeout: 60_000 });

    const download = await waitForDownloadOrVisibleFailure(page, page.locator('#btnExportPDF'));
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
  });
});
