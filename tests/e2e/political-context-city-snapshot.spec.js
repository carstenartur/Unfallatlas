import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { writeRisSnapshot } from '../../server/political-context/services/risSnapshot.js';

const SIM = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
const BONN = 'https://www.bonn.sitzung-online.de/';

async function provideSnapshot(page, testInfo, city, sources, records) {
  const directory = testInfo.outputPath('ris');
  const manifest = await writeRisSnapshot(directory, city, {
    sources, records,
    coverage: {
      from: '2026-01-01', to: '2026-11-07', bodies: ['Ratsversammlung'],
      complete: false, warnings: ['Ausgewählte Gremien und Sitzungen']
    }
  });
  const assets = new Set([`${city}.json`, manifest.records.path, manifest.map.path]);
  const requests = [];
  await page.route('**/data/ris/*', async route => {
    const file = path.posix.basename(new URL(route.request().url()).pathname);
    requests.push({ file, method: route.request().method() });
    if (!assets.has(file)) return route.fulfill({ status: 404 });
    return route.fulfill({
      body: await readFile(path.join(directory, file)),
      contentType: file.endsWith('.gz') ? 'application/gzip' : 'application/json'
    });
  });
  return { manifest, requests };
}

async function openPublicWerkbank(page, query) {
  await page.goto(`/werkbank_v2.html?${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(
    window.UA?.getRuntimeContext?.()?.map && window.UA?.PoliticalContext?._runSearch
  ), null, { timeout: 45_000 });
  if (!await page.evaluate(() => Boolean(window.UA.PUBLIC_DISTRIBUTION_PROFILE))) {
    await page.addScriptTag({ url: 'js/ua.public-preview.js' });
  }
}

test('Hannover searches the published index and exports the linked SIM documents', async ({ page }, testInfo) => {
  test.setTimeout(80_000);
  const original = {
    id: 'hannover-sim:1047-2026', number: '1047/2026',
    title: 'Radwegeausbau am Lindener Stichkanal und am Mittellandkanal',
    type: 'Anfrage', date: null, gremium: 'Ratsversammlung', source: 'hannover-sim',
    url: SIM + 'DS/1047-2026'
  };
  const answer = {
    id: 'hannover-sim:1047-2026F1', number: '1047/2026 F1',
    title: 'Antwort der Verwaltung zum Radwegeausbau', type: 'Verwaltungsantwort',
    date: null, gremium: 'Ratsversammlung', source: 'hannover-sim',
    url: SIM + 'DS/1047-2026F1', relatedTo: original.id
  };
  const { manifest, requests } = await provideSnapshot(page, testInfo, 'hannover', [SIM], [original, answer]);
  const external = [];
  await page.route(/\/api\/political-context\/search|sitzung-online\.de\/oparl/, route => {
    external.push(route.request().url());
    return route.abort();
  });
  await openPublicWerkbank(page, 'city=Hannover');
  expect(requests).toEqual([]);

  await page.locator('#btnPolCtxOpen').click();
  await page.locator('#polCtxSearchInput').fill('Lindener Stichkanal');
  await page.locator('#polCtxBtnSearch').click();
  const results = page.locator('#polCtxResults');
  await expect(results.locator('.polCtxRef')).toHaveCount(2);
  await expect(results).toContainText('Gehört zu Drucksache 1047/2026');
  await expect(results.getByRole('link').nth(1)).toHaveAttribute('href', answer.url);
  for (const checkbox of await results.getByRole('checkbox').all()) await checkbox.check();
  await page.locator('#polCtxBtnAdopt').click();
  await expect.poll(() => page.evaluate(() => window.UA.getRuntimeContext().politicalReferences?.length)).toBe(2);
  const report = await page.evaluate(async () => {
    const ctx = window.UA.getRuntimeContext();
    const result = await window.UA.computeExportReport(ctx);
    return { references: result.structured.politicalReferences, text: result.text };
  });
  expect(report.references).toEqual(expect.arrayContaining([
    expect.objectContaining({ number: original.number, url: original.url }),
    expect.objectContaining({ number: answer.number, url: answer.url, relatedTo: original.id,
      snapshot: expect.objectContaining({ sha256: manifest.records.sha256 }) })
  ]));
  expect(report.text).toContain(answer.url);
  expect(requests.map(request => request.file)).toEqual(['hannover.json', manifest.records.path, 'hannover.json']);
  expect(requests.every(request => request.method === 'GET')).toBe(true);
  expect(external).toEqual([]);
});

test('Hannover opens the selected junction from a search result with several places', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const junction = 'Limmerstraße / Kötnerholzweg';
  const evidence = `An der Kreuzung ${junction} wird eine Querungshilfe eingerichtet.`;
  const coordinates = [9.7039, 52.3728];
  await provideSnapshot(page, testInfo, 'hannover', [SIM], [{
    id: 'hannover-sim:15-1570-2026', number: '15-1570/2026',
    title: 'Querungen in Linden verbessern', type: 'Antrag', date: null,
    gremium: 'Bezirksrat Linden-Limmer', source: 'hannover-sim', url: SIM + 'DS/15-1570-2026',
    locations: [{
      label: 'Limmerstraße', kind: 'street', evidence: { source: 'document', text: 'Maßnahmen in der Limmerstraße' },
      geometry: { type: 'LineString', coordinates: [[9.697, 52.374], [9.710, 52.371]] }
    }, {
      label: junction, kind: 'junction', evidence: { source: 'document', text: evidence },
      geometry: { type: 'Point', coordinates }
    }]
  }]);
  await openPublicWerkbank(page, 'city=Hannover&centerLat=52.38&centerLon=9.74&zoom=15');
  await page.locator('#btnPolCtxOpen').click();
  await page.locator('#polCtxSearchInput').fill('Kötnerholzweg');
  await page.locator('#polCtxBtnSearch').click();
  const results = page.locator('#polCtxResults');
  await expect(results.getByRole('button', { name: /^Auf Karte zeigen:/ })).toHaveCount(2);
  await results.getByRole('button', { name: `Auf Karte zeigen: ${junction}`, exact: true }).click();

  await expect(page.locator('#polCtxPanel')).toBeHidden();
  await expect(page.locator('.ua-ris-point')).toBeFocused();
  const popup = page.locator('.leaflet-popup');
  await expect(popup).toContainText(`Kreuzung · ${junction}`);
  await expect(popup).toContainText(`Beleg im Dokument: „${evidence}“`);
  const openedPoint = await page.evaluate(() => {
    const { map } = window.UA.getRuntimeContext();
    let coordinates;
    map.eachLayer(layer => {
      if (layer.feature?.geometry.type === 'Point' && layer.isPopupOpen?.()) {
        const { lng, lat } = layer.getLatLng();
        coordinates = [lng, lat];
      }
    });
    return coordinates;
  });
  expect(openedPoint).toEqual(coordinates);
});

test('Bonn loads the optional map layer and offers official links in its popup', async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const title = 'Bau Straße Am Hauptbahnhof';
  const url = BONN + 'public/VO020?VOLFDNR=2028602';
  const { manifest, requests } = await provideSnapshot(page, testInfo, 'bonn', [BONN], [{
    id: 'bonn-oparl:2028602', number: '260920-01 ST', title, type: 'Verwaltungsantwort',
    date: '2026-08-24', gremium: null, source: 'bonn-oparl', url,
    geometry: { type: 'Point', coordinates: [7.0950, 50.7330] },
    locationSource: 'derived', locationLabel: 'Straßenlage zur Orientierung'
  }]);
  await openPublicWerkbank(page, 'city=Bonn&centerLat=50.7330&centerLon=7.0950&zoom=15');
  const layer = page.getByRole('checkbox', { name: 'Ratsvorgänge', exact: true });
  await expect(layer).toBeVisible();
  await expect(layer).not.toBeChecked();
  expect(requests).toEqual([]);
  await layer.check();
  await page.locator('.ua-ris-point').click();
  const popup = page.locator('.leaflet-popup');
  await expect(popup).toContainText('Abgeleitete Lage');
  await expect(popup.getByRole('link', { name: `Amtliches Dokument: ${title}` })).toHaveAttribute('href', url);
  await popup.getByRole('button', { name: `${title} für Bericht übernehmen` }).click();
  await expect.poll(() => page.evaluate(() =>
    window.UA.getRuntimeContext().politicalReferences?.[0]?.number
  )).toBe('260920-01 ST');
  expect(requests.map(request => request.file)).toEqual(['bonn.json', manifest.records.path, manifest.map.path, 'bonn.json']);
  await layer.uncheck();
  await expect(page.locator('.ua-ris-point')).toHaveCount(0);
});

if (process.env.PAGES_REFRESH_RIS === '1') {
  test('the built site serves the official acceptance records and street geometries', async ({ page }) => {
    test.setTimeout(80_000);
    await openPublicWerkbank(page, 'city=Hannover');
    const evidence = await page.evaluate(async () => {
      const catalogue = window.UA.RisCatalogue;
      const [bonn, hannover] = await Promise.all([catalogue.loadMap('Bonn'), catalogue.loadMap('Hannover')]);
      const bonnPaper = bonn.records.find(record => record.number === '260920-01 ST');
      const enquiry = hannover.records.find(record => record.number === '1047/2026');
      const answer = hannover.records.find(record => record.number === '1047/2026 F1');
      const limmerstrasse = hannover.records.find(record => record.number === '15-1570/2026');
      const hasGeometry = (bundle, record) => bundle.features.features.some(feature =>
        feature.properties.recordId === record?.id && feature.geometry.type.includes('LineString')
      );
      return {
        bonnUrl: bonnPaper?.url,
        bonnLine: hasGeometry(bonn, bonnPaper),
        enquiryUrl: enquiry?.url,
        answerUrl: answer?.url,
        linked: Boolean(enquiry && answer?.relatedTo === enquiry.id),
        hannoverLine: hasGeometry(hannover, limmerstrasse)
      };
    });
    expect(evidence).toEqual({
      bonnUrl: BONN + 'public/VO020?VOLFDNR=2028602', bonnLine: true,
      enquiryUrl: SIM + 'DS/1047-2026', answerUrl: SIM + 'DS/1047-2026F1',
      linked: true, hannoverLine: true
    });
  });
}
