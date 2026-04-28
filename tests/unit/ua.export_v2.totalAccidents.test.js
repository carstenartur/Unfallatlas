/**
 * Unit test for structured.totalAccidents (Phase 2.2 des PDF/DOCX-
 * Sanierungsplans). Diese kanonische Fallzahl wird vom Pre-Flight-Konsistenz-
 * Gate (UA.validateExportConsistency) gegen die in den Karten gerenderten
 * Punkte geprüft. Sie muss grundsätzlich existieren und mit severity.total
 * übereinstimmen, damit Tabellen und Karten gegen denselben Wert validiert
 * werden.
 */

describe('UA.computeExportReport – structured.totalAccidents (Phase 2.2)', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

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
    mockWindow.location = { href: 'http://localhost/?city=Hannover' };

    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeBounds() {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    return {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: (latlng) => {
        const [la, lo] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
        return la >= sw.lat && la <= ne.lat && lo >= sw.lng && lo <= ne.lng;
      }
    };
  }

  function makeUI() {
    // Minimal UI stub to satisfy UA.matchesNonInvolvementFilters/InvolvementFilter.
    return {
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
    };
  }

  test('totalAccidents exists and equals severity.total on empty input', async () => {
    UA.reverseGeocode = async () => null;
    const ctx = {
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: makeBounds(),
      ui: makeUI(),
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
    const r = await UA.computeExportReport(ctx);
    expect(r.structured.totalAccidents).toBe(0);
    expect(r.structured.totalAccidents).toBe(r.structured.severity.total);
  });

  test('totalAccidents reflects in-bounds, filter-passing point count', async () => {
    UA.reverseGeocode = async () => null;
    // 3 in-bounds, 1 out-of-bounds. ustunde must be parseable for the filter to pass.
    const allPts = [
      { lat: 52.10, lon: 9.75, props: { ukategorie: '3', IstRad: '1', year: 2020, ustunde: '8' } },
      { lat: 52.20, lon: 9.80, props: { ukategorie: '2', IstPKW: '1', year: 2021, ustunde: '12' } },
      { lat: 52.30, lon: 9.85, props: { ukategorie: '3', IstFuss: '1', year: 2022, ustunde: '17' } },
      { lat: 60.00, lon: 9.80, props: { ukategorie: '3', IstRad: '1', year: 2023, ustunde: '9' } } // out
    ];
    const ctx = {
      CITY_RAW: 'Hannover',
      allPts,
      selectionBounds: makeBounds(),
      ui: makeUI(),
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
    const r = await UA.computeExportReport(ctx);
    expect(r.structured.totalAccidents).toBe(3);
    expect(r.structured.totalAccidents).toBe(r.structured.severity.total);
  });
});
