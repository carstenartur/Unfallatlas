/**
 * Screenshot-Tests für die Werkbank V2 Dokumentation
 * Erstellt automatisch Screenshots und speichert sie unter docs/screenshots/
 */

import { test } from '@playwright/test';

test.describe('Werkbank V2 – Dokumentations-Screenshots', () => {
  test('01 Startansicht', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'docs/screenshots/01-startansicht.png', fullPage: true });
  });

  test('02 Stadtauswahl', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => {
      const select = document.querySelector('#citySel');
      return select && select.querySelectorAll('option').length > 1;
    });
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/02-stadtauswahl.png' });
  });

  test('03 Filter', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => {
      const select = document.querySelector('#citySel');
      return select && select.querySelectorAll('option').length > 1;
    });
    // Schwere auf "Getötete" setzen
    await page.locator('#severity').selectOption('1');
    // Fahrrad-Checkbox abwählen, Fuß-Checkbox anwählen
    const bike = page.locator('#incBike');
    if (await bike.isChecked()) await bike.click();
    const foot = page.locator('#incFoot');
    if (!(await foot.isChecked())) await foot.click();
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/03-filter.png' });
  });

  test('04 Cluster-Ansicht', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    // Cluster ist standardmäßig aktiv
    await page.locator('#map').screenshot({ path: 'docs/screenshots/04-cluster-ansicht.png' });
  });

  test('05 Heatmap-Ansicht', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#toggleHeat').click();
    await page.waitForFunction(() => {
      const btn = document.querySelector('#toggleHeat');
      return btn && btn.classList.contains('active');
    });
    await page.locator('#map').screenshot({ path: 'docs/screenshots/05-heatmap-ansicht.png' });
  });

  test('06 Legende', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#legendBtn').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('#legendBox');
      return el && window.getComputedStyle(el).display !== 'none';
    });
    await page.screenshot({ path: 'docs/screenshots/06-legende.png', fullPage: true });
  });

  test('07 Export-Modal', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => {
      const select = document.querySelector('#citySel');
      return select && select.querySelectorAll('option').length > 1;
    });
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.screenshot({ path: 'docs/screenshots/07-export-modal.png', fullPage: true });
  });

  test('08 Stundenfilter', async ({ page }) => {
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('networkidle');
    await page.locator('#hFrom').fill('6');
    await page.locator('#hTo').fill('18');
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/08-stundenfilter.png' });
  });
});
