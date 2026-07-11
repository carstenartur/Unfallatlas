'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Module loader helpers
// ---------------------------------------------------------------------------

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA(opts) {
  const win = { UA: {} };
  // ua.core.js provides UA.normKey — load it first so slugification works.
  loadModule('../../js/ua.core.js', win);
  if (opts && opts.skipCore) {
    // Test without normKey to verify the built-in fallback.
    delete win.UA.normKey;
  }
  loadModule('../../js/ua.data_paths.js', win);
  return win.UA;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UA.DataPaths — path construction', () => {
  let UA;

  beforeEach(() => {
    UA = makeUA();
  });

  test('module is exposed on UA.DataPaths', () => {
    expect(UA.DataPaths).toBeDefined();
    expect(typeof UA.DataPaths.accidentGeoJson).toBe('function');
  });

  test('accidentGeoJson: slugifies and constructs path', () => {
    expect(UA.DataPaths.accidentGeoJson('Berlin')).toBe('out/output_all_years_berlin.geojson');
    expect(UA.DataPaths.accidentGeoJson('München')).toBe('out/output_all_years_muenchen.geojson');
    expect(UA.DataPaths.accidentGeoJson('Frankfurt am Main')).toBe('out/output_all_years_frankfurt_am_main.geojson');
  });

  test('poiGeoJson: slugifies and constructs path', () => {
    expect(UA.DataPaths.poiGeoJson('Bonn')).toBe('out/poi_bonn.geojson');
    expect(UA.DataPaths.poiGeoJson('Köln')).toBe('out/poi_koeln.geojson');
  });

  test('contextWays: slugifies and constructs path', () => {
    expect(UA.DataPaths.contextWays('Berlin')).toBe('out/ways_berlin.json');
    expect(UA.DataPaths.contextWays('Düsseldorf')).toBe('out/ways_duesseldorf.json');
  });

  test('enrichmentMeta: slugifies and constructs path', () => {
    expect(UA.DataPaths.enrichmentMeta('Berlin')).toBe(
      'out/output_all_years_berlin.enrichment.meta.json'
    );
  });

  test('contextTileIndex: constructs correct index path', () => {
    expect(UA.DataPaths.contextTileIndex('Berlin')).toBe('out/ctxtiles/berlin/index.json');
  });

  test('contextTile: constructs correct tile path', () => {
    expect(UA.DataPaths.contextTile('Berlin', 13, 4396, 2694)).toBe(
      'out/ctxtiles/berlin/13/4396/2694.json'
    );
  });

  test('accidentTileIndex: constructs correct index path', () => {
    expect(UA.DataPaths.accidentTileIndex('Berlin')).toBe('out/accidenttiles/berlin/index.json');
  });

  test('accidentTile: constructs correct tile path', () => {
    expect(UA.DataPaths.accidentTile('Berlin', 13, 4396, 2694)).toBe(
      'out/accidenttiles/berlin/13/4396/2694.json'
    );
  });
});

describe('UA.DataPaths — fallback without UA.normKey', () => {
  test('works with basic lowercase fallback when normKey is absent', () => {
    const UA = makeUA({ skipCore: true });
    expect(UA.DataPaths.accidentGeoJson('berlin')).toBe('out/output_all_years_berlin.geojson');
  });
});

describe('UA.DataPaths — delegation from ua.data.js', () => {
  test('UA.buildDataUrl delegates to DataPaths.accidentGeoJson', () => {
    const win = { UA: {} };
    loadModule('../../js/ua.core.js', win);
    loadModule('../../js/ua.data_paths.js', win);
    loadModule('../../js/ua.data.js', win);
    expect(win.UA.buildDataUrl('Berlin')).toBe('out/output_all_years_berlin.geojson');
  });
});

describe('UA.DataPaths — delegation from ua.data_v2.js', () => {
  test('UA.buildDataUrl in data_v2 delegates to DataPaths.accidentGeoJson', () => {
    const win = { UA: {} };
    loadModule('../../js/ua.core.js', win);
    loadModule('../../js/ua.data_paths.js', win);
    loadModule('../../js/ua.data_v2.js', win);
    expect(win.UA.buildDataUrl('Köln')).toBe('out/output_all_years_koeln.geojson');
  });

  test('UA.buildPOIUrl in data_v2 delegates to DataPaths.poiGeoJson', () => {
    const win = { UA: {} };
    loadModule('../../js/ua.core.js', win);
    loadModule('../../js/ua.data_paths.js', win);
    loadModule('../../js/ua.data_v2.js', win);
    expect(win.UA.buildPOIUrl('Bonn')).toBe('out/poi_bonn.geojson');
  });
});
