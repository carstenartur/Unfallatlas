'use strict';

const {
  BonnOparlCatalogueStore,
  BonnOparlCatalogueStoreError,
  buildCatalogueKey,
} = require('../../server/political-context/services/bonnOparlCatalogueStore.js');

function paper(id, overrides = {}) {
  return {
    id: `https://www.bonn.sitzung-online.de/oparl/papers/${id}`,
    web: `https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=${id}`,
    name: `Vorgang ${id}`,
    reference: `DS-${id}`,
    paperType: 'Mitteilungsvorlage',
    date: '2026-01-02',
    modified: '2026-01-03T00:00:00Z',
    keyword: ['Radverkehr', 'Bonn'],
    location: [{ description: 'Adenauerallee', ignored: 'drop-me' }],
    mainFile: {
      name: 'Vorlage',
      web: `https://www.bonn.sitzung-online.de/public/to020?TOLFDNR=${id}`,
      ignored: 'drop-me',
    },
    auxiliaryFile: [],
    ignored: 'drop-me',
    ...overrides,
  };
}

function snapshot(ids = [1], overrides = {}) {
  return {
    sourceUrl: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers',
    items: ids.map(id => paper(id)),
    pages: [{
      url: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=1&size=100',
      count: ids.length,
      pagination: { currentPage: 1, totalPages: 1 },
    }],
    pagesFetched: 1,
    scanPagesFetched: 1,
    discoveryPagesFetched: 1,
    traversalDirection: 'newest-first',
    truncated: false,
    nextUrl: '',
    ...overrides,
  };
}

const CONFIG = {
  collectionUrl: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers',
  pageSize: 100,
  maxScanPages: 300,
  businessDateCutoff: '2016-01-01T00:00:00Z',
};

