'use strict';

const { collectHannoverCatalogue } = require('./hannoverSimCatalogue');
const { collectRegionHannoverCatalogue } = require('./regionHannoverCatalogue');
const { collectHannoverAdditionalSources } = require('./hannoverAdditionalSources');
const { composeHannoverCatalogue } = require('./hannoverCatalogueComposition');

const REGION_HOST = 'ris.hannit.de';
function includesRegionSource(sources = []) {
  return sources.some(source => {
    try { return new URL(source).hostname === REGION_HOST; } catch (_) { return false; }
  });
}

function historicalCityStart(requestedFrom, previousCoverage, previousSourceStatuses = []) {
  const cityStatus = previousSourceStatuses.find(status => status.source === 'hannover-sim');
  // Mixed coverage can start earlier because of Region records. Keep SIM's own
  // verified range; legacy city-only manifests still use their coverage range.
  const previousFrom = cityStatus?.from || (previousSourceStatuses.some(status => status.source === 'region-hannover-ris' && status.recordCount > 0)
    ? null : previousCoverage?.from);
  return previousFrom && previousFrom < requestedFrom ? previousFrom : requestedFrom;
}

function combineHannoverCatalogues(city, region, { now = new Date(), additional = { records: [], sources: [], sourceStatuses: [] } } = {}) {
  for (const [name, catalogue] of [['Landeshauptstadt Hannover', city], ['Region Hannover', region]]) {
    const exclusionsOnly = catalogue === region && Array.isArray(catalogue?.records) && catalogue.exclusions?.length > 0;
    if ((!catalogue?.records?.length && !exclusionsOnly) || !catalogue.sources?.length ||
        (!exclusionsOnly && (!catalogue.coverage?.from || !catalogue.coverage.to)) || !catalogue.coverage?.bodies?.length) {
      throw new Error(`${name}: no usable public catalogue`);
    }
  }
  const catalogues = [city, region];
  const records = catalogues.flatMap(catalogue => catalogue.records);
  records.push(...additional.records);
  if (new Set(records.map(record => record.id)).size !== records.length) throw new Error('Duplicate Hannover source record identity');
  const unique = values => [...new Set(values)];
  const oldest = values => values.filter(Boolean).sort()[0] || null;
  const newest = values => values.filter(Boolean).sort().at(-1) || null;
  const history = {
    pending: catalogues.some(catalogue => catalogue.history?.pending === true),
    interrupted: catalogues.some(catalogue => catalogue.history?.interrupted === true),
    // Regional rows carry their own verification clocks. Pending new details
    // alone must not freeze freshly verified metadata at an older publication.
    retainPreviousClock: city.history?.interrupted === true,
    pendingYears: unique(catalogues.flatMap(catalogue => catalogue.history?.pendingYears || [])).sort((a, b) => a - b),
    requestedFrom: oldest(catalogues.map(catalogue => catalogue.history?.requestedFrom)),
    requestedTo: newest(catalogues.map(catalogue => catalogue.history?.requestedTo)),
  };
  // Unknown SIM counters must not turn a known regional subtotal into a claimed
  // combined total. Normalized item counts are added after retained rows merge.
  const sumKnown = field => {
    const values = [...catalogues, ...(additional.sourceStatuses.length ? [additional] : [])]
      .map(catalogue => catalogue.provenance?.collection?.[field]);
    return values.every(value => Number.isSafeInteger(value) && value >= 0) ? values.reduce((a, b) => a + b, 0) : null;
  };
  const regionStatus = region.sourceStatus || region.sourceStatuses?.find(status => status.source === 'region-hannover-ris') || {
    source: 'region-hannover-ris', status: 'partial', url: region.sources[0],
    retrievedAt: region.generatedAt || null, from: region.coverage.from, to: region.coverage.to,
    recordCount: region.records.length, message: 'Öffentliche regionale Vorlagen; Abdeckung und offene Detailabrufe siehe Quellenhinweise.',
  };
  // Keep the established multi-source context, timeline and rights mapping.
  // The actual ALLRIS result replaces the live-search placeholder for that source.
  const composed = composeHannoverCatalogue(city, {
    records: [...region.records, ...additional.records],
    sources: unique([...region.sources, ...(additional.sources || [])]),
    sourceStatuses: [regionStatus, ...additional.sourceStatuses.filter(status => status.source !== 'region-hannover-ris')],
  }, { now });
  return {
    ...composed, history,
    ...(region.exclusions?.length ? { exclusions: region.exclusions } : {}),
    generatedAt: oldest([composed.generatedAt, ...catalogues.map(catalogue => catalogue.generatedAt)]) || now.toISOString(),
    coverage: {
      ...composed.coverage,
      from: oldest(catalogues.map(catalogue => catalogue.coverage.from)),
      to: newest(catalogues.map(catalogue => catalogue.coverage.to)),
      bodies: unique([...composed.coverage.bodies, ...region.coverage.bodies]),
      warnings: unique([...composed.coverage.warnings, ...region.coverage.warnings]),
    },
    provenance: { ...composed.provenance, collection: {
      pages: sumKnown('pages'), rawItems: sumKnown('rawItems'),
      requestedFrom: history.requestedFrom, requestedTo: history.requestedTo,
      continuation: { pending: history.pending, interrupted: history.interrupted, pendingYears: history.pendingYears, reason: null },
    } },
  };
}

