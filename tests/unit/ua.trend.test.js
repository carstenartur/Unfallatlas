/**
 * Unit tests for UA.trend (#C2 Mehrjahres-Trend).
 * Validates the regression math, the qualitative classification, the
 * shape of the structured output, and the SVG renderer.
 */

describe('UA.trend', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const mockWindow = { UA: {} };
    const trendPath = path.resolve(__dirname, '../../js/ua.trend.js');
    (function (window) { eval(fs.readFileSync(trendPath, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  // -----------------------------------------------------------------
  // linearRegression
  // -----------------------------------------------------------------
  describe('linearRegression', () => {
    test('fits a perfectly linear series exactly (slope=2, intercept=1, r²=1)', () => {
      const xs = [0, 1, 2, 3, 4];
      const ys = xs.map(x => 2 * x + 1);
      const r = UA.trend.linearRegression(xs, ys);
      expect(r.slope).toBeCloseTo(2, 10);
      expect(r.intercept).toBeCloseTo(1, 10);
      expect(r.r2).toBeCloseTo(1, 10);
      expect(r.mean).toBeCloseTo(5, 10);
    });

    test('returns slope=0 with valid mean for constant y series', () => {
      const r = UA.trend.linearRegression([2020, 2021, 2022], [4, 4, 4]);
      expect(r.slope).toBeCloseTo(0, 10);
      expect(r.intercept).toBeCloseTo(4, 10);
      // Constant series → SStot=0 → R² conventionally 1 (perfect fit on constant).
      expect(r.r2).toBe(1);
    });

    test('returns NaN R² when all x are identical (no x-variance)', () => {
      const r = UA.trend.linearRegression([2020, 2020, 2020], [1, 2, 3]);
      expect(r.slope).toBe(0);
      expect(Number.isNaN(r.r2)).toBe(true);
    });

    test('handles n=1 gracefully', () => {
      const r = UA.trend.linearRegression([2020], [5]);
      expect(r.slope).toBe(0);
      expect(r.intercept).toBe(5);
      expect(Number.isNaN(r.r2)).toBe(true);
    });

    test('handles n=0 gracefully', () => {
      const r = UA.trend.linearRegression([], []);
      expect(r.slope).toBe(0);
      expect(r.intercept).toBe(0);
    });
  });

  // -----------------------------------------------------------------
  // classifyTrend (threshold semantics)
  // -----------------------------------------------------------------
  describe('classifyTrend', () => {
    test('returns "unbestimmt" when fewer than the minimum number of years', () => {
      // 2 years is below MIN_YEARS_FOR_TREND.
      expect(UA.trend.classifyTrend(1, 5, 1, 2)).toBe('unbestimmt');
    });

    test('returns "unbestimmt" for an empty series (mean=0)', () => {
      expect(UA.trend.classifyTrend(0, 0, 1, 5)).toBe('unbestimmt');
    });

    test('falls back to "stagnierend" when R² is below R2_MIN', () => {
      // Slope is steep relative to mean, but R² is poor → conservatively flat.
      expect(UA.trend.classifyTrend(2, 10, 0.1, 5)).toBe('stagnierend');
    });

    test('classifies relative slope below ±5% as "stagnierend" when fit is OK', () => {
      // slope/mean = 0.4/10 = 4 % → flat
      expect(UA.trend.classifyTrend(0.4, 10, 0.9, 5)).toBe('stagnierend');
    });

    test('classifies a strong upward trend as "steigend"', () => {
      // slope/mean = 1/10 = 10 % → steigend
      expect(UA.trend.classifyTrend(1, 10, 0.9, 5)).toBe('steigend');
    });

    test('classifies a strong downward trend as "rückläufig"', () => {
      expect(UA.trend.classifyTrend(-1, 10, 0.9, 5)).toBe('rückläufig');
    });
  });

  // -----------------------------------------------------------------
  // computeYearlyTrend (end-to-end on accident-shaped points)
  // -----------------------------------------------------------------
  describe('computeYearlyTrend', () => {
    function pt(year, ukategorie) {
      return { props: { year: String(year), ukategorie: String(ukategorie) } };
    }

    test('returns empty arrays and "unbestimmt" for no points', () => {
      const r = UA.trend.computeYearlyTrend([]);
      expect(r.years).toEqual([]);
      expect(r.counts.total).toEqual([]);
      expect(r.classification).toBe('unbestimmt');
      expect(r.nYears).toBe(0);
    });

    test('groups by year and severity correctly, sorts years ascending', () => {
      const pts = [
        pt(2022, 1), pt(2022, 2), pt(2022, 3),
        pt(2020, 2), pt(2020, 2),
        pt(2021, 3),
        // Out-of-vocabulary severity must still count toward total but not into named buckets.
        pt(2021, 9)
      ];
      const r = UA.trend.computeYearlyTrend(pts);
      expect(r.years).toEqual([2020, 2021, 2022]);
      expect(r.counts.fatal).toEqual([0, 0, 1]);
      expect(r.counts.severe).toEqual([2, 0, 1]);
      expect(r.counts.light).toEqual([0, 1, 1]);
      expect(r.counts.total).toEqual([2, 2, 3]);
    });

    test('ignores points with missing/non-numeric year', () => {
      const pts = [pt(2020, 1), { props: { ukategorie: '1' } }, { props: { year: 'foo', ukategorie: '1' } }];
      const r = UA.trend.computeYearlyTrend(pts);
      expect(r.years).toEqual([2020]);
      expect(r.counts.total).toEqual([1]);
    });

    test('detects a clearly increasing total trend (~+30 %/yr) over ≥3 years', () => {
      const pts = [];
      const series = [{ y: 2020, n: 5 }, { y: 2021, n: 8 }, { y: 2022, n: 11 }, { y: 2023, n: 14 }];
      for (const { y, n } of series) for (let i = 0; i < n; i++) pts.push(pt(y, 3));
      const r = UA.trend.computeYearlyTrend(pts);
      expect(r.classification).toBe('steigend');
      expect(r.slope).toBeGreaterThan(0);
      expect(r.r2).toBeGreaterThan(0.9);
      expect(r.nYears).toBe(4);
    });

    test('detects a clearly decreasing total trend as "rückläufig"', () => {
      const pts = [];
      const series = [{ y: 2018, n: 20 }, { y: 2019, n: 16 }, { y: 2020, n: 12 }, { y: 2021, n: 8 }, { y: 2022, n: 5 }];
      for (const { y, n } of series) for (let i = 0; i < n; i++) pts.push(pt(y, 3));
      const r = UA.trend.computeYearlyTrend(pts);
      expect(r.classification).toBe('rückläufig');
      expect(r.slope).toBeLessThan(0);
    });

    test('classifies a flat 5-year series as "stagnierend"', () => {
      const pts = [];
      for (const y of [2018, 2019, 2020, 2021, 2022]) for (let i = 0; i < 6; i++) pts.push(pt(y, 3));
      const r = UA.trend.computeYearlyTrend(pts);
      expect(r.classification).toBe('stagnierend');
    });

    test('classifies a 2-year series as "unbestimmt" (below MIN_YEARS_FOR_TREND)', () => {
      const pts = [pt(2021, 3), pt(2021, 3), pt(2022, 3), pt(2022, 3), pt(2022, 3)];
      const r = UA.trend.computeYearlyTrend(pts);
      expect(r.classification).toBe('unbestimmt');
    });
  });

  // -----------------------------------------------------------------
  // renderTrendSVG
  // -----------------------------------------------------------------
  describe('renderTrendSVG', () => {
    test('returns an empty string when there is nothing meaningful to draw', () => {
      expect(UA.trend.renderTrendSVG(null)).toBe('');
      expect(UA.trend.renderTrendSVG({ years: [2020], counts: { total: [3] }, slope: 0, intercept: 3 })).toBe('');
    });

    test('emits a self-contained <svg> document with data + regression paths', () => {
      const trend = {
        years: [2020, 2021, 2022, 2023],
        counts: { total: [3, 5, 7, 9] },
        slope: 2,
        intercept: -4037,
        classification: 'steigend'
      };
      const svg = UA.trend.renderTrendSVG(trend);
      expect(svg).toMatch(/^<svg /);
      expect(svg).toMatch(/<\/svg>$/);
      // Two paths: data line + regression line
      expect((svg.match(/<path /g) || []).length).toBeGreaterThanOrEqual(2);
      // Year labels for first/last year and y-max present
      expect(svg).toContain('2020');
      expect(svg).toContain('2023');
      // Has an aria-label so it's accessible
      expect(svg).toMatch(/aria-label=/);
    });

    test('respects width / height / ariaLabel options', () => {
      const trend = { years: [2020, 2021], counts: { total: [1, 2] }, slope: 1, intercept: -2019, classification: 'steigend' };
      const svg = UA.trend.renderTrendSVG(trend, { width: 200, height: 60, ariaLabel: 'X' });
      expect(svg).toContain('viewBox="0 0 200 60"');
      expect(svg).toContain('width="200"');
      expect(svg).toContain('aria-label="X"');
    });
  });
});
