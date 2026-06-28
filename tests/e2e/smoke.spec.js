/**
 * Cross-Browser Smoke Tests
 *
 * Diese Tests prüfen die grundlegende Funktionsfähigkeit der Werkbank V2 in
 * verschiedenen Browsern (Chromium, Firefox, WebKit).  Sie sind bewusst schlank
 * gehalten, damit sie auch bei langsameren CI-Runnern zuverlässig laufen.
 *
 * Projekte: chromium, firefox-smoke, webkit-smoke (playwright.config.js)
 *
 * URLs werden ohne führenden Slash angegeben, damit ein `baseURL` mit Pfad-
 * Präfix (z. B. GitHub Pages `https://…/Unfallatlas/`) erhalten bleibt.
 */

import { test, expect } from '@playwright/test';
import { waitForMapTiles } from './helpers.js';

/**
 * Hängt Listener an Page an, die sowohl `pageerror` als auch
 * `console.error`-Nachrichten einsammeln. Liefert die Sammel-Arrays zurück.
 *
 * Console-Errors werden gegen eine kleine Allowlist gefiltert, da die
 * E2E-Tests die Frontend-Seite gegen einen statischen Server fahren – ohne
 * `/api/*`-Backend. Das frontend-seitige Capability-Probing löst dabei
 * erwartbare 404-Fehler aus, die nichts mit der UI zu tun haben.
 */
const KNOWN_NON_ACTIONABLE_CONSOLE_ERRORS = [
  // Kein Node-Backend im statischen Test-Server → 404-Probes sind erwartet
  /Failed to load resource.*404/i,
  /\/api\//i,
];

function isKnownNonActionable(message) {
  return KNOWN_NON_ACTIONABLE_CONSOLE_ERRORS.some((re) => re.test(message));
}

function attachErrorCollectors(page) {
  const jsErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => jsErrors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (isKnownNonActionable(text)) return;
    consoleErrors.push(text);
  });
  return { jsErrors, consoleErrors };
}

