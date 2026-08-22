'use strict';

const client = require('./bonnOparlClient.js');
const httpContract = require('./bonnOparlHttp.js');
const {
  sharedBonnOparlCatalogueStore,
} = require('../services/bonnOparlCatalogueStore.js');

const PROVIDER_KEY = 'bonn-oparl';

function catalogueStoreFor(params, fetchJsonImpl) {
  if (params.catalogueStore && typeof params.catalogueStore.getOrRefresh === 'function') {
    return params.catalogueStore;
  }
  if (params.catalogueCache === false) return null;
  // A custom fetcher normally belongs to one deterministic test/request and
  // must never contaminate the process-wide production snapshot. Tests that
  // explicitly need cache behaviour inject their own catalogueStore.
  if (fetchJsonImpl !== httpContract.fetchJson) return null;
  return sharedBonnOparlCatalogueStore;
}

function sourceMetadata(source) {
  return {
    sourceUrl: source.sourceUrl,
    paperListUrl: source.paperListUrl,
    discoveryMode: source.discoveryMode,
    discoveryError: source.discoveryError || null,
    bodyId: httpContract.normalizeUrl(source.body && source.body.id),
    bodyName: source.body && (source.body.name || source.body.shortName) || 'Bonn',
    bodyPagesFetched: Number(source.bodyList && source.bodyList.pagesFetched || 0),
  };
}

function cacheConfiguration(sourceUrl, params) {
  const pageSize = Math.min(
    100,
    client._internal.positiveInteger(params.pageLimit, 100)
  );
  return {
    collectionUrl: sourceUrl,
    pageSize,
    maxScanPages: client._internal.positiveInteger(params.maxPages, 300),
    businessDateCutoff: client.createdSinceIso(params.now, params.lookbackYears),
  };
}

function cacheNetworkPages(metadata, snapshot) {
  return ['miss', 'refresh'].includes(metadata.cacheStatus)
    ? Number(snapshot.pagesFetched || 0)
    : 0;
}

function cacheWarnings(metadata) {
  if (!metadata || !metadata.stale) return [];
  const error = metadata.refreshError;
  return [
    'Der Bonner OParl-Katalog konnte nicht aktualisiert werden. '
    + `Es wird ein ${Math.round(metadata.ageMs / 1000)} Sekunden alter, ausdrücklich `
    + 'als veraltet markierter Snapshot verwendet; ein vollständiger Nulltreffer ist damit nicht zulässig.'
    + (error ? ` (${error.code}: ${error.message})` : ''),
  ];
}

