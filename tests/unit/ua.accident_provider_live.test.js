'use strict';

const fs = require('fs');
const path = require('path');

function load(file, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js', file), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  load('ua.core.js', win);
  win.UA.fetchJsonCompressed = jest.fn();
  win.UA.fetchJsonGz = jest.fn();
  load('ua.data_paths.js', win);
  load('ua.accident_provider.js', win);
  return win.UA;
}

function point(id, lon, lat) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id },
  };
}

function payload(city, x, y, feature) {
  return {
    schemaVersion: 1,
    city,
    z: 13,
    x,
    y,
    type: 'FeatureCollection',
    features: [feature],
    featureIdentities: [`id:${feature.properties.id}`],
  };
}

async function loadAndRetain(provider, city, bounds) {
  const result = await provider.fetchTileSetForBbox(city, bounds);
  provider.retainForViewport(city, result.requestedTileKeys);
  return result;
}

const A = { south: 50.7298, west: 7.0998, north: 50.7302, east: 7.1002 };
const B = { south: 50.7298, west: 7.2998, north: 50.7302, east: 7.3002 };

describe('TiledAccidentProvider live viewport contract', () => {
  test('returns tile-aware metadata and persisted feature identities', async () => {
    const UA = makeUA();
    const [a] = UA.AccidentProvider._tilesForBounds(A, 13);
    const manifest = {
      schemaVersion: 1,
      city: 'bonn',
      z: 13,
      totalCount: 1,
      sourceFingerprint: 'sha256-a',
      tiles: [{ x: a[0], y: a[1], count: 1 }],
    };
    UA.fetchJsonGz = jest.fn(async url => url.endsWith('/index.json.gz')
      ? manifest
      : payload('bonn', a[0], a[1], point('a', 7.1, 50.73)));

    const provider = UA.AccidentProvider.createTiledProvider();
    const result = await provider.fetchTileSetForBbox('Bonn', A);

    expect(result).toEqual(expect.objectContaining({
      city: 'bonn',
      tileZoom: 13,
      requestedTileKeys: [`${a[0]}/${a[1]}`],
      loadedTileKeys: [`${a[0]}/${a[1]}`],
      missingTileKeys: [],
      manifestTileCount: 1,
      sourceTotalCount: 1,
      sourceFingerprint: 'sha256-a',
    }));
    expect(result.tiles[0].featureIdentities).toEqual(['id:a']);
    expect(result.tiles[0].featureCollection.features[0].properties.id).toBe('a');
  });

  test('turns an unavailable optional tile into explicit missing metadata', async () => {
    const UA = makeUA();
    const [a] = UA.AccidentProvider._tilesForBounds(A, 13);
    const [b] = UA.AccidentProvider._tilesForBounds(B, 13);
    expect(b).not.toEqual(a);
    const manifest = {
      schemaVersion: 1,
      city: 'bonn',
      z: 13,
      totalCount: 2,
      sourceFingerprint: 'sha256-ab',
      tiles: [
        { x: a[0], y: a[1], count: 1 },
        { x: b[0], y: b[1], count: 1 },
      ],
    };
    UA.fetchJsonGz = jest.fn(async url => {
      if (url.endsWith('/index.json.gz')) return manifest;
      if (url.endsWith(`/${a[0]}/${a[1]}.json.gz`)) {
        return payload('bonn', a[0], a[1], point('a', 7.1, 50.73));
      }
      return null;
    });

    const provider = UA.AccidentProvider.createTiledProvider();
    const result = await provider.fetchTileSetForBbox('Bonn', {
      south: 50.7298, west: 7.0998, north: 50.7302, east: 7.3002,
    });

    expect(result.loadedTileKeys).toEqual([`${a[0]}/${a[1]}`]);
    expect(result.missingTileKeys).toEqual([`${b[0]}/${b[1]}`]);
    expect(result.tiles).toHaveLength(1);
  });

  test('reuses cached tiles when returning to a previous viewport', async () => {
    const UA = makeUA();
    const [a] = UA.AccidentProvider._tilesForBounds(A, 13);
    const [b] = UA.AccidentProvider._tilesForBounds(B, 13);
    const manifest = {
      schemaVersion: 1,
      city: 'bonn',
      z: 13,
      totalCount: 2,
      tiles: [
        { x: a[0], y: a[1], count: 1 },
        { x: b[0], y: b[1], count: 1 },
      ],
    };
    UA.fetchJsonGz = jest.fn(async url => {
      if (url.endsWith('/index.json.gz')) return manifest;
      if (url.endsWith(`/${a[0]}/${a[1]}.json.gz`)) {
        return payload('bonn', a[0], a[1], point('a', 7.1, 50.73));
      }
      return payload('bonn', b[0], b[1], point('b', 7.3, 50.73));
    });

    const provider = UA.AccidentProvider.createTiledProvider({ maxCachedTiles: 2 });
    await loadAndRetain(provider, 'Bonn', A);
    await loadAndRetain(provider, 'Bonn', B);
    await loadAndRetain(provider, 'Bonn', A);

    const tileCalls = UA.fetchJsonGz.mock.calls.map(call => call[0])
      .filter(url => !url.endsWith('/index.json.gz'));
    expect(tileCalls.filter(url => url.endsWith(`/${a[0]}/${a[1]}.json.gz`)))
      .toHaveLength(1);
    expect(tileCalls.filter(url => url.endsWith(`/${b[0]}/${b[1]}.json.gz`)))
      .toHaveLength(1);
  });

  test('bounds inactive cache entries only after the committed viewport is retained', async () => {
    const UA = makeUA();
    const [a] = UA.AccidentProvider._tilesForBounds(A, 13);
    const [b] = UA.AccidentProvider._tilesForBounds(B, 13);
    const keyA = `${a[0]}/${a[1]}`;
    const keyB = `${b[0]}/${b[1]}`;
    const manifest = {
      schemaVersion: 1,
      city: 'bonn',
      z: 13,
      totalCount: 2,
      tiles: [
        { x: a[0], y: a[1], count: 1 },
        { x: b[0], y: b[1], count: 1 },
      ],
    };
    UA.fetchJsonGz = jest.fn(async url => {
      if (url.endsWith('/index.json.gz')) return manifest;
      const isA = url.endsWith(`/${a[0]}/${a[1]}.json.gz`);
      return isA
        ? payload('bonn', a[0], a[1], point('a', 7.1, 50.73))
        : payload('bonn', b[0], b[1], point('b', 7.3, 50.73));
    });

    const provider = UA.AccidentProvider.createTiledProvider({ maxCachedTiles: 1 });
    const resultA = await provider.fetchTileSetForBbox('Bonn', A);
    provider.retainForViewport('Bonn', resultA.requestedTileKeys);
    const resultB = await provider.fetchTileSetForBbox('Bonn', B);

    // Merely completing B must not evict A. Only the controller-confirmed
    // viewport commit decides which keys are pinned during eviction.
    expect(provider.getCacheSnapshot('Bonn').cities.bonn.tileKeys.sort())
      .toEqual([keyA, keyB].sort());
    provider.retainForViewport('Bonn', resultB.requestedTileKeys);
    expect(provider.getCacheSnapshot('Bonn').cities.bonn.tileKeys).toEqual([keyB]);

    const nextA = await provider.fetchTileSetForBbox('Bonn', A);
    provider.retainForViewport('Bonn', nextA.requestedTileKeys);
    expect(provider.getCacheSnapshot('Bonn').cities.bonn.tileKeys).toEqual([keyA]);
    const callsForA = UA.fetchJsonGz.mock.calls.map(call => call[0])
      .filter(url => url.endsWith(`/${a[0]}/${a[1]}.json.gz`));
    expect(callsForA).toHaveLength(2);
  });

  test('partitions cache state by city and clears one city independently', async () => {
    const UA = makeUA();
    const [a] = UA.AccidentProvider._tilesForBounds(A, 13);
    UA.fetchJsonGz = jest.fn(async url => {
      const city = url.includes('/hannover/') ? 'hannover' : 'bonn';
      if (url.endsWith('/index.json.gz')) {
        return {
          schemaVersion: 1,
          city,
          z: 13,
          totalCount: 1,
          tiles: [{ x: a[0], y: a[1], count: 1 }],
        };
      }
      return payload(city, a[0], a[1], point(city, 7.1, 50.73));
    });

    const provider = UA.AccidentProvider.createTiledProvider();
    await provider.fetchTileSetForBbox('Bonn', A);
    await provider.fetchTileSetForBbox('Hannover', A);
    provider.clearCache('Bonn');

    const snapshot = provider.getCacheSnapshot();
    expect(snapshot.cities.bonn).toBeUndefined();
    expect(snapshot.cities.hannover.tileKeys).toHaveLength(1);
  });
});
