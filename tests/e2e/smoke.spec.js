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
});
