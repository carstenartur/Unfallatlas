'use strict';

/**
 * Cross-module architecture checks for issue #312.
 *
 * The loader setup mirrors the production order for static data:
 * core -> DataResources -> AccidentProvider -> consumers.
 */

const fs = require('fs');
const path = require('path');

function makeWindow(extra) {
  return Object.assign({
    UA: {},
    location: { href: 'http://localhost/', search: '' },
    history: { replaceState: () => {} },
  }, extra || {});
}

function loadModule(win, relativePath) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function installJsonTransport(win) {
  const fetchResponse = async (url, options) => {
    const fetchImpl = options?.fetch || win.fetch;
    if (typeof fetchImpl !== 'function') throw new Error(`No fetch for ${url}`);
    const response = await fetchImpl(url, { cache: options?.cache });
    if (!response || !response.ok) throw new Error(`HTTP ${response?.status} for ${url}`);
    return response.json();
  };
  win.UA.fetchJsonCompressed = fetchResponse;
  win.UA.fetchJsonGz = async (url, options) => fetchResponse(String(url).replace(/\.gz$/, ''), options);
}

function loadArchModules(win) {
  const load = file => loadModule(win, `../../js/${file}`);
  load('ua.core.js');
  installJsonTransport(win);
  load('ua.data_paths.js');
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

function makeFetch(map) {
  return async url => {
    const entry = map[url];
    if (!entry) return { ok: false, status: 404, json: async () => null };
    return { ok: true, status: 200, json: async () => entry };
  };
}

function featureCollection(features, properties) {
  const value = { type: 'FeatureCollection', features: features || [] };
  if (properties) value.properties = properties;
  return value;
}

function point(lat, lon, category = 1) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { UKATEGORIE: category },
  };
}

function mapBounds() {
  return {
    getSouth: () => 52.29,
    getWest: () => 9.69,
    getNorth: () => 52.31,
    getEast: () => 9.71,
    getSouthWest: () => ({ lat: 52.29, lng: 9.69 }),
    getNorthEast: () => ({ lat: 52.31, lng: 9.71 }),
    getCenter: () => ({ lat: 52.3, lng: 9.7 }),
    contains: latlng => {
      const [lat, lon] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
      return lat >= 52.29 && lat <= 52.31 && lon >= 9.69 && lon <= 9.71;
    },
  };
}

describe('Architecture integration: AccidentProvider and data modes', () => {
  test('static provider loads through DataResources', async () => {
    const win = makeWindow();
    loadArchModules(win);
    const payload = featureCollection([point(52.3, 9.7)]);
    const provider = win.UA.AccidentProvider.createStaticProvider({
      fetch: makeFetch({ 'out/output_all_years_hannover.geojson': payload }),
    });

    const result = await provider.fetchForCity('Hannover');
    expect(result.features).toHaveLength(1);
  });

  test('full-city mode does not probe or select the tiled provider', async () => {
    const full = featureCollection([point(52.3, 9.7)]);
    const win = makeWindow({
      fetch: makeFetch({ 'out/output_all_years_hannover.geojson': full }),
    });
    loadArchModules(win);
    loadModule(win, '../../js/ua.data_v2.js');

    const tiled = {
      type: win.UA.AccidentProvider.PROVIDER_TYPES.TILED,
      canProvideForCity: jest.fn(async () => true),
      fetchForCity: jest.fn(),
      fetchForBbox: jest.fn(),
      getCapabilities: jest.fn(),
    };
    win.UA.AccidentProvider.ProviderRegistry.register('tiled', tiled);

    const ctx = {
      CITY_RAW: 'Hannover',
      ui: { dataSourceCode: { textContent: '' } },
    };
    await win.UA.loadCityData(ctx);

    expect(tiled.canProvideForCity).not.toHaveBeenCalled();
    expect(tiled.fetchForBbox).not.toHaveBeenCalled();
    expect(ctx.allPts).toHaveLength(1);
    expect(ctx.accidentDataCoverage.complete).toBe(true);
  });

  test('viewport mode explicitly uses tiled provider and marks partial coverage', async () => {
    const win = makeWindow();
    loadArchModules(win);
    loadModule(win, '../../js/ua.data_v2.js');
    const partial = featureCollection([point(52.3, 9.7)]);
    const bounds = mapBounds();
    const tiled = {
      type: win.UA.AccidentProvider.PROVIDER_TYPES.TILED,
      canProvideForCity: jest.fn(async () => true),
      fetchForCity: jest.fn(),
      fetchForBbox: jest.fn(async () => partial),
      getCapabilities: jest.fn(async () => ({
        tileZoom: 13,
        totalCount: 120,
        sourceFingerprint: 'fingerprint',
      })),
    };
    win.UA.AccidentProvider.ProviderRegistry.register('tiled', tiled);

    const ctx = {
      CITY_RAW: 'Hannover',
      accidentDataMode: 'viewport',
      map: { getBounds: () => bounds },
      ui: { dataSourceCode: { textContent: '' } },
    };
    await win.UA.loadCityData(ctx);

    expect(tiled.fetchForBbox).toHaveBeenCalledWith('Hannover', bounds);
    expect(ctx.allPts).toHaveLength(1);
    expect(ctx.accidentDataCoverage).toEqual(expect.objectContaining({
      complete: false,
      mode: 'viewport-partial',
      sourceTotalCount: 120,
    }));
  });

  test('ProviderRegistry resolves a registered static fallback', () => {
    const win = makeWindow();
    loadArchModules(win);
    const registry = win.UA.AccidentProvider.ProviderRegistry;
    registry.clear();
    const provider = win.UA.AccidentProvider.createStaticProvider();
    registry.register('static', provider);
    expect(registry.resolve('unknowncity')).toBe(provider);
  });
});

