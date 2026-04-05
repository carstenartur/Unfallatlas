/**
 * Video-Export – Frontend-Modul
 *
 * Prüft beim Laden, ob das Backend-API (`/api/video-export-available`)
 * erreichbar ist. Wenn ja: „🎬 Als Video exportieren"-Button einblenden.
 *
 * Beim Klick werden die aktuellen URL-Parameter gesammelt, an das Backend
 * gesendet und das erzeugte GIF automatisch heruntergeladen.
 *
 * Graceful degradation: Wenn kein Backend vorhanden ist (z. B. bei der
 * GitHub-Pages-Distribution), passiert nichts – kein Button, keine Fehler.
 */
(() => {
  'use strict';

  /**
   * Aktuellen Zustand der Werkbank als Parameter-Objekt auslesen.
   * Versucht zuerst window.UA.getParams(), dann window.UA.ctx, dann
   * fällt es auf window.location.search zurück.
   */
  function collectParams() {
    // Bevorzugt: UA.ctx falls vom App-Code befüllt
    if (window.UA && window.UA.ctx) {
      const ctx = window.UA.ctx;
      return {
        city:                 ctx.city             || '',
        severity:             ctx.severity         || 'all',
        includeCyclist:       ctx.includeCyclist    != null ? String(+ctx.includeCyclist)    : '1',
        includePedestrian:    ctx.includePedestrian != null ? String(+ctx.includePedestrian) : '1',
        includeCar:           ctx.includeCar        != null ? String(+ctx.includeCar)        : '1',
        includeMotorcycle:    ctx.includeMotorcycle != null ? String(+ctx.includeMotorcycle) : '1',
        involvementMode:      ctx.involvementMode  || 'or',
        hourFrom:             ctx.hourFrom          != null ? String(ctx.hourFrom) : '0',
        hourTo:               ctx.hourTo            != null ? String(ctx.hourTo)   : '23',
        dayType:              ctx.dayType           || 'all',
        roadCondition:        ctx.roadCondition     || 'all',
        showCluster:          ctx.showCluster       != null ? String(+ctx.showCluster)          : '1',
        showHeatmap:          ctx.showHeatmap       != null ? String(+ctx.showHeatmap)          : '0',
        showOnlyAboveAverage: ctx.showOnlyAboveAverage != null ? String(+ctx.showOnlyAboveAverage) : '0',
        centerLat:            ctx.centerLat         != null ? String(ctx.centerLat) : '',
        centerLon:            ctx.centerLon         != null ? String(ctx.centerLon) : '',
        zoom:                 ctx.zoom              != null ? String(ctx.zoom)      : '',
        selSouth:             ctx.selSouth          != null ? String(ctx.selSouth)  : '',
        selWest:              ctx.selWest           != null ? String(ctx.selWest)   : '',
        selNorth:             ctx.selNorth          != null ? String(ctx.selNorth)  : '',
        selEast:              ctx.selEast           != null ? String(ctx.selEast)   : '',
        maxPoints:            ctx.maxPoints         != null ? String(ctx.maxPoints) : '',
        viewportPaddingPct:   ctx.viewportPaddingPct != null ? String(ctx.viewportPaddingPct) : '',
        heatRadius:           ctx.heatRadius        != null ? String(ctx.heatRadius) : ''
      };
    }

    // Fallback: URL-Parameter auslesen
    const sp = new URLSearchParams(window.location.search);
    const p = {};
    for (const [k, v] of sp.entries()) {
      p[k] = v;
    }
    return p;
  }

  /** Blendet den Video-Export-Button ein */
  function showVideoExportButton() {
    const container = document.getElementById('videoExportContainer');
    if (!container) return;
    container.style.display = '';

    const btn = document.getElementById('btnExportVideo');
    if (!btn) return;

    btn.addEventListener('click', async () => {
      const params = collectParams();
      const progressEl = document.getElementById('videoExportProgress');

      btn.disabled = true;
      if (progressEl) {
        progressEl.textContent = '🎬 Video wird erzeugt… (kann 1–2 Minuten dauern)';
        progressEl.style.display = '';
      }

      try {
        const response = await fetch('/api/export-video', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params)
        });

        if (!response.ok) {
          let msg = `Fehler ${response.status}`;
          try {
            const data = await response.json();
            if (data && data.error) msg = data.error;
          } catch (_) { /* ignore */ }
          throw new Error(msg);
        }

        // GIF als Blob empfangen und Download auslösen
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'unfallatlas-analyse.gif';
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
    try {
      const res = await fetch('/api/video-export-available', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        // Kurzes Timeout – bei GitHub Pages antwortet kein Backend
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

  // Nach DOM-Bereitschaft initialisieren
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
