'use strict';

const sim = require('./hannoverSimProvider');
const { collectHannoverAdditionalSources, collectLandtagCatalogue, buildCatalogueUrl, BLOCKED } = require('./hannoverAdditionalSources');
const { sourceContext, hasLocalTrafficEvidence, substantiveText } = require('./hannoverAdditionalFormats');

const SIM_URL = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/ds_suchformular';
function termsFrom(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(t => typeof t === 'string').map(t => t.trim()).filter(Boolean))].slice(0, 8);
}
function matchingAdditional(record, terms) {
  if (!hasLocalTrafficEvidence(record)) return null;
  const haystack = `${substantiveText(record)}\n${record.number || ''}`.toLocaleLowerCase('de');
  const matched = terms.filter(term => haystack.includes(term.toLocaleLowerCase('de')));
  if (!matched.length) return null;
  const streetHints = matched.filter(term => /straße|strasse|weg\b|platz\b|allee\b|ufer\b/i.test(term));
  const areaHints = matched.filter(term => /Eilenriede|Stadtteil|Stadtbezirk/i.test(term));
  const locationMatch = streetHints.length ? 'street' : areaHints.length ? 'district' : 'topic-only';
  const referenceType = record.type === 'Verwaltungsantwort' ? 'Verwaltungsantwort'
    : record.type === 'Anfrage' ? 'Anfrage' : ['Antrag', 'Änderungsantrag'].includes(record.type) ? 'Antrag'
      : record.type === 'Protokoll' ? 'Protokollnotiz' : 'verwandtes Thema';
  return { ...record, topicMatch: matched, streetHints, areaHints, locationMatch, referenceType,
    reason: `Amtliche ${record.sourceContext.level === 'state' ? 'Landesquelle' : 'Regionsquelle'} mit inhaltlichem Orts- und Verkehrsbezug.` };
}
function cityRecord(raw) {
  const type = `${raw.type || ''} ${raw.rawType || ''}`;
  const status = /Antwort/i.test(type) ? 'answer' : /Antrag|Anfrage/i.test(type) ? 'proposal'
    : /Protokoll|Niederschrift/i.test(type) ? 'minutes' : 'other';
  return { ...raw, source: raw.source || 'hannover-sim',
    sourceContext: raw.sourceContext || { ...sourceContext('city', raw.rawType || raw.type || 'Sonstige', status), publisher: 'Landeshauptstadt Hannover' } };
}
function sourceFailure(source, url, message) {
  return { source, status: 'failed', url, retrievedAt: null, from: null, to: null, recordCount: 0, message };
}
function createHannoverCompositeProvider({ simProvider = sim, collectAdditional = collectHannoverAdditionalSources,
  collectCatalogue = collectLandtagCatalogue, additionalOptions = {} } = {}) {
  const pending = new Map();
  function loadAdditional(options) {
    const key = JSON.stringify(options.filters || null);
    if (!pending.has(key)) pending.set(key, collectAdditional(options).finally(() => pending.delete(key)));
    return pending.get(key);
  }
  async function search(params = {}) {
    const terms = termsFrom(params.searchTerms);
    if (!terms.length) return { results: [], meta: { status: 'incomplete', sourceStatuses: [{ ...BLOCKED }], truncated: true } };
    const context = params.context || {};
    const filters = { ...(additionalOptions.filters || {}),
      ...(context.landtagNumber === undefined ? {} : { number: context.landtagNumber }),
      ...(context.landtagYear === undefined ? {} : { year: context.landtagYear }) };
    if (Object.keys(filters).length) buildCatalogueUrl(filters); // validate before either network path
    const now = new Date();
    if (context.landtagNumber !== undefined || context.landtagYear !== undefined) {
      // An explicit state-document scope does not invoke Domino or unrelated
      // feeds. It is a bounded catalogue selection, not a complete city search.
      const result = await collectCatalogue({ ...additionalOptions, filters, now, maxPages: 2 });
      const results = result.records.map(record => matchingAdditional(record, terms)).filter(Boolean);
      const url = buildCatalogueUrl(filters);
      return { results, meta: { status: results.length ? 'partial-results' : 'incomplete', sourceType: 'landtag-catalogue-filtered', sourceUrl: url,
        sourceStatuses: [result.sourceStatus], truncated: true, pagesFetched: result.pagesFetched || 0, scannedItems: result.records.length,
        queryLog: [{ source: 'landtag-catalogue', sourceType: 'public-documents', url,
          query: `${JSON.stringify(filters)}; ${terms.join('; ')}`, status: result.sourceStatus.status, count: results.length }],
        warnings: ['Auswahl nach Landtagsdokumentnummer/Jahr; begrenzte Dokumentpartition. Keine vollständige politische Stadtrecherche.', result.sourceStatus.message] } };
    }
    const [city, additional] = await Promise.allSettled([
      simProvider.search(params),
      loadAdditional({ ...additionalOptions, ...(Object.keys(filters).length ? { filters } : {}), now }),
    ]);
    const cityRows = city.status === 'fulfilled' ? (Array.isArray(city.value) ? city.value : city.value.results || []) : [];
    const cityStatus = city.status === 'fulfilled' ? { source: 'hannover-sim', status: 'partial', url: SIM_URL,
      retrievedAt: now.toISOString(), from: null, to: null, recordCount: cityRows.length,
      message: 'SIM-Portalsuche; einzelne Suchanfragen und historische Vollständigkeit sind nicht vollständig nachgewiesen.' }
      : sourceFailure('hannover-sim', SIM_URL, 'Städtische SIM-Suche derzeit nicht erreichbar.');
    const added = additional.status === 'fulfilled' ? additional.value : { records: [], sourceStatuses: [
      sourceFailure('hannover-additional', 'https://www.landtag-niedersachsen.de/dokumentensuche/', 'Zusätzliche öffentliche Quellen derzeit nicht erreichbar.'), { ...BLOCKED },
    ] };
    const results = [...cityRows.map(cityRecord), ...added.records.map(record => matchingAdditional(record, terms)).filter(Boolean)];
    const sourceStatuses = [cityStatus, ...added.sourceStatuses];
    return { results, meta: { status: results.length ? 'partial-results' : 'incomplete', sourceType: 'official-multiple-sources', sourceUrl: SIM_URL,
      sourceStatuses, truncated: true, warnings: sourceStatuses.filter(s => s.status !== 'available').map(s => `${s.source}: ${s.message}`),
      scannedItems: cityRows.length + added.records.length,
      attempts: sourceStatuses.map(s => ({ source: s.source, sourceType: s.source === 'region-hannover-ris' ? 'manual-only' : 'public-documents',
        url: s.url, status: s.status, count: s.recordCount })) } };
  }
  // Keep the historical aggregate key for compatibility; each record/status has its real source.
  return { _key: 'hannover-sim', supportsCity: simProvider.supportsCity, search };
}

module.exports = { ...createHannoverCompositeProvider(), createHannoverCompositeProvider };
