/**
 * Integration test: UA.computeExportReport must wire the prioritization
 * block (Goldstandard-Sektion 8) into structured.prioritization, so that
 * DOCX/PDF/AI consumers see the same Kurz / Mittel / Lang buckets that
 * the TEXT/HTML renderers print.
 */

describe('UA.computeExportReport – structured.prioritization (Goldstandard-Sektion 8)', () => {
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
    load('ua.measures.js');

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

  test('structured.prioritization is null when measures toggle is off', async () => {
    UA.reverseGeocode = async () => null;
    const ctx = {
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: makeBounds(),
      ui: makeUI(),
      // includeMeasures:false → recommendedMeasures is null → prioritization is null
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
    const r = await UA.computeExportReport(ctx);
    expect(r.structured.prioritization).toBeNull();
  });

  test('structured.prioritization shape mirrors buildPrioritization when measures present', async () => {
    UA.reverseGeocode = async () => null;
    const ctx = {
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: makeBounds(),
      ui: makeUI(),
      exportOptions: { includeCosts: false, includeMeasures: true }
    };
    const r = await UA.computeExportReport(ctx);
    // Empty input → recommendedMeasures has empty .measures[] but exists,
    // so prioritization is an empty-buckets object, not null.
    if (r.structured.recommendedMeasures) {
      expect(r.structured.prioritization).not.toBeNull();
      expect(r.structured.prioritization).toHaveProperty('kurzfristig');
      expect(r.structured.prioritization).toHaveProperty('mittelfristig');
      expect(r.structured.prioritization).toHaveProperty('langfristig');
      expect(r.structured.prioritization.meta.totals.all).toBe(0);
    } else {
      // If the catalog couldn't load at all (offline), prioritization is null.
      expect(r.structured.prioritization).toBeNull();
    }
  });

  test('text + html contain Priorisierung section when prioritization has entries', async () => {
    UA.reverseGeocode = async () => null;
    // Stub loadCatalog with a synthetic catalog that targets the [Rad] pattern (mask=1).
    UA.measures.loadCatalog = async () => ({
      version: 1,
      sources: [],
      disclaimer: 'Test-Disclaimer',
      measures: [
        { id: 'a', label: 'Sicht freischneiden', leadTime: '1–3 Monate',   costRange: [500, 2000],  perUnit: 'Standort', effect: { targetPatterns: [1], expectedReductionPct: [10, 20], evidenceLevel: 'B' }, description: 'Test', considerations: [] },
        { id: 'b', label: 'Querungshilfe',       leadTime: '3–9 Monate',   costRange: [5000, 20000], perUnit: 'Standort', effect: { targetPatterns: [1], expectedReductionPct: [15, 30], evidenceLevel: 'B' }, description: 'Test', considerations: [] },
        { id: 'c', label: 'Knotenpunktumbau',    leadTime: '18–36 Monate', costRange: [200000, 800000], perUnit: 'Knoten', effect: { targetPatterns: [1], expectedReductionPct: [25, 50], evidenceLevel: 'B' }, description: 'Test', considerations: [] }
      ]
    });

    // ≥30 bike-only points in-bounds + a few mixed-mode comparators so that
    // [Rad] becomes overrepresented and dev.focus picks up the mask.
    const inBoundsBike = Array.from({ length: 40 }, (_, i) => ({
      lat: 52.10 + (i % 5) * 0.001,
      lon: 9.75 + (i % 7) * 0.001,
      props: { ukategorie: '3', IstRad: '1', year: 2020 + (i % 3), ustunde: String(8 + (i % 12)) }
    }));
    const inBoundsCar = Array.from({ length: 5 }, (_, i) => ({
      lat: 52.20 + i * 0.001,
      lon: 9.80 + i * 0.001,
      props: { ukategorie: '3', IstPKW: '1', year: 2021, ustunde: '12' }
    }));
    // City-wide reference (out-of-bounds) — heavily car-dominated so [Rad]
    // is overrepresented locally.
    const cityCar = Array.from({ length: 200 }, (_, i) => ({
      lat: 60.00 + i * 0.0001, lon: 9.80 + i * 0.0001,
      props: { ukategorie: '3', IstPKW: '1', year: 2021, ustunde: '12' }
    }));

    const ctx = {
      CITY_RAW: 'Hannover',
      allPts: [...inBoundsBike, ...inBoundsCar, ...cityCar],
      selectionBounds: makeBounds(),
      ui: makeUI(),
      exportOptions: { includeCosts: false, includeMeasures: true }
    };
    const r = await UA.computeExportReport(ctx);

    expect(r.structured.prioritization).not.toBeNull();
    expect(r.structured.prioritization.meta.totals.all).toBeGreaterThanOrEqual(1);

    // Mandated headings appear in TEXT and HTML output.
    expect(r.text).toContain('Priorisierung (Umsetzungshorizont):');
    expect(r.text).toContain('Kurzfristig (0–3 Monate)');
    expect(r.text).toContain('Mittelfristig (3–12 Monate)');
    expect(r.text).toContain('Langfristig (>12 Monate)');

    expect(r.html).toContain('Priorisierung (Umsetzungshorizont)');
    expect(r.html).toContain('Kurzfristig (0–3 Monate)');
    expect(r.html).toContain('Mittelfristig (3–12 Monate)');
    // The HTML escaper turns ">" into "&gt;", so the long-term heading is
    // emitted as "Langfristig (&gt;12 Monate)". This is correct (escaped
    // output) — assert the escaped form.
    expect(r.html).toContain('Langfristig (&gt;12 Monate)');
  });

  test('empty bucket is rendered with explicit "keine Maßnahmen" placeholder (avoids "only long-term" misperception)', async () => {
    UA.reverseGeocode = async () => null;
    // Catalog: only short-term measure → mittel/lang buckets stay empty.
    UA.measures.loadCatalog = async () => ({
      version: 1,
      sources: [],
      disclaimer: 'Test',
      measures: [
        { id: 'only_short', label: 'Nur kurzfristig', leadTime: '1–3 Monate', costRange: [500, 2000], perUnit: 'Standort', effect: { targetPatterns: [1], expectedReductionPct: [10, 20], evidenceLevel: 'B' }, description: 'Test', considerations: [] }
      ]
    });

    const inBoundsBike = Array.from({ length: 40 }, (_, i) => ({
      lat: 52.10 + (i % 5) * 0.001,
      lon: 9.75 + (i % 7) * 0.001,
      props: { ukategorie: '3', IstRad: '1', year: 2020 + (i % 3), ustunde: String(8 + (i % 12)) }
    }));
    const cityCar = Array.from({ length: 200 }, (_, i) => ({
      lat: 60.00 + i * 0.0001, lon: 9.80 + i * 0.0001,
      props: { ukategorie: '3', IstPKW: '1', year: 2021, ustunde: '12' }
    }));

    const ctx = {
      CITY_RAW: 'Hannover',
      allPts: [...inBoundsBike, ...cityCar],
      selectionBounds: makeBounds(),
      ui: makeUI(),
      exportOptions: { includeCosts: false, includeMeasures: true }
    };
    const r = await UA.computeExportReport(ctx);
    expect(r.structured.prioritization).not.toBeNull();
    expect(r.structured.prioritization.kurzfristig).toHaveLength(1);
    expect(r.structured.prioritization.mittelfristig).toHaveLength(0);
    expect(r.structured.prioritization.langfristig).toHaveLength(0);

    expect(r.text).toContain('Mittelfristig (3–12 Monate): — keine Maßnahmen in diesem Horizont —');
    expect(r.text).toContain('Langfristig (>12 Monate): — keine Maßnahmen in diesem Horizont —');
    expect(r.html).toContain('keine Maßnahmen in diesem Horizont');
  });
});
