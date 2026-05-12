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
    getBounds() {
      return {
        getSouth: () => 50,
        getNorth: () => 51,
        getWest: () => 7,
        getEast: () => 8,
      };
    },
    on() {},
    off() {},
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
});
