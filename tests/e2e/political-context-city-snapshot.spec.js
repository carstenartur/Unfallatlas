import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { writeRisSnapshot, enumerateSnapshotAssets } from '../../server/political-context/services/risSnapshot.js';

const SIM = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
const BONN = 'https://www.bonn.sitzung-online.de/';

async function provideSnapshot(page, testInfo, city, sources, records, options = {}) {
  const directory = testInfo.outputPath('ris');
  const manifest = await writeRisSnapshot(directory, city, {
    sources, records,
    coverage: {
      from: '2026-01-01', to: '2026-11-07', bodies: ['Ratsversammlung'],
      complete: false, warnings: ['Ausgewählte Gremien und Sitzungen']
    }
  }, options);
  const assets = new Set([`${city}.json`, ...(await enumerateSnapshotAssets(directory, manifest)).map(asset => asset.path)]);
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
  await page.setViewportSize({ width: 820, height: 1180 });
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
  await popup.getByRole('link', { name: 'Amtliches Dokument: Querungen in Linden verbessern' })
    .click({ trial: true, timeout: 5_000 });
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
  page.setDefaultTimeout(8_000);
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
  await expect.poll(() => page.evaluate(() => {
    const { map } = window.UA.getRuntimeContext();
    if (map._panAnim?._inProgress || map._animatingZoom) return false;
    let visibleOpenPoint = false;
    map.eachLayer(candidate => {
      if (candidate.feature?.geometry.type === 'Point' && candidate.isPopupOpen?.()) {
        visibleOpenPoint = map.getBounds().contains(candidate.getLatLng());
      }
    });
    return visibleOpenPoint;
  }), { timeout: 8_000 }).toBe(true);
  await expect(popup).toBeVisible();
  const bounds = await popup.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const panel = document.getElementById('panel').getBoundingClientRect();
    const settings = document.querySelector('.carte-control').getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      panelRight: panel.right, settingsLeft: settings.left, height: window.innerHeight };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(bounds.panelRight);
  expect(bounds.right).toBeLessThanOrEqual(bounds.settingsLeft);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  await popup.getByRole('button', { name: `${title} für Bericht übernehmen` }).click();
  await expect.poll(() => page.evaluate(() =>
    window.UA.getRuntimeContext().politicalReferences?.[0]?.number
  )).toBe('260920-01 ST');
  await expect(popup).toBeVisible();
  await testInfo.attach('settled-bonn-popup', { body: await page.screenshot(), contentType: 'image/png' });
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
      const [bonn, hannover] = await Promise.all([
        catalogue.loadManifest('Bonn'), catalogue.loadManifest('Hannover')
      ]);
      const [bonnPaper, enquiry, answer, limmerstrasse] = await Promise.all([
        catalogue.loadRecord('Bonn', 'https://www.bonn.sitzung-online.de/oparl/papers/2028602', { snapshot: bonn }),
        catalogue.loadRecord('Hannover', 'hannover-sim:1047-2026', { snapshot: hannover }),
        catalogue.loadRecord('Hannover', 'hannover-sim:1047-2026F1', { snapshot: hannover }),
        catalogue.loadRecord('Hannover', 'hannover-sim:15-1570-2026', { snapshot: hannover })
      ]);
      const hasGeometry = async (city, manifest, record) => {
        if (!record) return false;
        if (manifest.schemaVersion === 1) {
          const bundle = await catalogue.loadMap(city);
          return bundle.features.features.some(feature =>
            feature.properties.recordId === record.id && feature.geometry.type.includes('LineString')
          );
        }
        let page = 0;
        do {
          const links = await catalogue.loadRecordGeometries(city, record.id, page, { snapshot: manifest });
          if (!links.complete || links.missing.length) throw new Error(`Incomplete geometry links for ${record.id}`);
          const features = await Promise.all(links.geometryIds.map(id =>
            catalogue.loadGeometry(city, id, { snapshot: manifest })
          ));
          if (features.some(feature => feature?.geometry.type.includes('LineString'))) return true;
          page = links.nextPage;
        } while (page != null);
        return false;
      };
      return {
        bonnUrl: bonnPaper?.url,
        bonnLine: await hasGeometry('Bonn', bonn, bonnPaper),
        enquiryUrl: enquiry?.url,
        answerUrl: answer?.url,
        linked: Boolean(enquiry && answer?.relatedTo === enquiry.id),
        hannoverLine: await hasGeometry('Hannover', hannover, limmerstrasse)
      };
    });
    expect(evidence).toEqual({
      bonnUrl: BONN + 'public/VO020?VOLFDNR=2028602', bonnLine: true,
      enquiryUrl: SIM + 'DS/1047-2026', answerUrl: SIM + 'DS/1047-2026F1',
      linked: true, hannoverLine: true
    });
  });
}

