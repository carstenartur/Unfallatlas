/**
 * Screenshot-Tests für die Werkbank V2 Dokumentation
 * Erstellt automatisch Screenshots und speichert sie unter docs/screenshots/
 */

import { test, expect } from '@playwright/test';
import { setupCDNRoutes } from './helpers.js';

/** Hilfsfunktion: Seite mit URL-Parametern laden und auf Datenladen warten */
async function loadPage(page, params = '') {
  await page.goto('/werkbank_v2.html' + params);
  await page.waitForLoadState('networkidle');
}

/** Hilfsfunktion: Warten bis Leaflet-Tiles sichtbar fertig geladen sind */
async function waitForMapTiles(page, timeout = 15000) {
  try {
    await page.waitForFunction(() => {
      const map = document.querySelector('.leaflet-container');
      if (!map) return false;
      const loadingTiles = map.querySelectorAll('img.leaflet-tile-loading').length;
      const loadedTiles = map.querySelectorAll('img.leaflet-tile-loaded').length;
      return loadingTiles === 0 && loadedTiles > 0;
    }, { timeout });
  } catch (err) {
    throw new Error(
      `Leaflet tiles did not reach a stable loaded state within ${timeout}ms: ${err && err.message ? err.message : err}`
    );
  }
  // kurzes Zusatzfenster für finales Paint nach dem letzten Tile-Decode
  await page.waitForTimeout(250);
}

/** Hilfsfunktion: Defensiv auf Font-Readiness warten (kein Fehler ohne Font-API) */
async function waitForFonts(page) {
  await page.evaluate(() => (document.fonts && document.fonts.ready) || null);
}

/** Hilfsfunktion: Warten bis Städte geladen sind (prüft auch ob Lade-Placeholder verschwunden) */
async function waitForCities(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#citySel');
    if (!select) return false;
    const opts = select.querySelectorAll('option');
    return opts.length > 1 && ![...opts].some(o => o.textContent.includes('Lade'));
  }, { timeout: 30000 });
}

/** Hilfsfunktion: Warten bis Unfalldaten geladen sind (stat-Element zeigt geladene Unfälle > 0) */
async function waitForData(page) {
  await page.waitForFunction(() => {
    const stat = document.querySelector('#stat');
    return stat && stat.textContent.includes('geladen:') && !stat.textContent.includes('geladen: 0');
  }, { timeout: 30000 });
}

test.describe('Werkbank V2 – Dokumentations-Screenshots', () => {
  // Einheitliche Viewport-Größe für alle Screenshots: 1280×800
  test.use({ viewport: { width: 1280, height: 800 } });

  test('01 Startansicht', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.screenshot({ path: 'docs/screenshots/01-startansicht.png', fullPage: true });
  });

  test('02 Stadtauswahl', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    await waitForFonts(page);
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/02-stadtauswahl.png' });
  });

  test('03 Filter', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    // Schwere auf "Getötete" setzen
    await page.locator('#severity').selectOption('1');
    // Alle 6 Beteiligungsfilter sichtbar: Rad, Fuß, PKW, Krad, Lkw, Sonstig
    // Lkw und Sonstig anwählen, damit alle 6 Checkboxen im angehakten Zustand gezeigt werden
    const gkfz = page.locator('#incGkfz');
    if (!(await gkfz.isChecked())) await gkfz.click();
    const son = page.locator('#incSon');
    if (!(await son.isChecked())) await son.click();
    await waitForFonts(page);
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/03-filter.png' });
  });

  test('04 Cluster-Ansicht', async ({ page }) => {
    await loadPage(page);
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.locator('#map').screenshot({ path: 'docs/screenshots/04-cluster-ansicht.png' });
  });

  test('05 Heatmap-Ansicht', async ({ page }) => {
    test.setTimeout(60000);
    // Bonn als Stadt angeben damit Daten geladen werden und die Heatmap sichtbar ist
    await loadPage(page, '?city=Bonn&showHeatmap=1&showCluster=0');
    await waitForCities(page);
    await waitForData(page);
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.locator('#map').screenshot({ path: 'docs/screenshots/05-heatmap-ansicht.png' });
  });

  test('06 Legende', async ({ page }) => {
    await loadPage(page);
    await waitForMapTiles(page);
    await page.locator('#legendBtn').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('#legendBox');
      return el && window.getComputedStyle(el).display !== 'none';
    });
    await waitForFonts(page);
    await page.screenshot({ path: 'docs/screenshots/06-legende.png', fullPage: true });
  });

  test('07 Export-Modal', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    await waitForData(page);
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 });
    await page.waitForTimeout(1000);
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.screenshot({ path: 'docs/screenshots/07-export-modal.png', fullPage: true });
  });

  test('08 Stundenfilter', async ({ page }) => {
    await loadPage(page);
    await page.locator('#hFrom').fill('6');
    await page.locator('#hTo').fill('18');
    await waitForFonts(page);
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
    await waitForMapTiles(page);
    await waitForFonts(page);
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
    await waitForMapTiles(page);
    await waitForFonts(page);
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
    await waitForMapTiles(page);
    await waitForFonts(page);
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
    await waitForMapTiles(page);
    await waitForFonts(page);
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
    await waitForMapTiles(page);
    await waitForFonts(page);
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
    await waitForData(page);
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 });
    await page.waitForTimeout(1000);
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.screenshot({ path: 'docs/screenshots/14-export-filterkontext.png', fullPage: true });
  });

  test('16 Antrag-Inhalt (durchgescrollt)', async ({ page }) => {
    test.setTimeout(60000);
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0' +
      '&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=6&hourTo=18' +
      '&centerLat=50.7330&centerLon=7.0950&zoom=15' +
      '&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000');
    await waitForCities(page);
    await waitForData(page);
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 });
    // Modal zum Antragsteil scrollen damit der Inhalt sichtbar ist
    // 30% des Scrollbereichs zeigt den Beginn des Antragsinhalts (Sachverhalt/Statistik)
    const modal = page.locator('#modalOverlay .modal');
    const scrollHeight = await modal.evaluate(el => el.scrollHeight);
    await modal.evaluate((el, pos) => el.scrollTo({ top: pos, behavior: 'instant' }),
      Math.round(scrollHeight * 0.3));
    await page.waitForTimeout(500);
    await waitForMapTiles(page);
    await waitForFonts(page);
    await page.screenshot({ path: 'docs/screenshots/16-antrag-inhalt.png', fullPage: false });
  });
});

