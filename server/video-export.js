/**
 * Playwright-basierter Video-Export für die Unfallwerkbank.
 *
 * Nimmt URL-Parameter der Werkbank entgegen, spielt den kompletten
 * Analyse-Ablauf in einem Headless-Chromium durch (mit sichtbaren
 * Interaktionen), zeichnet ein Video auf und konvertiert es per
 * ffmpeg zu einem GIF.
 *
 * Ablauf:
 *  1. Werkbank mit dem kanonischen Kontextzustand laden
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
const videoExportContract = require('../js/ua.video-export-contract.js');

const execFileAsync = promisify(execFile);
const FFMPEG_TIMEOUT_MS = 120_000; // 2 minutes max for each ffmpeg step
const WEBP_QUALITY = 60;
const VIDEO_TILE_STABLE_MS = 800;
const ENCODED_INSPECTION_FPS = 2;
const MAX_DECODE_BUFFER_BYTES = 256 * 1024 * 1024;

const SERVER_URL = process.env.BASE_URL || `http://localhost:${process.env.PORT || 8000}`;

class VideoExportSemanticError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'VideoExportSemanticError';
    this.code = code;
    this.status = 422;
    this.details = details || null;
  }
}

/** Wartet bis Städte im Dropdown geladen sind */
async function waitForCities(page) {
  await page.waitForFunction(() => {
    const select = document.querySelector('#citySel');
    if (!select) return false;
    const opts = select.querySelectorAll('option');
    return opts.length > 1 && ![...opts].some(o => o.textContent.includes('Lade'));
  }, null, { timeout: 60000 });
}

/** Wartet bis Unfalldaten geladen wurden */
async function waitForData(page) {
  await page.waitForFunction(() => {
    const stat = document.querySelector('#stat');
    return stat && stat.textContent.includes('geladen:');
  }, null, { timeout: 30000 });
}