describe('Architecture integration: TrafficSituation', () => {
  let UA;

  beforeEach(() => {
    const win = makeWindow();
    loadArchModules(win);
    UA = win.UA;
  });

  test('creates a domain object from ctx and round-trips it', () => {
    const ctx = {
      CITY_RAW: 'hannover',
      allPts: [{ lat: 52.3, lon: 9.7, props: { UKATEGORIE: 1 } }],
      contextCapabilities: { hasSlope: false, hasOsmContext: true },
      filters: {},
      involvementMode: 'or',
    };
    const situation = UA.TrafficSituation.fromCtx(ctx);
    expect(situation.metadata.city).toBe('hannover');
    expect(situation.context.capabilities.hasOsmContext).toBe(true);
    const restored = UA.TrafficSituation.deserialize(
      UA.TrafficSituation.serialize(situation)
    );
    expect(restored.id).toBe(situation.id);
  });

  test('creates a TrafficSituation from a minimal MapScene', () => {
    const situation = UA.TrafficSituation.fromMapScene(
      UA.MapScene.create({ city: 'berlin' })
    );
    expect(situation.metadata.city).toBe('berlin');
  });
});

describe('Architecture integration: AnalysisPipeline and SceneGraph', () => {
  let UA;

  beforeEach(() => {
    const win = makeWindow();
    loadArchModules(win);
    UA = win.UA;
  });

  test('PilotPlugin produces complete statistics with optional viewport data', async () => {
    const accidents = featureCollection([
      point(52.3, 9.7, 1),
      point(52.31, 9.71, 2),
      point(52.32, 9.72, 3),
    ]);
    const dataRegistry = UA.AnalysisPipeline.createDataRegistry({
      accidents,
      viewport: { center: { lat: 52.3, lon: 9.7 }, zoom: 14 },
    });
    const pluginRegistry = UA.AnalysisPipeline.createPluginRegistry([
      UA.PilotPlugin.ACCIDENT_STATISTICS,
    ]);
    const results = await UA.AnalysisPipeline.runPipeline({ dataRegistry, pluginRegistry });
    const result = results.resultMap['accident-statistics'];
    expect(result.status).toBe('complete');
    expect(result.producedArtifacts.accidentStatistics.total).toBe(3);
  });

  test('PilotPlugin marks missing optional viewport data as partial', async () => {
    const dataRegistry = UA.AnalysisPipeline.createDataRegistry({
      accidents: featureCollection([point(52.3, 9.7)]),
    });
    const pluginRegistry = UA.AnalysisPipeline.createPluginRegistry([
      UA.PilotPlugin.ACCIDENT_STATISTICS,
    ]);
    const results = await UA.AnalysisPipeline.runPipeline({ dataRegistry, pluginRegistry });
    expect(results.resultMap['accident-statistics'].status).toBe('partial');
  });

  test('SceneGraph is serializable', () => {
    const situation = UA.TrafficSituation.fromCtx({
      CITY_RAW: 'berlin',
      allPts: [],
      contextCapabilities: {},
      filters: {},
      involvementMode: 'or',
    });
    const graph = UA.SceneGraph.fromTrafficSituation(situation);
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(JSON.parse(JSON.stringify(graph)).id).toBe(graph.id);
  });
});

describe('Architecture integration: export metadata', () => {
  let UA;

  function makeUI() {
    return {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      dayTypeEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      incGkfzEl: { checked: false },
      incSonEl: { checked: false },
    };
  }

  beforeEach(() => {
    const win = makeWindow({
      fetch: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }),
      L: { latLngBounds: () => {} },
    });
    loadArchModules(win);
    for (const file of [
      'ua.utils.js', 'ua.state.js', 'ua.filters.js', 'ua.accident_views.js',
      'ua.stats.js', 'ua.costs.js', 'ua.measures.js', 'ua.context_measures.js',
      'ua.trend.js', 'ua.osm_context.js', 'ua.export_v2.js',
    ]) loadModule(win, `../../js/${file}`);
    UA = win.UA;
  });

  function exportContext(withSituation) {
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
      selectionBounds: mapBounds(),
    };
    if (withSituation) ctx.trafficSituation = UA.TrafficSituation.fromCtx(ctx);
    return ctx;
  }

  test('includes TrafficSituation when available', async () => {
    UA.reverseGeocode = async () => null;
    const result = await UA.computeExportReport(exportContext(true));
    expect(result.structured.meta.trafficSituation.metadata.city).toBe('hannover');
  });

  test('omits TrafficSituation when absent', async () => {
    UA.reverseGeocode = async () => null;
    const result = await UA.computeExportReport(exportContext(false));
    expect(result.structured.meta.trafficSituation).toBeUndefined();
  });
});
