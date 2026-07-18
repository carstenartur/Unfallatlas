import { test, expect } from '@playwright/test';
import { waitForMapTiles } from './helpers.js';

const CITY = process.env.CONTEXT_E2E_CITY || 'Bonn';
const VIEW = {
  centerLat: process.env.CONTEXT_E2E_CENTER_LAT || '50.7336',
  centerLon: process.env.CONTEXT_E2E_CENTER_LON || '7.0990',
  zoom: process.env.CONTEXT_E2E_ZOOM || '15',
};

function isContextTileUrl(url) {
  return /\/out\/ctxtiles\/[^/]+\/(?:\d+\/)?\d+\/\d+\.json(?:\.gz)?(?:[?#]|$)/i.test(url);
}

async function canvasCounts(page) {
  return page.evaluate(() => {
    const slopePalette = [
      [255, 255, 178],
      [254, 204, 92],
      [253, 141, 60],
      [240, 59, 32],
      [189, 0, 38],
      [154, 169, 184],
    ];
    const trafficPalette = [
      [255, 255, 204],
      [161, 218, 180],
      [65, 182, 196],
      [34, 94, 168],
    ];
    const closeTo = (r, g, b, palette) => palette.some(([pr, pg, pb]) =>
      Math.abs(r - pr) <= 8 && Math.abs(g - pg) <= 8 && Math.abs(b - pb) <= 8
    );
    const counts = { canvases: 0, slopePixels: 0, trafficPixels: 0 };
    const canvases = document.querySelectorAll('.leaflet-overlay-pane canvas');
    for (const canvas of canvases) {
      if (!(canvas instanceof HTMLCanvasElement) || canvas.width === 0 || canvas.height === 0) continue;
      const style = getComputedStyle(canvas);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      let pixels;
      try {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) continue;
        pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      } catch (_) {
        continue;
      }
      counts.canvases += 1;
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3];
        if (alpha < 80) continue;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        if (closeTo(r, g, b, slopePalette)) counts.slopePixels += 1;
        if (closeTo(r, g, b, trafficPalette)) counts.trafficPixels += 1;
      }
    }
    return counts;
  });
}

/**
 * This is deliberately not a producer-file test.
 *
 * The dedicated context-data integration runner first generates the selected
 * city into an isolated static site. This test then exercises the public HTML,
 * gzip loader, capability detection, v3 tile-index loader, viewport tile fetch,
 * Leaflet canvas rendering and visible UI controls. Missing data is a hard
 * failure; there is no conditional skip.
 */
test.describe('Generated context data – browser end to end', () => {
  test('Bonn renders slope and traffic road features in the real web page', async ({ page }, testInfo) => {
    test.setTimeout(150_000);

    const query = new URLSearchParams({
      city: CITY,
      mapLayer: 'slope,traffic',
      centerLat: VIEW.centerLat,
      centerLon: VIEW.centerLon,
      zoom: VIEW.zoom,
      showCluster: '0',
      showHeatmap: '0',
      showSchools: '0',
      showKindergartens: '0',
      showArgumentation: '0',
    });

    const pageErrors = [];
    const contextNetwork = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('response', response => {
      const url = response.url();
      if (isContextTileUrl(url)) contextNetwork.push({ type: 'response', url, status: response.status() });
    });
    page.on('requestfailed', request => {
      const url = request.url();
      if (isContextTileUrl(url)) {
        contextNetwork.push({ type: 'requestfailed', url, error: request.failure()?.errorText || 'unknown' });
      }
    });

    const attachDiagnostics = async rendered => {
      await testInfo.attach('context-render-diagnostics.json', {
        body: Buffer.from(JSON.stringify({ contextNetwork, pageErrors, rendered }, null, 2), 'utf8'),
        contentType: 'application/json',
      });
    };

    const response = await page.goto(`werkbank_v2.html?${query.toString()}`);
    expect(response && response.ok(), 'Werkbank HTML was not served successfully').toBe(true);
    await page.waitForLoadState('networkidle');
    await waitForMapTiles(page);

    // Capability detection must reach the user-facing UI. The old smoke test
    // inspected the GeoJSON first and skipped here; this contract fails closed.
    await expect(page.locator('#ctxFilterSection')).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#ctxFilterEmpty')).toBeHidden();
    await expect(page.locator('#ctxSlopeRow')).toBeVisible();
    await expect(page.locator('#ctxTrafficRow')).toBeVisible();

    const overlayControl = page.locator('.context-overlay-control');
    await expect(overlayControl).toBeVisible({ timeout: 60_000 });
    await expect(overlayControl).toContainText('Karten-Layer');
    await expect(overlayControl.locator('input[data-context-overlay="slope"]')).toBeChecked();
    await expect(overlayControl.locator('input[data-context-overlay="traffic"]')).toBeChecked();

    // The viewport loader must request gzip tiles directly. A raw tile request
    // is a regression: production deploys context tiles gzip-only.
    try {
      await expect.poll(() => contextNetwork.filter(entry =>
        entry.type === 'response' && entry.status === 200 && /\.json\.gz(?:[?#]|$)/i.test(entry.url)
      ).length, {
        timeout: 30_000,
        message: `No successful gzip context-tile response. Network: ${JSON.stringify(contextNetwork)}`,
      }).toBeGreaterThan(0);
    } catch (error) {
      await attachDiagnostics(await canvasCounts(page));
      throw error;
    }

    const rawRequests = contextNetwork.filter(entry =>
      /\/\d+\/\d+\.json(?:[?#]|$)/i.test(entry.url) && !/\.json\.gz(?:[?#]|$)/i.test(entry.url)
    );
    expect(rawRequests, `Raw context-tile requests are forbidden: ${JSON.stringify(rawRequests)}`).toEqual([]);

    // Black-box rendering contract: inspect the pixels users actually see in
    // Leaflet's overlay canvases. `ctx` and the map are intentionally private
    // implementation details, so the test must not depend on window.map or a
    // test-only global.
    let rendered = await canvasCounts(page);
    try {
      await expect.poll(async () => {
        rendered = await canvasCounts(page);
        return rendered.slopePixels >= 20 && rendered.trafficPixels >= 20;
      }, {
        timeout: 60_000,
        message: `Context tiles loaded but no visible slope/traffic pixels. Network: ${JSON.stringify(contextNetwork)}`,
      }).toBe(true);
    } catch (error) {
      await attachDiagnostics(rendered);
      throw error;
    }

    expect(rendered.canvases, 'Leaflet created no visible overlay canvas').toBeGreaterThan(0);
    expect(rendered.slopePixels, 'no visible pixels from the slope signal palette were rendered').toBeGreaterThanOrEqual(20);
    expect(rendered.trafficPixels, 'no visible pixels from the traffic palette were rendered').toBeGreaterThanOrEqual(20);

    // Both active legends must be visible and describe the current road context,
    // not merely leave checked switches with an empty map behind.
    const visibleLegends = page.locator('.context-road-legend:visible');
    await expect.poll(() => visibleLegends.count(), { timeout: 30_000 }).toBe(2);
    const legendText = (await visibleLegends.allTextContents()).join(' ');
    expect(legendText).toMatch(/Straßensteigung/);
    expect(legendText).toMatch(/Verkehrsbelastung/);

    await attachDiagnostics(rendered);
    expect(pageErrors, `pageerror events:\n${pageErrors.join('\n')}`).toHaveLength(0);
  });
});
