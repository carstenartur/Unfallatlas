import { test, expect } from '@playwright/test';
import { ID, TITLE, BASE_VIEW, fixture, ready, captureEvidence } from './helpers/ris-shared-view-fixture.js';

test('a copied RIS view restores layer, area filter, unlocated record, tab and page in a fresh context', async ({ page, browser }, testInfo) => {
  test.setTimeout(100_000);
  const data = await fixture(testInfo);
  await data.install(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page, `/werkbank_v2.html?${BASE_VIEW}&selSouth=52.37&selWest=9.72&selNorth=52.38&selEast=9.74`);
  await page.getByRole('checkbox', { name: 'Ratsvorgänge', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Nur in markierter Fläche', exact: true }).check();
  await expect(page.locator('.ua-ris-point')).toHaveCount(1);
  await page.locator('#btnPolCtxOpen').click();
  await page.locator('#polCtxSearchInput').fill('Mittellandkanal');
  await page.locator('#polCtxBtnSearch').click();
  await page.getByRole('button', { name: `Verlauf und Zusammenhänge: ${TITLE}`, exact: true }).click();
  const panel = page.locator('#risDetails');
  await expect(panel).toContainText(TITLE);
  await expect(panel.locator('.ris-process-step')).toHaveCount(64);
  await panel.getByRole('button', { name: 'Nächste Seite Beratungsverlauf', exact: true }).click();
  await expect(panel.locator('.ris-process-step')).toHaveCount(6);
  await expect(panel).toContainText('Regionsversammlung');
  await panel.getByRole('tab', { name: 'Zusammenhänge', exact: true }).click();
  await expect(panel).toContainText('Amtlicher Verweis auf den Änderungsantrag');
  await panel.getByRole('button', { name: 'Link zur aktuellen Ansicht kopieren', exact: true }).click();
  await expect(panel).toContainText('Link zur aktuellen Ansicht kopiert.');
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  expect(shared).toBe(page.url());
  const parameters = new URL(shared).searchParams;
  expect(parameters.get('mapLayer')).toBe('ris');
  expect(parameters.get('risSelectionOnly')).toBe('1');
  expect(parameters.get('risRecord')).toBe(ID);
  expect(parameters.get('risView')).toBe('relations');
  expect(parameters.get('risEventsPage')).toBe('1');

  const recipient = await browser.newContext();
  try {
    await data.install(recipient);
    await recipient.addInitScript(() => localStorage.setItem('ua_state_hannover', JSON.stringify({
      contextOverlays: { active: { slope: false, traffic: false, ris: false } },
      risView: { recordId: 'wrong-local-document', section: 'locations', selectionOnly: false },
      centerLat: 52.4, centerLon: 9.8, zoom: 11,
    })));
    const received = await recipient.newPage();
    const errors = []; received.on('pageerror', error => errors.push(error.message));
    await ready(received, shared);
    const detail = received.locator('#risDetails');
    await expect(detail).toContainText(TITLE);
    await expect(detail.getByRole('tab', { name: 'Zusammenhänge', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(received.getByRole('checkbox', { name: 'Ratsvorgänge', exact: true })).toBeChecked();
    await expect(received.getByRole('checkbox', { name: 'Nur in markierter Fläche', exact: true })).toBeChecked();
    const state = await received.evaluate(() => {
      const ctx = window.UA.getRuntimeContext();
      return { view: ctx.risView, zoom: ctx.map.getZoom(), bounds: ctx.selectionBounds.toBBoxString() };
    });
    expect(state).toMatchObject({ view: { recordId: ID, section: 'relations', eventsPage: 1, selectionOnly: true },
      zoom: 14, bounds: '9.72,52.37,9.74,52.38' });
    await detail.getByRole('tab', { name: 'Beratungsverlauf', exact: true }).click();
    await expect(detail.locator('.ris-process-step')).toHaveCount(6);
    await expect(detail).toContainText('Öffentlicher Beratungsbeleg 70');
    await expect(detail).not.toContainText('Öffentlicher Beratungsbeleg 1');
    expect(errors).toEqual([]);
    await captureEvidence(received, testInfo, 'shared-ris-process-desktop');
  } finally { await recipient.close(); }
});

for (const schemaVersion of [1, 2]) {
  test(`a direct unlocated record link works with catalogue v${schemaVersion} and leaves the map layer off`, async ({ page }, testInfo) => {
    test.setTimeout(70_000);
    const data = await fixture(testInfo, schemaVersion); await data.install(page);
    await ready(page, `/werkbank_v2.html?${BASE_VIEW}&risRecord=${encodeURIComponent(ID)}`);
    const panel = page.locator('#risDetails');
    await expect(panel).toContainText(TITLE);
    await expect(panel).toContainText('Region Hannover');
    await expect(page.getByRole('checkbox', { name: 'Ratsvorgänge', exact: true })).not.toBeChecked();
    await expect(page.locator('.ua-ris-point')).toHaveCount(0);
    await panel.getByRole('tab', { name: 'Zusammenhänge', exact: true }).click();
    const internal = panel.getByRole('button', { name: /Änderungsantrag zum Radverkehr/ }).first();
    await internal.click();
    await expect(panel).toContainText('TEST-Ä/2026');
    expect(new URL(page.url()).searchParams.get('risRecord')).toBe('region-hannover-ris:vo:2003261');
    await panel.getByRole('button', { name: 'Vorgangsansicht schließen', exact: true }).click();
    await expect(panel).toBeHidden();
    expect(new URL(page.url()).searchParams.has('risRecord')).toBe(false);
  });
}
