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
  test('Hauptseite hat keine critical/serious axe-Violations', async ({ page }, testInfo) => {
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();

    const blocking = results.violations.filter(
      (v) => v.impact === 'critical' || v.impact === 'serious'
    );
    await testInfo.attach('axe-main-all-violations', {
      body: Buffer.from(JSON.stringify(results.violations, null, 2)),
      contentType: 'application/json',
    });

    expect(
      blocking,
      `axe found ${blocking.length} serious/critical violation(s):\n` +
        blocking.map((v) => `  [${v.impact}] ${v.id}: ${v.description}`).join('\n')
    ).toHaveLength(0);
  });

  test('alle vier Arbeitsdialoge haben keine critical/serious axe-Violations', async ({ page }, testInfo) => {
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
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
      await testInfo.attach(`axe-${dialog.name}-all-violations`, {
        body: Buffer.from(JSON.stringify(results.violations, null, 2)),
        contentType: 'application/json',
      });

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

  test('alle Arbeitsdialoge schließen per Escape und geben den Fokus zurück', async ({ page }) => {
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

    const dialogs = [
      {
        name: 'Export',
        opener: '#btnOpenExport',
        dialog: '#modalOverlay',
        open: async () => page.locator('#btnOpenExport').press('Enter'),
      },
      {
        name: 'Politische Kontextrecherche',
        opener: '#btnPolCtxOpen',
        dialog: '#polCtxPanel',
        open: async () => page.locator('#btnPolCtxOpen').press('Enter'),
      },
      {
        name: 'Prioritäten',
        opener: '#btnPrioritiesOpen',
        dialog: '#prioPanel',
        open: async () => page.locator('#btnPrioritiesOpen').press('Enter'),
      },
      {
        name: 'Tour-Rekorder',
        opener: '#tourBtnRecord',
        dialog: '#recorderModal',
        open: async () => {
          await page.locator('#tourBtnRecord').press('Enter');
          await page.locator('#tourBtnRecord').press('Enter');
        },
      },
    ];

    for (const item of dialogs) {
      const opener = page.locator(item.opener);
      const dialog = page.locator(item.dialog);
      await opener.scrollIntoViewIfNeeded();
      await opener.focus();
      await item.open();
      await expect(dialog, item.name).toBeVisible();
      expect(await page.evaluate(selector => {
        const element = document.querySelector(selector);
        return Boolean(element && element.contains(document.activeElement));
      }, item.dialog), `${item.name}: initial focus`).toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog, item.name).toBeHidden();
      await expect(opener, `${item.name}: focus return`).toBeFocused();
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

  test('Forced-Colors-Modus bewahrt sichtbare Zustände und Tastaturfokus', async ({ page }) => {
    await page.emulateMedia({ forcedColors: 'active' });
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

    const button = page.locator('#btnOpenExport');
    await button.focus();
    const styles = await button.evaluate(element => {
      const style = getComputedStyle(element);
      return {
        borderStyle: style.borderStyle,
        borderWidth: style.borderWidth,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
      };
    });
    expect(styles.borderStyle).not.toBe('none');
    expect(Number.parseFloat(styles.borderWidth)).toBeGreaterThan(0);
    expect(styles.outlineStyle).not.toBe('none');
    expect(Number.parseFloat(styles.outlineWidth)).toBeGreaterThanOrEqual(2);
  });

  test('Reduced-Motion-Modus entfernt wahrnehmbare Animationen', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/werkbank_v2.html', { waitUntil: 'domcontentloaded' });
    await waitForScreenshotReady(page, { city: 'Hannover' });

    const timings = await page.locator('#btnOpenExport').evaluate(element => {
      const style = getComputedStyle(element);
      const seconds = value => value.split(',').map(part => {
        const item = part.trim();
        return item.endsWith('ms') ? Number.parseFloat(item) / 1000 : Number.parseFloat(item);
      });
      return {
        transitions: seconds(style.transitionDuration),
        animations: seconds(style.animationDuration),
      };
    });
    expect(Math.max(...timings.transitions, 0)).toBeLessThanOrEqual(0.001);
    expect(Math.max(...timings.animations, 0)).toBeLessThanOrEqual(0.001);
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
