/**
 * Bonn-Regression-Fixture-Test (PR 3 / Spec-Item 11).
 *
 * Treibt UA.computeExportReport gegen ein synthetisches Bonner Datenset
 * (`tests/fixtures/bonn-regression.json`, 20 Punkte über 2019–2023) und
 * prüft die Invarianten, die die Ursache der ursprünglichen QA-Klage
 * waren — und durch PR 1 + PR 2 jetzt deterministisch gehalten werden:
 *
 *   1. structured.totalAccidents matched die Punktzahl im Ausschnitt.
 *   2. structured.yearTable enthält Einträge für jedes vertretene Jahr.
 *   3. structured.meta.activeFilterScope / patternAnalysisScope /
 *      baselineScope sind gesetzt (PR 2-Vertrag).
 *   4. structured.methodikScope hat title + 3 Zeilen.
 *   5. UA.validateExportConsistency liefert ok:true für die so erzeugte
 *      structured (Pre-Flight-Gate würde diesen Export NICHT abbrechen).
 *
 * Der Test dient als Regression-Anker: jede künftige Änderung am Export-
 * Pipeline (computeExportReport / validateExportConsistency) muss diese
 * Akzeptanzbedingungen weiter erfüllen.
 */

const fs = require('fs');
const path = require('path');

describe('Bonn-Regression-Fixture (PR 3)', () => {
  let UA;
  let report;
  let fixture;

  beforeAll(async () => {
    fixture = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../fixtures/bonn-regression.json'),
      'utf8'
    ));

    const mockWindow = { UA: {} };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      // eslint-disable-next-line no-eval
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    mockWindow.location = { href: 'http://localhost/?city=Bonn' };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
    UA.reverseGeocode = async () => ({ label: 'Bonn-Bad Godesberg' });

    const sw = { lat: fixture.bounds.south, lng: fixture.bounds.west };
    const ne = { lat: fixture.bounds.north, lng: fixture.bounds.east };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: (sw.lat + ne.lat) / 2, lng: (sw.lng + ne.lng) / 2 }),
      contains: (latlng) => {
        const [la, lo] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
        return la >= sw.lat && la <= ne.lat && lo >= sw.lng && lo <= ne.lng;
      }
    };

    const ctx = {
      CITY_RAW: fixture.city,
      allPts: fixture.points,
      selectionBounds: bounds,
      ui: {
        severityEl: { value: 'all' },
        roadConditionEl: { value: 'all' },
        dayTypeEl: { value: 'all' },
        hFromEl: { value: '0' },
        hToEl: { value: '23' },
        incBikeEl: { checked: true },
        incPedEl: { checked: true },
        incCarEl: { checked: true },
        incMotoEl: { checked: true },
        incGkfzEl: { checked: true },
        incSonEl: { checked: true }
      },
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
    report = await UA.computeExportReport(ctx);
  });

  test('totalAccidents covers all 20 in-bounds Bonn points', () => {
    expect(report.structured.totalAccidents).toBe(20);
    expect(report.structured.severity.total).toBe(20);
  });

  test('yearTable carries one row per year between 2019 and 2023', () => {
    expect(Array.isArray(report.structured.yearTable)).toBe(true);
    const years = report.structured.yearTable.map(r => Number(r.year)).sort();
    expect(years).toEqual([2019, 2020, 2021, 2022, 2023]);
  });

  test('meta exposes activeFilterScope / patternAnalysisScope / baselineScope', () => {
    const meta = report.structured.meta;
    expect(meta.activeFilterScope).toBeDefined();
    expect(meta.activeFilterScope.bounds).toMatch(/50\.\d+,7\.\d+ – 50\.\d+,7\.\d+/);
    expect(meta.patternAnalysisScope).toBeDefined();
    expect(meta.patternAnalysisScope.basis).toMatch(/Beteiligungsmaske > 0/);
    expect(meta.baselineScope).toBeDefined();
    expect(meta.baselineScope.city).toBe('Bonn');
  });

  test('methodikScope has title + 3 scope lines', () => {
    const ms = report.structured.methodikScope;
    expect(ms).toBeDefined();
    expect(typeof ms.title).toBe('string');
    expect(ms.lines).toHaveLength(3);
    // Bonn appears in the baseline sentence.
    expect(ms.lines[2]).toMatch(/Bonn/);
    // Bonn-Bad Godesberg surfaces in the active-filter scope sentence.
    expect(ms.lines[0]).toMatch(/Bonn-Bad Godesberg/);
  });

  test('validateExportConsistency accepts the report (pre-flight passes)', () => {
    // Re-load report renderer to access UA.validateExportConsistency.
    const reportFn = require('fs').readFileSync(
      path.resolve(__dirname, '../../js/ua.report_v2.js'),
      'utf8'
    );
    const w = {};
    w.UA = UA;
    w.docx = require('docx');
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    pdfMakeLib.vfs = require('pdfmake/build/vfs_fonts');
    w.pdfMake = pdfMakeLib;
    w.saveAs = () => {};
    // eslint-disable-next-line no-eval
    (function (window) { eval(reportFn); })(w);

    const ctx = { viewportPts: fixture.points };
    const r = w.UA.validateExportConsistency(ctx, report.structured);
    expect(r.ok).toBe(true);
  });
});
