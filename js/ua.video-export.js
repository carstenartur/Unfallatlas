/**
 * Video-Export – Frontend-Modul
 *
 * Prüft beim Laden, ob das Backend-API (`/api/video-export-available`)
 * erreichbar ist. Wenn ja: „🎬 Als Video exportieren"-Button einblenden.
 *
 * Beim Klick werden die aktuellen URL-Parameter gesammelt, an das Backend
 * gesendet und das erzeugte GIF automatisch heruntergeladen.
 *
 * Graceful degradation: Wenn kein Backend vorhanden ist (z. B. bei einer
 * statischen Distribution), passiert nichts – kein Button, kein Probe-404.
 */
(() => {
  'use strict';
  const VIDEO_EXPORT_FORMAT_KEY = 'ua:videoExportFormat';
  const DEFAULT_VIDEO_EXPORT_FORMAT = 'webp';
  const SUPPORTED_VIDEO_EXPORT_FORMATS = new Set(['gif', 'webp', 'apng']);
  const VIDEO_EXPORT_CAPABILITY = 'video-export';

  function readPreferredFormat() {
    try {
      const stored = localStorage.getItem(VIDEO_EXPORT_FORMAT_KEY);
      if (stored && SUPPORTED_VIDEO_EXPORT_FORMATS.has(stored)) return stored;
    } catch (_) { /* ignore storage issues */ }
    return DEFAULT_VIDEO_EXPORT_FORMAT;
  }

  function applyPreferredFormatSelection() {
    const selected = readPreferredFormat();
    const radios = document.querySelectorAll('input[name="videoExportFormat"]');
    if (!radios.length) return selected;
    let found = false;
    radios.forEach((radio) => {
      const checked = radio.value === selected;
      radio.checked = checked;
      if (checked) found = true;
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        try { localStorage.setItem(VIDEO_EXPORT_FORMAT_KEY, radio.value); } catch (_) { /* ignore */ }
      });
    });
    if (!found) {
      const first = radios[0];
      first.checked = true;
      try { localStorage.setItem(VIDEO_EXPORT_FORMAT_KEY, first.value); } catch (_) { /* ignore */ }
      return first.value;
    }
    return selected;
  }

  function currentSelectedFormat() {
    const checked = document.querySelector('input[name="videoExportFormat"]:checked');
    const candidate = checked ? checked.value : readPreferredFormat();
    return SUPPORTED_VIDEO_EXPORT_FORMATS.has(candidate) ? candidate : DEFAULT_VIDEO_EXPORT_FORMAT;
  }

  function checked(id, fallback) {
    const element = document.getElementById(id);
    return element ? Boolean(element.checked) : fallback;
  }

  function value(id, fallback) {
    const element = document.getElementById(id);
    return element && element.value !== '' ? element.value : fallback;
  }

  function active(id, fallback) {
    const element = document.getElementById(id);
    if (!element) return fallback;
    return element.classList.contains('active') || element.getAttribute('aria-pressed') === 'true';
  }

  function backendProbeDisabled() {
    const profile = window.UA && window.UA.PUBLIC_DISTRIBUTION_PROFILE;
    return Boolean(
      profile &&
      Array.isArray(profile.disabledCapabilities) &&
      profile.disabledCapabilities.includes(VIDEO_EXPORT_CAPABILITY)
    );
  }

  /**
   * Read the state that is actually visible/active in the workbench.  The
   * nested shape is validated by the exact same contract module that the
   * server uses before it allocates a browser.
   */
  function collectState() {
    const UA = window.UA || {};
    const contract = UA.videoExportContract;
    if (!contract || typeof contract.normalizeState !== 'function') {
      throw new Error('Video-Export-Vertrag ist nicht geladen.');
    }
    if (typeof UA.getRuntimeContext !== 'function') {
      throw new Error('Werkbank-Laufzeitkontext ist nicht verfügbar.');
    }
    const ctx = UA.getRuntimeContext();
    if (!ctx || typeof ctx !== 'object') {
      throw new Error('Werkbank-Laufzeitkontext ist ungültig.');
    }
    const map = ctx.map || window._uaMap;
    const center = map && typeof map.getCenter === 'function' ? map.getCenter() : null;
    const selectionBounds = ctx.selectionBounds || null;
    const contextFilters = ctx.contextFilters || {};
    const overlayState = ctx.contextOverlays && ctx.contextOverlays.active || {};

    let viewport = null;
    if (center && Number.isFinite(Number(center.lat)) && Number.isFinite(Number(center.lng)) &&
        map && typeof map.getZoom === 'function') {
      viewport = {
        center: { lat: Number(center.lat), lon: Number(center.lng) },
        zoom: Number(map.getZoom()),
      };
    }

    let selection = null;
    if (selectionBounds && typeof selectionBounds.getSouth === 'function') {
      selection = {
        south: Number(selectionBounds.getSouth()),
        west: Number(selectionBounds.getWest()),
        north: Number(selectionBounds.getNorth()),
        east: Number(selectionBounds.getEast()),
      };
    }

    const slopeChips = document.querySelectorAll('input[data-ctx-slope]');
    const trafficChips = document.querySelectorAll('input[data-ctx-traffic]');
    const slopeClasses = slopeChips.length
      ? Array.from(slopeChips).filter(el => el.checked).map(el => el.dataset.ctxSlope)
      : Array.from(contextFilters.slopeClasses || []);
    const trafficClasses = trafficChips.length
      ? Array.from(trafficChips).filter(el => el.checked).map(el => el.dataset.ctxTraffic)
      : Array.from(contextFilters.trafficClasses || []);

    return contract.normalizeState({
      schemaVersion: contract.SCHEMA_VERSION,
      city: document.getElementById('citySel')
        ? value('citySel', 'Hannover')
        : (ctx.CITY_RAW || 'Hannover'),
      filters: {
        severity: value('severity', 'all'),
        involvementMode: active('modeAnd', false)
          ? 'and'
          : (active('modeSolo', false) ? 'solo' : (active('modeOr', false) ? 'or' : (ctx.involvementMode || 'or'))),
        hourFrom: value('hFrom', 0),
        hourTo: value('hTo', 23),
        dayType: value('dayType', 'all'),
        roadCondition: value('roadCondition', 'all'),
        maxPoints: value('maxPoints', 100000),
        viewportPaddingPct: value('viewportPaddingPct', 20),
        heatRadius: value('heatRadius', 25),
        involvement: {
          cyclist: checked('incBike', true),
          pedestrian: checked('incPed', true),
          car: checked('incCar', true),
          motorcycle: checked('incMoto', false),
          gkfz: checked('incGkfz', false),
          sonstig: checked('incSon', false),
        },
      },
      context: {
        slopeClasses,
        trafficClasses,
        onlyMatchedWays: document.getElementById('ctxOnlyMatched')
          ? checked('ctxOnlyMatched', false)
          : Boolean(contextFilters.onlyMatchedWays),
      },
      layers: {
        cluster: active('toggleCluster', ctx.showCluster != null ? Boolean(ctx.showCluster) : true),
        heatmap: active('toggleHeat', ctx.showHeatmap != null ? Boolean(ctx.showHeatmap) : false),
        onlyAboveAverage: active(
          'toggleOnlyHot',
          ctx.showOnlyAboveAverage != null ? Boolean(ctx.showOnlyAboveAverage) : false
        ),
        slope: document.querySelector('input[data-context-overlay="slope"]')
          ? checked('ctxOverlay_slope', false)
          : Boolean(overlayState.slope),
        traffic: document.querySelector('input[data-context-overlay="traffic"]')
          ? checked('ctxOverlay_traffic', false)
          : Boolean(overlayState.traffic),
      },
      viewport,
      selection,
    });
  }

  /** Blendet den Video-Export-Button ein */
  function showVideoExportButton() {
    const container = document.getElementById('videoExportContainer');
    if (!container) return;
    container.style.display = '';
    applyPreferredFormatSelection();

    const btn = document.getElementById('btnExportVideo');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const progressEl = document.getElementById('videoExportProgress');

      btn.disabled = true;
      if (progressEl) {
        progressEl.textContent = '🎬 Video wird erzeugt… (kann 1–2 Minuten dauern)';
        progressEl.style.display = '';
      }

      try {
        const state = collectState();
        const format = currentSelectedFormat();
        const response = await fetch('/api/export-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format, state })
        });

        if (!response.ok) {
          let msg = `Fehler ${response.status}`;
          try {
            const data = await response.json();
            if (data && data.message) msg = data.message;
            else if (data && data.error) msg = data.error;
          } catch (_) { /* ignore */ }
          throw new Error(msg);
        }

        // Datei als Blob empfangen und Download auslösen
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `unfallatlas-analyse.${format}`;
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }, 1000);

        if (progressEl) {
          progressEl.textContent = '✅ Video erfolgreich heruntergeladen!';
          setTimeout(() => { progressEl.style.display = 'none'; }, 4000);
        }
      } catch (err) {
        if (progressEl) {
          progressEl.textContent = `❌ Fehler: ${err.message}`;
        } else {
          alert(`Video-Export fehlgeschlagen: ${err.message}`);
        }
      } finally {
        btn.disabled = false;
      }
    });
  }

  /** Initialisierung: Backend-Verfügbarkeit prüfen */
  async function init() {
    // A distribution profile is authoritative about unavailable capabilities.
    // Static Pages must not generate a predictable 404 merely to discover that
    // the server-only video endpoint is absent.
    if (backendProbeDisabled()) return;
    try {
      const res = await fetch('/api/video-export-available', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data && data.available) {
        showVideoExportButton();
      }
    } catch (_) {
      // Kein Backend → kein Button → keine Fehlermeldung
    }
  }

  // Small test/debug surface: callers can inspect the exact canonical payload
  // and capability decision without duplicating client logic.
  window.UA = window.UA || {};
  window.UA.videoExportClient = Object.freeze({ collectState, backendProbeDisabled, init });

  // Nach DOM-Bereitschaft initialisieren
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
