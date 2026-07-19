'use strict';

const fs = require('fs');
const path = require('path');

function makeLayer(name, getCount) {
  return {
    _name: name,
    addTo(map) {
      map._layers.push(this);
      this._map = map;
      return this;
    },
    remove() {
      if (!this._map) return;
      this._map._layers = this._map._layers.filter((l) => l !== this);
    },
    getLayers() {
      return Array.from({ length: getCount() }, (_, i) => ({ id: i }));
    },
  };
}

function makeLeafletStub() {
  return {
    canvas: jest.fn(() => ({ kind: 'shared-context-renderer' })),
    DomUtil: {
      create(tag, className) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        return el;
      },
    },
    DomEvent: {
      disableClickPropagation() {},
      disableScrollPropagation() {},
    },
    control() {
      return {
        onAdd: null,
        addTo(map) {
          this._container = this.onAdd ? this.onAdd(map) : document.createElement('div');
          map._controls.push(this);
          return this;
        },
        remove() {
          this._removed = true;
        },
      };
    },
  };
}

function loadMapModule() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  const p = path.resolve(__dirname, '../../js/ua.map_v2.js');
  const L = makeLeafletStub();
  win.L = L;
  global.L = L;
  (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
  return win.UA;
}

function makeCtx(UA) {
  const map = {
    _layers: [],
    _controls: [],
    _events: {},
    getBounds() {
      return {
        getSouth: () => 50,
        getNorth: () => 51,
        getWest: () => 7,
        getEast: () => 8,
      };
    },
    on(evt, fn) {
      this._events[evt] = fn;
    },
    off(evt, fn) {
      if (!this._events[evt]) return;
      if (!fn || this._events[evt] === fn) delete this._events[evt];
    },
    getZoom() { return 14; },
  };

  UA.contextRoadLayer = {
    buildSlopeLayer(state) {
      const count = Object.keys((state && state.geometries) || {}).length;
      return makeLayer('slope', () => count);
    },
    buildTrafficLayer(state) {
      const count = Object.keys((state && state.geometries) || {}).length;
      return makeLayer('traffic', () => count);
    },
    buildLegend(kind) {
      const el = document.createElement('div');
      el.className = 'context-road-legend context-road-legend--' + kind;
      return el;
    },
  };
  UA.syncAllToUrl = () => {};

  return {
    map,
    contextCapabilities: { hasSlope: true, hasTrafficProxy: false },
    contextLayerState: null,
    contextOverlays: {
      active: { slope: true, traffic: false },
      layers: { slope: null, traffic: null },
      layerControl: null,
      legendControl: null,
    },
  };
}

