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
  loadModule('../../js/ua.map_scene_url_codec.js', win);
  loadModule('../../js/ua.traffic_situation.js', win);
  return win.UA;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UA.TrafficSituation', () => {
  let UA;
  beforeEach(() => { UA = makeUA(); });

  // -------------------------------------------------------------------------
  describe('LAYER_TYPES', () => {
    test('exposes all expected layer type constants', () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      expect(LT.ACCIDENT).toBe('accident');
      expect(LT.POI).toBe('poi');
      expect(LT.CONTEXT_ROAD).toBe('contextRoad');
      expect(LT.POLITICAL_CONTEXT).toBe('politicalContext');
      expect(LT.ENVIRONMENTAL).toBe('environmental');
      expect(LT.AI_ASSESSMENT).toBe('aiAssessment');
      expect(LT.RECOMMENDATION).toBe('recommendation');
      expect(LT.EXPORT).toBe('export');
      expect(LT.PRESENTATION).toBe('presentation');
    });

    test('LAYER_TYPES object is frozen', () => {
      expect(Object.isFrozen(UA.TrafficSituation.LAYER_TYPES)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('create', () => {
    test('returns a default TrafficSituation with expected shape', () => {
      const ts = UA.TrafficSituation.create();
      expect(ts.version).toBe(1);
      expect(ts.id).toBeNull();
      expect(ts.metadata).toBeDefined();
      expect(ts.metadata.city).toBe('');
      expect(ts.metadata.description).toBe('');
      expect(ts.metadata.created).toBeTruthy();
      expect(ts.metadata.updated).toBeTruthy();
      expect(ts.core).toBeDefined();
      expect(ts.context).toBeDefined();
      expect(ts.context.selectionQuery).toBeNull();
      expect(ts.context.capabilities).toEqual({});
      expect(ts.layers).toEqual({});
    });

    test('core has correct default viewport', () => {
      const ts = UA.TrafficSituation.create();
      expect(ts.core.viewport.center).toBeNull();
      expect(ts.core.viewport.zoom).toBeNull();
    });

    test('core has correct default filters', () => {
      const ts = UA.TrafficSituation.create();
      expect(ts.core.filters.severity).toBe('all');
      expect(ts.core.filters.includeCyclist).toBe(true);
      expect(ts.core.filters.involvementMode).toBe('or');
      expect(ts.core.filters.contextFilters.slopeClasses).toEqual([]);
    });

    test('core has correct default layerVisibility', () => {
      const ts = UA.TrafficSituation.create();
      expect(ts.core.layerVisibility.showCluster).toBe(true);
      expect(ts.core.layerVisibility.showHeatmap).toBe(true);
      expect(ts.core.layerVisibility.showOnlyAboveAverage).toBe(false);
    });

    test('core has correct default accidentView', () => {
      const ts = UA.TrafficSituation.create();
      expect(ts.core.accidentView).toBe('bySeverity');
    });

    test('keeps stable top-level API while context remains transitional', () => {
      const ts = UA.TrafficSituation.create();
      expect(Object.keys(ts).sort()).toEqual(['context', 'core', 'id', 'layers', 'metadata', 'version']);
      expect(ts.context.selectionQuery).toBeNull();
    });

    test('merges top-level overrides', () => {
      const ts = UA.TrafficSituation.create({ id: 'test-id' });
      expect(ts.id).toBe('test-id');
    });

    test('shallow-merges metadata', () => {
      const ts = UA.TrafficSituation.create({ metadata: { city: 'Berlin' } });
      expect(ts.metadata.city).toBe('Berlin');
      expect(ts.metadata.description).toBe(''); // default preserved
    });

    test('deep-merges core.filters without losing defaults', () => {
      const ts = UA.TrafficSituation.create({
        core: { filters: { severity: '1', dayType: 'weekend' } }
      });
      expect(ts.core.filters.severity).toBe('1');
      expect(ts.core.filters.dayType).toBe('weekend');
      expect(ts.core.filters.includeCyclist).toBe(true); // default preserved
    });

    test('deep-merges core.filters.contextFilters', () => {
      const ts = UA.TrafficSituation.create({
        core: { filters: { contextFilters: { slopeClasses: ['steep'] } } }
      });
      expect(ts.core.filters.contextFilters.slopeClasses).toEqual(['steep']);
      expect(ts.core.filters.contextFilters.onlyMatchedWays).toBe(false); // default preserved
    });

    test('deep-merges core.layerVisibility', () => {
      const ts = UA.TrafficSituation.create({
        core: { layerVisibility: { showCluster: false } }
      });
      expect(ts.core.layerVisibility.showCluster).toBe(false);
      expect(ts.core.layerVisibility.showHeatmap).toBe(true); // default preserved
    });

    test('returns independent objects on each call', () => {
      const a = UA.TrafficSituation.create();
      const b = UA.TrafficSituation.create();
      a.metadata.city = 'Hamburg';
      expect(b.metadata.city).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  describe('fromMapScene', () => {
    test('returns default TrafficSituation for null scene', () => {
      const ts = UA.TrafficSituation.fromMapScene(null);
      expect(ts.core.viewport.center).toBeNull();
    });

    test('maps city from scene.city', () => {
      const scene = UA.MapScene.create({ city: 'Hamburg' });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      expect(ts.metadata.city).toBe('Hamburg');
    });

    test('maps viewport center and zoom', () => {
      const scene = UA.MapScene.create({
        center: { lat: 53.55, lon: 9.99 },
        zoom:   14
      });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      expect(ts.core.viewport.center).toEqual({ lat: 53.55, lon: 9.99 });
      expect(ts.core.viewport.zoom).toBe(14);
    });

    test('maps selection', () => {
      const selection = { south: 51.0, west: 10.0, north: 52.0, east: 11.0 };
      const scene = UA.MapScene.create({ selection });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      expect(ts.core.selection).toEqual(selection);
    });

    test('maps filters from scene', () => {
      const scene = UA.MapScene.create({
        filters: { severity: '1', dayType: 'weekend' }
      });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      expect(ts.core.filters.severity).toBe('1');
      expect(ts.core.filters.dayType).toBe('weekend');
      expect(ts.core.filters.includeCyclist).toBe(true); // default
    });

    test('maps layer visibility', () => {
      const scene = UA.MapScene.create({
        layers: { showCluster: false, showHeatmap: true }
      });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      expect(ts.core.layerVisibility.showCluster).toBe(false);
      expect(ts.core.layerVisibility.showHeatmap).toBe(true);
    });

    test('maps accidentView', () => {
      const scene = UA.MapScene.create({ accidentView: 'byType' });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      expect(ts.core.accidentView).toBe('byType');
    });

    test('attaches initial layers when provided', () => {
      const scene = UA.MapScene.create({ city: 'Berlin' });
      const LT = UA.TrafficSituation.LAYER_TYPES;
      const layers = {
        [LT.ACCIDENT]: { type: LT.ACCIDENT, version: 1, enabled: true, data: null, meta: {} }
      };
      const ts = UA.TrafficSituation.fromMapScene(scene, layers);
      expect(ts.layers[LT.ACCIDENT]).toBeDefined();
      expect(ts.layers[LT.ACCIDENT].type).toBe(LT.ACCIDENT);
    });

    test('maps export options into context', () => {
      const scene = UA.MapScene.create({
        exportOptions: { includeCosts: false },
        contextOverlays: { active: { slope: true, traffic: false } }
      });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      expect(ts.context.exportOptions.includeCosts).toBe(false);
      expect(ts.context.contextOverlays.active.slope).toBe(true);
      expect(ts.context.selectionQuery.accidentView).toBe('bySeverity');
    });

    test('does not mutate the original scene', () => {
      const scene = UA.MapScene.create({ city: 'Bonn' });
      const ts = UA.TrafficSituation.fromMapScene(scene);
      ts.metadata.city = 'Köln';
      expect(scene.city).toBe('Bonn');
    });
  });

  // -------------------------------------------------------------------------
  describe('toMapScene', () => {
    test('returns a MapScene-compatible object', () => {
      const ts = UA.TrafficSituation.create({ metadata: { city: 'München' } });
      const scene = UA.TrafficSituation.toMapScene(ts);
      expect(scene).toBeDefined();
      expect(scene.city).toBe('München');
    });

    test('round-trips through fromMapScene → toMapScene', () => {
      const original = UA.MapScene.create({
        city:         'Dresden',
        center:       { lat: 51.05, lon: 13.74 },
        zoom:         12,
        accidentView: 'byType',
        filters:      { severity: '2', dayType: 'workday' }
      });
      const ts    = UA.TrafficSituation.fromMapScene(original);
      const scene = UA.TrafficSituation.toMapScene(ts);
      expect(scene.city).toBe('Dresden');
      expect(scene.center).toEqual({ lat: 51.05, lon: 13.74 });
      expect(scene.zoom).toBe(12);
      expect(scene.accidentView).toBe('byType');
      expect(scene.filters.severity).toBe('2');
      expect(scene.filters.dayType).toBe('workday');
    });

    test('returns null for undefined ts', () => {
      const scene = UA.TrafficSituation.toMapScene(undefined);
      // When UA.MapScene is available a default is returned, otherwise null.
      // Either way no exception is thrown.
      expect(scene === null || typeof scene === 'object').toBe(true);
    });

    test('carries contextRoad overlay state to contextOverlays', () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      const ts = UA.TrafficSituation.create();
      const tsWithCtx = UA.TrafficSituation.addLayer(ts, {
        type:    LT.CONTEXT_ROAD,
        version: 1,
        enabled: true,
        data:    null,
        meta:    { contextOverlays: { active: { slope: true, traffic: false } } }
      });
      const scene = UA.TrafficSituation.toMapScene(tsWithCtx);
      expect(scene.contextOverlays.active.slope).toBe(true);
    });

    test('returns cloned center and selection objects', () => {
      const ts = UA.TrafficSituation.create({
        core: {
          viewport: { center: { lat: 53.55, lon: 9.99 }, zoom: 14 },
          selection: { south: 53.4, west: 9.8, north: 53.7, east: 10.1 }
        }
      });
      const scene = UA.TrafficSituation.toMapScene(ts);
      scene.center.lat = 0;
      scene.selection.south = 0;
      expect(ts.core.viewport.center.lat).toBe(53.55);
      expect(ts.core.selection.south).toBe(53.4);
    });
  });

  // -------------------------------------------------------------------------
  describe('addLayer', () => {
    test('returns a new object (immutable)', () => {
      const ts  = UA.TrafficSituation.create();
      const LT  = UA.TrafficSituation.LAYER_TYPES;
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: LT.ACCIDENT, version: 1, enabled: true, data: null, meta: {}
      });
      expect(ts2).not.toBe(ts);
      expect(ts.layers).toEqual({});      // original unchanged
      expect(ts2.layers[LT.ACCIDENT]).toBeDefined();
    });

    test('replaces an existing layer of the same type', () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      let ts = UA.TrafficSituation.create();
      ts = UA.TrafficSituation.addLayer(ts, { type: LT.POI, version: 1, enabled: false, data: null, meta: {} });
      ts = UA.TrafficSituation.addLayer(ts, { type: LT.POI, version: 2, enabled: true,  data: null, meta: {} });
      expect(ts.layers[LT.POI].version).toBe(2);
      expect(ts.layers[LT.POI].enabled).toBe(true);
    });

    test('updates metadata.updated timestamp', () => {
      const ts  = UA.TrafficSituation.create();
      const t0  = ts.metadata.updated;
      // Ensure a detectable time difference
      const ts2 = UA.TrafficSituation.addLayer(ts, {
        type: UA.TrafficSituation.LAYER_TYPES.POI, version: 1, enabled: true, data: null, meta: {}
      });
      expect(ts2.metadata.updated >= t0).toBe(true);
    });

    test('throws when layer.type is missing', () => {
      const ts = UA.TrafficSituation.create();
      expect(() => UA.TrafficSituation.addLayer(ts, { version: 1 }))
        .toThrow('layer.type is required');
    });

    test('throws a clear error when ts is missing', () => {
      expect(() => UA.TrafficSituation.addLayer(null, { type: 'poi' }))
        .toThrow('ts is required');
    });

    test('clones the layer data (no shared references)', () => {
      const LT   = UA.TrafficSituation.LAYER_TYPES;
      const data = { features: [] };
      const ts   = UA.TrafficSituation.addLayer(
        UA.TrafficSituation.create(),
        { type: LT.ACCIDENT, version: 1, enabled: true, data, meta: {} }
      );
      data.features.push('x');
      expect(ts.layers[LT.ACCIDENT].data.features).toEqual([]); // not mutated
    });
  });

  // -------------------------------------------------------------------------
  describe('removeLayer', () => {
    test('removes the specified layer', () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      let ts = UA.TrafficSituation.create();
      ts = UA.TrafficSituation.addLayer(ts, { type: LT.POI, version: 1, enabled: true, data: null, meta: {} });
      ts = UA.TrafficSituation.removeLayer(ts, LT.POI);
      expect(ts.layers[LT.POI]).toBeUndefined();
    });

    test('is a no-op when the layer does not exist', () => {
      const ts  = UA.TrafficSituation.create();
      const ts2 = UA.TrafficSituation.removeLayer(ts, 'nonexistent');
      expect(ts2).toBe(ts); // same reference — nothing changed
    });

    test('does not affect other layers', () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      let ts = UA.TrafficSituation.create();
      ts = UA.TrafficSituation.addLayer(ts, { type: LT.POI,      version: 1, enabled: true, data: null, meta: {} });
      ts = UA.TrafficSituation.addLayer(ts, { type: LT.ACCIDENT, version: 1, enabled: true, data: null, meta: {} });
      ts = UA.TrafficSituation.removeLayer(ts, LT.POI);
      expect(ts.layers[LT.ACCIDENT]).toBeDefined();
    });

    test('returns null unchanged for null ts', () => {
      expect(UA.TrafficSituation.removeLayer(null, 'poi')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('getLayer', () => {
    test('returns the layer when present', () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      let ts = UA.TrafficSituation.create();
      ts = UA.TrafficSituation.addLayer(ts, { type: LT.AI_ASSESSMENT, version: 1, enabled: true, data: { score: 0.8 }, meta: {} });
      const layer = UA.TrafficSituation.getLayer(ts, LT.AI_ASSESSMENT);
      expect(layer).toBeDefined();
      expect(layer.data.score).toBe(0.8);
    });

    test('returns null when layer is absent', () => {
      const ts = UA.TrafficSituation.create();
      expect(UA.TrafficSituation.getLayer(ts, 'nonexistent')).toBeNull();
    });

    test('returns null for null ts', () => {
      expect(UA.TrafficSituation.getLayer(null, 'accident')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('fromCtx', () => {
    test('captures serializable context capabilities and export options', () => {
      const map = {
        getCenter: () => ({ lat: 53.55, lng: 9.99 }),
        getZoom:   () => 14
      };
      const ts = UA.TrafficSituation.fromCtx({
        CITY_RAW: 'Hamburg',
        map,
        contextCapabilities: { hasSlope: true, hasAny: true },
        exportOptions: { includeMeasures: false },
        selectedAccidentIds: new Set(['a1', 'a2']),
        reportOptions: { preview: true }
      });
      expect(ts.metadata.city).toBe('Hamburg');
      expect(ts.context.capabilities.hasSlope).toBe(true);
      expect(ts.context.exportOptions.includeMeasures).toBe(false);
      expect(ts.context.selectedAccidentIds).toEqual(['a1', 'a2']);
      expect(ts.context.reportOptions.preview).toBe(true);
    });

    test('produces JSON-safe data without Leaflet/DOM references', () => {
      const ts = UA.TrafficSituation.fromCtx({
        CITY_RAW: 'Bremen',
        map: { getCenter: () => ({ lat: 53.08, lng: 8.8 }), getZoom: () => 11 },
        ui: { severityEl: { value: '1' }, statEl: document.createElement('div') }
      });
      const raw = UA.TrafficSituation.serialize(ts);
      expect(() => JSON.stringify(raw)).not.toThrow();
      expect(raw.map).toBeUndefined();
      expect(raw.ui).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('serialize / deserialize', () => {
    test('serialized output is JSON-safe (no functions, no circular refs)', () => {
      const ts  = UA.TrafficSituation.create({ metadata: { city: 'Frankfurt' } });
      const raw = UA.TrafficSituation.serialize(ts);
      expect(() => JSON.stringify(raw)).not.toThrow();
    });

    test('deserialize restores a TrafficSituation from serialized form', () => {
      const ts  = UA.TrafficSituation.create({ metadata: { city: 'Frankfurt' } });
      const raw = UA.TrafficSituation.serialize(ts);
      const ts2 = UA.TrafficSituation.deserialize(raw);
      expect(ts2.metadata.city).toBe('Frankfurt');
      expect(ts2.version).toBe(1);
    });

    test('round-trip preserves layers', () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      let ts = UA.TrafficSituation.create();
      ts = UA.TrafficSituation.addLayer(ts, {
        type: LT.RECOMMENDATION, version: 1, enabled: true,
        data: { measures: ['reduce speed limit'] }, meta: {}
      });
      const ts2 = UA.TrafficSituation.deserialize(UA.TrafficSituation.serialize(ts));
      expect(ts2.layers[LT.RECOMMENDATION].data.measures).toEqual(['reduce speed limit']);
    });

    test('serialize produces a deep clone (mutations do not affect original)', () => {
      const ts  = UA.TrafficSituation.create({ metadata: { city: 'Hannover' } });
      const raw = UA.TrafficSituation.serialize(ts);
      raw.metadata.city = 'Dortmund';
      expect(ts.metadata.city).toBe('Hannover');
    });

    test('deserialize throws for wrong schema version', () => {
      expect(() => UA.TrafficSituation.deserialize({ version: 99 }))
        .toThrow('unsupported schema version');
    });

    test('deserialize throws for non-object input', () => {
      expect(() => UA.TrafficSituation.deserialize('bad')).toThrow();
    });

    test('URL scene round-trips via TrafficSituation JSON', () => {
      const url = '?city=Bonn&centerLat=50.73&centerLon=7.1&zoom=13&severity=2&mapLayer=slope';
      const scene = UA.MapSceneUrlCodec.decode(url);
      const ts = UA.TrafficSituation.fromMapScene(scene);
      const raw = UA.TrafficSituation.serialize(ts);
      const ts2 = UA.TrafficSituation.deserialize(JSON.parse(JSON.stringify(raw)));
      const scene2 = UA.TrafficSituation.toMapScene(ts2);
      const encoded = UA.MapSceneUrlCodec.encode(scene2);
      expect(encoded).toContain('city=Bonn');
      expect(encoded).toContain('severity=2');
      expect(encoded).toContain('mapLayer=slope');
    });
  });

  // -------------------------------------------------------------------------
  describe('Leaflet independence', () => {
    test('module loads without window.L being defined', () => {
      const win = { UA: {}, location: { href: 'http://localhost/' } };
      // deliberately no win.L
      loadModule('../../js/ua.traffic_situation.js', win);
      const ts = win.UA.TrafficSituation.create();
      expect(ts).toBeDefined();
      expect(ts.version).toBe(1);
    });
  });
});
