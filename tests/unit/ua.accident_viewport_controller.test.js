'use strict';

const fs = require('fs');
const path = require('path');

function load(file, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js', file), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function point(id, lon = 7.1, lat = 50.73, extra = {}) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { id, ...extra },
  };
}

function tile(key, features, identities) {
  const [x, y] = key.split('/').map(Number);
  return {
    key,
    x,
    y,
    featureCollection: { type: 'FeatureCollection', features },
    featureIdentities: identities,
  };
}

function tileSet(tiles, missing = []) {
  const loadedTileKeys = tiles.map(entry => entry.key);
  return {
    city: 'bonn',
    tileZoom: 13,
    requestedTileKeys: [...loadedTileKeys, ...missing],
    loadedTileKeys,
    missingTileKeys: missing,
    tiles,
    manifestTileCount: 7,
    sourceTotalCount: 100,
    sourceFingerprint: 'sha256-test',
  };
}

function makeUA(provider) {
  const win = { UA: {} };
  load('ua.core.js', win);
  win.UA.AccidentProvider = {
    _canonicalFeatureIdentity(feature) {
      return `id:${feature.properties.id}`;
    },
  };
  load('ua.accident_viewport_controller.js', win);
  return {
    UA: win.UA,
    controller: win.UA.AccidentViewportController.create({ provider }),
  };
}

const BOUNDS_A = { south: 50.72, west: 7.08, north: 50.74, east: 7.12 };
const BOUNDS_B = { south: 50.72, west: 7.30, north: 50.74, east: 7.34 };

