import { test, expect } from '@playwright/test';
import { waitForMapTiles } from './helpers.js';

const CITY = process.env.CONTEXT_E2E_CITY || 'Bonn';
const VIEW = {
  centerLat: process.env.CONTEXT_E2E_CENTER_LAT || '50.7336',
  centerLon: process.env.CONTEXT_E2E_CENTER_LON || '7.0990',
  zoom: process.env.CONTEXT_E2E_ZOOM || '15',
};

/**
 * This is deliberately not a producer-file test.
 *
 * The dedicated context-data integration runner first generates the selected
 * city into an isolated static site. This test then exercises the public HTML,
 * gzip loader, capability detection, v3 tile-index loader, viewport tile fetch,
 * Leaflet layer construction and visible UI controls. Missing data is a hard
 * failure; there is no conditional skip.
 */
test.describe('Generated context data – browser end to end', () => {
  test('Bonn renders slope and traffic road features in the real web page', async ({ page }) => {
    test.setTimeout(120_000);

    const query = new URLSearchParams({
      city: CITY,
      mapLayer: 'slope,traffic',
      centerLat: VIEW.centerLat,
      centerLon: VIEW.centerLon,
      zoom: VIEW.zoom,
      showCluster: '0',
      showHeatmap: '0',
      showArgumentation: '0',
    });

    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

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

    // Wait until the v3 context-tile loader has fetched viewport tiles and the
    // actual Leaflet polylines have been added to the map. Leaflet exposes the
    // two context overlays as top-level LayerGroups; the road polylines carrying
    // `feature.properties.kind` are their children, so traversal must recurse.
    await page.waitForFunction(() => {
      const map = window.map || (window.UA && window.UA.ctx && window.UA.ctx.map);
      if (!map || typeof map.eachLayer !== 'function') return false;
      const counts = { slope: 0, slopeSignal: 0, traffic: 0 };
      const visited = new Set();
      const visit = layer => {
        if (!layer || visited.has(layer)) return;
        visited.add(layer);
        const props = layer.feature && layer.feature.properties;
        if (props && props.kind === 'slope') {
          counts.slope += 1;
          if (props.class !== 'no_signal') counts.slopeSignal += 1;
        } else if (props && props.kind === 'traffic') {
          counts.traffic += 1;
        }
        if (typeof layer.getLayers === 'function') {
          for (const child of layer.getLayers() || []) visit(child);
        }
      };
      map.eachLayer(visit);
      window.__uaContextRenderCounts = counts;
      return counts.slope > 0 && counts.slopeSignal > 0 && counts.traffic > 0;
    }, null, { timeout: 90_000 });

    const rendered = await page.evaluate(() => window.__uaContextRenderCounts);
    expect(rendered.slope, 'no slope road polylines were rendered').toBeGreaterThan(0);
    expect(rendered.slopeSignal, 'slope layer only rendered no-signal roads').toBeGreaterThan(0);
    expect(rendered.traffic, 'no traffic-proxy road polylines were rendered').toBeGreaterThan(0);

    // At least one active legend must be visible and describe the current road
    // context instead of leaving an empty map-layer switch behind.
    const visibleLegends = page.locator('.context-road-legend:visible');
    await expect.poll(() => visibleLegends.count(), { timeout: 30_000 }).toBeGreaterThan(0);
    const legendText = (await visibleLegends.allTextContents()).join(' ');
    expect(legendText).toMatch(/Straßensteigung|Verkehrsbelastung/);

    expect(pageErrors, `pageerror events:\n${pageErrors.join('\n')}`).toHaveLength(0);
  });
});
