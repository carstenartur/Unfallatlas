/**
 * Screenshot-Tests für die Werkbank V2 Dokumentation
 * Erstellt automatisch Screenshots und speichert sie unter docs/screenshots/
 */

import { test } from '@playwright/test';

/** Hilfsfunktion: Seite mit URL-Parametern laden und auf Datenladen warten */
async function loadPage(page, params = '') {
  await page.goto('/werkbank_v2.html' + params);
  await page.waitForLoadState('networkidle');
}

/** Hilfsfunktion: Warten bis Städte geladen sind */
async function waitForCities(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#citySel');
    return select && select.querySelectorAll('option').length > 1;
  });
}

test.describe('Werkbank V2 – Dokumentations-Screenshots', () => {
  test('01 Startansicht', async ({ page }) => {
    await loadPage(page);
    await page.screenshot({ path: 'docs/screenshots/01-startansicht.png', fullPage: true });
  });

  test('02 Stadtauswahl', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/02-stadtauswahl.png' });
  });

  test('03 Filter', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    // Schwere auf "Getötete" setzen
    await page.locator('#severity').selectOption('1');
    // Fahrrad-Checkbox abwählen, Fuß-Checkbox anwählen
    const bike = page.locator('#incBike');
    if (await bike.isChecked()) await bike.click();
    const foot = page.locator('#incPed');
    if (!(await foot.isChecked())) await foot.click();
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/03-filter.png' });
  });

  test('04 Cluster-Ansicht', async ({ page }) => {
    await loadPage(page);
    await page.locator('#map').screenshot({ path: 'docs/screenshots/04-cluster-ansicht.png' });
  });

  test('05 Heatmap-Ansicht', async ({ page }) => {
    await loadPage(page, '?showHeatmap=1&showCluster=0');
    await waitForCities(page);
    await page.locator('#map').screenshot({ path: 'docs/screenshots/05-heatmap-ansicht.png' });
  });

  test('06 Legende', async ({ page }) => {
    await loadPage(page);
    await page.locator('#legendBtn').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('#legendBox');
      return el && window.getComputedStyle(el).display !== 'none';
    });
    await page.screenshot({ path: 'docs/screenshots/06-legende.png', fullPage: true });
  });

  test('07 Export-Modal', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.screenshot({ path: 'docs/screenshots/07-export-modal.png', fullPage: true });
  });

  test('08 Stundenfilter', async ({ page }) => {
    await loadPage(page);
    await page.locator('#hFrom').fill('6');
    await page.locator('#hTo').fill('18');
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/08-stundenfilter.png' });
  });

  // --- Neue Screenshots ---

  test('09 Bereich markieren', async ({ page }) => {
    // Bonn mit vordefinierten Auswahlgrenzen (Hauptbahnhof-Bereich)
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=1&includeMotorcycle=0' +
      '&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7330&centerLon=7.0950&zoom=15' +
      '&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000');
    await waitForCities(page);
    await page.screenshot({ path: 'docs/screenshots/09-bereich-markieren.png', fullPage: true });
  });

  test('10 Auto und Fahrrad UND-Modus', async ({ page }) => {
    // Bonn: Nur Unfälle mit Auto UND Fahrrad beteiligt
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0' +
      '&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7350&centerLon=7.1000&zoom=14');
    await waitForCities(page);
    await page.screenshot({ path: 'docs/screenshots/10-auto-fahrrad-und.png', fullPage: true });
  });

  test('11 Fahrrad-Alleinunfälle', async ({ page }) => {
    // Bonn: Nur Fahrrad-Alleinunfälle (Solo-Modus)
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=0&includeMotorcycle=0' +
      '&involvementMode=solo&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7350&centerLon=7.1000&zoom=13');
    await waitForCities(page);
    await page.screenshot({ path: 'docs/screenshots/11-fahrrad-alleinunfaelle.png', fullPage: true });
  });

  test('12 POI-Ansicht mit Schulen und Kitas', async ({ page }) => {
    // Bonn: Herangezoomt (Zoom 15+), damit POIs sichtbar werden
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0' +
      '&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7350&centerLon=7.0950&zoom=16');
    await waitForCities(page);
    await page.screenshot({ path: 'docs/screenshots/12-poi-schulen-kitas.png', fullPage: true });
  });

  test('13 Bonn Hauptbahnhof – Radunfälle mit Auswahl', async ({ page }) => {
    // Bonn Hbf: Fahrrad+Auto UND-Modus, Bereich markiert, Heatmap aktiv
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0' +
      '&involvementMode=and&showCluster=0&showHeatmap=1&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7326&centerLon=7.0963&zoom=16' +
      '&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010');
    await waitForCities(page);
    await page.screenshot({ path: 'docs/screenshots/13-bonn-hbf-radunfaelle.png', fullPage: true });
  });

  test('14 Export mit Filterkontext', async ({ page }) => {
    // Bonn mit Auswahl und spezifischen Filtern, dann Export öffnen
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0' +
      '&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18' +
      '&centerLat=50.7330&centerLon=7.0950&zoom=15' +
      '&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000');
    await waitForCities(page);
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.screenshot({ path: 'docs/screenshots/14-export-filterkontext.png', fullPage: true });
  });
});
