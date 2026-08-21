'use strict';

/**
 * Structured OParl client for the official Bonn council-information system.
 *
 * OParl has no mandatory free-text search endpoint. We traverse the official
 * System -> Body -> Paper list, use standard list filters and match terms
 * locally. The crawl is bounded; truncation is incomplete evidence and must
 * be supplemented by the official portal fallback.
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

const SYSTEM_URL = 'https://www.bonn.sitzung-online.de/public/oparl/system';
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
    query: { limit: 100, omit_internal: 'true' },
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

function matchedTermForPaper(paper, terms) {
  const haystack = paperHaystack(paper);
  return haystack ? terms.find(term => haystack.includes(term.normalized)) || null : null;
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

function deduplicateByUrl(results) {
  const seen = new Set();
  return results.filter(result => {
    const key = normalizeUrl(result && result.url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  const paperList = await fetchExternalList(body.paper, {
    fetchJsonImpl,
    maxPages: positiveInteger(params.maxPages, DEFAULT_MAX_PAGES),
    query: {
      created_since: createdSinceIso(params.now, params.lookbackYears),
      omit_internal: 'true',
      limit: positiveInteger(params.pageLimit, DEFAULT_PAGE_LIMIT),
    },
    requestOptions: params.requestOptions,
  });

  const matches = [];
  const termCounts = new Map(terms.map(term => [term.normalized, 0]));
  for (const paper of paperList.items) {
    if (!paper || paper.deleted === true) continue;
    const matchedTerm = matchedTermForPaper(paper, terms);
    const mapped = matchedTerm && mapPaper(paper, matchedTerm);
    if (!mapped) continue;
    matches.push(mapped);
    termCounts.set(matchedTerm.normalized, (termCounts.get(matchedTerm.normalized) || 0) + 1);
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

  return {
    results,
    meta: {
      status,
      sourceType: 'oparl-1.1',
      sourceUrl: systemUrl,
      bodyId: normalizeUrl(body.id),
      bodyName: body.name || body.shortName || 'Bonn',
      paperListUrl: normalizeUrl(body.paper),
      queryLog,
      pagesFetched: bodyList.pagesFetched + paperList.pagesFetched,
      scannedItems: paperList.items.length,
      truncated: paperList.truncated,
      nextUrl: paperList.nextUrl || '',
      warnings: paperList.truncated
        ? ['Die OParl-Paper-Liste wurde am konfigurierten Seitenlimit abgeschnitten; ein offizieller Portal-Fallback ist erforderlich.']
        : [],
    },
  };
}

module.exports = {
  SYSTEM_URL,
  PROVIDER_KEY,
  OParlClientError,
  OParlClientErrorCode,
  fetchJson,
  fetchExternalList,
  resolveBonnBody,
  meaningfulSearchTerms,
  matchedTermForPaper,
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
    bestPaperUrl,
    paperSnippet,
    bodyScore,
  },
};