async function collectCombinedHannoverCatalogue({ now = new Date(), from = '2014-01-01',
  maxDurationMs = 58 * 60_000, workBudget, sourceCache, checkpoint, report = () => {},
  collectCity = collectHannoverCatalogue, collectRegion = collectRegionHannoverCatalogue,
  collectAdditional = collectHannoverAdditionalSources, onExclusions = () => {}, checkpointOnly = false } = {}) {
  if (checkpointOnly && workBudget !== 0) throw new Error('Hannover checkpoint recovery requires zero source work');
  let sourceReadAttempted = false;
  const denySourceRead = () => {
    sourceReadAttempted = true;
    throw new Error('Official source requests are disabled during checkpoint recovery');
  };
  // The two public systems are independent. A configured request budget is
  // shared, while their ordinary wall-clock bounds run concurrently.
  const regionBudget = workBudget === undefined ? undefined : Math.ceil(workBudget / 2);
  const cityBudget = workBudget === undefined ? undefined : workBudget - regionBudget;
  const outcomes = await Promise.allSettled([
    collectCity({ now, from, discovery: 'search', strict: true, maxDocuments: 50_000,
      concurrency: 8, maxDurationMs, timeoutMs: 20_000, includeLocationEvidence: true,
      sourceCache, checkpoint, ...(checkpointOnly ? { requestText: denySourceRead } : {}), workBudget: cityBudget, report: event => report({ ...event, source: 'hannover-sim' }) }),
    collectRegion({ now, from, maxDocuments: 50_000, maxDetails: 2000,
      maxDurationMs: Math.min(15 * 60_000, maxDurationMs), timeoutMs: 20_000,
      sourceCache, checkpoint, ...(checkpointOnly ? { fetchHtmlImpl: denySourceRead } : {}), workBudget: regionBudget, report: event => report({ ...event, source: 'region-hannover-ris' }) })
      .then(region => { onExclusions(region.exclusions || []); return region; }),
    // Preserve the separately bounded Landtag/announcement discovery introduced
    // with consultation histories. Zero work budget remains entirely offline.
    collectAdditional({ now, sourceCache, checkpoint, workBudget,
      ...(checkpointOnly ? { request: denySourceRead } : {}),
      maxPages: workBudget === 0 ? 0 : 2, maxNotices: workBudget === 0 ? 0 : 4 }),
  ]);
  const failures = outcomes.filter(outcome => outcome.status === 'rejected');
  // A collector may catch transport failure and return retained data. The
  // offline recovery boundary must still reject the attempted source read.
  if (sourceReadAttempted) failures.push({ reason: new Error('Checkpoint recovery attempted an official source request') });
  if (failures.length) {
    const error = new Error(failures.map(outcome => outcome.reason?.message || 'Hannover source failed').join('; '));
    error.exclusions = outcomes[1].status === 'fulfilled' ? outcomes[1].value.exclusions || [] : [];
    throw error;
  }
  const [city, region, additional] = outcomes.map(outcome => outcome.value);
  return combineHannoverCatalogues(city, region, { now, additional });
}

module.exports = { combineHannoverCatalogues, collectCombinedHannoverCatalogue, includesRegionSource, historicalCityStart };
