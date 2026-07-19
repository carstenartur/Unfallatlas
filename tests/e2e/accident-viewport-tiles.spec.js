import { test, expect } from '@playwright/test';
import zlib from 'node:zlib';

function tileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function tileY(lat, zoom) {
  const radians = lat * Math.PI / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2)
      * Math.pow(2, zoom)
  );
}

function gzipJson(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), {
    level: 9,
    mtime: 0,
  });
}

function accidentFeature() {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [7.1, 50.73] },
    properties: {
      id: 'viewport-accident-1',
      ukategorie: '2',
      uart: '1',
      utyp1: '1',
      ulichtverh: '0',
      ustrzustand: '0',
      uwochentag: '2',
      umonat: '6',
      ujahr: '2024',
      ustunde: '8',
      istrad: '1',
      istpkw: '1',
      istfuss: '0',
      istkrad: '0',
      istgkfz: '0',
      istsonstig: '0',
    },
  };
}

test('viewport mode renders accidents from gzip tiles without loading full city data', async ({ page }) => {
  const zoom = 13;
  const x = tileX(7.1, zoom);
  const y = tileY(50.73, zoom);
  const manifest = {
    schemaVersion: 1,
    producerVersion: 'e2e-fixture',
    city: 'bonn',
    z: zoom,
    sourceFingerprint: 'e2e-sha256',
    totalCount: 1,
    explicitIdCount: 1,
    derivedIdCount: 0,
    tiles: [{ x, y, count: 1 }],
  };
  const tile = {
    schemaVersion: 1,
    city: 'bonn',
    z: zoom,
    x,
    y,
    type: 'FeatureCollection',
    features: [accidentFeature()],
    featureIdentities: ['id:viewport-accident-1'],
  };

  const requested = [];
  let fullCityRequests = 0;
  page.on('request', request => requested.push(request.url()));

  await page.route('**/out/accidenttiles/bonn/index.json.gz', route => route.fulfill({
    status: 200,
    contentType: 'application/gzip',
    body: gzipJson(manifest),
  }));
  await page.route(`**/out/accidenttiles/bonn/${zoom}/${x}/${y}.json.gz`, route => route.fulfill({
    status: 200,
    contentType: 'application/gzip',
    body: gzipJson(tile),
  }));
  await page.route('**/out/output_all_years_bonn.geojson*', route => {
    fullCityRequests += 1;
    return route.abort('failed');
  });

  const response = await page.goto(
    `/werkbank_v2.html?city=Bonn&accidentDataMode=viewport&centerLat=50.730000&centerLon=7.100000&zoom=15&showCluster=1&showHeatmap=0&showSchools=0&showKindergartens=0&showArgumentation=0`,
    { waitUntil: 'domcontentloaded' }
  );
  expect(response?.ok()).toBe(true);

  await expect(page.locator('#dataSourceCode')).toContainText('out/accidenttiles/bonn/index.json');
  await expect(page.locator('#dataSourceCode'))
    .toContainText('Kartenausschnitt vollständig; Stadt unvollständig');
  await expect(page.locator('#stat')).toContainText('geladen: 1');

  // Keep the normal marker layer enabled: disabling both cluster and heatmap
  // intentionally renders no accidents, which would make a pixel assertion
  // test the fixture rather than the viewport tile path.
  await page.waitForFunction(() => {
    const target = [255, 127, 0]; // severity category 2
    for (const canvas of document.querySelectorAll('.leaflet-overlay-pane canvas')) {
      if (!(canvas instanceof HTMLCanvasElement) || !canvas.width || !canvas.height) continue;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) continue;
      let pixels;
      try { pixels = context.getImageData(0, 0, canvas.width, canvas.height).data; }
      catch (_) { continue; }
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] < 100) continue;
        if (Math.abs(pixels[index] - target[0]) <= 12
            && Math.abs(pixels[index + 1] - target[1]) <= 12
            && Math.abs(pixels[index + 2] - target[2]) <= 12) return true;
      }
    }
    return false;
  }, null, { timeout: 30_000 });

  expect(fullCityRequests).toBe(0);
  expect(requested.some(url => url.endsWith('/out/accidenttiles/bonn/index.json.gz'))).toBe(true);
  expect(requested.some(url => url.endsWith(`/out/accidenttiles/bonn/${zoom}/${x}/${y}.json.gz`))).toBe(true);
  expect(requested.some(url => /accidenttiles\/bonn\/.*\.json(?:[?#]|$)/.test(url))).toBe(false);
});
