import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { writeRisSnapshot, enumerateSnapshotAssets } from '../../server/political-context/services/risSnapshot.js';
import { BASE_VIEW, ready } from './helpers/ris-shared-view-fixture.js';

test.use({ actionTimeout: 10_000 });

const pageErrors = new WeakMap();
test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on('pageerror', error => errors.push(error.message));
});
test.afterEach(async ({ page }, testInfo) => {
  const errors = pageErrors.get(page) || [];
  if (errors.length) await testInfo.attach('workspace-page-errors', {
    body: Buffer.from(JSON.stringify(errors, null, 2)), contentType: 'application/json',
  });
  expect(errors, 'Workspace navigation must not produce uncaught application errors').toEqual([]);
});

const CITY_SOURCE = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
const REGION_SOURCE = 'https://ris.hannit.de/public/';
const STATE_SOURCE = 'https://www.landtag-niedersachsen.de/';
const CITY_ID = 'hannover-sim:doc:workspace-city';
const REGION_ID = 'region-hannover-ris:vo:workspace-region';
const STATE_ID = 'niedersachsen-landtag:doc:workspace-state';
const UNKNOWN_ID = 'unbekanntes-archiv:doc:workspace-unknown';
const CITY_TITLE = 'Radweg in Hannover: kommunaler Antrag';
const REGION_TITLE = 'Radweg in der Region: abgestimmte Planung';
const STATE_TITLE = 'Radweg in Niedersachsen: Antwort des Landes';
const UNKNOWN_TITLE = 'Radweg: weitere Unterlage zu Stadt, Region und Land';
const EVENT_EVIDENCE = 'Der Ausschuss beschließt, die Radwegeplanung mit der Region Hannover abzustimmen. Der genaue Prüfauftrag bleibt Teil dieses amtlichen Belegs.';

const sourceContext = (level, publisher) => ({ level, publisher, issuer: null,
  documentKind: 'Antrag', status: 'proposal', publicationDate: null,
  documentDate: '2026-10-01', meetingDate: null });

