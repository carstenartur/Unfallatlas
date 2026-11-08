/* Bounded immutable RIS v2 trees, shared by publication and browser readers. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) (root.UA = root.UA || {}).RisPartitions = api;
})(typeof window === 'object' ? window : null, () => {
  'use strict';

  const MAX_BYTES = 262144,
    FANOUT = 64,
    PAGE_SIZE = 64;
  const ROOTS = ['records', 'locations', 'relations', 'search', 'geometry', 'links', 'spatial'];
  const key = (id, page = 0) => JSON.stringify([id, page]);
  const fold = value => String(value || '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  function invalid(message = 'Invalid RIS partition') {
    return Object.assign(new Error(message), {
      code: 'RIS_SNAPSHOT_INVALID'
    });
  }
  function descriptor(value, city) {
    return value
        && /^[a-f0-9]{64}$/.test(value.sha256)
        && value.path === `${city}.${value.sha256}.${value.kind}.json.gz`
        && /^(records|locations|relations|search|geometry|links|spatial)$/.test(value.kind)
        && Number.isSafeInteger(value.bytes)
        && value.bytes > 0
        && value.bytes <= MAX_BYTES
        && Number.isSafeInteger(value.count)
        && value.count >= 0
        && value.count <= FANOUT;
  }
  function manifest(value, city) {
    if (value?.schemaVersion !== 2
        || value.city !== city
        || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(city)
        || !/^[a-f0-9]{64}$/.test(value.generation)
        || !ROOTS.every(k => descriptor(value.roots?.[k], city)
        && value.roots[k].kind === k)
        || !Number.isSafeInteger(value.recordCount)
        || value.recordCount < 1
        || !Number.isSafeInteger(value.geometryCount)
        || value.geometryCount < 0
        || !Number.isSafeInteger(value.mappedRecordCount)
        || value.mappedRecordCount < 0
        || value.mappedRecordCount > value.recordCount
        || ![0, 4, 6, 8].includes(value.overviewZoom)
        || value.gridZoom !== 12) throw invalid('Invalid RIS partition manifest');
    return value;
  }
  function node(value, ref, city) {
    if (!value
        || !['leaf', 'branch'].includes(value.type)
        || !Array.isArray(value.entries)
        || value.entries.length !== ref.count
        || value.entries.length > FANOUT) throw invalid();
    let prior = null;
    for (const entry of value.entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || prior !== null && entry[0] <= prior) throw invalid();
      prior = entry[0];
      if (value.type === 'branch' && (!descriptor(entry[1], city) || entry[1].kind !== ref.kind)) throw invalid();
      if (value.type === 'leaf') {
        const [id, item] = entry;
        if (ref.kind === 'records'
            && (!item
            || item.id !== id
            || !Number.isSafeInteger(item.locationCount)
            || item.locationCount < 0)) throw invalid('Invalid RIS record directory');
        if(ref.kind==='relations' && id.startsWith('member:') && (!item || !/^component:[a-f0-9]{64}$/.test(item.component) || !Number.isSafeInteger(item.position) || item.position<0))throw invalid('Invalid RIS relation membership');
        if(ref.kind==='records' && ((item.hasLocations!==undefined && item.hasLocations!==true) || (item.locationCount>0 && item.hasLocations!==true)))throw invalid('Invalid RIS location presence metadata');
        if (!['records', 'geometry'].includes(ref.kind) && id.startsWith('[')) {
          let tuple;
          try {
            tuple = JSON.parse(id);
          } catch {
            throw invalid('Invalid RIS page key');
          }
          if (!Array.isArray(tuple)
              || tuple.length !== 2
              || typeof tuple[0] !== 'string'
              || !Number.isSafeInteger(tuple[1])
              || tuple[1] < 0) throw invalid('Invalid RIS page key');
          if (!item
              || !Array.isArray(item.items)
              || !item.items.length
              || item.items.length > PAGE_SIZE
              || !Number.isSafeInteger(item.start)
              || item.start < 0
              || !Number.isSafeInteger(item.total)
              || item.total < item.items.length
              || tuple[1] === 0
              && item.start !== 0
              || (item.nextPage === null ? item.start + item.items.length !== item.total : item.nextPage !== tuple[1] + 1
              || item.start + item.items.length >= item.total)) throw invalid('Invalid RIS page shape');
        }
      }
    }
    return value;
  }
  function createReader({
    manifest: m,
    load,
    cacheBytes = 8 * 1024 * 1024,
    concurrency = 4
  }) {
    manifest(m, m.city);
    const budgets = typeof module === 'object' && module.exports ? require('./ua.data-budget') : window.UA.DataBudget;
    const cache = budgets.createByteCache(cacheBytes),
      scheduler = budgets.createScheduler(concurrency);
    function asset(ref, budget) {
      if (!descriptor(ref, m.city)) return Promise.reject(invalid());
      if (budget && !budget.seen.has(ref.path)) {
        if (budget.bytes + ref.bytes > budget.maxBytes || budget.seen.size >= budget.maxAssets) throw Object.assign(new Error('RIS map query budget reached'), {
          code: 'RIS_QUERY_BUDGET'
        });
        budget.seen.add(ref.path);
        budget.bytes += ref.bytes;
      }
      const existing = cache.get(ref.path);
      if (existing) return existing;
      const promise = scheduler.run(async () => node(await load(ref), ref, m.city));
      cache.set(ref.path, promise, ref.bytes);
      promise.catch(() => {
        if (cache.get(ref.path) === promise) cache.delete(ref.path);
      });
      return promise;
    }
    async function get(kind, wanted, budget) {
      let ref = m.roots[kind],
        lower = null,
        upper = null;
      for (let depth = 0; depth < 32; depth++) {
        const n = await asset(ref, budget);
        if (upper !== null && (n.entries.at(-1)?.[0] !== upper || lower !== null && n.entries[0]?.[0] <= lower)) throw invalid('Invalid RIS directory range');
        if (n.type === 'leaf') return n.entries.find(([k]) => k === wanted)?.[1] ?? null;
        const next = n.entries.find(([upper]) => wanted <= upper);
        if (!next) return null;
        const index = n.entries.indexOf(next);
        lower = index ? n.entries[index - 1][0] : lower;
        upper = next[0];
        ref = next[1];
      }
      throw invalid('RIS tree depth exceeded');
    }
    async function walk(kind, visit) {
      const seen = new Set();
      async function descend(ref, depth, lower = null, upper = null) {
        if (depth > 32 || seen.has(ref.path)) throw invalid('RIS tree cycle');
        seen.add(ref.path);
        const n = await asset(ref);
        if (upper !== null && (n.entries.at(-1)?.[0] !== upper || lower !== null && n.entries[0]?.[0] <= lower)) throw invalid('Invalid RIS directory range');
        await visit(ref, n);
        if (n.type === 'branch') for (let i = 0; i < n.entries.length; i++) await descend(n.entries[i][1], depth + 1, i ? n.entries[i - 1][0] : lower, n.entries[i][0]);
      }
      await descend(m.roots[kind], 0);
    }
    async function page(kind, id, index = 0, budget) {
      if (!Number.isSafeInteger(index) || index < 0) throw invalid('Invalid RIS page');
      const value = await get(kind, key(id, index), budget);
      if (!value) {
        if (index > 0) throw invalid('RIS page does not exist');
        return {
          items: [],
          total: 0,
          start: 0,
          page: 0,
          nextPage: null,
          complete: true,
          missing: []
        };
      }
      if (!Array.isArray(value.items)
          || value.items.length > PAGE_SIZE
          || !Number.isSafeInteger(value.total)
          || value.total < value.items.length
          || value.nextPage !== null
          && value.nextPage !== index + 1) throw invalid('Invalid RIS page');
      if (!value.items.length
          || !Number.isSafeInteger(value.start)
          || value.start < 0
          || index === 0
          && value.start !== 0
          || (value.nextPage === null ? value.start + value.items.length !== value.total : value.start + value.items.length >= value.total)) throw invalid('Inconsistent RIS page totals');
      if (index > 0) {
        const prior = await get(kind, key(id, index - 1), budget);
        if (!prior
            || prior.nextPage !== index
            || prior.total !== value.total
            || prior.start + prior.items.length !== value.start) throw invalid('Inconsistent RIS page chain');
      }
      return {
        ...value,
        page: index,
        complete: true,
        missing: []
      };
    }
    function scoped({
      maxBytes = 3 * 1024 * 1024,
      maxAssets = 128
    } = {}) {
      const budget = {
        maxBytes,
        maxAssets,
        bytes: 0,
        seen: new Set()
      };
      return {
        get: (kind, key) => get(kind, key, budget),
        page: (kind, id, index) => page(kind, id, index, budget),
        stats: () => ({
          bytes: budget.bytes,
          assets: budget.seen.size
        })
      };
    }
    return {
      scoped,
      get,
      page,
      walk,
      asset
    };
  }
  return {
    MAX_BYTES,
    FANOUT,
    PAGE_SIZE,
    ROOTS,
    key,
    fold,
    descriptor,
    manifest,
    node,
    createReader,
    invalid
  };
});
