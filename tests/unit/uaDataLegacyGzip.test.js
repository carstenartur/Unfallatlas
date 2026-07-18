'use strict';

const fs = require('fs');
const path = require('path');

function evaluate(relPath, win) {
  const source = fs.readFileSync(path.resolve(__dirname, relPath), 'utf8');
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
}

function loadLegacyDataModule() {
  const win = { UA: {}, document: { querySelector: () => null } };
  evaluate('../../js/ua.core.js', win);
  evaluate('../../js/ua.data_paths.js', win);
  evaluate('../../js/ua.data.js', win);
  return win.UA;
}

describe('js/ua.data.js central resource compatibility', () => {
  test('loads the canonical accident resource through DataResources', async () => {
    const UA = loadLegacyDataModule();
    const payload = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [7.1, 50.7] },
        properties: { id: '1' },
      }],
    };
    UA.fetchJsonCompressed = jest.fn(async () => payload);

    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } } };
    await UA.loadCityData(ctx);

    expect(UA.fetchJsonCompressed).toHaveBeenCalledWith(
      'out/output_all_years_bonn.geojson',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(ctx.allPts).toHaveLength(1);
    expect(ctx.DATA_URL).toBe('out/output_all_years_bonn.geojson');
  });

  test('surfaces central transport errors with city-data context', async () => {
    const UA = loadLegacyDataModule();
    UA.fetchJsonCompressed = jest.fn(async () => {
      throw new Error('gzip decompression unavailable');
    });
    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } } };
    await expect(UA.loadCityData(ctx)).rejects.toThrow(
      /GeoJSON konnte nicht geladen werden:.*gzip decompression unavailable/
    );
  });
});