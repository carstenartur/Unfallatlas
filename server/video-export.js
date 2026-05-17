/**
 * Playwright-basierter Video-Export für die Unfallwerkbank.
 *
 * Nimmt URL-Parameter der Werkbank entgegen, spielt den kompletten
 * Analyse-Ablauf in einem Headless-Chromium durch (mit sichtbaren
 * Interaktionen), zeichnet ein Video auf und konvertiert es per
 * ffmpeg zu einem GIF.
 *
 * Ablauf:
 *  1. Standardansicht laden (Hannover, Zoom 12)
 *  2. Stadt aus Parametern auswählen
 *  3. Filter nacheinander setzen (Schwere, Beteiligung, Modus, Uhrzeit, etc.)
 *  4. Darstellungsoptionen togglen (Heatmap / Cluster / Hotspot)
 *  5. Zur gewünschten Kartenposition fliegen
 *  6. Bereich markieren (wenn selSouth/West/North/East vorhanden)
 *  7. Export öffnen → durch Antrag scrollen → PDF-Export-Button klicken
 *  8. Modal schließen
 *
 * @module server/video-export
 */

'use strict';

const { chromium } = require('@playwright/test');
const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { VIDEO_EXPORT_FORMATS } = require('./video-export-formats.js');

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 120_000; // 2 minutes max for each ffmpeg step
const WEBP_QUALITY = 60;
const WEBM_TO_ANIMATED_IMAGE_FILTER = 'setpts=0.15*PTS,fps=8,scale=800:-1:flags=lanczos';

