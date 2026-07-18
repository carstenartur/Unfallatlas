'use strict';

const fs = require('fs');
const path = require('path');

function evaluate(win, relative) {
  const source = fs.readFileSync(path.resolve(__dirname, relative), 'utf8');
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
}

function loadDataModule(options) {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  if (!options || options.idle !== false) win.requestIdleCallback = callback => callback();
  evaluate(win, '../../js/ua.core.js');
  evaluate(win, '../../js/ua.data_paths.js');
  if (!options || options.context !== false) evaluate(win, '../../js/ua.context_layers.js');
  evaluate(win, '../../js/ua.data_v2.js');
  return win.UA;
}

function point(properties) {
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [7.1, 50.7] },
    properties: properties || {},
  };
}

function featureCollection(features, properties) {
  const result = { type: 'FeatureCollection', features };
  if (properties) result.properties = properties;
  return result;
}

function installCompressedFixtures(UA, fixtures) {
  UA.fetchJsonCompressed = jest.fn(async url => {
    for (const [suffix, value] of Object.entries(fixtures)) {
      if (url.endsWith(suffix)) {
        if (value instanceof Error) throw value;
        if (typeof value === 'function') return value();
        return value;
      }
    }
    throw new Error(`missing fixture: ${url}`);
  });
}

async function flush() {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('UA.extractPoints enrichment compatibility', () => {
  test('parses old and enriched FeatureCollections identically', () => {
    const UA = loadDataModule({ context: false });
    const plain = featureCollection([
      point({ id: '1', ukategorie: '2' }),
      point({ id: '2', ukategorie: '3' }),
    ]);
    expect(UA.extractPoints(plain)).toHaveLength(2);

    const enriched = featureCollection([
      point({
        id: '1',
        ukategorie: '2',
        matched_way_id: 'W1',
        elevation_m: 123.5,
        slope_class: 'steep',
        traffic_proxy_class: 'high',
      }),
    ], { enrichmentDicts: { highway: ['residential'] } });
    const result = UA.extractPoints(enriched);
    expect(result).toHaveLength(1);
    expect(result[0].props.elevation_m).toBe(123.5);
    expect(result[0].props.matched_way_id).toBe('W1');
  });

  test('drops invalid or non-point geometries', () => {
    const UA = loadDataModule({ context: false });
    const result = UA.extractPoints(featureCollection([
      point({ id: 'valid' }),
      { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: { id: 'line' } },
      { type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 'y'] }, properties: { id: 'bad' } },
      { type: 'Feature', geometry: null, properties: { id: 'null' } },
    ]));
    expect(result.map(item => item.props.id)).toEqual(['valid']);
  });

  test('URL builders are registry-backed', () => {
    const UA = loadDataModule({ context: false });
    expect(UA.buildDataUrl('Bonn')).toBe('out/output_all_years_bonn.geojson');
    expect(UA.buildPOIUrl('Köln')).toBe('out/poi_koeln.geojson');
  });
});