/** Wartet bis Kartenkacheln geladen sind */
async function waitForTiles(page) {
  let helperResult;
  try {
    helperResult = await page.evaluate(async ({ stableMs }) => {
    if (!window.UA || typeof window.UA.waitForMapFullyRendered !== 'function') {
      return { supported: false, ok: false };
    }
    const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
      ? window.UA.getRuntimeContext()
      : null;
    const map = window._uaMap || (ctx && ctx.map);
    if (!map) return { supported: false, ok: false };
    const timeoutMs = Number(window.UA.MAP_CAPTURE_TIMEOUT_MS) || 30000;
    const ok = await window.UA.waitForMapFullyRendered(map, {
      ctx,
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
  }, null, { timeout: 30000 });
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
  if (!option) {
    throw new VideoExportSemanticError(
      'unknown_city',
      `Requested city is not available: ${targetCity}`
    );
  }
  await page.locator('#citySel').selectOption(option.value);
  return option;
}

function expectedVideoState(params, city) {
  if (params && typeof params === 'object' &&
      (params.schemaVersion != null || params.filters || params.context || params.layers)) {
    return videoExportContract.normalizeState({ ...params, city: city || params.city });
  }
  return videoExportContract.fromLegacyParams({ ...(params || {}), city: city || params && params.city });
}

/**
 * Hydrate context filters and road layers through the application's public URL
 * contract. This is the same product path used by shared links and the context
 * media generator, and avoids coordinate-based clicks on Leaflet controls that
 * can legitimately sit underneath the analysis panel.
 */
function buildVideoWorkbenchUrl(requiredState) {
  const url = new URL('/werkbank_v2.html', SERVER_URL);
  url.searchParams.set('city', requiredState.city);
  if (requiredState.context.slopeClasses.length) {
    url.searchParams.set('ctxSlope', requiredState.context.slopeClasses.join(','));
  }
  if (requiredState.context.trafficClasses.length) {
    url.searchParams.set('ctxTraffic', requiredState.context.trafficClasses.join(','));
  }
  if (requiredState.context.onlyMatchedWays) url.searchParams.set('ctxOnlyMatched', '1');
  const contextLayers = ['slope', 'traffic'].filter(kind => requiredState.layers[kind]);
  if (contextLayers.length) url.searchParams.set('mapLayer', contextLayers.join(','));
  return url.toString();
}

async function assertRuntimeContextAvailable(page) {
  const observed = await page.evaluate(() => {
    const accessorDefined = Boolean(
      window.UA && typeof window.UA.getRuntimeContext === 'function'
    );
    const ctx = accessorDefined ? window.UA.getRuntimeContext() : null;
    return {
      accessorDefined,
      contextObject: Boolean(ctx && typeof ctx === 'object'),
      mapAvailable: Boolean(ctx && ctx.map),
      mapIdentity: Boolean(ctx && ctx.map && window._uaMap && ctx.map === window._uaMap),
    };
  });
  if (!observed || !observed.accessorDefined || !observed.contextObject ||
      !observed.mapAvailable || !observed.mapIdentity) {
    throw new VideoExportSemanticError(
      'runtime_context_unavailable',
      'The workbench runtime-context integration contract is unavailable',
      { observed: observed || null }
    );
  }
  return observed;
}

async function waitForRequestedContextState(page, requiredState) {
  await assertRuntimeContextAvailable(page);
  const requested = {
    context: requiredState.context,
    layers: {
      slope: requiredState.layers.slope,
      traffic: requiredState.layers.traffic,
    },
  };
  try {
    await page.waitForFunction(required => {
      const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
        ? window.UA.getRuntimeContext()
        : null;
      if (!ctx) return false;
      const sorted = value => Array.from(value || []).map(String).sort();
      const same = (left, right) => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
      const filters = ctx.contextFilters || {};
      if (!same(filters.slopeClasses, required.context.slopeClasses) ||
          !same(filters.trafficClasses, required.context.trafficClasses) ||
          Boolean(filters.onlyMatchedWays) !== Boolean(required.context.onlyMatchedWays)) {
        return false;
      }

      const map = ctx.map || window._uaMap;
      const registry = ctx.contextOverlays || {};
      const active = registry.active || {};
      const layers = registry.layers || {};
      for (const kind of ['slope', 'traffic']) {
        const expected = Boolean(required.layers[kind]);
        if (Boolean(active[kind]) !== expected) return false;
        const control = document.querySelector(`input[data-context-overlay="${kind}"]`);
        if (expected && (!control || control.disabled || !control.checked)) return false;
        if (!expected) continue;
        const layer = layers[kind];
        const attached = Boolean(layer && map && (
          (typeof map.hasLayer === 'function' && map.hasLayer(layer)) || layer._map === map
        ));
        const children = layer && typeof layer.getLayers === 'function' ? layer.getLayers() : [];
        if (!attached || !Array.isArray(children) || children.length < 1) return false;
      }
      return true;
    }, requested, { timeout: 60000 });
  } catch (error) {
    let observed;
    try {
      observed = await page.evaluate(() => {
        const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
          ? (window.UA.getRuntimeContext() || {})
          : {};
        const registry = ctx.contextOverlays || {};
        const values = value => Array.from(value || []).map(String).sort();
        const layer = kind => {
          const candidate = registry.layers && registry.layers[kind];
          const map = ctx.map || window._uaMap;
          return {
            active: Boolean(registry.active && registry.active[kind]),
            checked: Boolean(document.querySelector(`input[data-context-overlay="${kind}"]`)?.checked),
            attached: Boolean(candidate && map && (
              (typeof map.hasLayer === 'function' && map.hasLayer(candidate)) || candidate._map === map
            )),
            children: candidate && typeof candidate.getLayers === 'function' ? candidate.getLayers().length : 0,
          };
        };
        return {
          context: {
            slopeClasses: values(ctx.contextFilters && ctx.contextFilters.slopeClasses),
            trafficClasses: values(ctx.contextFilters && ctx.contextFilters.trafficClasses),
            onlyMatchedWays: Boolean(ctx.contextFilters && ctx.contextFilters.onlyMatchedWays),
          },
          layers: { slope: layer('slope'), traffic: layer('traffic') },
        };
      });
    } catch (diagnosticError) {
      observed = {
        diagnosticError: String(diagnosticError && diagnosticError.message || diagnosticError),
      };
    }
    throw new VideoExportSemanticError(
      'context_state_unavailable',
      `Requested context state did not become render-ready for ${requiredState.city}`,
      { requested, observed, cause: String(error && error.message || error) }
    );
  }
}

async function assertVideoAnalysisState(page, expected) {
  const actual = await page.evaluate(async required => {
    const lifecycle = window.UA && window.UA.lifecycle;
    if (!lifecycle || typeof lifecycle.whenReady !== 'function') {
      throw new Error('UA.lifecycle.whenReady is unavailable');
    }
    const layers = [];
    if (required.layers.cluster) layers.push('cluster');
    if (required.layers.heatmap) layers.push('heatmap');
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
    const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
      ? (window.UA.getRuntimeContext() || {})
      : {};
    const contextFilters = ctx.contextFilters || {};
    const selectionBounds = ctx.selectionBounds;
    const selection = selectionBounds && typeof selectionBounds.getSouth === 'function'
      ? {
          south: Number(selectionBounds.getSouth()),
          west: Number(selectionBounds.getWest()),
          north: Number(selectionBounds.getNorth()),
          east: Number(selectionBounds.getEast()),
        }
      : null;
    const contextRegistry = ctx.contextOverlays || {};
    const contextOverlays = contextRegistry.active || {};
    const visibleLegendText = [...document.querySelectorAll('.context-road-legend')]
      .filter(element => {
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden';
      })
      .map(element => String(element.textContent || '').replace(/\s+/g, ' ').trim());

    // Context colors are intentionally not used as ownership evidence.  The
    // lightest slope/traffic swatches are close enough that lossy encoding can
    // make one satisfy both palettes.  Instead prove that the exact registry
    // layer for each kind is active, attached to this map and owns non-empty
    // geometry whose feature payload identifies that kind.
    const contextOwnership = {};
    const inspectOwnedLayer = kind => {
      const root = contextRegistry.layers && contextRegistry.layers[kind];
      let geometryCount = 0;
      let matchingGeometryCount = 0;
      let childCount = 0;
      const seen = new Set();
      const visit = layer => {
        if (!layer || seen.has(layer)) return;
        seen.add(layer);
        if (layer !== root) childCount += 1;
        if (typeof layer.getLatLngs === 'function') {
          let latLngs = null;
          try { latLngs = layer.getLatLngs(); } catch (_) { /* invalid child */ }
          if (Array.isArray(latLngs) && latLngs.length) {
            geometryCount += 1;
            const featureKind = layer.feature && layer.feature.properties &&
              layer.feature.properties.kind;
            if (featureKind === kind) matchingGeometryCount += 1;
          }
        }
        if (typeof layer.getLayers === 'function') {
          let children = [];
          try { children = layer.getLayers() || []; } catch (_) { /* invalid group */ }
          for (const child of children) visit(child);
        }
      };
      visit(root);
      const attached = Boolean(root && map && (
        (typeof map.hasLayer === 'function' && map.hasLayer(root)) || root._map === map
      ));
      return {
        active: Boolean(contextOverlays[kind]),
        present: Boolean(root),
        attached,
        childCount,
        geometryCount,
        matchingGeometryCount,
      };
    };
    for (const kind of ['slope', 'traffic']) contextOwnership[kind] = inspectOwnedLayer(kind);
    contextOwnership.layersDistinct = !contextRegistry.layers ||
      !contextRegistry.layers.slope || !contextRegistry.layers.traffic ||
      contextRegistry.layers.slope !== contextRegistry.layers.traffic;
    return {
      state: {
        schemaVersion: required.schemaVersion,
        city: citySelect && citySelect.value,
        filters: {
          severity: document.getElementById('severity')?.value,
          involvementMode: active('modeAnd') ? 'and' : (active('modeSolo') ? 'solo' : 'or'),
          hourFrom: Number(document.getElementById('hFrom')?.value),
          hourTo: Number(document.getElementById('hTo')?.value),
          dayType: document.getElementById('dayType')?.value,
          roadCondition: document.getElementById('roadCondition')?.value,
          maxPoints: Number(document.getElementById('maxPoints')?.value),
          viewportPaddingPct: Number(document.getElementById('viewportPaddingPct')?.value),
          heatRadius: Number(document.getElementById('heatRadius')?.value),
          involvement: {
            cyclist: checked('incBike'),
            pedestrian: checked('incPed'),
            car: checked('incCar'),
            motorcycle: checked('incMoto'),
            gkfz: checked('incGkfz'),
            sonstig: checked('incSon'),
          },
        },
        context: {
          slopeClasses: Array.from(contextFilters.slopeClasses || []).sort(),
          trafficClasses: Array.from(contextFilters.trafficClasses || []).sort(),
          onlyMatchedWays: Boolean(contextFilters.onlyMatchedWays),
        },
        layers: {
          cluster: active('toggleCluster'),
          heatmap: active('toggleHeat'),
          onlyAboveAverage: active('toggleOnlyHot'),
          slope: Boolean(contextOverlays.slope),
          traffic: Boolean(contextOverlays.traffic),
        },
        selection,
        viewport: center && typeof map.getZoom === 'function'
          ? { center: { lat: Number(center.lat), lon: Number(center.lng) }, zoom: Number(map.getZoom()) }
          : null,
      },
      selectedCity: citySelect && citySelect.value,
      lifecycleCity: snapshot.city,
      selection,
      lifecycle: snapshot,
      frameSemantics: { visibleLegendText, contextOwnership },
    };
  }, expected);

  const mismatches = [];
  const compare = (path, required, observed) => {
    if (videoExportContract.stableStringify(required) !== videoExportContract.stableStringify(observed)) {
      mismatches.push(
        `${path}: expected ${videoExportContract.stableStringify(required)}, ` +
        `got ${videoExportContract.stableStringify(observed)}`
      );
    }
  };
  compare('filters', expected.filters, actual.state.filters);
  compare('context', {
    ...expected.context,
    slopeClasses: expected.context.slopeClasses.slice().sort(),
    trafficClasses: expected.context.trafficClasses.slice().sort(),
  }, actual.state.context);
  compare('layers', expected.layers, actual.state.layers);
  if (actual.selectedCity !== expected.city) {
    mismatches.push(`selectedCity: expected ${expected.city}, got ${actual.selectedCity}`);
  }
  if (actual.lifecycleCity !== expected.city) {
    mismatches.push(`city: expected ${expected.city}, got ${actual.lifecycleCity}`);
  }
  if (expected.selection === null) {
    if (actual.state.selection !== null) mismatches.push('selection: expected none, got a selection');
  } else if (!actual.state.selection) {
    mismatches.push('selection: requested bounds are missing');
  } else {
    for (const key of ['south', 'west', 'north', 'east']) {
      if (Math.abs(actual.state.selection[key] - expected.selection[key]) > 0.000001) {
        mismatches.push(`selection.${key}: expected ${expected.selection[key]}, got ${actual.state.selection[key]}`);
      }
    }
  }
  if (expected.viewport) {
    if (!actual.state.viewport) mismatches.push('viewport: requested map view is missing');
    else {
      for (const key of ['lat', 'lon']) {
        if (Math.abs(actual.state.viewport.center[key] - expected.viewport.center[key]) > 0.00001) {
          mismatches.push(
            `viewport.center.${key}: expected ${expected.viewport.center[key]}, ` +
            `got ${actual.state.viewport.center[key]}`
          );
        }
      }
      if (actual.state.viewport.zoom !== expected.viewport.zoom) {
        mismatches.push(
          `viewport.zoom: expected ${expected.viewport.zoom}, got ${actual.state.viewport.zoom}`
        );
      }
    }
  }
  const semantics = actual.frameSemantics || {};
  const visibleLegendText = Array.isArray(semantics.visibleLegendText)
    ? semantics.visibleLegendText : [];
  const ownership = semantics.contextOwnership || {};
  const assertContextOwnership = kind => {
    const proof = ownership[kind] || {};
    if (!proof.active || !proof.present || !proof.attached ||
        !(proof.geometryCount > 0) || !(proof.matchingGeometryCount > 0)) {
      mismatches.push(
        `layers.${kind}: registry ownership is not active, attached and non-empty ` +
        `(observed ${videoExportContract.stableStringify(proof)})`
      );
    }
  };
  if (expected.layers.slope) {
    if (!visibleLegendText.some(text => text.includes('Straßensteigung'))) {
      mismatches.push('layers.slope: visible Straßensteigung legend is missing');
    }
    assertContextOwnership('slope');
  }
  if (expected.layers.traffic) {
    if (!visibleLegendText.some(text => text.includes('Verkehrsbelastung'))) {
      mismatches.push('layers.traffic: visible Verkehrsbelastung legend is missing');
    }
    assertContextOwnership('traffic');
  }
  if (expected.layers.slope && expected.layers.traffic && ownership.layersDistinct !== true) {
    mismatches.push('layers.slope/traffic: registry layers must be distinct owned layer instances');
  }
  if (mismatches.length) {
    throw new VideoExportSemanticError(
      'video_state_mismatch',
      `Video analysis state mismatch:\n${mismatches.join('\n')}`,
      { expected, actual }
    );
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

function sha256Buffer(buffer) {
  const digest = crypto.createHash('sha256').update(buffer).digest();
  return { hex: digest.toString('hex'), base64: digest.toString('base64') };
}

function sha256Canonical(value) {
  return sha256Buffer(Buffer.from(videoExportContract.stableStringify(value), 'utf8')).hex;
}

async function readBuildEvidence(page) {
  const manifest = await page.evaluate(async () => {
    const response = await fetch('/build-manifest.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`build-manifest HTTP ${response.status}`);
    return response.json();
  });
  const buildFingerprint = manifest && manifest.fingerprint;
  const dataFingerprint = manifest && manifest.data && manifest.data.fingerprint;
  if (!/^[a-f0-9]{64}$/.test(String(buildFingerprint || '')) ||
      !/^[a-f0-9]{64}$/.test(String(dataFingerprint || ''))) {
    throw new VideoExportSemanticError(
      'build_evidence_invalid',
      'Build manifest does not contain valid build/data fingerprints'
    );
  }
  return {
    build: { fingerprint: buildFingerprint },
    data: { fingerprint: dataFingerprint },
  };
}

async function installSemanticEvidenceBadge(page, state, stateSha256, analysis) {
  const lifecycle = analysis && analysis.lifecycle || {};
  const counts = lifecycle.counts || {};
  const contextLabels = [];
  if (state.layers.slope) contextLabels.push('Steigung');
  if (state.layers.traffic) contextLabels.push('Verkehr');
  if (state.context.slopeClasses.length) {
    contextLabels.push(`Steigungsfilter ${state.context.slopeClasses.join('+')}`);
  }
  if (state.context.trafficClasses.length) {
    contextLabels.push(`Verkehrsfilter ${state.context.trafficClasses.join('+')}`);
  }
  if (state.context.onlyMatchedWays) contextLabels.push('nur OSM-zugeordnet');
  const label = [
    'Video-Evidenz',
    state.city,
    `State ${stateSha256.slice(0, 12)}`,
    `geladen ${Number(counts.loaded || 0).toLocaleString('de-DE')}`,
    `gefiltert ${Number(counts.filtered || 0).toLocaleString('de-DE')}`,
    `Ausschnitt ${Number(counts.viewport || 0).toLocaleString('de-DE')}`,
    contextLabels.length ? contextLabels.join(', ') : 'Kontextfilter aus',
  ].join(' · ');

  const visualWitness = await page.evaluate(({ text, digest, requiredLayers }) => {
    const previous = document.getElementById('ua-video-semantic-evidence');
    if (previous) previous.remove();
    for (const witness of document.querySelectorAll('[data-video-layer-witness]')) witness.remove();
    const badge = document.createElement('div');
    badge.id = 'ua-video-semantic-evidence';
    badge.dataset.stateSha256 = digest;
    badge.textContent = text;
    Object.assign(badge.style, {
      position: 'fixed',
      left: '12px',
      right: '12px',
      top: '8px',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      padding: '7px 10px',
      border: '3px solid rgb(0, 191, 165)',
      borderRadius: '5px',
      background: 'rgba(17, 17, 17, 0.94)',
      color: 'white',
      font: '700 14px/1.25 system-ui, sans-serif',
      letterSpacing: '0.01em',
      pointerEvents: 'none',
    });
    document.body.appendChild(badge);

    const mapElement = document.getElementById('map');
    const mapRect = mapElement && mapElement.getBoundingClientRect();
    const insideMap = rect => mapRect && rect.width > 0 && rect.height > 0 &&
      rect.left >= mapRect.left && rect.right <= mapRect.right &&
      rect.top >= mapRect.top + 48 && rect.bottom <= mapRect.bottom - 18;
    const visible = element => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden' && insideMap(rect);
    };
    const ctx = window.UA && typeof window.UA.getRuntimeContext === 'function'
      ? window.UA.getRuntimeContext()
      : null;
    const map = window._uaMap || ctx && ctx.map;
    const attached = layer => Boolean(layer && map && (
      (typeof map.hasLayer === 'function' && map.hasLayer(layer)) || layer._map === map
    ));
    const pointInsideMap = (x, y, margin) => Boolean(mapRect &&
      x >= mapRect.left + margin && x <= mapRect.right - margin &&
      y >= mapRect.top + 52 && y <= mapRect.bottom - 20);
    const addRing = (scope, kind, x, y, radius, color) => {
      const ring = document.createElement('div');
      ring.dataset.videoLayerWitness = `${scope}:${kind}`;
      Object.assign(ring.style, {
        position: 'fixed',
        left: `${x - radius}px`,
        top: `${y - radius}px`,
        width: `${radius * 2}px`,
        height: `${radius * 2}px`,
        borderRadius: '50%',
        border: `5px solid rgb(${color.join(', ')})`,
        background: 'transparent',
        boxSizing: 'border-box',
        zIndex: '2147483646',
        pointerEvents: 'none',
      });
      document.body.appendChild(ring);
    };

    const accidentWitnesses = {};
    if (requiredLayers.cluster) {
      const group = ctx && ctx.clusterLayer;
      const children = attached(group) && typeof group.getLayers === 'function'
        ? group.getLayers() : [];
      for (const marker of children) {
        if (!marker || typeof marker.getLatLng !== 'function' || !marker._uaProps) continue;
        const parent = typeof group.getVisibleParent === 'function'
          ? group.getVisibleParent(marker) : marker;
        if (parent && parent !== marker && parent._icon && visible(parent._icon)) {
          const rect = parent._icon.getBoundingClientRect();
          const x = rect.left + rect.width / 2;
          const y = rect.top + rect.height / 2;
          const radius = Math.max(rect.width, rect.height) / 2;
          const ringRadius = radius + 6;
          const color = [255, 0, 255];
          addRing('accident', 'cluster', x, y, ringRadius, color);
          accidentWitnesses.cluster = {
            kind: 'cluster',
            clusterSize: parent._icon.classList.contains('marker-cluster-large')
              ? 'large'
              : (parent._icon.classList.contains('marker-cluster-medium') ? 'medium' : 'small'),
            x, y, radius, ringRadius, witnessColor: color,
            ownershipVerified: true,
          };
          break;
        }
        if (parent !== marker) continue;
        const projected = map && map.latLngToContainerPoint(marker.getLatLng());
        if (!projected || !mapRect) continue;
        const x = mapRect.left + Number(projected.x);
        const y = mapRect.top + Number(projected.y);
        if (!pointInsideMap(x, y, 14)) continue;
        const color = [255, 0, 255];
        const ringRadius = 10;
        addRing('accident', 'cluster', x, y, ringRadius, color);
        accidentWitnesses.cluster = {
          kind: 'severity',
          clusterSize: null,
          x, y, radius: 7, ringRadius, witnessColor: color,
          ownershipVerified: true,
          projectedFromOwnedMarker: true,
          expectedColor: marker.options && marker.options.fillColor || null,
        };
        break;
      }
    }

    if (requiredLayers.heatmap) {
      const heatLayer = ctx && ctx.heatLayer;
      const canvas = heatLayer && (heatLayer._canvas ||
        heatLayer._renderer && heatLayer._renderer._container);
      if (attached(heatLayer) && canvas instanceof HTMLCanvasElement &&
          mapRect && canvas.width && canvas.height) {
        const drawing = canvas.getContext('2d', { willReadFrequently: true });
        const pixels = drawing && drawing.getImageData(0, 0, canvas.width, canvas.height).data;
        let found = null;
        if (pixels) {
          // This pixel comes from the exact canvas owned by ctx.heatLayer, not
          // from an arbitrary overlay canvas or a shared global palette.
          for (let alpha = 3; alpha < pixels.length; alpha += 4) {
            if (pixels[alpha] < 160) continue;
            const pixel = (alpha - 3) / 4;
            const px = pixel % canvas.width;
            const py = Math.floor(pixel / canvas.width);
            if (px < 20 || py < 50 || px > canvas.width - 20 || py > canvas.height - 20) continue;
            found = {
              px,
              py,
              color: [pixels[alpha - 3], pixels[alpha - 2], pixels[alpha - 1]],
            };
            break;
          }
        }
        if (found) {
          const rect = canvas.getBoundingClientRect();
          const x = rect.left + found.px * (rect.width / canvas.width);
          const y = rect.top + found.py * (rect.height / canvas.height);
          // Purple is deliberately outside both the heat gradient and all
          // other witness colors, so the ring cannot satisfy the underlying
          // heat-pixel check after lossy encoding.
          const color = [128, 0, 128];
          const ringRadius = 10;
          addRing('accident', 'heatmap', x, y, ringRadius, color);
          accidentWitnesses.heatmap = {
            kind: 'heatmap', x, y, radius: 9, ringRadius,
            witnessColor: color, expectedColor: found.color,
            ownershipVerified: true,
          };
        }
      }
    }

    const flattenLatLngs = (value, out) => {
      if (Array.isArray(value)) {
        for (const child of value) flattenLatLngs(child, out);
      } else if (value && Number.isFinite(Number(value.lat)) &&
                 Number.isFinite(Number(value.lng))) {
        out.push({ lat: Number(value.lat), lng: Number(value.lng) });
      }
      return out;
    };
    const collectOwnedContextGeometry = (root, kind) => {
      const found = [];
      const seen = new Set();
      const visit = layer => {
        if (!layer || seen.has(layer)) return;
        seen.add(layer);
        const featureKind = layer.feature && layer.feature.properties &&
          layer.feature.properties.kind;
        if (featureKind === kind && typeof layer.getLatLngs === 'function') {
          let latLngs = [];
          try { latLngs = flattenLatLngs(layer.getLatLngs(), []); } catch (_) { latLngs = []; }
          if (latLngs.length > 1) {
            found.push({
              layer,
              latLngs,
              expectedColor: layer.options && layer.options.color || null,
              lineWeight: Number(layer.options && layer.options.weight) || 0,
              dashArray: String(layer.options && layer.options.dashArray || ''),
              wayId: String(layer.feature && layer.feature.properties &&
                layer.feature.properties.way_id || ''),
            });
          }
        }
        if (typeof layer.getLayers === 'function') {
          let children = [];
          try { children = layer.getLayers() || []; } catch (_) { children = []; }
          for (const child of children) visit(child);
        }
      };
      visit(root);
      return found;
    };

    const parseRgb = value => {
      const text = String(value || '').trim();
      const hex = text.match(/^#([a-f\d]{6})$/i);
      if (hex) return [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16));
      const rgb = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
      return rgb ? rgb.slice(1, 4).map(Number) : null;
    };
    const colorBoxesOverlap = (left, right, tolerance) => {
      const a = parseRgb(left), b = parseRgb(right);
      return Boolean(a && b && a.every((channel, index) =>
        Math.abs(channel - b[index]) <= tolerance * 2
      ));
    };
    const buildGeometryCandidates = (features, predicate) => {
      const candidates = [];
      for (const feature of features) {
        if (predicate && !predicate(feature)) continue;
        for (let index = 0; index < feature.latLngs.length - 1; index += 1) {
          const current = feature.latLngs[index];
          const next = feature.latLngs[index + 1];
          // A road can cross the viewport with both endpoints outside it.
          // Sample the owned segment itself, not a global canvas color.
          for (const ratio of [0.5, 0.25, 0.75, 0, 1]) {
            const latLng = {
              lat: current.lat + (next.lat - current.lat) * ratio,
              lng: current.lng + (next.lng - current.lng) * ratio,
            };
            const projected = map && map.latLngToContainerPoint(latLng);
            if (!projected || !mapRect) continue;
            const x = mapRect.left + Number(projected.x);
            const y = mapRect.top + Number(projected.y);
            if (!pointInsideMap(x, y, 22)) continue;
            candidates.push({ ...feature, x, y });
            if (candidates.length >= 400) return candidates;
          }
        }
      }
      return candidates;
    };

    const contextWitnesses = {};
    const contextRegistry = ctx && ctx.contextOverlays || {};
    const contextColors = { slope: [0, 96, 255], traffic: [255, 0, 128] };
    const contextRadii = { slope: 11, traffic: 18 };
    const roots = {};
    const features = {};
    for (const kind of ['slope', 'traffic']) {
      if (!requiredLayers[kind]) continue;
      roots[kind] = contextRegistry.layers && contextRegistry.layers[kind];
      if (!contextRegistry.active || !contextRegistry.active[kind] || !attached(roots[kind])) continue;
      features[kind] = collectOwnedContextGeometry(roots[kind], kind);
    }

    const selectedGeometry = {};
    if (requiredLayers.slope && requiredLayers.traffic && features.slope && features.traffic) {
      const slopeByWay = new Map(features.slope.map(feature => [feature.wayId, feature]));
      const trafficByWay = new Map(features.traffic.map(feature => [feature.wayId, feature]));

      // Prefer one shared road corridor. The product deliberately renders
      // slope as an 8 px solid casing and traffic as a 3 px dashed centreline,
      // so both real colors must survive in the same composite corridor.
      for (const slope of features.slope) {
        const traffic = trafficByWay.get(slope.wayId);
        if (!traffic || !slope.wayId) continue;
        if (slope.lineWeight < traffic.lineWeight + 3 || !traffic.dashArray) continue;
        if (colorBoxesOverlap(slope.expectedColor, traffic.expectedColor, 45)) continue;
        const candidate = buildGeometryCandidates([slope])[0];
        if (!candidate) continue;
        selectedGeometry.slope = {
          ...candidate,
          counterpartExpectedColor: traffic.expectedColor,
          counterpartWayPresent: true,
          counterpartLineWeight: traffic.lineWeight,
          sharedCompositeWay: true,
        };
        selectedGeometry.traffic = {
          ...traffic,
          x: candidate.x,
          y: candidate.y,
          counterpartExpectedColor: slope.expectedColor,
          counterpartWayPresent: true,
          counterpartLineWeight: slope.lineWeight,
          sharedCompositeWay: true,
        };
        break;
      }

      // Some partial datasets genuinely have disjoint slope- and traffic-only
      // roads. Keep that honest fallback, but never accept an occluded shared
      // road that lacks the dual-stroke encoding above.
      const slopeCandidates = buildGeometryCandidates(features.slope, feature => {
        const counterpart = trafficByWay.get(feature.wayId);
        return !counterpart;
      });
      const trafficCandidates = buildGeometryCandidates(features.traffic, feature => {
        const counterpart = slopeByWay.get(feature.wayId);
        return !counterpart || !colorBoxesOverlap(feature.expectedColor, counterpart.expectedColor, 45);
      });
      if (!selectedGeometry.slope || !selectedGeometry.traffic) {
        pairSearch:
        for (const traffic of trafficCandidates) {
          for (const slope of slopeCandidates) {
            if (Math.hypot(traffic.x - slope.x, traffic.y - slope.y) < 90) continue;
            const counterpart = slopeByWay.get(traffic.wayId);
            selectedGeometry.traffic = {
              ...traffic,
              counterpartExpectedColor: counterpart && counterpart.expectedColor || null,
              counterpartWayPresent: Boolean(counterpart),
              counterpartLineWeight: counterpart && counterpart.lineWeight || 0,
              sharedCompositeWay: false,
            };
            selectedGeometry.slope = {
              ...slope,
              counterpartExpectedColor: null,
              counterpartWayPresent: false,
              counterpartLineWeight: 0,
              sharedCompositeWay: false,
            };
            break pairSearch;
          }
        }
      }
    } else {
      for (const kind of ['slope', 'traffic']) {
        if (!requiredLayers[kind] || !features[kind]) continue;
        selectedGeometry[kind] = buildGeometryCandidates(features[kind])[0] || null;
      }
    }

    for (const kind of ['slope', 'traffic']) {
      if (!requiredLayers[kind]) continue;
      const geometry = selectedGeometry[kind];
      if (!geometry) continue;
      const color = contextColors[kind];
      const ringRadius = contextRadii[kind];
      addRing('context', kind, geometry.x, geometry.y, ringRadius, color);
      contextWitnesses[kind] = {
        kind,
        x: geometry.x,
        y: geometry.y,
        radius: ringRadius,
        ringRadius,
        witnessColor: color,
        expectedColor: geometry.expectedColor,
        roadRadius: 7,
        wayId: geometry.wayId,
        counterpartExpectedColor: geometry.counterpartExpectedColor || null,
        counterpartWayPresent: Boolean(geometry.counterpartWayPresent),
        counterpartLineWeight: Number(geometry.counterpartLineWeight) || 0,
        lineWeight: Number(geometry.lineWeight) || 0,
        dashArray: String(geometry.dashArray || ''),
        sharedCompositeWay: Boolean(geometry.sharedCompositeWay),
        ownershipVerified: true,
        geometryVerified: true,
      };
    }

    return {
      sourceWidth: window.innerWidth,
      sourceHeight: window.innerHeight,
      accidentWitnesses,
      contextWitnesses,
    };
  }, {
    text: label,
    digest: stateSha256,
    requiredLayers: state.layers,
  });

  for (const kind of ['cluster', 'heatmap']) {
    if (state.layers[kind] && !(visualWitness.accidentWitnesses || {})[kind]) {
      throw new VideoExportSemanticError(
        `accident_${kind}_witness_missing`,
        `Could not bind a separate semantic evidence marker to the visible ${kind} accident layer`
      );
    }
  }
  for (const kind of ['slope', 'traffic']) {
    if (state.layers[kind] && !(visualWitness.contextWitnesses || {})[kind]) {
      throw new VideoExportSemanticError(
        `context_${kind}_witness_missing`,
        `Could not bind the ${kind} context witness to owned, visible road geometry`
      );
    }
  }

  const screenshot = await page.screenshot({ type: 'png' });
  const screenshotDigest = sha256Buffer(screenshot);
  return {
    label,
    stateSha256,
    screenshotSha256: screenshotDigest.hex,
    screenshotBytes: screenshot.length,
    ...visualWitness,
  };
}

function countPalettePixels(buffer, width, height, requiredState, frameEvidence) {
  const frameBytes = width * height * 4;
  if (!buffer.length || buffer.length % frameBytes !== 0) {
    throw new VideoExportSemanticError(
      'encoded_frame_decode_invalid',
      `Decoded frame buffer has invalid size ${buffer.length}`
    );
  }
  const frameCount = buffer.length / frameBytes;
  const marker = [[0, 191, 165]];
  const severityPalette = [[227, 26, 28], [255, 127, 0], [255, 255, 51], [153, 153, 153]];
  const clusterPalettes = {
    // MarkerCluster.Default.css outer/inner pairs. Requiring both members at
    // the witnessed DOM cluster prevents a single slope/traffic road color
    // from masquerading as an accident cluster.
    small:  { outer: [[181, 226, 140]], inner: [[110, 204, 57]] },
    medium: { outer: [[241, 211, 87]], inner: [[240, 194, 12]] },
    large:  { outer: [[253, 156, 115]], inner: [[241, 128, 23]] },
  };
  const heatmapPalette = [
    [0, 0, 255], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 0, 0],
  ];
  const closeTo = (r, g, b, palette, tolerance) => palette.some(([pr, pg, pb]) =>
    Math.abs(r - pr) <= tolerance && Math.abs(g - pg) <= tolerance && Math.abs(b - pb) <= tolerance
  );
  const parseRgb = value => {
    if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
      return value.map(Number);
    }
    const text = String(value || '').trim();
    const hex = text.match(/^#([a-f\d]{6})$/i);
    if (hex) return [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16));
    const rgb = text.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return rgb ? rgb.slice(1, 4).map(Number) : null;
  };
  const colorBoxesOverlap = (left, right, leftTolerance, rightTolerance) => Boolean(
    left && right && left.every((channel, index) =>
      Math.abs(channel - right[index]) <= leftTolerance + rightTolerance
    )
  );
  const CONTEXT_ROAD_TOLERANCE = 45;
  const WITNESS_TOLERANCE = 44;
  const sourceWidth = Number(frameEvidence && frameEvidence.sourceWidth);
  const sourceHeight = Number(frameEvidence && frameEvidence.sourceHeight);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) ||
      sourceWidth <= 0 || sourceHeight <= 0) {
    throw new VideoExportSemanticError(
      'encoded_layer_witness_missing',
      'Encoded-frame inspection requires browser witness dimensions'
    );
  }
  const accidentWitnesses = frameEvidence && frameEvidence.accidentWitnesses || {};
  const contextWitnesses = frameEvidence && frameEvidence.contextWitnesses || {};
  const validateWitness = (scope, kind, witness) => {
    if (!witness || !Number.isFinite(Number(witness.x)) || !Number.isFinite(Number(witness.y)) ||
        !Array.isArray(witness.witnessColor) || witness.witnessColor.length !== 3) {
      throw new VideoExportSemanticError(
        `encoded_${kind}_witness_missing`,
        `Encoded-frame inspection requires a separate ${scope} ${kind}-layer witness`
      );
    }
  };
  for (const kind of ['cluster', 'heatmap']) {
    if (requiredState.layers[kind]) validateWitness('accident', kind, accidentWitnesses[kind]);
  }
  for (const kind of ['slope', 'traffic']) {
    if (requiredState.layers[kind]) validateWitness('context', kind, contextWitnesses[kind]);
  }
  if (requiredState.layers.cluster &&
      !['cluster', 'severity'].includes(accidentWitnesses.cluster.kind)) {
    throw new VideoExportSemanticError(
      'encoded_cluster_witness_invalid',
      'Cluster witness is not bound to a cluster or an owned severity marker'
    );
  }
  if (requiredState.layers.heatmap && accidentWitnesses.heatmap.kind !== 'heatmap') {
    throw new VideoExportSemanticError(
      'encoded_heatmap_witness_invalid',
      'Heatmap witness is not bound to the owned heatmap canvas'
    );
  }

  const projectWitness = witness => ({
    witness,
    x: Number(witness.x) * width / sourceWidth,
    y: Number(witness.y) * height / sourceHeight,
    radiusX: Math.max(2, (Number(witness.ringRadius || witness.radius || 8) + 3) * width / sourceWidth),
    radiusY: Math.max(2, (Number(witness.ringRadius || witness.radius || 8) + 3) * height / sourceHeight),
  });
  const accidentRegions = Object.fromEntries(
    Object.entries(accidentWitnesses).map(([kind, witness]) => [kind, projectWitness(witness)])
  );
  const contextRegions = Object.fromEntries(
    Object.entries(contextWitnesses).map(([kind, witness]) => [kind, projectWitness(witness)])
  );
  const projectRoadWitness = witness => ({
    witness,
    x: Number(witness.x) * width / sourceWidth,
    y: Number(witness.y) * height / sourceHeight,
    radiusX: Math.max(1, Number(witness.roadRadius || 7) * width / sourceWidth),
    radiusY: Math.max(1, Number(witness.roadRadius || 7) * height / sourceHeight),
  });
  const contextRoadRegions = {};
  const contextExpectedColors = {};
  for (const kind of ['slope', 'traffic']) {
    if (!requiredState.layers[kind]) continue;
    const witness = contextWitnesses[kind];
    const expectedColor = parseRgb(witness.expectedColor);
    const witnessColor = parseRgb(witness.witnessColor);
    if (!expectedColor) {
      throw new VideoExportSemanticError(
        `encoded_${kind}_expected_color_missing`,
        `The owned ${kind} geometry witness has no exact road color`
      );
    }
    if (colorBoxesOverlap(
      expectedColor,
      witnessColor,
      CONTEXT_ROAD_TOLERANCE,
      WITNESS_TOLERANCE
    )) {
      throw new VideoExportSemanticError(
        `encoded_${kind}_witness_color_collision`,
        `The ${kind} helper-ring color overlaps its real road-pixel tolerance`
      );
    }
    contextExpectedColors[kind] = expectedColor;
    contextRoadRegions[kind] = projectRoadWitness(witness);
  }
  const atRegion = (x, y, region) => region &&
    Math.abs(x - region.x) <= region.radiusX && Math.abs(y - region.y) <= region.radiusY;

  let sharedCompositeContext = false;
  if (requiredState.layers.slope && requiredState.layers.traffic) {
    const slopeRoad = contextRoadRegions.slope;
    const trafficRoad = contextRoadRegions.traffic;
    const regionsOverlap = Math.abs(slopeRoad.x - trafficRoad.x) <=
        slopeRoad.radiusX + trafficRoad.radiusX &&
      Math.abs(slopeRoad.y - trafficRoad.y) <= slopeRoad.radiusY + trafficRoad.radiusY;
    const sameCompositeWay = Boolean(
      contextWitnesses.slope.sharedCompositeWay &&
      contextWitnesses.traffic.sharedCompositeWay &&
      contextWitnesses.slope.wayId &&
      contextWitnesses.slope.wayId === contextWitnesses.traffic.wayId
    );
    sharedCompositeContext = sameCompositeWay;
    if (sameCompositeWay) {
      if (!regionsOverlap) {
        throw new VideoExportSemanticError(
          'encoded_context_composite_regions_disjoint',
          'Dual-stroke slope and traffic witnesses must inspect the same road corridor'
        );
      }
      if (Number(contextWitnesses.slope.lineWeight) < Number(contextWitnesses.traffic.lineWeight) + 3) {
        throw new VideoExportSemanticError(
          'encoded_context_casing_invalid',
          'Slope casing must be at least three pixels wider than the traffic centreline'
        );
      }
      if (!String(contextWitnesses.traffic.dashArray || '')) {
        throw new VideoExportSemanticError(
          'encoded_context_dash_missing',
          'Traffic centreline must use a dash pattern in the combined context view'
        );
      }
      const underlyingSlopeColor = parseRgb(contextWitnesses.traffic.counterpartExpectedColor);
      if (!underlyingSlopeColor || colorBoxesOverlap(
        contextExpectedColors.traffic,
        underlyingSlopeColor,
        CONTEXT_ROAD_TOLERANCE,
        CONTEXT_ROAD_TOLERANCE
      )) {
        throw new VideoExportSemanticError(
          'encoded_traffic_witness_color_collision',
          'Traffic road color overlaps the underlying slope-layer color tolerance'
        );
      }
    } else {
      if (regionsOverlap) {
        throw new VideoExportSemanticError(
          'encoded_context_witness_regions_overlap',
          'Disjoint slope and traffic witnesses must use separate screen regions'
        );
      }
      if (contextWitnesses.slope.counterpartWayPresent) {
        throw new VideoExportSemanticError(
          'encoded_slope_witness_occluded',
          'A non-composite slope witness must not be covered by a traffic counterpart'
        );
      }
    }
  }

  let maxMarkerPixels = 0;
  const maxAccidentWitnessPixels = { cluster: 0, heatmap: 0 };
  const maxContextWitnessPixels = { slope: 0, traffic: 0 };
  const maxContextLayerPixels = { slope: 0, traffic: 0 };
  let maxCompositeContextPairPixels = 0;
  let maxClusterPairPixels = 0;
  let maxAccidentPixels = 0;
  let maxHeatmapPixels = 0;
  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * frameBytes;
    const end = start + frameBytes;
    let markerPixels = 0;
    const accidentWitnessPixels = { cluster: 0, heatmap: 0 };
    const contextWitnessPixels = { slope: 0, traffic: 0 };
    const contextLayerPixels = { slope: 0, traffic: 0 };
    const compositeContextLayerPixels = { slope: 0, traffic: 0 };
    let clusterOuterPixels = 0;
    let clusterInnerPixels = 0;
    let accidentPixels = 0;
    let heatmapPixels = 0;
    for (let index = start; index < end; index += 4) {
      const r = buffer[index], g = buffer[index + 1], b = buffer[index + 2];
      if (closeTo(r, g, b, marker, 38)) markerPixels += 1;
      const pixel = (index - start) / 4;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      for (const kind of ['cluster', 'heatmap']) {
        const region = accidentRegions[kind];
        if (!atRegion(x, y, region)) continue;
        const witness = region.witness;
        if (closeTo(r, g, b, [witness.witnessColor], 44)) {
          accidentWitnessPixels[kind] += 1;
        }
        if (kind === 'cluster' && witness.kind === 'cluster') {
          const pair = clusterPalettes[witness.clusterSize] || clusterPalettes.small;
          // CSS colors are alpha-composited over arbitrary map tiles before
          // lossy encoding. Identity comes from this owned, coordinate-bound
          // cluster witness; the broad tolerance only verifies its fill.
          if (closeTo(r, g, b, pair.outer, 75)) clusterOuterPixels += 1;
          if (closeTo(r, g, b, pair.inner, 75)) clusterInnerPixels += 1;
        }
        if (kind === 'cluster' && witness.kind === 'severity' &&
            closeTo(r, g, b, severityPalette, 34)) accidentPixels += 1;
        if (kind === 'heatmap') {
          const expectedHeatColor = Array.isArray(witness.expectedColor) &&
            witness.expectedColor.length === 3 ? [witness.expectedColor] : heatmapPalette;
          const heatTolerance = expectedHeatColor === heatmapPalette ? 38 : 65;
          if (closeTo(r, g, b, expectedHeatColor, heatTolerance)) heatmapPixels += 1;
        }
      }
      for (const kind of ['slope', 'traffic']) {
        const region = contextRegions[kind];
        if (atRegion(x, y, region) &&
            closeTo(r, g, b, [region.witness.witnessColor], WITNESS_TOLERANCE)) {
          contextWitnessPixels[kind] += 1;
        }
        if (atRegion(x, y, contextRoadRegions[kind]) &&
            closeTo(r, g, b, [contextExpectedColors[kind]], CONTEXT_ROAD_TOLERANCE)) {
          contextLayerPixels[kind] += 1;
        }
        // A combined slope/traffic export is only proven when both real
        // layer colours survive in one and the same decoded frame and in
        // the geometric intersection of both owned road-witness regions.
        // Independent maxima across frames would falsely accept an
        // animation that alternates between the two context layers.
        if (sharedCompositeContext &&
            atRegion(x, y, contextRoadRegions.slope) &&
            atRegion(x, y, contextRoadRegions.traffic) &&
            closeTo(r, g, b, [contextExpectedColors[kind]], CONTEXT_ROAD_TOLERANCE)) {
          compositeContextLayerPixels[kind] += 1;
        }
      }
    }
    maxMarkerPixels = Math.max(maxMarkerPixels, markerPixels);
    for (const kind of ['cluster', 'heatmap']) {
      maxAccidentWitnessPixels[kind] = Math.max(
        maxAccidentWitnessPixels[kind], accidentWitnessPixels[kind]
      );
    }
    for (const kind of ['slope', 'traffic']) {
      maxContextWitnessPixels[kind] = Math.max(
        maxContextWitnessPixels[kind], contextWitnessPixels[kind]
      );
      maxContextLayerPixels[kind] = Math.max(
        maxContextLayerPixels[kind], contextLayerPixels[kind]
      );
    }
    if (sharedCompositeContext) {
      maxCompositeContextPairPixels = Math.max(
        maxCompositeContextPairPixels,
        Math.min(compositeContextLayerPixels.slope, compositeContextLayerPixels.traffic)
      );
    }
    maxClusterPairPixels = Math.max(
      maxClusterPairPixels,
      Math.min(clusterOuterPixels, clusterInnerPixels)
    );
    if (accidentWitnesses.cluster && accidentWitnesses.cluster.kind === 'cluster') {
      accidentPixels = Math.min(clusterOuterPixels, clusterInnerPixels);
    }
    maxAccidentPixels = Math.max(maxAccidentPixels, accidentPixels);
    maxHeatmapPixels = Math.max(maxHeatmapPixels, heatmapPixels);
  }
  if (frameCount < 2 || maxMarkerPixels < 20) {
    throw new VideoExportSemanticError(
      'encoded_semantic_marker_missing',
      'Decoded final animation does not contain the semantic evidence marker',
      { frameCount, maxMarkerPixels }
    );
  }
  for (const kind of ['cluster', 'heatmap']) {
    if (requiredState.layers[kind] && maxAccidentWitnessPixels[kind] < 2) {
      throw new VideoExportSemanticError(
        `encoded_${kind}_witness_missing`,
        `Decoded final animation does not contain the separate ${kind} accident-layer witness at its recorded coordinates`,
        { frameCount, maxWitnessPixels: maxAccidentWitnessPixels[kind], witness: accidentWitnesses[kind] }
      );
    }
  }
  const clusterWitness = accidentWitnesses.cluster;
  if (requiredState.layers.cluster && clusterWitness.kind === 'cluster' && maxClusterPairPixels < 2) {
    throw new VideoExportSemanticError(
      'encoded_accident_pixels_missing',
      'Decoded final animation does not contain both colors of the witnessed accident cluster',
      { frameCount, maxClusterPairPixels, witness: clusterWitness }
    );
  }
  if (requiredState.layers.cluster && clusterWitness.kind === 'severity' && maxAccidentPixels < 2) {
    throw new VideoExportSemanticError(
      'encoded_accident_pixels_missing',
      'Decoded final animation does not contain the witnessed severity marker',
      { frameCount, maxAccidentPixels, witness: clusterWitness }
    );
  }
  if (requiredState.layers.heatmap && maxHeatmapPixels < 2) {
    throw new VideoExportSemanticError(
      'encoded_heatmap_pixels_missing',
      'Decoded final animation does not contain the witnessed heatmap pixels',
      { frameCount, maxHeatmapPixels }
    );
  }
  for (const kind of ['slope', 'traffic']) {
    if (requiredState.layers[kind] && maxContextWitnessPixels[kind] < 2) {
      throw new VideoExportSemanticError(
        `encoded_${kind}_witness_missing`,
        `Decoded final animation does not contain the owned ${kind} geometry witness`,
        { frameCount, maxWitnessPixels: maxContextWitnessPixels[kind], witness: contextWitnesses[kind] }
      );
    }
    if (requiredState.layers[kind] && maxContextLayerPixels[kind] < 2) {
      throw new VideoExportSemanticError(
        `encoded_${kind}_pixels_missing`,
        `Decoded final animation does not contain real ${kind} road pixels from the owned geometry layer`,
        { frameCount, maxLayerPixels: maxContextLayerPixels[kind], witness: contextWitnesses[kind] }
      );
    }
  }
  if (sharedCompositeContext && maxCompositeContextPairPixels < 2) {
    throw new VideoExportSemanticError(
      'encoded_context_composite_pixels_missing',
      'Decoded final animation does not contain both real context-layer colours in the same frame and road corridor',
      {
        frameCount,
        maxCompositeContextPairPixels,
        slopeWitness: contextWitnesses.slope,
        trafficWitness: contextWitnesses.traffic,
      }
    );
  }
  const requestedAccidentWitnessCounts = ['cluster', 'heatmap']
    .filter(kind => requiredState.layers[kind])
    .map(kind => maxAccidentWitnessPixels[kind]);
  const maxWitnessPixels = requestedAccidentWitnessCounts.length
    ? Math.min(...requestedAccidentWitnessCounts) : 0;
  // Response/evidence pixel fields now refer to the actual owned road layer;
  // helper-ring counts remain separate diagnostics.
  const maxSlopePixels = maxContextLayerPixels.slope;
  const maxTrafficPixels = maxContextLayerPixels.traffic;
  return {
    frameCount,
    width,
    height,
    maxMarkerPixels,
    maxWitnessPixels,
    maxClusterWitnessPixels: maxAccidentWitnessPixels.cluster,
    maxHeatmapWitnessPixels: maxAccidentWitnessPixels.heatmap,
    maxClusterPairPixels,
    maxAccidentPixels,
    maxHeatmapPixels,
    maxSlopePixels,
    maxTrafficPixels,
    maxCompositeContextPairPixels,
    maxSlopeWitnessPixels: maxContextWitnessPixels.slope,
    maxTrafficWitnessPixels: maxContextWitnessPixels.traffic,
  };
}

