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
  officialHttpsUrl, paperDate, paperLocationGeometry, mapCataloguePaper,
} = require('./bonnOparlCatalogueRecord.js');
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
const CATALOGUE_TTL_MS = positiveInteger(process.env.BONN_OPARL_CACHE_TTL_MS, 5 * 60 * 1000);
const MAX_CATALOGUE_SCOPES = 2;
const MAX_CATALOGUE_CACHE_BYTES = positiveInteger(process.env.BONN_OPARL_CACHE_MAX_BYTES, 64 * 1024 * 1024);
// The official archive already has roughly 25,000 papers.
const MAX_CATALOGUE_CACHE_ITEMS = positiveInteger(process.env.BONN_OPARL_CACHE_MAX_ITEMS, 60_000);
const pendingCatalogueReads = new Map();
const catalogueSnapshots = new Map();

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

function bestPaperUrl(paper, normalize = officialBonnUrl) {
  return [
    paper && paper.web,
    paper && paper.mainFile && paper.mainFile.web,
    paper && paper.id,
    paper && paper.mainFile && paper.mainFile.accessUrl,
    paper && paper.mainFile && paper.mainFile.downloadUrl,
  ].map(normalize).find(Boolean) || '';
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
    date: paper.date || (paper.modified ? String(paper.modified).slice(0, 10) : null),
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

function isScalar(value) {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function pickScalars(object, keys) {
  const projected = {};
  for (const key of keys) {
    const value = object?.[key];
    if (isScalar(value)) projected[key] = value;
  }
  return projected;
}

function projectObjectOrList(value, project) {
  return Array.isArray(value) ? value.map(project).filter(Boolean) : project(value);
}

function projectLocation(location) {
  if (!location || typeof location !== 'object') return null;
  const projected = pickScalars(location, ['description', 'streetAddress', 'locality', 'deleted']);
  const geometry = location.deleted === true ? null : paperLocationGeometry(location.geojson);
  if (geometry) {
    const name = location.geojson.properties?.name;
    projected.geojson = typeof name === 'string' ? { ...geometry, properties: { name } } : geometry;
  }
  return geometry || projected.description || projected.streetAddress || projected.locality ? projected : null;
}

function projectConsultation(consultation) {
  const organization = projectObjectOrList(consultation?.organization, value => {
    const names = pickScalars(value, ['name', 'shortName']);
    return names.name || names.shortName ? names : null;
  });
  return organization && (!Array.isArray(organization) || organization.length) ? { organization } : null;
}

function projectRelation(value) {
  const id = typeof value === 'object' ? value?.id : value;
  return typeof id === 'string' ? id : null;
}

function projectPaper(paper) {
  // Search and catalogue consumers share this subset. Project each page before
  // accumulating it, so unrelated embedded objects do not live through a crawl.
  if (!paper || typeof paper !== 'object') return paper ? {} : null;
  if (paper.deleted === true) return pickScalars(paper, ['id', 'deleted']);
  const projected = pickScalars(paper, [
    'id', 'web', 'name', 'reference', 'paperType', 'date', 'modified', 'gremium', 'organizationName',
  ]);
  if (Array.isArray(paper.keyword)) projected.keyword = paper.keyword.filter(isScalar);
  if (paper.mainFile) {
    projected.mainFile = pickScalars(paper.mainFile, ['name', 'fileName', 'web', 'accessUrl', 'downloadUrl']);
  }
  if (Array.isArray(paper.auxiliaryFile)) {
    projected.auxiliaryFile = paper.auxiliaryFile.map(value => pickScalars(value, ['name', 'fileName']))
      .filter(file => file.name || file.fileName);
  }
  if (paper.location) projected.location = projectObjectOrList(paper.location, projectLocation);
  if (paper.consultation) projected.consultation = projectObjectOrList(paper.consultation, projectConsultation);
  if (paper.superordinatedPaper) {
    projected.superordinatedPaper = projectObjectOrList(paper.superordinatedPaper, projectRelation);
  }
  if (paper.relatedPaper) projected.relatedPaper = projectObjectOrList(paper.relatedPaper, projectRelation);
  return projected;
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

function collectionPath(url) {
  return url.pathname.replace(/^\/public(?=\/oparl\/)/, '').replace(/\/$/, '');
}

function isOfficialBonnPaperCollection(urlValue) {
  const normalized = normalizeUrl(urlValue);
  if (!normalized) return false;
  const url = new URL(normalized);
  return ['www.bonn.sitzung-online.de', 'bonn.sitzung-online.de']
    .includes(url.hostname.toLowerCase())
    && /^\/oparl\/bodies\/\d+\/papers$/.test(collectionPath(url));
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
  if (!raw) return '';
  const target = new URL(assertAllowedNetworkUrl(normalizeUrl(raw, currentUrl)));
  const page = Number(target.searchParams.get('page') ?? '1');
  if (!isOfficialBonnPaperCollection(target.href) || collectionPath(target) !== collectionPath(new URL(currentUrl))
      || !Number.isSafeInteger(page) || page < 1) {
    throw new OParlClientError(
      OParlClientErrorCode.INVALID_LIST,
      `Ungültiger ${key}-Link in der Bonner OParl-Paginierung: ${target.href}`,
      { url: currentUrl }
    );
  }
  return officialCollectionUrl(currentUrl, pageSize, page);
}

function collectionPage(payload, currentUrl, pageSize) {
  const requestedPage = Number(new URL(currentUrl).searchParams.get('page'));
  const parsed = parseListPage(payload, currentUrl);
  const { currentPage, totalPages } = parsed.pagination;
  let previous = collectionLink(payload, 'prev', currentUrl, pageSize);
  let last = collectionLink(payload, 'last', currentUrl, pageSize);
  const next = collectionLink(payload, 'next', currentUrl, pageSize);
  if ((!Array.isArray(payload) && !Array.isArray(payload.data))
      || (currentPage != null && Number(currentPage) !== requestedPage)
      || (previous && previous !== officialCollectionUrl(currentUrl, pageSize, requestedPage - 1))
      || (next && next !== officialCollectionUrl(currentUrl, pageSize, requestedPage + 1))) {
    throw new OParlClientError(
      OParlClientErrorCode.INVALID_LIST,
      `Inkonsistente Seitennummern in der Bonner OParl-Paginierung: ${currentUrl}`,
      { url: currentUrl }
    );
  }
  if (!previous && requestedPage > 1) {
    previous = officialCollectionUrl(currentUrl, pageSize, requestedPage - 1);
  }
  if (!last && positiveInteger(totalPages, 0)) {
    last = officialCollectionUrl(currentUrl, pageSize, Number(totalPages));
  }
  return { ...parsed, data: parsed.data.map(projectPaper), next, previous, last };
}

async function fetchOfficialBonnPaperList(source, params, fetchJsonImpl) {
  const maxScanPages = positiveInteger(params.maxPages, DEFAULT_BONN_MAX_SCAN_PAGES);
  const pageSize = Math.min(
    MAX_BONN_PAGE_SIZE,
    positiveInteger(params.pageLimit, DEFAULT_PAGE_LIMIT)
  );
  const requestOptions = params.requestOptions || {};
  const firstUrl = officialCollectionUrl(source.paperListUrl, pageSize, 1);
  const firstPage = collectionPage(await fetchJsonImpl(firstUrl, requestOptions), firstUrl, pageSize);
  const cache = new Map([[firstUrl, firstPage]]);
  const visited = new Set();
  const items = [];
  let pages = [];
  let requests = 1;
  // OParl only requires `next`. Bonn normally supplies `last` as well.
  const newestFirst = !firstPage.next || Boolean(firstPage.last && firstPage.last !== firstUrl);
  const startUrl = newestFirst ? firstPage.last || firstUrl : firstUrl;
  const checkpoint = params.checkpoint;
  const checkpointScope = `official-pages:${firstUrl}`;
  const sourceKey = 'bonn-oparl';
  const checkpointRevision = 'bonn-pages-v1';
  const checkpointYear = new Date(params.now ?? Date.now()).getUTCFullYear();
  const sourceRevision = JSON.stringify([firstPage.data, firstPage.last, firstPage.pagination]);
  let cursor;
  let cursorYear;
  const cursors = [];
  if (checkpoint) {
    for (const year of await checkpoint.years(sourceKey, `${checkpointScope}:cursor`)) {
      const state = await checkpoint.read(sourceKey, `${checkpointScope}:cursor`, year, checkpointRevision);
      if (state) cursors.push({ year, state });
    }
    const selected = cursors.find(entry => entry.year === checkpointYear) || cursors.at(-1);
    cursor = selected?.state;
    cursorYear = selected?.year;
  }
  const annual = new Map();
  if (checkpoint) {
    for (const year of await checkpoint.years(sourceKey, checkpointScope)) {
      const state = await checkpoint.read(sourceKey, checkpointScope, year, checkpointRevision);
      if (state) annual.set(year, state);
    }
  }
  async function reconcilePapers(papers, undatedYear = checkpointYear) {
    const changed = new Set();
    for (const paper of papers) {
      if (!paper?.id) continue;
      // A Paper ID is stable across corrected/unknown dates and tombstones.
      // Remove every old bucket copy before installing the observed revision.
      for (const [year, state] of annual) {
        if (Object.hasOwn(state.papers, paper.id)) { delete state.papers[paper.id]; changed.add(year); }
      }
      const date = paperDate(paper);
      const year = date ? Number(date.slice(0, 4)) : undatedYear;
      const state = annual.get(year) || { papers: {} };
      state.papers[paper.id] = paper;
      annual.set(year, state); changed.add(year);
    }
    for (const year of changed) await checkpoint.write(sourceKey, checkpointScope, year, checkpointRevision, annual.get(year));
  }
  // Journals outlive their calendar year. Replay every outstanding page in
  // chronological order before consuming partially updated annual records.
  // Undated Papers/tombstones retain the original transaction's bucket year.
  let recoveredPage = false;
  for (const entry of cursors.sort((a, b) => a.year - b.year)) {
    if (!entry.state.pendingPage) continue;
    await reconcilePapers(entry.state.pendingPage, entry.year);
    const { pendingPage, ...completed } = entry.state;
    await checkpoint.write(sourceKey, `${checkpointScope}:cursor`, entry.year, checkpointRevision, completed);
    if (!cursor || entry.year >= cursorYear) { cursor = completed; cursorYear = entry.year; }
    recoveredPage = true;
  }
  const resume = cursor?.sourceRevision === sourceRevision && (cursor.nextUrl || recoveredPage);
  let currentUrl = resume ? cursor.nextUrl : startUrl;
  if (resume) pages = cursor.pages;
  const budget = params.workBudget ?? maxScanPages;
  if (!Number.isSafeInteger(budget) || budget < 0) throw new TypeError('Invalid RIS work budget');
  const deadline = performance.now() + (params.maxDurationMs ?? 18 * 60_000);
  let scanPagesFetched = 0;

  while (currentUrl && scanPagesFetched < maxScanPages && scanPagesFetched < budget && performance.now() < deadline) {
    currentUrl = officialCollectionUrl(currentUrl, pageSize);
    if (visited.has(currentUrl)) {
      throw new OParlClientError(
        OParlClientErrorCode.PAGINATION_CYCLE,
        `Die Bonner OParl-Paginierung enthält einen Zyklus: ${currentUrl}`,
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
    if (newestFirst && currentUrl === startUrl && page.next) {
      throw new OParlClientError(
        OParlClientErrorCode.INVALID_LIST,
        `Die gemeldete letzte Bonner OParl-Seite verweist auf eine weitere Seite: ${currentUrl}`,
        { url: currentUrl }
      );
    }
    items.push(...page.data);
    pages.push({
      url: currentUrl,
      count: page.data.length,
      pagination: page.pagination,
    });
    scanPagesFetched += 1;
    currentUrl = newestFirst ? page.previous : page.next;
    if (checkpoint) {
      const completed = { sourceRevision, nextUrl: currentUrl || '', pages, complete: !currentUrl,
        checkedAt: new Date(params.now ?? Date.now()).toISOString() };
      await checkpoint.write(sourceKey, `${checkpointScope}:cursor`, checkpointYear, checkpointRevision, { ...completed, pendingPage: page.data });
      await reconcilePapers(page.data);
      await checkpoint.write(sourceKey, `${checkpointScope}:cursor`, checkpointYear, checkpointRevision, completed);
    }
  }

  return {
    items: checkpoint ? [...annual.values()].flatMap(state => Object.values(state.papers)) : items,
    ...(checkpoint ? { retainedHistoricalFrom: [...annual.keys()].sort((a, b) => a - b)[0] } : {}),
    pages,
    pagesFetched: requests,
    scanPagesFetched,
    discoveryPagesFetched: 1,
    traversalDirection: newestFirst ? 'newest-first' : 'forward',
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
    mapItem: projectPaper,
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

function paperListWarnings(paperList, pages) {
  const warnings = [];
  if (pages.some(page => page.count === 0)) {
    warnings.push('Die Bonner OParl-Paper-Liste enthält mindestens eine leere Seite.');
  }
  if (!paperList.truncated && pages.some(({ pagination }) => (
    (pagination.totalElements != null && Number(pagination.totalElements) !== paperList.items.length)
    || (pagination.totalPages != null && Number(pagination.totalPages) !== pages.length)
  ))) {
    warnings.push('Die gemeldeten Summen der Bonner OParl-Paginierung stimmen nicht mit dem Abruf überein.');
  }
  const ids = new Set();
  for (const paper of paperList.items) {
    const id = normalizeUrl(paper && paper.id);
    if (!id) continue;
    if (ids.has(id)) {
      warnings.push('Die Bonner OParl-Paginierung lieferte mehrfach dieselbe Vorgangs-ID.');
      break;
    }
    ids.add(id);
  }
  return warnings;
}

function assertCurrentBonnHttpsUrl(value) {
  const url = assertAllowedNetworkUrl(value);
  if (!officialHttpsUrl(url)) {
    throw new OParlClientError(OParlClientErrorCode.INVALID_URL, 'Ungültige Bonner OParl-HTTPS-URL.');
  }
  return url;
}

function officialJsonFetcher(fetchJsonImpl) {
  return (value, options) => fetchJsonImpl(assertCurrentBonnHttpsUrl(value), options);
}

function projectSource({ body, bodyList, ...metadata }) {
  return {
    ...metadata,
    body: pickScalars(body, ['id', 'name', 'shortName']),
    bodyList: { pagesFetched: bodyList.pagesFetched, truncated: bodyList.truncated },
  };
}

async function readPaperCatalogue(params, systemUrl, fetchJsonImpl) {
  const source = projectSource(await resolvePaperSource(params, fetchJsonImpl, systemUrl));
  const { paperList: { pages, ...paperList }, ...listMetadata } = await fetchPaperList(source, params, fetchJsonImpl);
  return {
    source,
    paperList,
    ...listMetadata,
    listWarnings: paperListWarnings(paperList, pages),
  };
}

function pruneCatalogueSnapshots(now) {
  for (const [scope, entry] of catalogueSnapshots) {
    if (entry.expiresAt <= now) catalogueSnapshots.delete(scope);
  }
}

function retainCatalogueSnapshot(key, catalogue) {
  const { items, ...listMetadata } = catalogue.paperList;
  if (items.length > MAX_CATALOGUE_CACHE_ITEMS) return;
  // Count the UTF-8 JSON footprint one paper at a time, without building a
  // second archive-sized string. The item limit also bounds row overhead.
  let bytes = Buffer.byteLength(key) + Buffer.byteLength(
    JSON.stringify({ ...catalogue, paperList: { ...listMetadata, items: [] } })
  );
  if (bytes > MAX_CATALOGUE_CACHE_BYTES) return;
  for (const item of items) {
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > MAX_CATALOGUE_CACHE_BYTES) return;
  }

  const now = Date.now();
  pruneCatalogueSnapshots(now);
  let totalBytes = bytes;
  let totalItems = items.length;
  for (const entry of catalogueSnapshots.values()) {
    totalBytes += entry.bytes;
    totalItems += entry.catalogue.paperList.items.length;
  }
  for (const [scope, entry] of catalogueSnapshots) {
    if (catalogueSnapshots.size < MAX_CATALOGUE_SCOPES
        && totalBytes <= MAX_CATALOGUE_CACHE_BYTES
        && totalItems <= MAX_CATALOGUE_CACHE_ITEMS) break;
    catalogueSnapshots.delete(scope);
    totalBytes -= entry.bytes;
    totalItems -= entry.catalogue.paperList.items.length;
  }
  catalogueSnapshots.set(key, { catalogue, bytes, expiresAt: now + CATALOGUE_TTL_MS });
}

function loadPaperCatalogue(params, systemUrl, officialOnly = false) {
  if (params.fetchJsonImpl) {
    const fetchJsonImpl = officialOnly ? officialJsonFetcher(params.fetchJsonImpl) : params.fetchJsonImpl;
    return readPaperCatalogue(params, systemUrl, fetchJsonImpl);
  }

  const request = params.requestOptions || {};
  const key = JSON.stringify([
    systemUrl, normalizeUrl(params.directPaperListUrl) || String(params.directPaperListUrl || ''),
    positiveInteger(params.maxBodyPages, 3),
    positiveInteger(params.maxPages, null), positiveInteger(params.pageLimit, DEFAULT_PAGE_LIMIT),
    createdSinceIso(params.now, params.lookbackYears),
    request.timeoutMs, request.maxBytes, request.maxRedirects, request.redirectCount,
  ]);
  pruneCatalogueSnapshots(Date.now());
  const cached = catalogueSnapshots.get(key);
  if (cached) return cached.catalogue;
  const inFlight = pendingCatalogueReads.get(key);
  if (inFlight) return inFlight;

  const pending = readPaperCatalogue(params, systemUrl, officialJsonFetcher(fetchJson))
    .then(catalogue => {
      const { source, paperList, listWarnings } = catalogue;
      if (!paperList.truncated && !source.bodyList.truncated && !listWarnings.length) {
        retainCatalogueSnapshot(key, catalogue);
      }
      return catalogue;
    })
    .finally(() => { pendingCatalogueReads.delete(key); });
  pendingCatalogueReads.set(key, pending);
  return pending;
}

function discoveryWarning(source) {
  const error = source.discoveryError;
  return error && `Das OParl-Systemdokument war nicht nutzbar (${error.code}: `
    + `${error.message}); die offizielle direkte Paper-Sammlung wurde verwendet.`;
}

async function collectBonnCatalogue(params = {}) {
  const systemUrl = officialHttpsUrl(params.systemUrl || SYSTEM_URL);
  const sources = systemUrl ? [systemUrl] : [];
  const coverage = { from: null, to: null, bodies: [], complete: false, warnings: [] };
  const records = [];
  try {
    const url = systemUrl || assertCurrentBonnHttpsUrl(params.systemUrl || SYSTEM_URL);
    const { source, paperList, listWarnings } = await loadPaperCatalogue(params, url, true);
    sources.splice(0, sources.length, ...new Set([source.sourceUrl, source.paperListUrl]));
    const sourceOrigins = new Set(sources.map(value => new URL(value).origin));
    coverage.bodies.push(String(source.body.name || source.body.shortName || 'Bonn').trim());
    if (source.discoveryError) coverage.warnings.push(discoveryWarning(source));
    coverage.warnings.push(...listWarnings);
    if (source.bodyList.truncated) coverage.warnings.push('Die Bonner OParl-Body-Liste wurde am Seitenlimit abgeschnitten.');
    if (paperList.truncated) coverage.warnings.push('Die Bonner OParl-Paper-Liste wurde am Seitenlimit abgeschnitten.');

    const requestedCutoff = createdSinceIso(params.now, params.lookbackYears).slice(0, 10);
    const retainedCutoff = paperList.retainedHistoricalFrom ? `${paperList.retainedHistoricalFrom}-01-01` : requestedCutoff;
    const cutoff = retainedCutoff < requestedCutoff ? retainedCutoff : requestedCutoff;
    const seen = new Set();
    let invalidRecords = 0;
    for (const paper of paperList.items) {
      if (paper && paper.deleted === true) continue;
      const date = paper ? paperDate(paper) : null;
      if (date && date < cutoff) continue;
      const record = paper && mapCataloguePaper(paper, bestPaperUrl(paper, officialHttpsUrl), PROVIDER_KEY, date);
      if (!record) {
        invalidRecords += 1;
        continue;
      }
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      records.push(record);
      const origin = new URL(record.url).origin;
      if (!sourceOrigins.has(origin)) {
        sources.push(`${origin}/`);
        sourceOrigins.add(origin);
      }
      if (date && (!coverage.from || date < coverage.from)) coverage.from = date;
      if (date && (!coverage.to || date > coverage.to)) coverage.to = date;
    }
    if (invalidRecords) coverage.warnings.push(`${invalidRecords} Bonner OParl-Vorgänge konnten nicht übernommen werden.`);
    if (!records.length) coverage.warnings.push('Die Bonner OParl-Sammlung lieferte keine nutzbaren Vorgänge im Betrachtungszeitraum.');
    coverage.complete = records.length > 0 && !invalidRecords && !source.bodyList.truncated
      && !paperList.truncated && !listWarnings.length;
  } catch (error) {
    const failure = compactError(error);
    coverage.warnings.push(`Bonner OParl-Abruf fehlgeschlagen (${failure.code}: ${failure.message}).`);
  }
  return { records, sources, coverage };
}

async function searchOparl(params = {}) {
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

  const { source, paperList, unfilteredRetry, reverseTraversal, listWarnings } = await loadPaperCatalogue(params, systemUrl);
  queryLog.forEach(entry => { entry.url = source.paperListUrl; });

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
  const incomplete = paperList.truncated || source.bodyList.truncated || (reverseTraversal && listWarnings.length > 0);
  const status = incomplete
    ? (results.length ? 'partial-results' : 'incomplete')
    : (results.length ? 'results-found' : 'searched-no-results');
  queryLog.forEach((entry, index) => {
    const count = termCounts.get(terms[index].normalized) || 0;
    entry.count = count;
    entry.status = incomplete
      ? (count ? 'partial-results' : 'incomplete')
      : (count ? 'results-found' : 'searched-no-results');
  });

  const warnings = [];
  if (source.discoveryError) {
    warnings.push(discoveryWarning(source));
  }
  if (reverseTraversal) {
    warnings.push(
      'Die Bonner OParl-Sammlung wird wegen unzuverlässiger created-Zeitstempel '
      + (paperList.traversalDirection === 'newest-first' ? 'begrenzt von den neuesten Seiten rückwärts durchsucht; ' : 'seitenweise durchsucht; ')
      + 'die fachliche '
      + 'Datumsgrenze wird lokal anhand des Vorgangsdatums geprüft.'
    );
    warnings.push(...listWarnings);
  }
  if (source.bodyList.truncated) {
    warnings.push('Die Bonner OParl-Body-Liste wurde am konfigurierten Seitenlimit abgeschnitten.');
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
      truncated: incomplete,
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
  collectBonnCatalogue,
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
