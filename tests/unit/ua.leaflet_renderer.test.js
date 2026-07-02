'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

/**
 * Build a minimal Leaflet stub sufficient for LeafletRenderer tests.
 * All geometric methods (circleMarker, polyline, etc.) return a chainable
 * layer stub.
 */
function makeLeafletStub() {
  const layerStub = () => {
    const self = {
      addTo: jest.fn(() => self),
      remove: jest.fn(),
      bindTooltip: jest.fn(() => self),
      bringToFront: jest.fn()
    };
    return self;
  };

  const mapStub = {
    setView:   jest.fn(),
    getCenter: () => ({ lat: 52.37, lng: 9.73 }),
    getZoom:   () => 12,
    eachLayer: jest.fn(),
    on:        jest.fn(),
    remove:    jest.fn(),
    _layers:   []
  };

  return {
    map:          jest.fn(() => mapStub),
    tileLayer:    Object.assign(jest.fn(() => layerStub()), {
      wms: jest.fn(() => layerStub())
    }),
    circleMarker: jest.fn(() => layerStub()),
    polyline:     jest.fn(() => layerStub()),
    polygon:      jest.fn(() => layerStub()),
    rectangle:    jest.fn(() => layerStub()),
    marker:       jest.fn(() => layerStub()),
    divIcon:      jest.fn(() => ({})),
    _mapStub:     mapStub
  };
}

