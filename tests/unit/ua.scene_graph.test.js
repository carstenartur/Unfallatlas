'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Helpers to load modules into an isolated window-like object
// ---------------------------------------------------------------------------

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  loadModule('../../js/ua.map_scene.js',         win);
  loadModule('../../js/ua.traffic_situation.js', win);
  loadModule('../../js/ua.scene_graph.js',       win);
  return win.UA;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UA.SceneGraph', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  // -------------------------------------------------------------------------
  describe('NODE_TYPES', () => {
    test('exposes all expected node type constants', () => {
      const NT = UA.SceneGraph.NODE_TYPES;
      expect(NT.POINT).toBe('point');
      expect(NT.POLYLINE).toBe('polyline');
      expect(NT.POLYGON).toBe('polygon');
      expect(NT.MESH).toBe('mesh');
      expect(NT.BILLBOARD).toBe('billboard');
      expect(NT.LABEL).toBe('label');
      expect(NT.HEAT_FIELD).toBe('heatField');
      expect(NT.CLUSTER).toBe('cluster');
      expect(NT.ARROW).toBe('arrow');
      expect(NT.HIGHLIGHT).toBe('highlight');
      expect(NT.CAMERA).toBe('camera');
      expect(NT.LIGHT).toBe('light');
      expect(NT.RASTER).toBe('raster');
    });

    test('NODE_TYPES object is frozen', () => {
      expect(Object.isFrozen(UA.SceneGraph.NODE_TYPES)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('LOD_LEVELS', () => {
    test('exposes all expected LOD level constants', () => {
      const LL = UA.SceneGraph.LOD_LEVELS;
      expect(LL.DISTANT).toBe('distant');
      expect(LL.CITY).toBe('city');
      expect(LL.STREET).toBe('street');
      expect(LL.INTERSECTION).toBe('intersection');
      expect(LL.PEDESTRIAN).toBe('pedestrian');
    });

    test('LOD_LEVELS object is frozen', () => {
      expect(Object.isFrozen(UA.SceneGraph.LOD_LEVELS)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('INTERACTION_EVENTS', () => {
    test('exposes all expected interaction event constants', () => {
      const IE = UA.SceneGraph.INTERACTION_EVENTS;
      expect(IE.SELECTION).toBe('selection');
      expect(IE.HOVER).toBe('hover');
      expect(IE.FOCUS).toBe('focus');
      expect(IE.VOICE).toBe('voice');
      expect(IE.GESTURE).toBe('gesture');
      expect(IE.EYE_TRACKING).toBe('eyeTracking');
    });

    test('INTERACTION_EVENTS object is frozen', () => {
      expect(Object.isFrozen(UA.SceneGraph.INTERACTION_EVENTS)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('create', () => {
    test('returns a default SceneGraph with expected shape', () => {
      const sg = UA.SceneGraph.create();
      expect(sg.version).toBe(1);
      expect(sg.id).toBeNull();
      expect(sg.lod).toBe(UA.SceneGraph.LOD_LEVELS.CITY);
      expect(sg.nodes).toEqual([]);
      expect(sg.metadata).toBeDefined();
      expect(sg.metadata.title).toBe('');
    });

    test('metadata includes mapMode defaulting to standard', () => {
      const sg = UA.SceneGraph.create();
      expect(sg.metadata.mapMode).toBe('standard');
    });

    test('metadata includes sourceAttribution defaulting to empty string', () => {
      const sg = UA.SceneGraph.create();
      expect(sg.metadata.sourceAttribution).toBe('');
    });

    test('accepts overrides', () => {
      const sg = UA.SceneGraph.create({ id: 'test-1', lod: 'pedestrian' });
      expect(sg.id).toBe('test-1');
      expect(sg.lod).toBe('pedestrian');
    });

    test('merges metadata overrides including mapMode and sourceAttribution', () => {
      const sg = UA.SceneGraph.create({
        metadata: {
          title: 'Test Graph',
          mapMode: 'orthophoto',
          sourceAttribution: '&copy; Geobasis NRW'
        }
      });
      expect(sg.metadata.title).toBe('Test Graph');
      expect(sg.metadata.mapMode).toBe('orthophoto');
      expect(sg.metadata.sourceAttribution).toBe('&copy; Geobasis NRW');
    });

    test('merges metadata overrides', () => {
      const sg = UA.SceneGraph.create({ metadata: { title: 'Test Graph' } });
      expect(sg.metadata.title).toBe('Test Graph');
    });

    test('copies nodes array from overrides', () => {
      const n = UA.SceneGraph.createNode('point');
      const sg = UA.SceneGraph.create({ nodes: [n] });
      expect(sg.nodes).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  describe('createNode', () => {
    test('throws when type is missing', () => {
      expect(() => UA.SceneGraph.createNode()).toThrow('type');
    });

    test('creates a node with required fields', () => {
      const node = UA.SceneGraph.createNode('point');
      expect(node.type).toBe('point');
      expect(node.id).toBeDefined();
      expect(node.geometry).toBeDefined();
      expect(node.style).toBeDefined();
      expect(node.semantic).toBeDefined();
      expect(node.interaction).toBeDefined();
      expect(node.lod).toBeDefined();
      expect(node.children).toEqual([]);
    });

    test('applies default style for point type', () => {
      const node = UA.SceneGraph.createNode('point');
      expect(node.style.color).toBe('#e74c3c');
      expect(node.style.radius).toBe(6);
    });

    test('applies default style for polyline type', () => {
      const node = UA.SceneGraph.createNode('polyline');
      expect(node.style.color).toBe('#3498db');
      expect(node.style.weight).toBe(2);
    });

    test('applies default style for raster type', () => {
      const node = UA.SceneGraph.createNode('raster');
      expect(node.style.opacity).toBe(1.0);
      expect(node.style.maxZoom).toBe(19);
    });

    test('accepts raster geometry with url and technicalType', () => {
      const node = UA.SceneGraph.createNode('raster', {
        geometry: {
          url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          technicalType: 'XYZ'
        }
      });
      expect(node.geometry.url).toBe('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
      expect(node.geometry.technicalType).toBe('XYZ');
    });

    test('merges style overrides with defaults', () => {
      const node = UA.SceneGraph.createNode('point', { style: { color: '#000', radius: 10 } });
      expect(node.style.color).toBe('#000');
      expect(node.style.radius).toBe(10);
      expect(node.style.opacity).toBe(0.8);  // default preserved
    });

    test('accepts geometry', () => {
      const node = UA.SceneGraph.createNode('point', { geometry: { lat: 52.37, lon: 9.73 } });
      expect(node.geometry.lat).toBe(52.37);
      expect(node.geometry.lon).toBe(9.73);
    });

    test('accepts semantic overrides', () => {
      const node = UA.SceneGraph.createNode('point', {
        semantic: { kind: 'accident', label: 'KFZ/FG' }
      });
      expect(node.semantic.kind).toBe('accident');
      expect(node.semantic.label).toBe('KFZ/FG');
    });

    test('accepts interaction overrides', () => {
      const node = UA.SceneGraph.createNode('point', {
        interaction: { selectable: true, hoverable: true, data: { id: 42 } }
      });
      expect(node.interaction.selectable).toBe(true);
      expect(node.interaction.hoverable).toBe(true);
      expect(node.interaction.data.id).toBe(42);
    });

    test('accepts lod overrides', () => {
      const node = UA.SceneGraph.createNode('point', {
        lod: { minLevel: 'street', maxLevel: 'pedestrian' }
      });
      expect(node.lod.minLevel).toBe('street');
      expect(node.lod.maxLevel).toBe('pedestrian');
    });

    test('each call generates a unique id', () => {
      const n1 = UA.SceneGraph.createNode('point');
      const n2 = UA.SceneGraph.createNode('point');
      expect(n1.id).not.toBe(n2.id);
    });

    test('accepts explicit id', () => {
      const node = UA.SceneGraph.createNode('point', { id: 'my-node' });
      expect(node.id).toBe('my-node');
    });
  });

  // -------------------------------------------------------------------------
  describe('addNode', () => {
    test('throws when graph is missing', () => {
      const node = UA.SceneGraph.createNode('point');
      expect(() => UA.SceneGraph.addNode(null, node)).toThrow('graph');
    });

    test('throws when node.type is missing', () => {
      const sg = UA.SceneGraph.create();
      expect(() => UA.SceneGraph.addNode(sg, {})).toThrow('node.type');
    });

    test('returns a new graph with the node appended', () => {
      const sg   = UA.SceneGraph.create();
      const node = UA.SceneGraph.createNode('point', { id: 'p1' });
      const sg2  = UA.SceneGraph.addNode(sg, node);
      expect(sg2.nodes).toHaveLength(1);
      expect(sg2.nodes[0].id).toBe('p1');
    });

    test('does not mutate the original graph', () => {
      const sg   = UA.SceneGraph.create();
      const node = UA.SceneGraph.createNode('point');
      UA.SceneGraph.addNode(sg, node);
      expect(sg.nodes).toHaveLength(0);
    });

    test('the added node is a deep clone', () => {
      const sg   = UA.SceneGraph.create();
      const node = UA.SceneGraph.createNode('point', { id: 'p1' });
      const sg2  = UA.SceneGraph.addNode(sg, node);
      // Mutate original node — should NOT affect the graph
      node.id = 'mutated';
      expect(sg2.nodes[0].id).toBe('p1');
    });

    test('accumulates multiple nodes', () => {
      let sg = UA.SceneGraph.create();
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point'));
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('polyline'));
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('polygon'));
      expect(sg.nodes).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  describe('removeNode', () => {
    test('returns the same graph when nodeId is not found', () => {
      const sg   = UA.SceneGraph.create();
      const sg2  = UA.SceneGraph.removeNode(sg, 'nonexistent');
      expect(sg2.nodes).toHaveLength(0);
    });

    test('removes a root-level node by id', () => {
      let sg = UA.SceneGraph.create();
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point', { id: 'p1' }));
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point', { id: 'p2' }));
      sg = UA.SceneGraph.removeNode(sg, 'p1');
      expect(sg.nodes).toHaveLength(1);
      expect(sg.nodes[0].id).toBe('p2');
    });

    test('does not mutate the original graph', () => {
      let sg = UA.SceneGraph.create();
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point', { id: 'p1' }));
      UA.SceneGraph.removeNode(sg, 'p1');
      expect(sg.nodes).toHaveLength(1);
    });

    test('is a no-op when graph is null', () => {
      expect(UA.SceneGraph.removeNode(null, 'p1')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('getNode', () => {
    test('returns null when graph is null', () => {
      expect(UA.SceneGraph.getNode(null, 'p1')).toBeNull();
    });

    test('returns null when nodeId is not found', () => {
      const sg = UA.SceneGraph.create();
      expect(UA.SceneGraph.getNode(sg, 'missing')).toBeNull();
    });

    test('finds a root-level node by id', () => {
      let sg = UA.SceneGraph.create();
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point', { id: 'p1' }));
      const found = UA.SceneGraph.getNode(sg, 'p1');
      expect(found).not.toBeNull();
      expect(found.id).toBe('p1');
    });

    test('finds a node nested in children', () => {
      const child  = UA.SceneGraph.createNode('point', { id: 'child-1' });
      const parent = UA.SceneGraph.createNode('cluster', { id: 'cluster-1', children: [child] });
      let sg = UA.SceneGraph.create();
      sg = UA.SceneGraph.addNode(sg, parent);
      const found = UA.SceneGraph.getNode(sg, 'child-1');
      expect(found).not.toBeNull();
      expect(found.id).toBe('child-1');
    });
  });

  // -------------------------------------------------------------------------
  describe('fromTrafficSituation', () => {
    test('returns an empty SceneGraph when ts is null', () => {
      const sg = UA.SceneGraph.fromTrafficSituation(null);
      expect(sg).toBeDefined();
      expect(sg.nodes).toEqual([]);
    });

    test('returns an empty SceneGraph for a default TrafficSituation', () => {
      const ts = UA.TrafficSituation.create();
      const sg = UA.SceneGraph.fromTrafficSituation(ts);
      expect(sg).toBeDefined();
      // With no accident data there should be no accident POINT nodes,
      // but HEAT_FIELD and CLUSTER nodes are added by default because
      // layerVisibility.showHeatmap and showCluster default to true.
      const types = sg.nodes.map(n => n.type);
      expect(types).toContain('heatField');
      expect(types).toContain('cluster');
    });

    test('includes city in graph metadata', () => {
      const ts = UA.TrafficSituation.create({ metadata: { city: 'Hannover' } });
      const sg = UA.SceneGraph.fromTrafficSituation(ts);
      expect(sg.metadata.title).toBe('Hannover');
    });

    test('adds POINT nodes for accident GeoJSON features', () => {
      const ts = UA.TrafficSituation.create();
      const accidentData = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [9.73, 52.37] },
            properties: { UKATEGORIE: 1, UJAHR: 2022 }
          },
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [9.74, 52.38] },
            properties: { UKATEGORIE: 2, UJAHR: 2022 }
          }
        ]
      };
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'accident', version: 1, enabled: true, data: accidentData, meta: {}
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts2);
      const points = sg.nodes.filter(n => n.type === 'point');
      expect(points).toHaveLength(2);
    });

    test('maps severity 1 (fatal) to red color', () => {
      const ts = UA.TrafficSituation.create();
      const accidentData = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [9.73, 52.37] },
            properties: { UKATEGORIE: 1 }
          }
        ]
      };
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'accident', version: 1, enabled: true, data: accidentData, meta: {}
      });
      const sg     = UA.SceneGraph.fromTrafficSituation(ts2);
      const points = sg.nodes.filter(n => n.type === 'point');
      expect(points[0].style.color).toBe('#e74c3c');
      expect(points[0].style.radius).toBe(8);
    });

    test('accident POINT nodes have selectable interaction', () => {
      const ts = UA.TrafficSituation.create();
      const accidentData = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [9.73, 52.37] },
            properties: {}
          }
        ]
      };
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'accident', version: 1, enabled: true, data: accidentData, meta: {}
      });
      const sg     = UA.SceneGraph.fromTrafficSituation(ts2);
      const points = sg.nodes.filter(n => n.type === 'point');
      expect(points[0].interaction.selectable).toBe(true);
    });

    test('omits HEAT_FIELD when showHeatmap is false', () => {
      const ts = UA.TrafficSituation.create({
        core: { layerVisibility: { showHeatmap: false } }
      });
      const sg    = UA.SceneGraph.fromTrafficSituation(ts);
      const heats = sg.nodes.filter(n => n.type === 'heatField');
      expect(heats).toHaveLength(0);
    });

    test('omits CLUSTER when showCluster is false', () => {
      const ts = UA.TrafficSituation.create({
        core: { layerVisibility: { showCluster: false } }
      });
      const sg       = UA.SceneGraph.fromTrafficSituation(ts);
      const clusters = sg.nodes.filter(n => n.type === 'cluster');
      expect(clusters).toHaveLength(0);
    });

    test('adds BILLBOARD nodes from POI layer', () => {
      const ts = UA.TrafficSituation.create();
      const poiData = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [9.73, 52.37] },
            properties: { amenity: 'school', name: 'Grundschule Mitte' }
          }
        ]
      };
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'poi', version: 1, enabled: true, data: poiData, meta: {}
      });
      const sg       = UA.SceneGraph.fromTrafficSituation(ts2);
      const billboards = sg.nodes.filter(n => n.type === 'billboard');
      expect(billboards).toHaveLength(1);
      expect(billboards[0].semantic.kind).toBe('school');
      expect(billboards[0].semantic.label).toBe('Grundschule Mitte');
    });

    test('adds LABEL nodes from recommendation layer', () => {
      const ts = UA.TrafficSituation.create();
      const recData = [
        { text: 'Tempo-30-Zone einführen', location: { lat: 52.37, lon: 9.73 } }
      ];
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'recommendation', version: 1, enabled: true, data: recData, meta: {}
      });
      const sg     = UA.SceneGraph.fromTrafficSituation(ts2);
      const labels = sg.nodes.filter(n => n.type === 'label');
      expect(labels).toHaveLength(1);
      expect(labels[0].semantic.label).toBe('Tempo-30-Zone einführen');
    });

    test('LOD is set based on viewport zoom', () => {
      const ts = UA.TrafficSituation.create({
        core: { viewport: { zoom: 16 } }
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts);
      expect(sg.lod).toBe('intersection');
    });

    test('LOD defaults to city when zoom is null', () => {
      const ts = UA.TrafficSituation.create();
      const sg = UA.SceneGraph.fromTrafficSituation(ts);
      expect(sg.lod).toBe('city');
    });

    test('metadata.mapMode defaults to standard when no presentation layer', () => {
      const ts = UA.TrafficSituation.create();
      const sg = UA.SceneGraph.fromTrafficSituation(ts);
      expect(sg.metadata.mapMode).toBe('standard');
    });

    test('metadata.mapMode is taken from presentation layer', () => {
      const ts = UA.TrafficSituation.create();
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'presentation', version: 1, enabled: true,
        data: { mapMode: 'orthophoto', baseLayerAttribution: 'Quelle: Geobasis NRW' },
        meta: {}
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts2);
      expect(sg.metadata.mapMode).toBe('orthophoto');
      expect(sg.metadata.sourceAttribution).toBe('Quelle: Geobasis NRW');
    });

    test('adds a RASTER node when presentation layer provides baseLayerUrl', () => {
      const ts = UA.TrafficSituation.create();
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'presentation', version: 1, enabled: true,
        data: {
          mapMode: 'standard',
          baseLayerId: 'standard-osm',
          baseLayerUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          baseLayerTechnicalType: 'XYZ',
          baseLayerLabel: 'OpenStreetMap Standard',
          baseLayerProvider: 'OpenStreetMap',
          baseLayerAttribution: '&copy; OpenStreetMap-Mitwirkende',
          baseLayerLicense: 'ODbL 1.0',
          baseLayerOfficialForExport: true
        },
        meta: {}
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts2);
      const rasterNodes = sg.nodes.filter(n => n.type === 'raster');
      expect(rasterNodes).toHaveLength(1);
      const raster = rasterNodes[0];
      expect(raster.geometry.url).toBe('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
      expect(raster.geometry.technicalType).toBe('XYZ');
      expect(raster.semantic.layerId).toBe('standard-osm');
      expect(raster.semantic.provider).toBe('OpenStreetMap');
      expect(raster.semantic.attribution).toBe('&copy; OpenStreetMap-Mitwirkende');
      expect(raster.semantic.officialForExport).toBe(true);
    });

    test('RASTER node supports WMS technicalType', () => {
      const ts = UA.TrafficSituation.create();
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'presentation', version: 1, enabled: true,
        data: {
          mapMode: 'orthophoto',
          baseLayerUrl: 'https://www.wms.nrw.de/geobasis/wms_nw_dop',
          baseLayerTechnicalType: 'WMS',
          baseLayerWmsLayers: 'nw_dop',
          baseLayerFormat: 'image/png',
          baseLayerTransparent: false,
          baseLayerAttribution: 'Quelle: Geobasis NRW',
          baseLayerOfficialForExport: true
        },
        meta: {}
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts2);
      const rasterNodes = sg.nodes.filter(n => n.type === 'raster');
      expect(rasterNodes).toHaveLength(1);
      const raster = rasterNodes[0];
      expect(raster.geometry.technicalType).toBe('WMS');
      expect(raster.geometry.layers).toBe('nw_dop');
      expect(raster.geometry.format).toBe('image/png');
    });

    test('does not add a RASTER node when no baseLayerUrl in presentation', () => {
      const ts = UA.TrafficSituation.create();
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'presentation', version: 1, enabled: true,
        data: { mapMode: 'standard' },
        meta: {}
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts2);
      const rasterNodes = sg.nodes.filter(n => n.type === 'raster');
      expect(rasterNodes).toHaveLength(0);
    });

    test('RASTER semantic.attribution defaults to empty string when missing', () => {
      const ts = UA.TrafficSituation.create();
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: 'presentation', version: 1, enabled: true,
        data: {
          baseLayerUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
          baseLayerTechnicalType: 'XYZ'
        },
        meta: {}
      });
      const sg = UA.SceneGraph.fromTrafficSituation(ts2);
      const rasterNodes = sg.nodes.filter(n => n.type === 'raster');
      expect(rasterNodes).toHaveLength(1);
      expect(rasterNodes[0].semantic.attribution).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  describe('serialization (JSON round-trip)', () => {
    test('a SceneGraph is fully JSON-serializable', () => {
      const sg = UA.SceneGraph.create({
        id: 'test-sg',
        metadata: {
          title: 'Test',
          mapMode: 'standard',
          sourceAttribution: '&copy; OpenStreetMap-Mitwirkende'
        }
      });
      expect(() => JSON.stringify(sg)).not.toThrow();
      const parsed = JSON.parse(JSON.stringify(sg));
      expect(parsed.id).toBe('test-sg');
      expect(parsed.metadata.mapMode).toBe('standard');
      expect(parsed.metadata.sourceAttribution).toBe('&copy; OpenStreetMap-Mitwirkende');
    });

    test('a SceneGraph with nodes is fully JSON-serializable', () => {
      let sg = UA.SceneGraph.create();
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point', {
        geometry: { lat: 52.37, lon: 9.73 },
        semantic: { kind: 'accident', label: 'KFZ/FG' },
        interaction: { selectable: true, data: { UKATEGORIE: 1 } }
      }));
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('raster', {
        geometry: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', technicalType: 'XYZ' },
        semantic: { kind: 'baseLayer', attribution: '&copy; OpenStreetMap-Mitwirkende' }
      }));
      const json = JSON.stringify(sg);
      expect(() => JSON.parse(json)).not.toThrow();
      const parsed = JSON.parse(json);
      expect(parsed.nodes).toHaveLength(2);
      expect(parsed.nodes[0].type).toBe('point');
      expect(parsed.nodes[1].type).toBe('raster');
      expect(parsed.nodes[1].geometry.url).toContain('openstreetmap');
    });

    test('serialized SceneGraph matches snapshot', () => {
      // Use a fixed id and created date for determinism
      let sg = UA.SceneGraph.create({
        id: 'snapshot-test',
        metadata: {
          title: 'Snapshot Test',
          description: 'Deterministic snapshot for regression detection',
          created: '2024-01-01T00:00:00.000Z',
          mapMode: 'standard',
          sourceAttribution: '© OpenStreetMap-Mitwirkende'
        }
      });
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('point', {
        id: 'p1',
        geometry: { lat: 52.37, lon: 9.73 },
        style: { color: '#e74c3c', radius: 8, opacity: 0.85, fillOpacity: 0.65 },
        semantic: { kind: 'accident', label: '', severity: 1, year: 2022 },
        interaction: { selectable: true, hoverable: true, data: { UKATEGORIE: 1 } },
        lod: { minLevel: 'city', maxLevel: 'pedestrian', overrides: {} }
      }));
      sg = UA.SceneGraph.addNode(sg, UA.SceneGraph.createNode('raster', {
        id: 'r1',
        geometry: { url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', technicalType: 'XYZ' },
        semantic: { kind: 'baseLayer', label: 'OpenStreetMap Standard', attribution: '© OpenStreetMap-Mitwirkende' }
      }));
      expect(JSON.parse(JSON.stringify(sg))).toMatchSnapshot();
    });
  });
});
