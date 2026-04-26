/**
 * Unit tests for ua.stats.js – wilsonScoreInterval
 */

describe('UA.wilsonScoreInterval', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');
    const statsPath = path.resolve(__dirname, '../../js/ua.stats.js');
    (function(window) { eval(fs.readFileSync(statsPath, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  describe('edge cases', () => {
    test('n=0 returns [0, 1]', () => {
      const ci = UA.wilsonScoreInterval(0, 0);
      expect(ci.low).toBe(0);
      expect(ci.high).toBe(1);
    });

    test('k=0, n=10: lower bound is 0', () => {
      const ci = UA.wilsonScoreInterval(0, 10);
      expect(ci.low).toBe(0);
      expect(ci.high).toBeGreaterThan(0);
      expect(ci.high).toBeLessThan(1);
    });

    test('k=n: upper bound is 1', () => {
      const ci = UA.wilsonScoreInterval(10, 10);
      expect(ci.high).toBe(1);
      expect(ci.low).toBeGreaterThan(0);
    });
  });

  describe('known reference values (95 % CI)', () => {
    // Reference: https://www.statology.org/wilson-score-interval/
    // k=4, n=200: p̂=0.02
    // Expected approx: low≈0.0077, high≈0.0509
    test('k=4, n=200 interval is within expected range', () => {
      const ci = UA.wilsonScoreInterval(4, 200);
      expect(ci.low).toBeGreaterThan(0.005);
      expect(ci.low).toBeLessThan(0.015);
      expect(ci.high).toBeGreaterThan(0.04);
      expect(ci.high).toBeLessThan(0.065);
    });

    // k=50, n=100: p̂=0.5 – symmetric interval around 0.5
    test('k=50, n=100 interval is symmetric around 0.5', () => {
      const ci = UA.wilsonScoreInterval(50, 100);
      expect(ci.low).toBeGreaterThan(0.39);
      expect(ci.low).toBeLessThan(0.42);
      expect(ci.high).toBeGreaterThan(0.58);
      expect(ci.high).toBeLessThan(0.61);
      // Symmetry check
      expect(Math.abs((ci.low + ci.high) / 2 - 0.5)).toBeLessThan(0.005);
    });

    // k=1, n=10: p̂=0.1 – skewed left-truncated
    test('k=1, n=10 interval is reasonable', () => {
      const ci = UA.wilsonScoreInterval(1, 10);
      expect(ci.low).toBeGreaterThanOrEqual(0);
      expect(ci.low).toBeLessThan(0.1);
      expect(ci.high).toBeGreaterThan(0.1);
      expect(ci.high).toBeLessThan(0.6);
    });
  });

  describe('output is always valid', () => {
    test('low <= high for all inputs', () => {
      const cases = [[0,1],[1,1],[0,10],[1,10],[5,10],[9,10],[10,10],[4,200],[100,1000]];
      for (const [k, n] of cases) {
        const ci = UA.wilsonScoreInterval(k, n);
        expect(ci.low).toBeLessThanOrEqual(ci.high);
      }
    });

    test('interval is always within [0, 1]', () => {
      const cases = [[0,1],[1,1],[0,10],[10,10],[4,200]];
      for (const [k, n] of cases) {
        const ci = UA.wilsonScoreInterval(k, n);
        expect(ci.low).toBeGreaterThanOrEqual(0);
        expect(ci.high).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('custom z value', () => {
    test('z=1.645 (90 %) yields narrower interval than z=1.96 (95 %)', () => {
      const ci90 = UA.wilsonScoreInterval(5, 50, 1.645);
      const ci95 = UA.wilsonScoreInterval(5, 50, 1.96);
      const width90 = ci90.high - ci90.low;
      const width95 = ci95.high - ci95.low;
      expect(width90).toBeLessThan(width95);
    });

    test('z=2.576 (99 %) yields wider interval than z=1.96 (95 %)', () => {
      const ci99 = UA.wilsonScoreInterval(5, 50, 2.576);
      const ci95 = UA.wilsonScoreInterval(5, 50, 1.96);
      const width99 = ci99.high - ci99.low;
      const width95 = ci95.high - ci95.low;
      expect(width99).toBeGreaterThan(width95);
    });
  });
});