function buildEncodedInspectionArgs(outputPath) {
  return [
    '-v', 'error',
    '-i', outputPath,
    '-vf', `fps=${ENCODED_INSPECTION_FPS}`,
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    'pipe:1',
  ];
}

function buildWebpEncodingArgs(webmPath, outputPath) {
  return [
    '-y',
    '-i', webmPath,
    '-vf', ANIMATED_IMAGE_FILTER,
    '-loop', '0',
    '-c:v', 'libwebp_anim',
    '-lossless', '0',
    '-q:v', String(WEBP_QUALITY),
    '-compression_level', '6',
    '-an',
    '-f', 'webp',
    outputPath,
  ];
}

async function probeEncodedDimensions(outputPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'json',
    outputPath,
  ], {
    timeout: FFMPEG_TIMEOUT_MS,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(String(stdout || ''));
  } catch (error) {
    throw new VideoExportSemanticError(
      'encoded_frame_probe_invalid',
      `Could not parse encoded-frame dimensions: ${error.message}`
    );
  }
  const stream = parsed && Array.isArray(parsed.streams) ? parsed.streams[0] : null;
  const width = Number(stream && stream.width);
  const height = Number(stream && stream.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    throw new VideoExportSemanticError(
      'encoded_frame_probe_invalid',
      `Encoded animation has invalid dimensions ${width}x${height}`
    );
  }
  return { width, height };
}

