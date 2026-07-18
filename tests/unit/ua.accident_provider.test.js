'use strict';

const fs = require('fs');
const path = require('path');

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeFetch(responses, calls = []) {
  const map = responses instanceof Map ? responses : new Map(Object.entries(responses));
  return async (url) => {
    calls.push(url);
    const entry = map.get(url);
    if (!entry) return { ok: false, status: 404, json: async () => null };
    return {
      ok: entry.ok !== false,
      status: entry.ok === false ? 404 : 200,
      json: async () => entry.body,
    };
  };
}

function makeUA() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  loadModule('../../js/ua.core.js', win);
  // Test doubles keep transport parsing out of provider tests. The gzip helper
  // receives the real .gz URL, then maps it to the logical URL used by the
  // compact fake-response tables below.
  win.UA.fetchJsonCompressed = async (url, options = {}) => {
    const response = await options.fetch(url, { cache: options.cache });
    if (!response || !response.ok) throw new Error(`HTTP ${response && response.status} for ${url}`);
    return response.json();
  };
  win.UA.fetchJsonGz = async (url, options = {}) => {
    const logical = String(url).replace(/\.gz$/, '');
    const response = await options.fetch(logical, { cache: options.cache });
    if (!response || !response.ok) throw new Error(`HTTP ${response && response.status} for ${url}`);
    return response.json();
  };
  loadModule('../../js/ua.data_paths.js', win);
  loadModule('../../js/ua.accident_provider.js', win);
  return win.UA;
}

function fc(features = [], properties) {
  const result = { type: 'FeatureCollection', features };
  if (properties) result.properties = properties;
  return result;
}

function point(id, lat, lon) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id },
  };
}

function manifest(city = 'bonn', tiles = []) {
  return {
    schemaVersion: 1,
    city,
    z: 13,
    totalCount: tiles.reduce((sum, tile) => sum + (tile.count || 0), 0),
    sourceFingerprint: 'abc123',
    tiles,
  };
}

