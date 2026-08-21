'use strict';

/**
 * Zentrale serverseitige Orchestrierung der politischen Kontextrecherche.
 *
 * Provider dürfen weiterhin das historische Array-Format zurückgeben. Neue,
 * evidenzfähige Provider können zusätzlich `{ results, meta }` liefern. Die
 * Meta-Daten werden defensiv normalisiert und zusammen mit dem Suchergebnis
 * transportiert, damit „keine Treffer“ von „Quelle nicht vollständig
 * erreichbar“ getrennt bleibt und der KI-Handoff ein reproduzierbares
 * Suchprotokoll erhält.
 *
 * @module server/political-context/services/portalSearchService
 */

const { getProviderForCity }   = require('../registry/cityPortalRegistry.js');
const { normalizeAll }         = require('./portalNormalizationService.js');
const { scoreAndSort }         = require('./portalRelevanceService.js');
const { buildSearchVariants }  = require('./searchVariantBuilder.js');
const { enrichAllWithTrafficRelevance } = require('./trafficRelevanceService.js');
const { enrichAllWithAiGating }         = require('./aiGatingService.js');
const { sharedCache: searchCache, buildKey: buildCacheKey } =
  require('./portalSearchCache.js');

const VALID_SEARCH_STATUS = new Set([
  'results-found',
  'searched-no-results',
  'partial-results',
  'incomplete',
  'failed',
  'unsupported',
]);

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

function absoluteHttpUrl(value) {
  try {
    const url = new URL(clean(value, 2_000));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function normalizeQueryLog(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 100).map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const query = clean(entry.query || entry.term || entry.searchTerm, 300);
    const source = clean(entry.source || entry.provider || entry.providerKey, 120);
    const sourceType = clean(entry.sourceType || entry.type, 80);
    const url = absoluteHttpUrl(entry.url || entry.sourceUrl || entry.portalUrl);
    const status = clean(entry.status, 80);
    const error = entry.error && typeof entry.error === 'object'
      ? {
          code: clean(entry.error.code, 100),
          message: clean(entry.error.message, 300),
        }
      : undefined;
    if (!query && !source && !url) return null;
    return {
      query,
      source: source || 'political-context-provider',
      sourceType: sourceType || 'unspecified',
      url,
      ...(status ? { status } : {}),
      ...(entry.count != null ? { count: nonNegativeInteger(entry.count) } : {}),
      ...(error && (error.code || error.message) ? { error } : {}),
    };
  }).filter(Boolean);
}

function normalizeWarnings(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(value => clean(value, 500)).filter(Boolean))].slice(0, 30);
}

function normalizeAttempts(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(0, 100).map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const normalized = {
      source: clean(entry.source, 120) || 'political-context-provider',
      sourceType: clean(entry.sourceType, 80) || 'unspecified',
      url: absoluteHttpUrl(entry.url),
      status: clean(entry.status, 80) || 'unknown',
    };
    if (entry.query != null) normalized.query = clean(entry.query, 300);
    if (entry.count != null) normalized.count = nonNegativeInteger(entry.count);
    if (entry.error && typeof entry.error === 'object') {
      normalized.error = {
        code: clean(entry.error.code, 100),
        message: clean(entry.error.message, 300),
      };
    }
    return normalized;
  }).filter(Boolean);
}

function unwrapProviderResult(value) {
  if (Array.isArray(value)) {
    return { rawResults: value, providerMeta: {} };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value.results) === false) {
    const error = new Error('Portal-Provider lieferte weder ein Array noch { results, meta }.');
    error.code = 'POLITICAL_PROVIDER_INVALID_RESPONSE';
    throw error;
  }
  return {
    rawResults: value.results,
    providerMeta: value.meta && typeof value.meta === 'object' && !Array.isArray(value.meta)
      ? value.meta
      : {},
  };
}

