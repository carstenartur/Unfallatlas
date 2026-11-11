import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const intersection = 'Brühlstraße / Escherstraße';
const councilSources = ['15-1243-2021', '15-2403-2022F1', '15-2377-2023F1'].map(id =>
  'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/' + id);

function checkMotion(text, hannoverWord = false) {
  // Inspect the formal request and its reasons, before the maps or the statistics.
  // A correct caption in the annex must not hide a proposal about another pattern.
  const normalized = text.replace(/\s+/g, ' ');
  const heading = hannoverWord ? /\bAntrag (?=Der Bezirksrat möge beschließen:)/ : /\bBeschlussvorschlag\s*:?\s*/i;
  const [cover, body] = normalized.split(heading);
  expect(cover).toContain('Prüfung und Verbesserung der Verkehrssicherheit im Bereich ' + intersection);
  if (hannoverWord) {
    expect(cover).toContain('Entwurf · Stand');
    expect(cover).toContain('An den Stadtbezirksrat Mitte');
    expect(cover).toContain('Sitzung am [Datum, falls bekannt]');
  }
  const [motion, rationale] = body?.match(/(.+?) Begründung\s*:? (.+?)(?:Amtliche Vorbefassung am Netzobjekt|KURZBEWERTUNG|Anlagen? 1\b|DATENQUELLEN|$)/i)?.slice(1) || [];
  expect(motion).toBeTruthy();
  expect(rationale).toBeTruthy();
  expect(motion).toContain('Brühlstraße');
  expect(motion).toContain('Escherstraße');
  expect(rationale).toMatch(/\b17 Fälle am Netzobjekt/i);
  expect(rationale).toMatch(/2021.*2025/);
  expect(motion).toMatch(/Rad/i);
  expect(motion).toMatch(/Pkw/i);
  expect(motion).toMatch(/Abbiege/i);
  expect(motion).toMatch(/Unfallskizzen/i);
  expect(motion).toContain('Stadtbezirksrat Mitte');
  expect(motion).toMatch(/Wirkungskontrolle/i);
  expect(motion).toContain('15-1243/2021');
  expect(motion).toMatch(/Aufpflasterung/i);
  expect(motion).toMatch(/15-2377\/2023\s*F1/);
  expect(motion).toMatch(/04\.12\.2023|2023-12-04/);
  expect(motion).toMatch(/Personalengpäss/i);
  expect(motion).toMatch(/(?:aktuell|heut)[^.!?]{0,180}Umsetzungsstand/i);
  expect(motion).toMatch(/für umgesetzte Schritte[^.!?]+Wirkung/i);
  expect(motion).toMatch(/für ausstehende Schritte[^.!?]+Termin/i);
  expect(motion).not.toMatch(/Schienenrillen|Gleisquerungen/i);
}

async function readPdf(bytes) {
  const document = pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true });
  try {
    const pdf = await document.promise;
    const paragraphs = [];
    const links = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const [content, annotations] = await Promise.all([page.getTextContent(), page.getAnnotations()]);
      paragraphs.push(content.items.map(item => item.str).join(' '));
      links.push(...annotations.map(annotation => annotation.url).filter(Boolean));
    }
    return { text: paragraphs.join(' '), links, title: (await pdf.getMetadata()).info.Title };
  } finally {
    await document.destroy();
  }
}

async function readWordDocument(bytes) {
  const archive = await JSZip.loadAsync(bytes);
  const xml = await archive.file('word/document.xml').async('string');
  const rels = await archive.file('word/_rels/document.xml.rels').async('string');
  const hyperlinks = new Set([...xml.matchAll(/<w:hyperlink\b[^>]*\br:id="([^"]+)"/g)].map(match => match[1]));
  const links = [...rels.matchAll(/<Relationship\b[^>]+>/g)].map(match => match[0])
    .filter(element => hyperlinks.has(element.match(/\bId="([^"]+)"/)?.[1]))
    .map(element => element.match(/\bTarget="([^"]+)"/)?.[1]);
  const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(match => match[1]).join(' ');
  const core = await archive.file('docProps/core.xml').async('string');
  const drawings = [...xml.matchAll(/<wp:docPr\b[^>]*>/g)].map(match => ({
    title: match[0].match(/\btitle="([^"]*)"/)?.[1],
    description: match[0].match(/\bdescr="([^"]*)"/)?.[1] || '',
  }));
  return { text, links, drawings, title: core.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1] };
}

test('a Hannover network search carries its actual bicycle/car turning crashes and council record into the motion, PDF and Word', async ({ page, baseURL }, testInfo) => {
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

  // Exercise the PDF text separately and inspect the Word download with its map appendix enabled.
  await detail.getByRole('button', { name: 'Antragsentwurf für diese Stelle öffnen' }).click();
  await page.locator('#cbIncludeMap').uncheck();
  await expect(page.locator('#exportProgress')).toHaveText('Fertig.', { timeout: 30000 });
  const preview = await page.locator('#exportBoxTa').inputValue();
  checkMotion(preview);
  const summary = preview.split('KURZBEWERTUNG:')[1]?.trim().split(/\r?\n/);
  expect(summary?.[0]).toContain(intersection);
  expect(summary[0]).toContain('Rad + Pkw');
  expect(summary[1]).toMatch(/\b17 Fälle/);

  for (const [selector, extract] of [['#btnExportPDF', readPdf], ['#btnExportWord', readWordDocument]]) {
    if (selector === '#btnExportWord') {
      await page.locator('#cbIncludeMap').check();
    }
    const [file] = await Promise.all([page.waitForEvent('download'), page.locator(selector).click()]);
    const path = testInfo.outputPath(file.suggestedFilename());
    await file.saveAs(path);
    const bytes = await readFile(path);
    const result = await extract(bytes);
    const { text, links, title } = result;
    checkMotion(text, selector === '#btnExportWord');
    expect(title).toContain(intersection);
    expect(links).toEqual(expect.arrayContaining(councilSources));
    if (selector === '#btnExportWord') {
      // External map services are intentionally unavailable in this CI case.
      expect(text).toContain('kein amtliches Luftbild verfügbar');
      expect(text).toContain('17 Unfälle an 12 veröffentlichten Unfallorten');
      const sheets = result.drawings.filter(image => /^Veröffentlichte Unfallorte auf K\d+$/.test(image.title));
      expect(sheets.map(sheet => sheet.title)).toEqual(['Veröffentlichte Unfallorte auf K1', 'Veröffentlichte Unfallorte auf K2']);
      expect(sheets[0].description.match(/A\d{3}/g)).toHaveLength(17);
      expect(sheets[1].description.match(/A\d{3}/g)).toHaveLength(31);
      const allIds = sheets.flatMap(image => image.description.match(/A\d{3}/g));
      expect(allIds).toHaveLength(48);
      expect(new Set(allIds).size).toBe(48);
      expect(text).toContain('Gleiche Koordinaten');
    }
  }
});
