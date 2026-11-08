/** @jest-environment node */
'use strict';

const { combineHannoverCatalogues, collectCombinedHannoverCatalogue, historicalCityStart } = require('../../server/political-context/providers/hannoverCatalogue');

const NOW = new Date('2026-11-08T12:00:00.000Z');
const noAdditional = async () => ({ records: [], sources: [], sourceStatuses: [] });
function catalogue(source, generatedAt = NOW.toISOString()) {
  const regional = source === 'region-hannover-ris';
  return {
    generatedAt, sources: [regional ? 'https://ris.hannit.de/public/vo040' : 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/Suche.xsp'],
    records: [{ id: `${source}:1`, source, title: 'Radverkehr', number: '123/2026' }],
    coverage: { from: '2014-01-01', to: '2026-11-06', bodies: [regional ? 'Regionsversammlung' : 'Ratsversammlung'],
      complete: false, warnings: [], ...(regional ? {} : { scope: 'citywide' }) },
    history: { pending: false, interrupted: false, pendingYears: [], requestedFrom: '2014-01-01', requestedTo: '2026-11-08' },
    provenance: { collection: { pages: regional ? 141 : 1000, rawItems: regional ? 14055 : 54217 } },
  };
}

test('combines public sources without collapsing equal document numbers or refreshing older source evidence', () => {
  const city = catalogue('hannover-sim');
  const region = catalogue('region-hannover-ris', '2026-11-07T09:00:00.000Z');
  region.coverage.from = '2013-10-01';
  region.coverage.warnings = ['Einige Detailtexte fehlen.'];
  region.history = { ...region.history, pending: true, interrupted: true, pendingYears: [2024] };
  const result = combineHannoverCatalogues(city, region, { now: NOW });
  expect(result.records.map(record => record.id)).toEqual(['hannover-sim:1', 'region-hannover-ris:1']);
  expect(result.sources).toEqual([...city.sources, ...region.sources]);
  expect(result.generatedAt).toBe(region.generatedAt);
  expect(result.coverage).toMatchObject({ from: '2013-10-01', to: '2026-11-06', scope: 'citywide', complete: false,
    bodies: expect.arrayContaining(['Ratsversammlung', 'Regionsversammlung']), warnings: expect.arrayContaining(['Einige Detailtexte fehlen.']) });
  expect(result.sourceStatuses).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'hannover-sim', recordCount: 1 }),
    expect.objectContaining({ source: 'region-hannover-ris', recordCount: 1, retrievedAt: region.generatedAt }),
  ]));
  expect(result.history).toMatchObject({ pending: true, interrupted: true, pendingYears: [2024] });
  expect(result.history.retainPreviousClock).toBe(false);
  expect(result.provenance.collection).toMatchObject({ pages: 1141, rawItems: 68272,
    continuation: { pending: true, interrupted: true, pendingYears: [2024] } });
});

test('does not present a partial source counter as the combined total', () => {
  const city = catalogue('hannover-sim');
  delete city.provenance;
  const result = combineHannoverCatalogues(city, catalogue('region-hannover-ris'), { now: NOW });
  expect(result.provenance.collection).toMatchObject({ pages: null, rawItems: null });
});

test('rejects an empty or missing source instead of renewing a city-only catalogue', () => {
  const city = catalogue('hannover-sim');
  expect(() => combineHannoverCatalogues(city, { ...catalogue('region-hannover-ris'), records: [] }, { now: NOW }))
    .toThrow(/Region Hannover.*usable|Region Hannover.*verwendbar/i);
  expect(() => combineHannoverCatalogues(null, catalogue('region-hannover-ris'), { now: NOW }))
    .toThrow(/Hannover.*usable|Hannover.*verwendbar/i);
});