const SERVER_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8000}`;
const CDN_ROUTES = [
  {
    url: 'https://unpkg.com/docx@9.6.1/dist/index.iife.js',
    file: path.resolve(__dirname, '../node_modules/docx/dist/index.iife.js')
  },
  {
    url: 'https://unpkg.com/pdfmake@0.3.7/build/pdfmake.min.js',
    file: path.resolve(__dirname, '../node_modules/pdfmake/build/pdfmake.min.js')
  },
  {
    url: 'https://unpkg.com/pdfmake@0.3.7/build/vfs_fonts.js',
    file: path.resolve(__dirname, '../node_modules/pdfmake/build/vfs_fonts.js')
  },
  {
    url: 'https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js',
    file: path.resolve(__dirname, '../node_modules/file-saver/dist/FileSaver.min.js')
  }
];

/** Wartet bis Städte im Dropdown geladen sind */
async function waitForCities(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#citySel');
    if (!select) return false;
    const opts = select.querySelectorAll('option');
    return opts.length > 1 && ![...opts].some(o => o.textContent.includes('Lade'));
  }, { timeout: 60000 });
}

/** Wartet bis Unfalldaten geladen wurden */
async function waitForData(page) {
  await page.waitForFunction(() => {
    const stat = document.querySelector('#stat');
    return stat && stat.textContent.includes('geladen:');
  }, { timeout: 30000 });
}

/** Wartet bis Kartenkacheln geladen sind */
async function waitForTiles(page) {
  const usedUaHelper = await page.evaluate(async () => {
    if (!window.UA || typeof window.UA.waitForMapFullyRendered !== 'function') return false;
    const map = window._uaMap || (window.UA.ctx && window.UA.ctx.map);
    if (!map) return false;
    const timeoutMs = Number(window.UA.MAP_CAPTURE_TIMEOUT_MS) || 30000;
    const ok = await window.UA.waitForMapFullyRendered(map, {
      ctx: window.UA.ctx || null,
      timeoutMs
    });
    return ok === true;
  }).catch(() => false);
  if (usedUaHelper) return;
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('.leaflet-tile-pane img');
    return imgs.length >= 4
      && [...imgs].every(i => i.complete && i.naturalWidth > 0);
  }, { timeout: 30000 }).catch(() => { /* Tiles optional, weitermachen */ });
}

/** Bewegt die Karte per flyTo und wartet auf Tiles + Animation */
async function flyToAndWait(page, lat, lng, zoom) {
  await page.evaluate(({ lat, lng, zoom }) => {
    return new Promise(resolve => {
      const map = window._uaMap;
      if (!map) { resolve(); return; }
      map.once('moveend', () => setTimeout(resolve, 200));
      map.flyTo([lat, lng], zoom, { duration: 1.2 });
    });
  }, { lat, lng, zoom });
  await waitForTiles(page);
}

/**
 * Erzeugt ein Export-Video des Analyse-Ablaufs basierend auf den übergebenen
 * URL-Parametern.
 *
 * @param {Object} params  URL-Parameter der Werkbank
 * @param {{ format?: 'gif'|'webp'|'apng' }} [opts]
 * @returns {Promise<{ path: string, format: 'gif'|'webp'|'apng', contentType: string, extension: string }>}
  */
async function exportVideo(params, opts = {}) {
  const format = String(opts.format || 'gif').toLowerCase();
  const formatMeta = VIDEO_EXPORT_FORMATS[format];
  if (!formatMeta) {
    throw new Error(`unsupported_format:${format}`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-video-export-'));
  const videoDir = path.join(tmpDir, 'video');
  fs.mkdirSync(videoDir, { recursive: true });

  let browser = null;
  let webmPath = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    // CDN-Routen auf lokale node_modules umleiten (offline-fähig)
    for (const route of CDN_ROUTES) {
      if (fs.existsSync(route.file)) {
        await page.route(route.url, async r => {
          await r.fulfill({
            status: 200,
            contentType: 'application/javascript',
            body: fs.readFileSync(route.file)
          });
        });
      }
    }

    // ── 1. Standardansicht laden ────────────────────────────────────────────
    await page.goto(`${SERVER_URL}/werkbank_v2.html`);
    await page.waitForLoadState('domcontentloaded');
    await waitForCities(page);
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── 2. Stadt auswählen ──────────────────────────────────────────────────
    const targetCity = params.city || 'Hannover';
    // Prüfen ob die gewünschte Stadt verfügbar ist
    const cityAvailable = await page.locator('#citySel').evaluate((sel, city) => {
      return [...sel.options].some(o => o.value === city || o.textContent.trim() === city);
    }, targetCity);

    if (cityAvailable) {
      await page.locator('#citySel').selectOption(targetCity);
    } else {
      // Fallback: erste verfügbare Stadt
      await page.locator('#citySel').selectOption({ index: 1 });
    }
    await waitForData(page);
    await waitForTiles(page);
    await page.waitForTimeout(2500);

    // ── 3. Unfallschwere setzen ─────────────────────────────────────────────
    if (params.severity && params.severity !== 'all') {
      await page.locator('#severity').selectOption(params.severity);
      await waitForTiles(page);
      await page.waitForTimeout(800);
    }

    // ── 4. Beteiligungsfilter setzen ────────────────────────────────────────
    //    Defaults match werkbank_v2.html UI:
    //    Rad/Fuß/PKW are checked by default, Krad/Gkfz/Sonstig are unchecked.
    const bikeWanted   = params.includeCyclist    !== '0';
    const pedWanted    = params.includePedestrian !== '0';
    const carWanted    = params.includeCar        !== '0';
    const motoWanted   = params.includeMotorcycle === '1';
    const gkfzWanted   = params.includeGkfz       === '1';
    const sonWanted    = params.includeSonstig    === '1';

    const incBike = page.locator('#incBike');
    const incPed  = page.locator('#incPed');
    const incCar  = page.locator('#incCar');
    const incMoto = page.locator('#incMoto');
    const incGkfz = page.locator('#incGkfz');
    const incSon  = page.locator('#incSon');

    const bikeChecked = await incBike.isChecked().catch(() => true);
    const pedChecked  = await incPed.isChecked().catch(() => true);
    const carChecked  = await incCar.isChecked().catch(() => true);
    const motoChecked = await incMoto.isChecked().catch(() => true);
    const gkfzChecked = await incGkfz.isChecked().catch(() => true);
    const sonChecked  = await incSon.isChecked().catch(() => true);

    if (bikeChecked !== bikeWanted) { await incBike.click(); await page.waitForTimeout(400); }
    if (pedChecked  !== pedWanted)  { await incPed.click();  await page.waitForTimeout(400); }
    if (carChecked  !== carWanted)  { await incCar.click();  await page.waitForTimeout(400); }
    if (motoChecked !== motoWanted) { await incMoto.click(); await page.waitForTimeout(400); }
    if (gkfzChecked !== gkfzWanted) { await incGkfz.click(); await page.waitForTimeout(400); }
    if (sonChecked  !== sonWanted)  { await incSon.click();  await page.waitForTimeout(400); }

    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // ── 5. Involvierungs-Modus setzen ───────────────────────────────────────
    const mode = params.involvementMode;
    if (mode === 'and') {
      await page.locator('#modeAnd').click().catch(() => {});
      await page.waitForTimeout(600);
    } else if (mode === 'solo') {
      await page.locator('#modeSolo').click().catch(() => {});
      await page.waitForTimeout(600);
    }
    // 'or' ist Standard, kein Klick nötig

    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // ── 6. Tageszeit-Filter setzen ──────────────────────────────────────────
    const hourFrom = parseInt(params.hourFrom, 10);
    const hourTo   = parseInt(params.hourTo,   10);
    if (!isNaN(hourFrom) && hourFrom !== 0) {
      await page.locator('#hourFrom').fill(String(hourFrom)).catch(() => {});
      await page.locator('#hourFrom').dispatchEvent('input').catch(() => {});
      await page.waitForTimeout(400);
    }
    if (!isNaN(hourTo) && hourTo !== 23) {
      await page.locator('#hourTo').fill(String(hourTo)).catch(() => {});
      await page.locator('#hourTo').dispatchEvent('input').catch(() => {});
      await page.waitForTimeout(400);
    }

    // ── 7. Wochentag-Filter setzen ──────────────────────────────────────────
    if (params.dayType && params.dayType !== 'all') {
      await page.locator('#dayType').selectOption(params.dayType).catch(() => {});
      await page.waitForTimeout(600);
    }

    // ── 8. Fahrbahnzustand setzen ───────────────────────────────────────────
    if (params.roadCondition && params.roadCondition !== 'all') {
      await page.locator('#roadCondition').selectOption(params.roadCondition).catch(() => {});
      await page.waitForTimeout(600);
    }

    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // ── 9. Darstellungsoptionen togglen ────────────────────────────────────
    const wantHeatmap  = params.showHeatmap          === '1';
    const wantCluster  = params.showCluster          !== '0'; // Standard: an
    const wantHotspot  = params.showOnlyAboveAverage === '1';

    // Cluster-Zustand auslesen und ggf. togglen
    const clusterActive = await page.locator('#toggleCluster').evaluate(
      btn => btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true'
    ).catch(() => true);
    if (clusterActive !== wantCluster) {
      await page.locator('#toggleCluster').click().catch(() => {});
      await waitForTiles(page);
      await page.waitForTimeout(600);
    }

    // Heatmap togglen wenn gewünscht
    const heatActive = await page.locator('#toggleHeat').evaluate(
      btn => btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true'
    ).catch(() => false);
    if (heatActive !== wantHeatmap) {
      await page.locator('#toggleHeat').click().catch(() => {});
      await waitForTiles(page);
      await page.waitForTimeout(600);
    }

    // Hotspot togglen wenn gewünscht
    const hotActive = await page.locator('#toggleHot').evaluate(
      btn => btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true'
    ).catch(() => false);
    if (hotActive !== wantHotspot) {
      await page.locator('#toggleHot').click().catch(() => {});
      await waitForTiles(page);
      await page.waitForTimeout(600);
    }

    await page.waitForTimeout(1500);

    // ── 10. Zur Kartenposition fliegen ─────────────────────────────────────
    const lat  = parseFloat(params.centerLat);
    const lon  = parseFloat(params.centerLon);
    const zoom = parseFloat(params.zoom);
    if (!isNaN(lat) && !isNaN(lon) && !isNaN(zoom)) {
      await flyToAndWait(page, lat, lon, zoom);
    }
    await page.waitForTimeout(2000);

    // ── 11. Bereich markieren (Rechteck zeichnen) ──────────────────────────
    const hasSel = params.selSouth && params.selWest && params.selNorth && params.selEast;
    if (hasSel) {
      await page.locator('#btnDraw').click().catch(() => {});
      await page.waitForTimeout(500);

      const mapBox = await page.locator('#map').boundingBox();
      if (mapBox) {
        const cx = mapBox.x + mapBox.width / 2;
        const cy = mapBox.y + mapBox.height / 2;
        await page.mouse.move(cx - 90, cy - 70);
        await page.mouse.down();
        await page.mouse.move(cx + 90, cy + 70, { steps: 12 });
        await page.mouse.up();
        await waitForTiles(page);
        await page.waitForTimeout(2000);
      }
    }

    // ── 12. Export / Analyse öffnen ────────────────────────────────────────
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => {
      const prog = document.querySelector('#exportProgress');
      return prog && prog.textContent.includes('Fertig');
    }, { timeout: 30000 }).catch(() => { /* weitermachen auch wenn kein "Fertig" */ });
    await page.waitForTimeout(4000);

    // ── 13. Durch den Antrag scrollen ──────────────────────────────────────
    const exportHtml = page.locator('#exportHtml');
    await exportHtml.evaluate(el => { el.scrollTop = 0; }).catch(() => {});
    await page.waitForTimeout(1500);

    const scrollHeight = await exportHtml.evaluate(el => el.scrollHeight).catch(() => 0);
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      await exportHtml.evaluate((el, pos) => {
        el.scrollTo({ top: pos, behavior: 'smooth' });
      }, Math.round((scrollHeight / steps) * i)).catch(() => {});
      await page.waitForTimeout(1200);
    }
    await page.waitForTimeout(2500);

    // ── 14. PDF-Export klicken ─────────────────────────────────────────────
    await page.locator('#btnExportPDF').click().catch(() => {});
    await page.waitForTimeout(3000);

    // ── 15. Modal schließen ────────────────────────────────────────────────
    await page.locator('#btnCloseModal').click().catch(() => {});
    await page.locator('#modalOverlay').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // Video-Aufnahme abschließen: Video-Objekt VOR dem Schließen des Kontexts sichern,
    // da der Pfad erst nach context.close() finalisiert wird.
    const video = page.video();
    await context.close();
    await browser.close();
    browser = null;

    const videoPath = video ? await video.path() : null;
    if (!videoPath || !fs.existsSync(videoPath)) {
      throw new Error('Keine Video-Datei erzeugt');
    }
    webmPath = videoPath;

    // ── 16. WebM → Zielformat konvertieren ─────────────────────────────────
    const outputPath = path.join(
      os.tmpdir(),
      `unfallatlas-export-${Date.now()}-${crypto.randomUUID()}.${formatMeta.extension}`
    );

    if (format === 'gif') {
      const palettePath = path.join(tmpDir, 'palette.png');
      // Schritt 1: Palette erzeugen (async, damit der Event-Loop nicht blockiert)
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', '1',
        '-i', webmPath,
        '-vf', 'fps=4,scale=800:-1:flags=lanczos,palettegen=max_colors=96:stats_mode=diff',
        palettePath
      ], { timeout: FFMPEG_TIMEOUT_MS });

      // Schritt 2: GIF mit Palette erzeugen (async)
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', '1',
        '-i', webmPath,
        '-i', palettePath,
        '-lavfi', 'fps=4,scale=800:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4',
        outputPath
      ], { timeout: FFMPEG_TIMEOUT_MS });
    } else if (format === 'webp') {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', webmPath,
        '-vf', WEBM_TO_ANIMATED_IMAGE_FILTER,
        '-loop', '0',
        '-vcodec', 'libwebp',
        '-lossless', '0',
        '-q:v', String(WEBP_QUALITY),
        '-compression_level', '6',
        '-preset', 'picture',
        '-an',
        '-vsync', '0',
        outputPath
      ], { timeout: FFMPEG_TIMEOUT_MS });
    } else if (format === 'apng') {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', webmPath,
        '-vf', WEBM_TO_ANIMATED_IMAGE_FILTER,
        '-pix_fmt', 'pal8',
        '-plays', '0',
        '-f', 'apng',
        outputPath
      ], { timeout: FFMPEG_TIMEOUT_MS });
    }

    // Gesamtes tmpDir (enthält video/ + palette.png + .webm) aufräumen
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

    return {
      path: outputPath,
      format,
      contentType: formatMeta.contentType,
      extension: formatMeta.extension
    };

  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore */ }
    }
    // tmpDir aufräumen
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw err;
  }
}

module.exports = { exportVideo };