describe('UA.AccidentProvider', () => {
  let UA;

  beforeEach(() => { UA = makeUA(); });

  test('registers tiled before static providers by default', () => {
    expect(UA.AccidentProvider.ProviderRegistry.list().map(entry => entry.name))
      .toEqual(['tiled', 'static']);
  });

  test('exposes frozen API and constants', () => {
    expect(Object.isFrozen(UA.AccidentProvider)).toBe(true);
    expect(UA.AccidentProvider.PROVIDER_TYPES).toEqual(expect.objectContaining({
      STATIC_GEOJSON: 'staticGeoJson',
      TILED: 'tiled',
      CUSTOM: 'custom',
    }));
    expect(UA.AccidentProvider.ACCIDENT_TILE_DEFAULT_ZOOM).toBe(13);
  });

  test('merges FeatureCollections and preserves first properties block', () => {
    const result = UA.AccidentProvider._mergeFeatureCollections([
      fc([point('a', 50.7, 7.1)], { source: 'first' }),
      fc([point('b', 50.8, 7.2)]),
    ]);
    expect(result.features.map(feature => feature.properties.id)).toEqual(['a', 'b']);
    expect(result.properties).toEqual({ source: 'first' });
  });

  test('computes slippy tiles for plain and Leaflet bounds', () => {
    const plain = UA.AccidentProvider._tilesForBounds({
      south: 50.7, north: 50.8, west: 7.0, east: 7.2,
    }, 13);
    const leaflet = UA.AccidentProvider._tilesForBounds({
      getSouth: () => 50.7, getNorth: () => 50.8,
      getWest: () => 7.0, getEast: () => 7.2,
    }, 13);
    expect(plain.length).toBeGreaterThan(0);
    expect(leaflet).toEqual(plain);
  });

  test('validates provider shape', () => {
    expect(() => UA.AccidentProvider._assertProviderShape({})).toThrow(/fetchForCity/);
    expect(() => UA.AccidentProvider._assertProviderShape({
      fetchForCity() {}, fetchForBbox() {}, getCapabilities() {},
    })).not.toThrow();
  });

  describe('static provider', () => {
    test('loads the central accidentGeoJson resource and caches it', async () => {
      const calls = [];
      const payload = fc([point('a', 50.7, 7.1)]);
      const provider = UA.AccidentProvider.createStaticProvider({
        fetch: makeFetch({ 'out/output_all_years_bonn.geojson': { body: payload } }, calls),
      });
      expect(await provider.fetchForCity('Bonn')).toBe(payload);
      expect(await provider.fetchForBbox('Bonn', null)).toBe(payload);
      expect(calls).toEqual(['out/output_all_years_bonn.geojson']);
      expect(provider.getCapabilities()).toEqual(expect.objectContaining({
        supportsFullCity: true,
        supportsTiles: false,
        coverage: 'full-city',
      }));
    });

    test('supports custom base URL/pattern through DataResources transport', async () => {
      const payload = fc([point('a', 50.7, 7.1)]);
      const provider = UA.AccidentProvider.createStaticProvider({
        baseUrl: 'https://cdn.example/',
        filePattern: 'custom/{slug}.geojson',
        fetch: makeFetch({ 'https://cdn.example/custom/bonn.geojson': { body: payload } }),
      });
      expect((await provider.fetchForCity('Bonn')).features).toHaveLength(1);
    });
  });

  describe('tiled provider', () => {
    test('loads gzip-only manifest and tile resources via DataResources', async () => {
      const gzipCalls = [];
      UA.fetchJsonGz = jest.fn(async (url) => {
        gzipCalls.push(url);
        if (url.endsWith('/index.json.gz')) {
          return manifest('bonn', [{ x: 4256, y: 2754, count: 1 }]);
        }
        return fc([point('a', 50.73, 7.1)], { source: 'tile' });
      });
      const provider = UA.AccidentProvider.createTiledProvider();
      const result = await provider.fetchForCity('Bonn');
      expect(result.features).toHaveLength(1);
      expect(result.properties).toEqual({ source: 'tile' });
      expect(gzipCalls).toEqual([
        'out/accidenttiles/bonn/index.json.gz',
        'out/accidenttiles/bonn/13/4256/2754.json.gz',
      ]);
    });

    test('fetchForBbox requests only manifest-listed intersecting tiles', async () => {
      const calls = [];
      const wanted = UA.AccidentProvider._tilesForBounds({
        south: 50.729, north: 50.731, west: 7.099, east: 7.101,
      }, 13)[0];
      const far = [wanted[0] + 100, wanted[1] + 100];
      UA.fetchJsonGz = jest.fn(async (url) => {
        calls.push(url);
        if (url.endsWith('/index.json.gz')) {
          return manifest('bonn', [
            { x: wanted[0], y: wanted[1], count: 1 },
            { x: far[0], y: far[1], count: 1 },
          ]);
        }
        return fc([point('near', 50.73, 7.1)]);
      });
      const provider = UA.AccidentProvider.createTiledProvider();
      const result = await provider.fetchForBbox('Bonn', {
        south: 50.729, north: 50.731, west: 7.099, east: 7.101,
      });
      expect(result.features).toHaveLength(1);
      expect(calls.some(url => url.includes(`/${far[0]}/${far[1]}.json.gz`))).toBe(false);
    });

    test('returns unavailable capabilities when manifest is missing', async () => {
      UA.fetchJsonGz = jest.fn(async () => { throw new Error('404'); });
      const provider = UA.AccidentProvider.createTiledProvider();
      expect(await provider.canProvideForCity('Bonn')).toBe(false);
      expect(await provider.getCapabilities('Bonn')).toEqual(expect.objectContaining({
        supportsTiles: false,
        totalCount: null,
      }));
    });

    test('rejects unsupported schema and ignores mismatched manifest city for URLs', async () => {
      UA.fetchJsonGz = jest.fn(async (url) => {
        if (url.endsWith('/index.json.gz')) return { schemaVersion: 99, city: 'other', z: 13, tiles: [] };
        return null;
      });
      const provider = UA.AccidentProvider.createTiledProvider();
      await expect(provider.fetchForCity('Bonn')).rejects.toThrow(/No tile index/);
    });

    test('supports custom tile roots through central generic transport', async () => {
      const calls = [];
      const wantedManifest = manifest('bonn', [{ x: 1, y: 2, count: 1 }]);
      const provider = UA.AccidentProvider.createTiledProvider({
        tileRoot: 'custom/tiles',
        fetch: makeFetch({
          'custom/tiles/bonn/index.json': { body: wantedManifest },
          'custom/tiles/bonn/13/1/2.json': { body: fc([point('a', 50.7, 7.1)]) },
        }, calls),
      });
      expect((await provider.fetchForCity('Bonn')).features).toHaveLength(1);
      expect(calls).toEqual([
        'custom/tiles/bonn/index.json',
        'custom/tiles/bonn/13/1/2.json',
      ]);
    });
  });

  describe('ProviderRegistry', () => {
    test('prefers available tiled provider asynchronously', async () => {
      const registry = UA.AccidentProvider.ProviderRegistry;
      registry.clear();
      const staticProvider = {
        type: UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON,
        fetchForCity: jest.fn(), fetchForBbox: jest.fn(), getCapabilities: jest.fn(),
        canProvideForCity: () => true,
      };
      const tiledProvider = {
        type: UA.AccidentProvider.PROVIDER_TYPES.TILED,
        fetchForCity: jest.fn(), fetchForBbox: jest.fn(), getCapabilities: jest.fn(),
        canProvideForCity: async () => true,
      };
      registry.register('static', staticProvider);
      registry.register('tiled', tiledProvider);
      expect(await registry.resolveAsync('Bonn')).toBe(tiledProvider);
    });

    test('falls back to static provider when tile manifest is unavailable', async () => {
      const registry = UA.AccidentProvider.ProviderRegistry;
      registry.clear();
      const tiledProvider = {
        type: UA.AccidentProvider.PROVIDER_TYPES.TILED,
        fetchForCity: jest.fn(), fetchForBbox: jest.fn(), getCapabilities: jest.fn(),
        canProvideForCity: async () => false,
      };
      const staticProvider = {
        type: UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON,
        fetchForCity: jest.fn(), fetchForBbox: jest.fn(), getCapabilities: jest.fn(),
        canProvideForCity: () => true,
      };
      registry.register('tiled', tiledProvider);
      registry.register('static', staticProvider);
      expect(await registry.resolveAsync('Bonn')).toBe(staticProvider);
    });
  });
});
