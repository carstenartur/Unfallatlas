/**
 * Tests for political-mode helpers and executive-summary / causes-measures
 * builders introduced in tasks 2, 4, 8, 9, 10.
 */

describe('political-mode + summary helpers', () => {
  let UA;
  let prevFetch;
  let hadFetch;
  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const win = { UA: {}, location: { href: 'http://localhost/' } };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    load('ua.trend.js');
    load('ua.heatmap.js');
    load('ua.osm_context.js');
    load('ua.costs.js');
    load('ua.measures.js');
    win.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    hadFetch = Object.prototype.hasOwnProperty.call(global, 'fetch');
    prevFetch = global.fetch;
    global.fetch = win.fetch;
    win.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = win.UA;
  });
  afterEach(() => {
    if (hadFetch) global.fetch = prevFetch;
    else delete global.fetch;
  });

  describe('UA.formatFactorPolitical (Task 9)', () => {
    test('bands map to political phrasing', () => {
      expect(UA.formatFactorPolitical(2.5)).toBe('mehr als doppelt so häufig wie im Stadtmittel');
      expect(UA.formatFactorPolitical(2.0)).toBe('mehr als doppelt so häufig wie im Stadtmittel');
      expect(UA.formatFactorPolitical(1.7)).toBe('rund 1,5-mal so häufig wie im Stadtmittel');
      expect(UA.formatFactorPolitical(1.5)).toBe('rund 1,5-mal so häufig wie im Stadtmittel');
      expect(UA.formatFactorPolitical(1.4)).toBe('deutlich häufiger als im Stadtmittel');
      expect(UA.formatFactorPolitical(1.35)).toBe('deutlich häufiger als im Stadtmittel');
      expect(UA.formatFactorPolitical(1.1)).toBe('leicht erhöht gegenüber dem Stadtmittel');
    });

    test('technical mode preserves the raw factor (German decimal comma)', () => {
      expect(UA.formatFactorPolitical(2.5, { mode: 'technical' })).toBe('Faktor 2,50');
      expect(UA.formatFactorPolitical(1.345, { mode: 'technical' })).toBe('Faktor 1,34');
    });

    test('non-finite input → "k. A."', () => {
      expect(UA.formatFactorPolitical(NaN)).toBe('k. A.');
      expect(UA.formatFactorPolitical(undefined)).toBe('k. A.');
    });
  });

  describe('UA.buildExecutiveSummary (Task 2)', () => {
    test('strong focus + steigender Trend → urgent', () => {
      const structured = {
        deviations: { focus: [{ factor: 2.0, isSignificant: true, mask: 5, textLabel: '[Rad]+[PKW]' }] },
        severity: { total: 12, bySev: { '1': 1, '2': 4, '3': 7 } },
        yearlyTrend: { classification: 'steigend' }
      };
      const es = UA.buildExecutiveSummary(structured);
      expect(es.classification).toMatch(/Auffälliger Unfallschwerpunkt/);
      expect(es.urgency).toMatch(/Dringlich/);
      // Bullet list capped at 4, includes total + factor + trend + heavy share.
      expect(es.bullets.length).toBeGreaterThanOrEqual(2);
      expect(es.bullets.length).toBeLessThanOrEqual(4);
      expect(es.bullets[0]).toMatch(/12/);
    });

    test('no focus, no severe injuries → unauffällig + monitoring', () => {
      const structured = {
        deviations: { focus: [] },
        severity: { total: 4, bySev: { '3': 4 } },
        yearlyTrend: { classification: 'rückläufig' }
      };
      const es = UA.buildExecutiveSummary(structured);
      expect(es.classification).toMatch(/kein eindeutiger Unfallschwerpunkt/);
      expect(es.urgency).toMatch(/Beobachtungsmodus/);
    });

    test('political-mode bullet uses the factor band wording', () => {
      const structured = {
        deviations: { focus: [{ factor: 2.0, isSignificant: true, mask: 1, textLabel: '[Rad]' }] },
        severity: { total: 5, bySev: { '3': 5 } },
        yearlyTrend: null
      };
      const es = UA.buildExecutiveSummary(structured, { mode: 'political' });
      expect(es.bullets.some(b => /mehr als doppelt/.test(b))).toBe(true);
    });
  });

  describe('UA.buildCausesMeasuresSection (Task 4)', () => {
    test('catalog mapping wins; falls back to deterministic table when absent', () => {
      const focus = [
        { mask: 5, textLabel: '[Rad]+[PKW]' }, // covered by catalog (Tempo 30 etc.)
        { mask: 3, textLabel: '[Rad]+[Fuss]' } // not in our minimal mock catalog
      ];
      const recommended = {
        measures: [
          { measure: { label: 'Tempo-30-Anordnung', effect: { targetPatterns: [5] } } }
        ]
      };
      const out = UA.buildCausesMeasuresSection(focus, recommended);
      expect(out.length).toBe(2);
      expect(out[0].measures).toContain('Tempo-30-Anordnung');
      // mask=3 falls back to CAUSE_MEASURE_FALLBACK
      expect(out[1].measures.length).toBeGreaterThan(0);
      expect(out[1].measures[0]).toMatch(/Trennung|Querung/);
    });

    test('every detected anomaly produces ≥1 measure (or the explicit fallback string)', () => {
      const focus = [{ mask: 999, textLabel: 'unknown' }]; // not in catalog or fallback
      const out = UA.buildCausesMeasuresSection(focus, null);
      expect(out[0].measures.length).toBe(1);
      expect(out[0].measures[0]).toMatch(/Keine spezifische Maßnahme/);
    });

    test('empty focus → empty result (no section to render)', () => {
      expect(UA.buildCausesMeasuresSection([], null)).toEqual([]);
    });
  });

  describe('UA.deriveOsmInsights (Task 8)', () => {
    test('low cycle infra + Tempo 50 → two insights', () => {
      const ins = UA.deriveOsmInsights({
        summary: {
          cycleInfraShare: 0.10,
          dominantMaxspeed: 50,
          speedSampleSize: 4,
          crossings: 1,
          trafficSignals: 1
        }
      });
      expect(ins.some(s => /Anteil sicherer Radinfrastruktur/.test(s))).toBe(true);
      expect(ins.some(s => /Tempolimit ≥ 50/.test(s))).toBe(true);
    });

    test('Tempo 30 already established → recommend no further reduction', () => {
      const ins = UA.deriveOsmInsights({
        summary: {
          cycleInfraShare: 0.5,
          dominantMaxspeed: 30,
          speedSampleSize: 8,
          crossings: 2,
          trafficSignals: 2
        }
      });
      expect(ins.some(s => /Tempo 30 ist bereits etabliert/.test(s))).toBe(true);
    });

    test('null / missing summary → empty result', () => {
      expect(UA.deriveOsmInsights(null)).toEqual([]);
      expect(UA.deriveOsmInsights({})).toEqual([]);
    });
  });
});
