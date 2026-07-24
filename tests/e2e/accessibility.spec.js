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
import { waitForScreenshotReady } from './helpers.js';

function seriousOrCritical(violations) {
  return violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious'
  );
}

test.describe('Accessibility – Werkbank V2', () => {
  test('Hauptseite hat keine critical/serious axe-Violations', async ({ page }) => {
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

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

  test('alle vier Arbeitsdialoge haben keine critical/serious axe-Violations', async ({ page }) => {
    await page.goto('werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

    const dialogs = [
      {
        name: 'Export',
        selector: '#modalOverlay',
        open: async () => page.locator('#btnOpenExport').click(),
        close: async () => page.locator('#btnCloseModal').click(),
      },
      {
        name: 'Politische Kontextrecherche',
        selector: '#polCtxPanel',
        open: async () => page.locator('#btnPolCtxOpen').click(),
        close: async () => page.locator('#polCtxBtnClose').click(),
      },
      {
        name: 'Prioritäten',
        selector: '#prioPanel',
        open: async () => page.locator('#btnPrioritiesOpen').click(),
        close: async () => page.locator('#prioBtnClose').click(),
      },
      {
        name: 'Tour-Rekorder',
        selector: '#recorderModal',
        open: async () => {
          await page.locator('#tourBtnRecord').click();
          await page.locator('#tourBtnRecord').click();
        },
        close: async () => page.locator('#recorderBtnClose').click(),
      },
    ];

    for (const dialog of dialogs) {
      await dialog.open();
      await expect(page.locator(dialog.selector)).toBeVisible({ timeout: 5000 });

      const results = await new AxeBuilder({ page })
        .include(dialog.selector)
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const blocking = seriousOrCritical(results.violations);

      expect(
        blocking,
        `axe found ${blocking.length} serious/critical violation(s) in ${dialog.name}:\n` +
          blocking.map((violation) =>
            `  [${violation.impact}] ${violation.id}: ${violation.description}`
          ).join('\n')
      ).toHaveLength(0);

      await dialog.close();
      await expect(page.locator(dialog.selector)).toBeHidden();
    }
  });

  test('Export-Dialog unterstützt Tastaturfokus, Escape und Fokus-Rückgabe', async ({ page }) => {
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

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
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

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