test('an authoritative exclusion can remove the last regional record without losing the city catalogue', () => {
  const region = catalogue('region-hannover-ris');
  region.records = [];
  region.coverage.from = null;
  region.coverage.to = null;
  region.exclusions = [{ id: 'region-hannover-ris:vo:1', url: 'https://ris.hannit.de/public/vo020?VOLFDNR=1&refresh=false',
    verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  const result = combineHannoverCatalogues(catalogue('hannover-sim'), region, { now: NOW });
  expect(result.records.map(record => record.id)).toEqual(['hannover-sim:1']);
  expect(result.exclusions).toEqual(region.exclusions);
});

test('rejects colliding record identities across providers', () => {
  const city = catalogue('hannover-sim');
  const region = catalogue('region-hannover-ris');
  region.records[0].id = city.records[0].id;
  expect(() => combineHannoverCatalogues(city, region, { now: NOW })).toThrow(/duplicate|collision/i);
});

test('runs both independent sources with a bounded combined work budget and a separate regional deadline', async () => {
  const cityCollector = jest.fn(async () => catalogue('hannover-sim'));
  const regionCollector = jest.fn(async () => catalogue('region-hannover-ris'));
  const result = await collectCombinedHannoverCatalogue({ now: NOW, from: '2014-01-01', workBudget: 11,
    maxDurationMs: 58 * 60_000, collectCity: cityCollector, collectRegion: regionCollector, collectAdditional: noAdditional });
  expect(result.records).toHaveLength(2);
  const city = cityCollector.mock.calls[0][0], region = regionCollector.mock.calls[0][0];
  expect(city.workBudget + region.workBudget).toBe(11);
  expect(city).toMatchObject({ from: '2014-01-01', maxDurationMs: 58 * 60_000, includeLocationEvidence: true });
  expect(region).toMatchObject({ from: '2014-01-01', maxDurationMs: 15 * 60_000, maxDetails: 2000 });
});

test('propagates a regional source failure to the existing snapshot fallback', async () => {
  await expect(collectCombinedHannoverCatalogue({ now: NOW,
    collectCity: async () => catalogue('hannover-sim'),
    collectRegion: async () => { throw new Error('Region HTTP 503'); },
    collectAdditional: noAdditional,
  })).rejects.toThrow('Region HTTP 503');
});

test('preserves confirmed regional exclusions when a sibling source fails', async () => {
  const region = catalogue('region-hannover-ris');
  region.exclusions = [{ id: 'region-hannover-ris:vo:2', url: 'https://ris.hannit.de/public/vo020?VOLFDNR=2&refresh=false',
    verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  const onExclusions = jest.fn();
  await expect(collectCombinedHannoverCatalogue({ now: NOW, onExclusions,
    collectCity: async () => { throw new Error('SIM source failed'); }, collectRegion: async () => region,
    collectAdditional: noAdditional,
  })).rejects.toMatchObject({ exclusions: region.exclusions });
  expect(onExclusions).toHaveBeenCalledWith(region.exclusions);
});

test('preserves additional state documents and replaces the obsolete regional source placeholder', () => {
  const region = catalogue('region-hannover-ris');
  const status = { source: 'landtag-catalogue', status: 'partial', url: 'https://www.landtag-niedersachsen.de/dokumentensuche/',
    retrievedAt: '2026-11-06T12:00:00.000Z', from: '2026-01-01', to: '2026-11-06', recordCount: 1, message: 'Begrenzte Dokumentpartition.' };
  const state = { id: 'niedersachsen-landtag:1', source: 'niedersachsen-landtag', title: 'Radverkehr Hannover',
    sourceContext: { level: 'state', publisher: 'Niedersächsischer Landtag' } };
  const result = combineHannoverCatalogues(catalogue('hannover-sim'), region, { now: NOW, additional: {
    records: [state], sources: [status.url, 'https://ris.hannit.de/public/'],
    sourceStatuses: [status, { ...status, source: 'region-hannover-ris', status: 'blocked', recordCount: 0 }],
  } });
  expect(result.records.find(record => record.id === state.id)).toEqual(state);
  expect(result.sourceStatuses.filter(s => s.source === 'region-hannover-ris')).toEqual([expect.objectContaining({ status: 'partial', recordCount: 1 })]);
  expect(result.sourceStatuses).toContain(status);
  expect(result.generatedAt).toBe(status.retrievedAt);
  expect(result.provenance.rights.attribution).toContain('Region Hannover');
});

test('older regional rows do not silently widen the city source discovery period', () => {
  expect(historicalCityStart('2014-01-01', { from: '2004-10-14' }, [
    { source: 'hannover-sim', from: '2014-01-01' }, { source: 'region-hannover-ris', from: '2004-10-14' },
  ])).toBe('2014-01-01');
  expect(historicalCityStart('2014-01-01', { from: '2010-01-01' })).toBe('2010-01-01');
});

test('the city source status keeps the original verification time of cached city details', () => {
  const city = catalogue('hannover-sim');
  city.records[0].detailVerifiedAt = '2026-11-05T10:00:00.000Z';
  const result = combineHannoverCatalogues(city, catalogue('region-hannover-ris'), { now: NOW });
  expect(result.sourceStatuses.find(status => status.source === 'hannover-sim').retrievedAt).toBe(city.records[0].detailVerifiedAt);
  expect(result.generatedAt).toBe(city.records[0].detailVerifiedAt);
});
