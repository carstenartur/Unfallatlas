'use strict';

const {
  fetchHtml,
  stripTags,
  decodeEntities,
  enrichWithReferenceModel,
  normCityKey,
} = require('./_portalUtils.js');
const {
  SYSTEM_URL: OPARL_SYSTEM_URL,
  searchOparl,
} = require('./bonnOparlClient.js');
const { officialBonnUrl } = require('./bonnOparlHttp.js');

const PORTAL_BASE = 'https://www.bonn.sitzung-online.de';
const SEARCH_PATH = '/public/tr010';
const DETAIL_DIR = '/public/';

const LEGACY_PORTAL_BASE = 'https://www2.bonn.de';
const LEGACY_SEARCH_PATH = '/bo_ris/ws_buergerinfo/suche.asp';
const LEGACY_DETAIL_DIR = '/bo_ris/ws_buergerinfo/';

const MAX_RESULTS = 20;
const PROVIDER_KEY = 'bonn-allris';

function supportsCity(city) {
  return normCityKey(city) === 'bonn';
}

function buildSitzungOnlineSearchUrl(term) {
  const params = new URLSearchParams({ q: term });
  return `${PORTAL_BASE}${SEARCH_PATH}?${params.toString()}`;
}

function buildSearchUrl(term) {
  const params = new URLSearchParams({
    SUCH: term,
    SUCH_OBJ: 'V',
    SUCHMAX: String(MAX_RESULTS),
  });
  return `${LEGACY_PORTAL_BASE}${LEGACY_SEARCH_PATH}?${params.toString()}`;
}

const buildLegacySearchUrl = buildSearchUrl;

function normalizeHref(href, portalBase, detailDir) {
  const decoded = decodeEntities(String(href || '')).trim();
  let candidate = '';
  if (/^https?:\/\//i.test(decoded)) candidate = decoded;
  else if (decoded.startsWith('/')) candidate = `${portalBase}${decoded}`;
  else {
    const cleaned = decoded.replace(/^\.?\/?/, '');
    candidate = /\.asp(?:\?|$)/i.test(cleaned)
      ? `${LEGACY_PORTAL_BASE}${LEGACY_DETAIL_DIR}${cleaned}`
      : `${portalBase}${detailDir}${cleaned}`;
  }
  return officialBonnUrl(candidate);
}

function parseResults(html, options = {}) {
  const results = [];
  const portalBase = options.portalBase || PORTAL_BASE;
  const detailDir = options.detailDir || DETAIL_DIR;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[1];
    const linkMatch = row.match(/<a\s+[^>]*href="([^"]*(?:vo|to|si|kp)0?\d+(?:\.asp)?[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1];
    const rawTitle = decodeEntities(stripTags(linkMatch[2])).trim();
    if (!rawTitle || rawTitle.length < 5) continue;

    const url = normalizeHref(href, portalBase, detailDir);
    if (!url) continue;

    const cells = [];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(row)) !== null) {
      cells.push(decodeEntities(stripTags(cellMatch[1])).trim());
    }

    let date = null;
    const datePattern = /\b(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})\b/;
    for (const cell of cells) {
      const dm = cell.match(datePattern);
      if (dm) { date = dm[1]; break; }
    }

    let gremium = null;
    const gremiumKeywords = /rat|ausschuss|bezirk|gremium|kommission|beirat|hauptausschuss/i;
    for (const cell of cells) {
      if (gremiumKeywords.test(cell) && cell.length < 120 && cell !== rawTitle) {
        gremium = cell;
        break;
      }
    }

    let number = null;
    const numberPattern = /\b(?:DS\s*|Drs\.\s*|Drs\s*)?(\d{4}[-/]\d{2,6}|\d{2,6}[-/]\d{4})\b/;
    for (const cell of cells) {
      const nm = cell.match(numberPattern);
      if (nm) { number = nm[0].trim(); break; }
    }

    const snippet = cells
      .filter(cell => cell && cell !== rawTitle && cell.length > 10)
      .slice(0, 3)
      .join(' | ') || null;

    results.push({
      title: rawTitle,
      url,
      date,
      gremium,
      number,
      snippet: snippet ? snippet.substring(0, 300) : null,
      rawType: cells.find(cell => /antrag|anfrage|beschluss|protokoll|antwort|vorlage|mitteilung/i.test(cell)) || '',
    });
  }

  return results.slice(0, MAX_RESULTS);
}

