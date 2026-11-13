import { test, expect } from '@playwright/test';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { writeRisSnapshot } from '../../server/political-context/services/risSnapshot.js';
import { waitForScreenshotReady } from './helpers.js';

async function waitForTaskSurface(page) {
  const ready = await waitForScreenshotReady(page, {
    city: 'Hannover',
    layers: ['cluster', 'heatmap'],
  });
  const disclosure = page.locator('#collapseBtn');
  if (await disclosure.getAttribute('aria-expanded') === 'false') await disclosure.click();
  await expect(page.locator('#btnOpenExport')).toBeVisible();
  return ready;
}

async function routeReportInputs(page) {
  await page.route(/^https:\/\/(?:[a-z]+\.)?tile\.openstreetmap\.org\//i, route => route.fulfill({
    path: require.resolve('./fixtures/map-tiles/standard.svg'),
    contentType: 'image/svg+xml',
    headers: { 'access-control-allow-origin': '*' },
  }));
  await page.route(/^https:\/\/(?:nominatim\.openstreetmap\.org|overpass-api\.de)\//, route => route.abort());
}

test.describe('responsive task surface', () => {
  test('keyboard user can change the analysis and complete the export-dialog task', async ({ page }) => {
    test.setTimeout(60000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    let ready = await waitForTaskSurface(page);

    const initialPrimaryAction = await page.evaluate(() => {
      const panel = document.getElementById('panel');
      const button = document.getElementById('btnOpenExport');
      const panelRect = panel.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        scrollTop: panel.scrollTop,
        fullyVisible: buttonRect.top >= panelRect.top && buttonRect.bottom <= panelRect.bottom,
      };
    });
    expect(initialPrimaryAction).toEqual({ scrollTop: 0, fullyVisible: true });

    const severity = page.locator('#severity');
    await severity.focus();
    await page.keyboard.press('ArrowDown');
    await expect(severity).not.toHaveValue('all');
    ready = await waitForScreenshotReady(page, { city: 'Hannover', afterRevision: ready.render.revision });

    const mapSettings = page.getByRole('button', { name: 'Karte', exact: true });
    if (await mapSettings.getAttribute('aria-expanded') === 'false') await mapSettings.click();
    const cluster = page.locator('#toggleCluster');
    const initialPressed = await cluster.getAttribute('aria-pressed');
    await cluster.focus();
    await page.keyboard.press('Enter');
    await expect(cluster).toHaveAttribute('aria-pressed', initialPressed === 'true' ? 'false' : 'true');
    ready = await waitForScreenshotReady(page, { city: 'Hannover', afterRevision: ready.render.revision });

    if (await page.locator('#collapseBtn').getAttribute('aria-expanded') === 'false') await page.locator('#collapseBtn').click();
    const open = page.locator('#btnOpenExport');
    const dialog = page.locator('#modalOverlay');
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeVisible();
    await expect(page.locator('#btnCloseModal')).toBeFocused();
    await expect(page.locator('#exportProgress')).toContainText('Fertig', { timeout: 30_000 });

    expect(await page.locator('#panel').evaluate(element => ({
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }))).toEqual({ inert: true, ariaHidden: 'true' });

    // Walk farther than the dialog's focusable count. Focus must never reach
    // the inert map/task surface while the modal is active.
    for (let i = 0; i < 30; i++) await page.keyboard.press('Tab');
    expect(await page.evaluate(() => {
      const dialogElement = document.getElementById('modalOverlay');
      return dialogElement.contains(document.activeElement);
    })).toBe(true);

    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(open).toBeFocused();
    expect(pageErrors).toEqual([]);
  });
});