async function searchCachedOparl(params = {}) {
  const fetchJsonImpl = params.fetchJsonImpl || httpContract.fetchJson;
  const store = catalogueStoreFor(params, fetchJsonImpl);
  if (!store) return client.searchOparl(params);

  const systemUrl = httpContract.normalizeUrl(params.systemUrl || client.SYSTEM_URL);
  if (!systemUrl) {
    throw new client.OParlClientError(
      client.OParlClientErrorCode.INVALID_URL,
      `Ungültige OParl-System-URL: ${String(params.systemUrl || client.SYSTEM_URL)}`,
      { systemUrl: String(params.systemUrl || client.SYSTEM_URL) }
    );
  }

  const terms = client.meaningfulSearchTerms(params.searchTerms);
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
        status: 'incomplete',
        sourceType: 'oparl-1.1',
        sourceUrl: systemUrl,
        queryLog: [],
        pagesFetched: 0,
        scannedItems: 0,
        truncated: false,
        warnings: ['Keine orts- oder themenspezifischen Suchbegriffe für die OParl-Suche.'],
      },
    };
  }

  // The production store is scoped to Bonn's official paper collection. A
  // custom system/direct collection keeps the original fully validated path.
  const expectedCollection = httpContract.normalizeUrl(
    params.directPaperListUrl || client.DIRECT_PAPER_LIST_URL
  );
  if (!client._internal.isOfficialBonnPaperCollection(expectedCollection)) {
    return client.searchOparl(params);
  }

  const loaded = await store.getOrRefresh(
    cacheConfiguration(expectedCollection, params),
    async () => {
      const source = await client._internal.resolvePaperSource(
        params,
        fetchJsonImpl,
        systemUrl
      );
      if (!client._internal.isOfficialBonnPaperCollection(source.paperListUrl)) {
        const error = new Error(
          `Catalogue cache only supports Bonn's official paper collection: ${source.paperListUrl}`
        );
        error.code = 'OPARL_CATALOGUE_CACHE_UNSUPPORTED_SOURCE';
        throw error;
      }
      const paperList = await client._internal.fetchOfficialBonnPaperList(
        source,
        params,
        fetchJsonImpl
      );
      return {
        ...paperList,
        sourceUrl: source.paperListUrl,
        provider: sourceMetadata(source),
      };
    }
  );

  const snapshot = loaded.snapshot;
  const catalogue = loaded.metadata;
  const provider = snapshot.provider || {
    sourceUrl: systemUrl,
    paperListUrl: snapshot.sourceUrl,
    discoveryMode: 'catalogue-snapshot',
    discoveryError: null,
    bodyId: '',
    bodyName: 'Bonn',
    bodyPagesFetched: 0,
  };

  queryLog.forEach(entry => { entry.url = snapshot.sourceUrl; });
  const matches = [];
  const termCounts = new Map(terms.map(term => [term.normalized, 0]));
  let excludedOutsideLookback = 0;
  let eligibleItems = 0;

  for (const paper of snapshot.items) {
    if (!paper || paper.deleted === true) continue;
    if (!client._internal.paperWithinLookback(paper, params.now, params.lookbackYears)) {
      excludedOutsideLookback += 1;
      continue;
    }
    eligibleItems += 1;
    const matchedTerms = client.matchedTermsForPaper(paper, terms);
    const mapped = matchedTerms.length ? client.mapPaper(paper, matchedTerms[0]) : null;
    if (!mapped) continue;
    matches.push(mapped);
    for (const matchedTerm of matchedTerms) {
      termCounts.set(
        matchedTerm.normalized,
        (termCounts.get(matchedTerm.normalized) || 0) + 1
      );
    }
  }

  const results = client.deduplicateByUrl(matches);
  const evidenceIncomplete = snapshot.truncated || catalogue.stale;
  const status = evidenceIncomplete
    ? (results.length ? 'partial-results' : 'incomplete')
    : (results.length ? 'results-found' : 'searched-no-results');

  queryLog.forEach((entry, index) => {
    const count = termCounts.get(terms[index].normalized) || 0;
    entry.count = count;
    entry.status = evidenceIncomplete
      ? (count ? 'partial-results' : 'incomplete')
      : (count ? 'results-found' : 'searched-no-results');
  });

  const warnings = cacheWarnings(catalogue);
  if (provider.discoveryError) {
    warnings.push(
      `Das OParl-Systemdokument war nicht nutzbar (${provider.discoveryError.code}: `
      + `${provider.discoveryError.message}); die offizielle direkte Paper-Sammlung wurde verwendet.`
    );
  }
  warnings.push(
    'Der Bonner OParl-Katalog wird als begrenzter, gemeinsam genutzter Snapshot '
    + 'von den neuesten Seiten rückwärts durchsucht; Suchbegriffe werden lokal ausgewertet.'
  );
  if (excludedOutsideLookback > 0) {
    warnings.push(
      `${excludedOutsideLookback} Vorgang/Vorgänge außerhalb des konfigurierten `
      + 'Betrachtungszeitraums wurden nach dem Abruf verworfen.'
    );
  }
  if (snapshot.truncated) {
    warnings.push(
      'Der OParl-Katalog-Snapshot wurde am konfigurierten Seitenlimit abgeschnitten; '
      + 'ein offizieller Portal-Fallback ist erforderlich.'
    );
  }

  return {
    results,
    meta: {
      status,
      sourceType: 'oparl-1.1',
      sourceUrl: provider.sourceUrl || systemUrl,
      bodyId: provider.bodyId || '',
      bodyName: provider.bodyName || 'Bonn',
      paperListUrl: provider.paperListUrl || snapshot.sourceUrl,
      discoveryMode: provider.discoveryMode || 'catalogue-snapshot',
      queryLog,
      pagesFetched: Number(provider.bodyPagesFetched || 0)
        + cacheNetworkPages(catalogue, snapshot),
      scanPagesFetched: Number(snapshot.scanPagesFetched || 0),
      discoveryPagesFetched: Number(snapshot.discoveryPagesFetched || 0),
      traversalDirection: snapshot.traversalDirection || 'newest-first',
      scannedItems: snapshot.items.length,
      eligibleItems,
      excludedOutsideLookback,
      truncated: snapshot.truncated,
      nextUrl: snapshot.nextUrl || '',
      catalogueSnapshot: catalogue,
      warnings,
    },
  };
}

module.exports = {
  searchCachedOparl,
  catalogueStoreFor,
  cacheConfiguration,
  cacheNetworkPages,
  cacheWarnings,
};
