(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const PROFILE_ID = 'public-preview-core-v1';
  const DISABLED_CAPABILITIES = Object.freeze(['video-export']);
  const SERVER_REQUIRED_CAPABILITIES = Object.freeze([
    'political-context-search',
    'video-export',
  ]);
  const DEFAULT_CITY_LIST_WARNING_MS = 1500;

  UA.PUBLIC_DISTRIBUTION_PROFILE = Object.freeze({
    id: PROFILE_ID,
    label: 'Öffentliche Browser-Version',
    completeVendorInventory: false,
    complianceMode: 'declared-known-provenance-gaps',
    knownLicenseRestrictions: Object.freeze([]),
    provenanceGapsBlockCapabilities: false,
    disabledCapabilities: DISABLED_CAPABILITIES,
    serverRequiredCapabilities: SERVER_REQUIRED_CAPABILITIES,
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

  function configuredPoliticalContextEndpoint() {
    const direct = String(
      UA.POLITICAL_CONTEXT_ENDPOINT
      || document.querySelector('meta[name="unfallwerkbank:political-context-endpoint"]')?.content
      || ''
    ).trim();
    if (direct) {
      try {
        const endpoint = new URL(direct, window.location.href);
        return /^https?:$/.test(endpoint.protocol) ? endpoint.href : null;
      } catch (_) {
        return null;
      }
    }

    const baseValue = String(
      UA.API_BASE_URL
      || document.querySelector('meta[name="unfallwerkbank:api-base"]')?.content
      || ''
    ).trim();
    if (!baseValue) return null;

    try {
      const base = new URL(baseValue, window.location.href);
      if (!/^https?:$/.test(base.protocol)) return null;
      const baseHref = base.href.endsWith('/') ? base.href : `${base.href}/`;
      return new URL('api/political-context/search', baseHref).href;
    } catch (_) {
      return null;
    }
  }

  function createPoliticalBackendError(message, code, status, endpoint) {
    const error = new Error(message);
    error.code = code;
    if (Number.isFinite(status)) error.status = status;
    if (endpoint) error.endpoint = endpoint;
    return error;
  }

  async function readErrorBody(response) {
    try {
      const body = await response.json();
      return body && typeof body === 'object' ? body : {};
    } catch (_) {
      return {};
    }
  }

  async function searchConfiguredPoliticalBackend(endpoint, params) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
    } catch (error) {
      throw createPoliticalBackendError(
        `Das konfigurierte Backend für die politische Recherche ist nicht erreichbar: ${String(error?.message || error)}`,
        'POLITICAL_CONTEXT_NETWORK_ERROR',
        undefined,
        endpoint
      );
    }

    if (!response.ok) {
      const body = await readErrorBody(response);
      if (response.status === 405) {
        throw createPoliticalBackendError(
          'Die politische Recherche wurde mit HTTP 405 abgewiesen. Der konfigurierte Host stellt den POST-Endpunkt nicht bereit; bitte API-Basis oder Reverse-Proxy prüfen.',
          'POLITICAL_CONTEXT_HTTP_405',
          response.status,
          endpoint
        );
      }
      throw createPoliticalBackendError(
        body.error || `Politische Recherche fehlgeschlagen (HTTP ${response.status}).`,
        body.code || 'POLITICAL_CONTEXT_HTTP_ERROR',
        response.status,
        endpoint
      );
    }
    return response.json();
  }

  function politicalBackendUnavailableError() {
    return createPoliticalBackendError(
      'Die politische Recherche benötigt die Server-/Docker-Version der Unfallwerkbank. GitHub Pages kann den erforderlichen POST-Endpunkt nicht ausführen.',
      'POLITICAL_CONTEXT_BACKEND_REQUIRED'
    );
  }

  function bonnSearchTerms(ctx) {
    if (!UA.PoliticalContext || typeof UA.PoliticalContext.buildSearchTerms !== 'function') return [];
    const city = String(ctx?.CITY_RAW || '').trim().toLowerCase();
    return UA.PoliticalContext.buildSearchTerms(ctx)
      .map(term => String(term || '').trim())
      .filter(term => term && term.toLowerCase() !== city)
      .slice(0, 3);
  }

  function renderPoliticalBackendNotice(ctx) {
    const status = document.getElementById('polCtxStatus');
    const results = document.getElementById('polCtxResults');
    const searchButton = document.getElementById('polCtxBtnSearch');
    const openButton = document.getElementById('btnPolCtxOpen');
    const endpoint = configuredPoliticalContextEndpoint();

    if (searchButton) {
      searchButton.disabled = !endpoint;
      searchButton.setAttribute('aria-disabled', endpoint ? 'false' : 'true');
      searchButton.title = endpoint
        ? ''
        : 'Politische Recherche benötigt ein Server-Backend.';
    }
    if (openButton && !endpoint) {
      openButton.dataset.serverRequired = 'true';
      openButton.title =
        'Politische Recherche öffnen – auf GitHub Pages stehen offizielle Portal-Links statt der Serverrecherche bereit.';
    }
    if (endpoint || !status || !results) return;

    status.textContent =
      'Serverrecherche auf GitHub Pages nicht verfügbar – es wurde kein fehlerhafter API-Aufruf gesendet.';

    results.replaceChildren();
    const box = document.createElement('div');
    box.dataset.politicalContextFallback = 'server-required';
    box.style.cssText = [
      'padding:12px',
      'border:1px solid rgba(23,96,125,.28)',
      'border-radius:8px',
      'background:rgba(23,96,125,.06)',
      'font-size:12px',
      'line-height:1.45',
    ].join(';');

    const explanation = document.createElement('p');
    explanation.style.margin = '0 0 8px';
    explanation.textContent =
      'Die automatische Recherche läuft nur in der Server-/Docker-Version, weil sie kommunale Portale serverseitig abfragt, normalisiert und bewertet.';
    box.appendChild(explanation);

    const city = String(ctx?.CITY_RAW || activeCityFromUrl()).trim();
    if (city.toLowerCase() === 'bonn') {
      const links = document.createElement('div');
      links.append('Offizielle Bonner Recherche: ');

      const portal = document.createElement('a');
      portal.href = 'https://www.bonn.sitzung-online.de/public/';
      portal.target = '_blank';
      portal.rel = 'noopener';
      portal.textContent = 'Ratsinformationssystem öffnen';
      links.appendChild(portal);

      for (const term of bonnSearchTerms(ctx)) {
        links.append(' · ');
        const link = document.createElement('a');
        link.href = `https://www.bonn.sitzung-online.de/public/tr010?q=${encodeURIComponent(term)}`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = `nach „${term}“ suchen`;
        links.appendChild(link);
      }
      box.appendChild(links);
    } else {
      const hint = document.createElement('p');
      hint.style.margin = '8px 0 0';
      hint.textContent =
        'Für die automatische Recherche diese Analyse mit der Server-/Docker-Distribution öffnen.';
      box.appendChild(hint);
    }

    results.appendChild(box);
  }

  function installPoliticalContextTransport(ctx) {
    const politicalContext = UA.PoliticalContext;
    if (!politicalContext || typeof politicalContext.search !== 'function') return false;

    if (!politicalContext.search.__publicPagesTransportGuard) {
      const guardedSearch = async params => {
        const endpoint = configuredPoliticalContextEndpoint();
        if (!endpoint) throw politicalBackendUnavailableError();
        return searchConfiguredPoliticalBackend(endpoint, params);
      };
      Object.defineProperty(guardedSearch, '__publicPagesTransportGuard', { value: true });
      politicalContext.search = guardedSearch;
    }

    if (typeof politicalContext.openPanel === 'function'
        && !politicalContext.openPanel.__publicPagesTransportGuard) {
      const originalOpenPanel = politicalContext.openPanel.bind(politicalContext);
      const guardedOpenPanel = async panelCtx => {
        const result = await originalOpenPanel(panelCtx);
        renderPoliticalBackendNotice(panelCtx);
        return result;
      };
      Object.defineProperty(guardedOpenPanel, '__publicPagesTransportGuard', { value: true });
      politicalContext.openPanel = guardedOpenPanel;
    }

    renderPoliticalBackendNotice(ctx);
    return true;
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
      'Politische Recherche und Videoexport benötigen ein Server-Backend; die Bonn-Ansicht bietet ersatzweise Links zum offiziellen Ratsinformationssystem. ' +
      'Nach aktuellem Stand gilt: eine bekannte Lizenzbeschränkung für diese Browserfunktionen besteht nicht. ' +
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
    installPoliticalContextTransport(ctx);
    document.documentElement.dataset.distributionProfile = PROFILE_ID;

    if (ctx && ctx.ui && ctx.ui.exportMapModeHintEl) {
      ctx.ui.exportMapModeHintEl.textContent =
        'Der Kartenmodus gilt für Vorschau, Word/PDF und Datenexporte. ' +
        'Politische Recherche und Videoexport benötigen ein Server-Backend und sind auf GitHub Pages nicht automatisch verfügbar.';
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
  UA.PUBLIC_SERVER_REQUIRED_CAPABILITIES = SERVER_REQUIRED_CAPABILITIES;
  UA.resolvePublicPoliticalContextEndpoint = configuredPoliticalContextEndpoint;

  primeCityDropdown();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => applyPublicUi(UA.getRuntimeContext?.()), { once: true });
  } else {
    applyPublicUi(UA.getRuntimeContext?.());
  }
})();