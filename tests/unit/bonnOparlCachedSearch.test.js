'use strict';

const {
  searchCachedOparl,
  catalogueStoreFor,
} = require('../../server/political-context/providers/bonnOparlCachedSearch.js');
const {
  BonnOparlCatalogueStore,
} = require('../../server/political-context/services/bonnOparlCatalogueStore.js');
const httpContract = require('../../server/political-context/providers/bonnOparlHttp.js');

const SYSTEM_URL = 'https://www.bonn.sitzung-online.de/oparl/system';
const BODY_LIST_URL = 'https://www.bonn.sitzung-online.de/oparl/bodies';
const PAPER_LIST_URL = 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers';

function paper(id, name, keyword) {
  return {
    id: `https://www.bonn.sitzung-online.de/oparl/papers/${id}`,
    name,
    reference: `DS-${id}`,
    date: '2026-06-01',
    paperType: 'Antrag',
    web: `https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=${id}`,
    keyword: [keyword, 'Radverkehr'],
  };
}

function router(options = {}) {
  const papers = options.papers || [
    paper(1, 'Radverkehr in der Adenauerallee', 'Adenauerallee'),
    paper(2, 'Verkehrssicherheit an der Oxfordstraße', 'Oxfordstraße'),
  ];
  return jest.fn(async rawUrl => {
    const url = new URL(rawUrl);
    if (options.fail === true) throw new Error('portal unavailable');
    if (url.href === SYSTEM_URL) {
      return { body: BODY_LIST_URL };
    }
    if (url.origin + url.pathname === BODY_LIST_URL) {
      return {
        data: [{
          id: 'https://www.bonn.sitzung-online.de/oparl/bodies/1',
          ags: '05314000',
          shortName: 'Bonn',
          name: 'Bundesstadt Bonn',
          paper: PAPER_LIST_URL,
        }],
        links: { next: null },
      };
    }
    if (url.origin + url.pathname === PAPER_LIST_URL) {
      return {
        data: papers,
        pagination: { currentPage: 1, totalPages: options.totalPages || 1 },
        links: {
          self: url.href,
          last: options.totalPages > 1
            ? `${PAPER_LIST_URL}?page=${options.totalPages}&size=100`
            : url.href,
          prev: null,
        },
      };
    }
    throw new Error(`Unexpected URL ${url.href}`);
  });
}

function params(fetchJsonImpl, catalogueStore, searchTerms) {
  return {
    searchTerms,
    fetchJsonImpl,
    catalogueStore,
    now: new Date('2026-08-22T00:00:00Z'),
    lookbackYears: 10,
    maxPages: 300,
    pageLimit: 100,
  };
}

describe('shared Bonn OParl catalogue search', () => {
  test('two different term sets cause one catalogue crawl and two local searches', async () => {
    const fetchJsonImpl = router();
    const catalogueStore = new BonnOparlCatalogueStore();

    const first = await searchCachedOparl(params(
      fetchJsonImpl,
      catalogueStore,
      ['Adenauerallee']
    ));
    const callsAfterFirst = fetchJsonImpl.mock.calls.length;
    const second = await searchCachedOparl(params(
      fetchJsonImpl,
      catalogueStore,
      ['Oxfordstraße']
    ));

    expect(callsAfterFirst).toBe(3);
    expect(fetchJsonImpl).toHaveBeenCalledTimes(3);
    expect(first.results.map(result => result.number)).toEqual(['DS-1']);
    expect(second.results.map(result => result.number)).toEqual(['DS-2']);
    expect(first.meta.catalogueSnapshot.cacheStatus).toBe('miss');
    expect(second.meta.catalogueSnapshot.cacheStatus).toBe('hit');
    expect(first.meta.pagesFetched).toBe(3);
    expect(second.meta.pagesFetched).toBe(0);
  });

  test('concurrent different searches share one in-flight refresh', async () => {
    let releasePapers;
    const paperGate = new Promise(resolve => { releasePapers = resolve; });
    const fetchJsonImpl = router();
    const original = fetchJsonImpl.getMockImplementation();
    fetchJsonImpl.mockImplementation(async rawUrl => {
      if (new URL(rawUrl).origin + new URL(rawUrl).pathname === PAPER_LIST_URL) {
        await paperGate;
      }
      return original(rawUrl);
    });
    const catalogueStore = new BonnOparlCatalogueStore();

    const firstPromise = searchCachedOparl(params(
      fetchJsonImpl,
      catalogueStore,
      ['Adenauerallee']
    ));
    const secondPromise = searchCachedOparl(params(
      fetchJsonImpl,
      catalogueStore,
      ['Oxfordstraße']
    ));
    releasePapers();

    const [first, second] = await Promise.all([firstPromise, secondPromise]);
    expect(fetchJsonImpl).toHaveBeenCalledTimes(3);
    expect([first.meta.catalogueSnapshot.cacheStatus, second.meta.catalogueSnapshot.cacheStatus].sort())
      .toEqual(['coalesced', 'miss']);
  });

  test('custom fetchers bypass the process-wide store unless a store is explicitly injected', () => {
    const custom = jest.fn();
    expect(catalogueStoreFor({}, custom)).toBeNull();
    expect(catalogueStoreFor({ catalogueCache: false }, httpContract.fetchJson)).toBeNull();
    const isolated = new BonnOparlCatalogueStore();
    expect(catalogueStoreFor({ catalogueStore: isolated }, custom)).toBe(isolated);
  });

  test('a stale zero-result snapshot remains incomplete after refresh failure', async () => {
    let now = 100_000;
    const catalogueStore = new BonnOparlCatalogueStore({
      ttlMs: 1_000,
      staleIfErrorMs: 5_000,
      clock: () => now,
    });
    const fetchJsonImpl = router();
    await searchCachedOparl(params(
      fetchJsonImpl,
      catalogueStore,
      ['Nichtvorhandene Straße']
    ));

    now += 1_500;
    fetchJsonImpl.mockImplementation(async () => {
      const error = new Error('portal unavailable');
      error.code = 'OPARL_NETWORK_ERROR';
      throw error;
    });
    const stale = await searchCachedOparl(params(
      fetchJsonImpl,
      catalogueStore,
      ['Noch immer nicht vorhanden']
    ));

    expect(stale.results).toEqual([]);
    expect(stale.meta.status).toBe('incomplete');
    expect(stale.meta.catalogueSnapshot).toMatchObject({
      cacheStatus: 'stale-if-error',
      stale: true,
      refreshFailed: true,
    });
    expect(stale.meta.warnings.join(' ')).toMatch(/veraltet markierter Snapshot/i);
  });

  test('a truncated snapshot cannot produce a completed no-result status', async () => {
    const fetchJsonImpl = router({ totalPages: 2, papers: [] });
    const catalogueStore = new BonnOparlCatalogueStore();
    const result = await searchCachedOparl({
      ...params(fetchJsonImpl, catalogueStore, ['Unbekannt']),
      maxPages: 1,
    });

    expect(result.results).toEqual([]);
    expect(result.meta.status).toBe('incomplete');
    expect(result.meta.truncated).toBe(true);
    expect(result.meta.catalogueSnapshot.truncated).toBe(true);
  });
});
