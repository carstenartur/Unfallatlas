(() => {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const UA = (root.UA = root.UA || {});
  const MODULE_ID = 'unfallwerkbank.bonnPoliticalBrowserFallback.v1';
  const COLLECTION = 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers';
  const HOSTS = new Set(['www.bonn.sitzung-online.de', 'bonn.sitzung-online.de']);
  const PAGE_SIZE = 100;
  const DEFAULT_MAX_PAGES = 12;
  const HARD_MAX_PAGES = 30;
  const MAX_INSTALL_CHECKS = 240;

  const clean = value => String(value == null ? '' : value).trim();
  const normalize = value => clean(value).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ');
  const cityKey = value => normalize(value).replace(/[^a-z0-9]+/g, '');
  const bounded = (value, fallback, max) => {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
  };
  const statusOf = error => {
    const status = Number(error && error.status);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
    const match = clean(error && error.message).match(/\bHTTP\s+(\d{3})\b/i);
    return match ? Number(match[1]) : null;
  };

  function officialUrl(value, base, collectionOnly = false) {
    const raw = clean(value);
    if (!raw) return '';
    try {
      const url = new URL(raw, base || undefined);
      if (url.protocol !== 'https:' || !HOSTS.has(url.hostname.toLowerCase())) return '';
      if (collectionOnly && !/^\/oparl\/bodies\/\d+\/papers\/?$/.test(url.pathname)) return '';
      return url.href;
    } catch (_) {
      return '';
    }
  }

  function pageUrl(value = COLLECTION, pageNumber) {
    const trusted = officialUrl(value, undefined, true);
    if (!trusted) {
      const error = new Error(`Nicht vertrauenswürdige Bonner OParl-URL: ${clean(value)}`);
      error.code = 'BONN_OPARL_UNTRUSTED_URL';
      throw error;
    }
    const url = new URL(trusted);
    const page = pageNumber == null
      ? bounded(url.searchParams.get('page'), 1, Number.MAX_SAFE_INTEGER)
      : bounded(pageNumber, 1, Number.MAX_SAFE_INTEGER);
    url.search = '';
    url.searchParams.set('page', String(page));
    url.searchParams.set('limit', String(PAGE_SIZE));
    url.searchParams.set('size', String(PAGE_SIZE));
    return url.href;
  }

  function searchTerms(values) {
    const ignored = new Set(['bonn', 'stadt bonn', 'bundesstadt bonn']);
    const seen = new Set();
    return (Array.isArray(values) ? values : []).map(value => ({
      value: clean(value), normalized: normalize(value),
    })).filter(term => {
      if (!term.value || term.normalized.length < 3 || ignored.has(term.normalized)
          || seen.has(term.normalized)) return false;
      seen.add(term.normalized);
      return true;
    });
  }

  function paperText(paper) {
    const locations = Array.isArray(paper && paper.location)
      ? paper.location.flatMap(item => [item?.description, item?.streetAddress, item?.locality])
      : [];
    const files = [paper?.mainFile, ...(Array.isArray(paper?.auxiliaryFile)
      ? paper.auxiliaryFile : [])].filter(Boolean)
      .flatMap(file => [file.name, file.fileName]);
    return normalize([
      paper?.name, paper?.reference, paper?.paperType,
      ...(Array.isArray(paper?.keyword) ? paper.keyword : []), ...locations, ...files,
    ].filter(Boolean).join(' | '));
  }

  function inferType(paper) {
    const text = `${clean(paper?.paperType)} ${clean(paper?.name)}`;
    if (/änderungsantrag/i.test(text)) return 'Änderungsantrag';
    if (/\bantrag\b/i.test(text)) return 'Antrag';
    if (/\banfrage\b/i.test(text)) return 'Anfrage';
    if (/\bbeschluss\b/i.test(text)) return 'Beschluss';
    if (/verwaltungsantwort|stellungnahme/i.test(text)) return 'Verwaltungsantwort';
    if (/protokoll|niederschrift/i.test(text)) return 'Protokoll';
    return 'Sonstige';
  }

  function mapPaper(paper, terms) {
    const matched = terms.filter(term => paperText(paper).includes(term.normalized));
    const url = [paper?.web, paper?.mainFile?.web, paper?.id,
      paper?.mainFile?.accessUrl, paper?.mainFile?.downloadUrl]
      .map(value => officialUrl(value)).find(Boolean) || '';
    const title = clean(paper?.name);
    if (!title || !url || matched.length === 0) return null;
    const type = inferType(paper);
    return {
      id: clean(paper?.id) || url,
      title,
      type,
      date: paper?.date || (paper?.modified ? clean(paper.modified).slice(0, 10) : null),
      gremium: paper?.gremium || paper?.organizationName || null,
      number: paper?.reference || null,
      snippet: [paper?.paperType, ...(Array.isArray(paper?.keyword) ? paper.keyword : [])]
        .filter(Boolean).join(' | ').slice(0, 400) || null,
      url,
      source: 'bonn-oparl-browser',
      sourceType: 'oparl-1.1-browser-fallback',
      referenceType: type,
      reason: `Browserdirekter OParl-Treffer für ${matched.map(term => `„${term.value}“`).join(', ')}. `
        + 'Die begrenzte Teilsuche ersetzt keine vollständige politische Recherche.',
      relevanceScore: Math.min(100, matched.length * 30
        + (['Antrag', 'Änderungsantrag', 'Beschluss'].includes(type) ? 15 : 0)),
      aiGating: {
        allowed: false,
        reason: 'Begrenzte browserdirekte OParl-Teilsuche; vollständige Vorbefassung noch zu prüfen.',
      },
    };
  }

  function parsePage(payload, currentUrl) {
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
      const error = new Error(`Ungültige Bonner OParl-Listenantwort: ${currentUrl}`);
      error.code = 'BONN_OPARL_INVALID_LIST';
      throw error;
    }
    const pagination = payload.pagination || {};
    const links = payload.links || {};
    let last = officialUrl(links.last, currentUrl, true);
    let previous = officialUrl(links.prev, currentUrl, true);
    if (clean(links.last) && !last || clean(links.prev) && !previous) {
      const error = new Error('Nicht vertrauenswürdiger Bonner OParl-Paginierungslink.');
      error.code = 'BONN_OPARL_UNTRUSTED_URL';
      throw error;
    }
    const currentPage = Number(pagination.currentPage);
    const totalPages = Number(pagination.totalPages);
    if (!last && Number.isFinite(totalPages) && totalPages > 0) last = pageUrl(currentUrl, totalPages);
    if (!previous && Number.isFinite(currentPage) && currentPage > 1) {
      previous = pageUrl(currentUrl, currentPage - 1);
    }
    return {
      data: payload.data,
      last: last ? pageUrl(last) : '',
      previous: previous ? pageUrl(previous) : '',
    };
  }

  async function readPage(url, fetchImpl) {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json, application/ld+json;q=0.9' },
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!response || !response.ok) {
      const error = new Error(`Bonner OParl HTTP ${Number(response?.status) || 'unbekannt'}`);
      error.code = 'BONN_OPARL_HTTP_ERROR';
      error.status = Number(response?.status) || null;
      throw error;
    }
    try {
      return await response.json();
    } catch (cause) {
      const error = new Error(`Ungültiges JSON von der Bonner OParl-Sammlung: ${cause.message}`);
      error.code = 'BONN_OPARL_INVALID_JSON';
      throw error;
    }
  }

  function uniqueSorted(values) {
    const seen = new Set();
    return values.filter(value => {
      const key = clean(value?.url).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0));
  }

  function incomplete(message, details = {}) {
    const error = new Error(message);
    error.code = 'POLITICAL_CONTEXT_BROWSER_SEARCH_INCOMPLETE';
    error.details = details;
    return error;
  }

  async function searchBonn(params = {}, options = {}) {
    const fetchImpl = options.fetchImpl || (typeof root.fetch === 'function'
      ? root.fetch.bind(root) : null);
    const terms = searchTerms(params.searchTerms);
    if (!fetchImpl) throw incomplete('Diese Laufzeit stellt kein fetch für die Bonner Teilsuche bereit.');
    if (!terms.length) throw incomplete('Für die Bonner Teilsuche fehlt ein belastbarer Suchbegriff.');

    const configured = root.UA_CONFIG?.bonnPoliticalBrowserMaxPages;
    const maxPages = bounded(options.maxPages ?? configured, DEFAULT_MAX_PAGES, HARD_MAX_PAGES);
    const maxResults = bounded(params.maxResults, 15, 30);
    const firstUrl = pageUrl(COLLECTION, 1);
    const first = parsePage(await readPage(firstUrl, fetchImpl), firstUrl);
    const cache = new Map([[firstUrl, first]]);
    const visited = new Set();
    const raw = [];
    const counts = new Map(terms.map(term => [term.normalized, 0]));
    let requests = 1;
    let pages = 0;
    let scanned = 0;
    let current = first.last || firstUrl;
    let next = '';

    while (current && pages < maxPages) {
      current = pageUrl(current);
      if (visited.has(current)) throw incomplete('Zyklus in der Bonner OParl-Paginierung.');
      visited.add(current);
      let page = cache.get(current);
      if (!page) {
        page = parsePage(await readPage(current, fetchImpl), current);
        requests += 1;
      }
      pages += 1;
      scanned += page.data.length;
      for (const paper of page.data) {
        if (!paper || paper.deleted === true) continue;
        const text = paperText(paper);
        const matched = terms.filter(term => text.includes(term.normalized));
        const mapped = matched.length ? mapPaper(paper, terms) : null;
        if (!mapped) continue;
        raw.push(mapped);
        matched.forEach(term => counts.set(term.normalized,
          (counts.get(term.normalized) || 0) + 1));
      }
      if (uniqueSorted(raw).length >= maxResults
          && terms.every(term => (counts.get(term.normalized) || 0) > 0)) {
        next = page.previous || '';
        break;
      }
      current = page.previous;
      next = current || '';
    }

    const references = uniqueSorted(raw).slice(0, maxResults);
    if (!references.length) {
      throw incomplete(
        `Die begrenzte Bonner OParl-Teilsuche (${pages} Seite(n), ${scanned} Vorgänge) `
          + 'lieferte keinen Treffer. Das ist kein belastbarer Nullbefund.',
        { pagesFetched: requests, scanPagesFetched: pages, scannedItems: scanned, nextUrl: next }
      );
    }

    const bypassed = options.serverBypassed === true;
    return {
      references,
      meta: {
        city: 'Bonn',
        searchTerms: Array.isArray(params.searchTerms) ? params.searchTerms : terms.map(term => term.value),
        searchedAt: new Date().toISOString(),
        totalFound: uniqueSorted(raw).length,
        providerKey: 'bonn-allris',
        supported: true,
        searchStatus: 'partial-results',
        sourceType: 'oparl-1.1-browser-fallback',
        sourceUrl: COLLECTION,
        queryLog: terms.map(term => ({
          query: term.value,
          source: 'bonn-oparl-browser',
          sourceType: 'oparl-1.1-browser-fallback',
          url: COLLECTION,
          status: (counts.get(term.normalized) || 0) > 0 ? 'partial-results' : 'incomplete',
          count: counts.get(term.normalized) || 0,
        })),
        pagesFetched: requests,
        scanPagesFetched: pages,
        discoveryPagesFetched: 1,
        scannedItems: scanned,
        truncated: true,
        nextUrl: next || null,
        warnings: [
          bypassed
            ? 'Der nicht verfügbare Pages-POST wurde bewusst nicht aufgerufen; Bonn wurde begrenzt direkt über OParl durchsucht.'
            : 'Der Server-Endpunkt war nicht verfügbar; Bonn wurde begrenzt direkt über OParl durchsucht.',
          'Fehlende Treffer sind kein Beleg für fehlende politische Vorbefassung.',
        ],
        attempts: [{
          source: 'same-origin-api',
          sourceType: 'http-api',
          url: '/api/political-context/search',
          status: bypassed ? 'not-attempted-static-profile'
            : `http-${Number(options.serverStatus) || 405}`,
        }, {
          source: 'bonn-oparl-browser',
          sourceType: 'oparl-1.1-browser-fallback',
          url: COLLECTION,
          status: 'partial-results',
          count: references.length,
        }],
        cache: { hit: false, enabled: false },
        browserFallback: {
          schemaVersion: MODULE_ID,
          bounded: true,
          maxPages,
          pageSize: PAGE_SIZE,
          serverBypassed: bypassed,
          serverStatus: bypassed ? null : (Number(options.serverStatus) || 405),
        },
      },
    };
  }

  function backendRequired(params, status = 405) {
    const city = clean(params?.city) || 'die ausgewählte Stadt';
    const error = new Error(
      `Die politische Recherche für ${city} benötigt einen konfigurierten `
        + `Unfallwerkbank-Server (POST-Endpunkt nicht verfügbar, HTTP ${status}).`
    );
    error.code = 'POLITICAL_CONTEXT_BACKEND_REQUIRED';
    error.status = status;
    return error;
  }

  function publicStaticProfile() {
    const endpoint = typeof UA.resolvePublicPoliticalContextEndpoint === 'function'
      ? UA.resolvePublicPoliticalContextEndpoint() : null;
    return UA.PUBLIC_DISTRIBUTION_PROFILE?.id === 'public-preview-core-v1' && !endpoint;
  }

  function syncEvidence(result, params) {
    try {
      const fn = UA.aiPoliticalEvidence?._internal?.stateFromResult;
      if (typeof fn !== 'function') return;
      fn(typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() || {} : {}, result, {
        searchTerms: Array.isArray(params.searchTerms) ? params.searchTerms : [],
        automaticallyAdopted: false,
      });
    } catch (_) { /* UI result remains usable. */ }
  }

  function decorate(result) {
    if (!root.document) return;
    root.setTimeout?.(() => {
      const status = root.document.getElementById('polCtxStatus');
      const results = root.document.getElementById('polCtxResults');
      if (status) status.textContent =
        `${result.references.length} Vorgang/Vorgänge in einer begrenzten Bonner OParl-Teilsuche gefunden. Vollständige Vorbefassung weiterhin prüfen.`;
      if (results && !root.document.getElementById('polCtxBrowserFallbackNotice')) {
        const note = root.document.createElement('div');
        note.id = 'polCtxBrowserFallbackNotice';
        note.setAttribute('role', 'note');
        note.textContent = 'Begrenzte browserdirekte Teilsuche: Fehlende Treffer sind kein Nullbefund.';
        note.style.cssText = 'margin:0 0 10px;padding:9px 11px;border-left:3px solid #b7791f;background:rgba(255,193,7,.14);font-size:12px;';
        results.prepend(note);
      }
    }, 0);
  }

  function enablePublicBonnUi() {
    if (!root.document || !publicStaticProfile()) return;
    const city = clean(UA.getRuntimeContext?.()?.CITY_RAW
      || new URLSearchParams(root.location?.search || '').get('city'));
    if (cityKey(city) !== 'bonn') return;
    const search = root.document.getElementById('polCtxBtnSearch');
    if (search) {
      search.disabled = false;
      search.setAttribute('aria-disabled', 'false');
      search.title = 'Begrenzte browserdirekte Bonner OParl-Teilsuche starten.';
    }
    const notice = root.document.getElementById('publicPreviewNotice');
    if (notice && !root.document.getElementById('publicPoliticalPartialNotice')) {
      const text = root.document.createElement('p');
      text.id = 'publicPoliticalPartialNotice';
      text.textContent = 'Bonn: Bei fehlendem Server steht eine begrenzte browserdirekte OParl-Teilsuche bereit; sie ist kein vollständiger Nullbefund.';
      notice.appendChild(text);
    }
  }

  function refreshPublicBonnUi() {
    enablePublicBonnUi();
    root.setTimeout?.(enablePublicBonnUi, 0);
  }

  function wrapSearch(political, original) {
    if (typeof original !== 'function' || original._uaBonnBrowserFallbackWrapped) return original;
    const wrapped = async function searchWithBonnBrowserFallback(params = {}) {
      if (publicStaticProfile()) {
        if (cityKey(params.city) !== 'bonn') throw backendRequired(params);
        const result = await searchBonn(params, { serverBypassed: true });
        decorate(result);
        syncEvidence(result, params);
        return result;
      }
      try {
        return await original.call(political, params);
      } catch (error) {
        const status = statusOf(error);
        const guarded = error?.code === 'POLITICAL_CONTEXT_BACKEND_REQUIRED';
        if (!guarded && ![404, 405].includes(status)) throw error;
        if (cityKey(params.city) !== 'bonn') {
          throw guarded ? error : backendRequired(params, status || 405);
        }
        const result = await searchBonn(params, { serverStatus: status || 405 });
        decorate(result);
        syncEvidence(result, params);
        return result;
      }
    };
    wrapped._uaBonnBrowserFallbackWrapped = true;
    wrapped._uaOriginal = original;
    return wrapped;
  }

  function install() {
    const political = UA.PoliticalContext;
    if (!political || typeof political.search !== 'function') return false;
    if (political.__uaBonnBrowserFallbackAccessor === true) {
      refreshPublicBonnUi();
      return true;
    }

    let current = wrapSearch(political, political.search);
    Object.defineProperty(political, 'search', {
      configurable: true,
      enumerable: true,
      get() { return current; },
      set(value) {
        current = wrapSearch(political, value);
        refreshPublicBonnUi();
      },
    });
    Object.defineProperty(political, '__uaBonnBrowserFallbackAccessor', {
      configurable: true,
      value: true,
    });
    political.searchBonnInBrowser = searchBonn;
    refreshPublicBonnUi();
    return true;
  }

  UA.PoliticalContextBrowserFallback = Object.freeze({
    MODULE_ID, COLLECTION, install, searchBonn,
    _internal: Object.freeze({ cityKey, officialUrl, pageUrl, searchTerms,
      paperText, mapPaper, parsePage, readPage, incomplete, backendRequired }),
  });

  let checks = 0;
  const installWhenReady = () => {
    if (install()) return;
    if (checks++ < MAX_INSTALL_CHECKS && typeof root.setTimeout === 'function') {
      root.setTimeout(installWhenReady, 25);
    }
  };
  installWhenReady();
  if (typeof root.document?.addEventListener === 'function') {
    root.document.addEventListener('DOMContentLoaded', installWhenReady, { once: true });
  }
})();
