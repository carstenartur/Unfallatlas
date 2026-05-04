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

    test('passesContextSuppression: drops measures whose suppressInContexts hits the active context', () => {
      // QA-Spec Item 7: „Sichtbeziehungen herstellen / Bewuchs zurückschneiden"
      // ist im Bahnhofs-/Schienen-Umfeld unpassend und muss unterdrückt werden.
      const c = {
        sources: [],
        disclaimer: 'd',
        measures: [
          {
            id: 'sicht_freischnitt',
            label: 'Sichtbeziehungen herstellen (Bewuchs/Parken)',
            costRange: [1000, 10000],
            effect: { targetPatterns: [1], expectedReductionPct: [5, 20], evidenceLevel: 'B' },
            prerequisites: {
              suppressInContexts: ['bahnhof', 'busbahnhof', 'straßenbahn_schienen'],
              requireContexts: ['sichtbehinderung', 'bewuchs']
            }
          },
          {
            id: 'tempo_30',
            label: 'Tempo-30-Anordnung',
            costRange: [2000, 8000],
            effect: { targetPatterns: [1], expectedReductionPct: [10, 25], evidenceLevel: 'A' }
          }
        ]
      };
      const r = UA.measures.recommendMeasures([1], c, {
        activeContexts: new Set(['bahnhof', 'straßenbahn_schienen'])
      });
      const labels = r.measures.map(m => m.measure.label);
      expect(labels).not.toContain('Sichtbeziehungen herstellen (Bewuchs/Parken)');
      expect(labels).toContain('Tempo-30-Anordnung');
      // Filtered-out trace contains the suppressed measure with a Kontext-Reason.
      expect(r.filteredOut.some(f => f.id === 'sicht_freischnitt' && /Ortskontext|bahnhof/i.test(f.reason))).toBe(true);
    });

    test('passesContextSuppression: requireContexts whitelist keeps the measure when explicit Sicht-Hinweis is set', () => {
      const c = {
        sources: [], disclaimer: 'd',
        measures: [{
          id: 'sicht_freischnitt',
          label: 'Sicht',
          costRange: [1, 2],
          effect: { targetPatterns: [1], expectedReductionPct: [5, 20], evidenceLevel: 'B' },
          prerequisites: {
            suppressInContexts: ['bahnhof'],
            requireContexts: ['sichtbehinderung']
          }
        }]
      };
      const r = UA.measures.recommendMeasures([1], c, {
        activeContexts: new Set(['bahnhof', 'sichtbehinderung'])
      });
      expect(r.measures.length).toBe(1);
    });

    test('passesContextSuppression: no-op when activeContexts is empty / null', () => {
      const c = {
        sources: [], disclaimer: 'd',
        measures: [{
          id: 'sicht_freischnitt',
          label: 'Sicht',
          costRange: [1, 2],
          effect: { targetPatterns: [1], expectedReductionPct: [5, 20], evidenceLevel: 'B' },
          prerequisites: { suppressInContexts: ['bahnhof'] }
        }]
      };
      expect(UA.measures.recommendMeasures([1], c, {}).measures.length).toBe(1);
      expect(UA.measures.recommendMeasures([1], c, { activeContexts: new Set() }).measures.length).toBe(1);
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

  describe('passesPrerequisites (OSM-Kontext-Filter)', () => {
    const baseMeasure = (prerequisites) => ({
      id: 'm', label: 'M',
      effect: { targetPatterns: [1], expectedReductionPct: [10, 25], evidenceLevel: 'A' },
      prerequisites
    });

    test('no prerequisites → always ok', () => {
      const m = { id: 'm', label: 'M', effect: { targetPatterns: [1], expectedReductionPct: [10, 25], evidenceLevel: 'A' } };
      expect(UA.measures.passesPrerequisites(m, null).ok).toBe(true);
      expect(UA.measures.passesPrerequisites(m, { summary: { dominantMaxspeed: 50 } }).ok).toBe(true);
    });

    test('missing osmContext → defensive pass-through (do not suppress on missing data)', () => {
      const m = baseMeasure({ currentSpeedLimitGt: 30 });
      expect(UA.measures.passesPrerequisites(m, null).ok).toBe(true);
      expect(UA.measures.passesPrerequisites(m, {}).ok).toBe(true);
      expect(UA.measures.passesPrerequisites(m, { summary: null }).ok).toBe(true);
    });

    test('currentSpeedLimitGt: suppress when dominant limit ≤ threshold', () => {
      const m = baseMeasure({ currentSpeedLimitGt: 30 });
      const r = UA.measures.passesPrerequisites(m, { summary: { dominantMaxspeed: 30, speedSampleSize: 5 } });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/30/);
    });

    test('currentSpeedLimitGt: pass when dominant limit > threshold', () => {
      const m = baseMeasure({ currentSpeedLimitGt: 30 });
      expect(UA.measures.passesPrerequisites(m, { summary: { dominantMaxspeed: 50, speedSampleSize: 5 } }).ok).toBe(true);
    });

    test('currentSpeedLimitGt: pass when dominant limit unknown (null)', () => {
      const m = baseMeasure({ currentSpeedLimitGt: 30 });
      expect(UA.measures.passesPrerequisites(m, { summary: { dominantMaxspeed: null, speedSampleSize: 0 } }).ok).toBe(true);
    });

    test('minLaneWidthM: suppress when avgWidth below threshold (with samples)', () => {
      const m = baseMeasure({ minLaneWidthM: 7.5 });
      const r = UA.measures.passesPrerequisites(m, { summary: { avgWidthMeters: 6.0, widthSampleSize: 4 } });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/7\.5/);
    });

    test('minLaneWidthM: pass when avgWidth ≥ threshold', () => {
      const m = baseMeasure({ minLaneWidthM: 7.5 });
      expect(UA.measures.passesPrerequisites(m, { summary: { avgWidthMeters: 7.6, widthSampleSize: 3 } }).ok).toBe(true);
    });

    test('minLaneWidthM: pass when no width samples available', () => {
      const m = baseMeasure({ minLaneWidthM: 7.5 });
      expect(UA.measures.passesPrerequisites(m, { summary: { avgWidthMeters: null, widthSampleSize: 0 } }).ok).toBe(true);
    });

    test('noExistingBikeInfra: suppress when cycleInfraShare ≥ 0.30', () => {
      const m = baseMeasure({ noExistingBikeInfra: true });
      const r = UA.measures.passesPrerequisites(m, { summary: { cycleInfraShare: 0.9 } });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Radinfrastruktur/);
    });

    test('noExistingBikeInfra: pass when cycleInfraShare = 0', () => {
      const m = baseMeasure({ noExistingBikeInfra: true });
      expect(UA.measures.passesPrerequisites(m, { summary: { cycleInfraShare: 0 } }).ok).toBe(true);
    });

    test('noExistingBikeInfra: pass when cycleInfraShare unknown (null)', () => {
      const m = baseMeasure({ noExistingBikeInfra: true });
      expect(UA.measures.passesPrerequisites(m, { summary: { cycleInfraShare: null } }).ok).toBe(true);
    });

    test('minTrafficSignals: suppress when trafficSignals below threshold', () => {
      const m = baseMeasure({ minTrafficSignals: 1 });
      const r = UA.measures.passesPrerequisites(m, { summary: { trafficSignals: 0 } });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/signalisierte/);
    });

    test('minTrafficSignals: pass when trafficSignals ≥ threshold', () => {
      const m = baseMeasure({ minTrafficSignals: 1 });
      expect(UA.measures.passesPrerequisites(m, { summary: { trafficSignals: 1 } }).ok).toBe(true);
      expect(UA.measures.passesPrerequisites(m, { summary: { trafficSignals: 5 } }).ok).toBe(true);
    });

    test('minTrafficSignals: pass defensively when trafficSignals field is missing', () => {
      // The OSM fetcher always populates trafficSignals as an integer (0 when
      // none found), so the "unknown" case is an entirely missing field — the
      // prerequisite must then pass-through (no false negatives, mirrors
      // speed/width). `null` is treated as 0 by `Number(null)`, which matches
      // the "known: keine signalisierten Knoten" semantics documented inline.
      const m = baseMeasure({ minTrafficSignals: 1 });
      expect(UA.measures.passesPrerequisites(m, { summary: {} }).ok).toBe(true);
      expect(UA.measures.passesPrerequisites(m, { summary: { trafficSignals: undefined } }).ok).toBe(true);
    });

    test('maxCrossings: suppress when crossings above threshold', () => {
      const m = baseMeasure({ maxCrossings: 0 });
      const r = UA.measures.passesPrerequisites(m, { summary: { crossings: 2 } });
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/Querungen/);
    });

    test('maxCrossings: pass when crossings ≤ threshold', () => {
      const m = baseMeasure({ maxCrossings: 0 });
      expect(UA.measures.passesPrerequisites(m, { summary: { crossings: 0 } }).ok).toBe(true);
      const m2 = baseMeasure({ maxCrossings: 3 });
      expect(UA.measures.passesPrerequisites(m2, { summary: { crossings: 3 } }).ok).toBe(true);
    });

    test('maxCrossings: pass defensively when crossings field is missing', () => {
      // OSM fetcher always populates crossings as integer (0 when none); the
      // "unknown" case is a missing field. `Number(null)===0` would actually
      // suppress (n=0 ≤ threshold ⇒ pass for max-style); but for the missing
      // case we must absolutely not suppress.
      const m = baseMeasure({ maxCrossings: 0 });
      expect(UA.measures.passesPrerequisites(m, { summary: {} }).ok).toBe(true);
      expect(UA.measures.passesPrerequisites(m, { summary: { crossings: undefined } }).ok).toBe(true);
    });
  });

  describe('recommendMeasures with osmContext (PR-γ prerequisites)', () => {
    // Minimaler Test-Katalog mit drei Maßnahmen, jede mit eigenen prerequisites,
    // sodass die OSM-gesteuerte Filterung deterministisch beobachtbar ist.
    const TEST_CATALOG = {
      version: 1,
      sources: [],
      disclaimer: 'test',
      measures: [
        {
          id: 'tempo_30', label: 'Tempo 30', costRange: [2000, 8000],
          effect: { targetPatterns: [5], expectedReductionPct: [10, 25], evidenceLevel: 'A' },
          prerequisites: { currentSpeedLimitGt: 30 }
        },
        {
          id: 'mittelinsel', label: 'Mittelinsel', costRange: [25000, 80000],
          effect: { targetPatterns: [6], expectedReductionPct: [25, 45], evidenceLevel: 'B' },
          prerequisites: { minLaneWidthM: 7.5 }
        },
        {
          id: 'protected_bike_lane', label: 'PBL', costRange: [80000, 250000],
          effect: { targetPatterns: [5], expectedReductionPct: [30, 50], evidenceLevel: 'B' },
          prerequisites: { noExistingBikeInfra: true }
        }
      ]
    };

    test('Maske 5 + bikeInfraShare = 0 → PBL empfohlen', () => {
      const r = UA.measures.recommendMeasures([5], TEST_CATALOG, {
        osmContext: { summary: { cycleInfraShare: 0, dominantMaxspeed: 50, speedSampleSize: 3 } }
      });
      const ids = r.measures.map(m => m.measure.id);
      expect(ids).toContain('protected_bike_lane');
    });

    test('Maske 5 + bikeInfraShare = 0.9 → PBL NICHT empfohlen, in filteredOut', () => {
      const r = UA.measures.recommendMeasures([5], TEST_CATALOG, {
        osmContext: { summary: { cycleInfraShare: 0.9, dominantMaxspeed: 50, speedSampleSize: 3 } }
      });
      const ids = r.measures.map(m => m.measure.id);
      expect(ids).not.toContain('protected_bike_lane');
      expect(r.filteredOut.find(f => f.id === 'protected_bike_lane')).toBeDefined();
    });

    test('Maske 6 + Fahrbahnbreite < 7,50 m → Mittelinsel NICHT empfohlen', () => {
      const r = UA.measures.recommendMeasures([6], TEST_CATALOG, {
        osmContext: { summary: { avgWidthMeters: 5.5, widthSampleSize: 4 } }
      });
      const ids = r.measures.map(m => m.measure.id);
      expect(ids).not.toContain('mittelinsel');
      expect(r.filteredOut.find(f => f.id === 'mittelinsel')).toBeDefined();
    });

    test('Maske 5 + dominantMaxspeed = 30 → Tempo 30 NICHT empfohlen', () => {
      const r = UA.measures.recommendMeasures([5], TEST_CATALOG, {
        osmContext: { summary: { dominantMaxspeed: 30, speedSampleSize: 5, cycleInfraShare: 0 } }
      });
      const ids = r.measures.map(m => m.measure.id);
      expect(ids).not.toContain('tempo_30');
      expect(r.filteredOut.find(f => f.id === 'tempo_30')).toBeDefined();
    });

    test('Maske 5 + dominantMaxspeed = 50 → Tempo 30 empfohlen', () => {
      const r = UA.measures.recommendMeasures([5], TEST_CATALOG, {
        osmContext: { summary: { dominantMaxspeed: 50, speedSampleSize: 5, cycleInfraShare: 0 } }
      });
      const ids = r.measures.map(m => m.measure.id);
      expect(ids).toContain('tempo_30');
    });

    test('osmContext fehlt → keine Maßnahme wird durch prerequisites unterdrückt', () => {
      const r = UA.measures.recommendMeasures([5, 6], TEST_CATALOG, {});
      const ids = r.measures.map(m => m.measure.id);
      expect(ids).toContain('tempo_30');
      expect(ids).toContain('protected_bike_lane');
      expect(ids).toContain('mittelinsel');
      expect(r.filteredOut).toEqual([]);
    });

    test('Sortierung Kosten asc bleibt erhalten', () => {
      const r = UA.measures.recommendMeasures([5], TEST_CATALOG, {
        osmContext: { summary: { dominantMaxspeed: 50, speedSampleSize: 5, cycleInfraShare: 0 } }
      });
      // tempo_30 (2000) sollte vor protected_bike_lane (80000) kommen.
      const ids = r.measures.map(m => m.measure.id);
      expect(ids.indexOf('tempo_30')).toBeLessThan(ids.indexOf('protected_bike_lane'));
    });
  });

  describe('Real catalog has prerequisites for key measures', () => {
    const fs = require('fs');
    const path = require('path');
    const REAL_CATALOG = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../data/measures_catalog.json'), 'utf8'));

    test('tempo_30 has currentSpeedLimitGt prerequisite', () => {
      const t30 = REAL_CATALOG.measures.find(m => m.id === 'tempo_30');
      expect(t30).toBeDefined();
      expect(t30.prerequisites).toBeDefined();
      expect(t30.prerequisites.currentSpeedLimitGt).toBe(30);
    });

    test('mittelinsel has minLaneWidthM prerequisite', () => {
      const mi = REAL_CATALOG.measures.find(m => m.id === 'mittelinsel');
      expect(mi.prerequisites.minLaneWidthM).toBeCloseTo(7.5);
    });

    test('protected_bike_lane has noExistingBikeInfra prerequisite', () => {
      const pbl = REAL_CATALOG.measures.find(m => m.id === 'protected_bike_lane');
      expect(pbl.prerequisites.noExistingBikeInfra).toBe(true);
    });
  });
});
