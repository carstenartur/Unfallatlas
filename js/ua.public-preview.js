(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const PROFILE_ID = 'public-preview-core-v1';
  const DISABLED_CAPABILITIES = Object.freeze([
    'interactive-rectangle-drawing',
    'heatmap',
    'word-export',
    'pdf-export',
    'video-export'
  ]);

  UA.PUBLIC_DISTRIBUTION_PROFILE = Object.freeze({
    id: PROFILE_ID,
    completeVendorInventory: true,
    disabledCapabilities: DISABLED_CAPABILITIES
  });
  document.documentElement.dataset.distributionProfile = PROFILE_ID;
  if (!document.querySelector(`meta[name="unfallwerkbank:distribution-profile"][content="${PROFILE_ID}"]`)) {
    const meta = document.createElement('meta');
    meta.name = 'unfallwerkbank:distribution-profile';
    meta.content = PROFILE_ID;
    document.head.appendChild(meta);
  }

  const L = window.L;
  if (L) {
    // Compatibility stubs for libraries deliberately omitted from the static preview.
    L.Draw = L.Draw || {};
    L.Draw.Event = L.Draw.Event || {};
    L.Draw.Event.CREATED = L.Draw.Event.CREATED || 'draw:created';
    if (!L.Control.Draw && L.Control && typeof L.Control.extend === 'function') {
      L.Control.Draw = L.Control.extend({
        initialize() {
          this._toolbars = { draw: { _modes: { rectangle: { handler: { enable() {} } } } } };
        },
        onAdd() {
          const container = L.DomUtil.create('div', 'ua-public-preview-draw-disabled');
          container.hidden = true;
          container.setAttribute('aria-hidden', 'true');
          return container;
        }
      });
    }
    if (typeof L.heatLayer !== 'function') {
      L.heatLayer = function publicPreviewHeatLayer() {
        const layer = L.layerGroup();
        layer._uaPublicPreviewDisabled = true;
        return layer;
      };
    }
  }

  function hideElement(element) {
    if (!element) return;
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
  }

  function disableButton(button, explanation) {
    if (!button) return;
    button.disabled = true;
    button.setAttribute('aria-disabled', 'true');
    button.title = explanation;
  }

  function installProfileNotice() {
    const panelBody = document.getElementById('panelBody');
    if (!panelBody || document.getElementById('publicPreviewNotice')) return;
    const notice = document.createElement('div');
    notice.id = 'publicPreviewNotice';
    notice.setAttribute('role', 'note');
    notice.dataset.distributionProfile = PROFILE_ID;
    notice.style.cssText = [
      'margin:0 0 10px',
      'padding:9px 10px',
      'background:rgba(23,96,125,.10)',
      'border-left:3px solid #17607d',
      'border-radius:6px',
      'font-size:12px',
      'line-height:1.45'
    ].join(';');
    notice.innerHTML =
      '<strong>Öffentliche Kernvorschau:</strong> Kartenanalyse, Filter, Cluster, ' +
      'Kontextlayer und Datenexport sind verfügbar. Video benötigt ein Server-Backend. ' +
      'Heatmap und freie Rechteckzeichnung sind in diesem statischen Profil nicht enthalten. ' +
      'Word/PDF sind hier deaktiviert, weil die zugehörigen Browser-Bundles nicht mit ' +
      'ausgeliefert werden; eine bekannte Lizenzsperre besteht dafür nicht.';
    panelBody.prepend(notice);
  }

  function applyPublicUi(ctx) {
    if (!ctx || !ctx.ui) return false;
    ctx.showHeatmap = false;
    const heatToggle = ctx.ui.btnHeat || document.getElementById('toggleHeat');
    if (typeof UA.setBtnState === 'function') UA.setBtnState(heatToggle, false);
    if (typeof UA.syncLegendButtons === 'function') UA.syncLegendButtons(ctx);

    const explanation = 'In diesem reduzierten statischen Deployment nicht mit ausgeliefert.';
    disableButton(heatToggle, explanation);
    hideElement(heatToggle);
    disableButton(ctx.ui.btnDraw, explanation);
    hideElement(ctx.ui.btnDraw);

    const legendHeat = document.querySelector('.layer-legend-control button[data-layer="heatmap"]');
    disableButton(legendHeat, explanation);
    hideElement(legendHeat);

    const heatRadius = document.getElementById('heatRadius');
    if (heatRadius && heatRadius.closest('.row')) hideElement(heatRadius.closest('.row'));
    const heatExport = document.getElementById('heatExportOpacity');
    if (heatExport && heatExport.parentElement) hideElement(heatExport.parentElement);
    const includeHeatmap = document.getElementById('cbIncludeHeatmap');
    if (includeHeatmap) {
      includeHeatmap.checked = false;
      includeHeatmap.disabled = true;
      if (includeHeatmap.closest('label')) hideElement(includeHeatmap.closest('label'));
    }

    hideElement(document.getElementById('exportGroupAntrag'));
    for (const id of ['btnExportWord', 'btnExportPDF']) {
      disableButton(document.getElementById(id), explanation);
    }
    hideElement(document.getElementById('videoExportContainer'));

    const quickStart = document.getElementById('quickStartHint');
    if (quickStart) {
      quickStart.innerHTML =
        '<strong>Analyse in 3 Schritten:</strong> ' +
        '<span style="white-space:nowrap;">1. Stadt wählen</span> → ' +
        '<span style="white-space:nowrap;">2. Kartenausschnitt prüfen</span> → ' +
        '<span style="white-space:nowrap;">3. Ergebnis oder Daten exportieren</span>';
    }
    const noSelectionHint = document.getElementById('noSelectionHint');
    if (noSelectionHint) {
      noSelectionHint.innerHTML =
        'ℹ️ <strong>Kein Bereich über einen geteilten Link vorgegeben.</strong> ' +
        'Die Auswertung verwendet den aktuellen Kartenausschnitt.';
    }
    if (ctx.ui.exportMapModeHintEl) {
      ctx.ui.exportMapModeHintEl.textContent =
        'Der Kartenmodus gilt für Vorschau und Datenexporte. Video benötigt ein Server-Backend; Word/PDF sind in diesem statischen Profil deaktiviert.';
    }
    installProfileNotice();
    document.documentElement.dataset.distributionProfile = PROFILE_ID;
    return true;
  }

  function installHooks() {
    if (!UA.__publicPreviewInitLeafletWrapped && typeof UA.initLeaflet === 'function') {
      const originalInitLeaflet = UA.initLeaflet;
      UA.initLeaflet = function initLeafletForPublicPreview(ctx) {
        ctx.showHeatmap = false;
        return originalInitLeaflet(ctx);
      };
      UA.__publicPreviewInitLeafletWrapped = true;
    }

    if (!UA.__publicPreviewBindUiWrapped && typeof UA.bindUi === 'function') {
      const originalBindUi = UA.bindUi;
      UA.bindUi = function bindUiForPublicPreview(ctx) {
        const result = originalBindUi(ctx);
        applyPublicUi(ctx);
        return result;
      };
      UA.__publicPreviewBindUiWrapped = true;
    }

    UA.ensureExportLibraries = async function unavailablePublicPreviewExportLibraries() {
      throw new Error('Word/PDF sind in diesem statischen Profil deaktiviert; eine bekannte Lizenzsperre besteht nicht.');
    };

    const current = typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null;
    const uiApplied = current && current.ui ? applyPublicUi(current) : false;
    return Boolean(UA.__publicPreviewBindUiWrapped && uiApplied);
  }

  // ua.app_v2.js starts immediately while the document is still loading. Its
  // first asynchronous city-list fetch gives this short poll a deterministic
  // window to wrap bindUi before bindUi is called. The same code also remains
  // correct when the validated Pages profile loads this file directly before
  // the app module.
  installHooks();
  const hookDeadline = Date.now() + 30000;
  const hookTimer = window.setInterval(() => {
    if (installHooks() || Date.now() >= hookDeadline) window.clearInterval(hookTimer);
  }, 25);
  document.addEventListener('DOMContentLoaded', () => {
    installHooks();
    window.setTimeout(installHooks, 0);
  }, { once: true });
})();
