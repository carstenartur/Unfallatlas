import { expect, test } from '@playwright/test';

test.use({ hasTouch: true });
test.setTimeout(150_000);

const hannover = '/werkbank_v2.html?city=Hannover&includeCyclist=1&includePedestrian=1&includeCar=1'
  + '&includeMotorcycle=0&includeGkfz=0&includeSonstig=0&involvementMode=or&showCluster=1';
const bruehl = hannover + '&centerLat=52.375721&centerLon=9.726783&zoom=19'
  + '&selSouth=52.37552874272362&selWest=9.72648054178715&selNorth=52.375906457276386&selEast=9.72709925821285'
  + '&siteNetworkId=j:60655478&siteFocus=turning:5&siteFrom=2021&siteTo=2025&siteType=turning&siteInvolvement=bike-foot'
  + '&evidenceLabels=1&evidenceScope=complete&evidenceAccident=A002';
const leine = hannover + '&centerLat=52.410681&centerLon=9.649133&zoom=17'
  + '&selSouth=52.411706603890885&selWest=9.64800829228593&selNorth=52.41307889610911&selEast=9.64999930771407'
  + '&siteNetworkId=s:1016906518:29715462:29719902:1:1:1&siteFrom=2025&siteTo=2025&siteFocus=all';

async function openSite(page, baseURL, path, name) {
  const origin = new URL(baseURL).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin
    ? route.continue() : route.abort('blockedbyclient'));
  const index = await page.request.get('/data/mobility/review-network/hannover/index.json');
  const url = new URL(path, baseURL);
  url.searchParams.set('siteNetworkRev', (await index.json()).revision);
  await page.goto(url.href, { waitUntil: 'commit' });
  await expect(page.locator('.site-discovery-detail')).toContainText(name, { timeout: 60_000 });
  const toggle = page.getByRole('button', { name: 'Bedienfeld einklappen' });
  if (await toggle.isVisible()) await toggle.click();
}

test('a shared coordinate opens by touch and all eight other cases are reachable by keyboard', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openSite(page, baseURL, bruehl, 'Brühlstraße');
  const pin = page.getByTitle('A002 ×9 · Fälle am selben Unfallort', { exact: true });
  await expect(pin).toBeVisible({ timeout: 90_000 });
  await pin.tap({ timeout: 10_000 });
  const popup = page.locator('.leaflet-popup-content');
  await expect(popup).toContainText('9 Unfälle an derselben Koordinate');
  const ids = ['A002', 'A010', 'A018', 'A019', 'A028', 'A030', 'A037', 'A042', 'A045'];
  await expect(popup.getByRole('listitem')).toHaveText(ids.map(id => new RegExp('^' + id + ' ·')));
  await page.locator('.leaflet-popup-close-button').tap();

  await pin.focus();
  await page.keyboard.press('Enter');
  const cases = popup.getByRole('link');
  await expect(cases.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(popup).toBeHidden();
  await expect(pin).toBeFocused();

  await page.keyboard.press('Enter');
  for (const id of ids.slice(1)) {
    await expect(popup.getByRole('link', { name: 'Unfall ' + id + ' einzeln anzeigen' })).toBeFocused();
    if (id !== 'A045') await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/evidenceAccident=A045/);
  await expect(page.getByTitle('A045 ×9 · Fälle am selben Unfallort', { exact: true })).toBeVisible({ timeout: 90_000 });
});

test('a normal map cluster outside the selected site still opens on click', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSite(page, baseURL, leine, 'Am Leineufer');
  const clusters = page.locator('.leaflet-marker-icon.marker-cluster');
  await expect(clusters.first()).toBeAttached({ timeout: 60_000 });
  // Pick a visible cluster outside the site, disregarding controls that cover the map.
  const index = await clusters.evaluateAll(markers => {
    const { map, selectionBounds } = window.UA.getRuntimeContext();
    return markers.findIndex(marker => {
      const rect = marker.getBoundingClientRect();
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      return document.elementFromPoint(x, y)?.closest('.leaflet-pane')
        && !selectionBounds.contains(map.mouseEventToLatLng({ clientX: x, clientY: y }));
    });
  });
  expect(index).toBeGreaterThanOrEqual(0);
  const cluster = clusters.nth(index);
  const count = await cluster.innerText();
  await cluster.click({ timeout: 10_000 });
  const popup = page.locator('.leaflet-popup-content');
  await expect(popup).toContainText('Cluster: ' + count + ' Unfälle');
  await expect(popup.getByRole('button', { name: 'Zoom auf Cluster' })).toBeVisible();
});
