/**
 * Integration test: `computeExportReport` exposes `structured.heatmap`
 * when UA.heatmap is loaded (issue #A2).
 *
 * Also verifies the modal toggle: `exportOptions.includeHeatmap === false`
 * suppresses both the structured payload and the rendered HTML/text panels.
 */

describe('UA.computeExportReport – structured.heatmap (#A2)', () => {
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
    load('ua.heatmap.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function pt(hour, weekday) {
    return {
      lat: 52.25, lon: 9.8,
      props: {
        year: '2022',
        ukategorie: '3',
        ustunde: String(hour),
        uwochentag: String(weekday),
        strzustand: '0',
        IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '0', IstSonstig: '0'
      }
    };
  }

  function makeCtx(points, opts) {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw, getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }), contains: () => true
    };
    UA.reverseGeocode = async () => null;
    const ui = {
      severityEl: { value: 'all' }, roadConditionEl: { value: 'all' },
      hFromEl: { value: '0' }, hToEl: { value: '23' }, dayTypeEl: { value: 'all' },
      incBikeEl: { checked: true }, incPedEl: { checked: true }, incCarEl: { checked: true },
      incMotoEl: { checked: true }, incGkfzEl: { checked: true }, incSonEl: { checked: true }
    };
    return {
      CITY_RAW: 'Hannover',
      allPts: points,
      selectionBounds: bounds,
      ui,
      exportOptions: Object.assign({ includeCosts: false, includeMeasures: false }, opts || {})
    };
  }

  test('structured.heatmap is populated and matches direct computeHourDaytypeMatrix output', async () => {
    const points = [pt(8, 1), pt(8, 1), pt(8, 6), pt(20, 7)];
    const r = await UA.computeExportReport(makeCtx(points));
    expect(r.structured.heatmap).toBeDefined();
    const hm = r.structured.heatmap;
    expect(hm.total).toBe(4);
    expect(hm.matrix[8]).toEqual([2, 1]);
    expect(hm.matrix[20]).toEqual([0, 1]);
    expect(hm.colTotals).toEqual([2, 2]);
  });

  test('text and html outputs include the heatmap section when there are matching points', async () => {
    const points = [pt(8, 1), pt(8, 1), pt(8, 6), pt(20, 7)];
    const r = await UA.computeExportReport(makeCtx(points));
    expect(r.text).toContain('Stunden-Heatmap');
    expect(r.text).toMatch(/Spitzenstunden Mo–Fr/);
    expect(r.html).toContain('Stunden-Heatmap');
    // SVG present (cells + labels)
    expect(r.html).toMatch(/<svg /);
  });

  test('exportOptions.includeHeatmap=false suppresses the heatmap entirely', async () => {
    const points = [pt(8, 1), pt(8, 6)];
    const r = await UA.computeExportReport(makeCtx(points, { includeHeatmap: false }));
    expect(r.structured.heatmap).toBeNull();
    expect(r.text).not.toContain('Stunden-Heatmap');
    // The HTML should not contain the heatmap heading either.
    expect(r.html).not.toContain('Stunden-Heatmap');
  });

  test('empty point set: heatmap.total=0 and HTML/text don\'t render the panel', async () => {
    const r = await UA.computeExportReport(makeCtx([]));
    expect(r.structured.heatmap).toBeDefined();
    expect(r.structured.heatmap.total).toBe(0);
    expect(r.text).not.toContain('Stunden-Heatmap');
    expect(r.html).not.toContain('Stunden-Heatmap');
  });
});
