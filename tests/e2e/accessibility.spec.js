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
    await page.goto('/werkbank_v2.html');
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
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');

    // Export-Button anklicken
    const exportBtn = page.locator('#exportBtn');
    await expect(exportBtn).toBeVisible({ timeout: 5000 });
    await exportBtn.click();

    const exportModal = page.locator('#exportModal');
    await expect(exportModal).toBeVisible({ timeout: 5000 });

    const results = await new AxeBuilder({ page })
      .include('#exportModal')
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
});