describe('ua.map_v2 context overlays', () => {
  test('refreshContextOverlays keeps slope pending until state is available, then builds and adds layer', () => {
    const UA = loadMapModule();
    const ctx = makeCtx(UA);

    expect(() => UA.refreshContextOverlays(ctx)).not.toThrow();
    expect(ctx.contextOverlays.layers.slope).toBeNull();
    expect(ctx.contextOverlays.pending.slope).toBe(true);

    ctx.contextLayerState = {
      ways: { W1: { road_slope_class: 'steep' } },
      geometries: { W1: [50.0, 7.0, 50.001, 7.001] },
    };
    UA.refreshContextOverlays(ctx);

    expect(ctx.contextOverlays.layers.slope).toBeTruthy();
    expect(ctx.map._layers).toContain(ctx.contextOverlays.layers.slope);
    expect(ctx.contextOverlays.layers.slope.getLayers().length).toBeGreaterThan(0);
  });

  test('both URL-hydrated layers share one renderer and expose the combined encoding note', () => {
    const UA = loadMapModule();
    const ctx = makeCtx(UA);
    ctx.contextCapabilities.hasTrafficProxy = true;
    ctx.contextOverlays.active.traffic = true;
    ctx.contextLayerState = {
      ways: { W1: { road_slope_class: 'steep', traffic_volume_value: 12000 } },
      geometries: { W1: [50.0, 7.0, 50.001, 7.001] },
    };
    const slope = jest.spyOn(UA.contextRoadLayer, 'buildSlopeLayer');
    const traffic = jest.spyOn(UA.contextRoadLayer, 'buildTrafficLayer');

    UA.refreshContextOverlays(ctx);

    expect(slope).toHaveBeenCalledWith(ctx.contextLayerState, expect.objectContaining({
      renderer: ctx.contextOverlays.renderer,
    }));
    expect(traffic).toHaveBeenCalledWith(ctx.contextLayerState, expect.objectContaining({
      renderer: ctx.contextOverlays.renderer,
    }));
    expect(ctx.contextOverlays.legendControl._container
      .querySelector('.context-road-legend__combined-note').textContent)
      .toMatch(/Steigung außen.*Verkehr.*innen/);
  });

  test('URL-hydrated v3 overlays install the viewport moveend rebuild handler', () => {
    const UA = loadMapModule();
    const ctx = makeCtx(UA);
    ctx.contextLayerState = {
      ways: { W1: { road_slope_class: 'steep' } },
      geometries: { W1: [50.0, 7.0, 50.001, 7.001] },
      tileIndex: { z: 13, tiles: [], tileKeySet: new Set() },
      _tileCache: new Map(),
    };
    UA.contextLayers = { loadTilesForBbox: jest.fn().mockResolvedValue({}) };

    UA.refreshContextOverlays(ctx);

    expect(typeof ctx.map._events.moveend).toBe('function');
  });

  test('setContextOverlayActive rebuilds when already active but layer is missing', async () => {
    const UA = loadMapModule();
    const ctx = makeCtx(UA);
    ctx.contextLayerState = {
      ways: { W1: { road_slope_class: 'steep' } },
      geometries: { W1: [50.0, 7.0, 50.001, 7.001] },
    };

    UA.setContextOverlayActive(ctx, 'slope', true);
    expect(ctx.contextOverlays.layers.slope).toBeNull();
    await Promise.resolve();

    expect(ctx.contextOverlays.layers.slope).toBeTruthy();
    expect(ctx.map._layers).toContain(ctx.contextOverlays.layers.slope);
  });

  test('moveend keeps old active overlay until viewport tiles finished loading', async () => {
    const UA = loadMapModule();
    const ctx = makeCtx(UA);
    const tileKey = '4250/2770';
    ctx.contextLayerState = {
      ways: { W1: { road_slope_class: 'steep' }, W2: { road_slope_class: 'gentle' } },
      geometries: { W1: [50.0, 7.0, 50.001, 7.001] },
      tileIndex: { z: 13, tiles: [{ x: 4250, y: 2770 }], tileKeySet: new Set([tileKey]) },
      _tileCache: new Map([[tileKey, Promise.resolve({})]]),
    };
    ctx.contextOverlays.active.slope = false;
    let loadCall = 0;
    UA.contextLayers = {
      loadTilesForBbox: jest.fn(() => {
        loadCall += 1;
        if (loadCall === 1) {
          return Promise.resolve({ ways: ctx.contextLayerState.ways, geometries: ctx.contextLayerState.geometries });
        }
        return new Promise((resolve) => {
          setTimeout(() => {
            ctx.contextLayerState.geometries.W2 = [50.002, 7.002, 50.003, 7.003];
            resolve({ ways: ctx.contextLayerState.ways, geometries: ctx.contextLayerState.geometries });
          }, 100);
        });
      }),
    };

    UA.setContextOverlayActive(ctx, 'slope', true);
    await new Promise((r) => setTimeout(r, 130));
    const oldLayer = ctx.contextOverlays.layers.slope;
    expect(oldLayer).toBeTruthy();

    expect(typeof ctx.map._events.moveend).toBe('function');
    ctx.map._events.moveend();
    await new Promise((r) => setTimeout(r, 120));
    expect(ctx.contextOverlays.layers.slope).toBe(oldLayer);
    expect(ctx.map._layers).toContain(oldLayer);

    await new Promise((r) => setTimeout(r, 420));
    expect(ctx.contextOverlays.layers.slope).not.toBe(oldLayer);
    expect(ctx.map._layers).not.toContain(oldLayer);
    expect(ctx.contextOverlays.layers.slope.getLayers().length).toBeGreaterThan(1);
  });
});