test.describe('touch task surface', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('touch user can alter the map and open/close the export bottom sheet', async ({ page }) => {
    test.setTimeout(60_000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error && error.message || error)));
    await routeReportInputs(page);
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    let ready = await waitForTaskSurface(page);

    await page.getByRole('button', { name: 'Karte', exact: true }).tap();
    const heat = page.locator('#toggleHeat');
    await heat.scrollIntoViewIfNeeded();
    const initialPressed = await heat.getAttribute('aria-pressed');
    await heat.tap();
    await expect(heat).toHaveAttribute('aria-pressed', initialPressed === 'true' ? 'false' : 'true');
    ready = await waitForScreenshotReady(page, { city: 'Hannover', afterRevision: ready.render.revision });

    await page.locator('#collapseBtn').tap();
    const open = page.locator('#btnOpenExport');
    await open.scrollIntoViewIfNeeded();
    await open.tap();

    const dialog = page.locator('#modalOverlay');
    const modal = dialog.locator('.modal');
    await expect(dialog).toBeVisible();
    await expect(modal).toBeVisible();
    await expect(page.locator('#exportProgress')).toContainText('Fertig', { timeout: 30_000 });

    const geometry = await page.evaluate(() => {
      const root = document.documentElement;
      const panel = document.getElementById('panel');
      const modalElement = document.querySelector('#modalOverlay .modal');
      const openButton = document.getElementById('btnOpenExport').getBoundingClientRect();
      const closeButton = document.getElementById('btnCloseModal').getBoundingClientRect();
      return {
        viewportWidth: window.innerWidth,
        documentWidth: root.scrollWidth,
        panelFits: panel.scrollWidth <= panel.clientWidth + 1,
        modalFits: modalElement.scrollWidth <= modalElement.clientWidth + 1,
        openTarget: { width: openButton.width, height: openButton.height },
        closeTarget: { width: closeButton.width, height: closeButton.height },
      };
    });
    expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.panelFits).toBe(true);
    expect(geometry.modalFits).toBe(true);
    expect(geometry.openTarget.height).toBeGreaterThanOrEqual(44);
    expect(geometry.closeTarget.height).toBeGreaterThanOrEqual(44);

    await page.locator('#btnCloseModal').tap();
    await expect(dialog).toBeHidden();
    expect(pageErrors).toEqual([]);
  });

  test('long context source links fit in the completed export preview', async ({ page }) => {
    const limitation = 'bridge_surface_not_represented_by_dtm,elevated_profile_residual,non_ground_osm_layer';
    await installMobileContextFixture(page, {
      slope_source: 'SRTM Local Tiles',
      road_slope_uncertainty_reasons: [limitation],
    });
    await routeReportInputs(page);
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForTaskSurface(page);
    await page.locator('#btnOpenExport').tap();
    await expect(page.locator('#exportProgress')).toHaveText('Fertig.');

    const modal = page.locator('#modalOverlay .modal');
    const source = modal.getByRole('link', { name: new RegExp(limitation) });
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute('href', 'https://registry.opendata.aws/terrain-tiles/');
    const geometry = await source.evaluate(link => {
      const sheet = link.closest('.modal');
      return {
        textRight: Math.max(...Array.from(link.getClientRects(), rect => rect.right)),
        itemRight: link.closest('li').getBoundingClientRect().right,
        scrollWidth: sheet.scrollWidth,
        clientWidth: sheet.clientWidth,
      };
    });
    expect(geometry.textRight).toBeLessThanOrEqual(geometry.itemRight + 1);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
  });

  test('320px portrait layout and export sheet fit with touch-sized ranges', async ({ page }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 320, height: 720 });
    await installMobileContextFixture(page);
    await routeReportInputs(page);
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForTaskSurface(page);

    const layout = await page.evaluate(() => {
      const panel = document.getElementById('panel');
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        panelLeft: panel.getBoundingClientRect().left,
        panelRight: panel.getBoundingClientRect().right,
        panelScrollWidth: panel.scrollWidth,
        panelClientWidth: panel.clientWidth,
        panelScrollTop: panel.scrollTop,
        primaryActionVisible: (() => {
          const button = document.getElementById('btnOpenExport').getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          return button.top >= panelRect.top && button.bottom <= panelRect.bottom;
        })(),
      };
    });
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.panelLeft).toBeGreaterThanOrEqual(0);
    expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.panelScrollWidth).toBeLessThanOrEqual(layout.panelClientWidth + 1);
    expect(layout.panelScrollTop).toBe(0);
    expect(layout.primaryActionVisible).toBe(true);

    const open = page.locator('#btnOpenExport');
    await open.tap();
    await expect(page.locator('#modalOverlay')).toBeVisible();
    await expect(page.locator('#exportProgress')).toHaveText('Fertig.', { timeout: 30_000 });

    const exportLayout = await page.evaluate(() => {
      const modal = document.querySelector('#modalOverlay .modal');
      const visibleRanges = [...document.querySelectorAll('input[type="range"]')]
        .map(input => ({ input, rect: input.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.height > 0);
      return {
        viewportWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        modalScrollWidth: modal.scrollWidth,
        modalClientWidth: modal.clientWidth,
        rangeHeights: visibleRanges.map(({ rect }) => rect.height),
      };
    });
    expect(exportLayout.documentWidth).toBeLessThanOrEqual(exportLayout.viewportWidth);
    expect(exportLayout.modalScrollWidth).toBeLessThanOrEqual(exportLayout.modalClientWidth + 1);
    expect(exportLayout.rangeHeights.length).toBeGreaterThan(0);
    expect(Math.min(...exportLayout.rangeHeights)).toBeGreaterThanOrEqual(44);
  });
});


