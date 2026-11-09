/** @jest-environment node */
'use strict';

jest.mock('../../server/political-context/registry/cityPortalRegistry', () => ({ getProviderForCity: jest.fn() }));
const { getProviderForCity } = require('../../server/political-context/registry/cityPortalRegistry');
const { search } = require('../../server/political-context/services/portalSearchService');
const { sharedCache } = require('../../server/political-context/services/portalSearchCache');
const context = level => ({ level, publisher: 'Amtliche Quelle', issuer: null, documentKind: 'Antrag',
  status: 'proposal', publicationDate: null, documentDate: null, meetingDate: null });
beforeEach(() => { sharedCache.clear(); jest.clearAllMocks(); });

test('live search filters before result limits and isolates the level selection in its cache', async () => {
  getProviderForCity.mockReturnValue({ _key: 'test-source', search: async () => [
    ...Array.from({ length: 15 }, (_, i) => ({ title: 'Schulweg', url: `https://example.org/city-${i}`, sourceContext: context('city') })),
    { title: 'Schulweg', url: 'https://example.org/state', sourceContext: context('state') },
  ] });
  const params = { city: 'Hannover', searchTerms: ['Schulweg'], maxResults: 1, expandVariants: false };
  const city = await search({ ...params, sourceLevels: ['city'] });
  const state = await search({ ...params, sourceLevels: ['state'] });
  expect(city.references[0].sourceContext.level).toBe('city');
  expect(state.references.map(value => value.url)).toEqual(['https://example.org/state']);
  expect(state.meta.totalFound).toBe(1);
  const repeat = await search({ ...params, sourceLevels: ['state'] });
  expect(repeat.references.map(value => value.url)).toEqual(['https://example.org/state']);
  expect(repeat.meta.cache.hit).toBe(true);
  expect(repeat.meta.cache.key).not.toBe(city.meta.cache.key);
});

test('an unknown-level live result cannot leak into an explicit level selection or imply a complete negative search', async () => {
  getProviderForCity.mockReturnValue({ _key: 'unknown-source', search: async () => ({
    results: [{ title: 'Schulweg', url: 'https://example.org/unknown' }],
    meta: { searchStatus: 'results-found', truncated: false },
  }) });
  const result = await search({ city: 'Hannover', searchTerms: ['Schulweg'], sourceLevels: ['state'] });
  expect(result.references).toEqual([]);
  expect(result.meta.searchStatus).toBe('incomplete');
  expect(result.meta.truncated).toBe(true);
});

test.each([null, 'state', ['unknown'], ['state', 'unknown']])('live search rejects malformed filters without falling back to all levels: %j', async sourceLevels => {
  getProviderForCity.mockReturnValue({ _key: 'hannover-sim', search: async () => [] });
  await expect(search({ city: 'Hannover', searchTerms: ['Schulweg'], sourceLevels }))
    .rejects.toMatchObject({ code: 'RIS_SOURCE_LEVELS_INVALID' });
});
