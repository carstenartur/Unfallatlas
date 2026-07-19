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

function tileCenterLon(x, zoom) {
  return ((x + 0.5) / Math.pow(2, zoom)) * 360 - 180;
}

function tileCenterLat(y, zoom) {
  const mercator = Math.PI - (2 * Math.PI * (y + 0.5)) / Math.pow(2, zoom);
  return Math.atan(Math.sinh(mercator)) * 180 / Math.PI;
}

function gzipJson(value) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), {
    level: 9,
    mtime: 0,
  });
}

function accidentFeature(id, x, y, tileZoom, category) {
  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [tileCenterLon(x, tileZoom), tileCenterLat(y, tileZoom)],
    },
    properties: {
      id,
      ukategorie: String(category),
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

function tilePayload(city, zoom, x, y, id, category) {
  return {
    schemaVersion: 1,
    city,
    z: zoom,
    x,
    y,
    type: 'FeatureCollection',
    features: [accidentFeature(id, x, y, zoom, category)],
    featureIdentities: [`id:${id}`],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

async function pressArrow(page, key, count) {
  const map = page.locator('#map');
  await map.focus();
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press(key);
  }
}

async function markerColorVisible(page, rgb) {
  return page.evaluate(target => {
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
  }, rgb);
}

test('pan and zoom lifecycle caches tiles and suppresses delayed stale responses', async ({ page }) => {
  const tileZoom = 13;
  const displayZoom = 15;
  const aX = tileX(7.1, tileZoom);
  const y = tileY(50.73, tileZoom);
  const bX = aX + 2;
  const cX = aX + 4;
  const manifest = {
    schemaVersion: 1,
    producerVersion: 'e2e-fixture',
    city: 'bonn',
    z: tileZoom,
    sourceFingerprint: 'e2e-live-sha256',
    totalCount: 3,
    explicitIdCount: 3,
    derivedIdCount: 0,
    tiles: [
      { x: aX, y, count: 1 },
      { x: bX, y, count: 1 },
      { x: cX, y, count: 1 },
    ],
  };
  const payloadA = tilePayload('bonn', tileZoom, aX, y, 'a', 3);
  const payloadB = tilePayload('bonn', tileZoom, bX, y, 'b', 2);
  const payloadC = tilePayload('bonn', tileZoom, cX, y, 'c', 1);
  const delayedB = deferred();
  let bRequestSeen = false;
  let cRequestSeen = false;
  let fullCityRequests = 0;
  const requestCounts = new Map();

  page.on('request', request => {
    const url = request.url();
    requestCounts.set(url, (requestCounts.get(url) || 0) + 1);
  });

  await page.route('**/out/accidenttiles/bonn/index.json.gz', route => route.fulfill({
    status: 200,
    contentType: 'application/gzip',
    body: gzipJson(manifest),
  }));
  await page.route(`**/out/accidenttiles/bonn/${tileZoom}/${aX}/${y}.json.gz`, route => route.fulfill({
    status: 200,
    contentType: 'application/gzip',
    body: gzipJson(payloadA),
  }));
  await page.route(`**/out/accidenttiles/bonn/${tileZoom}/${bX}/${y}.json.gz`, async route => {
    bRequestSeen = true;
    await delayedB.promise;
    await route.fulfill({
      status: 200,
      contentType: 'application/gzip',
      body: gzipJson(payloadB),
    });
  });
  await page.route(`**/out/accidenttiles/bonn/${tileZoom}/${cX}/${y}.json.gz`, route => {
    cRequestSeen = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/gzip',
      body: gzipJson(payloadC),
    });
  });
  await page.route('**/out/output_all_years_bonn.geojson*', route => {
    fullCityRequests += 1;
    return route.abort('failed');
  });

  const centerLat = tileCenterLat(y, tileZoom);
  const centerLon = tileCenterLon(aX, tileZoom);
  const response = await page.goto(
    `/werkbank_v2.html?city=Bonn&accidentDataMode=viewport`
      + `&centerLat=${centerLat.toFixed(8)}&centerLon=${centerLon.toFixed(8)}`
      + `&zoom=${displayZoom}&showCluster=1&showHeatmap=0&showSchools=0`
      + `&showKindergartens=0&showArgumentation=0`,
    { waitUntil: 'domcontentloaded' }
  );
  expect(response?.ok()).toBe(true);

  await expect(page.locator('#dataSourceCode'))
    .toContainText('Kartenausschnitt vollständig; Stadt unvollständig');
  await expect.poll(() => markerColorVisible(page, [255, 255, 51]), { timeout: 30_000 })
    .toBe(true);

  // At zoom 15 an accident z=13 tile is 1024 screen pixels wide. Twenty-six
  // default Leaflet keyboard pans (80 px each) move from tile A to B.
  await pressArrow(page, 'ArrowRight', 26);
  await expect.poll(() => bRequestSeen, { timeout: 15_000 }).toBe(true);
  await expect(page.locator('#dataSourceCode')).toContainText('Kartenausschnitt wird geladen');

  // Move to C while B is deliberately still in flight. This must invalidate B
  // immediately and let C become the only commit-capable scheduler epoch.
  await pressArrow(page, 'ArrowRight', 26);
  await expect.poll(() => cRequestSeen, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => markerColorVisible(page, [227, 26, 28]), { timeout: 30_000 })
    .toBe(true);
  await expect(page.locator('#dataSourceCode'))
    .toContainText('Kartenausschnitt vollständig; Stadt unvollständig');

  delayedB.resolve();
  await page.waitForTimeout(800);
  expect(await markerColorVisible(page, [227, 26, 28])).toBe(true);

  // Return to A. Provider cache reuse must avoid a second A network request and
  // deterministic replacement must render exactly the original yellow marker.
  await pressArrow(page, 'ArrowLeft', 52);
  await expect.poll(() => markerColorVisible(page, [255, 255, 51]), { timeout: 30_000 })
    .toBe(true);

  const suffixA = `/out/accidenttiles/bonn/${tileZoom}/${aX}/${y}.json.gz`;
  const suffixB = `/out/accidenttiles/bonn/${tileZoom}/${bX}/${y}.json.gz`;
  const suffixC = `/out/accidenttiles/bonn/${tileZoom}/${cX}/${y}.json.gz`;
  const countBySuffix = suffix => Array.from(requestCounts.entries())
    .filter(([url]) => url.endsWith(suffix))
    .reduce((sum, [, count]) => sum + count, 0);

  expect(countBySuffix(suffixA)).toBe(1);
  expect(countBySuffix(suffixB)).toBe(1);
  expect(countBySuffix(suffixC)).toBe(1);
  expect(fullCityRequests).toBe(0);
  expect(Array.from(requestCounts.keys())
    .some(url => /accidenttiles\/bonn\/.*\.json(?:[?#]|$)/.test(url))).toBe(false);
});

test('rejects mismatched tile metadata without retaining accidents from the old viewport', async ({ page }) => {
  const tileZoom = 13;
  const displayZoom = 15;
  const aX = tileX(7.1, tileZoom);
  const y = tileY(50.73, tileZoom);
  const bX = aX + 2;
  const manifest = {
    schemaVersion: 1,
    producerVersion: 'e2e-fixture',
    city: 'bonn',
    z: tileZoom,
    sourceFingerprint: 'e2e-invalid-tile-sha256',
    totalCount: 2,
    explicitIdCount: 2,
    derivedIdCount: 0,
    tiles: [
      { x: aX, y, count: 1 },
      { x: bX, y, count: 1 },
    ],
  };
  const payloadA = tilePayload('bonn', tileZoom, aX, y, 'a', 3);
  const invalidPayloadB = {
    ...tilePayload('bonn', tileZoom, bX, y, 'b', 1),
    city: 'hannover',
  };
  let fullCityRequests = 0;

  await page.route('**/out/accidenttiles/bonn/index.json.gz', route => route.fulfill({
    status: 200,
    contentType: 'application/gzip',
    body: gzipJson(manifest),
  }));
  await page.route(`**/out/accidenttiles/bonn/${tileZoom}/${aX}/${y}.json.gz`, route => route.fulfill({
    status: 200,
    contentType: 'application/gzip',
    body: gzipJson(payloadA),
  }));
  await page.route(`**/out/accidenttiles/bonn/${tileZoom}/${bX}/${y}.json.gz`, route => route.fulfill({
    status: 200,
    contentType: 'application/gzip',
    body: gzipJson(invalidPayloadB),
  }));
  await page.route('**/out/output_all_years_bonn.geojson*', route => {
    fullCityRequests += 1;
    return route.abort('failed');
  });

  const centerLat = tileCenterLat(y, tileZoom);
  const centerLon = tileCenterLon(aX, tileZoom);
  const response = await page.goto(
    `/werkbank_v2.html?city=Bonn&accidentDataMode=viewport`
      + `&centerLat=${centerLat.toFixed(8)}&centerLon=${centerLon.toFixed(8)}`
      + `&zoom=${displayZoom}&showCluster=1&showHeatmap=0&showSchools=0`
      + `&showKindergartens=0&showArgumentation=0`,
    { waitUntil: 'domcontentloaded' }
  );
  expect(response?.ok()).toBe(true);

  await expect(page.locator('#dataSourceCode'))
    .toContainText('Kartenausschnitt vollständig; Stadt unvollständig');
  await expect(page.locator('#stat')).toContainText('geladen: 1');

  await pressArrow(page, 'ArrowRight', 26);

  await expect(page.locator('#dataSourceCode'))
    .toContainText('Kartenausschnitt teilweise geladen; Stadt unvollständig');
  await expect(page.locator('#stat')).toContainText('geladen: 0');
  expect(await markerColorVisible(page, [227, 26, 28])).toBe(false);
  expect(fullCityRequests).toBe(0);
});
