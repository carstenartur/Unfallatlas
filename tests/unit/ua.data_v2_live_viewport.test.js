'use strict';

const fs = require('fs');
const path = require('path');

function load(file, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js', file), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function featureCollection(id) {
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [7.1, 50.73] },
      properties: { id },
    }],
  };
}

function makeWindow(optionalControllerPromise, tiled) {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  load('ua.core.js', win);
  win.UA.fetchJsonCompressed = jest.fn(async () => featureCollection('full'));
  win.UA.fetchJsonGz = jest.fn();
  load('ua.data_paths.js', win);
  win.UA.optionalModulePromises = {
    accidentViewportController: optionalControllerPromise,
  };
  win.UA.AccidentProvider = {
    PROVIDER_TYPES: { CUSTOM: 'custom', TILED: 'tiled' },
    ProviderRegistry: {
      get(name) { return name === 'tiled' ? tiled : null; },
    },
  };
  load('ua.data_v2.js', win);
  return win;
}

const BOUNDS = {
  getSouth: () => 50.72,
  getWest: () => 7.08,
  getNorth: () => 50.74,
  getEast: () => 7.12,
};

describe('ua.data_v2 live viewport bootstrap', () => {
  test('waits for the optional controller module before the initial viewport request', async () => {
    const moduleGate = deferred();
    const tiled = {
      fetchForBbox: jest.fn(),
      fetchTileSetForBbox: jest.fn(),
      canProvideForCity: jest.fn(async () => true),
    };
    const win = makeWindow(moduleGate.promise, tiled);
    const create = jest.fn(() => {
      const coverage = Object.freeze({
        mode: 'viewport-partial',
        complete: false,
        viewportComplete: true,
        status: 'complete-for-viewport',
        provider: 'tiled',
        city: 'bonn',
        loadedFeatureCount: 1,
      });
      return {
        load: jest.fn(async () => ({
          committed: true,
          geojson: featureCollection('tiled'),
          coverage,
        })),
        getSnapshot: jest.fn(() => ({
          coverage: Object.freeze({
            mode: 'viewport-partial',
            complete: false,
            status: 'loading',
            loadedFeatureCount: 0,
          }),
        })),
      };
    });
    const ctx = {
      CITY_RAW: 'Bonn',
      accidentDataMode: 'viewport',
      map: { getBounds: () => BOUNDS },
      ui: { dataSourceCode: { textContent: '' } },
    };

    const pending = win.UA.loadCityData(ctx);
    await Promise.resolve();
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();

    win.UA.AccidentViewportController = { create };
    moduleGate.resolve(true);
    await pending;

    expect(create).toHaveBeenCalledWith({ provider: tiled });
    expect(tiled.fetchForBbox).not.toHaveBeenCalled();
    expect(ctx.allPts.map(point => point.props.id)).toEqual(['tiled']);
    expect(ctx.accidentDataCoverage).toEqual(expect.objectContaining({
      status: 'complete-for-viewport',
      complete: false,
      viewportComplete: true,
    }));
    expect(ctx.ui.dataSourceCode.textContent)
      .toContain('Kartenausschnitt vollständig; Stadt unvollständig');
  });

  test('full-city loading does not wait for or probe the viewport controller', async () => {
    const never = new Promise(() => {});
    const tiled = {
      fetchForBbox: jest.fn(),
      fetchTileSetForBbox: jest.fn(),
      canProvideForCity: jest.fn(),
    };
    const win = makeWindow(never, tiled);
    const ctx = {
      CITY_RAW: 'Bonn',
      accidentDataMode: 'full',
      ui: { dataSourceCode: { textContent: '' } },
    };

    await win.UA.loadCityData(ctx);

    expect(tiled.canProvideForCity).not.toHaveBeenCalled();
    expect(ctx.allPts.map(point => point.props.id)).toEqual(['full']);
    expect(ctx.accidentDataCoverage.complete).toBe(true);
  });
});
