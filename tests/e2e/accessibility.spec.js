/**
 * Accessibility-Tests mit axe-core
 *
 * Prüft die Werkbank V2 auf WCAG-Violations vom Schweregrad "serious" und
 * "critical" – sowohl die Hauptseite als auch das geöffnete Export-Modal.
 *
 * Abhängigkeit: @axe-core/playwright (devDependency in package.json)
 */

import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.describe('Accessibility – Werkbank V2', () => {
  test('Hauptseite hat keine critical/serious axe-Violations', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );

    expect(
      blocking,
      `axe found ${blocking.length} serious/critical violation(s):\n` +
        blocking.map((v) => `  [${v.impact}] ${v.id}: ${v.description}`).join('\n')
    ).toHaveLength(0);
  });

  test('Export-Modal hat keine critical/serious axe-Violations', async ({ page }) => {
    await page.goto('werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    // Export-Button ist `#btnOpenExport` (werkbank_v2.html:148).
    const exportBtn = page.locator('#btnOpenExport');
    await expect(exportBtn).toBeVisible({ timeout: 5000 });
    await exportBtn.click();

    // Den Dialog-Container selbst einschließen, damit axe auch dessen
    // accessible name, aria-modal und Dialog-Semantik prüft.
    const exportModal = page.locator('#modalOverlay');
    await expect(exportModal).toBeVisible({ timeout: 5000 });

    const results = await new AxeBuilder({ page })
      .include('#modalOverlay')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );

    expect(
      blocking,
      `axe found ${blocking.length} serious/critical violation(s) in export modal:\n` +
        blocking.map((v) => `  [${v.impact}] ${v.id}: ${v.description}`).join('\n')
    ).toHaveLength(0);
  });

  test('Export-Dialog unterstützt Tastaturfokus, Escape und Fokus-Rückgabe', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    const openButton = page.locator('#btnOpenExport');
    const closeButton = page.locator('#btnCloseModal');
    const dialog = page.locator('#modalOverlay');

    await openButton.scrollIntoViewIfNeeded();
    await openButton.focus();
    await openButton.press('Enter');

    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-labelledby', 'exportModalTitle');
    await expect(closeButton).toBeFocused();

    await page.keyboard.press('Escape');

    await expect(dialog).toBeHidden();
    await expect(openButton).toBeFocused();
  });

  test('Legende und Bedienfeld geben ihren Offen-Zustand für Tastaturbedienung aus', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    const legendButton = page.locator('#legendBtn');
    const legend = page.locator('#legendBox');
    await legendButton.focus();
    await legendButton.press('Enter');
    await expect(legendButton).toHaveAttribute('aria-expanded', 'true');
    await expect(legend).toBeVisible();

    const collapseButton = page.locator('#collapseBtn');
    await collapseButton.focus();
    await collapseButton.press('Space');
    await expect(collapseButton).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#panelBody')).toBeHidden();
  });
});
