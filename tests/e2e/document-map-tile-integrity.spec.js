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
  expect(requests.size).toBeGreaterThan(0);
  expect([...requests.values()].every(count => count === 1)).toBe(true);
});

test('report capture uses native raster zoom and leaves live accident layers out', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/qa-report-tile/**', route => route.fulfill({ contentType: 'image/png', body: RED_TILE }));
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  await page.setContent('<!doctype html><div id="map" style="width:1050px;height:650px"></div>');
  await page.addStyleTag({ url: `${origin}/vendor/leaflet/leaflet.css` });
  for (const file of [
    'vendor/leaflet/leaflet.js',
    'vendor/leaflet-image/leaflet-image.js',
    'js/ua.map_capture_tile_integrity.js',
    'js/ua.map_v2.js',
    'js/ua.report_v2.js',
  ]) {
    await page.addScriptTag({ url: `${origin}/${file}` });
  }

  const result = await page.evaluate(async originValue => {
    const center = [52.3915, 9.7204];
    const outside = [52.3915, 9.72075];
    const live = L.map('map', { preferCanvas: true, maxZoom: 22 }).setView(center, 20);
    const basemap = L.tileLayer(`${originValue}/qa-report-tile/{z}/{x}/{y}.png`, {
      maxNativeZoom: 19, maxZoom: 22,
    }).addTo(live);
    const otherMarker = L.circleMarker(outside, { radius: 10, fillOpacity: 1, fillColor: '#5500ee' }).addTo(live);
    const documentMap = UA.createDocumentMapContext({ map: live, baseMapState: { standardLayer: basemap } });
    const { ctx } = documentMap;
    const options = {
      exportPoints: [{ lat: center[0], lon: center[1], props: { ukategorie: '3' } }],
      exportBounds: { south: 52.3914, west: 9.72, north: 52.3916, east: 9.7206 },
    };
    const pixels = async dataUrl => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const colorAt = position => {
        const { x, y } = ctx.map.latLngToContainerPoint(position);
        return [...context.getImageData(x, y, 1, 1).data];
      };
      return { included: colorAt(center), outside: colorAt(outside) };
    };
    try {
      const raster = await UA.captureDocumentMap(ctx, options);
      const rasterPixels = await pixels(raster.image);
      UA.captureExportMapImage = async () => { throw new Error('fixture simulates raster-provider failure'); };
      const schematic = await UA.captureDocumentMap(ctx, options);
      return {
        zoom: raster.zoom, liveZoom: live.getZoom(), liveMarker: live.hasLayer(otherMarker),
        raster: raster.schematic, rasterPixels,
        fallback: schematic.schematic, fallbackPixels: await pixels(schematic.image),
      };
    } finally {
      // Exercise cleanup while a canvas redraw from changing zoom is pending.
      L.circleMarker(center).addTo(ctx.map);
      ctx.map.setZoom(18, { animate: false });
      documentMap.close();
      live.remove();
    }
  }, origin);
  expect(result).toMatchObject({
    zoom: 19, liveZoom: 20, liveMarker: true, raster: false, fallback: true,
    rasterPixels: { outside: [255, 0, 0, 255] },
    fallbackPixels: { included: [255, 255, 51, 255] },
  });
  expect(result.rasterPixels.included[1]).toBeGreaterThan(200);
  expect(result.fallbackPixels.outside).not.toEqual(result.rasterPixels.outside);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  expect(pageErrors).toEqual([]);
});

test('a tainted numbered raster falls back to a labelled schematic PNG', async ({ page }) => {
  const foreignTile = 'https://tile-fixture.invalid/uncorsed.png';
  await page.route(foreignTile, route => route.fulfill({ contentType: 'image/png', body: RED_TILE }));
  await page.goto('/');
  const origin = new URL(page.url()).origin;
  await page.setContent('<!doctype html><div id="map" style="width:400px;height:260px"></div>');
  for (const file of ['vendor/leaflet/leaflet.js', 'js/ua.report_v2.js', 'js/ua.evidence_cohort.js']) {
    await page.addScriptTag({ url: `${origin}/${file}` });
  }

  const result = await page.evaluate(async source => {
    const map = L.map('map', { preferCanvas: true }).setView([50.73, 7.10], 17);
    let requestedTiles = 0;
    const privateRaster = L.tileLayer(source);
    const getTileUrl = privateRaster.getTileUrl;
    privateRaster.getTileUrl = function (...args) {
      requestedTiles += 1;
      return getTileUrl.apply(this, args);
    };
    privateRaster.addTo(map);
    const ctx = { map, documentRasterAvailable: true, documentRasterLayers: [privateRaster] };
    const raster = document.createElement('canvas');
    raster.width = 400;
    raster.height = 260;
    const image = new Image();
    image.src = source;
    await image.decode();
    raster.getContext('2d').drawImage(image, 0, 0);
    let denied;
    try { raster.toDataURL(); } catch (error) { denied = error.name; }
    UA.captureExportMapImage = async () => raster;
    const row = { displayId: 'A017', lat: 50.73, lon: 7.10 };
    const options = {
      exportBounds: { south: 50.729, north: 50.731, west: 7.099, east: 7.101 },
      exportPoints: [row],
      evidenceRows: [row],
    };
    const recorded = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
      if (this.canvas !== raster) recorded.push(text);
      return fillText.call(this, text, ...args);
    };
    try {
      const { image: png, schematic } = await UA.captureDocumentMap(ctx, options);
      const decoded = new Image();
      decoded.src = png;
      await decoded.decode();
      const previousRequests = requestedTiles;
      map.setView([50.75, 7.12], 17, { animate: false });
      return { denied, schematic, recorded, width: decoded.width, height: decoded.height,
        subsequentRequests: requestedTiles - previousRequests,
        rasterAvailable: ctx.documentRasterAvailable, released: raster.width === 0 && raster.height === 0 };
    } finally {
      CanvasRenderingContext2D.prototype.fillText = fillText;
      map.remove();
    }
  }, foreignTile);

  expect(result).toMatchObject({ denied: 'SecurityError', schematic: true, rasterAvailable: false,
    width: 400, height: 260, released: true, subsequentRequests: 0 });
  expect(result.recorded).toContain('Schematische Unfallkarte ohne Basiskarte');
  expect(result.recorded).toContain('A017');
});
