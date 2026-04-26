/**
 * Cross-Browser Smoke Tests
 *
 * Diese Tests prüfen die grundlegende Funktionsfähigkeit der Werkbank V2 in
 * verschiedenen Browsern (Chromium, Firefox, WebKit).  Sie sind bewusst schlank
 * gehalten, damit sie auch bei langsameren CI-Runnern zuverlässig laufen.
 *
 * Projekte: chromium-smoke, firefox-smoke, webkit-smoke (playwright.config.js)
 */

import { test, expect } from '@playwright/test';

test.describe('Smoke – Werkbank V2', () => {
  test('Seite lädt ohne JS-Fehler (HTTP 200)', async ({ page }) => {
    const jsErrors = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));

    const response = await page.goto('/werkbank_v2.html');
    expect(response.status()).toBe(200);

    await page.waitForLoadState('networkidle');
    expect(jsErrors).toHaveLength(0);
  });

  test('Stadt-Dropdown ist sichtbar und hat auswählbare Optionen', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
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
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    const severitySelect = page.locator('#severity');
    await expect(severitySelect).toBeVisible();

    await severitySelect.selectOption('1');
    await expect(severitySelect).toHaveValue('1');
  });

  test('Export-Modal lässt sich öffnen', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    // Zeichenmodus aktivieren, damit der Export-Button sichtbar wird
    const drawBtn = page.locator('#drawBtn');
    if (await drawBtn.isVisible()) {
      await drawBtn.click();
      // Zeichnung löschen, damit exportBtn aktiv wird
      const clearBtn = page.locator('#clearDrawing');
      if (await clearBtn.isVisible()) {
        await clearBtn.click();
      }
    }

    // Export-Button suchen und klicken
    const exportBtn = page.locator('#exportBtn');
    await expect(exportBtn).toBeVisible({ timeout: 5000 });
    await exportBtn.click();

    // Modal muss sichtbar sein
    const exportModal = page.locator('#exportModal');
    await expect(exportModal).toBeVisible({ timeout: 5000 });
  });
});
