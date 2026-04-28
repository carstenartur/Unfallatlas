/**
 * Tests for Goldstandard Items 5–6:
 *   1. structured.recommendedMeasures.measures[i].derivedFrom is populated
 *      with [{mask,label}] entries derived from matchedPatterns + dev.focus
 *      labels (so the renderer can show "Abgeleitet aus: …" without re-doing
 *      the lookup).
 *   2. UA.buildCausesMeasuresSection() exposes `measureRefs` (1-based
 *      indices into recommendedMeasures.measures[]) so the URSACHEN-block
 *      can cross-reference into the EMPFOHLENE-MASSNAHMEN-list instead of
 *      stutter-repeating the labels.
 *   3. TEXT/HTML/DOCX/PDF renderers print "#N (Label)" and
 *      "Abgeleitet aus: …" lines.
 *
 * Backward-compat must hold: when no recommendedMeasures are available
 * (toggle off, fallback path), the URSACHEN-block keeps the old
 * label-only format.
 */

describe('UA.buildCausesMeasuresSection – measureRefs cross-reference (Items 5–6)', () => {
  let UA;

  beforeAll(() => {
    window.UA = {};
    const fs = require('fs');
    const path = require('path');
    // Need utils + filters for COMBO_LABEL/formatInvolvementCombo, plus the
    // export module itself to expose UA.buildCausesMeasuresSection.
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      // eslint-disable-next-line no-eval
      eval(fs.readFileSync(p, 'utf8'));
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    load('ua.measures.js');
    window.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    window.location = { href: 'http://localhost/?city=Hannover' };
    load('ua.export_v2.js');
    UA = window.UA;
  });

  afterAll(() => {
    delete window.UA;
    delete window.fetch;
    delete window.location;
  });

  test('returns measureRefs with 1-based idx + label when recommendedMeasures matches via targetPatterns', () => {
    const focus = [
      { mask: 1, textLabel: '[Rad allein]' },
      { mask: 5, textLabel: '[Rad+PKW]' }
    ];
    const rm = {
      measures: [
        { measure: { id: 'a', label: 'Tempo 30',          effect: { targetPatterns: [1, 5] } }, score: 2, matchedPatterns: [1, 5] },
        { measure: { id: 'b', label: 'Querungshilfe',     effect: { targetPatterns: [5]    } }, score: 1, matchedPatterns: [5] },
        { measure: { id: 'c', label: 'Sicht freischneiden', effect: { targetPatterns: [1]  } }, score: 1, matchedPatterns: [1] }
      ]
    };
    const result = UA.buildCausesMeasuresSection(focus, rm);
    expect(result).toHaveLength(2);

    // [Rad allein] → matches measures #1 (Tempo 30) and #3 (Sicht freischneiden)
    expect(result[0].cause).toBe('[Rad allein]');
    expect(result[0].mask).toBe(1);
    expect(result[0].measureRefs).toEqual([
      { idx: 1, label: 'Tempo 30' },
      { idx: 3, label: 'Sicht freischneiden' }
    ]);
    expect(result[0].measures).toEqual(['Tempo 30', 'Sicht freischneiden']);

    // [Rad+PKW] → matches measures #1 (Tempo 30) and #2 (Querungshilfe)
    expect(result[1].cause).toBe('[Rad+PKW]');
    expect(result[1].mask).toBe(5);
    expect(result[1].measureRefs).toEqual([
      { idx: 1, label: 'Tempo 30' },
      { idx: 2, label: 'Querungshilfe' }
    ]);
  });

  test('measureRefs is empty when no recommendedMeasures match a cause (fallback path)', () => {
    const focus = [{ mask: 999, textLabel: '[Unknown]' }];
    const rm = {
      measures: [
        { measure: { id: 'a', label: 'Tempo 30', effect: { targetPatterns: [1] } }, score: 1, matchedPatterns: [1] }
      ]
    };
    const result = UA.buildCausesMeasuresSection(focus, rm);
    expect(result[0].measureRefs).toEqual([]);
    // measures[] retains the safe "no specific catalog match" placeholder
    // (CAUSE_MEASURE_FALLBACK has no entry for mask=999).
    expect(result[0].measures.length).toBeGreaterThan(0);
  });

  test('measureRefs is empty when recommendedMeasures is null (Backward-compat: toggle off)', () => {
    const focus = [{ mask: 1, textLabel: '[Rad allein]' }];
    const result = UA.buildCausesMeasuresSection(focus, null);
    expect(result[0].measureRefs).toEqual([]);
    // Falls back to label-based measures from CAUSE_MEASURE_FALLBACK[1]
    // or the generic "no specific catalog match" placeholder.
    expect(Array.isArray(result[0].measures)).toBe(true);
    expect(result[0].measures.length).toBeGreaterThan(0);
  });

  test('measureRefs caps at 3 entries (matches measures[].slice cap)', () => {
    const focus = [{ mask: 1, textLabel: '[Rad allein]' }];
    const rm = {
      measures: Array.from({ length: 5 }, (_, i) => ({
        measure: { id: `m${i}`, label: `M${i}`, effect: { targetPatterns: [1] } },
        score: 1,
        matchedPatterns: [1]
      }))
    };
    const result = UA.buildCausesMeasuresSection(focus, rm);
    expect(result[0].measureRefs).toHaveLength(3);
    expect(result[0].measureRefs.map(e => e.idx)).toEqual([1, 2, 3]);
  });
});

