'use strict';

/**
 * Structured OParl client for the official Bonn council-information system.
 *
 * OParl has no mandatory free-text search endpoint. We normally traverse the
 * official System -> Body -> Paper list, use standard list filters and match
 * terms locally. Bonn's ALLRIS deployment also exposes the official Paper
 * collection directly; that documented collection is used as a bounded,
 * auditable fallback when the discovery document is temporarily unavailable.
 */

const { enrichWithReferenceModel } = require('./_portalUtils.js');
const {
  OParlClientError,
  OParlClientErrorCode: HTTP_ERROR_CODE,
  DEFAULT_MAX_PAGES,
  positiveInteger,
  normalizeUrl,
  isHttpUrl,
  officialBonnUrl,
  assertAllowedNetworkUrl,
  fetchJson,
  fetchExternalList,
  appendQuery,
  parseListPage,
} = require('./bonnOparlHttp.js');

const SYSTEM_URL = 'https://www.bonn.sitzung-online.de/oparl/system';
const DIRECT_PAPER_LIST_URL = 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers';
const PROVIDER_KEY = 'bonn-oparl';
const OParlClientErrorCode = Object.freeze({
  ...HTTP_ERROR_CODE,
  INVALID_SYSTEM: 'OPARL_INVALID_SYSTEM',
  BODY_NOT_FOUND: 'OPARL_BODY_NOT_FOUND',
  PAPER_LIST_MISSING: 'OPARL_PAPER_LIST_MISSING',
});
const DEFAULT_PAGE_LIMIT = positiveInteger(process.env.BONN_OPARL_PAGE_LIMIT, 100);
const DEFAULT_LOOKBACK_YEARS = positiveInteger(process.env.BONN_OPARL_LOOKBACK_YEARS, 10);
const BONN_AGS = '05314000';
const MAX_BONN_PAGE_SIZE = 100;
const DEFAULT_BONN_MAX_SCAN_PAGES = positiveInteger(
  process.env.BONN_OPARL_MAX_PAGES,
  300
);

function bodyScore(body) {
  if (!body || typeof body !== 'object') return -1;
  const name = `${body.shortName || ''} ${body.name || ''}`.toLowerCase();
  let score = 0;
  if (String(body.ags || '') === BONN_AGS) score += 100;
  if (String(body.shortName || '').trim().toLowerCase() === 'bonn') score += 50;
  if (name.includes('bonn')) score += 20;
  return score;
}

async function resolveBonnBody(system, options = {}) {
  if (!system || typeof system !== 'object' || !isHttpUrl(system.body)) {
    throw new OParlClientError(
      OParlClientErrorCode.INVALID_SYSTEM,
      'Das Bonner OParl-System enthält keine gültige Body-Liste.',
      { systemUrl: options.systemUrl || SYSTEM_URL }
    );
  }
  const fetchJsonImpl = options.fetchJsonImpl || fetchJson;
  const bodyList = await fetchExternalList(system.body, {
    fetchJsonImpl,
    maxPages: positiveInteger(options.maxBodyPages, 3),
    query: { limit: 100, size: 100, omit_internal: 'true' },
    requestOptions: options.requestOptions,
  });
  const candidates = bodyList.items.filter(Boolean);
  if (!candidates.length) {
    throw new OParlClientError(
      OParlClientErrorCode.BODY_NOT_FOUND,
      'Die Bonner OParl-Body-Liste ist leer.',
      { bodyListUrl: system.body }
    );
  }

  candidates.sort((a, b) => bodyScore(b) - bodyScore(a));
  if (bodyScore(candidates[0]) <= 0) {
    throw new OParlClientError(
      OParlClientErrorCode.BODY_NOT_FOUND,
      'In der OParl-Body-Liste wurde kein belastbarer Bonn-Eintrag gefunden.',
      { bodyListUrl: system.body, candidateCount: candidates.length }
    );
  }
  let body = candidates[0];
  if (typeof body === 'string') {
    body = await fetchJsonImpl(body, options.requestOptions || {});
  } else if ((!body.paper || !body.name) && isHttpUrl(body.id)) {
    body = await fetchJsonImpl(body.id, options.requestOptions || {});
  }
  if (!body || typeof body !== 'object' || !isHttpUrl(body.paper)) {
    throw new OParlClientError(
      OParlClientErrorCode.PAPER_LIST_MISSING,
      'Der Bonner OParl-Body enthält keine gültige Paper-Liste.',
      { bodyId: body && body.id, bodyName: body && body.name }
    );
  }
  return { body, bodyList };
}

