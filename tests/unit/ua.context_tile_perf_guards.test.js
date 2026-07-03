'use strict';

/**
 * @jest-environment jsdom
 */

describe('context tile performance guards', () => {
  let UA;
  let originalFetch;

  function loadModule(relPath) {
    const fs = require('fs');
    const path = require('path');
    const code = fs.readFileSync(path.resolve(__dirname, relPath), 'utf8');
    // eslint-disable-next-line no-new-func
    (new Function('window', 'document', code))(window, document);
  }

  beforeEach(() => {
    originalFetch = global.fetch;
    delete window.UA;
    delete window.L;
    window.UA = {
      normKey: (s) => String(s || '').toLowerCase(),
    };
    loadModule('../../js/ua.context_layers.js');
    UA = window.UA;
    // The production guard patches UA.renderLayers after ua.map_v2.js defines
    // it. Tests define a stub up front so the patch is immediate and no retry
    // timers remain pending in jsdom.
    UA.renderLayers = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete window.L;
  });

  function makeBounds() {
    return {
      getSouth: () => 52.30,
      getNorth: () => 52.34,
      getWest:  () => 9.70,
      getEast:  () => 9.76,
    };
  }

  test('loadTilesForBbox reuses manifest indexes and fetches only known tiles', async () => {
    loadModule('../../js/ua.preview_map_renderer.js');
    const guard = UA.contextLayers._contextTilePerformanceGuards;
    expect(guard).toBeDefined();

    const z = 13;
    const want = guard.tilesForBounds(makeBounds(), z);
    expect(want.length).toBeGreaterThan(0);
    const [x, y] = want[0];
    const state = {
      ways: {},
      geometries: {},
      tileIndexUrl: 'out/ctxtiles/hannover/index.json',
      tileIndex: {
        z,
        tiles: [{ x, y }],
      },
      _tileCache: new Map(),
    };

    let fetchCalls = 0;
    global.fetch = jest.fn(async () => {
      fetchCalls += 1;
      return {
        ok: true,
        async json() {
          return {
            ways: { way1: { highway: 'residential' } },
            geometries: { way1: [52.31, 9.71, 52.32, 9.72] },
          };
        },
      };
    });

    await UA.contextLayers.loadTilesForBbox(state, makeBounds());
    expect(fetchCalls).toBe(1);
    expect(state.ways.way1.highway).toBe('residential');
    expect(state.tileIndex.tileKeySet).toBeInstanceOf(Set);
    expect(state.tileIndex.tileUrlByKey).toBeInstanceOf(Map);

    await UA.contextLayers.loadTilesForBbox(state, makeBounds());
    expect(fetchCalls).toBe(1); // second call reuses _tileCache
  });

  test('resolveWayAcrossTiles does not start tile fetches during renderLayers', () => {
    loadModule('../../js/ua.preview_map_renderer.js');
    const state = {
      ways: {},
      geometries: {},
      tileIndexUrl: 'out/ctxtiles/hannover/index.json',
      tileIndex: {
        z: 13,
        tiles: [{ x: 4300, y: 2680 }],
        wayIndex: { way1: [4300, 2680] },
      },
      _tileCache: new Map(),
    };
    global.fetch = jest.fn(async () => ({ ok: true, async json() { return { ways: {}, geometries: {} }; } }));

    UA._suppressContextTileFetchDuringRender = true;
    const resolved = UA.contextLayers.resolveWayAcrossTiles(state, 'way1');
    UA._suppressContextTileFetchDuringRender = false;

    expect(resolved).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('renderLayers is wrapped so popup prebinding cannot trigger context tile fetches', () => {
    let sawSuppression = false;
    UA.renderLayers = jest.fn(() => {
      sawSuppression = !!UA._suppressContextTileFetchDuringRender;
    });

    loadModule('../../js/ua.preview_map_renderer.js');

    expect(UA.renderLayers._contextTilePerfGuarded).toBe(true);
    UA.renderLayers({});
    expect(sawSuppression).toBe(true);
    expect(UA._suppressContextTileFetchDuringRender).toBe(false);
  });

  test('map layer registry keeps layers visible above native zoom', () => {
    const tileLayer = jest.fn((url, options) => ({ url, options }));
    tileLayer.wms = jest.fn((url, options) => ({ url, options, wms: true }));
    window.L = { tileLayer };

    loadModule('../../js/ua.map_layer_registry.js');

    const osm = UA.createMapLayer(UA.getMapLayerDefinition('standard-osm'));
    expect(osm.options.maxNativeZoom).toBe(19);
    expect(osm.options.maxZoom).toBeGreaterThanOrEqual(22);

    const dop = UA.createMapLayer(UA.getMapLayerDefinition('niedersachsen-orthophoto'));
    expect(dop.options.maxNativeZoom).toBe(20);
    expect(dop.options.maxZoom).toBeGreaterThanOrEqual(22);
  });

  test('direct map mode control is installed by initLeaflet wrapper and updates map mode', () => {
    window.L = {
      control: () => ({
        addTo(map) {
          this._container = this.onAdd(map);
          map._controls.push(this);
          return this;
        }
      }),
      DomUtil: {
        create(tag, className) {
          const el = document.createElement(tag);
          el.className = className;
          return el;
        }
      },
      DomEvent: {
        disableClickPropagation: jest.fn(),
        disableScrollPropagation: jest.fn(),
      }
    };
    UA.resolveMapMode = (raw) => ['standard', 'orthophoto', 'hybrid', 'analysis'].includes(raw) ? raw : 'standard';
    UA.applyMapMode = jest.fn();
    UA.syncMapModeButtons = jest.fn();
    UA.renderMapLayerStatus = jest.fn();
    UA.syncAllToUrl = jest.fn();

    loadModule('../../js/ua.preview_map_renderer.js');

    UA.initLeaflet = function initLeafletStub(ctx) {
      ctx.map = { _controls: [] };
    };
    const ctx = { mapMode: 'standard' };
    UA.initLeaflet(ctx);

    expect(ctx.directMapModeControl).toBeDefined();
    const btn = ctx.directMapModeControl._uaContainer.querySelector('button[data-map-mode="orthophoto"]');
    expect(btn).toBeTruthy();
    btn.click();

    expect(ctx.mapMode).toBe('orthophoto');
    expect(UA.applyMapMode).toHaveBeenCalledWith(ctx);
    expect(UA.syncAllToUrl).toHaveBeenCalledWith(ctx);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });
});