describe('UA.AccidentViewportController', () => {
  test('publishes loading and complete-for-viewport coverage without claiming city completeness', async () => {
    const wait = deferred();
    const provider = { fetchTileSetForBbox: jest.fn(() => wait.promise) };
    const { controller } = makeUA(provider);

    const pending = controller.load('Bonn', BOUNDS_A);
    expect(controller.getSnapshot().coverage).toEqual(expect.objectContaining({
      status: 'loading',
      complete: false,
      viewportComplete: false,
      loadedFeatureCount: 0,
    }));

    wait.resolve(tileSet([
      tile('1/2', [point('a')], ['id:a']),
    ]));
    const result = await pending;

    expect(result.committed).toBe(true);
    expect(result.coverage).toEqual(expect.objectContaining({
      status: 'complete-for-viewport',
      complete: false,
      viewportComplete: true,
      requiredTileCount: 1,
      loadedTileCount: 1,
      missingTileCount: 0,
      loadedFeatureCount: 1,
      sourceTotalCount: 100,
    }));
    expect(Object.isFrozen(result.coverage)).toBe(true);
  });

  test('merges deterministically and deduplicates the same persisted identity', () => {
    const provider = { fetchTileSetForBbox: jest.fn() };
    const { UA } = makeUA(provider);
    const a = point('a');
    const merged = UA.AccidentViewportController._mergeTileSet(tileSet([
      tile('10/2', [point('b'), a], ['id:b', 'id:a']),
      tile('2/9', [a, point('c')], ['id:a', 'id:c']),
    ]));

    expect(merged.features.map(feature => feature.properties.id)).toEqual(['a', 'b', 'c']);
  });

  test('detects conflicting payloads for one stable identity', () => {
    const provider = { fetchTileSetForBbox: jest.fn() };
    const { UA } = makeUA(provider);
    expect(() => UA.AccidentViewportController._mergeTileSet(tileSet([
      tile('1/1', [point('a', 7.1)], ['id:a']),
      tile('1/2', [point('a', 7.2)], ['id:a']),
    ]))).toThrow(/conflicting duplicate feature identity id:a/);
  });

  test('suppresses a late response and retains cache only for the committed viewport', async () => {
    const first = deferred();
    const second = deferred();
    const provider = {
      fetchTileSetForBbox: jest.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
      retainForViewport: jest.fn(),
    };
    const { controller } = makeUA(provider);

    const firstPending = controller.load('Bonn', BOUNDS_A);
    const secondPending = controller.load('Bonn', BOUNDS_B);
    first.resolve(tileSet([tile('1/1', [point('old')], ['id:old'])]));
    expect(await firstPending).toEqual(expect.objectContaining({ committed: false, stale: true }));
    expect(provider.retainForViewport).not.toHaveBeenCalled();

    second.resolve(tileSet([tile('2/2', [point('current')], ['id:current'])]));
    const current = await secondPending;
    expect(current.committed).toBe(true);
    expect(provider.retainForViewport).toHaveBeenCalledTimes(1);
    expect(provider.retainForViewport).toHaveBeenCalledWith('bonn', ['2/2']);
    expect(controller.getSnapshot().geojson.features.map(f => f.properties.id))
      .toEqual(['current']);
  });

  test('an explicit invalidation makes an already running request stale', async () => {
    const wait = deferred();
    const provider = { fetchTileSetForBbox: jest.fn(() => wait.promise) };
    const { controller } = makeUA(provider);
    const pending = controller.load('Bonn', BOUNDS_A);

    controller.invalidate();
    wait.resolve(tileSet([tile('1/1', [point('late')], ['id:late'])]));

    expect(await pending).toEqual(expect.objectContaining({ committed: false, stale: true }));
    expect(controller.getSnapshot().geojson.features).toHaveLength(0);
  });

  test('city switches cannot retain features from the previous city', async () => {
    const provider = {
      fetchTileSetForBbox: jest.fn(async city => ({
        ...tileSet([tile('1/1', [point(city)], [`id:${city}`])]),
        city,
      })),
    };
    const { controller } = makeUA(provider);

    await controller.load('Bonn', BOUNDS_A);
    await controller.load('Hannover', BOUNDS_B);

    expect(controller.getSnapshot().city).toBe('hannover');
    expect(controller.getSnapshot().geojson.features.map(f => f.properties.id))
      .toEqual(['hannover']);
  });

  test('a fatal current request clears old features instead of relabelling them with new bounds', async () => {
    const provider = {
      fetchTileSetForBbox: jest.fn()
        .mockResolvedValueOnce(tileSet([tile('1/1', [point('old')], ['id:old'])]))
        .mockRejectedValueOnce(new Error('tile transport failed')),
    };
    const { controller } = makeUA(provider);
    await controller.load('Bonn', BOUNDS_A);

    const failed = await controller.load('Bonn', BOUNDS_B);

    expect(failed).toEqual(expect.objectContaining({
      committed: true,
      stale: false,
      changed: true,
    }));
    expect(failed.geojson.features).toEqual([]);
    expect(failed.coverage).toEqual(expect.objectContaining({
      status: 'degraded',
      viewportComplete: false,
      bounds: BOUNDS_B,
      loadedFeatureCount: 0,
      error: 'tile transport failed',
    }));
    expect(controller.getSnapshot().geojson.features).toEqual([]);
  });

  test('missing tiles produce degraded viewport coverage and never city completeness', async () => {
    const provider = {
      fetchTileSetForBbox: jest.fn(async () => tileSet([
        tile('1/1', [point('available')], ['id:available']),
      ], ['1/2'])),
    };
    const { controller } = makeUA(provider);
    const result = await controller.load('Bonn', BOUNDS_A);

    expect(result.coverage).toEqual(expect.objectContaining({
      status: 'degraded',
      complete: false,
      viewportComplete: false,
      requiredTileCount: 2,
      loadedTileCount: 1,
      missingTileCount: 1,
      missingTileKeys: ['1/2'],
    }));
  });

  test('clear invalidates requests and delegates cache clearing to the provider', () => {
    const provider = {
      fetchTileSetForBbox: jest.fn(),
      clearCache: jest.fn(),
    };
    const { controller } = makeUA(provider);
    const before = controller.getSnapshot().epoch;

    controller.clear('Bonn');

    expect(controller.getSnapshot().epoch).toBeGreaterThan(before);
    expect(provider.clearCache).toHaveBeenCalledWith('Bonn');
  });
});
