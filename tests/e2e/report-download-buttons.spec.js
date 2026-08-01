import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const outputDir = resolve(process.cwd(), 'out/qa/report-button-downloads');
const standardTile = readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/map-tiles/standard.svg'));
const bonnReverse = readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/network/nominatim-reverse-bonn.json'));
const corsHeaders = { 'access-control-allow-origin': '*' };
const FULL_SHA256 = /\b[a-f0-9]{64}\b/i;
const RAW_URL = /https?:\/\/\S+/i;

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

function wordVisibleText(documentXml) {
  return [...documentXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
    .map((match) => match[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function auditDocx(bytes) {
  const archive = await JSZip.loadAsync(bytes);
  const required = [
    '[Content_Types].xml',
    'word/document.xml',
    'word/_rels/document.xml.rels',
    'docProps/custom.xml',
  ];
  required.forEach((name) => expect(archive.file(name), `DOCX part ${name}`).not.toBeNull());

  const documentXml = await archive.file('word/document.xml').async('string');
  const relationshipsXml = await archive.file('word/_rels/document.xml.rels').async('string');
  const customXml = await archive.file('docProps/custom.xml').async('string');
  const visible = wordVisibleText(documentXml);

  expect(visible).toContain('DATENQUELLEN, METHODIK UND NACHVOLLZIEHBARKEIT');
  expect(visible).not.toContain('ANLAGEN');
  expect(visible).not.toMatch(/Anlage [1-3]:/);
  expect(visible).not.toMatch(FULL_SHA256);
  expect(visible).not.toMatch(RAW_URL);
  expect(documentXml).toContain('<w:tblHeader');
  expect(documentXml).toContain('<w:cantSplit');
  expect(relationshipsXml).toMatch(/Type="[^"]*\/hyperlink"[^>]*TargetMode="External"/);
  expect(customXml).toContain('UnfallwerkbankSourceManifestSha256');
  expect(customXml).toContain('UnfallwerkbankSourceManifest');
  const manifestHash = customXml.match(FULL_SHA256)?.[0] || null;
  expect(manifestHash).toMatch(FULL_SHA256);
  expect(visible).toContain(manifestHash.slice(0, 12));

  return {
    format: 'docx',
    manifestHash,
    tableHeaderCount: (documentXml.match(/<w:tblHeader/g) || []).length,
    cantSplitCount: (documentXml.match(/<w:cantSplit/g) || []).length,
    hyperlinkCount: (relationshipsXml.match(/TargetMode="External"/g) || []).length,
  };
}

function metadataValue(info, name) {
  return Object.entries(info || {})
    .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] || null;
}

async function auditPdf(bytes) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  const visiblePages = [];
  const urls = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const text = await page.getTextContent();
    visiblePages.push(text.items.map((item) => item.str).join(' '));
    for (const annotation of await page.getAnnotations()) {
      if (annotation.url) urls.push(annotation.url);
      else if (annotation.unsafeUrl) urls.push(annotation.unsafeUrl);
    }
  }
  const visible = visiblePages.join('\n').replace(/\s+/g, ' ').trim();
  const metadata = await pdf.getMetadata();
  const markInfo = typeof pdf.getMarkInfo === 'function' ? await pdf.getMarkInfo() : null;
  const manifestHash = metadataValue(metadata.info, 'UnfallwerkbankSourceManifestSha256');
  const manifestJson = metadataValue(metadata.info, 'UnfallwerkbankSourceManifest');

  expect(visible).toContain('DATENQUELLEN, METHODIK UND NACHVOLLZIEHBARKEIT');
  expect(visible).not.toContain('ANLAGEN');
  expect(visible).not.toMatch(/Anlage [1-3]:/);
  expect(visible).not.toMatch(FULL_SHA256);
  expect(visible).not.toMatch(RAW_URL);
  expect(manifestHash).toMatch(FULL_SHA256);
  expect(visible).toContain(manifestHash.slice(0, 12));
  expect(() => JSON.parse(manifestJson)).not.toThrow();
  expect(JSON.parse(manifestJson).sources.length).toBeGreaterThan(0);
  expect(urls.length).toBeGreaterThan(0);
  expect(markInfo?.Marked).toBe(true);

  return {
    format: 'pdf',
    pages: pdf.numPages,
    manifestHash,
    tagged: markInfo?.Marked === true,
    hyperlinkCount: urls.length,
  };
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
  const audit = await contract.validate(bytes);
  await testInfo.attach(`full-build-${contract.id}`, { path: target, contentType: contract.contentType });
  return { id: contract.id, filename, bytes: bytes.length, audit };
}

test('full site report buttons produce publication-ready Word and PDF downloads', async ({ page }, testInfo) => {
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
  await page.evaluate(() => {
    document.documentElement.dataset.mapSourceMode = 'fixture';
  });
  await page.waitForFunction(() => {
    const ctx = window.UA?.getRuntimeContext?.();
    return Boolean(ctx?.allPts?.length > 0 && ctx.viewportPts?.length > 0 && ctx.selectionBounds);
  }, null, { timeout: 90000 });

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
      validate: auditDocx,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    },
    {
      id: 'pdf', selector: '#btnExportPDF', extension: '.pdf', minimumBytes: 5000,
      validate: auditPdf,
      contentType: 'application/pdf',
    },
  ];
  const evidence = [];
  for (const contract of contracts) evidence.push(await downloadAndVerify(page, testInfo, contract));
  writeFileSync(resolve(outputDir, 'report-button-downloads.json'), `${JSON.stringify({ evidence }, null, 2)}\n`);
});
