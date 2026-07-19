'use strict';

const fs = require('fs');
const path = require('path');

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA(opts) {
  const win = { UA: {} };
  loadModule('../../js/ua.core.js', win);
  if (opts && opts.skipCore) delete win.UA.normKey;
  loadModule('../../js/ua.data_paths.js', win);
  return win.UA;
}

describe('UA.DataResources — central static resource contract', () => {
  let UA;

  beforeEach(() => {
    UA = makeUA();
  });

  test('exposes one registry for path and loading policy', () => {
    expect(UA.DataResources).toBeDefined();
    expect(typeof UA.DataResources.resolve).toBe('function');
    expect(typeof UA.DataResources.fetchJson).toBe('function');
    expect(UA.DataPaths).toBeDefined();
  });

  test('constructs canonical city resources', () => {
    expect(UA.DataResources.url('accidentGeoJson', { city: 'München' }))
      .toBe('out/output_all_years_muenchen.geojson');
    expect(UA.DataResources.url('poiGeoJson', { city: 'Köln' }))
      .toBe('out/poi_koeln.geojson');
    expect(UA.DataResources.url('contextWays', { city: 'Düsseldorf' }))
      .toBe('out/ways_duesseldorf.json');
    expect(UA.DataResources.url('enrichmentMeta', { city: 'Berlin' }))
      .toBe('out/output_all_years_berlin.enrichment.meta.json');
    expect(UA.DataResources.url('contextTileIndex', { city: 'Berlin' }))
      .toBe('out/ctxtiles/berlin/index.json');
  });

  test('context schema v3 uses city/x/y without a duplicate zoom directory', () => {
    expect(UA.DataResources.url('contextTile', { city: 'Berlin', x: 4396, y: 2694 }))
      .toBe('out/ctxtiles/berlin/4396/2694.json');
    expect(UA.DataPaths.contextTile('Berlin', 13, 4396, 2694))
      .toBe('out/ctxtiles/berlin/4396/2694.json');
    expect(UA.DataPaths.contextTile('Berlin', 4396, 2694))
      .toBe('out/ctxtiles/berlin/4396/2694.json');
  });

  test('context tiles are unconditionally gzip-only', async () => {
    const payload = { ways: { W1: {} }, geometries: { W1: [50, 7, 50.1, 7.1] } };
    UA.fetchJsonGz = jest.fn(async () => payload);
    const rawFetch = jest.fn();

    const result = await UA.DataResources.fetchJson('contextTile', {
      city: 'Bonn', x: 4256, y: 2754,
    }, { fetch: rawFetch });

    expect(result).toBe(payload);
    expect(UA.fetchJsonGz).toHaveBeenCalledWith(
      'out/ctxtiles/bonn/4256/2754.json.gz',
      expect.objectContaining({ fetch: rawFetch, cache: 'force-cache' })
    );
    expect(rawFetch).not.toHaveBeenCalled();
  });

  test('accident manifest and payload are unconditionally gzip-only', async () => {
    const manifest = { schemaVersion: 2, city: 'bonn', z: 13, tiles: [] };
    const tile = { type: 'FeatureCollection', features: [] };
    UA.fetchJsonGz = jest.fn(async url => url.endsWith('/index.json.gz') ? manifest : tile);
    const rawFetch = jest.fn();

    await expect(UA.DataResources.fetchJson('accidentTileIndex', {
      city: 'Bonn',
    }, { fetch: rawFetch })).resolves.toBe(manifest);
    await expect(UA.DataResources.fetchJson('accidentTile', {
      city: 'Bonn', z: 13, x: 4256, y: 2754,
    }, { fetch: rawFetch })).resolves.toBe(tile);

    expect(UA.fetchJsonGz.mock.calls.map(call => call[0])).toEqual([
      'out/accidenttiles/bonn/index.json.gz',
      'out/accidenttiles/bonn/13/4256/2754.json.gz',
    ]);
    expect(rawFetch).not.toHaveBeenCalled();
  });

  test('unknown resources and invalid tile coordinates fail early', () => {
    expect(() => UA.DataResources.url('unknown', {})).toThrow(/unknown resource kind/);
    expect(() => UA.DataResources.url('contextTile', { city: 'Bonn', x: '../x', y: 1 }))
      .toThrow(/x must be a non-negative integer/);
    expect(() => UA.DataResources.url('accidentTile', {
      city: 'Bonn', z: 13, x: -1, y: 1,
    })).toThrow(/x must be a non-negative integer/);
  });

  test('accident tile path retains its z/x/y pyramid', () => {
    expect(UA.DataResources.url('accidentTile', {
      city: 'Berlin', z: 13, x: 4396, y: 2694,
    })).toBe('out/accidenttiles/berlin/13/4396/2694.json');
  });
});

describe('UA.DataPaths — compatibility facade', () => {
  test('returns exactly the registry URLs for every legacy method', () => {
    const UA = makeUA();

    expect(UA.DataPaths.accidentGeoJson('Berlin'))
      .toBe(UA.DataResources.url('accidentGeoJson', { city: 'Berlin' }));
    expect(UA.DataPaths.poiGeoJson('Bonn'))
      .toBe(UA.DataResources.url('poiGeoJson', { city: 'Bonn' }));
    expect(UA.DataPaths.contextWays('Berlin'))
      .toBe(UA.DataResources.url('contextWays', { city: 'Berlin' }));
    expect(UA.DataPaths.enrichmentMeta('Berlin'))
      .toBe(UA.DataResources.url('enrichmentMeta', { city: 'Berlin' }));
    expect(UA.DataPaths.contextTileIndex('Berlin'))
      .toBe(UA.DataResources.url('contextTileIndex', { city: 'Berlin' }));
    expect(UA.DataPaths.accidentTileIndex('Berlin'))
      .toBe(UA.DataResources.url('accidentTileIndex', { city: 'Berlin' }));
  });

  test('works with basic lowercase fallback when normKey is absent', () => {
    const UA = makeUA({ skipCore: true });
    expect(UA.DataPaths.accidentGeoJson('berlin'))
      .toBe('out/output_all_years_berlin.geojson');
  });
});

describe('legacy loaders still receive canonical URLs', () => {
  test('ua.data.js delegates to the compatibility facade', () => {
    const win = { UA: {} };
    loadModule('../../js/ua.core.js', win);
    loadModule('../../js/ua.data_paths.js', win);
    loadModule('../../js/ua.data.js', win);
    expect(win.UA.buildDataUrl('Berlin')).toBe('out/output_all_years_berlin.geojson');
  });

  test('ua.data_v2.js delegates accident and POI paths', () => {
    const win = { UA: {} };
    loadModule('../../js/ua.core.js', win);
    loadModule('../../js/ua.data_paths.js', win);
    loadModule('../../js/ua.data_v2.js', win);
    expect(win.UA.buildDataUrl('Köln')).toBe('out/output_all_years_koeln.geojson');
    expect(win.UA.buildPOIUrl('Bonn')).toBe('out/poi_bonn.geojson');
  });
});
