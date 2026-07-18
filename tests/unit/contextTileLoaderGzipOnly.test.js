'use strict';

const fs = require('fs');
const path = require('path');

function loadModule() {
  const win = { UA: {}, requestIdleCallback: undefined };
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../js/ua.context_layers.js'),
    'utf8',
  );
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
  return win.UA;
}

function v3State() {
  return {
    slug: 'bonn',
    ways: {},
    geometries: {},
    dicts: { highway: ['residential'] },
    tileIndexUrl: 'out/ctxtiles/bonn/index.json',
    tileIndex: {
      z: 0,
      tiles: [{ x: 0, y: 0, wayCount: 1 }],
      wayIndex: { W1: [0, 0] },
      tileUrlByKey: new Map([
        ['0/0', 'out/ctxtiles/bonn/0/0.json'],
      ]),
    },
    _tileCache: new Map(),
  };
}

const tilePayload = {
  schemaVersion: 3,
  ways: { W1: { highway: 0, road_slope_percent: 2.5 } },
  geometries: { W1: [50.7, 7.1, 50.71, 7.11] },
};

describe('v3 context tile loading', () => {
  test('viewport loading explicitly requests gzip-only tiles', async () => {
    const UA = loadModule();
    const calls = [];
    UA.fetchJsonCompressed = async (url, options) => {
      calls.push({ url, options });
      return tilePayload;
    };
    const state = v3State();
    const worldBounds = {
      getSouth: () => -80,
      getNorth: () => 80,
      getWest: () => -170,
      getEast: () => 170,
    };

    const merged = await UA.contextLayers.loadTilesForBbox(state, worldBounds);

    expect(calls).toEqual([{
      url: 'out/ctxtiles/bonn/0/0.json',
      options: { cache: 'force-cache', gzipOnly: true },
    }]);
    expect(merged.ways.W1).toEqual(tilePayload.ways.W1);
    expect(merged.geometries.W1).toEqual(tilePayload.geometries.W1);
  });

  test('popup hydration uses the same gzip-only tile contract', async () => {
    const UA = loadModule();
    const calls = [];
    UA.fetchJsonCompressed = async (url, options) => {
      calls.push({ url, options });
      return tilePayload;
    };
    const state = v3State();

    expect(UA.contextLayers.resolveWayAcrossTiles(state, 'W1')).toBeNull();
    await state._tileCache.get('0/0');

    expect(calls).toEqual([{
      url: 'out/ctxtiles/bonn/0/0.json',
      options: { cache: 'force-cache', gzipOnly: true },
    }]);
    expect(UA.contextLayers.resolveWayAcrossTiles(state, 'W1'))
      .toEqual({ highway: 'residential', road_slope_percent: 2.5 });
  });

  test('never falls back to raw fetch when the gzip helper is unavailable', async () => {
    const UA = loadModule();
    const state = v3State();
    const rawFetch = jest.fn();
    global.fetch = rawFetch;
    const worldBounds = {
      getSouth: () => -80,
      getNorth: () => 80,
      getWest: () => -170,
      getEast: () => 170,
    };
    const originalWarn = console.warn;
    console.warn = jest.fn();
    try {
      const merged = await UA.contextLayers.loadTilesForBbox(state, worldBounds);
      expect(rawFetch).not.toHaveBeenCalled();
      expect(merged.ways).toEqual({});
      expect(merged.geometries).toEqual({});
    } finally {
      console.warn = originalWarn;
      delete global.fetch;
    }
  });
});