// Small real resource responses keep the mobile layout independent of the
// size and enrichment coverage of the checkout's generated city datasets.
async function installMobileContextFixture(page, accidentContext = {}) {
  const accidents = {
    type: 'FeatureCollection',
    features: [0, 1, 2].map(index => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [9.73 + index * 0.001, 52.375 + index * 0.001] },
      properties: {
        id: `mobile-${index}`, ujahr: '2024', ukategorie: '3', uart: '1', utyp1: '1',
        ustunde: '8', uwochentag: '2', umonat: '6', ulichtverh: '0', ustrzustand: '0',
        istrad: '1', istpkw: '1', istfuss: '0', istkrad: '0', istgkfz: '0', istsonstig: '0',
        matched_way_id: 'mobile-road', slope_class: 'steep', slope_percent: 8, ...accidentContext,
      },
    })),
  };
  const resources = new Map([
    ['/out/output_all_years_hannover.geojson', accidents],
    ['/out/poi_hannover.geojson', { type: 'FeatureCollection', features: [] }],
    ['/out/ways_hannover.json', {
      schemaVersion: 2,
      ways: { 'mobile-road': { road_slope_class: 'steep', road_slope_percent: 8 } },
      geometries: { 'mobile-road': [52.374, 9.729, 52.378, 9.733] },
    }],
    ['/out/output_all_years_hannover.enrichment.meta.json', { schemaVersion: 2 }],
  ]);
  await page.route(/\/out\/(?:output_all_years_hannover\.(?:geojson|enrichment\.meta\.json)|poi_hannover\.geojson|ways_hannover\.json)(?:\.gz)?(?:\?|$)/, async route => {
    const pathname = new URL(route.request().url()).pathname;
    const compressed = pathname.endsWith('.gz');
    const payload = resources.get(pathname.replace(/\.gz$/, ''));
    await route.fulfill({
      status: 200,
      contentType: compressed ? 'application/gzip' : 'application/json',
      body: compressed ? gzipSync(JSON.stringify(payload)) : JSON.stringify(payload),
    });
  });
}

const MOBILE_CONTEXT_URL = '/werkbank_v2.html?city=Hannover&mapLayer=slope&ctxOnlyMatched=0';
const MAP_CARDS = ['.carte-control', '.context-overlay-legend'];

async function waitForMobileMap(page) {
  // The full-city loader reports completeness for the intercepted response,
  // so require this fixture's actual rows as well as real layer completion.
  const ready = await waitForScreenshotReady(page, {
    city: 'Hannover', layers: ['cluster', 'heatmap'],
    minLoaded: 3, minFiltered: 3, minViewport: 3,
  });
  expect(ready.counts).toEqual({ loaded: 3, filtered: 3, viewport: 3 });
  expect(ready.coverage).toMatchObject({
    mode: 'full-city', complete: true, provider: 'static', loadedFeatureCount: 3,
  });
  await expect(page.locator('#ctxOverlay_slope')).toBeEnabled();
  await expect(page.locator('.context-overlay-legend')).toBeVisible();
}

