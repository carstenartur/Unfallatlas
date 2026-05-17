'use strict';

const fs = require('fs');
const path = require('path');

class FakeTileLayer {
  constructor() {
    this._handlers = { loading: [], load: [] };
    this._loading = true;
  }
  isLoading() { return this._loading; }
  on(evt, fn) {
    if (!this._handlers[evt]) this._handlers[evt] = [];
    this._handlers[evt].push(fn);
  }
  off(evt, fn) {
    if (!this._handlers[evt]) return;
    this._handlers[evt] = this._handlers[evt].filter((h) => h !== fn);
  }
  emit(evt) {
    for (const fn of this._handlers[evt] || []) fn();
  }
}

function loadMapModule() {
  const win = {
    UA: {},
    L: { TileLayer: FakeTileLayer },
    location: { href: 'http://localhost/' },
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
  };
  const p = path.resolve(__dirname, '../../js/ua.map_v2.js');
  (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
  return win;
}

describe('UA.waitForMapFullyRendered', () => {
  test('waits for tile layer load and context tile hydration before resolving', async () => {
    const win = loadMapModule();
    const UA = win.UA;
    const tileLayer = new FakeTileLayer();
    const map = {
      eachLayer(fn) { fn(tileLayer); },
      getBounds() {
        return {
          getSouth: () => 50,
          getNorth: () => 51,
          getWest: () => 7,
          getEast: () => 8,
        };
      },
    };
    const state = {
      tileIndex: { z: 13, tiles: [{ x: 4255, y: 2773 }], tileKeySet: new Set(['4255/2773']) },
      _tileCache: new Map(),
      ways: {},
      geometries: {},
    };
    const ctx = {
      map,
      contextLayerState: state,
      contextOverlays: { active: { slope: true, traffic: false } },
    };
    let hydrated = false;
    UA.contextLayers = {
      loadTilesForBbox: jest.fn(() => new Promise((resolve) => {
        setTimeout(() => {
          hydrated = true;
          state._tileCache.set('4255/2773', Promise.resolve({}));
          resolve({ ways: {}, geometries: {} });
        }, 10);
      })),
    };

    const p = UA.waitForMapFullyRendered(map, { ctx, timeoutMs: 1000 });
    setTimeout(() => {
      tileLayer._loading = false;
      tileLayer.emit('load');
    }, 10);
    await expect(p).resolves.toBe(true);
    expect(UA.contextLayers.loadTilesForBbox).toHaveBeenCalledTimes(1);
    expect(hydrated).toBe(true);
  });

  test('returns false when tile loading does not settle before timeout', async () => {
    const win = loadMapModule();
    const UA = win.UA;
    const tileLayer = new FakeTileLayer();
    const map = {
      eachLayer(fn) { fn(tileLayer); },
      getBounds() { return null; },
    };
    await expect(UA.waitForMapFullyRendered(map, { timeoutMs: 20, tileTimeoutMs: 20 })).resolves.toBe(false);
  });
});
