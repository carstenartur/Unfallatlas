'use strict';

const fs = require('fs');
const path = require('path');

function load(win, relativePath) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../js', relativePath), 'utf8');
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
}

function featureCollection(id = 'full') {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [7.1, 50.73] },
      properties: { id },
    }],
  };
}

function makeWindow(search = '') {
  const win = {
    UA: {},
    location: {
      href: `http://localhost/werkbank_v2.html${search}`,
      search,
      replace: jest.fn(),
    },
    history: { replaceState: jest.fn() },
  };
  load(win, 'ua.core.js');
  load(win, 'ua.utils.js');
  win.UA.fetchJsonCompressed = jest.fn(async () => featureCollection('full'));
  win.UA.fetchJsonGz = jest.fn(async () => null);
  load(win, 'ua.state.js');
  load(win, 'ua.data_paths.js');
  load(win, 'ua.accident_provider.js');
  load(win, 'ua.data_v2.js');
  return win;
}

function bounds() {
  return {
    getSouth: () => 50.72,
    getWest: () => 7.08,
    getNorth: () => 50.74,
    getEast: () => 7.12,
  };
}

function ctx() {
  return {
    CITY_RAW: 'Bonn',
    map: { getBounds: bounds },
    ui: { dataSourceCode: { textContent: '' } },
  };
}

describe('accidentDataMode viewport pilot', () => {
  test('full city remains the default even when a tiled provider is registered', async () => {
    const win = makeWindow();
    const tiled = {
      type: win.UA.AccidentProvider.PROVIDER_TYPES.TILED,
      fetchForCity: jest.fn(),
      fetchForBbox: jest.fn(),
      getCapabilities: jest.fn(),
      canProvideForCity: jest.fn(async () => true),
    };
    win.UA.AccidentProvider.ProviderRegistry.register('tiled', tiled);

    const context = ctx();
    await win.UA.loadCityData(context);

    expect(tiled.fetchForBbox).not.toHaveBeenCalled();
    expect(context.allPts[0].props.id).toBe('full');
    expect(context.accidentDataMode).toBe('full');
    expect(context.accidentDataCoverage).toEqual(expect.objectContaining({
      mode: 'full-city', complete: true, provider: 'static', loadedFeatureCount: 1,
    }));
    expect(context.DATA_URL).toBe('out/output_all_years_bonn.geojson');
  });

  test('viewport mode loads only the current map bounds through tiled provider', async () => {
    const win = makeWindow('?city=Bonn&accidentDataMode=viewport');
    const viewportData = featureCollection('viewport');
    const tiled = {
      type: win.UA.AccidentProvider.PROVIDER_TYPES.TILED,
      fetchForCity: jest.fn(),
      fetchForBbox: jest.fn(async () => viewportData),
      getCapabilities: jest.fn(async () => ({
        supportsTiles: true,
        tileZoom: 13,
        totalCount: 500,
        sourceFingerprint: 'sha256-test',
      })),
      canProvideForCity: jest.fn(async () => true),
    };
    win.UA.AccidentProvider.ProviderRegistry.register('tiled', tiled);

    const context = ctx();
    await win.UA.loadCityData(context);

    expect(tiled.fetchForBbox).toHaveBeenCalledWith('Bonn', context.map.getBounds());
    expect(tiled.fetchForCity).not.toHaveBeenCalled();
    expect(context.allPts[0].props.id).toBe('viewport');
    expect(context.accidentDataCoverage).toEqual(expect.objectContaining({
      mode: 'viewport-partial',
      complete: false,
      provider: 'tiled',
      tileZoom: 13,
      sourceTotalCount: 500,
      sourceFingerprint: 'sha256-test',
      loadedFeatureCount: 1,
      bounds: { south: 50.72, west: 7.08, north: 50.74, east: 7.12 },
    }));
    expect(context.DATA_URL).toBe('out/accidenttiles/bonn/index.json');
    expect(context.ui.dataSourceCode.textContent).toMatch(/nur aktueller Kartenausschnitt/);
  });

  test('viewport mode falls back cleanly when the manifest is unavailable', async () => {
    const win = makeWindow('?accidentDataMode=viewport');
    const tiled = {
      type: win.UA.AccidentProvider.PROVIDER_TYPES.TILED,
      fetchForCity: jest.fn(),
      fetchForBbox: jest.fn(),
      getCapabilities: jest.fn(),
      canProvideForCity: jest.fn(async () => false),
    };
    win.UA.AccidentProvider.ProviderRegistry.register('tiled', tiled);

    const context = ctx();
    await win.UA.loadCityData(context);

    expect(tiled.fetchForBbox).not.toHaveBeenCalled();
    expect(context.accidentDataCoverage).toEqual(expect.objectContaining({
      mode: 'full-city',
      complete: true,
      fallbackReason: 'accident tile manifest unavailable',
    }));
  });

  test('URL cleaner treats accidentDataMode as canonical', () => {
    const win = makeWindow('?city=Bonn&accidentDataMode=viewport');
    expect(win.UA.cleanUrlIfNeeded()).toBe(false);
    expect(win.location.replace).not.toHaveBeenCalled();
  });
});