test.describe('compact mobile map controls', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 720 },
    { width: 844, height: 390 },
  ]) {
    test(`${viewport.width}x${viewport.height}: map starts with compact, reachable disclosure buttons`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await installMobileContextFixture(page);
      await page.goto(MOBILE_CONTEXT_URL, { waitUntil: 'domcontentloaded' });
      // Do not use waitForTaskSurface: that helper deliberately opens the
      // analysis panel for the existing analysis/export interaction tests.
      await waitForMobileMap(page);
      await expect(page.locator('#collapseBtn')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('#btnOpenExport')).toBeHidden();
      for (const selector of MAP_CARDS) {
        const card = page.locator(selector);
        const toggle = card.locator('.mapControlToggle');
        const body = card.locator('.mapControlBody');
        await expect(toggle).toHaveRole('button');
        await expect(toggle).toHaveAttribute('aria-expanded', 'false');
        const controlledId = await toggle.getAttribute('aria-controls');
        expect(controlledId).toBeTruthy();
        await expect(body).toHaveAttribute('id', controlledId);
        await expect(body).toBeHidden();
      }

      const geometry = await page.evaluate((selectors) => {
        const targets = ['#collapseBtn', ...selectors.map(selector => `${selector} .mapControlToggle`)];
        return {
          width: window.innerWidth,
          height: window.innerHeight,
          documentWidth: document.documentElement.scrollWidth,
          panelHeight: document.getElementById('panel').getBoundingClientRect().height,
          targets: targets.map(selector => {
            const button = document.querySelector(selector);
            const rect = button.getBoundingClientRect();
            const topElement = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return {
              selector, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
              width: rect.width, height: rect.height,
              reachable: Boolean(topElement && button.contains(topElement)),
            };
          }),
          cardHeights: selectors.map(selector => document.querySelector(selector).getBoundingClientRect().height),
        };
      }, MAP_CARDS);
      expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.panelHeight).toBeLessThanOrEqual(100);
      for (const height of geometry.cardHeights) expect(height).toBeLessThanOrEqual(64);
      for (const target of geometry.targets) {
        expect(target.width, `${target.selector} touch width`).toBeGreaterThanOrEqual(44);
        expect(target.height, `${target.selector} touch height`).toBeGreaterThanOrEqual(44);
        expect(target.x, `${target.selector} left edge`).toBeGreaterThanOrEqual(0);
        expect(target.y, `${target.selector} top edge`).toBeGreaterThanOrEqual(0);
        expect(target.right, `${target.selector} right edge`).toBeLessThanOrEqual(geometry.width);
        expect(target.bottom, `${target.selector} bottom edge`).toBeLessThanOrEqual(geometry.height);
        expect(target.reachable, `${target.selector} is covered by another panel`).toBe(true);
      }

      const settings = page.getByRole('button', { name: 'Karte', exact: true });
      await expect(settings).toHaveCount(1);
      await expect(page.getByRole('button', { name: /^(Ebenen|Karten-Layer)$/ })).toHaveCount(0);
      const card = page.locator('.carte-control');
      const collapsed = await card.boundingBox();
      expect(collapsed.width, 'collapsed Karte width').toBeLessThanOrEqual(52);
      await settings.tap();
      await expect(page.locator('#collapseBtn')).toHaveAttribute('aria-expanded', 'false');
      const expanded = await card.boundingBox();
      expect(expanded.width, 'expanded Karte width').toBeLessThanOrEqual(Math.min(256, viewport.width * 0.78));
      const settingsBody = await card.locator('.mapControlBody').boundingBox();
      expect(settingsBody.height, 'visible layer list height').toBeLessThanOrEqual(viewport.height / 2);
      for (const selector of ['#mapModeHybrid', '#toggleHeat', '[data-layer="schools"]', '#ctxOverlay_slope']) {
        const setting = page.locator(selector);
        await setting.scrollIntoViewIfNeeded();
        const rect = await setting.boundingBox();
        expect(rect.height, selector).toBeGreaterThanOrEqual(selector === '#ctxOverlay_slope' ? 22 : 44);
        await setting.click({ trial: true });
      }
      const bikeCounts = card.getByRole('checkbox', { name: /Rad.*zählstellen/i });
      const file = card.locator('input[type="file"]');
      await expect(file).toBeHidden();
      await bikeCounts.check();
      await file.scrollIntoViewIfNeeded();
      const fileBounds = await file.boundingBox();
      expect(fileBounds.height, 'VMZ file picker touch height').toBeGreaterThanOrEqual(44);
      expect(fileBounds.x, 'VMZ file picker left edge').toBeGreaterThanOrEqual(expanded.x);
      expect(fileBounds.x + fileBounds.width, 'VMZ file picker right edge').toBeLessThanOrEqual(expanded.x + expanded.width);
      await page.keyboard.press('Escape');
      await expect(settings).toBeFocused();
      await expect(settings).toHaveAttribute('aria-expanded', 'false');
    });
  }

  test('folding map cards preserves layer choices and survives a context refresh', async ({ page }) => {
    await installMobileContextFixture(page);
    await page.goto(MOBILE_CONTEXT_URL, { waitUntil: 'domcontentloaded' });
    await waitForMobileMap(page);

    const context = page.locator('.context-overlay-control .mapControlToggle');
    const layers = context;
    const legend = page.locator('.context-overlay-legend .mapControlToggle');
    const slope = page.locator('#ctxOverlay_slope');
    const heatmap = page.locator('.carte-control button[data-layer="heatmap"]');
    await context.tap();
    await expect(context).toHaveAttribute('aria-expanded', 'true');
    await expect(slope).toBeVisible();
    await expect(slope).toBeChecked();

    // Context controls are rebuilt when lazy geometry arrives. A user's
    // disclosure choice must survive that same real lifecycle entry point.
    await page.evaluate(() => window.UA.refreshContextOverlays(window.UA.getRuntimeContext()));
    await expect(context).toHaveAttribute('aria-expanded', 'true');
    await expect(slope).toBeVisible();
    await context.tap();
    await page.evaluate(() => window.UA.refreshContextOverlays(window.UA.getRuntimeContext()));
    await expect(context).toHaveAttribute('aria-expanded', 'false');
    await expect(slope).toBeHidden();
    await expect(slope).toBeChecked();

    await layers.tap();
    await expect(heatmap).toHaveClass(/active/);
    await heatmap.tap();
    await expect(heatmap).not.toHaveClass(/active/);
    await expect(page.locator('#toggleHeat')).toHaveAttribute('aria-pressed', 'false');
    await layers.tap();
    await expect(heatmap).toBeHidden();
    await layers.tap();
    await expect(heatmap).not.toHaveClass(/active/);
    await layers.tap();

    await legend.tap();
    await expect(page.locator('.context-road-legend--slope')).toBeVisible();
    await legend.tap();
    await expect(page.locator('.context-road-legend--slope')).toBeHidden();
    await expect(slope).toBeChecked();
    await expect.poll(() => new URL(page.url()).searchParams.get('mapLayer')).toContain('slope');

    await context.tap();
    await page.setViewportSize({ width: 844, height: 390 });
    await expect(context).toHaveAttribute('aria-expanded', 'true');
    await expect(slope).toBeChecked();
    await context.tap();
    await expect(context).toHaveAttribute('aria-expanded', 'false');
  });

  test('map and analysis panel share the mobile space and restore the previous panel choice', async ({ page }) => {
    await installMobileContextFixture(page);
    await page.goto(MOBILE_CONTEXT_URL, { waitUntil: 'domcontentloaded' });
    await waitForMobileMap(page);
    const panel = page.locator('#collapseBtn');
    const settings = page.getByRole('button', { name: 'Karte', exact: true });
    await panel.tap();
    await expect(panel).toHaveAttribute('aria-expanded', 'true');
    await settings.tap();
    await expect(panel).toHaveAttribute('aria-expanded', 'false');
    await expect(settings).toHaveAttribute('aria-expanded', 'true');
    await settings.tap();
    await expect(panel).toHaveAttribute('aria-expanded', 'true');
    await settings.tap();
    await panel.tap();
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await expect(panel).toHaveAttribute('aria-expanded', 'true');
  });

  test('RIS popup fits the phone and restores folded controls without disabling its layer', async ({ page }, testInfo) => {
    await installMobileContextFixture(page);
    const source = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
    const title = 'Querungshilfe und sichere Radwege im Kartenausschnitt';
    const officialUrl = source + 'DS/mobile-popup-2026';
    const directory = testInfo.outputPath('ris');
    const manifest = await writeRisSnapshot(directory, 'hannover', {
      sources: [source],
      coverage: { from: '2026-01-01', to: '2026-11-07', bodies: ['Ratsversammlung'], complete: false, warnings: [] },
      records: [{
        id: 'hannover-sim:mobile-popup-2026', number: 'TEST/2026', title,
        type: 'Antrag', date: null, gremium: 'Ratsversammlung', source: 'hannover-sim', url: officialUrl,
        geometry: { type: 'Point', coordinates: [9.731, 52.376] },
        locationSource: 'derived', locationLabel: 'Querung im Kartenausschnitt',
      }],
    });
    const assets = new Set(['hannover.json', manifest.records.path, manifest.map.path]);
    await page.route('**/data/ris/*', async route => {
      const file = path.posix.basename(new URL(route.request().url()).pathname);
      if (!assets.has(file)) return route.fulfill({ status: 404 });
      return route.fulfill({
        body: await readFile(path.join(directory, file)),
        contentType: file.endsWith('.gz') ? 'application/gzip' : 'application/json',
      });
    });
    await page.goto(MOBILE_CONTEXT_URL + '&centerLat=52.376&centerLon=9.731&zoom=15', { waitUntil: 'domcontentloaded' });
    await waitForMobileMap(page);

    const context = page.locator('.context-overlay-control .mapControlToggle');
    const ris = page.locator('input[data-context-overlay="ris"]');
    await context.tap();
    await ris.check();
    const marker = page.locator('.ua-ris-point');
    await expect(marker).toBeVisible();
    await context.tap();
    await expect(ris).toBeChecked();
    await expect(marker).toBeVisible();
    await marker.tap();

    const popup = page.locator('.ua-ris-popup');
    await expect(popup).toBeVisible();
    const officialLink = popup.getByRole('link', { name: `Amtliches Dokument: ${title}` });
    await expect(officialLink).toHaveAttribute('href', officialUrl);
    await officialLink.click({ trial: true });
    await expect(popup).toBeInViewport({ ratio: 1 });
    const geometry = await popup.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width,
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(280);
    expect(geometry.x).toBeGreaterThanOrEqual(0);
    expect(geometry.y).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth);
    expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
    await expect(page.locator('#panel')).toBeHidden();
    for (const selector of MAP_CARDS) await expect(page.locator(selector)).toBeHidden();

    await popup.locator('.leaflet-popup-close-button').tap();
    await expect(popup).toBeHidden();
    await expect(page.locator('#collapseBtn')).toBeVisible();
    await expect(context).toBeVisible();
    await expect(context).toHaveAttribute('aria-expanded', 'false');
    await expect(marker).toBeVisible();
    await context.tap();
    await expect(ris).toBeChecked();
    await ris.uncheck();
    await expect(marker).toHaveCount(0);
  });

  test('analysis panel opens and closes while accident data is pending and after failure', async ({ page }) => {
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let accidentRequests = 0;
    await page.route(/\/out\/output_all_years_hannover\.geojson(?:\.gz)?(?:\?|$)/, async route => {
      accidentRequests += 1;
      await pending;
      await route.fulfill({ status: 503, contentType: 'text/plain', body: 'Unavailable for mobile loading regression' });
    });
    try {
      await page.goto('/werkbank_v2.html?city=Hannover', { waitUntil: 'domcontentloaded' });
      await expect.poll(() => accidentRequests).toBeGreaterThan(0);
      const disclosure = page.locator('#collapseBtn');
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
      await disclosure.tap();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await expect(page.locator('#btnOpenExport')).toBeVisible();
      await disclosure.tap();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');

      release();
      await expect(page.locator('#stat')).toContainText('Daten konnten nicht geladen werden');
      await disclosure.tap();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
      await disclosure.tap();
      await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    } finally {
      release();
    }
  });
});