function normalizedSearchText(value) {
  return String(value == null ? '' : value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningfulSearchTerms(values) {
  const ignored = new Set(['bonn', 'stadt bonn', 'bundesstadt bonn']);
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value == null ? '' : value).trim();
    const normalized = normalizedSearchText(clean);
    if (!clean || normalized.length < 3 || ignored.has(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ value: clean, normalized });
  }
  return out;
}

function paperHaystack(paper) {
  const locations = Array.isArray(paper && paper.location)
    ? paper.location.map(location => location && (
      location.description || location.streetAddress || location.locality
    ))
    : [];
  const files = [
    paper && paper.mainFile,
    ...(Array.isArray(paper && paper.auxiliaryFile) ? paper.auxiliaryFile : []),
  ].filter(Boolean).flatMap(file => [file.name, file.fileName]);
  return normalizedSearchText([
    paper && paper.name,
    paper && paper.reference,
    paper && paper.paperType,
    ...(Array.isArray(paper && paper.keyword) ? paper.keyword : []),
    ...locations,
    ...files,
  ].filter(Boolean).join(' | '));
}

function matchedTermsForPaper(paper, terms) {
  const haystack = paperHaystack(paper);
  return haystack ? terms.filter(term => haystack.includes(term.normalized)) : [];
}

function matchedTermForPaper(paper, terms) {
  return matchedTermsForPaper(paper, terms)[0] || null;
}

function bestPaperUrl(paper) {
  return [
    paper && paper.web,
    paper && paper.mainFile && paper.mainFile.web,
    paper && paper.id,
    paper && paper.mainFile && paper.mainFile.accessUrl,
    paper && paper.mainFile && paper.mainFile.downloadUrl,
  ].map(officialBonnUrl).find(Boolean) || '';
}

function paperSnippet(paper) {
  const locations = Array.isArray(paper && paper.location)
    ? paper.location.map(location => location && location.description).filter(Boolean)
    : [];
  const keywords = Array.isArray(paper && paper.keyword) ? paper.keyword : [];
  return [paper && paper.paperType, ...keywords.slice(0, 5), ...locations.slice(0, 3)]
    .filter(Boolean).join(' | ').slice(0, 300) || null;
}

function mapPaper(paper, matchedTerm) {
  const title = String(paper && paper.name || '').trim();
  const url = bestPaperUrl(paper);
  if (!title || !url) return null;
  return enrichWithReferenceModel({
    title,
    url,
    date: paper.date || (paper.created ? String(paper.created).slice(0, 10) : null),
    gremium: paper.gremium || paper.organizationName || null,
    number: paper.reference || null,
    snippet: paperSnippet(paper),
    rawType: paper.paperType || '',
    oparlId: normalizeUrl(paper.id),
    sourceType: 'oparl-1.1',
  }, matchedTerm.value);
}

function createdSinceIso(nowValue, lookbackYears) {
  let now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  if (!Number.isFinite(now.getTime())) now = new Date();
  const year = now.getUTCFullYear() - positiveInteger(lookbackYears, DEFAULT_LOOKBACK_YEARS);
  return `${year}-01-01T00:00:00Z`;
}

function lookbackCutoffTime(nowValue, lookbackYears) {
  let now = nowValue instanceof Date ? nowValue : new Date(nowValue || Date.now());
  if (!Number.isFinite(now.getTime())) now = new Date();
  return Date.UTC(
    now.getUTCFullYear() - positiveInteger(lookbackYears, DEFAULT_LOOKBACK_YEARS),
    0,
    1
  );
}

function paperWithinLookback(paper, nowValue, lookbackYears) {
  const rawDate = paper && (paper.date || paper.modified);
  if (!rawDate) return true;
  const time = new Date(rawDate).getTime();
  return !Number.isFinite(time) || time >= lookbackCutoffTime(nowValue, lookbackYears);
}