test('partitioned catalogue keeps a dense mobile map lazy and pages documents, relatives and search', async ({ page }, testInfo) => {
  test.setTimeout(100_000);
  page.setDefaultTimeout(8_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const records = Array.from({ length: 196 }, (_, index) => ({
    id: `hannover-sim:paged-${String(index).padStart(3, '0')}`,
    number: `TEST-${index}/2026`, title: index < 96 ? `Schulweg ${index}` : `Schulweg Antwort ${index}`,
    type: index < 96 ? 'Antrag' : 'Verwaltungsantwort', date: null,
    gremium: 'Ratsversammlung', source: 'hannover-sim', url: SIM + `DS/paged-${index}`,
    ...(index < 96 ? {
      geometry: { type: 'Point', coordinates: [9.731, 52.376] },
      locationSource: 'official', locationLabel: 'Gemeinsamer Schulweg',
    } : { relatedTo: 'hannover-sim:paged-000' }),
  }));
  const { requests } = await provideSnapshot(page, testInfo, 'hannover', [SIM], records, { schemaVersion: 2 });
  await openPublicWerkbank(page, 'city=Hannover&centerLat=52.376&centerLon=9.731&zoom=15');
  const settings = page.getByRole('button', { name: 'Karte', exact: true });
  await test.step('isolate the dense council layer through Karte and retain lazy map loading', async () => {
    if (await settings.getAttribute('aria-expanded') === 'false') await settings.click();
    for (const id of ['toggleCluster', 'toggleHeat']) {
      const accidentLayer = page.locator('#' + id);
      if (await accidentLayer.getAttribute('aria-pressed') === 'true') await accidentLayer.click();
      await expect(accidentLayer).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(page.locator('.marker-cluster')).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Ratsvorgänge', exact: true }).check();
    await expect(page.locator('.ua-ris-point')).toHaveCount(1);
    expect(requests.some(({ file }) => /\.(records|locations|relations|links|search)\.json\.gz$/.test(file))).toBe(false);
    if (await settings.getAttribute('aria-expanded') === 'true') await settings.click();
  });

  const popup = page.locator('.ua-ris-popup');
  const documents = popup.getByRole('link', { name: /^Amtliches Dokument:/ });
  await test.step('open the accessible council point and load its first 64 documents', async () => {
    await page.locator('.ua-ris-point').click();
    await expect(documents).toHaveCount(64);
    await expect(popup.getByRole('button', { name: 'Weitere Vorgänge laden', exact: true })).toBeVisible();
  });
  const layout = await popup.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const content = element.querySelector('.leaflet-popup-content');
    const scrollable = [content, ...content.querySelectorAll('*')].some(node =>
      node.scrollHeight > node.clientHeight + 1 && ['auto', 'scroll'].includes(getComputedStyle(node).overflowY));
    const buttons = [...element.querySelectorAll('button')].filter(node => node.getClientRects().length);
    return { left: rect.left, right: rect.right, height: rect.height, scrollable,
      smallestButton: Math.min(...buttons.map(node => node.getBoundingClientRect().height)) };
  });
  expect(layout.left).toBeGreaterThanOrEqual(-1);
  expect(layout.right).toBeLessThanOrEqual(391);
  expect(layout.height).toBeLessThanOrEqual(380);
  expect(layout.scrollable).toBe(true);
  expect(layout.smallestButton).toBeGreaterThanOrEqual(44);
  await test.step('page 64 to 96 mapped documents and reveal all 100 unlocated relatives', async () => {
    await popup.getByRole('button', { name: 'Weitere Vorgänge laden', exact: true }).click();
    await expect(documents).toHaveCount(96);
    await popup.getByRole('button', { name: 'Verknüpfte Vorgänge anzeigen', exact: true }).first().click();
    await expect(popup).toContainText('Schulweg Antwort');
    await popup.getByRole('button', { name: 'Weitere verknüpfte Vorgänge laden', exact: true }).click();
    await expect(documents).toHaveCount(196);
  });
  await popup.locator('.leaflet-popup-close-button').click();

  const panel = page.locator('#collapseBtn');
  if (await panel.getAttribute('aria-expanded') === 'false') await panel.click();
  await page.locator('#btnPolCtxOpen').click();
  await page.locator('#polCtxSearchInput').fill('Schulweg');
  await page.locator('#polCtxBtnSearch').click();
  const results = page.locator('#polCtxResults');
  await test.step('page search 15 to 30 through its opaque cursor while retaining selection', async () => {
    await expect(results.locator('.polCtxRef')).toHaveCount(15);
    const selected = results.getByRole('checkbox').first();
    await selected.check();
    await results.getByRole('button', { name: 'Weitere Suchtreffer laden', exact: true }).click();
    await expect(results.locator('.polCtxRef')).toHaveCount(30);
    await expect(selected).toBeChecked();
  });
  await page.locator('#polCtxBtnAdopt').click();
  await expect.poll(() => page.evaluate(() => window.UA.getRuntimeContext().politicalReferences?.length)).toBe(1);
  expect(errors).toEqual([]);
});
