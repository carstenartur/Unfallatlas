'use strict';

const fs = require('fs');
const path = require('path');

function loadModule(win) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../js/ua.accident_coverage.js'),
    'utf8'
  );
  (function (window) { eval(source); })(win); // eslint-disable-line no-eval
  return win.UA;
}

function partial() {
  return {
    accidentDataCoverage: {
      mode: 'viewport-partial',
      complete: false,
      loadedFeatureCount: 12,
      sourceTotalCount: 500,
    },
  };
}

describe('accident coverage export guard', () => {
  test('allows full-city and legacy contexts', () => {
    const UA = loadModule({ UA: {} });
    expect(UA.assertCompleteAccidentCoverage({
      accidentDataCoverage: { complete: true },
    })).toBe(true);
    expect(UA.assertCompleteAccidentCoverage({})).toBe(true);
  });

  test('rejects partial coverage with actionable counts', () => {
    const UA = loadModule({ UA: {} });
    expect(() => UA.assertCompleteAccidentCoverage(partial(), 'Datenexport'))
      .toThrow(/12 von 500.*accidentDataMode=viewport/);
  });

  test('wraps export functions that already exist', async () => {
    const compute = jest.fn(async () => ({ ok: true }));
    const csv = jest.fn();
    const win = { UA: { computeExportReport: compute, exportToCSV: csv } };
    const UA = loadModule(win);

    await expect(UA.computeExportReport({ accidentDataCoverage: { complete: true } }))
      .resolves.toEqual({ ok: true });
    expect(() => UA.exportToCSV(partial())).toThrow(/Unfall-Tile-Pilotmodus/);
    expect(csv).not.toHaveBeenCalled();
  });

  test('guards export functions assigned after the module loads', () => {
    const win = { UA: {} };
    const UA = loadModule(win);
    const original = jest.fn(async () => 'report');
    UA.computeExportReport = original;

    expect(() => UA.computeExportReport(partial()))
      .toThrow(/Berichtsexport ist im Unfall-Tile-Pilotmodus/);
    expect(original).not.toHaveBeenCalled();
  });
});
