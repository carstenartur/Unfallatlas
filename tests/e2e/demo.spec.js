/**
 * Demo-Flow für die Unfallwerkbank V2
 *
 * Dieser Test erzeugt ein zusammenhängendes Video, das die wichtigsten
 * Funktionen der Werkbank zeigt.  Abspielen: `npm run demo`, Video landet
 * unter `test-results/`.
 *
 * Story: Bonn → Radfahrer-Alleinunfälle filtern → Heatmap zeigt Hotspot →
 *        Heranzoomen → Bereich markieren → Export/Analyse → Antrag scrollen →
 *        PDF-Export → Ergebnis.
 *
 * Der Test ist bewusst als EIN langer Ablauf angelegt, damit Playwright
 * ein durchgehendes Video aufzeichnet.
 */

import { test, expect } from '@playwright/test';
import { setupCDNRoutes } from './helpers.js';

// Dem Demo-Test mehr Zeit geben (Video-Aufnahme + Pausen + PDF-Export)
test.setTimeout(300_000);

/** Hilfsfunktion: Warten bis Städte geladen sind */
async function waitForCities(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#citySel');
    if (!select) return false;
    const opts = select.querySelectorAll('option');
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

/** Hilfsfunktion: Warten bis ALLE Kachel-Bilder im Tile-Pane vollständig geladen sind */
async function waitForTiles(page) {
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('.leaflet-tile-pane img');
    return imgs.length >= 4
      && [...imgs].every(i => i.complete && i.naturalWidth > 0);
  }, { timeout: 30000 });
}

/**
 * Karte per flyTo bewegen und warten bis Tiles + Animation fertig sind.
 * Nutzt window._uaMap (in ua.map_v2.js gesetzt).
 */
async function flyToAndWait(page, lat, lng, zoom) {
  await page.evaluate(({ lat, lng, zoom }) => {
    return new Promise(resolve => {
      const map = window._uaMap;
      map.once('moveend', () => setTimeout(resolve, 200));
      map.flyTo([lat, lng], zoom, { duration: 1.2 });
    });
  }, { lat, lng, zoom });
  await waitForTiles(page);
}

test.describe('Werkbank V2 – Demo-Ablauf', () => {

  test('Kompletter Demo-Flow', async ({ page }) => {

    // ── 1. Startansicht laden ──────────────────────────────────────────
    // CDN-Routen für Export-Bibliotheken einrichten (pdfmake, docx, file-saver)
    // Muss VOR page.goto geschehen, damit keine CDN-Anfragen verpasst werden.
    await setupCDNRoutes(page);
    await page.goto('/werkbank_v2.html');
    await page.waitForLoadState('domcontentloaded');
    await waitForCities(page);
    await expect(page).toHaveTitle(/Unfallwerkbank V2/);
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── 2. Stadt wählen: Bonn ──────────────────────────────────────────
    await page.locator('#citySel').selectOption('Bonn');
    await waitForData(page);
    await waitForTiles(page);
    await page.waitForTimeout(2500);

    // ── 3. Filter: nur Radfahrer-Beteiligung ───────────────────────────
    //    Nur Fahrrad ankreuzen, alles andere abwählen.
    const incPed  = page.locator('#incPed');
    const incBike = page.locator('#incBike');
    const incCar  = page.locator('#incCar');
    const incMoto = page.locator('#incMoto');
    if (await incPed.isChecked())       await incPed.click();
    if (!(await incBike.isChecked()))   await incBike.click();
    if (await incCar.isChecked())       await incCar.click();
    if (await incMoto.isChecked())      await incMoto.click();
    await waitForTiles(page);
    await page.waitForTimeout(1500);

    // ── 4. Alleinunfall-Modus aktivieren ───────────────────────────────
    //    „Alleinunfall" zeigt nur Unfälle mit genau einem Beteiligungstyp –
    //    hier: reine Radfahrer-Stürze, typisch an Schienen/Kanten.
    await page.locator('#modeSolo').click();
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── 5. Heatmap aktivieren – Hotspots sichtbar machen ───────────────
    await page.locator('#toggleHeat').click();
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── 6. Heranzoomen an den Bonner Radfahrer-Hotspot ─────────────────
    //    Gebiet um die Bonner Innenstadt – dort häufen sich
    //    Alleinunfälle Rad (Schienen der Straßenbahn).
    await flyToAndWait(page, 50.739, 7.116, 15);
    await page.waitForTimeout(2000);

    // ── 7. Noch näher ran – Einzelmarker sichtbar ──────────────────────
    await flyToAndWait(page, 50.739, 7.116, 17);
    await page.waitForTimeout(2000);

    // ── 8. Bereich markieren (Rechteck zeichnen) ───────────────────────
    //    Klick auf „Bereich markieren", dann Rechteck aufziehen.
    await page.locator('#btnDraw').click();
    await page.waitForTimeout(500);

    // Rechteck auf der Karte ziehen: Mittelpunkt ± Offset
    const mapBox = await page.locator('#map').boundingBox();
    const cx = mapBox.x + mapBox.width / 2;
    const cy = mapBox.y + mapBox.height / 2;
    await page.mouse.move(cx - 80, cy - 60);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy + 60, { steps: 10 });
    await page.mouse.up();
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── 9. Export / Analyse öffnen ─────────────────────────────────────
    //    Zeigt den Report für den markierten Bereich: Überrepräsentationen,
    //    Schwereverteilung, POI-Analyse (Schulen, Kitas).
    await page.locator('#btnOpenExport').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    // Warten bis Report generiert ist
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 });
    await page.waitForTimeout(4000);

    // ── 9b. Durch den generierten Antrag scrollen ──────────────────────
    //    Das .modal-Element ist der scrollbare Container (overflow: auto).
    //    Langsam durchscrollen, damit der Antrag im Video lesbar ist.
    const modal = page.locator('#modalOverlay .modal');
    // Scroll to top first
    await modal.evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(2000);

    // Langsam nach unten scrollen (in mehreren Schritten)
    const scrollHeight = await modal.evaluate(el => el.scrollHeight);
    const steps = 6;
    for (let i = 1; i <= steps; i++) {
      await modal.evaluate((el, pos) => {
        el.scrollTo({ top: pos, behavior: 'smooth' });
      }, Math.round((scrollHeight / steps) * i));
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(2000);

    // ── 9c. PDF-Export demonstrieren ──────────────────────────────────
    //    CDN-Routen sind bereits eingerichtet (setupCDNRoutes am Anfang).
    await page.locator('#btnExportPDF').click();
    await page.waitForTimeout(3000);

    // ── 10. Export-Modal schließen ──────────────────────────────────────
    await page.locator('#btnCloseModal').click();
    await page.locator('#modalOverlay').waitFor({ state: 'hidden' });
    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // ── 11. Markierung löschen ─────────────────────────────────────────
    await page.locator('#btnClearDraw').click();
    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // ── 12. Zurück zur Übersicht: Zoom raus + alle Filter zurück ───────
    await flyToAndWait(page, 50.733, 7.10, 12);
    await page.waitForTimeout(500);
    await page.locator('#modeOr').click();
    if (!(await incPed.isChecked()))  await incPed.click();
    if (!(await incCar.isChecked()))  await incCar.click();
    await page.locator('#toggleHeat').click();
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── Fertig ─────────────────────────────────────────────────────────
  });
});
