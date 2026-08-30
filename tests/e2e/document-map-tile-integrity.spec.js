import { test, expect } from '@playwright/test';

const RED_TILE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);

test('document map capture reuses verified tiles instead of making a lossy second request', async ({ page }) => {
  const requests = new Map();
  await page.route('**/qa-map-tile/**', async route => {
    const url = route.request().url();
    requests.set(url, (requests.get(url) || 0) + 1);
    await route.fulfill({
      status: 200,
      contentType: 'image/png',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: RED_TILE,
    });
  });

  await page.goto('/');
  const origin = new URL(page.url()).origin;
  await page.setContent('<!doctype html><html><head></head><body><div id="map" style="width:255px;height:255px"></div></body></html>');
  await page.addScriptTag({ url: `${origin}/vendor/leaflet/leaflet.js` });
  await page.addScriptTag({ url: `${origin}/vendor/leaflet-image/leaflet-image.js` });
  await page.evaluate(() => { window.UA = {}; });
  await page.addScriptTag({ url: `${origin}/js/ua.map_capture_tile_integrity.js` });

  const captured = await page.evaluate(async originValue => {
    const map = L.map('map', {
      attributionControl: false,
      zoomControl: false,
      zoomAnimation: false,
      fadeAnimation: false,
    }).setView([0, 0], 0);
    const layer = L.tileLayer(`${originValue}/qa-map-tile/{z}/{x}/{y}.png`, {
      minZoom: 0,
      maxZoom: 0,
      noWrap: true,
      crossOrigin: 'anonymous',
      tileSize: 256,
    });
    const loaded = new Promise((resolve, reject) => {
      layer.once('load', resolve);
      layer.once('tileerror', event => reject(new Error(`initial tile error: ${event?.error || ''}`)));
    });
    layer.addTo(map);
    await loaded;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    return new Promise((resolve, reject) => {
      window.leafletImage(map, (error, canvas) => {
        if (error) {
          reject(new Error(`${error.code || 'MAP_CAPTURE_ERROR'}: ${error.message}`));
          return;
        }
        const pixel = [...canvas.getContext('2d').getImageData(127, 127, 1, 1).data];
        resolve({ width: canvas.width, height: canvas.height, pixel });
      });
    });
  }, origin);

  expect(captured).toMatchObject({ width: 255, height: 255 });
  expect(captured.pixel[3]).toBeGreaterThan(0);
  expect([...requests.values()]).toEqual([1]);
});
