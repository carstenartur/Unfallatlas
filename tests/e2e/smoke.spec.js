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
  // Browsers use different wording for unsupported frame-ancestors directives
  // from meta CSP. The directive has no effect in a meta policy by browser
  // definition; the enforceable production contract is the HTTP response
  // header covered by the dedicated security-header tests.
  /Content Security Policy directive 'frame-ancestors' is ignored when delivered via (?:a <meta>|an HTML meta) element/i,
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

async function waitForCityOptions(page) {
  const citySelect = page.locator('#citySel');
  await expect(citySelect).toBeVisible();
  await expect.poll(async () => citySelect.locator('option').count()).toBeGreaterThan(1);
  return citySelect;
}

async function waitForProvenanceRuntime(page) {
  await page.waitForFunction(() => Boolean(window.UA?.exportProvenanceReady));
  await page.evaluate(async () => {
    await window.UA.exportProvenanceReady;
    if (window.UA.exportProvenanceError) throw window.UA.exportProvenanceError;
    if (window.UA.__liveExportProvenanceInstalled !== true) {
      throw new Error('Live export provenance was not installed');
    }
  });
}

test.describe('Smoke – Werkbank V2', () => {
  test('Seite lädt ohne JS-Fehler (HTTP 200)', async ({ page }) => {
    const { jsErrors, consoleErrors } = attachErrorCollectors(page);

    const response = await page.goto('werkbank_v2.html');
    expect(response.status()).toBe(200);

    // Die Anwendung führt zulässige Hintergrundabfragen aus; globales
    // `networkidle` ist deshalb kein stabiler Bereitschaftsvertrag. Stattdessen
    // warten wir auf die sichtbare Haupt-UI und die komplette Runtime-Kette.
    await waitForCityOptions(page);
    await waitForProvenanceRuntime(page);
    expect(jsErrors, `pageerror events:\n${jsErrors.join('\n')}`).toHaveLength(0);
    expect(
      consoleErrors,
      `console.error messages:\n${consoleErrors.join('\n')}`
    ).toHaveLength(0);
  });

  test('Build-Manifest dokumentiert Daten, lokale Abhängigkeiten und Lizenzprovenienz', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    const baseUrl = new URL(page.url());
    const manifestUrl = new URL('build-manifest.json', baseUrl).toString();
    const response = await page.request.get(manifestUrl);
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.networkPolicy?.runtimeLibraries).toBe('local-only');
    expect(Object.keys(manifest.dependencies || {}).length).toBeGreaterThan(0);
    expect(manifest.vendorAssets?.length).toBeGreaterThan(0);
    expect(manifest.data?.artifacts?.length).toBeGreaterThan(0);
    expect(Object.keys(manifest.data?.cities || {}).length).toBeGreaterThan(0);
    expect(manifest.thirdPartyNotices?.path).toBe('vendor/third-party-notices.json');
    expect(manifest.thirdPartyNotices?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.thirdPartyNotices?.dependencies?.length)
      .toBe(Object.keys(manifest.dependencies).length);

    const noticesUrl = new URL(manifest.thirdPartyNotices.path, baseUrl).toString();
    const noticesResponse = await page.request.get(noticesUrl);
    expect(noticesResponse.status()).toBe(200);
    const notices = await noticesResponse.json();
    expect(notices.dependencies).toHaveLength(Object.keys(manifest.dependencies).length);
  });

  test('Stadt-Dropdown ist sichtbar und hat auswählbare Optionen', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    const citySelect = await waitForCityOptions(page);
    const optionCount = await citySelect.locator('option').count();
    expect(optionCount).toBeGreaterThan(1);
  });

  test('Schweregrad-Filter lässt sich ändern', async ({ page }) => {
    await page.goto('werkbank_v2.html');

    // Dieser Test benötigt nur das statisch gebundene Filterelement. Optionale
    // Daten-/Capability-Abfragen dürfen parallel weiterlaufen.
    const severitySelect = page.locator('#severity');
    await expect(severitySelect).toBeVisible();
    await expect(severitySelect.locator('option')).toHaveCount(4);

    await severitySelect.selectOption('1');
    await expect(severitySelect).toHaveValue('1');
  });

  test('Export-Modal lässt sich öffnen', async ({ page }) => {
    await page.goto('werkbank_v2.html');

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
    await page.waitForFunction(() => typeof window.UA?.fetchJsonCompressed === 'function');

    // Gate: only enforce the assertion when the deployment actually
    // has enriched data with slope or traffic fields. The overlay
    // control is mounted by ua.map_v2 only when hasSlope or hasTrafficProxy
    // is true, so unenriched data means "no overlays expected".
    const baseUrl = new URL(page.url());
    const dataUrl = new URL('out/output_all_years_bonn.geojson.gz', baseUrl).toString();
    const geojson = await page.evaluate(async (url) => {
      return window.UA.fetchJsonCompressed(url, { gzipOnly: true });
    }, dataUrl);
    expect(Array.isArray(geojson?.features), 'Bonn GeoJSON has no features array').toBe(true);
    expect(geojson.features.length, 'Bonn GeoJSON unexpectedly contains no accident data').toBeGreaterThan(0);
    const props = geojson.features[0]?.properties || {};
    // Check for slope or traffic fields (same as CAPABILITY_FIELDS in ua.context_layers.js)
    const hasOverlayCapability =
      'slope_percent' in props || 'slope_abs_percent' in props || 'slope_class' in props ||
      'slope_source' in props || 'slope_confidence' in props || 'traffic_proxy_class' in props;
    test.skip(!hasOverlayCapability, 'Bonn GeoJSON not enriched with slope/traffic fields — overlay control not expected');

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
    const waysUrlGz = new URL('out/ways_bonn.json.gz', baseUrl).toString();

    // Gate: skip when the .gz file is not deployed (CI-Checkout ohne Datendateien).
    const waysHead = await page.request.fetch(waysUrlGz, { method: 'HEAD' }).catch(() => null);
    test.skip(!waysHead || !waysHead.ok(), 'ways_bonn.json.gz not deployed — schema-version check skipped');

    await page.waitForFunction(() => typeof window.UA?.fetchJsonCompressed === 'function');
    // Decompress via the UA helper already present on the page so we don't
    // need to pipe raw gzip bytes through Node.js zlib in the test runner.
    const payload = await page.evaluate(async (url) => {
      return window.UA.fetchJsonCompressed(url, { gzipOnly: true });
    }, waysUrlGz);
    expect(payload && typeof payload === 'object', 'ways_bonn.json.gz is not a JSON object').toBe(true);
    expect(
      typeof payload.schemaVersion === 'number' && payload.schemaVersion >= 2,
      `ways_bonn.json.gz schemaVersion is "${payload.schemaVersion}" — expected >= 2 (rerun enrich.yml so a current producer regenerates the file)`
    ).toBe(true);
  });

  test('Pan + Screenshot enthält keine grauen Tile-Lücken', async ({ page, browserName }) => {
    test.setTimeout(60000);
    await page.goto('werkbank_v2.html?city=Berlin&mapLayer=slope&zoom=16&centerLat=52.521463&centerLon=13.379320');
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