test.describe('Smoke – Werkbank V2', () => {
  test('Seite lädt ohne JS-Fehler (HTTP 200)', async ({ page }) => {
    const { jsErrors, consoleErrors } = attachErrorCollectors(page);

    const response = await page.goto('werkbank_v2.html');
    expect(response.status()).toBe(200);

    await page.waitForLoadState('networkidle');
    expect(jsErrors, `pageerror events:\n${jsErrors.join('\n')}`).toHaveLength(0);
    expect(
      consoleErrors,
      `console.error messages:\n${consoleErrors.join('\n')}`
    ).toHaveLength(0);
  });

  test('Stadt-Dropdown ist sichtbar und hat auswählbare Optionen', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    const citySelect = page.locator('#citySel');
    await expect(citySelect).toBeVisible();

    await page.waitForFunction(() => {
      const select = document.querySelector('#citySel');
      return select && select.querySelectorAll('option').length > 1;
    });

    const optionCount = await citySelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(1);
  });

  test('Schweregrad-Filter lässt sich ändern', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    const severitySelect = page.locator('#severity');
    await expect(severitySelect).toBeVisible();

    await severitySelect.selectOption('1');
    await expect(severitySelect).toHaveValue('1');
  });

  test('Export-Modal lässt sich öffnen', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    // Export-Button (`#btnOpenExport`) ist immer sichtbar – kein Vorab-Klick auf
    // Zeichnen/Löschen nötig, vgl. werkbank_v2.html:148.
    const exportBtn = page.locator('#btnOpenExport');
    await expect(exportBtn).toBeVisible({ timeout: 5000 });
    await exportBtn.click();

    // Modal-Overlay (`#modalOverlay`) wird per inline `display: flex` eingeblendet.
    const exportModal = page.locator('#modalOverlay');
    await expect(exportModal).toBeVisible({ timeout: 5000 });
  });

  // Item 3 (post-PR #261 follow-up): the new top-left "Karten-Layer"
  // overlay control is mounted by ua.map_v2 only when the loaded city
  // exposes `hasOsmContext`. Asserting its presence on Bonn (which
  // ships with enriched ways_bonn.json) makes any future CSS or
  // capability-detection regression that hides it visible in CI.
  test('Karten-Layer-Control ist für Stadt mit OSM-Kontext sichtbar', async ({ page }) => {
    await page.goto('werkbank_v2.html?city=Bonn');
    await page.waitForLoadState('networkidle');

    // Gate: only enforce the assertion when the deployment actually
    // has the per-city ways file. That is the same precondition the
    // app uses to mount the control (capabilitiesFromDetection →
    // hasOsmContext), so a missing file is "no overlays expected".
    const baseUrl = new URL(page.url());
    const waysUrl = new URL('out/ways_bonn.json', baseUrl).toString();
    const waysHead = await page.request.fetch(waysUrl, { method: 'HEAD' }).catch(() => null);
    test.skip(!waysHead || !waysHead.ok(), 'ways_bonn.json not deployed — overlay control not expected');

    const overlayCtrl = page.locator('.context-overlay-control');
    await expect(overlayCtrl).toBeVisible({ timeout: 15000 });
    // Title + capability-gated checkbox(es) must be present so a CSS
    // regression that hides only one of them still trips the test.
    await expect(overlayCtrl).toContainText('Karten-Layer');
    const checkboxes = overlayCtrl.locator('input[type="checkbox"][data-context-overlay]');
    await expect.poll(async () => await checkboxes.count(), { timeout: 15000 })
      .toBeGreaterThan(0);
  });

  // Item 11 (post-PR #261 follow-up): a stale v1 ways_<city>.json
  // from a previous deploy would silently disable the new overlays
  // (loader downgrades to legacy flat shape, no `geometries`). The
  // smoke test fails closed on an unexpectedly old schema so the
  // operator notices before users do. Accepts schemaVersion >= 2
  // (envelope v2 with `geometries`, or v3 tile-index envelope).
  test('ways_bonn.json hat schemaVersion >= 2 (envelope mit geometries oder tile-index)', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    const baseUrl = new URL(page.url());
    const waysUrl = new URL('out/ways_bonn.json', baseUrl).toString();
    // Cache-bust so an edge cache cannot mask a stale file.
    const resp = await page.request.fetch(`${waysUrl}?cb=${Date.now()}`, {
      headers: { 'cache-control': 'no-cache' },
    });
    expect(resp.ok(), `ways_bonn.json fetch failed (HTTP ${resp.status()})`).toBe(true);
    const payload = await resp.json();
    expect(payload && typeof payload === 'object', 'ways_bonn.json is not a JSON object').toBe(true);
    expect(
      typeof payload.schemaVersion === 'number' && payload.schemaVersion >= 2,
      `ways_bonn.json schemaVersion is "${payload.schemaVersion}" — expected >= 2 (rerun enrich.yml so a current producer regenerates the file)`
    ).toBe(true);
  });

  test('Pan + Screenshot enthält keine grauen Tile-Lücken', async ({ page, browserName }) => {
    test.setTimeout(60000);
    await page.goto('werkbank_v2.html?city=Berlin&mapLayer=slope&zoom=16&centerLat=52.521463&centerLon=13.379320');
    await page.waitForLoadState('networkidle');
    await waitForMapTiles(page);

    const mapBounds = await page.locator('#map').boundingBox();
    expect(mapBounds).toBeTruthy();
    if (mapBounds) {
      const startX = mapBounds.x + mapBounds.width * 0.5;
      const startY = mapBounds.y + mapBounds.height * 0.5;
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(startX + 180, startY + 120, { steps: 12 });
      await page.mouse.up();
    }
    await waitForMapTiles(page);

    const buf = await page.locator('#map').screenshot();
    const ratio = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
        img.src = `data:image/png;base64,${b64}`;
      });
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const w = canvas.width;
      let greyBlocks = 0;
      let sampled = 0;
      const at = (x, y) => {
        const i = (y * w + x) * 4;
        return [d[i], d[i + 1], d[i + 2], d[i + 3]];
      };
      for (let y = 0; y < canvas.height - 32; y += 4) {
        for (let x = 0; x < canvas.width - 32; x += 4) {
          const [r, g, b, a] = at(x, y);
          if (a < 250) continue;
          sampled += 1;
          const nearGrey = r >= 236 && r <= 246 && g >= 236 && g <= 246 && b >= 236 && b <= 246;
          if (!nearGrey) continue;
          const [r1, g1, b1] = at(x + 32, y);
          const [r2, g2, b2] = at(x, y + 32);
          const flat = Math.abs(r - r1) <= 2 && Math.abs(g - g1) <= 2 && Math.abs(b - b1) <= 2
            && Math.abs(r - r2) <= 2 && Math.abs(g - g2) <= 2 && Math.abs(b - b2) <= 2;
          if (flat) greyBlocks += 1;
        }
      }
      return greyBlocks / Math.max(sampled, 1);
    }, buf.toString('base64'));
    const maxGreyRatio = browserName === 'webkit' ? 0.04 : 0.01;
    expect(ratio).toBeLessThan(maxGreyRatio);
  });
});
