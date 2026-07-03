'use strict';

const fs = require('fs');
const path = require('path');

function loadModules(extraWin) {
  const win = Object.assign(
    { UA: {}, location: { href: 'http://localhost/' } },
    extraWin || {}
  );
  const load = (file) => {
    (function (window) {
      eval(fs.readFileSync(path.resolve(__dirname, '../../js/' + file), 'utf8'));
    })(win);
  };
  load('ua.map_scene.js');
  load('ua.traffic_situation.js');
  load('ua.leaflet_map_adapter.js');
  load('ua.preview_map_renderer.js');
  return win;
}

describe('UA.PreviewMapRenderer', () => {
  test('render() throws when container is missing', async () => {
    const { UA } = loadModules({ L: {} });
    await expect(UA.PreviewMapRenderer.render({ scene: UA.MapScene.create() }))
      .rejects.toThrow('container');
  });

  test('render() throws when scene is missing', async () => {
    const { UA } = loadModules({ L: {} });
    await expect(UA.PreviewMapRenderer.render({ container: document.createElement('div') }))
      .rejects.toThrow('scene');
  });

  test('render() throws when Leaflet is not available', async () => {
    // No `L` on window
    const { UA } = loadModules({});
    await expect(UA.PreviewMapRenderer.render({
      container: document.createElement('div'),
      scene:     UA.MapScene.create()
    })).rejects.toThrow('Leaflet');
  });

  test('render() creates a Leaflet map and applies point data', async () => {
    const mapStub = {
      _layers: [],
      addLayer: jest.fn(),
      setView: jest.fn(),
      getCenter: () => ({ lat: 52.37, lng: 9.73 }),
      getZoom: () => 12,
      getBounds: () => ({
        getSouth: () => 52, getNorth: () => 53,
        getWest: () => 9,  getEast: () => 10
      }),
      eachLayer: jest.fn(),
      on: jest.fn(),
      invalidateSize: jest.fn(),
      remove: jest.fn()
    };
    const layerStub = { addTo: jest.fn(), remove: jest.fn() };

    const { UA, L } = loadModules({
      L: {
        map: jest.fn(() => mapStub),
        tileLayer: jest.fn(() => layerStub),
        markerClusterGroup: jest.fn(() => Object.assign({}, layerStub, {
          addLayers: jest.fn(), addTo: jest.fn(() => layerStub), on: jest.fn()
        })),
        heatLayer: jest.fn(() => Object.assign({}, layerStub)),
        circleMarker: jest.fn(() => Object.assign({}, layerStub, {
          bindPopup: jest.fn(() => layerStub)
        })),
        layerGroup: jest.fn(() => Object.assign({}, layerStub, {
          addLayer: jest.fn(), getLayers: jest.fn(() => [])
        })),
        LatLngBounds: jest.fn(() => ({
          getSouth: () => 0, getWest: () => 0, getNorth: () => 1, getEast: () => 1
        }))
      }
    });

    // Provide minimal rendering stubs
    UA.applyFilters        = jest.fn();
    UA.applyViewportFilter = jest.fn();
    UA.renderLayers        = jest.fn();

    const scene = UA.MapScene.create({
      city: 'Bonn',
      center: { lat: 50.73, lon: 7.1 },
      zoom: 13
    });

    const pts = [
      { lat: 50.73, lon: 7.1, props: { ukategorie: '1' } }
    ];

    const { ctx: previewCtx, map: previewMap } = await UA.PreviewMapRenderer.render({
      container: document.createElement('div'),
      scene,
      pts
    });

    expect(UA.applyFilters).toHaveBeenCalledWith(previewCtx);
    expect(UA.applyViewportFilter).toHaveBeenCalledWith(previewCtx);
    expect(UA.renderLayers).toHaveBeenCalledWith(previewCtx);
    expect(previewCtx.CITY_RAW).toBe('Bonn');
    expect(previewCtx.allPts).toBe(pts);
    expect(previewMap).toBe(mapStub);
  });

  test('render() calls onReady callback after map is stable', async () => {
    const mapStub = {
      setView: jest.fn(),
      getCenter: () => ({ lat: 52.37, lng: 9.73 }),
      getZoom: () => 12,
      getBounds: () => ({
        getSouth: () => 52, getNorth: () => 53,
        getWest: () => 9,  getEast: () => 10
      }),
      eachLayer: jest.fn(),
      on: jest.fn(),
      remove: jest.fn()
    };
    const layerStub = { addTo: jest.fn(() => layerStub), remove: jest.fn() };

    const { UA } = loadModules({
      L: {
        map: jest.fn(() => mapStub),
        tileLayer: jest.fn(() => layerStub)
      }
    });
    UA.applyFilters        = jest.fn();
    UA.applyViewportFilter = jest.fn();
    UA.renderLayers        = jest.fn();

    const onReady = jest.fn();
    await UA.PreviewMapRenderer.render({
      container: document.createElement('div'),
      scene:     UA.MapScene.create({ center: { lat: 52.37, lon: 9.73 }, zoom: 12 }),
      onReady
    });

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  test('render() applies layer visibility from scene', async () => {
    const mapStub = {
      setView: jest.fn(),
      getCenter: () => ({ lat: 52.37, lng: 9.73 }),
      getZoom: () => 12,
      eachLayer: jest.fn(),
      on: jest.fn(),
      remove: jest.fn()
    };
    const layerStub = { addTo: jest.fn(() => layerStub), remove: jest.fn() };

    const { UA } = loadModules({
      L: { map: jest.fn(() => mapStub), tileLayer: jest.fn(() => layerStub) }
    });
    UA.applyFilters        = jest.fn();
    UA.applyViewportFilter = jest.fn();
    UA.renderLayers        = jest.fn();

    const scene = UA.MapScene.create({
      layers: { showCluster: false, showHeatmap: false, showOnlyAboveAverage: true }
    });

    const { ctx } = await UA.PreviewMapRenderer.render({
      container: document.createElement('div'),
      scene
    });

    expect(ctx.showCluster).toBe(false);
    expect(ctx.showHeatmap).toBe(false);
    expect(ctx.showOnlyAboveAverage).toBe(true);
  });

  test('installDirectMapModeControl adds on-map buttons that switch map mode', () => {
    const { UA } = loadModules({
      L: {
        control: () => ({
          addTo(map) {
            this._container = this.onAdd(map);
            if (Array.isArray(map._controls)) map._controls.push(this);
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
          disableScrollPropagation: jest.fn()
        }
      }
    });

    const origApplyMapMode = jest.fn();
    UA.applyMapMode = origApplyMapMode;
    UA.syncMapModeButtons = jest.fn();
    UA.renderMapLayerStatus = jest.fn();
    UA.syncAllToUrl = jest.fn();

    const ctx = { map: { _controls: [] }, mapMode: 'standard' };
    UA.installDirectMapModeControl(ctx);

    expect(ctx.directMapModeControl).toBeDefined();
    const btn = ctx.directMapModeControl._uaContainer.querySelector('button[data-map-mode="orthophoto"]');
    expect(btn).toBeTruthy();
    btn.click();

    expect(ctx.mapMode).toBe('orthophoto');
    expect(origApplyMapMode).toHaveBeenCalledWith(ctx);
    expect(UA.syncAllToUrl).toHaveBeenCalledWith(ctx);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  test('render() accepts a TrafficSituation as read-only input', async () => {
    const mapStub = {
      setView: jest.fn(),
      getCenter: () => ({ lat: 52.37, lng: 9.73 }),
      getZoom: () => 12,
      eachLayer: jest.fn(),
      on: jest.fn(),
      remove: jest.fn()
    };
    const layerStub = { addTo: jest.fn(() => layerStub), remove: jest.fn() };

    const { UA } = loadModules({
      L: { map: jest.fn(() => mapStub), tileLayer: jest.fn(() => layerStub) }
    });
    UA.applyFilters        = jest.fn();
    UA.applyViewportFilter = jest.fn();
    UA.renderLayers        = jest.fn();

    const ts = UA.TrafficSituation.create({
      metadata: { city: 'Bonn' },
      core: {
        viewport: { center: { lat: 50.73, lon: 7.10 }, zoom: 13 },
        layerVisibility: { showCluster: false }
      }
    });

    const { ctx } = await UA.PreviewMapRenderer.render({
      container: document.createElement('div'),
      trafficSituation: ts
    });

    expect(ctx.CITY_RAW).toBe('Bonn');
    expect(ctx.showCluster).toBe(false);
  });
});
