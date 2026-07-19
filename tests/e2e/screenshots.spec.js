/**
 * Screenshot-Tests für die Werkbank V2 Dokumentation
 * Erstellt automatisch Screenshots und speichert sie unter docs/screenshots/
 */

import { test, expect } from '@playwright/test';
import {
  captureDataScreenshot,
  setupCDNRoutes,
  waitForFonts,
  waitForScreenshotReady
} from './helpers.js';

/** Hilfsfunktion: Seite mit URL-Parametern laden und auf Datenladen warten */
async function loadPage(page, params = '') {
  await page.goto('/werkbank_v2.html' + params);
  await page.waitForLoadState('networkidle');
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

const MAP_MODE_BASE_QUERY = '?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=1&includeMotorcycle=0' +
  '&involvementMode=or&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
  '&centerLat=50.7330&centerLon=7.0950&zoom=15';

function mapModeQuery(mode, extraParams = '') {
  return `${MAP_MODE_BASE_QUERY}&mapMode=${mode}${extraParams}`;
}

function parseLocalAccidentCount(text) {
  const match = String(text || '').match(/lokal\s+([\d.\s]+)\s+Unfälle/i);
  if (!match) return 0;
  return Number(match[1].replace(/\D/g, '')) || 0;
}

async function setupDeterministicMapModeTiles(page, options = {}) {
  const { orthophotoAvailable = true } = options;
  const standardTile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" fill="#eef2f6"/>
    <path d="M0 84 H256 M0 172 H256 M84 0 V256 M172 0 V256" stroke="#c7d2db" stroke-width="4"/>
    <path d="M-20 40 L280 220 M-30 210 L270 70" stroke="#9aa8b5" stroke-width="6"/>
  </svg>`;
  const orthophotoTile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#6f8f54"/>
        <stop offset="100%" stop-color="#9d8b6f"/>
      </linearGradient>
    </defs>
    <rect width="256" height="256" fill="url(#g)"/>
    <circle cx="60" cy="70" r="26" fill="#4f6f3f" opacity="0.45"/>
    <circle cx="180" cy="120" r="34" fill="#45663a" opacity="0.35"/>
    <rect x="24" y="186" width="208" height="20" fill="#b9a38b" opacity="0.45"/>
  </svg>`;
  const labelTile = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
    <rect width="256" height="256" fill="transparent"/>
    <path d="M12 118 H244 M44 60 L212 196" stroke="#1f2937" stroke-width="2.5" stroke-linecap="round" opacity="0.65"/>
    <text x="20" y="108" font-size="18" font-family="Arial, sans-serif" fill="#111827" opacity="0.85">Bonn Hbf</text>
    <text x="128" y="188" font-size="14" font-family="Arial, sans-serif" fill="#111827" opacity="0.8">Hybrid Labels</text>
  </svg>`;

  await page.route('https://*.tile.openstreetmap.org/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: standardTile });
  });
  await page.route('https://*.basemaps.cartocdn.com/light_only_labels/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: labelTile });
  });

  const orthophotoPatterns = [
    'https://www.bonn.de/stadtplan-wms/services/orthofoto/MapServer/WMSServer**',
    'https://www.wms.nrw.de/geobasis/wms_nw_dop**',
    'https://opendata.lgln.niedersachsen.de/doorman/noauth/dop_wms**',
    'https://sg.geodatenzentrum.de/wms_dop20**',
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/**'
  ];
  for (const pattern of orthophotoPatterns) {
    await page.route(pattern, async (route) => {
      if (!orthophotoAvailable) {
        await route.fulfill({ status: 503, contentType: 'text/plain; charset=utf-8', body: 'Orthophoto unavailable' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: orthophotoTile });
    });
  }
}

test.describe('Werkbank V2 – Dokumentations-Screenshots', () => {
  // Einheitliche Viewport-Größe für alle Screenshots: 1280×800
  test.use({ viewport: { width: 1280, height: 800 } });

  test('01 Startansicht', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/01-startansicht.png',
      fullPage: true,
      city: 'Hannover',
      layers: ['cluster', 'heatmap']
    });
  });

  test('02 Stadtauswahl', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    await waitForScreenshotReady(page, {
      city: 'Hannover',
      layers: ['cluster', 'heatmap']
    });
    await waitForFonts(page);
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/02-stadtauswahl.png' });
  });

  test('03 Filter', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    const initialRender = await waitForScreenshotReady(page, {
      city: 'Hannover',
      layers: ['cluster', 'heatmap']
    });
    // Schwere auf "Getötete" setzen
    await page.locator('#severity').selectOption('1');
    // Alle 6 Beteiligungsfilter sichtbar: Rad, Fuß, PKW, Krad, Lkw, Sonstig
    // Lkw und Sonstig anwählen, damit alle 6 Checkboxen im angehakten Zustand gezeigt werden
    const gkfz = page.locator('#incGkfz');
    if (!(await gkfz.isChecked())) await gkfz.click();
    const son = page.locator('#incSon');
    if (!(await son.isChecked())) await son.click();
    await waitForScreenshotReady(page, {
      city: 'Hannover',
      layers: ['cluster', 'heatmap'],
      afterRevision: initialRender.render.revision
    });
    await waitForFonts(page);
    const panel = page.locator('#panel');
    await panel.screenshot({ path: 'docs/screenshots/03-filter.png' });
  });

  test('04 Cluster-Ansicht', async ({ page }) => {
    await loadPage(page,
      '?city=Hannover&showCluster=1&showHeatmap=0' +
      '&showSchools=0&showKindergartens=0&showArgumentation=0');
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/04-cluster-ansicht.png',
      selector: '#map',
      city: 'Hannover',
      layers: ['cluster']
    });
  });

  test('05 Heatmap-Ansicht', async ({ page }) => {
    test.setTimeout(60000);
    // Bonn als Stadt angeben damit Daten geladen werden und die Heatmap sichtbar ist
    await loadPage(page, '?city=Bonn&showHeatmap=1&showCluster=0');
    await waitForCities(page);
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/05-heatmap-ansicht.png',
      selector: '#map',
      city: 'Bonn',
      layers: ['heatmap']
    });
  });

  test('06 Legende', async ({ page }) => {
    await loadPage(page);
    await page.locator('#legendBtn').click();
    const legend = page.locator('#legendBox');
    await expect(legend).toBeVisible();
    await expect(legend).toContainText('Legende / Hinweise');
    await expect(legend.locator('li')).toHaveCount(4);
    await legend.scrollIntoViewIfNeeded();
    await expect(legend).toBeInViewport();
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/06-legende.png',
      fullPage: true,
      city: 'Hannover',
      layers: ['cluster', 'heatmap']
    });
  });

  test('07 Export-Modal', async ({ page }) => {
    await loadPage(page);
    await waitForCities(page);
    await waitForScreenshotReady(page, {
      city: 'Hannover',
      layers: ['cluster', 'heatmap']
    });
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 });
    await page.waitForTimeout(1000);
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/07-export-modal.png',
      fullPage: true,
      city: 'Hannover',
      layers: ['cluster', 'heatmap']
    });
  });

  test('08 Stundenfilter', async ({ page }) => {
    await loadPage(page);
    const initialRender = await waitForScreenshotReady(page, {
      city: 'Hannover',
      layers: ['cluster', 'heatmap']
    });
    await page.locator('#hFrom').fill('6');
    await page.locator('#hTo').fill('18');
    await waitForScreenshotReady(page, {
      city: 'Hannover',
      layers: ['cluster', 'heatmap'],
      afterRevision: initialRender.render.revision
    });
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
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/09-bereich-markieren.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
  });

  test('10 Auto und Fahrrad UND-Modus', async ({ page }) => {
    // Bonn: Nur Unfälle mit Auto UND Fahrrad beteiligt
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0' +
      '&involvementMode=and&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7350&centerLon=7.1000&zoom=14');
    await waitForCities(page);
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/10-auto-fahrrad-und.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
  });

  test('11 Fahrrad-Alleinunfälle', async ({ page }) => {
    // Bonn: Nur Fahrrad-Alleinunfälle (Solo-Modus)
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=0&includeMotorcycle=0' +
      '&involvementMode=solo&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7350&centerLon=7.1000&zoom=13');
    await waitForCities(page);
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/11-fahrrad-alleinunfaelle.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
  });

  test('12 POI-Ansicht mit Schulen und Kitas', async ({ page }) => {
    // Bonn: Herangezoomt (Zoom 15+), damit POIs sichtbar werden
    await loadPage(page,
      '?city=Bonn&includeCyclist=1&includePedestrian=1&includeCar=0&includeMotorcycle=0' +
      '&involvementMode=or&showCluster=1&showHeatmap=0&showOnlyAboveAverage=0' +
      '&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23' +
      '&centerLat=50.7350&centerLon=7.0950&zoom=16');
    await waitForCities(page);
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/12-poi-schulen-kitas.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster', 'poi']
    });
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
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/13-bonn-hbf-radunfaelle.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['heatmap']
    });
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
    await waitForScreenshotReady(page, { city: 'Bonn', layers: ['cluster'] });
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 });
    await page.waitForTimeout(1000);
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/14-export-filterkontext.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
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
    await waitForScreenshotReady(page, { city: 'Bonn', layers: ['cluster'] });
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 });
    const exportHtml = page.locator('#exportHtml');
    const summary = exportHtml.locator('div').filter({ hasText: 'Auswertung:' }).first();
    await expect(summary).toBeVisible();
    const localAccidents = parseLocalAccidentCount(await summary.textContent());
    expect(localAccidents).toBeGreaterThan(0);

    // Auf einen semantisch stabilen Statistikabschnitt scrollen statt auf eine
    // fragile Prozentposition im Modal.
    const statisticsHeading = exportHtml.getByText('Verletzungsschwere im Ausschnitt', { exact: true });
    await expect(statisticsHeading).toBeVisible();
    await statisticsHeading.scrollIntoViewIfNeeded();
    await expect(statisticsHeading).toBeInViewport();
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/16-antrag-inhalt.png',
      fullPage: false,
      city: 'Bonn',
      layers: ['cluster']
    });
  });
  // 17–20 (Slope-Diagnose) bleiben bewusst ausgesetzt, bis ein versioniertes
  // Context-Dataset bzw. Fixture echte Overlay-Geometrie bereitstellt. Die
  // früheren Szenarien warteten nur auf Cluster/Heatmap und lieferten dadurch
  // Empty-State-Karten als vermeintlichen Slope-Beleg (QA #400/#404).

  test('21 Kartenmodus Standard (stabil)', async ({ page }) => {
    await setupDeterministicMapModeTiles(page);
    await loadPage(page, mapModeQuery('standard', '&showCluster=1&showHeatmap=0'));
    await waitForCities(page);
    await expect(page.locator('#mapLayerStatus')).toContainText('Kartenmodus: Standardkarte.');
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/21-mapmode-standard.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
  });

  test('22 Kartenmodus Orthofoto (stabil)', async ({ page }) => {
    await setupDeterministicMapModeTiles(page);
    await loadPage(page, mapModeQuery('orthophoto', '&showCluster=1&showHeatmap=0'));
    await waitForCities(page);
    await expect(page.locator('#mapLayerStatus')).toContainText('Kartenmodus: Orthofoto.');
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/22-mapmode-orthophoto.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
  });

  test('23 Kartenmodus Hybrid (stabil)', async ({ page }) => {
    await setupDeterministicMapModeTiles(page);
    await loadPage(page, mapModeQuery('hybrid', '&showCluster=1&showHeatmap=0'));
    await waitForCities(page);
    await expect(page.locator('#mapLayerStatus')).toContainText('Kartenmodus: Hybrid.');
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/23-mapmode-hybrid.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
  });

  test('24 Kartenmodus Analyse (stabil)', async ({ page }) => {
    await setupDeterministicMapModeTiles(page);
    await loadPage(page, mapModeQuery('analysis', '&showCluster=0&showHeatmap=1&orthophotoOpacity=65'));
    await waitForCities(page);
    await expect(page.locator('#mapLayerStatus')).toContainText('Kartenmodus: Analyseansicht.');
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/24-mapmode-analysis.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['heatmap']
    });
  });

  test('25 Kartenmodus Orthofoto – Fallback bei Tile-Fehler', async ({ page }) => {
    await setupDeterministicMapModeTiles(page, { orthophotoAvailable: false });
    await loadPage(page, mapModeQuery('orthophoto', '&showCluster=1&showHeatmap=0'));
    await waitForCities(page);
    const status = page.locator('#mapLayerStatus');
    await expect(status).toContainText('Kartenmodus: Standardkarte.');
    await expect(status).toContainText('Fallback');
    await captureDataScreenshot(page, {
      path: 'docs/screenshots/25-mapmode-orthophoto-fallback.png',
      fullPage: true,
      city: 'Bonn',
      layers: ['cluster']
    });
  });
});

test.describe('Werkbank V2 – PDF-Export Rendering', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('15 PDF-Export – Unfallinhalt geprüft und Belegseite gerendert', async ({ page }) => {
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
    // Semantische Daten- und Layer-Readiness, damit der PDF-Export nicht nur
    // einen bereits aktualisierten Statustext, sondern vollständig gerenderte
    // und vollständige Stadtdaten verwendet.
    await waitForScreenshotReady(page, { city: 'Bonn', layers: ['cluster'] });

    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay .modal').waitFor({ state: 'visible' });

    // Warten bis computeExportReport() (inkl. Nominatim-Call) abgeschlossen ist
    await page.locator('#exportProgress').waitFor({ state: 'visible' });
    await expect(page.locator('#exportProgress')).toContainText('Fertig', { timeout: 30000 });

    const exportSummary = page.locator('#exportHtml div').filter({ hasText: 'Auswertung:' }).first();
    const expectedLocalAccidents = parseLocalAccidentCount(await exportSummary.textContent());
    expect(expectedLocalAccidents).toBeGreaterThan(0);

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

      const loadingTask = getDocument({ url: 'https://pdfjs-test-cdn/document.pdf' });
      const pdfDoc = await loadingTask.promise;
      const expectedLocalAccidents = ${expectedLocalAccidents};
      const pageTexts = [];
      let renderedPageNumber = 1;
      for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
        const candidate = await pdfDoc.getPage(pageNumber);
        const textContent = await candidate.getTextContent();
        const text = textContent.items.map((item) => item.str || '').join(' ').replace(/\\s+/g, ' ').trim();
        pageTexts.push(text);
        if (renderedPageNumber === 1) {
          const countPattern = new RegExp('(?:^|\\\\D)' + expectedLocalAccidents + '\\\\s+Unfälle', 'i');
          if (countPattern.test(text)) renderedPageNumber = pageNumber;
        }
      }
      const pdfPage = await pdfDoc.getPage(renderedPageNumber);
      const viewport = pdfPage.getViewport({ scale: 1.5 });

      const canvas = document.getElementById('pdf-canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const ctx = canvas.getContext('2d');
      await pdfPage.render({ canvasContext: ctx, viewport }).promise;

      window.__pdfText = pageTexts.join('\\n');
      window.__pdfPageCount = pdfDoc.numPages;
      window.__pdfRenderedPage = renderedPageNumber;
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

    const pdfDiagnostics = await page.evaluate(() => ({
      text: window.__pdfText || '',
      pageCount: window.__pdfPageCount || 0,
      renderedPage: window.__pdfRenderedPage || 0
    }));
    expect(pdfDiagnostics.pageCount).toBeGreaterThan(0);
    expect(pdfDiagnostics.renderedPage).toBeGreaterThan(0);
    expect(pdfDiagnostics.text).toContain('Unfälle');
    expect(pdfDiagnostics.text).toMatch(
      new RegExp(`(?:^|\\D)${expectedLocalAccidents}\\s+Unfälle`, 'i')
    );

    // Screenshot der ersten PDF-Seite, auf der die zuvor aus dem Exportmodell
    // verifizierte lokale Unfallzahl tatsächlich genannt wird.
    await page.locator('#pdf-canvas').screenshot({ path: 'docs/screenshots/15-export-pdf-rendered.png' });
  });
});
