'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Module loader
// ---------------------------------------------------------------------------

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  // ua.core.js provides UA.normKey — load it first
  loadModule('../../js/ua.core.js', win);
  loadModule('../../js/ua.accident_provider.js', win);
  return win.UA;
}

// ---------------------------------------------------------------------------
// Fake fetch helpers
// ---------------------------------------------------------------------------

function makeFetch(responses) {
  // responses: Map<url, {ok, body}> or object with url keys
  const map = (responses instanceof Map) ? responses : new Map(Object.entries(responses));
  return async (url) => {
    const entry = map.get(url);
    if (!entry) return { ok: false, status: 404, json: async () => null };
    return {
      ok:     entry.ok !== false,
      status: entry.ok === false ? 404 : 200,
      json:   async () => entry.body,
    };
  };
}

function makeFeatureCollection(features, props) {
  const fc = { type: 'FeatureCollection', features: features || [] };
  if (props) fc.properties = props;
  return fc;
}

function makePoint(lat, lon, props) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: props || {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UA.AccidentProvider', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  // -------------------------------------------------------------------------
  describe('module shape', () => {
    test('exposes expected public API', () => {
      expect(typeof UA.AccidentProvider).toBe('object');
      expect(UA.AccidentProvider).not.toBeNull();
      expect(typeof UA.AccidentProvider.createStaticProvider).toBe('function');
      expect(typeof UA.AccidentProvider.createTiledProvider).toBe('function');
      expect(typeof UA.AccidentProvider.ProviderRegistry).toBe('object');
      expect(typeof UA.AccidentProvider.PROVIDER_TYPES).toBe('object');
      expect(Object.isFrozen(UA.AccidentProvider.PROVIDER_TYPES)).toBe(true);
      expect(Object.isFrozen(UA.AccidentProvider)).toBe(true);
    });

    test('exposes PROVIDER_TYPES constants', () => {
      const PT = UA.AccidentProvider.PROVIDER_TYPES;
      expect(PT.STATIC_GEOJSON).toBe('staticGeoJson');
      expect(PT.TILED).toBe('tiled');
      expect(PT.CUSTOM).toBe('custom');
    });

    test('exposes tile defaults', () => {
      expect(typeof UA.AccidentProvider.ACCIDENT_TILE_DEFAULT_ZOOM).toBe('number');
      expect(UA.AccidentProvider.ACCIDENT_TILE_DEFAULT_ZOOM).toBe(13);
      expect(Array.isArray(UA.AccidentProvider.SUPPORTED_TILE_SCHEMA_VERSIONS)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('_mergeFeatureCollections', () => {
    test('merges empty array into empty FeatureCollection', () => {
      const result = UA.AccidentProvider._mergeFeatureCollections([]);
      expect(result.type).toBe('FeatureCollection');
      expect(result.features).toEqual([]);
    });

    test('merges null/undefined entries gracefully', () => {
      const result = UA.AccidentProvider._mergeFeatureCollections([null, undefined, null]);
      expect(result.features).toEqual([]);
    });

    test('merges two FeatureCollections', () => {
      const fc1 = makeFeatureCollection([makePoint(52, 9, { id: 'a' })]);
      const fc2 = makeFeatureCollection([makePoint(53, 10, { id: 'b' })]);
      const result = UA.AccidentProvider._mergeFeatureCollections([fc1, fc2]);
      expect(result.type).toBe('FeatureCollection');
      expect(result.features).toHaveLength(2);
    });

    test('preserves top-level properties from first collection with properties', () => {
      const fc1 = makeFeatureCollection([], { source: 'test' });
      const fc2 = makeFeatureCollection([makePoint(52, 9)]);
      const result = UA.AccidentProvider._mergeFeatureCollections([fc1, fc2]);
      expect(result.properties).toEqual({ source: 'test' });
    });

    test('handles raw feature arrays', () => {
      const f1 = makePoint(52, 9);
      const f2 = makePoint(53, 10);
      const result = UA.AccidentProvider._mergeFeatureCollections([[f1, f2]]);
      expect(result.features).toHaveLength(2);
    });

    test('skips null features inside collections', () => {
      const fc = { type: 'FeatureCollection', features: [null, makePoint(52, 9), null] };
      const result = UA.AccidentProvider._mergeFeatureCollections([fc]);
      expect(result.features).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('_tilesForBounds', () => {
    const fn = () => UA.AccidentProvider._tilesForBounds;

    test('returns empty array for null bounds', () => {
      expect(UA.AccidentProvider._tilesForBounds(null, 13)).toEqual([]);
    });

    test('returns empty array for non-finite bounds', () => {
      expect(UA.AccidentProvider._tilesForBounds({ south: NaN, north: 53, west: 9, east: 10 }, 13)).toEqual([]);
    });

    test('returns at least one tile for a valid point', () => {
      const bounds = { south: 51.0, north: 51.5, west: 9.0, east: 9.5 };
      const tiles = UA.AccidentProvider._tilesForBounds(bounds, 13);
      expect(tiles.length).toBeGreaterThanOrEqual(1);
      for (const [x, y] of tiles) {
        expect(typeof x).toBe('number');
        expect(typeof y).toBe('number');
      }
    });

    test('supports Leaflet-like bounds object (getSouth/getNorth/getWest/getEast)', () => {
      const bounds = {
        getSouth: () => 52.0, getNorth: () => 52.5,
        getWest:  () => 9.0,  getEast:  () => 9.5,
      };
      const tiles = UA.AccidentProvider._tilesForBounds(bounds, 13);
      expect(tiles.length).toBeGreaterThanOrEqual(1);
    });

    test('supports array bounds [south, west, north, east]', () => {
      const tiles = UA.AccidentProvider._tilesForBounds([52.0, 9.0, 52.5, 9.5], 13);
      expect(tiles.length).toBeGreaterThanOrEqual(1);
    });

    test('returns multiple tiles for a larger area', () => {
      const bounds = { south: 50.0, north: 54.0, west: 6.0, east: 15.0 };
      const tiles = UA.AccidentProvider._tilesForBounds(bounds, 13);
      expect(tiles.length).toBeGreaterThan(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('_assertProviderShape', () => {
    test('does not throw for a valid provider', () => {
      const valid = {
        fetchForCity:    () => Promise.resolve(),
        fetchForBbox:    () => Promise.resolve(),
        getCapabilities: () => ({}),
      };
      expect(() => UA.AccidentProvider._assertProviderShape(valid)).not.toThrow();
    });

    test('throws for null', () => {
      expect(() => UA.AccidentProvider._assertProviderShape(null)).toThrow(TypeError);
    });

    test('throws when fetchForCity is missing', () => {
      expect(() => UA.AccidentProvider._assertProviderShape({
        fetchForBbox: () => {}, getCapabilities: () => {},
      })).toThrow(TypeError);
    });

    test('throws when fetchForBbox is missing', () => {
      expect(() => UA.AccidentProvider._assertProviderShape({
        fetchForCity: () => {}, getCapabilities: () => {},
      })).toThrow(TypeError);
    });

    test('throws when getCapabilities is missing', () => {
      expect(() => UA.AccidentProvider._assertProviderShape({
        fetchForCity: () => {}, fetchForBbox: () => {},
      })).toThrow(TypeError);
    });
  });

  // -------------------------------------------------------------------------
  describe('StaticGeoJsonAccidentProvider', () => {
    const CITY = 'bonn';

    function makeProvider(responses) {
      return UA.AccidentProvider.createStaticProvider({ fetch: makeFetch(responses) });
    }

    test('has type STATIC_GEOJSON', () => {
      const p = makeProvider({});
      expect(p.type).toBe(UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON);
    });

    test('is frozen', () => {
      const p = makeProvider({});
      expect(Object.isFrozen(p)).toBe(true);
    });

    test('getCapabilities returns correct shape', () => {
      const p = makeProvider({});
      const caps = p.getCapabilities(CITY);
      expect(caps.supportsFullCity).toBe(true);
      expect(caps.supportsTiles).toBe(false);
      expect(Object.isFrozen(caps)).toBe(true);
    });

    test('canProvideForCity always returns true', () => {
      const p = makeProvider({});
      expect(p.canProvideForCity(CITY)).toBe(true);
      expect(p.canProvideForCity('any-city')).toBe(true);
    });

    test('fetchForCity resolves with FeatureCollection', async () => {
      const fc = makeFeatureCollection([makePoint(50.7, 7.0)]);
      const p  = makeProvider({ 'out/output_all_years_bonn.geojson': { body: fc } });
      const result = await p.fetchForCity(CITY);
      expect(result.type).toBe('FeatureCollection');
      expect(result.features).toHaveLength(1);
    });

    test('fetchForCity uses UA.normKey to slugify city name', async () => {
      const fc = makeFeatureCollection([makePoint(50.7, 7.0)]);
      const p  = makeProvider({ 'out/output_all_years_bonn.geojson': { body: fc } });
      const result = await p.fetchForCity('Bonn');
      expect(result.features).toHaveLength(1);
    });

    test('fetchForCity caches repeated calls (single fetch)', async () => {
      let callCount = 0;
      const fetchFn = async (url) => {
        callCount++;
        return { ok: true, json: async () => makeFeatureCollection([]) };
      };
      const p = UA.AccidentProvider.createStaticProvider({ fetch: fetchFn });
      await p.fetchForCity(CITY);
      await p.fetchForCity(CITY);
      expect(callCount).toBe(1);
    });

    test('fetchForCity rejects on HTTP error', async () => {
      const p = makeProvider({ 'out/output_all_years_bonn.geojson': { ok: false } });
      await expect(p.fetchForCity(CITY)).rejects.toThrow(/HTTP/);
    });

    test('clearCache allows re-fetching', async () => {
      let callCount = 0;
      const fetchFn = async () => {
        callCount++;
        return { ok: true, json: async () => makeFeatureCollection([]) };
      };
      const p = UA.AccidentProvider.createStaticProvider({ fetch: fetchFn });
      await p.fetchForCity(CITY);
      p.clearCache();
      await p.fetchForCity(CITY);
      expect(callCount).toBe(2);
    });

    test('fetchForBbox falls back to full city load', async () => {
      const fc = makeFeatureCollection([makePoint(50.7, 7.0)]);
      const p  = makeProvider({ 'out/output_all_years_bonn.geojson': { body: fc } });
      const result = await p.fetchForBbox(CITY, { south: 50.5, north: 50.9, west: 6.8, east: 7.2 });
      expect(result.type).toBe('FeatureCollection');
      expect(result.features).toHaveLength(1);
    });

    test('respects custom filePattern', async () => {
      const fc = makeFeatureCollection([makePoint(50.7, 7.0)]);
      // The pattern replaces {slug} with 'bonn', so the resolved URL is 'custom/accidents_bonn.geojson'
      const responses = { 'custom/accidents_bonn.geojson': { body: fc } };
      const p = UA.AccidentProvider.createStaticProvider({
        fetch: makeFetch(responses),
        filePattern: 'custom/accidents_{slug}.geojson',
      });
      const result = await p.fetchForCity('bonn');
      expect(result.features).toHaveLength(1);
    });

    test('respects custom baseUrl', async () => {
      const fc = makeFeatureCollection([makePoint(50.7, 7.0)]);
      const responses = { 'https://cdn.example.com/out/output_all_years_bonn.geojson': { body: fc } };
      const p = UA.AccidentProvider.createStaticProvider({
        fetch: makeFetch(responses),
        baseUrl: 'https://cdn.example.com/',
      });
      const result = await p.fetchForCity('bonn');
      expect(result.features).toHaveLength(1);
    });

    test('fetchForCity rejects when fetch is not available', async () => {
      const p = UA.AccidentProvider.createStaticProvider({ fetch: null });
      await expect(p.fetchForCity(CITY)).rejects.toThrow(/fetch is not available/);
    });
  });

  // -------------------------------------------------------------------------
  describe('TiledAccidentProvider', () => {
    const CITY = 'hannover';
    const Z = 13;

    function makeManifest(tiles, extras) {
      return Object.assign({
        schemaVersion: 1,
        city:          CITY,
        z:             Z,
        tiles,
        totalCount:    tiles.reduce((s, t) => s + (t.count || 0), 0),
        generatedAt:   '2026-01-01T00:00:00Z',
      }, extras || {});
    }

    function makeTile(features) {
      return makeFeatureCollection(features);
    }

    function makeProvider(responses) {
      return UA.AccidentProvider.createTiledProvider({ fetch: makeFetch(responses) });
    }

    test('has type TILED', () => {
      const p = makeProvider({});
      expect(p.type).toBe(UA.AccidentProvider.PROVIDER_TYPES.TILED);
    });

    test('is frozen', () => {
      const p = makeProvider({});
      expect(Object.isFrozen(p)).toBe(true);
    });

    test('getCapabilities returns promise', async () => {
      const manifest = makeManifest([{ x: 4200, y: 2750, count: 5 }]);
      const responses = { [`out/accidenttiles/${CITY}/index.json`]: { body: manifest } };
      const p = makeProvider(responses);
      const caps = await p.getCapabilities(CITY);
      expect(caps.supportsFullCity).toBe(true);
      expect(caps.supportsTiles).toBe(true);
      expect(caps.tileZoom).toBe(Z);
      expect(caps.totalCount).toBe(manifest.totalCount);
    });

    test('getCapabilities supportsTiles is false when no manifest', async () => {
      const p = makeProvider({});
      const caps = await p.getCapabilities(CITY);
      expect(caps.supportsTiles).toBe(false);
    });

    test('canProvideForCity returns true when manifest exists', async () => {
      const manifest = makeManifest([{ x: 4200, y: 2750, count: 0 }]);
      const responses = { [`out/accidenttiles/${CITY}/index.json`]: { body: manifest } };
      const p = makeProvider(responses);
      const ok = await p.canProvideForCity(CITY);
      expect(ok).toBe(true);
    });

    test('canProvideForCity returns false when no manifest', async () => {
      const p = makeProvider({});
      const ok = await p.canProvideForCity(CITY);
      expect(ok).toBe(false);
    });

    test('fetchForCity merges all tiles into a FeatureCollection', async () => {
      const manifest = makeManifest([
        { x: 4200, y: 2750, count: 2 },
        { x: 4201, y: 2750, count: 1 },
      ]);
      const tile1 = makeTile([makePoint(52.4, 9.7), makePoint(52.5, 9.8)]);
      const tile2 = makeTile([makePoint(52.3, 9.9)]);
      const responses = {
        [`out/accidenttiles/${CITY}/index.json`]:              { body: manifest },
        [`out/accidenttiles/${CITY}/${Z}/4200/2750.json`]:    { body: tile1 },
        [`out/accidenttiles/${CITY}/${Z}/4201/2750.json`]:    { body: tile2 },
      };
      const p = makeProvider(responses);
      const result = await p.fetchForCity(CITY);
      expect(result.type).toBe('FeatureCollection');
      expect(result.features).toHaveLength(3);
    });

    test('fetchForCity throws when no manifest', async () => {
      const p = makeProvider({});
      await expect(p.fetchForCity(CITY)).rejects.toThrow(/No tile index found/);
    });

    test('fetchForBbox fetches only tiles intersecting bounds', async () => {
      const manifest = makeManifest([
        { x: 4200, y: 2750, count: 2 },
        { x: 4300, y: 2800, count: 1 }, // far away — should not be fetched
      ]);
      const tile = makeTile([makePoint(52.4, 9.7)]);
      let fetchedUrls = [];
      const fetchFn = async (url) => {
        fetchedUrls.push(url);
        if (url.endsWith('index.json')) {
          return { ok: true, json: async () => manifest };
        }
        if (url.includes('4200/2750')) {
          return { ok: true, json: async () => tile };
        }
        return { ok: false, status: 404, json: async () => null };
      };
      const p = UA.AccidentProvider.createTiledProvider({ fetch: fetchFn });
      // Bounds that only cover tile 4200/2750
      const bounds = { south: 52.37, north: 52.47, west: 9.65, east: 9.85 };
      const result = await p.fetchForBbox(CITY, bounds, Z);
      expect(result.type).toBe('FeatureCollection');
      // Should NOT have fetched tile 4300/2800
      const tileUrls = fetchedUrls.filter(u => !u.endsWith('index.json'));
      for (const u of tileUrls) {
        expect(u).not.toContain('4300');
      }
    });

    test('fetchForBbox returns empty FeatureCollection for empty bounds', async () => {
      const manifest = makeManifest([{ x: 4200, y: 2750, count: 0 }]);
      const responses = { [`out/accidenttiles/${CITY}/index.json`]: { body: manifest } };
      const p = makeProvider(responses);
      const result = await p.fetchForBbox(CITY, null, Z);
      expect(result.type).toBe('FeatureCollection');
      expect(result.features).toHaveLength(0);
    });

    test('fetchForBbox throws when no manifest', async () => {
      const p = makeProvider({});
      await expect(p.fetchForBbox(CITY, { south: 52, north: 53, west: 9, east: 10 }, Z)).rejects.toThrow(/No tile index found/);
    });

    test('ignores unsupported schemaVersion', async () => {
      const manifest = { schemaVersion: 99, city: CITY, z: Z, tiles: [], totalCount: 0 };
      const responses = { [`out/accidenttiles/${CITY}/index.json`]: { body: manifest } };
      const p = makeProvider(responses);
      // Should throw because manifest is null (unsupported version ignored)
      await expect(p.fetchForCity(CITY)).rejects.toThrow(/No tile index found/);
    });

    test('clearCache allows re-fetching manifest', async () => {
      let callCount = 0;
      const fetchFn = async (url) => {
        if (url.endsWith('index.json')) callCount++;
        return { ok: true, json: async () => makeManifest([]) };
      };
      const p = UA.AccidentProvider.createTiledProvider({ fetch: fetchFn });
      await p.canProvideForCity(CITY);
      p.clearCache();
      await p.canProvideForCity(CITY);
      expect(callCount).toBe(2);
    });

    test('respects custom tileRoot', async () => {
      const manifest = makeManifest([{ x: 1, y: 1, count: 0 }]);
      const responses = { [`custom/tiles/${CITY}/index.json`]: { body: manifest } };
      const p = UA.AccidentProvider.createTiledProvider({
        fetch: makeFetch(responses),
        tileRoot: 'custom/tiles',
      });
      const ok = await p.canProvideForCity(CITY);
      expect(ok).toBe(true);
    });

    test('gracefully handles 404 for individual tiles', async () => {
      const manifest = makeManifest([
        { x: 4200, y: 2750, count: 1 },
        { x: 4201, y: 2750, count: 1 },
      ]);
      const tile1 = makeTile([makePoint(52.4, 9.7)]);
      const responses = {
        [`out/accidenttiles/${CITY}/index.json`]:           { body: manifest },
        [`out/accidenttiles/${CITY}/${Z}/4200/2750.json`]: { body: tile1 },
        // 4201/2750 → 404 (not in responses)
      };
      const p = makeProvider(responses);
      const result = await p.fetchForCity(CITY);
      // Gets the one tile that succeeded
      expect(result.features).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('ProviderRegistry', () => {
    let registry;
    beforeEach(() => {
      // Use a fresh reference but clear the shared singleton
      registry = UA.AccidentProvider.ProviderRegistry;
      registry.clear();
    });

    afterEach(() => { registry.clear(); });

    function makeMinimalProvider(type) {
      return {
        type:            type || UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON,
        fetchForCity:    () => Promise.resolve({ type: 'FeatureCollection', features: [] }),
        fetchForBbox:    () => Promise.resolve({ type: 'FeatureCollection', features: [] }),
        getCapabilities: () => ({ supportsFullCity: true, supportsTiles: false }),
        canProvideForCity: () => true,
      };
    }

    test('register and get a provider', () => {
      const p = makeMinimalProvider();
      registry.register('static', p);
      expect(registry.get('static')).toBe(p);
    });

    test('get returns null for unregistered name', () => {
      expect(registry.get('nonexistent')).toBeNull();
    });

    test('throws when registering with invalid name', () => {
      expect(() => registry.register('', makeMinimalProvider())).toThrow(TypeError);
      expect(() => registry.register(null, makeMinimalProvider())).toThrow(TypeError);
    });

    test('throws when registering invalid provider', () => {
      expect(() => registry.register('bad', {})).toThrow(TypeError);
      expect(() => registry.register('bad', null)).toThrow(TypeError);
    });

    test('list returns all registered providers', () => {
      const p1 = makeMinimalProvider();
      const p2 = makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.TILED);
      registry.register('static', p1);
      registry.register('tiled', p2);
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map(e => e.name)).toContain('static');
      expect(list.map(e => e.name)).toContain('tiled');
    });

    test('list returns empty array when nothing registered', () => {
      expect(registry.list()).toEqual([]);
    });

    test('clear removes all providers', () => {
      registry.register('static', makeMinimalProvider());
      registry.clear();
      expect(registry.list()).toHaveLength(0);
      expect(registry.get('static')).toBeNull();
    });

    test('resolve returns null when registry is empty', () => {
      expect(registry.resolve('bonn')).toBeNull();
    });

    test('resolve returns the only registered provider', () => {
      const p = makeMinimalProvider();
      registry.register('static', p);
      expect(registry.resolve('bonn')).toBe(p);
    });

    test('resolve prefers tiled over static when canProvideForCity is synchronously true', () => {
      const staticP = makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON);
      const tiledP  = makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.TILED);
      registry.register('static', staticP);
      registry.register('tiled', tiledP);
      expect(registry.resolve('bonn')).toBe(tiledP);
    });

    test('resolve falls back to static when tiled canProvideForCity returns async/promise', () => {
      const staticP = makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON);
      const tiledP  = Object.assign(makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.TILED), {
        canProvideForCity: () => Promise.resolve(true), // async — not truthy synchronously
      });
      registry.register('static', staticP);
      registry.register('tiled', tiledP);
      expect(registry.resolve('bonn')).toBe(staticP);
    });

    test('resolveAsync prefers tiled when canProvideForCity resolves true', async () => {
      const staticP = makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON);
      const tiledP  = Object.assign(makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.TILED), {
        canProvideForCity: () => Promise.resolve(true),
      });
      registry.register('static', staticP);
      registry.register('tiled', tiledP);
      const resolved = await registry.resolveAsync('bonn');
      expect(resolved).toBe(tiledP);
    });

    test('resolveAsync falls back to static when tiled canProvideForCity rejects', async () => {
      const staticP = makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON);
      const tiledP  = Object.assign(makeMinimalProvider(UA.AccidentProvider.PROVIDER_TYPES.TILED), {
        canProvideForCity: () => Promise.reject(new Error('offline')),
      });
      registry.register('static', staticP);
      registry.register('tiled', tiledP);
      const resolved = await registry.resolveAsync('bonn');
      expect(resolved).toBe(staticP);
    });

    test('resolveAsync returns null when registry is empty', async () => {
      const resolved = await registry.resolveAsync('bonn');
      expect(resolved).toBeNull();
    });

    test('overwrites provider on duplicate register', () => {
      const p1 = makeMinimalProvider();
      const p2 = makeMinimalProvider();
      registry.register('static', p1);
      registry.register('static', p2);
      expect(registry.get('static')).toBe(p2);
      expect(registry.list()).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('full integration — static provider via registry', () => {
    let registry;
    beforeEach(() => {
      UA = makeUA();
      registry = UA.AccidentProvider.ProviderRegistry;
      registry.clear();
    });
    afterEach(() => { registry.clear(); });

    test('load city data via registered static provider', async () => {
      const fc = makeFeatureCollection([
        makePoint(52.4, 9.7, { severity: '1' }),
        makePoint(52.5, 9.8, { severity: '2' }),
      ]);
      const provider = UA.AccidentProvider.createStaticProvider({
        fetch: makeFetch({ 'out/output_all_years_hannover.geojson': { body: fc } }),
      });
      registry.register('static', provider);
      const resolved = registry.resolve('hannover');
      const result   = await resolved.fetchForCity('hannover');
      expect(result.features).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('full integration — tiled provider via registry', () => {
    let registry;
    beforeEach(() => {
      UA = makeUA();
      registry = UA.AccidentProvider.ProviderRegistry;
      registry.clear();
    });
    afterEach(() => { registry.clear(); });

    test('resolveAsync picks tiled over static when tiles exist', async () => {
      const CITY = 'hannover';
      const Z    = 13;
      const manifest = {
        schemaVersion: 1, city: CITY, z: Z,
        tiles: [{ x: 4222, y: 2760, count: 3 }], totalCount: 3,
      };
      const tile = makeFeatureCollection([
        makePoint(52.4, 9.7), makePoint(52.5, 9.8), makePoint(52.6, 9.9),
      ]);
      const responses = {
        [`out/accidenttiles/${CITY}/index.json`]:         { body: manifest },
        [`out/accidenttiles/${CITY}/${Z}/4222/2760.json`]: { body: tile },
      };
      const staticProvider = UA.AccidentProvider.createStaticProvider({
        fetch: makeFetch({}), // no static file
      });
      const tiledProvider = UA.AccidentProvider.createTiledProvider({
        fetch: makeFetch(responses),
      });
      registry.register('static', staticProvider);
      registry.register('tiled',  tiledProvider);

      const resolved = await registry.resolveAsync(CITY);
      expect(resolved.type).toBe(UA.AccidentProvider.PROVIDER_TYPES.TILED);

      const result = await resolved.fetchForCity(CITY);
      expect(result.features).toHaveLength(3);
    });
  });
});
