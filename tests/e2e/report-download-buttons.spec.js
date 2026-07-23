import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const outputDir = resolve(process.cwd(), 'out/qa/report-button-downloads');
const standardTile = readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/standard.svg'));
const bonnReverse = readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/nominatim-reverse-bonn.json'));
const corsHeaders = { 'access-control-allow-origin': '*' };

async function routeDeterministicExportInputs(page) {
  await page.route(/^https:\/\//, async (route) => {
    const url = new URL(route.request().url());
    if (/(^|\.)tile\.openstreetmap\.org$/i.test(url.hostname)) {
      await route.fulfill({
        status: 200,
        contentType: 'image/svg+xml',
        headers: corsHeaders,
        body: standardTile,
      });
      return;
    }
    if (url.hostname === 'nominatim.openstreetmap.org') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: corsHeaders,
        body: bonnReverse,
      });
      return;
    }
    await route.continue();
  });
}

async function downloadAndVerify(page, testInfo, contract) {
  const button = page.locator(contract.selector);
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
  const pending = page.waitForEvent('download', { timeout: 180000 });
  await button.click();
  const download = await pending;
  expect(await download.failure(), `${contract.id} download failure`).toBeNull();
  const filename = download.suggestedFilename();
  expect(filename.toLowerCase().endsWith(contract.extension)).toBe(true);
  const target = resolve(outputDir, `full-build-${contract.id}${contract.extension}`);
  await download.saveAs(target);
  const bytes = readFileSync(target);
  expect(bytes.length, `${contract.id} byte size`).toBeGreaterThanOrEqual(contract.minimumBytes);
  contract.validate(bytes);
  await testInfo.attach(`full-build-${contract.id}`, { path: target, contentType: contract.contentType });
  return { id: contract.id, filename, bytes: bytes.length };
}

test('full site report buttons produce valid Word and PDF downloads', async ({ page }, testInfo) => {
  test.setTimeout(600000);
  mkdirSync(outputDir, { recursive: true });
  await routeDeterministicExportInputs(page);
  await page.goto(
    '/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1' +
      '&includeMotorcycle=0&involvementMode=and&showCluster=1&showHeatmap=0' +
      '&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all' +
      '&hourFrom=0&hourTo=23&centerLat=50.7326&centerLon=7.0963&zoom=16' +
      '&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010',
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(() => {
    const ctx = window.UA?.getRuntimeContext?.();
    return Boolean(ctx?.allPts?.length > 0 && ctx.viewportPts?.length > 0 && ctx.selectionBounds);
  }, null, { timeout: 90000 });

  // This is deterministic test setup rather than a user interaction: the
  // control intentionally lives inside the still-closed export modal. Set the
  // precondition in the DOM before opening so the first report render cannot
  // start an external Overpass request. The production click path still reads
  // the real checkbox state through rerenderExportReport().
  await page.locator('#cbIncludeOsmContext').evaluate((checkbox) => {
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.locator('#btnOpenExport').click();
  await page.locator('#modalOverlay').waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForFunction(() =>
    String(document.getElementById('exportProgress')?.textContent || '').includes('Fertig'),
  null, { timeout: 60000 });

  await expect(page.locator('#exportGroupAntrag')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.distributionProfile || null)).toBeNull();

  const contracts = [
    {
      id: 'word', selector: '#btnExportWord', extension: '.docx', minimumBytes: 10000,
      validate: (bytes) => expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]),
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    {
      id: 'pdf', selector: '#btnExportPDF', extension: '.pdf', minimumBytes: 5000,
      validate: (bytes) => expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-'),
      contentType: 'application/pdf',
    },
  ];
  const evidence = [];
  for (const contract of contracts) evidence.push(await downloadAndVerify(page, testInfo, contract));
  writeFileSync(resolve(outputDir, 'report-button-downloads.json'), `${JSON.stringify({ evidence }, null, 2)}\n`);
});
