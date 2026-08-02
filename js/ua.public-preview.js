(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const PROFILE_ID = 'public-preview-core-v1';
  const DISABLED_CAPABILITIES = Object.freeze(['video-export']);
  const DEFAULT_CITY_LIST_WARNING_MS = 1500;

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

  function activeCityFromUrl() {
    const raw = new URLSearchParams(window.location.search).get('city');
    const city = String(raw || 'Hannover').trim();
    return city || 'Hannover';
  }

  function primeCityDropdown() {
    const select = document.getElementById('citySel');
    if (!select) return;

    const city = activeCityFromUrl();
    select.replaceChildren();

    const active = document.createElement('option');
    active.value = city;
    active.textContent = city;
    active.selected = true;
    select.appendChild(active);

    const pending = document.createElement('option');
    pending.value = '';
    pending.disabled = true;
    pending.textContent = 'Weitere Städte werden geladen …';
    select.appendChild(pending);

    select.setAttribute('aria-busy', 'true');
    select.setAttribute('aria-label', `${city} ausgewählt – weitere Städte werden geladen`);
  }

  function hideElement(element) {
    if (!element) return;
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
  }

  function installProfileNotice() {
    const panelBody = document.getElementById('panelBody');
    if (!panelBody || document.getElementById('publicPreviewNotice')) return;

    const notice = document.createElement('details');
    notice.id = 'publicPreviewNotice';
    notice.dataset.distributionProfile = PROFILE_ID;
    notice.style.cssText = [
      'margin:0 0 8px',
      'padding:5px 8px',
      'background:rgba(23,96,125,.08)',
      'border-left:3px solid #17607d',
      'border-radius:6px',
      'font-size:11px',
      'line-height:1.35',
    ].join(';');
    notice.innerHTML =
      '<summary style="cursor:pointer;font-weight:700">Öffentliche Browser-Version · nur Videoexport nicht verfügbar</summary>' +
      '<p style="margin:6px 0 2px">Karte, Filter, Bereichsauswahl sowie CSV-, GeoJSON-, KML-, Word- und PDF-Export sind verfügbar. ' +
      'Der Videoexport benötigt ein Server-Backend. Nach aktuellem Stand gilt: eine bekannte Lizenzbeschränkung für diese Browserfunktionen besteht nicht. ' +
      'Technische Provenienz-Härtung wird transparent in ' +
      '<a href="https://github.com/carstenartur/Unfallatlas/issues/406" target="_blank" rel="noopener">Issue #406</a> dokumentiert.</p>';
    panelBody.prepend(notice);
  }

  function preferVisibleSelection(ctx) {
    const map = ctx && ctx.map;
    const bounds = ctx && ctx.selectionBounds;
    if (!map || !bounds || typeof map.getCenter !== 'function' || typeof map.fitBounds !== 'function') return;

    const center = map.getCenter();
    if (typeof bounds.contains === 'function' && bounds.contains(center)) return;

    map.fitBounds(bounds, {
      padding: [24, 24],
      maxZoom: 18,
      animate: false,
    });
    ctx.urlConsistencyRepair = 'selection-preferred-over-conflicting-center';
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

  const originalLoadCitiesList = UA.loadCitiesList;
  if (typeof originalLoadCitiesList === 'function') {
    UA.loadCitiesList = function loadCitiesListInBackground(ctx) {
      const configured = Number(UA.PUBLIC_CITY_LIST_WARNING_MS);
      const warningMs = Number.isFinite(configured) && configured >= 0
        ? configured
        : DEFAULT_CITY_LIST_WARNING_MS;
      let settled = false;

      const warningId = window.setTimeout(() => {
        if (!settled) {
          console.warn(`Städte-Liste lädt länger als ${warningMs} ms; aktive Stadt bleibt nutzbar.`);
        }
      }, warningMs);

      Promise.resolve()
        .then(() => originalLoadCitiesList(ctx))
        .then((cities) => {
          settled = true;
          window.clearTimeout(warningId);
          if (!ctx || !ctx.ui || !Array.isArray(cities) || cities.length === 0) return;
          // Schedule after the app's immediate fallback dropdown commit so a
          // fast cities.txt response cannot be overwritten by that fallback.
          window.setTimeout(() => UA.setCityDropdown(ctx, cities), 0);
        })
        .catch((error) => {
          settled = true;
          window.clearTimeout(warningId);
          console.warn('Städte-Liste konnte nicht im Hintergrund übernommen werden:', error);
        });

      return Promise.resolve([ctx.CITY_RAW]);
    };
  }

  const originalBindUi = UA.bindUi;
  if (typeof originalBindUi === 'function') {
    UA.bindUi = function bindUiForPublicBrowserVersion(ctx) {
      const result = originalBindUi(ctx);
      preferVisibleSelection(ctx);
      applyPublicUi(ctx);
      return result;
    };
  }

  UA.applyPublicDistributionProfile = applyPublicUi;
  UA.preferVisibleSelection = preferVisibleSelection;

  primeCityDropdown();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyPublicUi(UA.getRuntimeContext?.()), { once: true });
  } else {
    applyPublicUi(UA.getRuntimeContext?.());
  }
})();
