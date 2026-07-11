'use strict';

const fs = require('fs');
const path = require('path');

function loadLegacyDataModule(win) {
  const filePath = path.resolve(__dirname, '../../js/ua.data.js');
  (function (window) { eval(fs.readFileSync(filePath, 'utf8')); })(win); // eslint-disable-line no-eval
  return win.UA;
}

describe('js/ua.data.js gzip compatibility', () => {
  test('uses UA.fetchJsonCompressed when available', async () => {
    const win = { UA: {}, document: { querySelector: () => null } };
    win.UA.normKey = (s) => String(s || '').toLowerCase();
    const UA = loadLegacyDataModule(win);

    const payload = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] }, properties: { id: '1' } }],
    };

    const calls = [];
    UA.fetchJsonCompressed = async (url) => {
      calls.push(url);
      return payload;
    };

    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } } };
    await UA.loadCityData(ctx);

    expect(calls).toEqual(['out/output_all_years_bonn.geojson']);
    expect(ctx.allPts).toHaveLength(1);
    expect(ctx.DATA_URL).toBe('out/output_all_years_bonn.geojson');
  });

  test('throws a clear message in gzip-only mode when UA.fetchJsonCompressed is unavailable', async () => {
    const win = {
      UA: {},
      document: {
        querySelector: () => ({ getAttribute: () => 'gzip-only' }),
      },
    };
    win.UA.normKey = (s) => String(s || '').toLowerCase();
    const UA = loadLegacyDataModule(win);

    const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: '' } } };
    await expect(UA.loadCityData(ctx)).rejects.toThrow(
      'Daten konnten nicht geladen werden: gzip-Daten konnten nicht dekomprimiert werden. Bitte modernen Browser verwenden oder Deployment prüfen.'
    );
  });
});