describe('UA.loadCityData context wiring', () => {
  test('loads accidents and context companions through central resources', async () => {
    const UA = loadDataModule();
    const geojson = featureCollection([
      point({ id: '1', matched_way_id: 'W1', elevation_m: 1 }),
    ], { enrichmentDicts: { highway: ['residential'] } });
    const ways = { W1: { highway: 0, maxspeed: 30 } };
    installCompressedFixtures(UA, {
      'output_all_years_bonn.geojson': geojson,
      'ways_bonn.json': ways,
      'output_all_years_bonn.enrichment.meta.json': new Error('optional'),
    });

    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } } };
    await UA.loadCityData(ctx);
    await flush();

    expect(ctx.allPts).toHaveLength(1);
    expect(ctx.contextCapabilities.hasOsmContext).toBe(true);
    expect(ctx.contextLayerState.ways).toEqual(ways);
    expect(ctx.contextLayerState.dicts).toEqual({ highway: ['residential'] });
    expect(UA.fetchJsonCompressed).toHaveBeenCalledWith(
      'out/output_all_years_bonn.geojson',
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  test('does not request context companions when no context fields exist', async () => {
    const UA = loadDataModule();
    const geojson = featureCollection([point({ id: '1', ukategorie: '2' })]);
    installCompressedFixtures(UA, { 'output_all_years_bonn.geojson': geojson });

    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } } };
    await UA.loadCityData(ctx);
    await flush();

    expect(ctx.contextCapabilities.hasOsmContext).toBe(false);
    expect(ctx.contextLayerState).toBeNull();
    expect(UA.fetchJsonCompressed.mock.calls.map(call => call[0]).filter(url => url.includes('ways_')))
      .toHaveLength(0);
  });

  test('does not let a late previous-city context response overwrite the new city', async () => {
    const UA = loadDataModule();
    const geojson = featureCollection([point({ id: '1', matched_way_id: 'W1' })]);
    let resolveWays;
    UA.fetchJsonCompressed = jest.fn(async url => {
      if (url.endsWith('output_all_years_bonn.geojson')) return geojson;
      if (url.endsWith('ways_bonn.json')) {
        return new Promise(resolve => { resolveWays = () => resolve({ W1: { highway: 0 } }); });
      }
      throw new Error('optional');
    });

    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } } };
    await UA.loadCityData(ctx);
    ctx.CITY_RAW = 'Köln';
    resolveWays();
    await flush();
    expect(ctx.contextLayerState).toBeNull();
  });

  test('re-renders an existing marker layer after context hydration', async () => {
    const UA = loadDataModule();
    const geojson = featureCollection([point({ id: '1', matched_way_id: 'W1' })]);
    installCompressedFixtures(UA, {
      'output_all_years_bonn.geojson': geojson,
      'ways_bonn.json': { W1: { highway: 0 } },
      'output_all_years_bonn.enrichment.meta.json': new Error('optional'),
    });
    UA.renderLayers = jest.fn();

    const ctx = {
      CITY_RAW: 'Bonn',
      ui: { dataSourceCode: { textContent: '' } },
      map: {},
      clusterLayer: {},
    };
    await UA.loadCityData(ctx);
    await flush();
    expect(UA.renderLayers).toHaveBeenCalled();
    expect(ctx._dataChanged).toBe(true);
  });

  test('skips the hydration re-render before any marker layer exists', async () => {
    const UA = loadDataModule();
    const geojson = featureCollection([point({ id: '1', matched_way_id: 'W1' })]);
    installCompressedFixtures(UA, {
      'output_all_years_bonn.geojson': geojson,
      'ways_bonn.json': { W1: { highway: 0 } },
      'output_all_years_bonn.enrichment.meta.json': new Error('optional'),
    });
    UA.renderLayers = jest.fn();

    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } }, map: {} };
    await UA.loadCityData(ctx);
    await flush();
    expect(UA.renderLayers).not.toHaveBeenCalled();
    expect(ctx.contextLayerState).toBeTruthy();
  });
});

describe('UA.loadPOIData', () => {
  test('loads optional POIs through DataResources and degrades to null', async () => {
    const UA = loadDataModule({ context: false });
    const poi = featureCollection([point({ name: 'Schule' })]);
    installCompressedFixtures(UA, { 'poi_bonn.geojson': poi });
    const ctx = { CITY_RAW: 'Bonn' };
    await UA.loadPOIData(ctx);
    expect(ctx.poiData).toBe(poi);

    const missingUA = loadDataModule({ context: false });
    missingCompressedResources = undefined;
    missingUA.fetchJsonCompressed = jest.fn(async () => { throw new Error('missing'); });
    const missingCtx = { CITY_RAW: 'Bonn' };
    await missingUA.loadPOIData(missingCtx);
    expect(missingCtx.poiData).toBeNull();
  });
});