function makeUA(extraWin) {
  const win = Object.assign({ UA: {}, location: { href: 'http://localhost/' } }, extraWin || {});
  loadModule('../../js/ua.map_scene.js',         win);
  loadModule('../../js/ua.traffic_situation.js', win);
  loadModule('../../js/ua.scene_graph.js',       win);
  loadModule('../../js/ua.renderer.js',          win);
  loadModule('../../js/ua.leaflet_renderer.js',  win);
  return win.UA;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UA.LeafletRenderer', () => {

  // -------------------------------------------------------------------------
  describe('create', () => {
    test('throws when Leaflet is not available', () => {
      const UA = makeUA({});
      expect(() => UA.LeafletRenderer.create(
        document.createElement('div'), { L: null }
      )).toThrow('Leaflet');
    });

    test('throws when neither container nor map is provided', () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      expect(() => UA.LeafletRenderer.create(null, { L })).toThrow('container');
    });

    test('returns a renderer that satisfies the renderer interface', () => {
      const UA  = makeUA({});
      const L   = makeLeafletStub();
      const r   = UA.LeafletRenderer.create(document.createElement('div'), { L });
      expect(typeof r.render).toBe('function');
      expect(typeof r.update).toBe('function');
      expect(typeof r.dispose).toBe('function');
      expect(typeof r.captureSnapshot).toBe('function');
    });

    test('name is LeafletRenderer', () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      const r  = UA.LeafletRenderer.create(document.createElement('div'), { L });
      expect(r.name).toBe('LeafletRenderer');
    });

    test('capabilities includes render2d and snapshot', () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      const r  = UA.LeafletRenderer.create(document.createElement('div'), { L });
      expect(r.capabilities.has('render2d')).toBe(true);
      expect(r.capabilities.has('snapshot')).toBe(true);
    });

    test('creates a Leaflet map when a container is provided', () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      UA.LeafletRenderer.create(document.createElement('div'), { L });
      expect(L.map).toHaveBeenCalledTimes(1);
    });

    test('reuses an existing map when map opt is provided', () => {
      const UA      = makeUA({});
      const L       = makeLeafletStub();
      const mapStub = L._mapStub;
      const r       = UA.LeafletRenderer.create(null, { L, map: mapStub });
      expect(L.map).not.toHaveBeenCalled();
      expect(r.map).toBe(mapStub);
    });
  });

  // -------------------------------------------------------------------------
  describe('render', () => {
    let UA, L, renderer, SG;

    beforeEach(() => {
      UA = makeUA({});
      L  = makeLeafletStub();
      renderer = UA.LeafletRenderer.create(document.createElement('div'), { L });
      SG = UA.SceneGraph;
    });

    test('render() resolves for an empty scene graph', async () => {
      const sg = SG.create();
      await expect(renderer.render(sg)).resolves.toBeUndefined();
    });

    test('render() resolves when sceneGraph is null', async () => {
      await expect(renderer.render(null)).resolves.toBeUndefined();
    });

    test('creates a circleMarker for each POINT node', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('point', {
        geometry: { lat: 52.37, lon: 9.73 }
      }));
      await renderer.render(sg);
      expect(L.circleMarker).toHaveBeenCalledTimes(1);
    });

    test('creates a polyline for each POLYLINE node', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('polyline', {
        geometry: { coordinates: [[9.73, 52.37], [9.74, 52.38]] }
      }));
      await renderer.render(sg);
      expect(L.polyline).toHaveBeenCalledTimes(1);
    });

    test('creates a polygon for each POLYGON node', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('polygon', {
        geometry: { coordinates: [[9.73, 52.37], [9.74, 52.38], [9.73, 52.38]] }
      }));
      await renderer.render(sg);
      expect(L.polygon).toHaveBeenCalledTimes(1);
    });

    test('creates a marker with DivIcon for BILLBOARD node', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('billboard', {
        geometry: { lat: 52.37, lon: 9.73 },
        semantic: { kind: 'school', label: 'Grundschule' }
      }));
      await renderer.render(sg);
      expect(L.marker).toHaveBeenCalledTimes(1);
      expect(L.divIcon).toHaveBeenCalledTimes(1);
    });

    test('creates a marker for LABEL node', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('label', {
        geometry: { lat: 52.37, lon: 9.73 },
        semantic: { kind: 'recommendation', label: 'Tempo 30' }
      }));
      await renderer.render(sg);
      expect(L.marker).toHaveBeenCalledTimes(1);
    });

    test('skips POINT nodes without geometry coordinates', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('point', { geometry: {} }));
      await renderer.render(sg);
      expect(L.circleMarker).not.toHaveBeenCalled();
    });

    test('skips HEAT_FIELD and CLUSTER nodes (managed by existing pipeline)', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('heatField'));
      sg = SG.addNode(sg, SG.createNode('cluster'));
      await renderer.render(sg);
      expect(L.circleMarker).not.toHaveBeenCalled();
      expect(L.polyline).not.toHaveBeenCalled();
    });

    test('renders children of CLUSTER node', async () => {
      const child = SG.createNode('point', {
        geometry: { lat: 52.37, lon: 9.73 }
      });
      const cluster = SG.createNode('cluster', {
        children: [child]
      });
      let sg = SG.create();
      sg = SG.addNode(sg, cluster);
      await renderer.render(sg);
      expect(L.circleMarker).toHaveBeenCalledTimes(1);
    });

    test('subsequent render() calls clear previous layers', async () => {
      let sg = SG.create();
      sg = SG.addNode(sg, SG.createNode('point', { geometry: { lat: 52.37, lon: 9.73 } }));
      await renderer.render(sg);
      await renderer.render(sg);
      // Each render call creates one circleMarker
      expect(L.circleMarker).toHaveBeenCalledTimes(2);
    });

    test('creates an XYZ tileLayer for a RASTER node with technicalType XYZ', async () => {
      // Use an external map to avoid the constructor's OSM tile layer call
      const UAr = makeUA({});
      const Lr  = makeLeafletStub();
      const r   = UAr.LeafletRenderer.create(null, { L: Lr, map: Lr._mapStub });
      let sg = UAr.SceneGraph.create();
      sg = UAr.SceneGraph.addNode(sg, UAr.SceneGraph.createNode('raster', {
        geometry: {
          url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          technicalType: 'XYZ'
        },
        semantic: { kind: 'baseLayer', attribution: '&copy; OpenStreetMap-Mitwirkende' }
      }));
      await r.render(sg);
      expect(Lr.tileLayer).toHaveBeenCalledTimes(1);
      expect(Lr.tileLayer.wms).not.toHaveBeenCalled();
    });

    test('creates a WMS tileLayer for a RASTER node with technicalType WMS', async () => {
      const UAr = makeUA({});
      const Lr  = makeLeafletStub();
      const r   = UAr.LeafletRenderer.create(null, { L: Lr, map: Lr._mapStub });
      let sg = UAr.SceneGraph.create();
      sg = UAr.SceneGraph.addNode(sg, UAr.SceneGraph.createNode('raster', {
        geometry: {
          url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop',
          technicalType: 'WMS',
          layers: 'nw_dop',
          format: 'image/png',
          transparent: false
        },
        semantic: { kind: 'baseLayer', attribution: 'Quelle: Geobasis NRW' }
      }));
      await r.render(sg);
      expect(Lr.tileLayer.wms).toHaveBeenCalledTimes(1);
      expect(Lr.tileLayer).not.toHaveBeenCalled();
    });

    test('skips RASTER node without url', async () => {
      const UAr = makeUA({});
      const Lr  = makeLeafletStub();
      const r   = UAr.LeafletRenderer.create(null, { L: Lr, map: Lr._mapStub });
      let sg = UAr.SceneGraph.create();
      sg = UAr.SceneGraph.addNode(sg, UAr.SceneGraph.createNode('raster', { geometry: {} }));
      await r.render(sg);
      expect(Lr.tileLayer).not.toHaveBeenCalled();
      expect(Lr.tileLayer.wms).not.toHaveBeenCalled();
    });

    test('removes default base layer when rendering a RASTER node on owned map', async () => {
      const UAr = makeUA({});
      const Lr  = makeLeafletStub();
      const r   = UAr.LeafletRenderer.create(document.createElement('div'), { L: Lr });
      const defaultBaseLayer = Lr.tileLayer.mock.results[0].value;
      let sg = UAr.SceneGraph.create();
      sg = UAr.SceneGraph.addNode(sg, UAr.SceneGraph.createNode('raster', {
        geometry: {
          url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          technicalType: 'XYZ'
        }
      }));

      await r.render(sg);

      expect(defaultBaseLayer.remove).toHaveBeenCalledTimes(1);
      expect(Lr.tileLayer).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('update', () => {
    test('update() calls render() under the hood', async () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      const r  = UA.LeafletRenderer.create(document.createElement('div'), { L });
      const sg = UA.SceneGraph.create();
      // update is an alias for render — no error expected
      await expect(r.update(sg)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('dispose', () => {
    test('dispose() removes managed layers', async () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      const r  = UA.LeafletRenderer.create(document.createElement('div'), { L });
      let sg = UA.SceneGraph.create();
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point', {
        geometry: { lat: 52.37, lon: 9.73 }
      }));
      await r.render(sg);
      r.dispose();
      // After dispose the map should have been removed (owned map)
      expect(L._mapStub.remove).toHaveBeenCalled();
    });

    test('dispose() with external map does not remove the map', () => {
      const UA      = makeUA({});
      const L       = makeLeafletStub();
      const mapStub = L._mapStub;
      const r       = UA.LeafletRenderer.create(null, { L, map: mapStub });
      r.dispose();
      expect(mapStub.remove).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  describe('captureSnapshot', () => {
    test('returns a Promise resolving to a data URL string', async () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      const r  = UA.LeafletRenderer.create(document.createElement('div'), { L });
      const url = await r.captureSnapshot();
      expect(typeof url).toBe('string');
      expect(url).toMatch(/^data:/);
    });

    test('delegates to UA.captureMapImage when available', async () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      const r  = UA.LeafletRenderer.create(document.createElement('div'), { L });
      const fakeFn = jest.fn(() => Promise.resolve('data:image/png;base64,ABC'));
      UA.captureMapImage = fakeFn;
      const url = await r.captureSnapshot();
      expect(fakeFn).toHaveBeenCalled();
      expect(url).toBe('data:image/png;base64,ABC');
    });
  });

  // -------------------------------------------------------------------------
  describe('integration: fromTrafficSituation → render', () => {
    test('renders accident points from a TrafficSituation', async () => {
      const UA = makeUA({});
      const L  = makeLeafletStub();
      const r  = UA.LeafletRenderer.create(document.createElement('div'), { L });

      const ts = UA.TrafficSituation.create({ metadata: { city: 'Hannover' } });
      const accidentData = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', geometry: { type: 'Point', coordinates: [9.73, 52.37] }, properties: { UKATEGORIE: 1 } },
          { type: 'Feature', geometry: { type: 'Point', coordinates: [9.74, 52.38] }, properties: { UKATEGORIE: 3 } }
        ]
      };
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'accident', version: 1, enabled: true, data: accidentData, meta: {}
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts2);
      await r.render(sg);

      // Two accident points should have produced two circleMarkers
      expect(L.circleMarker).toHaveBeenCalledTimes(2);
    });
  });
});
