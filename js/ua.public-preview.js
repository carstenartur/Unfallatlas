(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const PROFILE_ID = 'public-preview-core-v1';
  const DISABLED_CAPABILITIES = Object.freeze(['video-export']);

  UA.PUBLIC_DISTRIBUTION_PROFILE = Object.freeze({
    id: PROFILE_ID,
    label: 'Öffentliche Browser-Version',
    completeVendorInventory: false,
    complianceMode: 'declared-known-provenance-gaps',
    knownLicenseRestrictions: Object.freeze([]),
    provenanceGapsBlockCapabilities: false,
    disabledCapabilities: DISABLED_CAPABILITIES,
  });
  document.documentElement.dataset.distributionProfile = PROFILE_ID;
  if (!document.querySelector(`meta[name="unfallwerkbank:distribution-profile"][content="${PROFILE_ID}"]`)) {
    const meta = document.createElement('meta');
    meta.name = 'unfallwerkbank:distribution-profile';
    meta.content = PROFILE_ID;
    document.head.appendChild(meta);
  }

  function hideElement(element) {
    if (!element) return;
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
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
      'line-height:1.45',
    ].join(';');
    notice.innerHTML =
      '<strong>Öffentliche Browser-Version:</strong> Kartenanalyse, Filter, Cluster, ' +
      'Heatmap, freie Rechteckauswahl sowie CSV-, GeoJSON-, KML-, Word- und PDF-Export ' +
      'sind verfügbar. Nur der Videoexport ist hier deaktiviert, weil GitHub Pages kein ' +
      'Server-Backend bereitstellt. Bekannte Lücken der reproduzierbaren Build-Provenienz ' +
      'werden im Drittanbieter-Inventar dokumentiert; eine bekannte Lizenzbeschränkung ' +
      'für diese Browserfunktionen besteht nicht.';
    panelBody.prepend(notice);
  }

  function applyPublicUi(ctx) {
    hideElement(document.getElementById('videoExportContainer'));
    installProfileNotice();
    document.documentElement.dataset.distributionProfile = PROFILE_ID;

    if (ctx && ctx.ui && ctx.ui.exportMapModeHintEl) {
      ctx.ui.exportMapModeHintEl.textContent =
        'Der Kartenmodus gilt für Vorschau, Word/PDF und Datenexporte. ' +
        'Der Videoexport benötigt ein Server-Backend und ist auf GitHub Pages nicht verfügbar.';
    }
  }

  const originalBindUi = UA.bindUi;
  if (typeof originalBindUi === 'function') {
    UA.bindUi = function bindUiForPublicBrowserVersion(ctx) {
      const result = originalBindUi(ctx);
      applyPublicUi(ctx);
      return result;
    };
  }

  UA.applyPublicDistributionProfile = applyPublicUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyPublicUi(UA.getRuntimeContext?.()), { once: true });
  } else {
    applyPublicUi(UA.getRuntimeContext?.());
  }
})();
