'use strict';

const { test, expect } = require('@playwright/test');

// Keep this URL aligned with the canonical defaults from
// ua.video-export-contract.js plus the context-overlay fixture used by the
// Testcontainers video-export integration test. That makes a document failure
// observable in the much faster browser suite instead of only after five
// 90-second download timeouts in the animation pipeline.
const CONTEXT_URL =
  '/werkbank_v2.html?city=Bonn' +
  '&severity=all' +
  '&includeCyclist=1&includePedestrian=1&includeCar=1' +
  '&includeMotorcycle=0&includeGkfz=0&includeSonstig=0' +
  '&involvementMode=or&hourFrom=0&hourTo=23' +
  '&dayType=all&roadCondition=all' +
  '&maxPoints=100000&viewportPaddingPct=20&heatRadius=25' +
  '&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
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

async function waitForDownloadOrVisibleFailure(page, button, dialogMessages) {
  const downloadPromise = page.waitForEvent('download', { timeout: 90_000 })
    .then(download => ({ download }));
  const failurePromise = page.waitForFunction(() => {
    const text = String(document.querySelector('#exportProgress')?.textContent || '');
    return /^Fehler:/i.test(text) ? text : false;
  }, null, { timeout: 90_000 }).then(handle => handle.jsonValue())
    .then(error => ({ error }));

  await button.click();
  const outcome = await Promise.race([downloadPromise, failurePromise]);
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
    const dialogMessages = [];
    page.on('dialog', async (dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });

    await page.goto(CONTEXT_URL, { waitUntil: 'domcontentloaded' });
    await waitForWorkbench(page);

    const snapshot = await page.evaluate(async () => {
      const ctx = window.UA.getRuntimeContext();
      const result = await window.UA.documentExportProvenanceRuntime.createSnapshot(ctx);
      const query = new URL(window.location.href).searchParams;
      return {
        artifactId: result.manifest.artifactId,
        hash: result.sourceManifestSha256,
        filters: result.manifest.scenario.filters,
        runtime: {
          showCluster: ctx.showCluster,
          showHeatmap: ctx.showHeatmap,
          showOnlyAboveAverage: ctx.showOnlyAboveAverage,
          maxPoints: Number(query.get('maxPoints')),
          viewportPaddingPct: Number(query.get('viewportPaddingPct')),
          heatRadius: Number(query.get('heatRadius')),
        },
      };
    });
    expect(snapshot.artifactId).toMatch(/^unfallwerkbank-bonn-/);
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.filters.contextSlopeClasses).toEqual(['steep', 'very_steep']);
    expect(snapshot.filters.contextTrafficClasses).toEqual(['high', 'very_high']);
    expect(snapshot.filters.onlyMatchedWays).toBe(true);
    expect(snapshot.runtime).toEqual({
      showCluster: true,
      showHeatmap: false,
      showOnlyAboveAverage: false,
      maxPoints: 100000,
      viewportPaddingPct: 20,
      heatRadius: 25,
    });

    await page.locator('#btnOpenExport').click();
    await expect(page.locator('#modalOverlay .modal')).toBeVisible();
    await page.waitForFunction(() => {
      const text = String(document.querySelector('#exportProgress')?.textContent || '');
      return text === 'Fertig.' || /^Fehler/i.test(text);
    }, null, { timeout: 60_000 });
    expect(await page.locator('#exportProgress').innerText()).toBe('Fertig.');

    await scrollPreviewLikeVideoExporter(page);
    const download = await waitForDownloadOrVisibleFailure(
      page,
      page.locator('#btnExportPDF'),
      dialogMessages,
    );
    expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    expect(dialogMessages).toEqual([]);
  });
});
