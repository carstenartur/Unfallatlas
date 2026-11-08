/** @jest-environment node */
'use strict';
jest.mock('../../server/political-context/registry/cityPortalRegistry', () => ({ getProviderForCity: jest.fn() }));
const { getProviderForCity } = require('../../server/political-context/registry/cityPortalRegistry');
const { search } = require('../../server/political-context/services/portalSearchService');
const { createHannoverCompositeProvider } = require('../../server/political-context/providers/hannoverCompositeProvider');
const { parseLandtagCatalogue } = require('../../server/political-context/providers/hannoverAdditionalFormats');
const fs = require('node:fs');
const path = require('node:path');
const local = () => parseLandtagCatalogue(fs.readFileSync(path.join(__dirname, '../fixtures/political-sources/landtag-catalogue.html'), 'utf8'), 'https://www.landtag-niedersachsen.de/dokumentensuche/').records[0];
const STATUS = { source: 'landtag-catalogue', status: 'partial', url: 'https://www.landtag-niedersachsen.de/dokumentensuche/',
  retrievedAt: '2026-11-08T12:00:00.000Z', from: null, to: null, recordCount: 1, message: 'Partition only' };

test('real backend composition keeps independent issuer/source context, filters local matches and exposes source failures', async () => {
  const simProvider = { supportsCity: () => true, search: async () => [{ title: 'Radverkehr in der Eilenriede', type: 'Antrag',
    url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/1234-2026', date: '2026-04-01' }] };
  const provider = createHannoverCompositeProvider({ simProvider, collectAdditional: async () => ({ records: [local(),
    { ...local(), id: 'unrelated', title: 'Radverkehr in Niedersachsen', snippet: 'Hannover, den 13.06.2025', url: 'https://www.landtag-niedersachsen.de/unrelated.pdf' }
  ], sourceStatuses: [STATUS] }) });
  getProviderForCity.mockReturnValue(provider);
  const result = await search({ city: 'Hannover', searchTerms: ['Eilenriede'], expandVariants: false, useCache: false });
  expect(result.references).toHaveLength(2);
  expect(result.references.find(r => r.number === '19/8980')).toMatchObject({ source: 'niedersachsen-landtag',
    sourceContext: { level: 'state', issuer: null, status: 'answer', documentDate: null },
    originalPdfUrl: 'https://www.landtag-niedersachsen.de/drucksachen/drucksachen_19_10000/08501-09000/19-08980.pdf', type: 'Verwaltungsantwort' });
  expect(result.references.find(r => r.source === 'hannover-sim')).toMatchObject({ sourceContext: { level: 'city', publisher: 'Landeshauptstadt Hannover' } });
  expect(result.meta.sourceStatuses).toEqual(expect.arrayContaining([STATUS, expect.objectContaining({ source: 'hannover-sim', recordCount: 1 })]));
  expect(result.meta.searchStatus).toBe('partial-results');
  expect(result.meta.truncated).toBe(true);
});

test('a failed supplementary collector cannot discard SIM results or look like a complete search', async () => {
  const provider = createHannoverCompositeProvider({ simProvider: { supportsCity: () => true, search: async () => [
    { title: 'Verkehrssicherheit Eilenriede', url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/42-2026' }
  ] }, collectAdditional: async () => { throw new Error('upstream unavailable'); } });
  getProviderForCity.mockReturnValue(provider);
  const result = await search({ city: 'Hannover', searchTerms: ['Eilenriede'], expandVariants: false, useCache: false });
  expect(result.references).toHaveLength(1);
  expect(result.meta.sourceStatuses).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'hannover-additional', status: 'failed' }),
    expect.objectContaining({ source: 'region-hannover-ris', status: 'blocked' })
  ]));
  expect(result.meta.searchStatus).toBe('partial-results');
});

test('explicit Landtag filters select only the bounded catalogue and never invoke city or other source searches', async () => {
  let filters;
  let unrelated = 0;
  const provider = createHannoverCompositeProvider({ simProvider: { supportsCity: () => true, search: async () => { unrelated++; return []; } },
    collectAdditional: async () => { unrelated++; return { records: [], sourceStatuses: [] }; },
    collectCatalogue: async opts => { filters = opts.filters; return { records: [local()], sourceStatus: STATUS, pagesFetched: 1 }; } });
  const result = await provider.search({ city: 'Hannover', searchTerms: ['Eilenriede'], context: { landtagNumber: '19/8980', landtagYear: 2025 } });
  expect(filters).toEqual({ number: '19/8980', year: 2025 });
  expect(result.results).toHaveLength(1);
  expect(result.meta.sourceStatuses).toEqual([STATUS]);
  expect(result.meta.queryLog).toEqual([expect.objectContaining({ query: expect.stringContaining('19/8980'), source: 'landtag-catalogue' })]);
  expect(unrelated).toBe(0);
  await expect(provider.search({ searchTerms: ['Eilenriede'], context: { landtagNumber: 'https://evil.example' } })).rejects.toThrow(/filter/i);
});

test('normalization rejects untrusted PDF hosts and malformed optional source clocks', () => {
  const { normalizeOne } = require('../../server/political-context/services/portalNormalizationService');
  const { normalizeSourceStatuses } = require('../../server/political-context/services/politicalSourceContext');
  const record = normalizeOne({ ...local(), originalPdfUrl: 'https://evil.example/file.pdf' }, 'hannover-sim');
  expect(record.originalPdfUrl).toBeUndefined();
  expect(normalizeSourceStatuses([{ ...STATUS, retrievedAt: '2026-11-08' }])).toEqual([]);
  expect(normalizeSourceStatuses([{ ...STATUS, url: 'https://user@www.landtag-niedersachsen.de/' }])).toEqual([]);
});

test('distinct Region agenda items retain their official page URL and do not collapse during normalization', () => {
  const { normalizeAll } = require('../../server/political-context/services/portalNormalizationService');
  const { parseRegionNotice } = require('../../server/political-context/providers/hannoverAdditionalFormats');
  const url = 'https://bekanntmachungen.region-hannover.de/Regionsversammlung-und-Aussch%C3%BCsse/17.11.2026-Regionsversammlung';
  const records = parseRegionNotice(fs.readFileSync(path.join(__dirname, '../fixtures/political-sources/region-current-notice.html'), 'utf8'), url).slice(0, 2);
  const output = normalizeAll(records.map(r => ({ ...r, url })), 'hannover-sim');
  expect(output).toHaveLength(2);
  expect(output[0].id).not.toBe(output[1].id);
  expect(output.map(r => r.url)).toEqual([url, url]);
});

test('source-status sanitizer accepts an explicitly empty message in the shared optional contract', () => {
  const { normalizeSourceStatuses } = require('../../server/political-context/services/politicalSourceContext');
  expect(normalizeSourceStatuses([{ ...STATUS, message: '' }])).toEqual([{ ...STATUS, message: '' }]);
});
