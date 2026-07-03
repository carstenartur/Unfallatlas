'use strict';

/**
 * Integration test: verifies that all Issue #312 architecture modules are
 * correctly wired together.
 *
 * Tests:
 *  1. AccidentProvider registers and resolves via ProviderRegistry.
 *  2. loadCityData routes through the registered provider.
 *  3. TrafficSituation is created from ctx (including via fromCtx bridge).
 *  4. AnalysisPipeline runs PilotPlugin and produces accidentStatistics.
 *  5. SceneGraph is built from a TrafficSituation (renderer-independent model).
 *  6. TrafficSituation serialization round-trips.
 *  7. computeExportReport includes ctx.trafficSituation in structured.meta.
 */

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Module loader helpers
// ---------------------------------------------------------------------------

function makeWindow(extra) {
  return Object.assign(
    { UA: {}, location: { href: 'http://localhost/' } },
    extra || {}
  );
}

function loadModule(win, relPath) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, relPath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function loadArchModules(win) {
  const load = (f) => loadModule(win, `../../js/${f}`);
  load('ua.core.js');
  load('ua.accident_provider.js');
  load('ua.render_scheduler.js');
  load('ua.map_store.js');
  load('ua.map_scene.js');
  load('ua.map_scene_url_codec.js');
  load('ua.traffic_situation.js');
  load('ua.analysis_pipeline.js');
  load('ua.pilot_plugin.js');
  load('ua.scene_graph.js');
  load('ua.renderer.js');
}

// ---------------------------------------------------------------------------
// Fake fetch
// ---------------------------------------------------------------------------

function makeFetch(map) {
  return async (url) => {
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => entry };
  };
}

function makeFC(features, props) {
  const fc = { type: 'FeatureCollection', features: features || [] };
  if (props) fc.properties = props;
  return fc;
}

function makePoint(lat, lon, ukategorie) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { UKATEGORIE: ukategorie || 1 }
  };
}

// ---------------------------------------------------------------------------
// 1. AccidentProvider registers and resolves
// ---------------------------------------------------------------------------

