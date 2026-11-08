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
  const SPATIAL_FORMAT = 'packed-bounds-v1';
  function validBounds(bounds) {
    return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
      && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90
      && bounds[0] <= bounds[2] && bounds[1] <= bounds[3];
  }
  function spatialDescriptor(ref, city) {
    return descriptor(ref, city) && ref.kind === 'spatial' && Number.isSafeInteger(ref.featureCount)
      && ref.featureCount >= 0 && (ref.featureCount ? validBounds(ref.bounds) : ref.bounds === null);
  }
  function spatialFeatureKey(key, geometryId) {
    return typeof key === 'string' && /^feature:\d{16}:geometry:[a-f0-9]{64}$/.test(key)
      && key.endsWith(`:${geometryId}`);
  }
  function spatialLocator(value, geometryId, city) {
    return value && value.geometryId === geometryId && /^geometry:[a-f0-9]{64}$/.test(geometryId)
      && spatialFeatureKey(value.spatialKey, geometryId) && spatialDescriptor(value.asset, city)
      && value.asset.featureCount > 0;
  }
  function spatialMetadata(value, city) {
    let bounds = null, featureCount = 0;
    const grid = typeof module === 'object' && module.exports ? require('./ua.spatial-grid') : window.UA.SpatialGrid;
    for (const [key, item] of value.entries) {
      let box, count;
      if (value.type === 'branch') {
        if (!spatialDescriptor(item, city)) throw invalid('Invalid RIS spatial child descriptor');
        box = item.bounds; count = item.featureCount;
      } else if (key.startsWith('feature:')) {
        const id = item?.properties?.geometryId;
        if (item?.type !== 'Feature' || !spatialFeatureKey(key, id) || !validBounds(item.bounds)
            || !['official', 'derived', 'mixed'].includes(item.properties.accuracy)
            || !Number.isSafeInteger(item.properties.recordCount) || item.properties.recordCount < 1
            || JSON.stringify(grid.geometryBounds(item.geometry)) !== JSON.stringify(item.bounds)) {
          throw invalid('Invalid RIS spatial feature');
        }
        box = item.bounds; count = 1;
      } else {
        if (!key.startsWith('overview:') || !validBounds(item?.bounds) || !Number.isSafeInteger(item.count)
            || item.count < 1 || !Number.isSafeInteger(item.geometryCount) || item.geometryCount < 1) {
          throw invalid('Invalid RIS spatial overview');
        }
        continue;
      }
      featureCount += count;
      if (!Number.isSafeInteger(featureCount)) throw invalid('Invalid RIS spatial feature total');
      if (!count) continue;
      bounds = bounds ? [Math.min(bounds[0], box[0]), Math.min(bounds[1], box[1]),
        Math.max(bounds[2], box[2]), Math.max(bounds[3], box[3])] : [...box];
    }
    return { bounds, featureCount };
  }
  // One bounded contract for both snapshot versions, in Node and the browser.
  function validProvenance(value, generatedAt, recordCount, coverage) {
    if (value === undefined) return true;
    const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
    const fields = (v, names) => object(v) && Object.keys(v).length === names.length
      && names.every(name => Object.prototype.hasOwnProperty.call(v, name));
    const text = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max
      && v.trim() === v && !/[<>\p{Cc}\p{Cf}\p{Cs}]/u.test(v);
    const count = v => Number.isSafeInteger(v) && v >= 0;
    const optionalCount = v => v === null || count(v);
    const time = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
      && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
    const day = v => v === null || typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
      && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
    if (!fields(value, ['schemaVersion', 'producer', 'builtAt', 'sourceVerifiedAt', 'provider', 'normalizationRevision',
      'sourceFingerprint', 'collection', 'rights', 'distribution']) || value.schemaVersion !== 1
      || !fields(value.producer, ['name', 'version']) || value.producer.name !== 'unfallwerkbank-ris' || !text(value.producer.version)
      || !time(value.builtAt) || !time(value.sourceVerifiedAt) || value.sourceVerifiedAt !== generatedAt
      || Date.parse(value.sourceVerifiedAt) > Date.parse(value.builtAt)
      || !text(value.provider, 80) || !text(value.normalizationRevision, 128)
      || !fields(value.sourceFingerprint, ['algorithm', 'kind', 'sha256'])
      || value.sourceFingerprint.algorithm !== 'sha256' || value.sourceFingerprint.kind !== 'provider-projection-v1'
      || typeof value.sourceFingerprint.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint.sha256)) return false;
    const c = value.collection, r = value.rights, d = value.distribution;
    if (!fields(c, ['pages', 'rawItems', 'normalizedItems', 'requestedFrom', 'requestedTo', 'limits', 'continuation'])
      || !optionalCount(c.pages) || !optionalCount(c.rawItems) || !count(c.normalizedItems) || c.normalizedItems !== recordCount
      || !day(c.requestedFrom) || !day(c.requestedTo) || c.requestedFrom && c.requestedTo && c.requestedFrom > c.requestedTo
      || !fields(c.limits, ['maxPages', 'pageSize', 'maxDocuments', 'workBudget', 'maxDurationMs'])
      || !Object.values(c.limits).every(optionalCount)
      || !fields(c.continuation, ['pending', 'interrupted', 'pendingYears', 'reason'])) return false;
    const next = c.continuation;
    if (![null, true, false].includes(next.pending) || ![null, true, false].includes(next.interrupted)
      || !Array.isArray(next.pendingYears) || next.pendingYears.length > 200
      || !next.pendingYears.every(y => Number.isSafeInteger(y) && y >= 1000 && y <= 9999)
      || new Set(next.pendingYears).size !== next.pendingYears.length
      || ![null, 'page-limit', 'work-budget', 'time-limit', 'source-failure'].includes(next.reason)
      || next.pendingYears.length && next.pending !== true
      || coverage?.complete === true && (next.pending === true || next.interrupted === true || next.reason !== null)) return false;
    return fields(r, ['status', 'license', 'attribution']) && ['specified', 'not-specified'].includes(r.status)
      && (r.status === 'specified' ? text(r.license, 128) : r.license === null)
      && Array.isArray(r.attribution) && r.attribution.length <= 16 && r.attribution.every(v => text(v, 512))
      && fields(d, ['compression', 'assetCount', 'compressedBytes', 'uncompressedBytes']) && d.compression === 'gzip'
      && [d.assetCount, d.compressedBytes, d.uncompressedBytes].every(v => count(v) && v > 0);
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
        || value.gridZoom !== 12
        || (value.spatialFormat !== undefined && value.spatialFormat !== SPATIAL_FORMAT)
        || (value.spatialFormat === SPATIAL_FORMAT && (!spatialDescriptor(value.roots.spatial, city) || value.roots.spatial.featureCount !== value.geometryCount))) throw invalid('Invalid RIS partition manifest');
    if (!validProvenance(value.provenance, value.generatedAt, value.recordCount, value.coverage)) throw invalid('Invalid RIS provenance');
    return value;
  }
  function node(value, ref, city, spatialFormat) {
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
    if (spatialFormat === SPATIAL_FORMAT) {
      if (ref.kind === 'spatial') {
        if (!spatialDescriptor(ref, city)) throw invalid('Invalid RIS spatial descriptor');
        const actual = spatialMetadata(value, city);
        if (actual.featureCount !== ref.featureCount || JSON.stringify(actual.bounds) !== JSON.stringify(ref.bounds)) {
          throw invalid('RIS spatial bounds or feature count mismatch');
        }
      } else if (ref.kind === 'geometry' && value.type === 'leaf') {
        for (const [id, locator] of value.entries) if (!spatialLocator(locator, id, city)) throw invalid('Invalid RIS geometry locator');
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
      const cacheKey = JSON.stringify([ref.path, ref.bytes, ref.count, ref.bounds, ref.featureCount]);
      const existing = cache.get(cacheKey);
      if (existing) return existing;
      const promise = scheduler.run(async () => node(await load(ref), ref, m.city, m.spatialFormat));
      cache.set(cacheKey, promise, ref.bytes);
      promise.catch(() => {
        if (cache.get(cacheKey) === promise) cache.delete(cacheKey);
      });
      return promise;
    }
    async function get(kind, wanted, budget, withReference = false) {
      let ref = m.roots[kind],
        lower = null,
        upper = null;
      for (let depth = 0; depth < 32; depth++) {
        const n = await asset(ref, budget);
        if (upper !== null && (n.entries.at(-1)?.[0] !== upper || lower !== null && n.entries[0]?.[0] <= lower)) throw invalid('Invalid RIS directory range');
        if (n.type === 'leaf') {
          const entry = n.entries.find(([key]) => key === wanted);
          return entry ? (withReference ? {value: entry[1], reference: ref} : entry[1]) : null;
        }
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
    async function spatial(bounds, limit = 1000, budget) {
      if (m.spatialFormat !== SPATIAL_FORMAT || !validBounds(bounds) || !Number.isSafeInteger(limit) || limit < 1) throw invalid('Invalid RIS spatial query');
      const grid = typeof module === 'object' && module.exports ? require('./ua.spatial-grid') : window.UA.SpatialGrid;
      const stack = [{ ref: m.roots.spatial, lower: null, upper: null, depth: 0 }], seen = new Set(), ids = new Set(), features = [];
      while (stack.length) {
        const { ref, lower, upper, depth } = stack.pop();
        if (depth > 32 || seen.has(ref.path)) throw invalid('Invalid RIS spatial tree');
        seen.add(ref.path);
        const value = await asset(ref, budget);
        if (upper !== null && (value.entries.at(-1)?.[0] !== upper || lower !== null && value.entries[0]?.[0] <= lower)) throw invalid('Invalid RIS spatial directory range');
        if (!ref.featureCount || !grid.intersectsBounds(ref.bounds, bounds)) continue;
        if (ref.featureCount > limit && bounds[0] <= ref.bounds[0] && bounds[1] <= ref.bounds[1]
            && bounds[2] >= ref.bounds[2] && bounds[3] >= ref.bounds[3]) return {features, truncated: true};
        if (value.type === 'branch') {
          for (let i = value.entries.length - 1; i >= 0; i--) {
            const [key, child] = value.entries[i];
            if (child.featureCount && grid.intersectsBounds(child.bounds, bounds)) {
              stack.push({ref: child, lower: i ? value.entries[i - 1][0] : lower, upper: key, depth: depth + 1});
            }
          }
        } else {
          for (const [key, feature] of value.entries) {
            if (!key.startsWith('feature:') || !grid.intersectsBounds(feature.bounds, bounds)) continue;
            const id = feature.properties.geometryId;
            if (ids.has(id)) throw invalid('Duplicate RIS spatial geometry');
            if (features.length >= limit) return {features, truncated: true};
            ids.add(id); features.push(feature);
          }
        }
      }
      return {features, truncated: false};
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
        locate: (kind, key) => get(kind, key, budget, true),
        asset: ref => asset(ref, budget),
        spatial: (bounds, limit) => spatial(bounds, limit, budget),
        get: (kind, key) => get(kind, key, budget),
        page: (kind, id, index) => page(kind, id, index, budget),
        stats: () => ({
          bytes: budget.bytes,
          assets: budget.seen.size
        })
      };
    }
    return {
      locate: (kind, key) => get(kind, key, undefined, true),
      scoped,
      spatial,
      get,
      page,
      walk,
      asset
    };
  }
  return {
    SPATIAL_FORMAT,
    validProvenance,
    validBounds,
    spatialDescriptor,
    spatialLocator,
    spatialMetadata,
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
