/**
 * Unit tests for ua.measures.js
 */

describe('UA.measures', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

    // Load each script with `window` bound to mockWindow. We MUST NOT use a
    // bare `eval(...)` here — that runs against the global scope and would
    // leak the script's IIFE side-effects across tests (e.g. UA.costs being
    // attached to the *global* window from one test would survive into the
    // next). The Function-constructor approach gives the script a fresh
    // closure with our mockWindow as `window`.
    function loadInWindow(file) {
      const code = fs.readFileSync(path.resolve(__dirname, file), 'utf8');
      const fn = new Function('window', code);
      fn(mockWindow);
    }
    // Load costs first (measures references UA.costs.computeAmortisationYears + formatEUR)
    loadInWindow('../../js/ua.costs.js');
    loadInWindow('../../js/ua.measures.js');
    UA = mockWindow.UA;

    // Reset caches
    if (UA.measures && UA.measures._resetCache) UA.measures._resetCache();
    if (UA.costs && UA.costs._resetCache) UA.costs._resetCache();
  });

  describe('FALLBACK structure', () => {
    test('contains required fields', () => {
      expect(UA.measures.FALLBACK.measures.length).toBeGreaterThan(0);
      const m = UA.measures.FALLBACK.measures[0];
      expect(m.id).toBeDefined();
      expect(m.label).toBeDefined();
      expect(m.costRange).toHaveLength(2);
      expect(m.effect.targetPatterns).toBeDefined();
      expect(m.effect.expectedReductionPct).toHaveLength(2);
      expect(['A','B','C']).toContain(m.effect.evidenceLevel);
    });
  });

  describe('scoreMeasure', () => {
    test('returns 0 for non-overlapping patterns', () => {
      const measure = { effect: { targetPatterns: [5, 17] } };
      const r = UA.measures.scoreMeasure(measure, [1, 6]);
      expect(r.score).toBe(0);
      expect(r.matchedPatterns).toEqual([]);
    });

    test('returns count of matched patterns', () => {
      const measure = { effect: { targetPatterns: [1, 2, 3, 5, 6] } };
      const r = UA.measures.scoreMeasure(measure, [1, 5, 99]);
      expect(r.score).toBe(2);
      expect(r.matchedPatterns).toContain(1);
      expect(r.matchedPatterns).toContain(5);
    });

    test('handles missing/empty targetPatterns', () => {
      expect(UA.measures.scoreMeasure({}, [1]).score).toBe(0);
      expect(UA.measures.scoreMeasure({ effect: {} }, [1]).score).toBe(0);
      expect(UA.measures.scoreMeasure(null, [1]).score).toBe(0);
    });
  });

  describe('mergeCatalogs', () => {
    test('null override returns base unchanged', () => {
      const base = { measures: [{ id: 'a' }] };
      const merged = UA.measures.mergeCatalogs(base, null);
      expect(merged).toBe(base);
    });

    test('override entries replace base entries with same id', () => {
      const base = { measures: [
        { id: 'a', costRange: [100, 200] },
        { id: 'b', costRange: [10, 20] }
      ], sources: [{ title: 'S1', url: 'u1' }] };
      const override = { measures: [
        { id: 'a', costRange: [999, 999] },
        { id: 'c', costRange: [1, 2] }
      ], sources: [{ title: 'S2', url: 'u2' }] };
      const merged = UA.measures.mergeCatalogs(base, override);
      expect(merged.measures).toHaveLength(3);
      const a = merged.measures.find(m => m.id === 'a');
      expect(a.costRange).toEqual([999, 999]); // override wins
      const c = merged.measures.find(m => m.id === 'c');
      expect(c).toBeDefined(); // new id added
      expect(merged.sources).toHaveLength(2); // both source lists merged
    });

    test('deduplicates sources by url+title', () => {
      const base = { measures: [], sources: [{ title: 'S1', url: 'u1' }] };
      const override = { measures: [], sources: [{ title: 'S1', url: 'u1' }, { title: 'S2', url: 'u2' }] };
      const merged = UA.measures.mergeCatalogs(base, override);
      expect(merged.sources).toHaveLength(2);
    });
  });

  describe('recommendMeasures', () => {
    let catalog;
    beforeEach(() => {
      catalog = {
        sources: [{ title: 'TestSource', year: 2024 }],
        disclaimer: 'Testdisclaimer.',
        measures: [
          {
            id: 'tempo_30',
            label: 'Tempo-30-Anordnung',
            costRange: [2000, 8000],
            effect: { targetPatterns: [1, 2, 3, 5, 6], expectedReductionPct: [10, 25], evidenceLevel: 'A' }
          },
          {
            id: 'protected_bike_lane',
            label: 'Geschützter Radfahrstreifen',
            costRange: [80000, 250000],
            effect: { targetPatterns: [5, 17, 21], expectedReductionPct: [30, 50], evidenceLevel: 'B' }
          },
          {
            id: 'mittelinsel',
            label: 'Mittelinsel',
            costRange: [25000, 80000],
            effect: { targetPatterns: [6, 22], expectedReductionPct: [25, 45], evidenceLevel: 'B' }
          },
          {
            id: 'unrelated',
            label: 'Unrelated measure',
            costRange: [1000, 5000],
            effect: { targetPatterns: [99], expectedReductionPct: [10, 20], evidenceLevel: 'C' }
          }
        ]
      };
    });

    test('Maske 5 (Rad+PKW) recommends at least protected_bike_lane and tempo_30', () => {
      const r = UA.measures.recommendMeasures([5], catalog);
      const ids = r.measures.map(x => x.measure.id);
      expect(ids).toContain('protected_bike_lane');
      expect(ids).toContain('tempo_30');
    });

    test('Maske 6 (PKW+Fuß) recommends mittelinsel and tempo_30', () => {
      const r = UA.measures.recommendMeasures([6], catalog);
      const ids = r.measures.map(x => x.measure.id);
      expect(ids).toContain('mittelinsel');
      expect(ids).toContain('tempo_30');
    });

    test('omits measures with score 0', () => {
      const r = UA.measures.recommendMeasures([5], catalog);
      const ids = r.measures.map(x => x.measure.id);
      expect(ids).not.toContain('unrelated');
    });

    test('sorts by score desc then by lower cost asc', () => {
      // Patterns 5 and 17 → tempo_30 score=1 (matches 5), protected_bike_lane score=2 (matches 5,17)
      const r = UA.measures.recommendMeasures([5, 17], catalog);
      // protected_bike_lane should come first (higher score)
      expect(r.measures[0].measure.id).toBe('protected_bike_lane');
      expect(r.measures[1].measure.id).toBe('tempo_30');
    });

    test('respects limit option', () => {
      const r = UA.measures.recommendMeasures([1, 2, 3, 5, 6, 17, 22], catalog, { limit: 2 });
      expect(r.measures.length).toBe(2);
    });

    test('always includes evidenceLevel on each measure', () => {
      const r = UA.measures.recommendMeasures([5], catalog);
      for (const item of r.measures) {
        expect(['A','B','C']).toContain(item.measure.effect.evidenceLevel);
      }
    });

    test('always returns disclaimer in result', () => {
      const r = UA.measures.recommendMeasures([5], catalog);
      expect(r.disclaimer).toBe('Testdisclaimer.');
    });

    test('always returns sources list', () => {
      const r = UA.measures.recommendMeasures([5], catalog);
      expect(r.sources).toEqual(catalog.sources);
    });

    test('attaches amortisation when economicImpact is provided', () => {
      const r = UA.measures.recommendMeasures([6], catalog, {
        economicImpact: { annual: 380000 }
      });
      const mittelinsel = r.measures.find(x => x.measure.id === 'mittelinsel');
      expect(mittelinsel.amortisation).toBeDefined();
      expect(mittelinsel.amortisation.lowYears).toBeGreaterThan(0);
      expect(mittelinsel.amortisation.highYears).toBeGreaterThan(0);
      // best-case (lowYears) should be faster than worst-case (highYears)
      expect(mittelinsel.amortisation.lowYears).toBeLessThanOrEqual(mittelinsel.amortisation.highYears);
    });

    test('does not attach amortisation when no economicImpact', () => {
      const r = UA.measures.recommendMeasures([5], catalog);
      expect(r.measures[0].amortisation).toBeUndefined();
    });

    test('falls back to FALLBACK when catalog is invalid', () => {
      const r = UA.measures.recommendMeasures([1], null);
      expect(r.measures.length).toBeGreaterThan(0);
      expect(r.disclaimer).toBeDefined();
    });
  });

  describe('formatCostRange', () => {
    test('renders simple EUR range with single currency suffix', () => {
      expect(UA.measures.formatCostRange([2000, 8000])).toBe('2.000 – 8.000 €');
    });

    test('returns dash for invalid input', () => {
      expect(UA.measures.formatCostRange(null)).toBe('—');
      expect(UA.measures.formatCostRange([1])).toBe('—');
    });

    test('short format with same Mio. unit on both ends → suffix appears once', () => {
      // Both ends format as "1,5 Mio. €" / "3,0 Mio. €"; collapsed to "1,5 – 3,0 Mio. €".
      const out = UA.measures.formatCostRange([1_500_000, 3_000_000], { short: true });
      expect(out).toBe('1,5 – 3,0 Mio. €');
    });

    test('short format with same Tsd. unit on both ends → suffix appears once', () => {
      const out = UA.measures.formatCostRange([25_000, 80_000], { short: true });
      expect(out).toBe('25 – 80 Tsd. €');
    });

    test('short format with mixed Tsd./Mio. units → both ends keep their unit', () => {
      // Regression guard for review point #5 on PR #221:
      // Previously "80 Tsd." + "1,5 Mio. €" was collapsed to "80 – 1,5 Mio. €",
      // dropping the "Tsd." on the lower bound.
      const out = UA.measures.formatCostRange([80_000, 1_500_000], { short: true });
      expect(out).toBe('80 Tsd. € – 1,5 Mio. €');
    });
  });

  describe('formatReductionRange', () => {
    test('renders percent range', () => {
      expect(UA.measures.formatReductionRange([10, 25])).toBe('10–25 %');
    });

    test('returns dash for invalid input', () => {
      expect(UA.measures.formatReductionRange(null)).toBe('—');
    });
  });

  describe('loadBaseCatalog', () => {
    test('returns FALLBACK when no fetch is available', async () => {
      const data = await UA.measures.loadBaseCatalog();
      expect(data.measures.length).toBeGreaterThan(0);
    });

    test('parses fetched catalog and caches', async () => {
      UA.measures._resetCache();
      let calls = 0;
      const fakeData = {
        version: 2,
        measures: [{ id: 'fake', label: 'Fake', costRange: [1, 2], effect: { targetPatterns: [1], expectedReductionPct: [5, 15], evidenceLevel: 'C' } }]
      };
      global.fetch = async () => { calls++; return { ok: true, json: async () => fakeData }; };
      try {
        const a = await UA.measures.loadBaseCatalog();
        const b = await UA.measures.loadBaseCatalog();
        expect(a).toBe(b);
        expect(a.version).toBe(2);
        expect(calls).toBe(1);
      } finally {
        delete global.fetch;
      }
    });

    test('falls back when fetched data has no measures array', async () => {
      UA.measures._resetCache();
      global.fetch = async () => ({ ok: true, json: async () => ({ version: 1 }) });
      try {
        const data = await UA.measures.loadBaseCatalog();
        expect(data).toBe(UA.measures.FALLBACK);
      } finally {
        delete global.fetch;
      }
    });
  });

  describe('loadCityOverride', () => {
    test('returns null for empty/missing slug', async () => {
      expect(await UA.measures.loadCityOverride()).toBeNull();
      expect(await UA.measures.loadCityOverride("")).toBeNull();
    });

    test('returns null on 404', async () => {
      UA.measures._resetCache();
      global.fetch = async () => ({ ok: false });
      try {
        const r = await UA.measures.loadCityOverride('hannover');
        expect(r).toBeNull();
      } finally {
        delete global.fetch;
      }
    });

    test('returns parsed override when present', async () => {
      UA.measures._resetCache();
      const fakeOverride = {
        version: 1,
        measures: [{ id: 'tempo_30', label: 'Tempo 30 (lokal)', costRange: [3000, 9000], effect: { targetPatterns: [1], expectedReductionPct: [10, 25], evidenceLevel: 'A' } }]
      };
      global.fetch = async () => ({ ok: true, json: async () => fakeOverride });
      try {
        const r = await UA.measures.loadCityOverride('hannover');
        expect(r.measures[0].costRange).toEqual([3000, 9000]);
      } finally {
        delete global.fetch;
      }
    });
  });
});