async function inspectEncodedFrames(outputPath, requiredState, frameEvidence) {
  const { width, height } = await probeEncodedDimensions(outputPath);
  const { stdout } = await execFileAsync(
    'ffmpeg',
    buildEncodedInspectionArgs(outputPath),
    {
      timeout: FFMPEG_TIMEOUT_MS,
      encoding: 'buffer',
      maxBuffer: MAX_DECODE_BUFFER_BYTES,
    }
  );
  return countPalettePixels(Buffer.from(stdout), width, height, requiredState, frameEvidence);
}

async function clickAndWaitForDownload(page, selector, timeoutMs = 90000) {
  // Register the event waiter before clicking, then observe both branches as
  // one operation. If click() rejects, Promise.all has already installed a
  // rejection handler on the still-pending download waiter; the terminal
  // catches keep a later page-close/timeout rejection from becoming unhandled.
  const downloadPromise = Promise.resolve(page.waitForEvent('download', { timeout: timeoutMs }));
  const clickPromise = Promise.resolve().then(() => page.locator(selector).click());
  try {
    const [download] = await Promise.all([downloadPromise, clickPromise]);
    return download;
  } finally {
    void downloadPromise.catch(() => {});
    void clickPromise.catch(() => {});
  }
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

  // Contract validation is intentionally completed before temporary files or
  // Chromium are allocated.  The Express middleware performs the same check,
  // while this protects direct/library callers as well.
  const requiredState = expectedVideoState(params, params && params.city || 'Hannover');
  const targetCity = requiredState.city;
  const stateSha256 = sha256Canonical(requiredState);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-video-export-'));
  const videoDir = path.join(tmpDir, 'video');
  fs.mkdirSync(videoDir, { recursive: true });

  let browser = null;
  let webmPath = null;
  let outputPath = null;

  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
      ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    // ── 1. Werkbankzustand laden ────────────────────────────────────────────
    // Context filters and road layers use the application's own, tested URL
    // hydration contract. Other controls remain visible interactions below.
    await page.goto(buildVideoWorkbenchUrl(requiredState));
    await page.waitForLoadState('domcontentloaded');
    const buildEvidence = await readBuildEvidence(page);
    await waitForCities(page);
    await waitForTiles(page);
    await page.waitForTimeout(2000);

    // ── 2. Stadt auswählen ──────────────────────────────────────────────────
    await selectRequiredCity(page, targetCity);
    await waitForData(page);
    await waitForTiles(page);
    await page.waitForTimeout(2500);

    // ── 3. Unfallschwere setzen ─────────────────────────────────────────────
    if (requiredState.filters.severity !== 'all') {
      await page.locator('#severity').selectOption(requiredState.filters.severity);
      await waitForTiles(page);
      await page.waitForTimeout(800);
    }

    // ── 4. Beteiligungsfilter setzen ────────────────────────────────────────
    //    Defaults match werkbank_v2.html UI:
    //    Rad/Fuß/PKW are checked by default, Krad/Gkfz/Sonstig are unchecked.
    const bikeWanted   = requiredState.filters.involvement.cyclist;
    const pedWanted    = requiredState.filters.involvement.pedestrian;
    const carWanted    = requiredState.filters.involvement.car;
    const motoWanted   = requiredState.filters.involvement.motorcycle;
    const gkfzWanted   = requiredState.filters.involvement.gkfz;
    const sonWanted    = requiredState.filters.involvement.sonstig;

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
    const mode = requiredState.filters.involvementMode;
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
    const hourFrom = requiredState.filters.hourFrom;
    const hourTo = requiredState.filters.hourTo;
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
    if (requiredState.filters.dayType !== 'all') {
      await page.locator('#dayType').selectOption(requiredState.filters.dayType);
      await page.waitForTimeout(600);
    }

    // ── 8. Fahrbahnzustand setzen ───────────────────────────────────────────
    if (requiredState.filters.roadCondition !== 'all') {
      await page.locator('#roadCondition').selectOption(requiredState.filters.roadCondition);
      await page.waitForTimeout(600);
    }

    for (const [selector, wanted] of [
      ['#maxPoints', requiredState.filters.maxPoints],
      ['#viewportPaddingPct', requiredState.filters.viewportPaddingPct],
      ['#heatRadius', requiredState.filters.heatRadius],
    ]) {
      const control = page.locator(selector);
      const current = Number(await control.inputValue());
      if (current !== wanted) {
        await control.evaluate((input, nextValue) => {
          input.value = String(nextValue);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, wanted);
        await page.waitForTimeout(400);
      }
    }

    await waitForTiles(page);
    await page.waitForTimeout(1000);

    // ── 9. Darstellungsoptionen togglen ────────────────────────────────────
    const wantHeatmap  = requiredState.layers.heatmap;
    const wantCluster  = requiredState.layers.cluster;
    const wantHotspot  = requiredState.layers.onlyAboveAverage;

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
    if (requiredState.viewport) {
      await flyToAndWait(
        page,
        requiredState.viewport.center.lat,
        requiredState.viewport.center.lon,
        requiredState.viewport.zoom
      );
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

    // The URL-hydrated context state may finish lazy geometry work after the
    // accident layer. Wait for exact filters, controls, registry ownership and
    // non-empty attached road layers before accepting any frame evidence.
    await waitForRequestedContextState(page, requiredState);

    const analysisEvidence = await assertVideoAnalysisState(page, requiredState);
    const semanticFrame = await installSemanticEvidenceBadge(
      page,
      requiredState,
      stateSha256,
      analysisEvidence
    );
    // Hold the proven state long enough that even the 1-fps post-encode
    // inspection is guaranteed to sample it.
    await page.waitForTimeout(2200);

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
    const previewEvidence = await assertFreshExportContent(page, targetCity);
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
    const pdfDownload = await clickAndWaitForDownload(page, '#btnExportPDF', 90000);
    await page.waitForFunction(() => {
      const progress = document.querySelector('#exportProgress');
      const button = document.querySelector('#btnExportPDF');
      const text = String(progress && progress.textContent || '');
      if (/Fehler/i.test(text)) throw new Error(`PDF export failed: ${text}`);
      return /PDF erfolgreich erstellt\./.test(text) && button && !button.disabled;
    }, null, { timeout: 90000 });
    const pdfPath = await pdfDownload.path();
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      throw new VideoExportSemanticError(
        'pdf_download_missing',
        'The PDF export did not produce a downloadable file'
      );
    }
    const pdfBuffer = fs.readFileSync(pdfPath);
    if (pdfBuffer.length < 1024 || pdfBuffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new VideoExportSemanticError(
        'pdf_download_invalid',
        'The downloaded PDF is empty or has an invalid signature'
      );
    }
    const pdfEvidence = {
      bytes: pdfBuffer.length,
      sha256: crypto.createHash('sha256').update(pdfBuffer).digest('hex'),
      suggestedFilename: pdfDownload.suggestedFilename(),
      completed: true,
    };
    await page.waitForTimeout(1000);

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
    outputPath = path.join(
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
      await execFileAsync(
        'ffmpeg',
        buildWebpEncodingArgs(webmPath, outputPath),
        { timeout: FFMPEG_TIMEOUT_MS }
      );
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

    const encodedFrames = await inspectEncodedFrames(outputPath, requiredState, semanticFrame);
    const artifactBuffer = fs.readFileSync(outputPath);
    const artifactDigest = sha256Buffer(artifactBuffer);
    const evidenceCore = {
      schemaVersion: 1,
      state: { canonical: requiredState, sha256: stateSha256 },
      ...buildEvidence,
      artifact: {
        format,
        contentType: formatMeta.contentType,
        bytes: artifactBuffer.length,
        sha256: artifactDigest.hex,
        sha256Base64: artifactDigest.base64,
      },
      semantic: {
        lifecycle: analysisEvidence.lifecycle,
        frameBeforeEncoding: semanticFrame,
        framesAfterEncoding: encodedFrames,
        preview: previewEvidence,
        pdf: pdfEvidence,
      },
    };
    const evidence = { ...evidenceCore, sha256: sha256Canonical(evidenceCore) };

    // Gesamtes tmpDir (enthält video/ + palette.png + .webm) aufräumen
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }

    return {
      path: outputPath,
      format,
      contentType: formatMeta.contentType,
      extension: formatMeta.extension,
      evidence,
    };

  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore */ }
    }
    // tmpDir aufräumen
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    if (outputPath) {
      try { fs.unlinkSync(outputPath); } catch (_) { /* ignore */ }
    }
    throw err;
  }
}

module.exports = {
  ANIMATED_IMAGE_FILTER,
  VideoExportSemanticError,
  buildEncodedInspectionArgs,
  buildWebpEncodingArgs,
  assertFreshExportContent,
  assertRuntimeContextAvailable,
  assertVideoAnalysisState,
  buildVideoWorkbenchUrl,
  clickAndWaitForDownload,
  countPalettePixels,
  expectedVideoState,
  exportVideo,
  inspectEncodedFrames,
  installSemanticEvidenceBadge,
  probeEncodedDimensions,
  readBuildEvidence,
  selectRequiredCity,
  waitForFreshExportPreview,
  waitForRequestedContextState,
  waitForTiles,
};
