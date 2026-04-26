/**
 * Unit tests for ua.costs.js
 */

describe('UA.costs', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');
    const p = path.resolve(__dirname, '../../js/ua.costs.js');
    (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  describe('computeAnnualCost', () => {
    test('returns 0 when no severity counts given', () => {
      const r = UA.costs.computeAnnualCost({}, 5, UA.costs.FALLBACK);
      expect(r.total).toBe(0);
      expect(r.annual).toBe(0);
      expect(r.years).toBe(5);
    });

    test('multiplies counts by per-accident factors', () => {
      const r = UA.costs.computeAnnualCost({ "1": 1, "2": 2, "3": 3 }, 1, UA.costs.FALLBACK);
      const f = UA.costs.FALLBACK.perAccident;
      expect(r.total).toBe(1 * f.fatal.value + 2 * f.severe.value + 3 * f.light.value);
      expect(r.annual).toBe(r.total);
    });

    test('divides total by years for annual cost', () => {
      const r = UA.costs.computeAnnualCost({ "2": 5 }, 5, UA.costs.FALLBACK);
      const f = UA.costs.FALLBACK.perAccident;
      expect(r.total).toBe(5 * f.severe.value);
      expect(r.annual).toBe(f.severe.value);
      expect(r.years).toBe(5);
    });

    test('falls back to years=1 for invalid years input', () => {
      const r1 = UA.costs.computeAnnualCost({ "3": 4 }, 0,    UA.costs.FALLBACK);
      const r2 = UA.costs.computeAnnualCost({ "3": 4 }, -3,   UA.costs.FALLBACK);
      const r3 = UA.costs.computeAnnualCost({ "3": 4 }, "abc", UA.costs.FALLBACK);
      expect(r1.years).toBe(1);
      expect(r2.years).toBe(1);
      expect(r3.years).toBe(1);
      expect(r1.annual).toBe(r1.total);
    });

    test('breakdown sums to total', () => {
      const r = UA.costs.computeAnnualCost({ "1": 1, "2": 2, "3": 3 }, 1, UA.costs.FALLBACK);
      expect(r.breakdown.fatal + r.breakdown.severe + r.breakdown.light).toBe(r.total);
    });

    test('uses fallback if factors arg omitted', () => {
      const r = UA.costs.computeAnnualCost({ "2": 1 }, 1);
      expect(r.total).toBe(UA.costs.FALLBACK.perAccident.severe.value);
    });

    test('coerces string severity counts to numbers', () => {
      const r = UA.costs.computeAnnualCost({ "1": "1", "3": "10" }, 1, UA.costs.FALLBACK);
      const f = UA.costs.FALLBACK.perAccident;
      expect(r.total).toBe(f.fatal.value + 10 * f.light.value);
    });

    test('handles partial perAccident factors gracefully', () => {
      const partial = { perAccident: { fatal: { value: 1000000 }, severe: { value: 100000 } } };
      const r = UA.costs.computeAnnualCost({ "1": 1, "2": 1, "3": 5 }, 1, partial);
      // light not defined → contributes 0
      expect(r.total).toBe(1100000);
    });
  });

  describe('formatEUR', () => {
    test('formats integer EUR with German thousand separators', () => {
      expect(UA.costs.formatEUR(1234567)).toBe('1.234.567 €');
    });

    test('rounds non-integer values', () => {
      expect(UA.costs.formatEUR(99.4)).toBe('99 €');
      expect(UA.costs.formatEUR(99.6)).toBe('100 €');
    });

    test('returns "—" for non-finite input', () => {
      expect(UA.costs.formatEUR(NaN)).toBe('—');
      expect(UA.costs.formatEUR(Infinity)).toBe('—');
      expect(UA.costs.formatEUR(undefined)).toBe('—');
    });

    test('short mode renders Mio. € for >= 1 million', () => {
      expect(UA.costs.formatEUR(1900000, { short: true })).toBe('1,9 Mio. €');
      expect(UA.costs.formatEUR(2_000_000, { short: true })).toBe('2,0 Mio. €');
    });

    test('short mode renders Tsd. € for >= 10 000 but < 1 Mio', () => {
      expect(UA.costs.formatEUR(380000, { short: true })).toBe('380 Tsd. €');
      expect(UA.costs.formatEUR(15500, { short: true })).toBe('16 Tsd. €');
    });

    test('short mode renders plain EUR for small values', () => {
      expect(UA.costs.formatEUR(5000, { short: true })).toBe('5.000 €');
    });

    test('handles negative values', () => {
      expect(UA.costs.formatEUR(-1500)).toBe('-1.500 €');
    });
  });

  describe('computeAmortisationYears', () => {
    test('basic case: 60 000 € / (380 000 € * 0.16) ≈ 0.987 years', () => {
      const y = UA.costs.computeAmortisationYears(60000, 380000, 0.16);
      expect(y).toBeCloseTo(60000 / (380000 * 0.16), 3);
    });

    test('returns null when measure cost is 0 or negative', () => {
      expect(UA.costs.computeAmortisationYears(0,    1000, 0.5)).toBeNull();
      expect(UA.costs.computeAmortisationYears(-100, 1000, 0.5)).toBeNull();
    });

    test('returns null when annual cost is 0 or negative', () => {
      expect(UA.costs.computeAmortisationYears(1000, 0,    0.5)).toBeNull();
      expect(UA.costs.computeAmortisationYears(1000, -10,  0.5)).toBeNull();
    });

    test('returns null when reduction is 0 or negative', () => {
      expect(UA.costs.computeAmortisationYears(1000, 1000, 0)).toBeNull();
      expect(UA.costs.computeAmortisationYears(1000, 1000, -0.1)).toBeNull();
    });

    test('returns null for non-finite inputs', () => {
      expect(UA.costs.computeAmortisationYears(NaN,  1000, 0.3)).toBeNull();
      expect(UA.costs.computeAmortisationYears(1000, NaN,  0.3)).toBeNull();
      expect(UA.costs.computeAmortisationYears(1000, 1000, NaN)).toBeNull();
    });
  });

  describe('loadCostFactors', () => {
    test('returns FALLBACK when fetch is unavailable', async () => {
      // No global fetch in this test scope → goes to catch
      UA.costs._resetCache();
      const data = await UA.costs.loadCostFactors();
      expect(data).toBeDefined();
      expect(data.perAccident.fatal.value).toBeGreaterThan(0);
      expect(data.perAccident.severe.value).toBeGreaterThan(0);
      expect(data.perAccident.light.value).toBeGreaterThan(0);
    });

    test('returns FALLBACK on fetch error', async () => {
      UA.costs._resetCache();
      global.fetch = async () => { throw new Error('network error'); };
      try {
        const data = await UA.costs.loadCostFactors();
        expect(data).toBe(UA.costs.FALLBACK);
      } finally {
        delete global.fetch;
      }
    });

    test('returns FALLBACK on non-OK response', async () => {
      UA.costs._resetCache();
      global.fetch = async () => ({ ok: false });
      try {
        const data = await UA.costs.loadCostFactors();
        expect(data).toBe(UA.costs.FALLBACK);
      } finally {
        delete global.fetch;
      }
    });

    test('returns parsed data on success', async () => {
      UA.costs._resetCache();
      const fakeData = {
        version: 1,
        source: { publisher: "BASt", year: 2024 },
        perAccident: {
          fatal:  { value: 1, unit: "EUR" },
          severe: { value: 2, unit: "EUR" },
          light:  { value: 3, unit: "EUR" }
        },
        disclaimer: "test"
      };
      global.fetch = async () => ({ ok: true, json: async () => fakeData });
      try {
        const data = await UA.costs.loadCostFactors();
        expect(data).toBe(fakeData);
        expect(data.perAccident.fatal.value).toBe(1);
      } finally {
        delete global.fetch;
      }
    });

    test('caches the result across invocations', async () => {
      UA.costs._resetCache();
      let calls = 0;
      global.fetch = async () => { calls++; return { ok: false }; };
      try {
        await UA.costs.loadCostFactors();
        await UA.costs.loadCostFactors();
        await UA.costs.loadCostFactors();
        expect(calls).toBe(1);
      } finally {
        delete global.fetch;
      }
    });
  });

  describe('FALLBACK structure', () => {
    test('contains all required severity keys', () => {
      expect(UA.costs.FALLBACK.perAccident.fatal.value).toBeGreaterThan(0);
      expect(UA.costs.FALLBACK.perAccident.severe.value).toBeGreaterThan(0);
      expect(UA.costs.FALLBACK.perAccident.light.value).toBeGreaterThan(0);
    });

    test('contains source metadata', () => {
      expect(UA.costs.FALLBACK.source.publisher).toContain('BASt');
      expect(UA.costs.FALLBACK.source.year).toBeGreaterThanOrEqual(2020);
    });

    test('contains disclaimer mentioning BASt and Fachgutachten', () => {
      expect(UA.costs.FALLBACK.disclaimer).toContain('BASt');
      expect(UA.costs.FALLBACK.disclaimer).toContain('Fachgutachten');
    });
  });
});
