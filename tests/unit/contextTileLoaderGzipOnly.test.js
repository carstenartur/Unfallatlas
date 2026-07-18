'use strict';

const fs = require('fs');
const path = require('path');

function evaluate(relPath, win) {
  const source = fs.readFileSync(path.resolve(__dirname, relPath), 'utf8');
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
}

function loadModule() {
  const win = { UA: {}, requestIdleCallback: undefined };
  evaluate('../../js/ua.core.js', win);
  evaluate('../../js/ua.data_paths.js', win);
  evaluate('../../js/ua.context_layers.js', win);
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
      tileKeySet: new Set(['0/0']),
    },
    _tileCache: new Map(),
  };
}

const tilePayload = {
  schemaVersion: 3,
  ways: { W1: { highway: 0, road_slope_percent: 2.5 } },
  geometries: { W1: [50.7, 7.1, 50.71, 7.11] },
};

function worldBounds() {
  return {
    getSouth: () => -80,
    getNorth: () => 80,
    getWest: () => -170,
    getEast: () => 170,
  };
}

describe('v3 context tile loading', () => {
  test('viewport loading requests the registry-owned gzip resource', async () => {
    const UA = loadModule();
    UA.fetchJsonGz = jest.fn(async () => tilePayload);
    const state = v3State();

    const merged = await UA.contextLayers.loadTilesForBbox(state, worldBounds());

    expect(UA.fetchJsonGz).toHaveBeenCalledWith(
      'out/ctxtiles/bonn/0/0.json.gz',
      expect.objectContaining({ cache: 'force-cache' })
    );
    expect(merged.ways.W1).toEqual(tilePayload.ways.W1);
    expect(merged.geometries.W1).toEqual(tilePayload.geometries.W1);
  });

  test('popup hydration uses the identical central resource contract', async () => {
    const UA = loadModule();
    UA.fetchJsonGz = jest.fn(async () => tilePayload);
    const state = v3State();

    expect(UA.contextLayers.resolveWayAcrossTiles(state, 'W1')).toBeNull();
    await state._tileCache.get('0/0');

    expect(UA.fetchJsonGz).toHaveBeenCalledWith(
      'out/ctxtiles/bonn/0/0.json.gz',
      expect.objectContaining({ cache: 'force-cache' })
    );
    expect(UA.contextLayers.resolveWayAcrossTiles(state, 'W1'))
      .toEqual({ highway: 'residential', road_slope_percent: 2.5 });
  });

  test('never calls raw fetch when the gzip transport is unavailable', async () => {
    const UA = loadModule();
    const rawFetch = jest.fn();
    global.fetch = rawFetch;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const merged = await UA.contextLayers.loadTilesForBbox(v3State(), worldBounds());
      expect(rawFetch).not.toHaveBeenCalled();
      expect(merged.ways).toEqual({});
      expect(merged.geometries).toEqual({});
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      delete global.fetch;
    }
  });
});