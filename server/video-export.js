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
const { ANIMATED_IMAGE_FILTER } = require('./video-export-filters.js');

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 120_000; // 2 minutes max for each ffmpeg step
const WEBP_QUALITY = 60;
const VIDEO_TILE_STABLE_MS = 800;

const SERVER_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8000}`;

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
  let helperResult;
  try {
    helperResult = await page.evaluate(async ({ stableMs }) => {
    if (!window.UA || typeof window.UA.waitForMapFullyRendered !== 'function') {
      return { supported: false, ok: false };
    }
    const map = window._uaMap || (window.UA.ctx && window.UA.ctx.map);
    if (!map) return { supported: false, ok: false };
    const timeoutMs = Number(window.UA.MAP_CAPTURE_TIMEOUT_MS) || 30000;
    const ok = await window.UA.waitForMapFullyRendered(map, {
      ctx: window.UA.ctx || null,
      timeoutMs,
      minTileImages: 4,
      tileStableMs: stableMs
    });
    return {
      supported: true,
      ok: ok === true,
      lifecycle: window.UA.lifecycle && typeof window.UA.lifecycle.getSnapshot === 'function'
        ? window.UA.lifecycle.getSnapshot()
        : null
    };
    }, { stableMs: VIDEO_TILE_STABLE_MS });
  } catch (error) {
    throw new Error(`Video map readiness failed: ${error && error.message ? error.message : error}`);
  }
  if (helperResult.supported) {
    if (helperResult.ok === true) return;
    throw new Error(
      `Video map readiness returned false: ${JSON.stringify(helperResult.lifecycle || null)}`
    );
  }
  await page.waitForFunction(() => {
    const imgs = document.querySelectorAll('.leaflet-tile-pane img');
    return imgs.length >= 4
      && [...imgs].every(i => i.complete && i.naturalWidth > 0 && i.naturalHeight > 0 && !/\bleaflet-tile-loading\b/.test(String(i.className || '')));
  }, { timeout: 30000 });
  await page.waitForTimeout(VIDEO_TILE_STABLE_MS);
}

/** Bewegt die Karte per flyTo und wartet auf Tiles + Animation */
async function flyToAndWait(page, lat, lng, zoom) {
  await page.evaluate(({ lat, lng, zoom }) => {
    return new Promise((resolve, reject) => {
      const map = window._uaMap;
      if (!map) { reject(new Error('window._uaMap is unavailable')); return; }
      map.once('moveend', () => setTimeout(resolve, 200));
      map.flyTo([lat, lng], zoom, { duration: 1.2 });
    });
  }, { lat, lng, zoom });
  await waitForTiles(page);
}

async function selectRequiredCity(page, targetCity) {
  const option = await page.locator('#citySel').evaluate((select, requested) => {
    const match = [...select.options].find(candidate =>
      candidate.value === requested || candidate.textContent.trim() === requested
    );
    return match ? { value: match.value, label: match.textContent.trim() } : null;
  }, targetCity);
  if (!option) throw new Error(`unknown_city:${targetCity}`);
  await page.locator('#citySel').selectOption(option.value);
  return option;
}

function expectedVideoState(params, city) {
  const parseHour = (value, fallback, label) => {
    if (value == null || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) {
      throw new Error(`invalid_${label}:${value}`);
    }
    return parsed;
  };
  const hourFrom = parseHour(params.hourFrom, 0, 'hourFrom');
  const hourTo = parseHour(params.hourTo, 23, 'hourTo');
  if (hourFrom > hourTo) throw new Error(`invalid_hour_range:${hourFrom}-${hourTo}`);
  const involvementMode = params.involvementMode || 'or';
  if (!['or', 'and', 'solo'].includes(involvementMode)) {
    throw new Error(`invalid_involvementMode:${involvementMode}`);
  }
  const selectionKeys = ['selSouth', 'selWest', 'selNorth', 'selEast'];
  const presentSelectionKeys = selectionKeys.filter(key => params[key] != null && params[key] !== '');
  let selection = null;
  if (presentSelectionKeys.length > 0) {
    if (presentSelectionKeys.length !== selectionKeys.length) {
      throw new Error(`incomplete_selection:${presentSelectionKeys.join(',')}`);
    }
    selection = {
      south: Number(params.selSouth),
      west: Number(params.selWest),
      north: Number(params.selNorth),
      east: Number(params.selEast),
    };
    const values = Object.values(selection);
    if (!values.every(Number.isFinite) || selection.south < -90 || selection.north > 90 ||
        selection.west < -180 || selection.east > 180 || selection.south >= selection.north ||
        selection.west >= selection.east) {
      throw new Error(`invalid_selection:${values.join(',')}`);
    }
  }
  const viewKeys = ['centerLat', 'centerLon', 'zoom'];
  const presentViewKeys = viewKeys.filter(key => params[key] != null && params[key] !== '');
  let view = null;
  if (presentViewKeys.length > 0) {
    if (presentViewKeys.length !== viewKeys.length) throw new Error(`incomplete_view:${presentViewKeys.join(',')}`);
    view = { lat: Number(params.centerLat), lon: Number(params.centerLon), zoom: Number(params.zoom) };
    if (!Number.isFinite(view.lat) || !Number.isFinite(view.lon) || !Number.isFinite(view.zoom) ||
        view.lat < -90 || view.lat > 90 || view.lon < -180 || view.lon > 180 ||
        view.zoom < 0 || view.zoom > 24) {
      throw new Error(`invalid_view:${view.lat},${view.lon},${view.zoom}`);
    }
  }
  return {
    city,
    severity: params.severity || 'all',
    involvementMode,
    hourFrom,
    hourTo,
    dayType: params.dayType || 'all',
    roadCondition: params.roadCondition || 'all',
    includeCyclist: params.includeCyclist !== '0',
    includePedestrian: params.includePedestrian !== '0',
    includeCar: params.includeCar !== '0',
    includeMotorcycle: params.includeMotorcycle === '1',
    includeGkfz: params.includeGkfz === '1',
    includeSonstig: params.includeSonstig === '1',
    showCluster: params.showCluster !== '0',
    showHeatmap: params.showHeatmap === '1',
    showOnlyAboveAverage: params.showOnlyAboveAverage === '1',
    selection,
    view,
  };
}

async function assertVideoAnalysisState(page, expected) {
  const actual = await page.evaluate(async required => {
    const lifecycle = window.UA && window.UA.lifecycle;
    if (!lifecycle || typeof lifecycle.whenReady !== 'function') {
      throw new Error('UA.lifecycle.whenReady is unavailable');
    }
    const layers = [];
    if (required.showCluster) layers.push('cluster');
    if (required.showHeatmap) layers.push('heatmap');
    const snapshot = await lifecycle.whenReady({
      city: required.city,
      layers,
      minLoaded: 1,
      minFiltered: 1,
      minViewport: 1,
      requireCompleteCoverage: true,
    }, { timeoutMs: 45000 });
    const checked = id => Boolean(document.getElementById(id)?.checked);
    const active = id => {
      const element = document.getElementById(id);
      return Boolean(element && (element.classList.contains('active') || element.getAttribute('aria-pressed') === 'true'));
    };
    const citySelect = document.getElementById('citySel');
    const map = window._uaMap;
    const center = map && typeof map.getCenter === 'function' ? map.getCenter() : null;
    const url = new URL(window.location.href);
    const selectionValues = ['selSouth', 'selWest', 'selNorth', 'selEast']
      .map(key => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : null);
    const selection = selectionValues.every(Number.isFinite)
      ? { south: selectionValues[0], west: selectionValues[1], north: selectionValues[2], east: selectionValues[3] }
      : null;
    return {
      city: snapshot.city,
      selectedCity: citySelect && citySelect.value,
      severity: document.getElementById('severity')?.value,
      involvementMode: active('modeAnd') ? 'and' : (active('modeSolo') ? 'solo' : 'or'),
      hourFrom: Number(document.getElementById('hFrom')?.value),
      hourTo: Number(document.getElementById('hTo')?.value),
      dayType: document.getElementById('dayType')?.value,
      roadCondition: document.getElementById('roadCondition')?.value,
      includeCyclist: checked('incBike'),
      includePedestrian: checked('incPed'),
      includeCar: checked('incCar'),
      includeMotorcycle: checked('incMoto'),
      includeGkfz: checked('incGkfz'),
      includeSonstig: checked('incSon'),
      showCluster: active('toggleCluster'),
      showHeatmap: active('toggleHeat'),
      showOnlyAboveAverage: active('toggleOnlyHot'),
      selection,
      view: center && typeof map.getZoom === 'function'
        ? { lat: Number(center.lat), lon: Number(center.lng), zoom: Number(map.getZoom()) }
        : null,
      lifecycle: snapshot,
    };
  }, expected);

  const mismatches = [];
  for (const [key, required] of Object.entries(expected)) {
    if (key === 'selection' || key === 'view') continue;
    if (actual[key] !== required) mismatches.push(`${key}: expected ${required}, got ${actual[key]}`);
  }
  if (actual.selectedCity !== expected.city) {
    mismatches.push(`selectedCity: expected ${expected.city}, got ${actual.selectedCity}`);
  }
  if (expected.selection === null) {
    if (actual.selection !== null) mismatches.push('selection: expected none, got a selection');
  } else if (!actual.selection) {
    mismatches.push('selection: requested bounds are missing');
  } else {
    for (const key of ['south', 'west', 'north', 'east']) {
      if (Math.abs(actual.selection[key] - expected.selection[key]) > 0.000001) {
        mismatches.push(`selection.${key}: expected ${expected.selection[key]}, got ${actual.selection[key]}`);
      }
    }
  }
  if (expected.view) {
    if (!actual.view) mismatches.push('view: requested map view is missing');
    else {
      for (const key of ['lat', 'lon']) {
        if (Math.abs(actual.view[key] - expected.view[key]) > 0.000001) {
          mismatches.push(`view.${key}: expected ${expected.view[key]}, got ${actual.view[key]}`);
        }
      }
      if (actual.view.zoom !== expected.view.zoom) {
        mismatches.push(`view.zoom: expected ${expected.view.zoom}, got ${actual.view.zoom}`);
      }
    }
  }
  if (mismatches.length) {
    throw new Error(`Video analysis state mismatch:\n${mismatches.join('\n')}`);
  }
  return actual;
}

async function assertFreshExportContent(page, expectedCity) {
  const content = await page.locator('#exportHtml').innerText();
  const match = content.match(/lokal\s+([\d.,\s\u00a0\u202f]+)\s+Unfälle/i);
  const localAccidents = match ? Number(match[1].replace(/\D/g, '')) : 0;
  if (!content.includes(expectedCity)) {
    throw new Error(`Video export preview does not identify requested city ${expectedCity}`);
  }
  if (!(localAccidents > 0)) {
    throw new Error('Video export preview does not prove non-empty local accident data');
  }
  return { localAccidents };
}

/** Wartet auf einen frisch gerenderten, semantisch nichtleeren Exportbericht. */
async function waitForFreshExportPreview(page, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 45000;
  const previousFingerprint = String(opts.previousFingerprint || '');
  await page.waitForFunction((prevFp) => {
    const progress = document.querySelector('#exportProgress');
    const root = document.querySelector('#exportHtml');
    if (!progress || !root) return false;
    const progressText = String(progress.textContent || '').trim();
    const content = String(root.textContent || '').replace(/\s+/g, ' ').trim();
    if (/Fehler/i.test(progressText) || /Export fehlgeschlagen/i.test(content)) {
      throw new Error(`Export preview failed: ${progressText}; ${content.slice(0, 500)}`);
    }
    if (!/Fertig/.test(progressText)) return false;
    if (/Report wird erzeugt/.test(content)) return false;
    if (!/Auswertung:\s*lokal\s+[\d.,\s\u00a0\u202f]+\s+Unfälle/i.test(content)) return false;

    const html = String(root.innerHTML || '');
    let hash = 2166136261;
    for (let i = 0; i < html.length; i++) {
      hash ^= html.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const fp = `${html.length}:${(hash >>> 0).toString(16)}`;
    if (prevFp && fp === prevFp) return false;
    return true;
  }, previousFingerprint, { timeout: timeoutMs });
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

    // ── 1. Standardansicht laden ────────────────────────────────────────────
    await page.goto(`${SERVER_URL}/werkbank_v2.html`);
    await page.waitForLoadState('domcontentloaded');
    await waitForCities(page);
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── 2. Stadt auswählen ──────────────────────────────────────────────────
    const targetCity = params.city || 'Hannover';
    const requiredState = expectedVideoState(params, targetCity);
    await selectRequiredCity(page, targetCity);
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
      await page.locator('#modeAnd').click();
      await page.waitForTimeout(600);
    } else if (mode === 'solo') {
      await page.locator('#modeSolo').click();
      await page.waitForTimeout(600);
    }
    // 'or' ist Standard, kein Klick nötig

    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // ── 6. Tageszeit-Filter setzen ──────────────────────────────────────────
    const hourFrom = requiredState.hourFrom;
    const hourTo = requiredState.hourTo;
    if (hourFrom !== 0) {
      await page.locator('#hFrom').evaluate((input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, hourFrom);
      await page.waitForTimeout(400);
    }
    if (hourTo !== 23) {
      await page.locator('#hTo').evaluate((input, value) => {
        input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, hourTo);
      await page.waitForTimeout(400);
    }

    // ── 7. Wochentag-Filter setzen ──────────────────────────────────────────
    if (params.dayType && params.dayType !== 'all') {
      await page.locator('#dayType').selectOption(params.dayType);
      await page.waitForTimeout(600);
    }

    // ── 8. Fahrbahnzustand setzen ───────────────────────────────────────────
    if (params.roadCondition && params.roadCondition !== 'all') {
      await page.locator('#roadCondition').selectOption(params.roadCondition);
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
      await page.locator('#toggleCluster').click();
      await waitForTiles(page);
      await page.waitForTimeout(600);
    }

    // Heatmap togglen wenn gewünscht
    const heatActive = await page.locator('#toggleHeat').evaluate(
      btn => btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true'
    ).catch(() => false);
    if (heatActive !== wantHeatmap) {
      await page.locator('#toggleHeat').click();
      await waitForTiles(page);
      await page.waitForTimeout(600);
    }

    // Hotspot togglen wenn gewünscht
    const hotActive = await page.locator('#toggleOnlyHot').evaluate(
      btn => btn.classList.contains('active') || btn.getAttribute('aria-pressed') === 'true'
    ).catch(() => false);
    if (hotActive !== wantHotspot) {
      await page.locator('#toggleOnlyHot').click();
      await waitForTiles(page);
      await page.waitForTimeout(600);
    }

    await page.waitForTimeout(1500);

    // ── 10. Zur Kartenposition fliegen ─────────────────────────────────────
    if (requiredState.view) {
      await flyToAndWait(page, requiredState.view.lat, requiredState.view.lon, requiredState.view.zoom);
    }
    await page.waitForTimeout(2000);

    // ── 11. Bereich markieren (Rechteck zeichnen) ──────────────────────────
    if (requiredState.selection) {
      await page.evaluate(bounds => {
        const map = window._uaMap;
        if (!map || !window.L || typeof window.L.rectangle !== 'function') {
          throw new Error('Leaflet selection API is unavailable');
        }
        const layer = window.L.rectangle(
          [[bounds.south, bounds.west], [bounds.north, bounds.east]],
          { color: '#2b7cff', weight: 2 }
        );
        map.fire(window.L.Draw.Event.CREATED, { layer, layerType: 'rectangle' });
      }, requiredState.selection);
      await waitForTiles(page);
      await page.waitForTimeout(2000);
    }

    await assertVideoAnalysisState(page, requiredState);

    // ── 12. Export / Analyse öffnen ────────────────────────────────────────
    const beforeExportFingerprint = await page.evaluate(() => {
      const root = document.querySelector('#exportHtml');
      if (!root) throw new Error('Export preview container is unavailable before rendering');
      const html = String(root.innerHTML || '');
      let hash = 2166136261;
      for (let i = 0; i < html.length; i++) {
        hash ^= html.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return `${html.length}:${(hash >>> 0).toString(16)}`;
    });
    await page.locator('#btnOpenExport').click();
    await page.locator('#modalOverlay').waitFor({ state: 'visible', timeout: 10000 });
    await waitForFreshExportPreview(page, {
      previousFingerprint: beforeExportFingerprint,
      timeoutMs: 45000
    });
    await assertFreshExportContent(page, targetCity);
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
    await page.locator('#btnExportPDF').click();
    await page.waitForTimeout(3000);

    // ── 15. Modal schließen ────────────────────────────────────────────────
    await page.locator('#btnCloseModal').click();
    await page.locator('#modalOverlay').waitFor({ state: 'hidden', timeout: 5000 });
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
        '-vf', `${ANIMATED_IMAGE_FILTER},palettegen=max_colors=96:stats_mode=diff`,
        palettePath
      ], { timeout: FFMPEG_TIMEOUT_MS });

      // Schritt 2: GIF mit Palette erzeugen (async)
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss', '1',
        '-i', webmPath,
        '-i', palettePath,
        '-lavfi', `${ANIMATED_IMAGE_FILTER}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4`,
        outputPath
      ], { timeout: FFMPEG_TIMEOUT_MS });
    } else if (format === 'webp') {
      await execFileAsync('ffmpeg', [
        '-y',
        '-i', webmPath,
        '-vf', ANIMATED_IMAGE_FILTER,
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
        '-vf', ANIMATED_IMAGE_FILTER,
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

module.exports = {
  ANIMATED_IMAGE_FILTER,
  assertFreshExportContent,
  assertVideoAnalysisState,
  expectedVideoState,
  exportVideo,
  selectRequiredCity,
  waitForFreshExportPreview,
  waitForTiles,
};