describe('Architecture integration: AccidentProvider', () => {
  let UA;

  beforeEach(() => {
    const win = makeWindow();
    loadArchModules(win);
    UA = win.UA;
  });

  test('ProviderRegistry.register + resolve returns the provider', () => {
    const p = UA.AccidentProvider.createStaticProvider();
    UA.AccidentProvider.ProviderRegistry.register('static', p);
    const resolved = UA.AccidentProvider.ProviderRegistry.resolve('hannover');
    expect(resolved).toBe(p);
  });

  test('StaticGeoJsonAccidentProvider.fetchForCity fetches GeoJSON', async () => {
    const fc = makeFC([makePoint(52.3, 9.7, 1)]);
    const fakeFetch = makeFetch({ 'out/output_all_years_hannover.geojson': fc });
    const p = UA.AccidentProvider.createStaticProvider({ fetch: fakeFetch });
    UA.AccidentProvider.ProviderRegistry.register('static', p);

    const gj = await p.fetchForCity('hannover');
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.features).toHaveLength(1);
  });

  test('ProviderRegistry.resolve falls back to first registered when no slug match', () => {
    const p = UA.AccidentProvider.createStaticProvider();
    UA.AccidentProvider.ProviderRegistry.register('static', p);
    // Any city without an explicit provider resolves to the fallback
    const resolved = UA.AccidentProvider.ProviderRegistry.resolve('unknowncity');
    expect(resolved).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. TrafficSituation from ctx
// ---------------------------------------------------------------------------

describe('Architecture integration: TrafficSituation', () => {
  let UA;

  beforeEach(() => {
    const win = makeWindow();
    loadArchModules(win);
    UA = win.UA;
  });

  test('TrafficSituation.fromCtx creates a valid domain object from a minimal ctx', () => {
    const ctx = {
      CITY_RAW: 'hannover',
      allPts: [{ lat: 52.3, lon: 9.7, props: { UKATEGORIE: 1 } }],
      contextCapabilities: { hasSlope: false, hasOsmContext: true },
      filters: {},
      involvementMode: 'or'
    };
    const ts = UA.TrafficSituation.fromCtx(ctx);
    expect(ts).toBeDefined();
    expect(ts.metadata.city).toBe('hannover');
    expect(ts.context.capabilities.hasOsmContext).toBe(true);
  });

  test('TrafficSituation round-trips via serialize/deserialize', () => {
    const ctx = {
      CITY_RAW: 'bonn',
      allPts: [],
      contextCapabilities: {},
      filters: {},
      involvementMode: 'or'
    };
    const ts = UA.TrafficSituation.fromCtx(ctx);
    const serialized = UA.TrafficSituation.serialize(ts);
    const restored   = UA.TrafficSituation.deserialize(serialized);
    expect(restored.metadata.city).toBe('bonn');
    expect(restored.id).toBe(ts.id);
  });

  test('TrafficSituation.fromMapScene accepts a minimal MapScene', () => {
    const scene = UA.MapScene.create({ city: 'berlin' });
    const ts    = UA.TrafficSituation.fromMapScene(scene);
    expect(ts.metadata.city).toBe('berlin');
  });
});

// ---------------------------------------------------------------------------
// 3. AnalysisPipeline + PilotPlugin
// ---------------------------------------------------------------------------

describe('Architecture integration: AnalysisPipeline + PilotPlugin', () => {
  let UA;

  beforeEach(() => {
    const win = makeWindow();
    loadArchModules(win);
    UA = win.UA;
  });

  test('runPipeline with ACCIDENT_STATISTICS produces accidentStatistics', async () => {
    const pts = [
      makePoint(52.3, 9.7, 1),
      makePoint(52.31, 9.71, 2),
      makePoint(52.32, 9.72, 3)
    ];
    // Provide both required (accidents) and optional (viewport) data so the
    // plugin returns 'complete' rather than 'partial'.
    const dataReg   = UA.AnalysisPipeline.createDataRegistry({
      accidents: { type: 'FeatureCollection', features: pts },
      viewport:  { center: { lat: 52.3, lon: 9.7 }, zoom: 14 }
    });
    const pluginReg = UA.AnalysisPipeline.createPluginRegistry([UA.PilotPlugin.ACCIDENT_STATISTICS]);
    const results   = await UA.AnalysisPipeline.runPipeline({ dataRegistry: dataReg, pluginRegistry: pluginReg });

    expect(results).toBeDefined();
    const pluginResult = results.resultMap && results.resultMap['accident-statistics'];
    expect(pluginResult).toBeDefined();
    expect(pluginResult.status).toBe('complete');
    expect(pluginResult.producedArtifacts.accidentStatistics.total).toBe(3);
  });

  test('runPipeline without optional viewport data returns partial status', async () => {
    const pts = [makePoint(52.3, 9.7, 1)];
    const dataReg   = UA.AnalysisPipeline.createDataRegistry({
      accidents: { type: 'FeatureCollection', features: pts }
    });
    const pluginReg = UA.AnalysisPipeline.createPluginRegistry([UA.PilotPlugin.ACCIDENT_STATISTICS]);
    const results   = await UA.AnalysisPipeline.runPipeline({ dataRegistry: dataReg, pluginRegistry: pluginReg });

    const pluginResult = results.resultMap && results.resultMap['accident-statistics'];
    expect(pluginResult).toBeDefined();
    // Viewport is optional — plugin still produces results, but marks them partial.
    expect(pluginResult.status).toBe('partial');
    expect(pluginResult.producedArtifacts.accidentStatistics.total).toBe(1);
  });

  test('runPipeline with no accident data produces a skipped result', async () => {
    const dataReg   = UA.AnalysisPipeline.createDataRegistry({});
    const pluginReg = UA.AnalysisPipeline.createPluginRegistry([UA.PilotPlugin.ACCIDENT_STATISTICS]);
    const results   = await UA.AnalysisPipeline.runPipeline({ dataRegistry: dataReg, pluginRegistry: pluginReg });

    const pluginResult = results.resultMap && results.resultMap['accident-statistics'];
    // Missing required data → skipped or failed, not crash
    expect(pluginResult).toBeDefined();
    expect(['skipped', 'failed']).toContain(pluginResult.status);
  });
});

// ---------------------------------------------------------------------------
// 4. SceneGraph from TrafficSituation
// ---------------------------------------------------------------------------

describe('Architecture integration: SceneGraph', () => {
  let UA;

  beforeEach(() => {
    const win = makeWindow();
    loadArchModules(win);
    UA = win.UA;
  });

  test('SceneGraph.fromTrafficSituation returns a valid graph from a minimal TS', () => {
    const ctx = { CITY_RAW: 'hannover', allPts: [], contextCapabilities: {}, filters: {}, involvementMode: 'or' };
    const ts  = UA.TrafficSituation.fromCtx(ctx);
    const sg  = UA.SceneGraph.fromTrafficSituation(ts);

    expect(sg).toBeDefined();
    expect(sg.id).toBeDefined();
    expect(Array.isArray(sg.nodes)).toBe(true);
  });

  test('SceneGraph is JSON-serializable', () => {
    const ctx = { CITY_RAW: 'berlin', allPts: [], contextCapabilities: {}, filters: {}, involvementMode: 'or' };
    const ts  = UA.TrafficSituation.fromCtx(ctx);
    const sg  = UA.SceneGraph.fromTrafficSituation(ts);

    expect(() => JSON.stringify(sg)).not.toThrow();
    const restored = JSON.parse(JSON.stringify(sg));
    expect(restored.id).toBe(sg.id);
  });
});

// ---------------------------------------------------------------------------
// 5. computeExportReport includes trafficSituation in structured.meta
// ---------------------------------------------------------------------------

describe('Architecture integration: export metadata includes TrafficSituation', () => {
  let UA;
  let win;

  beforeEach(() => {
    win = makeWindow();
    // Export module needs fetch in the window scope
    win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    win.L = { latLngBounds: () => {} };
    loadArchModules(win);
    // Export module needs additional modules
    loadModule(win, '../../js/ua.utils.js');
    loadModule(win, '../../js/ua.state.js');
    loadModule(win, '../../js/ua.filters.js');
    loadModule(win, '../../js/ua.accident_views.js');
    loadModule(win, '../../js/ua.stats.js');
    loadModule(win, '../../js/ua.costs.js');
    loadModule(win, '../../js/ua.measures.js');
    loadModule(win, '../../js/ua.context_measures.js');
    loadModule(win, '../../js/ua.trend.js');
    loadModule(win, '../../js/ua.osm_context.js');
    loadModule(win, '../../js/ua.export_v2.js');
    UA = win.UA;
  });

  function makeBounds() {
    const sw = { lat: 52.29, lng: 9.69 };
    const ne = { lat: 52.31, lng: 9.71 };
    return {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter:    () => ({ lat: 52.3, lng: 9.7 }),
      contains: (latlng) => {
        const [la, lo] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
        return la >= sw.lat && la <= ne.lat && lo >= sw.lng && lo <= ne.lng;
      }
    };
  }

  function makeUI() {
    return {
      severityEl:      { value: 'all' },
      roadConditionEl: { value: 'all' },
      dayTypeEl:       { value: 'all' },
      hFromEl:         { value: '0' },
      hToEl:           { value: '23' },
      incBikeEl:       { checked: true },
      incPedEl:        { checked: true },
      incCarEl:        { checked: true },
      incMotoEl:       { checked: false },
      incGkfzEl:       { checked: false },
      incSonEl:        { checked: false }
    };
  }

  test('structured.meta includes trafficSituation when ctx.trafficSituation is set', async () => {
    UA.reverseGeocode = async () => null;
    const ctx = {
      CITY_RAW: 'hannover',
      allPts: [{ lat: 52.3, lon: 9.7, props: { year: 2022, UKATEGORIE: 1 } }],
      filteredAll: [],
      filteredCapped: [],
      viewportPts: [],
      contextCapabilities: {},
      filters: {},
      involvementMode: 'or',
      exportMode: 'bicycle',
      reportOptions: {},
      ui: makeUI(),
      selectionBounds: makeBounds()
    };
    // Set trafficSituation on ctx (simulating what app_v2.js does after city load)
    ctx.trafficSituation = UA.TrafficSituation.fromCtx(ctx);

    const result = await UA.computeExportReport(ctx);
    expect(result.structured.meta.trafficSituation).toBeDefined();
    expect(result.structured.meta.trafficSituation.metadata.city).toBe('hannover');
  });

  test('structured.meta.trafficSituation is absent when ctx.trafficSituation is not set', async () => {
    UA.reverseGeocode = async () => null;
    const ctx = {
      CITY_RAW: 'hannover',
      allPts: [],
      filteredAll: [],
      filteredCapped: [],
      viewportPts: [],
      contextCapabilities: {},
      filters: {},
      involvementMode: 'or',
      exportMode: 'bicycle',
      reportOptions: {},
      ui: makeUI(),
      selectionBounds: makeBounds()
    };
    // No trafficSituation set

    const result = await UA.computeExportReport(ctx);
    expect(result.structured.meta.trafficSituation).toBeUndefined();
  });
});
