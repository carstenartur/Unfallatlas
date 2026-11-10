import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const intersection = 'Brühlstraße / Escherstraße';

function checkMotion(text) {
  // Inspect the formal request and its reasons, before the maps or the statistics.
  // A correct caption in the annex must not hide a proposal about another pattern.
  const motion = text.replace(/\s+/g, ' ').match(/Beschlussvorschlag\s*:? (.+?Begründung.+?)(?:KURZBEWERTUNG|Anlagen 1 Karten|Anlage 1 [–-] Karten|DATENQUELLEN|$)/i)?.[1];
  expect(motion).toBeTruthy();
  expect(motion).toContain('Brühlstraße');
  expect(motion).toContain('Escherstraße');
  expect(motion).toMatch(/\b17\b/);
  expect(motion).toMatch(/2021.*2025/);
  expect(motion).toMatch(/Rad/i);
  expect(motion).toMatch(/Pkw/i);
  expect(motion).toMatch(/Abbiege/i);
  expect(motion).toMatch(/Unfallskizzen/i);
  expect(motion).toContain('Stadtbezirksrat Mitte');
  expect(motion).toMatch(/Wirkungskontrolle/i);
  expect(motion).not.toMatch(/Schienenrillen|Gleisquerungen/i);
}

async function readFirstPage(bytes) {
  const document = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true });
  try {
    const pdf = await document.promise;
    const firstPage = await pdf.getPage(1);
    const text = await firstPage.getTextContent();
    return text.items.map(item => item.str).join(' ');
  } finally {
    await document.destroy();
  }
}

async function readWordDocument(bytes) {
  const archive = await JSZip.loadAsync(bytes);
  const xml = await archive.file('word/document.xml').async('string');
  return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join(' ');
}

test('a Hannover network search carries its actual bicycle/car turning crashes into the motion, PDF and Word', async ({ page, baseURL }) => {
  test.setTimeout(120_000);
  const localOrigin = new URL(baseURL).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === localOrigin
    ? route.continue() : route.abort('blockedbyclient'));
  await page.goto('/werkbank_v2.html?city=Hannover', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.UA?.getRuntimeContext?.()?.accidentDataCoverage?.complete
    && !window.UA.isHydrating(), null, { timeout: 60000 });

  await page.locator('#btnDiscover').click();
  await expect(page.locator('#siteDiscoveryMode')).toHaveValue('network', { timeout: 30000 });
  await page.locator('#siteDiscoveryFromYear').selectOption('2021');
  await page.locator('#siteDiscoveryToYear').selectOption('2025');
  await page.locator('#siteDiscoveryType').selectOption('turning');
  await page.locator('#siteDiscoveryInvolvement').selectOption('bike-foot');
  await page.locator('#siteDiscoverySort').selectOption('pattern');
  await page.getByRole('button', { name: new RegExp(intersection) }).first().click();
  await expect(page.locator('.site-discovery-pattern')).toContainText('17 Fälle');
  const detail = page.locator('.site-discovery-detail');
  await expect(detail).toContainText('48 Fälle insgesamt im Rechteck');
  await expect(detail).toContainText(/11\.072 anderen Netzstellen desselben Typs/);

  const evidence = await page.evaluate(async () => {
    const { UA } = window;
    const report = await UA.computeExportReport(UA.getRuntimeContext());
    const { siteNetwork, discoveryFocus, evidenceCohorts } = report.structured;
    const rectangleInPeriod = evidenceCohorts.completeEvidenceCohort.rows.filter(row => row.year >= 2021 && row.year <= 2025);
    return {
      siteId: siteNetwork?.site.id,
      label: siteNetwork?.label,
      pattern: discoveryFocus?.key,
      years: [...new Set(discoveryFocus?.points.map(point => Number(point.props.year)))].sort(),
      matchingCases: discoveryFocus?.points.length,
      rectangleInPeriod: rectangleInPeriod.length,
      samePatternInRectangle: rectangleInPeriod.filter(row => row.involvementMask === 5 && [2, 3].includes(row.accidentType)).length,
      completeCases: evidenceCohorts.completeEvidenceCohort.count,
    };
  });
  expect(evidence).toEqual({
    siteId: 'j:60655478', label: intersection, pattern: 'turning:5', years: [2021, 2022, 2023, 2024, 2025],
    matchingCases: 17, samePatternInRectangle: 20, rectangleInPeriod: 28, completeCases: 48,
  });

  // The downloads exercise document text; map tile rendering has its own browser suite.
  await detail.getByRole('button', { name: 'Antragsentwurf für diese Stelle öffnen' }).click();
  await page.locator('#cbIncludeMap').uncheck();
  await expect(page.locator('#exportProgress')).toHaveText('Fertig.', { timeout: 30000 });
  const preview = await page.locator('#exportBoxTa').inputValue();
  checkMotion(preview);
  const summary = preview.split('KURZBEWERTUNG:')[1]?.trim().split(/\r?\n/);
  expect(summary?.[0]).toContain(intersection);
  expect(summary[0]).toContain('Rad + Pkw');
  expect(summary[1]).toMatch(/\b17 Fälle/);

  for (const [selector, extract] of [['#btnExportPDF', readFirstPage], ['#btnExportWord', readWordDocument]]) {
    const [file] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
    const bytes = await readFile(await file.path());
    checkMotion(await extract(bytes));
  }
});