function cleanTerms(values) {
  const seen = new Set();
  const terms = [];
  for (const value of Array.isArray(values) ? values : []) {
    const term = String(value == null ? '' : value).trim();
    const key = normCityKey(term);
    if (!term || !key || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function providerSearchTerms(values) {
  const terms = cleanTerms(values);
  const specific = terms.filter(term => !['bonn', 'stadtbonn', 'bundesstadtbonn'].includes(normCityKey(term)));
  return specific.length ? specific : terms.slice(0, 1);
}

function absoluteHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function deduplicate(results) {
  const seen = new Set();
  const output = [];
  for (const result of Array.isArray(results) ? results : []) {
    const url = absoluteHttpUrl(result && result.url);
    const fallback = `${String(result && result.title || '').trim()}|${String(result && result.number || '').trim()}`;
    const key = url || fallback;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(result);
  }
  return output;
}

function safeError(error) {
  return {
    code: error && error.code ? String(error.code) : 'PROVIDER_ERROR',
    message: String(error && error.message || error || 'Unbekannter Providerfehler').slice(0, 300),
  };
}

function createProviderError(code, message, attempts) {
  const error = new Error(message);
  error.code = code;
  error.providerKey = PROVIDER_KEY;
  error.attempts = attempts;
  return error;
}

async function search(params = {}) {
  const terms = providerSearchTerms(params.searchTerms);
  if (!terms.length) {
    return {
      results: [],
      meta: {
        status: 'incomplete',
        sourceType: 'oparl-1.1',
        sourceUrl: OPARL_SYSTEM_URL,
        queryLog: [],
        pagesFetched: 0,
        scannedItems: 0,
        warnings: ['Keine belastbaren Suchbegriffe übergeben.'],
      },
    };
  }

  const fetchHtmlImpl = params.fetchHtmlImpl || fetchHtml;
  const searchOparlImpl = params.searchOparlImpl || searchOparl;
  const attempts = [];
  const warnings = [];
  const queryLog = [];
  const allResults = [];
  let oparlMeta = null;
  let oparlComplete = false;

  try {
    const oparl = await searchOparlImpl({
      searchTerms: terms,
      fetchJsonImpl: params.fetchJsonImpl,
      maxPages: params.maxOparlPages,
      pageLimit: params.oparlPageLimit,
      lookbackYears: params.oparlLookbackYears,
      now: params.now,
      requestOptions: params.requestOptions,
    });
    oparlMeta = oparl && oparl.meta || {};
    const oparlResults = Array.isArray(oparl && oparl.results) ? oparl.results : [];
    allResults.push(...oparlResults);
    queryLog.push(...(Array.isArray(oparlMeta.queryLog) ? oparlMeta.queryLog : []));
    warnings.push(...(Array.isArray(oparlMeta.warnings) ? oparlMeta.warnings : []));
    oparlComplete = oparlMeta.truncated !== true
      && ['results-found', 'searched-no-results'].includes(oparlMeta.status);
    attempts.push({
      source: 'bonn-oparl',
      sourceType: 'oparl-1.1',
      url: OPARL_SYSTEM_URL,
      status: oparlMeta.status || (oparlResults.length ? 'results-found' : 'searched-no-results'),
      count: oparlResults.length,
    });

    if (oparlComplete && oparlResults.length) {
      return {
        results: deduplicate(oparlResults),
        meta: {
          status: 'results-found',
          sourceType: 'oparl-1.1',
          sourceUrl: OPARL_SYSTEM_URL,
          queryLog,
          pagesFetched: Number(oparlMeta.pagesFetched || 0),
          scannedItems: Number(oparlMeta.scannedItems || 0),
          truncated: false,
          warnings,
          attempts,
        },
      };
    }
  } catch (error) {
    const failure = safeError(error);
    warnings.push(`OParl-Abruf fehlgeschlagen: ${failure.code}: ${failure.message}`);
    for (const term of terms) {
      queryLog.push({
        query: term,
        source: 'bonn-oparl',
        sourceType: 'oparl-1.1',
        url: OPARL_SYSTEM_URL,
        status: 'failed',
        error: failure,
      });
    }
    attempts.push({
      source: 'bonn-oparl',
      sourceType: 'oparl-1.1',
      url: OPARL_SYSTEM_URL,
      status: 'failed',
      error: failure,
    });
  }

  const coveredTerms = new Set();
  for (const term of terms) {
    const requests = [
      {
        url: buildSitzungOnlineSearchUrl(term),
        portalBase: PORTAL_BASE,
        detailDir: DETAIL_DIR,
        source: 'bonn-sitzung-online',
        sourceType: 'html-scraping',
      },
      {
        url: buildLegacySearchUrl(term),
        portalBase: LEGACY_PORTAL_BASE,
        detailDir: LEGACY_DETAIL_DIR,
        source: 'bonn-legacy-buergerinfo',
        sourceType: 'html-scraping-fallback',
      },
    ];

    for (const request of requests) {
      const logEntry = {
        query: term,
        source: request.source,
        sourceType: request.sourceType,
        url: request.url,
        status: 'started',
      };
      try {
        const html = await fetchHtmlImpl(request.url);
        const results = parseResults(html, request)
          .map(result => enrichWithReferenceModel(result, term));
        allResults.push(...results);
        coveredTerms.add(term);
        logEntry.status = results.length ? 'results-found' : 'searched-no-results';
        logEntry.count = results.length;
        queryLog.push(logEntry);
        attempts.push({ ...logEntry });
        break;
      } catch (error) {
        const failure = safeError(error);
        logEntry.status = 'failed';
        logEntry.error = failure;
        queryLog.push(logEntry);
        attempts.push({ ...logEntry });
        warnings.push(`${request.source} für „${term}“ fehlgeschlagen: ${failure.message}`);
      }
    }
  }

  const results = deduplicate(allResults);
  const htmlComplete = terms.every(term => coveredTerms.has(term));
  if (!oparlComplete && !htmlComplete) {
    throw createProviderError(
      results.length ? 'POLITICAL_PROVIDER_INCOMPLETE' : 'POLITICAL_PROVIDER_UNAVAILABLE',
      results.length
        ? 'Die Bonner politische Recherche lieferte nur unvollständige Teilergebnisse.'
        : 'Alle strukturierten und HTML-basierten Bonner Recherchequellen sind fehlgeschlagen.',
      attempts
    );
  }

  const hasOparlResult = results.some(result => result && result.sourceType === 'oparl-1.1');
  const hasHtmlResult = results.some(result => !result || result.sourceType !== 'oparl-1.1');
  const sourceType = hasOparlResult && hasHtmlResult
    ? 'oparl-1.1+html-fallback'
    : (hasOparlResult ? 'oparl-1.1' : 'html-scraping');
  const sourceUrl = hasOparlResult
    ? (oparlMeta && oparlMeta.sourceUrl || OPARL_SYSTEM_URL)
    : `${PORTAL_BASE}${DETAIL_DIR}`;

  return {
    results,
    meta: {
      status: results.length ? 'results-found' : 'searched-no-results',
      sourceType,
      sourceUrl,
      queryLog,
      pagesFetched: Number(oparlMeta && oparlMeta.pagesFetched || 0),
      scannedItems: Number(oparlMeta && oparlMeta.scannedItems || 0),
      truncated: Boolean(oparlMeta && oparlMeta.truncated),
      warnings: [...new Set(warnings.filter(Boolean))],
      attempts,
    },
  };
}

module.exports = {
  _key: PROVIDER_KEY,
  supportsCity,
  search,
  parseResults,
  buildSearchUrl,
  buildLegacySearchUrl,
  buildSitzungOnlineSearchUrl,
  normalizeHref,
  deduplicate,
  providerSearchTerms,
  OPARL_SYSTEM_URL,
};