function deduplicateByUrl(results) {
  const seen = new Set();
  return results.filter(result => {
    const key = normalizeUrl(result && result.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compactError(error) {
  return {
    code: String(error && error.code || 'OPARL_DISCOVERY_ERROR').slice(0, 100),
    message: String(error && error.message || error || 'Unbekannter OParl-Fehler').slice(0, 240),
  };
}

function mayUseDirectPaperList(systemUrl, params, error) {
  const explicitDirectUrl = normalizeUrl(params.directPaperListUrl);
  const usesOfficialDiscovery = systemUrl === normalizeUrl(SYSTEM_URL);
  if (!explicitDirectUrl && !usesOfficialDiscovery) return false;
  const code = String(error && error.code || '');
  return ![
    OParlClientErrorCode.INVALID_URL,
    OParlClientErrorCode.UNTRUSTED_HOST,
  ].includes(code);
}

async function resolvePaperSource(params, fetchJsonImpl, systemUrl) {
  try {
    const system = await fetchJsonImpl(systemUrl, params.requestOptions || {});
    if (!system || typeof system !== 'object' || !isHttpUrl(system.body)) {
      throw new OParlClientError(
        OParlClientErrorCode.INVALID_SYSTEM,
        `Ungültiges OParl-Systemobjekt: ${systemUrl}`,
        { systemUrl, type: system && system.type, oparlVersion: system && system.oparlVersion }
      );
    }
    const { body, bodyList } = await resolveBonnBody(system, {
      fetchJsonImpl,
      systemUrl,
      requestOptions: params.requestOptions,
      maxBodyPages: params.maxBodyPages,
    });
    return {
      body,
      bodyList,
      paperListUrl: normalizeUrl(body.paper),
      sourceUrl: systemUrl,
      discoveryMode: 'system-body',
      discoveryError: null,
    };
  } catch (error) {
    if (!mayUseDirectPaperList(systemUrl, params, error)) throw error;
    const paperListUrl = assertAllowedNetworkUrl(
      params.directPaperListUrl || DIRECT_PAPER_LIST_URL
    );
    return {
      body: {
        id: '',
        name: 'Bundesstadt Bonn',
        shortName: 'Bonn',
        paper: paperListUrl,
      },
      bodyList: { pagesFetched: 0 },
      paperListUrl,
      sourceUrl: paperListUrl,
      discoveryMode: 'direct-paper-list',
      discoveryError: compactError(error),
    };
  }
}

function isOfficialBonnPaperCollection(urlValue) {
  const normalized = normalizeUrl(urlValue);
  if (!normalized) return false;
  const url = new URL(normalized);
  return ['www.bonn.sitzung-online.de', 'bonn.sitzung-online.de']
    .includes(url.hostname.toLowerCase())
    && /^\/oparl\/bodies\/\d+\/papers\/?$/.test(url.pathname);
}

function officialCollectionUrl(urlValue, pageSize, pageNumber) {
  const url = new URL(assertAllowedNetworkUrl(urlValue));
  const effectivePage = pageNumber !== undefined && pageNumber !== null
    ? pageNumber
    : positiveInteger(url.searchParams.get('page'), 1);
  url.search = '';
  url.searchParams.set('page', String(effectivePage));
  const effectiveSize = Math.min(
    MAX_BONN_PAGE_SIZE,
    positiveInteger(pageSize, DEFAULT_PAGE_LIMIT)
  );
  // `limit` is the OParl parameter; Bonn's deployed collection currently
  // honours the Spring-compatible `size` alias and caps it at 100.
  url.searchParams.set('limit', String(effectiveSize));
  url.searchParams.set('size', String(effectiveSize));
  // Keep internal object fields: local matching may need Paper.location and
  // file metadata when a street name is absent from the title.
  url.searchParams.delete('omit_internal');
  return url.href;
}

function collectionLink(payload, key, currentUrl, pageSize) {
  const raw = payload && payload.links && payload.links[key];
  const normalized = normalizeUrl(raw, currentUrl);
  return normalized ? officialCollectionUrl(normalized, pageSize) : '';
}

function collectionPage(payload, currentUrl, pageSize) {
  const parsed = parseListPage(payload, currentUrl);
  const currentPage = Number(parsed.pagination && parsed.pagination.currentPage);
  const totalPages = Number(parsed.pagination && parsed.pagination.totalPages);
  let previous = collectionLink(payload, 'prev', currentUrl, pageSize);
  let last = collectionLink(payload, 'last', currentUrl, pageSize);
  if (!previous && Number.isFinite(currentPage) && currentPage > 1) {
    previous = officialCollectionUrl(currentUrl, pageSize, currentPage - 1);
  }
  if (!last && Number.isFinite(totalPages) && totalPages > 0) {
    last = officialCollectionUrl(currentUrl, pageSize, totalPages);
  }
  return { ...parsed, previous, last };
}

async function fetchOfficialBonnPaperList(source, params, fetchJsonImpl) {
  const maxScanPages = positiveInteger(params.maxPages, DEFAULT_BONN_MAX_SCAN_PAGES);
  const pageSize = Math.min(
    MAX_BONN_PAGE_SIZE,
    positiveInteger(params.pageLimit, DEFAULT_PAGE_LIMIT)
  );
  const requestOptions = params.requestOptions || {};
  const firstUrl = officialCollectionUrl(source.paperListUrl, pageSize, 1);
  const firstPayload = await fetchJsonImpl(firstUrl, requestOptions);
  const firstPage = collectionPage(firstPayload, firstUrl, pageSize);
  const cache = new Map([[firstUrl, firstPage]]);
  const visited = new Set();
  const items = [];
  const pages = [];
  let requests = 1;
  let currentUrl = firstPage.last || firstUrl;
  let scanPagesFetched = 0;

  while (currentUrl && scanPagesFetched < maxScanPages) {
    currentUrl = officialCollectionUrl(currentUrl, pageSize);
    if (visited.has(currentUrl)) {
      throw new OParlClientError(
        OParlClientErrorCode.PAGINATION_CYCLE,
        `OParl-Rückwärtspaginierung enthält einen Zyklus: ${currentUrl}`,
        { url: currentUrl, visited: [...visited] }
      );
    }
    visited.add(currentUrl);

    let page = cache.get(currentUrl);
    if (!page) {
      const payload = await fetchJsonImpl(currentUrl, requestOptions);
      page = collectionPage(payload, currentUrl, pageSize);
      requests += 1;
    }
    items.push(...page.data);
    pages.push({
      url: currentUrl,
      count: page.data.length,
      pagination: page.pagination,
    });
    scanPagesFetched += 1;
    currentUrl = page.previous;
  }

  return {
    items,
    pages,
    pagesFetched: requests,
    scanPagesFetched,
    discoveryPagesFetched: 1,
    traversalDirection: 'newest-first',
    truncated: Boolean(currentUrl),
    nextUrl: currentUrl || '',
  };
}

async function fetchPaperList(source, params, fetchJsonImpl) {
  if (isOfficialBonnPaperCollection(source.paperListUrl)) {
    return {
      paperList: await fetchOfficialBonnPaperList(source, params, fetchJsonImpl),
      unfilteredRetry: false,
      reverseTraversal: true,
    };
  }

  const options = {
    fetchJsonImpl,
    maxPages: positiveInteger(params.maxPages, DEFAULT_MAX_PAGES),
    query: {
      created_since: createdSinceIso(params.now, params.lookbackYears),
      omit_internal: 'true',
      limit: positiveInteger(params.pageLimit, DEFAULT_PAGE_LIMIT),
    },
    requestOptions: params.requestOptions,
  };
  try {
    return {
      paperList: await fetchExternalList(source.paperListUrl, options),
      unfilteredRetry: false,
      reverseTraversal: false,
    };
  } catch (error) {
    const status = Number(error && error.details && error.details.status);
    const filterUnsupported = error && (
      error.code === OParlClientErrorCode.INVALID_JSON
      || (error.code === OParlClientErrorCode.HTTP_ERROR && status === 400)
    );
    if (source.discoveryMode !== 'direct-paper-list' || !filterUnsupported) {
      throw error;
    }
    return {
      paperList: await fetchExternalList(source.paperListUrl, {
        ...options,
        query: {},
      }),
      unfilteredRetry: true,
      reverseTraversal: false,
    };
  }
}

async function searchOparl(params = {}) {
  const fetchJsonImpl = params.fetchJsonImpl || fetchJson;
  const systemUrl = normalizeUrl(params.systemUrl || SYSTEM_URL);
  if (!systemUrl) {
    throw new OParlClientError(
      OParlClientErrorCode.INVALID_URL,
      `Ungültige OParl-System-URL: ${String(params.systemUrl || SYSTEM_URL)}`,
      { systemUrl: String(params.systemUrl || SYSTEM_URL) }
    );
  }
  const terms = meaningfulSearchTerms(params.searchTerms);
  const queryLog = terms.map(term => ({
    query: term.value,
    source: PROVIDER_KEY,
    sourceType: 'oparl-1.1',
    url: systemUrl,
    status: 'started',
  }));
  if (!terms.length) {
    return {
      results: [],
      meta: {
        status: 'incomplete', sourceType: 'oparl-1.1', sourceUrl: systemUrl,
        queryLog: [], pagesFetched: 0, scannedItems: 0, truncated: false,
        warnings: ['Keine orts- oder themenspezifischen Suchbegriffe für die OParl-Suche.'],
      },
    };
  }

  const source = await resolvePaperSource(params, fetchJsonImpl, systemUrl);
  queryLog.forEach(entry => { entry.url = source.paperListUrl; });
  const { paperList, unfilteredRetry, reverseTraversal } = await fetchPaperList(
    source,
    params,
    fetchJsonImpl
  );

  const matches = [];
  const termCounts = new Map(terms.map(term => [term.normalized, 0]));
  let excludedOutsideLookback = 0;
  let eligibleItems = 0;
  for (const paper of paperList.items) {
    if (!paper || paper.deleted === true) continue;
    if (reverseTraversal && !paperWithinLookback(paper, params.now, params.lookbackYears)) {
      excludedOutsideLookback += 1;
      continue;
    }
    eligibleItems += 1;
    const matchedTerms = matchedTermsForPaper(paper, terms);
    const mapped = matchedTerms.length ? mapPaper(paper, matchedTerms[0]) : null;
    if (!mapped) continue;
    matches.push(mapped);
    for (const matchedTerm of matchedTerms) {
      termCounts.set(matchedTerm.normalized, (termCounts.get(matchedTerm.normalized) || 0) + 1);
    }
  }

  const results = deduplicateByUrl(matches);
  const status = paperList.truncated
    ? (results.length ? 'partial-results' : 'incomplete')
    : (results.length ? 'results-found' : 'searched-no-results');
  queryLog.forEach((entry, index) => {
    const count = termCounts.get(terms[index].normalized) || 0;
    entry.count = count;
    entry.status = paperList.truncated
      ? (count ? 'partial-results' : 'incomplete')
      : (count ? 'results-found' : 'searched-no-results');
  });

  const warnings = [];
  if (source.discoveryError) {
    warnings.push(
      `Das OParl-Systemdokument war nicht nutzbar (${source.discoveryError.code}: `
      + `${source.discoveryError.message}); die offizielle direkte Paper-Sammlung wurde verwendet.`
    );
  }
  if (reverseTraversal) {
    warnings.push(
      'Die Bonner OParl-Sammlung wird wegen unzuverlässiger created-Zeitstempel '
      + 'begrenzt von den neuesten Seiten rückwärts durchsucht; die fachliche '
      + 'Datumsgrenze wird lokal anhand des Vorgangsdatums geprüft.'
    );
  }
  if (unfilteredRetry) {
    warnings.push(
      'Die direkte Paper-Sammlung akzeptierte die optionalen OParl-Listenfilter nicht; '
      + 'der begrenzte Abruf wurde ohne diese Filter wiederholt.'
    );
  }
  if (excludedOutsideLookback > 0) {
    warnings.push(
      `${excludedOutsideLookback} Vorgang/Vorgänge außerhalb des konfigurierten `
      + 'Betrachtungszeitraums wurden nach dem Abruf verworfen.'
    );
  }
  if (paperList.truncated) {
    warnings.push(
      'Die OParl-Paper-Liste wurde am konfigurierten Seitenlimit abgeschnitten; '
      + 'ein offizieller Portal-Fallback ist erforderlich.'
    );
  }

  return {
    results,
    meta: {
      status,
      sourceType: 'oparl-1.1',
      sourceUrl: source.sourceUrl,
      bodyId: normalizeUrl(source.body.id),
      bodyName: source.body.name || source.body.shortName || 'Bonn',
      paperListUrl: normalizeUrl(source.paperListUrl),
      discoveryMode: source.discoveryMode,
      queryLog,
      pagesFetched: Number(source.bodyList.pagesFetched || 0) + paperList.pagesFetched,
      scanPagesFetched: Number(paperList.scanPagesFetched || paperList.pagesFetched || 0),
      discoveryPagesFetched: Number(paperList.discoveryPagesFetched || 0),
      traversalDirection: paperList.traversalDirection || 'forward',
      scannedItems: paperList.items.length,
      eligibleItems,
      excludedOutsideLookback,
      truncated: paperList.truncated,
      nextUrl: paperList.nextUrl || '',
      warnings,
    },
  };
}

module.exports = {
  SYSTEM_URL,
  DIRECT_PAPER_LIST_URL,
  PROVIDER_KEY,
  OParlClientError,
  OParlClientErrorCode,
  fetchJson,
  fetchExternalList,
  resolveBonnBody,
  meaningfulSearchTerms,
  matchedTermForPaper,
  matchedTermsForPaper,
  mapPaper,
  deduplicateByUrl,
  createdSinceIso,
  searchOparl,
  _internal: {
    positiveInteger,
    normalizeUrl,
    officialBonnUrl,
    assertAllowedNetworkUrl,
    appendQuery,
    parseListPage,
    normalizedSearchText,
    paperHaystack,
    matchedTermsForPaper,
    bestPaperUrl,
    paperSnippet,
    bodyScore,
    compactError,
    mayUseDirectPaperList,
    resolvePaperSource,
    isOfficialBonnPaperCollection,
    officialCollectionUrl,
    collectionLink,
    collectionPage,
    fetchOfficialBonnPaperList,
    paperWithinLookback,
    lookbackCutoffTime,
    fetchPaperList,
  },
};