describe('UA.computeExportReport – derivedFrom enrichment + cross-reference rendering', () => {
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

  function buildCtxAndCatalog() {
    UA.reverseGeocode = async () => null;
    // Catalog with target pattern = 1 (Rad allein, see ua.filters.js).
    UA.measures.loadCatalog = async () => ({
      version: 1,
      sources: [],
      disclaimer: 'Test',
      measures: [
        { id: 'a', label: 'Sicht freischneiden', leadTime: '1–3 Monate',
          costRange: [500, 2000], perUnit: 'Standort',
          effect: { targetPatterns: [1], expectedReductionPct: [10, 20], evidenceLevel: 'B' },
          description: 'Test', considerations: [] },
        { id: 'b', label: 'Querungshilfe', leadTime: '3–9 Monate',
          costRange: [5000, 20000], perUnit: 'Standort',
          effect: { targetPatterns: [1], expectedReductionPct: [15, 30], evidenceLevel: 'B' },
          description: 'Test', considerations: [] }
      ]
    });

    // ≥30 bike-only points in-bounds + city-wide car baseline so [Rad] is
    // overrepresented locally and dev.focus picks up mask=1.
    const inBoundsBike = Array.from({ length: 40 }, (_, i) => ({
      lat: 52.10 + (i % 5) * 0.001,
      lon: 9.75 + (i % 7) * 0.001,
      props: { ukategorie: '3', IstRad: '1', year: 2020 + (i % 3), ustunde: String(8 + (i % 12)) }
    }));
    const cityCar = Array.from({ length: 200 }, (_, i) => ({
      lat: 60.00 + i * 0.0001, lon: 9.80 + i * 0.0001,
      props: { ukategorie: '3', IstPKW: '1', year: 2021, ustunde: '12' }
    }));

    return {
      CITY_RAW: 'Hannover',
      allPts: [...inBoundsBike, ...cityCar],
      selectionBounds: makeBounds(),
      ui: makeUI(),
      exportOptions: { includeCosts: false, includeMeasures: true }
    };
  }

  test('structured.recommendedMeasures.measures[i].derivedFrom is populated', async () => {
    const r = await UA.computeExportReport(buildCtxAndCatalog());
    expect(r.structured.recommendedMeasures).toBeTruthy();
    expect(r.structured.recommendedMeasures.measures.length).toBeGreaterThan(0);
    for (const item of r.structured.recommendedMeasures.measures) {
      expect(Array.isArray(item.derivedFrom)).toBe(true);
      expect(item.derivedFrom.length).toBeGreaterThan(0);
      // Every entry has {mask:number,label:string}.
      for (const d of item.derivedFrom) {
        expect(typeof d.mask).toBe('number');
        expect(typeof d.label).toBe('string');
        expect(d.label.length).toBeGreaterThan(0);
      }
    }
  });

  test('TEXT output contains "Abgeleitet aus auffälligem Muster:" and "#N (Label)" cross-refs', async () => {
    const r = await UA.computeExportReport(buildCtxAndCatalog());
    // Ursachen-block uses #N reference instead of full label repetition.
    expect(r.text).toMatch(/URSACHEN UND MASSNAHMEN \(kurz\):/);
    expect(r.text).toMatch(/#1 \(Sicht freischneiden\)/);
    // Empfohlene Maßnahmen-block surfaces the derivedFrom line.
    expect(r.text).toMatch(/Abgeleitet aus auffälligem Muster:/);
  });

  test('HTML output contains "<strong>#N</strong>" cross-refs and "Abgeleitet aus:" line', async () => {
    const r = await UA.computeExportReport(buildCtxAndCatalog());
    expect(r.html).toContain('<strong>#1</strong>');
    expect(r.html).toContain('Abgeleitet aus:');
    // Heading switched to "(siehe Liste unten)" to make the cross-ref explicit.
    expect(r.html).toContain('Empfohlene Maßnahmen (siehe Liste unten)');
  });

  test('structured.causesMeasures rows carry measureRefs with non-empty entries', async () => {
    const r = await UA.computeExportReport(buildCtxAndCatalog());
    expect(Array.isArray(r.structured.causesMeasures)).toBe(true);
    expect(r.structured.causesMeasures.length).toBeGreaterThan(0);
    const row = r.structured.causesMeasures[0];
    expect(Array.isArray(row.measureRefs)).toBe(true);
    expect(row.measureRefs.length).toBeGreaterThan(0);
    expect(row.measureRefs[0]).toHaveProperty('idx');
    expect(row.measureRefs[0]).toHaveProperty('label');
  });
});