function normalizeProviderMeta(metaValue, fallbackStatus) {
  const meta = metaValue && typeof metaValue === 'object' && !Array.isArray(metaValue)
    ? metaValue
    : {};
  const requestedStatus = clean(meta.status || meta.searchStatus, 80);
  const searchStatus = VALID_SEARCH_STATUS.has(requestedStatus)
    ? requestedStatus
    : fallbackStatus;
  return {
    searchStatus,
    sourceType: clean(meta.sourceType, 80) || null,
    sourceUrl: absoluteHttpUrl(meta.sourceUrl) || null,
    queryLog: normalizeQueryLog(meta.queryLog),
    pagesFetched: nonNegativeInteger(meta.pagesFetched),
    scannedItems: nonNegativeInteger(meta.scannedItems),
    truncated: meta.truncated === true,
    warnings: normalizeWarnings(meta.warnings),
    attempts: normalizeAttempts(meta.attempts),
  };
}

/**
 * Führt eine vollständige Recherche durch.
 *
 * @param {object} params
 * @returns {Promise<object>} PoliticalReferenceSearchResult
 */
async function search(params) {
  const {
    city            = '',
    searchTerms     = [],
    context         = {},
    maxResults      = 10,
    expandVariants  = true,
    useCache        = true,
    cache           = searchCache,
  } = params || {};

  const searchedAt = new Date().toISOString();
  const cacheUsable = Boolean(useCache && cache && typeof cache.get === 'function');
  const provider = getProviderForCity(city);

  if (!provider) {
    return {
      references: [],
      meta: {
        city,
        searchTerms,
        searchedAt,
        totalFound: 0,
        providerKey: null,
        supported: false,
        searchStatus: 'unsupported',
        sourceType: null,
        sourceUrl: null,
        queryLog: [],
        pagesFetched: 0,
        scannedItems: 0,
        truncated: false,
        warnings: [],
        attempts: [],
        cache: { hit: false, enabled: cacheUsable },
      },
    };
  }

  const providerKey = typeof provider._key === 'string' && provider._key
    ? provider._key
    : 'unknown';

  const cacheKey = cacheUsable
    ? buildCacheKey({ city, searchTerms, context, maxResults, expandVariants })
    : null;
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      return {
        references: cached.references,
        meta: {
          ...cached.meta,
          searchedAt,
          cache: { hit: true, enabled: true, key: cacheKey },
        },
      };
    }
  }

  const effectiveTerms = expandVariants
    ? buildSearchVariants(searchTerms, context)
    : searchTerms;

  const providerValue = await provider.search({
    city,
    searchTerms: effectiveTerms,
    context,
  });
  const { rawResults, providerMeta } = unwrapProviderResult(providerValue);

  const normalized = normalizeAll(rawResults, providerKey);
  const scored = scoreAndSort(normalized, searchTerms, context);
  const withTraffic = enrichAllWithTrafficRelevance(scored);
  const withGating  = enrichAllWithAiGating(withTraffic, context);
  const trimmed = withGating.slice(0, Math.max(0, maxResults));
  const fallbackStatus = normalized.length ? 'results-found' : 'searched-no-results';
  const evidenceMeta = normalizeProviderMeta(providerMeta, fallbackStatus);

  const result = {
    references: trimmed,
    meta: {
      city,
      searchTerms,
      searchedAt,
      totalFound: normalized.length,
      providerKey,
      supported: true,
      ...evidenceMeta,
      cache: {
        hit: false,
        enabled: Boolean(cacheKey),
        ...(cacheKey ? { key: cacheKey } : {}),
      },
    },
  };

  if (cacheKey) {
    try {
      cache.set(cacheKey, {
        references: result.references,
        meta: { ...result.meta, cache: undefined },
      });
    } catch (_) { /* Cache-Fehler dürfen die Antwort nicht stören */ }
  }

  return result;
}

module.exports = {
  search,
  unwrapProviderResult,
  normalizeProviderMeta,
  normalizeQueryLog,
};