test.describe('tablet map settings', () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true });

  test('starts with the map free and switches between analysis, settings and legend on a tablet', async ({ page }) => {
    await installMobileContextFixture(page);
    await page.goto(MOBILE_CONTEXT_URL, { waitUntil: 'domcontentloaded' });
    await waitForMobileMap(page);
    const settings = page.getByRole('button', { name: 'Karte', exact: true });
    const analysis = page.locator('#collapseBtn');
    const legend = page.locator('.context-overlay-legend .mapControlToggle');
    await expect(settings).toHaveCount(1);
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await expect(analysis).toHaveAttribute('aria-expanded', 'false');
    await expect(legend).toHaveAttribute('aria-expanded', 'false');
    await analysis.tap();
    await expect(analysis).toHaveAttribute('aria-expanded', 'true');
    await settings.tap();
    await expect(analysis).toHaveAttribute('aria-expanded', 'false');
    await expect(settings).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#mapModeHybrid').click({ trial: true });
    await page.locator('#toggleCluster').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#toggleCluster')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toggleHeat')).toHaveAttribute('aria-pressed', 'true');
    await legend.tap();
    await expect(legend).toHaveAttribute('aria-expanded', 'true');
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await expect(analysis).toHaveAttribute('aria-expanded', 'false');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(settings).toHaveAttribute('aria-expanded', 'false');
    await settings.tap();
    await expect(page.locator('#toggleCluster')).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('#toggleHeat')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#ctxOverlay_slope')).toBeChecked();
  });
});