// The fixture is published through the production writer so the browser still
// validates real schema-2 manifests, partitions, hashes and source hosts.
async function workspaceFixture(testInfo, { paginated = false } = {}) {
  const directory = testInfo.outputPath('ris-workspace-snapshot');
  const records = [{
    id: CITY_ID, title: CITY_TITLE, number: 'STADT-1/2026', type: 'Antrag',
    date: '2026-10-01', gremium: 'Stadtbezirksrat', source: 'hannover-sim',
    url: `${CITY_SOURCE}workspace-city`, sourceContext: sourceContext('city', 'Landeshauptstadt Hannover'),
    events: [{ date: '2026-10-12', body: 'Stadtbezirksrat', outcome: 'Mit Prüfauftrag beschlossen',
      url: `${CITY_SOURCE}workspace-sitzung`, evidence: EVENT_EVIDENCE }],
    relationships: [{ type: 'related', targetId: REGION_ID,
      targetUrl: `${REGION_SOURCE}vo020?VOLFDNR=workspace-region`, targetRole: 'proposal',
      label: REGION_TITLE, evidence: 'Der städtische Antrag verweist ausdrücklich auf die Planung der Region.' },
    { type: 'mentions', targetId: UNKNOWN_ID, targetUrl: `${CITY_SOURCE}workspace-unknown`,
      targetRole: null, label: UNKNOWN_TITLE,
      evidence: 'Eine weitere Unterlage wird amtlich erwähnt; ihre Quellenebene ist nicht dokumentiert.' }],
  }, {
    id: REGION_ID, title: REGION_TITLE, number: 'REGION-2/2026', type: 'Beschlussdrucksache',
    date: '2026-10-15', gremium: 'Regionsversammlung', source: 'region-hannover-ris',
    url: `${REGION_SOURCE}vo020?VOLFDNR=workspace-region`, sourceContext: sourceContext('region', 'Region Hannover'),
    events: [], relationships: [{ type: 'related', targetId: STATE_ID,
      targetUrl: `${STATE_SOURCE}dokumente/workspace-state`, targetRole: 'answer',
      label: STATE_TITLE, evidence: 'Die Regionsdrucksache nennt ausdrücklich die Antwort des Landes.' }],
  }, {
    id: STATE_ID, title: STATE_TITLE, number: 'LAND-3/2026', type: 'Antwort',
    date: '2026-10-20', gremium: 'Niedersächsischer Landtag', source: 'niedersachsen-landtag',
    url: `${STATE_SOURCE}dokumente/workspace-state`, sourceContext: sourceContext('state', 'Niedersächsischer Landtag'),
    events: [], relationships: [],
    geometry: { type: 'Point', coordinates: [9.743, 52.381] },
    locationSource: 'official', locationLabel: 'Amtlich verorteter Testvorgang',
  }, {
    id: UNKNOWN_ID, title: UNKNOWN_TITLE, number: 'ARCHIV-4/2026', type: 'Unterlage',
    date: '2026-10-21', gremium: null, source: 'unbekanntes-archiv',
    url: `${CITY_SOURCE}workspace-unknown`, events: [], relationships: [],
  }];
  if (paginated) {
    records.push(...Array.from({ length: 32 }, (_, index) => ({
      id: `niedersachsen-landtag:doc:workspace-page-${String(index).padStart(2, '0')}`,
      title: `Radweg: Landesunterlage ${index + 1}`, number: `LAND-P${index + 1}/2026`,
      type: 'Antrag', date: '2026-10-01', gremium: 'Niedersächsischer Landtag',
      source: 'niedersachsen-landtag', sourceContext: sourceContext('state', 'Niedersächsischer Landtag'),
      url: `${STATE_SOURCE}dokumente/workspace-page-${index}`, events: [], relationships: [],
    })));
  }
  const manifest = await writeRisSnapshot(directory, 'hannover', {
    sources: [CITY_SOURCE, REGION_SOURCE, STATE_SOURCE], records,
    coverage: { from: '2026-10-01', to: '2026-10-31', complete: false,
      bodies: ['Stadtbezirksrat', 'Regionsversammlung', 'Niedersächsischer Landtag'], warnings: ['Testbestand'] },
  }, { schemaVersion: 2 });
  const assets = new Set(['hannover.json', ...(await enumerateSnapshotAssets(directory, manifest)).map(asset => asset.path)]);
  return {
    async install(target) {
      const requests = [];
      // Match the public-pages builder: the real catalogue transport must be
      // installed before app hydration can restore an automatic shared search.
      // The canonical test server does not apply the public distribution profile.
      await target.route('**/werkbank_v2.html*', async route => {
        const response = await route.fetch();
        let html = await response.text();
        if (!html.includes('js/ua.public-preview.js')) {
          const appScript = /(<script src="js\/ua\.app_v2\.js[^>]*><\/script>)/;
          if (!appScript.test(html)) throw new Error('Missing public transport insertion point');
          html = html.replace(appScript, '<script src="js/ua.public-preview.js?v=4"></script>\n  $1');
        }
        await route.fulfill({ response, body: html });
      });
      await target.route('**/data/ris/*', async route => {
        const file = path.posix.basename(new URL(route.request().url()).pathname);
        requests.push(file);
        if (!assets.has(file)) return route.fulfill({ status: 404 });
        return route.fulfill({ body: await readFile(path.join(directory, file)),
          contentType: file.endsWith('.gz') ? 'application/gzip' : 'application/json' });
      });
      return requests;
    },
  };
}

async function captureEvidence(page, testInfo, name) {
  const body = await page.screenshot();
  const directory = path.resolve('out/qa/ris-workspace');
  const file = `${testInfo.project.name}-${name}`.replace(/[^a-zA-Z0-9_-]/g, '-');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${file}.png`), body);
  await testInfo.attach(name, { body, contentType: 'image/png' });
}

const resultCard = (page, id) => page.locator(`.polCtxRef[data-reference-id="${id}"]`);
const resultIds = page => page.locator('#polCtxResults .polCtxRef').evaluateAll(cards => cards.map(card => card.dataset.referenceId));
const mapView = page => page.evaluate(() => {
  const map = window.UA.getRuntimeContext().map;
  const center = map.getCenter();
  return { lat: center.lat, lng: center.lng, zoom: map.getZoom() };
});

async function search(page, level = '') {
  await page.locator('#polCtxSearchInput').fill('Radweg');
  await page.locator('#polCtxLevel').selectOption(level);
  await page.locator('#polCtxBtnSearch').click();
  await expect(page.locator('#polCtxBtnSearch')).toBeEnabled();
  await expect(page.locator('#polCtxStatus')).not.toContainText('Suche läuft');
}

async function expectFitsViewport(page, panel) {
  await expect(panel).toBeInViewport({ ratio: 1 });
  const bounds = await panel.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, bottom: box.bottom,
      width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  expect(bounds.overflow).toBe(false);
}

async function expectTouchTargets(controls) {
  for (const control of await controls.all()) {
    await expect(control).toBeVisible();
    expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44);
  }
}

test('desktop keeps compact results and the document beside an operable map', async ({ page }, testInfo) => {
  test.setTimeout(80_000);
  await page.setViewportSize({ width: 1512, height: 982 });
  const data = await workspaceFixture(testInfo);
  await data.install(page);
  await ready(page, `/werkbank_v2.html?${BASE_VIEW}`);
  await page.locator('#btnRisBrowse').click();
  const list = page.locator('#polCtxPanel');
  await expect(list).toBeVisible();
  await expect(list).toHaveClass(/ris-browser/);
  await expect(list).not.toHaveAttribute('aria-modal', 'true');
  await search(page);
  await expect(page.locator('#polCtxResults .polCtxRef')).toHaveCount(4);
  const city = resultCard(page, CITY_ID);
  await expect(city).toContainText('STADT-1/2026');
  await expect(city).toContainText('01.10.2026');
  await expect(city.locator('.ris-record-view__level')).toHaveAttribute('data-level', 'city');
  await expect(resultCard(page, UNKNOWN_ID).locator('.ris-record-view__level'))
    .toHaveAttribute('data-level', 'unknown');
  await expect(resultCard(page, UNKNOWN_ID)).toContainText('Ebene nicht angegeben');
  await city.locator('.polCtxCheck').check();
  const before = await mapView(page);
  await city.locator('[data-ris-open-record]').focus();
  await page.keyboard.press('Enter');
  const detail = page.locator('#risDetails');
  await expect(detail).toContainText(CITY_TITLE);
  await expect(list).toBeVisible();
  await expect(city).toHaveAttribute('aria-current', 'true');
  await expect(city.locator('.polCtxCheck')).toBeChecked();
  expect(await mapView(page)).toEqual(before);
  await expectFitsViewport(page, list);
  await expectFitsViewport(page, detail);
  const listBox = await list.boundingBox();
  const detailBox = await detail.boundingBox();
  expect(listBox.x + listBox.width <= detailBox.x || detailBox.x + detailBox.width <= listBox.x,
    'Desktop results and document must have separate horizontal space').toBe(true);
  const settings = page.getByRole('button', { name: 'Karte', exact: true });
  await expect(settings).toHaveAttribute('aria-expanded', 'false');
  const menuBox = await page.locator('.carte-control').boundingBox();
  expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(detailBox.x);
  await settings.click();
  await page.locator('#mapModeHybrid').click({ trial: true });
  await settings.click();
  await expectTouchTargets(page.locator('#polCtxBtnCollapse, #polCtxBtnClose, #polCtxBtnSearch, #polCtxLevel'));
  await expectTouchTargets(detail.locator('.ris-details__toolbar button'));
  await captureEvidence(page, testInfo, 'desktop-results-and-document');

  await page.locator('.leaflet-control-zoom-in').click();
  await expect.poll(async () => (await mapView(page)).zoom).toBe(before.zoom + 1);
  await expect(city.locator('.polCtxCheck')).toBeChecked();
  await page.locator('#polCtxBtnCollapse').click();
  await expect(list.locator('.ris-browser__body')).toBeHidden();
  await expect(detail).toBeVisible();
  await captureEvidence(page, testInfo, 'desktop-collapsed-list-and-map');
  await detail.getByRole('button', { name: 'Vorgangsansicht schließen', exact: true }).click();
  await page.locator('#polCtxBtnClose').click();
  await expect(list).toBeHidden();
  await page.locator('#btnPolCtxOpen').click();
  await expect(list).toBeVisible();
  await expect(page.locator('#polCtxSearchInput')).toHaveValue('Radweg');
});

test.describe('tablet workspace', () => {
  test.use({ hasTouch: true });

  for (const viewport of [{ width: 768, height: 1024 }, { width: 1366, height: 1024 }]) {
    test(`alternates results, document and Karte with a usable map at ${viewport.width}px`, async ({ page }, testInfo) => {
      test.setTimeout(80_000);
      await page.setViewportSize(viewport);
      const data = await workspaceFixture(testInfo);
      await data.install(page);
      await ready(page, `/werkbank_v2.html?${BASE_VIEW}`);
      const mapMenu = page.getByRole('button', { name: 'Karte', exact: true });
      const launcher = page.locator('#btnRisBrowse');
      const analysis = page.locator('#panel');
      const list = page.locator('#polCtxPanel');
      const documentPanel = page.locator('#risDetails');
      const city = resultCard(page, CITY_ID);

      await mapMenu.tap();
      await expect(mapMenu).toHaveAttribute('aria-expanded', 'true');
      await launcher.tap();
      await expect(list).toBeVisible();
      await expect(mapMenu).toHaveAttribute('aria-expanded', 'false');
      await expect(analysis).toBeHidden();
      expect((await list.boundingBox()).width).toBeLessThan(viewport.width / 2);
      await search(page, 'city');
      await city.locator('.polCtxCheck').check();
      await city.locator('[data-ris-open-record]').tap();
      await expect(documentPanel.locator('.ris-record-view__title')).toHaveText(CITY_TITLE);
      await expect(list).toBeHidden();
      await expect(analysis).toBeHidden();
      expect((await documentPanel.boundingBox()).width).toBeLessThan(viewport.width / 2);
      await expectFitsViewport(page, documentPanel);
      const selectedResult = city.locator('[data-ris-open-record]');
      const originalResult = await selectedResult.elementHandle();
      await documentPanel.getByRole('button', { name: 'Vorgangsansicht einklappen', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(list).toBeVisible();
      await expect(selectedResult).toBeFocused();
      expect(await originalResult.evaluate(element => element.isConnected)).toBe(true);
      expect(new URL(page.url()).searchParams.get('risRecord')).toBe(CITY_ID);
      await page.keyboard.press('Enter');
      await expect(documentPanel.locator('.ris-record-view__title')).toBeVisible();
      await page.locator('.leaflet-control-zoom-in').tap();
      await expect.poll(async () => (await mapView(page)).zoom).toBe(15);

      await mapMenu.tap();
      await expect(mapMenu).toHaveAttribute('aria-expanded', 'true');
      await expect(documentPanel.locator('.ris-details__body')).toBeHidden();
      await expect(list).toBeHidden();
      const query = new URL(page.url()).searchParams;
      expect(query.get('risRecord')).toBe(CITY_ID);
      expect(query.get('risQuery')).toBe('Radweg');
      expect(query.get('risLevels')).toBe('city');
      await launcher.tap();
      await expect(mapMenu).toHaveAttribute('aria-expanded', 'false');
      await expect(list).toBeVisible();
      await expect(city.locator('.polCtxCheck')).toBeChecked();
      await expect(city).toHaveAttribute('aria-current', 'true');
    });
  }
});

test.describe('mobile workspace', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('follows documented links across three levels and returns to the preserved result list', async ({ page }, testInfo) => {
    test.setTimeout(90_000);
    const data = await workspaceFixture(testInfo);
    await data.install(page);
    await ready(page, `/werkbank_v2.html?${BASE_VIEW}`);
    await page.locator('#btnRisBrowse').tap();
    const list = page.locator('#polCtxPanel');
    await search(page, 'city');
    await expect(page.locator('#polCtxResults .polCtxRef')).toHaveCount(1);
    const city = resultCard(page, CITY_ID);
    await city.locator('.polCtxCheck').check();
    await expectFitsViewport(page, list);
    await expectTouchTargets(page.locator('#polCtxBtnCollapse, #polCtxBtnClose, #polCtxBtnSearch, #polCtxLevel'));
    await captureEvidence(page, testInfo, 'mobile-filtered-results-390px');
    const before = await mapView(page);
    await city.locator('[data-ris-open-record]').tap();
    const detail = page.locator('#risDetails');
    await expect(detail).toContainText(CITY_TITLE);
    await expect(list).toBeHidden();
    await expectFitsViewport(page, detail);
    await expectTouchTargets(detail.locator('.ris-details__toolbar button'));
    await expect(detail.locator('.ris-record-view__header .ris-record-view__level')).toHaveAttribute('data-level', 'city');
    await captureEvidence(page, testInfo, 'mobile-document-header-390px');
    const step = detail.locator('.ris-process-step').first();
    await expect(step).toContainText('Mit Prüfauftrag beschlossen');
    const dateLines = await step.locator('time').evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return new Set([...range.getClientRects()].map(rect => Math.round(rect.top))).size;
    });
    expect(dateLines, 'The full event date must remain readable on one line at 390px').toBe(1);
    const evidence = step.locator('details');
    await expect(evidence).not.toHaveAttribute('open');
    await expect(evidence.locator('blockquote')).toBeHidden();
    await evidence.locator('summary').tap();
    await expect(evidence.locator('blockquote')).toHaveText(EVENT_EVIDENCE);
    await expect(evidence.locator('blockquote')).toBeVisible();
    await evidence.locator('summary').tap();
    await captureEvidence(page, testInfo, 'mobile-document-process-390px');

    await detail.getByRole('tab', { name: 'Zusammenhänge', exact: true }).tap();
    const direct = detail.locator('[aria-label="Direkte Querverweise"]');
    const regionLink = direct.locator('.ris-record-view__card').filter({ hasText: REGION_TITLE });
    await expect(regionLink.locator('.ris-record-view__level')).toHaveCount(2);
    expect(await regionLink.locator('.ris-record-view__level').evaluateAll(badges => badges.map(badge => badge.dataset.level)))
      .toEqual(['city', 'region']);
    const unknown = direct.locator('.ris-record-view__card').filter({ hasText: UNKNOWN_TITLE });
    expect(await unknown.locator('.ris-record-view__level').evaluateAll(badges => badges.map(badge => badge.dataset.level)))
      .toEqual(['city', 'unknown']);
    await expect(unknown).toContainText('Ebene nicht angegeben');
    await regionLink.scrollIntoViewIfNeeded();
    await captureEvidence(page, testInfo, 'mobile-explicit-relations-390px');
    await regionLink.getByRole('button', { name: `Vorgang öffnen: ${REGION_TITLE}`, exact: true }).tap();
    await expect(detail.locator('.ris-record-view__title')).toHaveText(REGION_TITLE);
    await expect(detail.locator('.ris-record-view__header .ris-record-view__level')).toHaveAttribute('data-level', 'region');
    await detail.getByRole('tab', { name: 'Zusammenhänge', exact: true }).tap();
    const stateLink = detail.locator('[aria-label="Direkte Querverweise"] .ris-record-view__card').filter({ hasText: STATE_TITLE });
    expect(await stateLink.locator('.ris-record-view__level').evaluateAll(badges => badges.map(badge => badge.dataset.level)))
      .toEqual(['region', 'state']);
    await stateLink.getByRole('button', { name: `Vorgang öffnen: ${STATE_TITLE}`, exact: true }).tap();
    await expect(detail.locator('.ris-record-view__title')).toHaveText(STATE_TITLE);
    await expect(detail.locator('.ris-record-view__header .ris-record-view__level')).toHaveAttribute('data-level', 'state');
    expect(await mapView(page)).toEqual(before);
    await detail.getByRole('button', { name: 'Zur Trefferliste', exact: true }).tap();
    await expect(list).toBeVisible();
    await expect(detail.locator('.ris-details__body')).toBeHidden();
    await expect(page.locator('#polCtxSearchInput')).toHaveValue('Radweg');
    await expect(page.locator('#polCtxLevel')).toHaveValue('city');
    await expect(page.locator('#polCtxResults .polCtxRef')).toHaveCount(1);
    await expect(city.locator('.polCtxCheck')).toBeChecked();
    await expectFitsViewport(page, list);
    await captureEvidence(page, testInfo, 'mobile-preserved-results-after-relations-390px');
    await city.locator('[data-ris-open-record]').tap();
    await expect(detail.locator('.ris-record-view__title')).toHaveText(CITY_TITLE);
    await expect(detail.locator('.ris-details__body')).toBeVisible();
  });

  test('releases the map for a selected location and preserves the filtered result list', async ({ page }, testInfo) => {
    test.setTimeout(80_000);
    const data = await workspaceFixture(testInfo);
    await data.install(page);
    await ready(page, `/werkbank_v2.html?${BASE_VIEW}`);
    await page.locator('#btnRisBrowse').tap();
    await search(page, 'state');
    const list = page.locator('#polCtxPanel');
    const state = resultCard(page, STATE_ID);
    await expect(page.locator('#polCtxResults .polCtxRef')).toHaveCount(1);
    await state.locator('.polCtxCheck').check();
    await state.locator('[data-ris-open-record]').tap();
    const detail = page.locator('#risDetails');
    await detail.getByRole('tab', { name: 'Orte', exact: true }).tap();
    await detail.getByRole('button', { name: 'Auf Karte zeigen: Kartenlage 1', exact: true }).tap();
    await expect(detail.locator('.ris-details__body')).toBeHidden();
    await expect(list.locator('.ris-browser__body')).toBeHidden();
    expect(await page.evaluate(() => window.UA.getRuntimeContext().risView)).toMatchObject({
      listOpen: true, listCollapsed: true, query: 'Radweg', sourceLevels: ['state'],
    });
    const popup = page.locator('.leaflet-popup');
    await expect(popup).toContainText(STATE_TITLE);
    await popup.getByRole('link', { name: `Amtliches Dokument: ${STATE_TITLE}`, exact: true })
      .click({ trial: true });
    const openedPoint = await page.evaluate(() => {
      let coordinates;
      window.UA.getRuntimeContext().map.eachLayer(layer => {
        if (layer.feature?.geometry.type === 'Point' && layer.isPopupOpen?.()) {
          const { lng, lat } = layer.getLatLng();
          coordinates = [lng, lat];
        }
      });
      return coordinates;
    });
    expect(openedPoint).toEqual([9.743, 52.381]);
    await expect(popup).toBeInViewport({ ratio: 1 });
    await expect(detail).toBeHidden();
    const launcher = page.locator('#btnRisBrowse');
    await expect(launcher).toBeVisible();
    expect((await launcher.boundingBox()).width).toBeLessThanOrEqual(44);
    await captureEvidence(page, testInfo, 'mobile-selected-location-map-390px');
    await launcher.tap();
    await expect(popup).toBeHidden();
    await expect(list.locator('.ris-browser__body')).toBeVisible();
    await expect(page.locator('#polCtxSearchInput')).toHaveValue('Radweg');
    await expect(page.locator('#polCtxLevel')).toHaveValue('state');
    await expect(page.locator('#polCtxResults .polCtxRef')).toHaveCount(1);
    await expect(state.locator('.polCtxCheck')).toBeChecked();
    await captureEvidence(page, testInfo, 'mobile-preserved-results-after-map-390px');
  });
});

test('a shared filtered search page overrides local state and restores only that bounded page', async ({ page, browser }, testInfo) => {
  test.setTimeout(100_000);
  await page.setViewportSize({ width: 1512, height: 982 });
  const data = await workspaceFixture(testInfo, { paginated: true });
  await data.install(page);
  await ready(page, `/werkbank_v2.html?${BASE_VIEW}`);
  await page.locator('#btnRisBrowse').click();
  await search(page, 'state');
  await expect(page.locator('#polCtxResults .polCtxRef')).toHaveCount(15);
  const firstPage = await resultIds(page);
  await page.getByRole('button', { name: 'Weitere Suchtreffer laden', exact: true }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get('risSearchPage')).toMatch(/^ris2\./);
  await expect(page.locator('#polCtxResults')).toHaveAttribute('aria-busy', 'false');
  await expect.poll(() => resultIds(page)).not.toEqual(firstPage);
  await expect(page.locator('#polCtxResults .polCtxRef')).toHaveCount(15);
  const currentPage = await resultIds(page);
  expect(currentPage.some(id => firstPage.includes(id))).toBe(false);
  await expect(page.locator('#polCtxResults [data-ris-open-record]').first()).toBeFocused();
  expect(await page.locator('#polCtxResults').evaluate(element => element.scrollTop)).toBe(0);
  await page.locator('#polCtxResults [data-ris-open-record]').first().click();
  const selected = currentPage[0];
  await expect(page.locator('#risDetails .ris-record-view__title')).toBeVisible();
  const title = await page.locator('#risDetails .ris-record-view__title').textContent();
  const shared = page.url();
  const params = new URL(shared).searchParams;
  expect(params.get('risList')).toBe('1');
  expect(params.get('risQuery')).toBe('Radweg');
  expect(params.get('risLevels')).toBe('state');
  expect(params.get('risSearchPage')).toMatch(/^ris2\./);
  expect(params.get('risSearchSnapshot')).toMatch(/^[a-f0-9]{64}$/);
  expect(params.get('risRecord')).toBe(selected);

  const recipient = await browser.newContext({ viewport: { width: 1512, height: 982 } });
  try {
    await data.install(recipient);
    await recipient.addInitScript(() => localStorage.setItem('ua_state_hannover', JSON.stringify({
      risView: { listOpen: false, listCollapsed: true, query: 'Widersprechender lokaler Suchtext',
        sourceLevels: ['city'], recordId: 'wrong-local-document', section: 'locations' },
    })));
    const received = await recipient.newPage();
    const errors = [];
    received.on('pageerror', error => errors.push(error.message));
    await ready(received, shared);
    await expect(received.locator('#polCtxPanel')).toBeVisible();
    await expect(received.locator('#polCtxSearchInput')).toHaveValue('Radweg');
    await expect(received.locator('#polCtxLevel')).toHaveValue('state');
    await expect(received.locator('#polCtxResults .polCtxRef')).toHaveCount(currentPage.length);
    expect(await resultIds(received)).toEqual(currentPage);
    await expect(received.locator('#risDetails .ris-record-view__title')).toHaveText(title);
    await expect(resultCard(received, selected)).toHaveAttribute('aria-current', 'true');
    expect(await received.evaluate(() => window.UA.getRuntimeContext().risView)).toMatchObject({
      listOpen: true, listCollapsed: false, query: 'Radweg', sourceLevels: ['state'],
      recordId: selected, searchCursor: params.get('risSearchPage'), searchGeneration: params.get('risSearchSnapshot'),
    });
    expect(errors).toEqual([]);
    await captureEvidence(received, testInfo, 'desktop-shared-filtered-search-page');

    const changedSnapshot = new URL(shared);
    const generation = params.get('risSearchSnapshot');
    changedSnapshot.searchParams.set('risSearchSnapshot', `${generation[0] === '0' ? '1' : '0'}${generation.slice(1)}`);
    await ready(received, changedSnapshot.href);
    await expect(received.locator('#polCtxStatus')).toContainText(/Fehler bei der Recherche.*Datenstand.*geändert/i);
    const restart = received.getByRole('button', { name: 'Suche neu starten', exact: true });
    await expect(restart).toBeVisible();
    await expect(received.locator('#polCtxResults .polCtxRef')).toHaveCount(0);
    await captureEvidence(received, testInfo, 'desktop-shared-changed-snapshot-error');
    await restart.click();
    await expect(received.locator('#polCtxSearchInput')).toHaveValue('Radweg');
    await expect(received.locator('#polCtxLevel')).toHaveValue('state');
    await expect.poll(() => resultIds(received)).toEqual(firstPage);
    await expect(received.locator('#polCtxStatus')).not.toContainText('Fehler');
    await expect(received.locator('#polCtxResults [data-ris-open-record]').first()).toBeFocused();
    expect(await received.locator('#polCtxResults').evaluate(element => element.scrollTop)).toBe(0);
    expect(new URL(received.url()).searchParams.has('risSearchPage')).toBe(false);
    expect(new URL(received.url()).searchParams.has('risSearchSnapshot')).toBe(false);
    expect(errors).toEqual([]);
    await captureEvidence(received, testInfo, 'desktop-shared-restarted-first-page');
  } finally {
    await recipient.close();
  }
});