test.describe('Werkbank V2 – PDF-Export Rendering', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('15 PDF-Export gerendert', async ({ page }) => {
    // 90 s: Stadtdaten laden (≤10 s) + pdfmake-Export (≤30 s) + pdfjs-Rendering (≤30 s)
    test.setTimeout(90000);

    // CDN-Routen für Export-Bibliotheken und pdfjs-dist einrichten
    await setupCDNRoutes(page);

    const path = await import('path');
    const fs = await import('fs');
    const root = path.resolve(process.cwd());
    const pdfjsFile = path.join(root, 'node_modules/pdfjs-dist/build/pdf.min.mjs');
    const workerFile = path.join(root, 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs');

    if (!fs.existsSync(pdfjsFile) || !fs.existsSync(workerFile)) {
      throw new Error('pdfjs-dist not found in node_modules – run npm install');
    }

    // Werkbank laden, Export-Modal öffnen
    await page.goto('/werkbank_v2.html?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0' +
      '&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7330&centerLon=7.0950&zoom=15' +
      '&selSouth=50.7300&selWest=7.0900&selNorth=50.7360&selEast=7.1000');
    await page.waitForLoadState('networkidle');
    await waitForCities(page);
    // Warten bis Unfalldaten geladen sind, damit der PDF-Export inhaltlich befüllt ist
    await waitForData(page);

    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay .modal').waitFor({ state: 'visible' });

    // Warten bis computeExportReport() (inkl. Nominatim-Call) abgeschlossen ist
    await page.locator('#exportProgress').waitFor({ state: 'visible' });
    await expect(page.locator('#exportProgress')).toContainText('Fertig', { timeout: 30000 });

    // Kartenausschnitt deaktivieren (vermeidet leaflet-image-Abhängigkeit)
    await page.locator('#cbIncludeMap').uncheck();

    // PDF herunterladen (event-driven: Download-Event und Klick gleichzeitig)
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('#btnExportPDF').click()
    ]);

    const filePath = await download.path();
    if (!filePath) {
      throw new Error('Download path is null – cannot read PDF file. Try running with a local browser context.');
    }
    // pdfjs-dist über lokale node_modules bereitstellen (kein Netzwerkzugriff nötig)
    await page.route('https://pdfjs-test-cdn/pdf.min.mjs', async (r) => {
      await r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(pdfjsFile) });
    });
    await page.route('https://pdfjs-test-cdn/pdf.worker.min.mjs', async (r) => {
      await r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(workerFile) });
    });
    // PDF-Datei selbst über Route bereitstellen
    await page.route('https://pdfjs-test-cdn/document.pdf', async (r) => {
      await r.fulfill({ status: 200, contentType: 'application/pdf', body: fs.readFileSync(filePath) });
    });

    // HTML-Seite mit pdfjs-Rendering im Browser aufbauen
    await page.setContent(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>PDF Preview</title>
  <style>body { margin: 0; background: #fff; }</style>
</head>
<body>
  <canvas id="pdf-canvas"></canvas>
  <script type="module">
    // Globale Fehlerhandler fangen auch Fehler beim Modul-Laden (vor try/catch)
    window.addEventListener('error', (e) => {
      if (!window.__pdfRendered) window.__pdfError = window.__pdfError || String(e.message || e);
    });
    window.addEventListener('unhandledrejection', (e) => {
      if (!window.__pdfRendered) window.__pdfError = window.__pdfError || String(e.reason || e);
    });
    try {
      // Dynamischer Import, damit Fehler beim Laden innerhalb des try/catch landen
      const { getDocument, GlobalWorkerOptions } = await import('https://pdfjs-test-cdn/pdf.min.mjs');
      GlobalWorkerOptions.workerSrc = 'https://pdfjs-test-cdn/pdf.worker.min.mjs';

      const loadingTask = getDocument('https://pdfjs-test-cdn/document.pdf');
      const pdfDoc = await loadingTask.promise;
      const pdfPage = await pdfDoc.getPage(1);
      const viewport = pdfPage.getViewport({ scale: 1.5 });

      const canvas = document.getElementById('pdf-canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

      window.__pdfRendered = true;
    } catch (err) {
      window.__pdfError = String(err);
    }
  </script>
</body>
</html>`);

    // Warten bis PDF gerendert ist – event-driven über window.__pdfRendered
    await page.waitForFunction(
      () => window.__pdfRendered === true || typeof window.__pdfError === 'string',
      { timeout: 30000 }
    );

    // Sicherstellen, dass kein Fehler aufgetreten ist
    const pdfError = await page.evaluate(() => window.__pdfError);
    if (pdfError) {
      throw new Error('PDF rendering failed: ' + pdfError);
    }

    // Screenshot des gerenderten PDF-Canvas
    await page.locator('#pdf-canvas').screenshot({ path: 'docs/screenshots/15-export-pdf-rendered.png' });
  });
});
