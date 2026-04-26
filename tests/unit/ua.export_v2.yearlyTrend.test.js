/**
 * Integration test: `computeExportReport` exposes `structured.yearlyTrend`
 * when UA.trend is present (issue #C2).
 *
 * Mirrors the loader pattern used in ua.export_v2.darkFigureNote.test.js,
 * but additionally loads js/ua.trend.js so the trend helper is available
 * while computeExportReport runs.
 */

describe('UA.computeExportReport – structured.yearlyTrend (#C2)', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const mockWindow = { UA: {}, location: { href: 'http://localhost/' } };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    load('ua.trend.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeBoundsCtx(points) {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: () => true
    };
    UA.reverseGeocode = async () => null;
    // matchesNonInvolvementFilters reads element-like .value/.checked off ctx.ui;
    // provide permissive stubs so all of the supplied points pass the filter.
    const ui = {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      dayTypeEl: { value: 'all' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: true },
      incGkfzEl: { checked: true },
      incSonEl: { checked: true }
    };
    return {
      CITY_RAW: 'Hannover',
      allPts: points,
      selectionBounds: bounds,
      ui,
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
  }

  function pt(year, ukategorie) {
    return {
      lat: 52.25, lon: 9.8,
      props: {
        year: String(year),
        ukategorie: String(ukategorie),
        ustunde: '12',
        uwochentag: '3',
        strzustand: '0',
        IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '0', IstSonstig: '0'
      }
    };
  }

  test('structured.yearlyTrend is populated and matches UA.trend.computeYearlyTrend', async () => {
    // 4-year clearly increasing series → "steigend" classification.
    const points = [];
    const series = [{ y: 2020, n: 4 }, { y: 2021, n: 7 }, { y: 2022, n: 10 }, { y: 2023, n: 13 }];
    for (const { y, n } of series) for (let i = 0; i < n; i++) points.push(pt(y, 3));

    const r = await UA.computeExportReport(makeBoundsCtx(points));
    expect(r.structured).toBeDefined();
    expect(r.structured.yearlyTrend).toBeDefined();
    const t = r.structured.yearlyTrend;
    expect(t.years).toEqual([2020, 2021, 2022, 2023]);
    expect(t.counts.total).toEqual([4, 7, 10, 13]);
    expect(t.classification).toBe('steigend');
    expect(t.slope).toBeGreaterThan(0);
    expect(t.nYears).toBe(4);
  });

  test('text output includes the "Mehrjahres-Trend" section and the classification', async () => {
    const points = [];
    for (const y of [2020, 2021, 2022, 2023]) for (let i = 0; i < 5; i++) points.push(pt(y, 3));
    const r = await UA.computeExportReport(makeBoundsCtx(points));
    expect(r.text).toContain('Mehrjahres-Trend');
    // Must contain the classification keyword (one of the four allowed values).
    expect(r.text).toMatch(/Klassifikation:\s*(rückläufig|stagnierend|steigend|unbestimmt)/);
  });

  test('html output includes the trend SVG when there are at least 2 years', async () => {
    const points = [];
    for (const y of [2020, 2021, 2022]) for (let i = 0; i < 3; i++) points.push(pt(y, 3));
    const r = await UA.computeExportReport(makeBoundsCtx(points));
    expect(r.html).toMatch(/Mehrjahres-Trend/);
    // SVG line is an optional bonbon — assert it's present in the rendered HTML.
    expect(r.html).toMatch(/<svg/);
  });
});
