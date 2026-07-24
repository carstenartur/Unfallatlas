import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setupCDNRoutes } from './helpers.js';

const bonnReverse = readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/nominatim-reverse-bonn.json'));
const corsHeaders = { 'access-control-allow-origin': '*' };

const BONN_HBF_URL =
  '/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1' +
  '&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=0' +
  '&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all' +
  '&hourFrom=0&hourTo=23&centerLat=50.732211&centerLon=7.095119&zoom=16' +
  '&selSouth=50.730000&selWest=7.091000&selNorth=50.735500&selEast=7.101000' +
  '&maxPoints=100000&viewportPaddingPct=20&heatRadius=25&includeGkfz=0' +
  '&includeSonstig=0&showSchools=1&showKindergartens=1&showArgumentation=1';

function parseGermanCount(text, label) {
  const match = String(text || '').match(new RegExp(`${label}\\s*:?\\s*([\\d.\\s]+)`, 'i'));
  return Number(((match && match[1]) || '').replace(/\D/g, '')) || 0;
}

test('selection, visible map and export use explicit exact count scopes', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  await setupCDNRoutes(page);
  await page.route('https://nominatim.openstreetmap.org/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    headers: corsHeaders,
    body: bonnReverse,
  }));

  await page.goto(BONN_HBF_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const ctx = window.UA?.getRuntimeContext?.();
    return Boolean(window.UA?.AnalysisScope && ctx?.allPts?.length && ctx?.selectionBounds);
  }, null, { timeout: 90000 });

  const counts = await page.evaluate(() => {
    const UA = window.UA;
    const ctx = UA.getRuntimeContext();
    const scope = UA.AnalysisScope.refreshScopePoints(ctx);
    const selection = ctx.selectionBounds;
    return {
      cityLoaded: ctx.allPts.length,
      cityFiltered: scope.active.length,
      visible: scope.visible.length,
      selected: scope.selected.length,
      buffered: scope.buffered.length,
      context: UA.AnalysisScope.getContextAreaPoints(ctx, selection).length,
    };
  });

  expect(counts.selected).toBeGreaterThan(0);
  expect(counts.context).toBeGreaterThanOrEqual(counts.selected);
  expect(counts.buffered).toBeGreaterThanOrEqual(counts.visible);

  const status = await page.locator('#stat').textContent();
  expect(parseGermanCount(status, 'sichtbar')).toBe(counts.visible);
  expect(parseGermanCount(status, 'markierter Bereich')).toBe(counts.selected);
  expect(status).not.toContain('im Viewport');

  await page.locator('#cbIncludeOsmContext').evaluate(checkbox => {
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#btnOpenExport').click();
  await page.locator('#modalOverlay').waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    String(document.getElementById('exportProgress')?.textContent || '').includes('Fertig'),
  null, { timeout: 60000 });

  const scopeBox = page.locator('[data-ua-count-scope="active"]');
  await expect(scopeBox).toBeVisible();
  await expect(scopeBox).toContainText(`Aktive Auswahl im markierten Bereich: ${counts.selected.toLocaleString('de-DE')}`);
  await expect(scopeBox).toContainText(`Vor dem Beteiligungsfilter liegen im selben Gebiet ${counts.context.toLocaleString('de-DE')}`);

  const reportText = await page.locator('#exportHtml').textContent();
  expect(parseGermanCount(reportText, 'lokal')).toBe(counts.selected);

  await testInfo.attach('bonn-hbf-count-scope.json', {
    body: Buffer.from(`${JSON.stringify({
      scenario: 'Bonn Hbf – Rad + PKW, UND, markiertes Rechteck',
      bounds: { south: 50.730000, west: 7.091000, north: 50.735500, east: 7.101000 },
      counts,
      status,
    }, null, 2)}\n`, 'utf8'),
    contentType: 'application/json',
  });
});