describe('BonnOparlCatalogueStore', () => {
  test('reuses one normalized snapshot for many local term searches', async () => {
    let now = 1_000;
    const store = new BonnOparlCatalogueStore({
      ttlMs: 10_000,
      clock: () => now,
    });
    const loader = jest.fn(async () => snapshot([1, 2]));

    const first = await store.getOrRefresh(CONFIG, loader);
    now += 500;
    const second = await store.getOrRefresh(CONFIG, loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.metadata.cacheStatus).toBe('miss');
    expect(second.metadata.cacheStatus).toBe('hit');
    expect(second.metadata.ageMs).toBe(500);
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.snapshot.items).toHaveLength(2);
    expect(second.snapshot.items[0]).not.toHaveProperty('ignored');
    expect(second.snapshot.items[0].location[0]).not.toHaveProperty('ignored');
  });

  test('coalesces concurrent refreshes into one portal crawl', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const store = new BonnOparlCatalogueStore({ clock: () => 2_000 });
    const loader = jest.fn(async () => {
      await gate;
      return snapshot([1]);
    });

    const firstPromise = store.getOrRefresh(CONFIG, loader);
    const secondPromise = store.getOrRefresh(CONFIG, loader);
    const thirdPromise = store.getOrRefresh(CONFIG, loader);
    release();

    const [first, second, third] = await Promise.all([
      firstPromise,
      secondPromise,
      thirdPromise,
    ]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(first.metadata.cacheStatus).toBe('miss');
    expect([second.metadata.cacheStatus, third.metadata.cacheStatus])
      .toEqual(['coalesced', 'coalesced']);
    expect(second.snapshot).toBe(first.snapshot);
    expect(third.snapshot).toBe(first.snapshot);
  });

  test('refreshes once after TTL expiry', async () => {
    let now = 10_000;
    const store = new BonnOparlCatalogueStore({
      ttlMs: 1_000,
      clock: () => now,
    });
    const loader = jest.fn()
      .mockResolvedValueOnce(snapshot([1]))
      .mockResolvedValueOnce(snapshot([2]));

    const first = await store.getOrRefresh(CONFIG, loader);
    now += 1_001;
    const refreshed = await store.getOrRefresh(CONFIG, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(first.snapshot.items[0].reference).toBe('DS-1');
    expect(refreshed.metadata.cacheStatus).toBe('refresh');
    expect(refreshed.snapshot.items[0].reference).toBe('DS-2');
  });

  test('returns a visibly stale complete snapshot on bounded refresh failure', async () => {
    let now = 20_000;
    const store = new BonnOparlCatalogueStore({
      ttlMs: 1_000,
      staleIfErrorMs: 5_000,
      clock: () => now,
    });
    await store.getOrRefresh(CONFIG, async () => snapshot([1]));
    now += 1_500;

    const stale = await store.getOrRefresh(CONFIG, async () => {
      const error = new Error('portal unavailable');
      error.code = 'OPARL_NETWORK_ERROR';
      throw error;
    });

    expect(stale.metadata).toMatchObject({
      cacheStatus: 'stale-if-error',
      stale: true,
      refreshFailed: true,
      refreshError: {
        code: 'OPARL_NETWORK_ERROR',
        message: 'portal unavailable',
      },
    });
    expect(stale.snapshot.items[0].reference).toBe('DS-1');
  });

  test('does not turn a refresh failure without an allowed snapshot into data', async () => {
    const store = new BonnOparlCatalogueStore({ clock: () => 30_000 });
    await expect(store.getOrRefresh(CONFIG, async () => {
      throw new Error('no catalogue');
    })).rejects.toThrow('no catalogue');
  });

  test('preserves incomplete/truncated evidence instead of upgrading it', async () => {
    const store = new BonnOparlCatalogueStore({ clock: () => 40_000 });
    const result = await store.getOrRefresh(CONFIG, async () => snapshot([], {
      truncated: true,
      nextUrl: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2',
    }));

    expect(result.snapshot.truncated).toBe(true);
    expect(result.metadata.truncated).toBe(true);
    expect(result.snapshot.nextUrl).toContain('page=2');
  });

  test('enforces retained item and byte bounds fail-closed', async () => {
    const itemBound = new BonnOparlCatalogueStore({
      maxItems: 1,
      clock: () => 50_000,
    });
    await expect(itemBound.getOrRefresh(CONFIG, async () => snapshot([1, 2])))
      .rejects.toMatchObject({ code: 'OPARL_CATALOGUE_ITEM_LIMIT' });

    const byteBound = new BonnOparlCatalogueStore({
      maxBytes: 100,
      clock: () => 50_000,
    });
    await expect(byteBound.getOrRefresh(CONFIG, async () => snapshot([1])))
      .rejects.toMatchObject({ code: 'OPARL_CATALOGUE_BYTE_LIMIT' });
  });

  test('does not cross-contaminate different catalogue configurations', async () => {
    const store = new BonnOparlCatalogueStore({ clock: () => 60_000 });
    const loader = jest.fn(async () => snapshot([loader.mock.calls.length]));
    const otherConfig = { ...CONFIG, maxScanPages: 50 };

    const first = await store.getOrRefresh(CONFIG, loader);
    const second = await store.getOrRefresh(otherConfig, loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(first.metadata.snapshotKey).not.toBe(second.metadata.snapshotKey);
    expect(buildCatalogueKey(CONFIG)).not.toBe(buildCatalogueKey(otherConfig));
  });

  test('uses LRU eviction for the configured number of snapshots', async () => {
    const store = new BonnOparlCatalogueStore({
      maxSnapshots: 2,
      clock: () => 70_000,
    });
    await store.getOrRefresh({ ...CONFIG, maxScanPages: 1 }, async () => snapshot([1]));
    await store.getOrRefresh({ ...CONFIG, maxScanPages: 2 }, async () => snapshot([2]));
    await store.getOrRefresh({ ...CONFIG, maxScanPages: 3 }, async () => snapshot([3]));
    expect(store.size()).toBe(2);
  });

  test('exposes a typed error for malformed loader output', async () => {
    const store = new BonnOparlCatalogueStore({ clock: () => 80_000 });
    await expect(store.getOrRefresh(CONFIG, async () => ({ nope: true })))
      .rejects.toBeInstanceOf(BonnOparlCatalogueStoreError);
  });
});
