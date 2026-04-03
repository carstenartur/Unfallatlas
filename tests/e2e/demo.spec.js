/**
 * Demo-Flow für die Unfallwerkbank V2
 *
 * Dieser Test erzeugt ein zusammenhängendes Video, das die wichtigsten
 * Funktionen der Werkbank zeigt.  Abspielen: `npm run demo`, Video landet
 * unter `test-results/`.
 *
 * Der Test ist bewusst als EIN langer Ablauf angelegt, damit Playwright
 * ein durchgehendes Video aufzeichnet.
 */

import { test, expect } from '@playwright/test';

// Dem Demo-Test mehr Zeit geben (Video-Aufnahme + Pausen)
test.setTimeout(120_000);

/** Hilfsfunktion: Warten bis Städte geladen sind */
async function waitForCities(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#citySel');
    if (!select) return false;
    const opts = select.querySelectorAll('option');
    // Mindestens 2 Optionen UND keine "Lade…"-Option mehr
    return opts.length > 1 && ![...opts].some(o => o.textContent.includes('Lade'));
  }, { timeout: 60000 });
}

/** Hilfsfunktion: Warten bis Daten geladen sind (stat-Element zeigt nicht 0) */
async function waitForData(page) {
  await page.waitForFunction(() => {
    const stat = document.querySelector('#stat');
    return stat && stat.textContent.includes('geladen:') && !stat.textContent.includes('geladen: 0');
  }, { timeout: 30000 });
}

test.describe('Werkbank V2 – Demo-Ablauf', () => {

  test('Kompletter Demo-Flow', async ({ page }) => {

    // ── 1. Startansicht laden ──────────────────────────────────────────
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('domcontentloaded');
    await waitForCities(page);
    await expect(page).toHaveTitle(/Unfallwerkbank V2/);
    await page.waitForTimeout(1500);              // kurze Pause zum Betrachten

    // ── 2. Stadt wählen: Bonn ──────────────────────────────────────────
    await page.locator('#citySel').selectOption('Bonn');
    await waitForData(page);
    await page.waitForTimeout(2000);

    // ── 3. Filter: Schwere auf "Schwerverletzt" ────────────────────────
    await page.locator('#severity').selectOption('2');
    await page.waitForTimeout(1000);

    // ── 4. Beteiligung: nur Fahrrad + PKW aktivieren ───────────────────
    const incPed = page.locator('#incPed');
    if (await incPed.isChecked()) await incPed.click();
    const incBike = page.locator('#incBike');
    if (!(await incBike.isChecked())) await incBike.click();
    const incCar = page.locator('#incCar');
    if (!(await incCar.isChecked())) await incCar.click();
    const incMoto = page.locator('#incMoto');
    if (await incMoto.isChecked()) await incMoto.click();
    await page.waitForTimeout(1000);

    // ── 5. UND-Modus aktivieren ────────────────────────────────────────
    await page.locator('#modeAnd').click();
    await page.waitForTimeout(1000);

    // ── 6. Stundenbereich auf Berufsverkehr setzen ─────────────────────
    await page.locator('#hFrom').fill('6');
    await page.locator('#hFrom').dispatchEvent('input');
    await page.locator('#hTo').fill('18');
    await page.locator('#hTo').dispatchEvent('input');
    await page.waitForTimeout(1000);

    // ── 7. Heatmap aktivieren ──────────────────────────────────────────
    await page.locator('#toggleHeat').click();
    await page.waitForTimeout(1500);

    // ── 8. Cluster deaktivieren (nur Heatmap zeigen) ───────────────────
    const clusterBtn = page.locator('#toggleCluster');
    if ((await clusterBtn.getAttribute('class'))?.includes('active')) {
      await clusterBtn.click();
    }
    await page.waitForTimeout(1500);

    // ── 9. Cluster wieder aktivieren, Heatmap aus ──────────────────────
    await clusterBtn.click();
    await page.locator('#toggleHeat').click();
    await page.waitForTimeout(1000);

    // ── 10. Legende öffnen ─────────────────────────────────────────────
    await page.locator('#legendBtn').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('#legendBox');
      return el && window.getComputedStyle(el).display !== 'none';
    });
    await page.waitForTimeout(1500);
    await page.locator('#legendBtn').click();           // wieder schließen
    await page.waitForTimeout(500);

    // ── 11. Alle Filter zurücksetzen: OR-Modus, alle Beteiligungen ────
    await page.locator('#modeOr').click();
    await page.locator('#severity').selectOption('all');
    if (!(await incPed.isChecked())) await incPed.click();
    await page.locator('#hFrom').fill('0');
    await page.locator('#hFrom').dispatchEvent('input');
    await page.locator('#hTo').fill('23');
    await page.locator('#hTo').dispatchEvent('input');
    await page.waitForTimeout(1000);

    // ── 12. Export-Modal öffnen ────────────────────────────────────────
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.waitForTimeout(2500);

    // ── 13. Export-Modal schließen ────────────────────────────────────
    await page.locator('#btnCloseModal').click();
    await page.locator('#modalOverlay').waitFor({ state: 'hidden' });
    await page.waitForTimeout(1000);

    // ── Fertig ─────────────────────────────────────────────────────────
  });
});
