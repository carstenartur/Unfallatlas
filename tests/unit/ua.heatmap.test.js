/**
 * Unit tests for UA.heatmap (#A2 Stunden-×-Tagestyp-Heatmap).
 */

describe('UA.heatmap', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const mockWindow = { UA: {} };
    const p = path.resolve(__dirname, '../../js/ua.heatmap.js');
    (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  function pt(hour, weekday) {
    return { props: { ustunde: String(hour), uwochentag: String(weekday) } };
  }

  // -----------------------------------------------------------------
  // dayTypeOf
  // -----------------------------------------------------------------
  describe('dayTypeOf', () => {
    test('classifies Mo–Fr (1–5) as weekday', () => {
      for (let d = 1; d <= 5; d++) expect(UA.heatmap.dayTypeOf(d)).toBe('weekday');
    });
    test('classifies Sa (6) and So (7) as weekend', () => {
      expect(UA.heatmap.dayTypeOf(6)).toBe('weekend');
      expect(UA.heatmap.dayTypeOf(7)).toBe('weekend');
    });
    test('returns null for out-of-range / non-numeric weekday', () => {
      expect(UA.heatmap.dayTypeOf(0)).toBeNull();
      expect(UA.heatmap.dayTypeOf(8)).toBeNull();
      expect(UA.heatmap.dayTypeOf('x')).toBeNull();
      expect(UA.heatmap.dayTypeOf(undefined)).toBeNull();
    });
  });

  // -----------------------------------------------------------------
  // computeHourDaytypeMatrix
  // -----------------------------------------------------------------
  describe('computeHourDaytypeMatrix', () => {
    test('produces a 24×2 matrix with all zeros for empty input', () => {
      const m = UA.heatmap.computeHourDaytypeMatrix([]);
      expect(m.matrix).toHaveLength(24);
      expect(m.matrix.every(row => row.length === 2 && row[0] === 0 && row[1] === 0)).toBe(true);
      expect(m.total).toBe(0);
      expect(m.max).toBe(0);
      expect(m.colTotals).toEqual([0, 0]);
    });

    test('aggregates correctly into weekday vs weekend buckets', () => {
      const pts = [
        pt(8, 1), pt(8, 1), pt(8, 5),  // 3 weekday accidents @ 08:00
        pt(8, 6),                        // 1 weekend accident @ 08:00
        pt(23, 7),                       // 1 weekend accident @ 23:00
        pt(0, 2)                         // 1 weekday accident @ 00:00
      ];
      const m = UA.heatmap.computeHourDaytypeMatrix(pts);
      expect(m.matrix[8]).toEqual([3, 1]);
      expect(m.matrix[23]).toEqual([0, 1]);
      expect(m.matrix[0]).toEqual([1, 0]);
      expect(m.matrix[12]).toEqual([0, 0]);
      expect(m.colTotals).toEqual([4, 2]);
      expect(m.rowTotals[8]).toBe(4);
      expect(m.total).toBe(6);
      expect(m.max).toBe(3);
    });

    test('skips points with invalid/missing hour or weekday', () => {
      const pts = [
        pt(8, 1),
        { props: { ustunde: '99', uwochentag: '1' } },     // invalid hour
        { props: { ustunde: '8', uwochentag: '0' } },      // invalid weekday
        { props: { uwochentag: '1' } },                    // missing hour
        { props: { ustunde: '8' } },                       // missing weekday
        { props: {} },                                     // empty props
        {}                                                 // missing props
      ];
      const m = UA.heatmap.computeHourDaytypeMatrix(pts);
      expect(m.total).toBe(1);
      expect(m.matrix[8]).toEqual([1, 0]);
    });

    test('truncates fractional hours toward zero (e.g. 8.7 → bucket 8)', () => {
      const m = UA.heatmap.computeHourDaytypeMatrix([{ props: { ustunde: '8.7', uwochentag: '3' } }]);
      expect(m.matrix[8][0]).toBe(1);
    });
  });

  // -----------------------------------------------------------------
  // cellColor / readableTextColor
  // -----------------------------------------------------------------
  describe('cellColor', () => {
    test('returns white for value=0 or max=0', () => {
      expect(UA.heatmap.cellColor(0, 10)).toBe('#FFFFFF');
      expect(UA.heatmap.cellColor(5, 0)).toBe('#FFFFFF');
    });
    test('returns the darkest end colour at value === max', () => {
      expect(UA.heatmap.cellColor(10, 10)).toBe('#08306B');
    });
    test('produces a #RRGGBB hex string for intermediate values', () => {
      const c = UA.heatmap.cellColor(5, 10);
      expect(c).toMatch(/^#[0-9A-F]{6}$/);
      // Mid-ramp should be lighter than the max colour.
      expect(c).not.toBe('#08306B');
      expect(c).not.toBe('#FFFFFF');
    });
  });

  describe('readableTextColor', () => {
    test('returns black on a near-white background', () => {
      expect(UA.heatmap.readableTextColor('#FFFFFF')).toBe('#000000');
    });
    test('returns white on the darkest blue', () => {
      expect(UA.heatmap.readableTextColor('#08306B')).toBe('#FFFFFF');
    });
    test('falls back to black on malformed input', () => {
      expect(UA.heatmap.readableTextColor('')).toBe('#000000');
      expect(UA.heatmap.readableTextColor('not-a-color')).toBe('#000000');
    });
  });

  // -----------------------------------------------------------------
  // renderHeatmapSVG
  // -----------------------------------------------------------------
  describe('renderHeatmapSVG', () => {
    test('returns "" for empty matrix or total=0', () => {
      const empty = UA.heatmap.computeHourDaytypeMatrix([]);
      expect(UA.heatmap.renderHeatmapSVG(empty)).toBe('');
      expect(UA.heatmap.renderHeatmapSVG(null)).toBe('');
    });

    test('emits 48 cell rectangles + an aria-label for non-empty data', () => {
      const m = UA.heatmap.computeHourDaytypeMatrix([pt(8, 1), pt(20, 6)]);
      const svg = UA.heatmap.renderHeatmapSVG(m);
      expect(svg).toMatch(/^<svg /);
      expect(svg).toMatch(/<\/svg>$/);
      // 24 hours × 2 columns = 48 cell <rect>s.
      expect((svg.match(/<rect /g) || []).length).toBe(48);
      // Hour and column labels present.
      expect(svg).toContain('Mo–Fr');
      expect(svg).toContain('Sa/So');
      expect(svg).toMatch(/aria-label=/);
      // Non-zero counts surface as cell text.
      expect(svg).toContain('>1<');
    });

    test('honours custom cellW / cellH via opts', () => {
      const m = UA.heatmap.computeHourDaytypeMatrix([pt(8, 1)]);
      const svg = UA.heatmap.renderHeatmapSVG(m, { cellW: 30, cellH: 24 });
      // viewBox width = padL(38) + 30*2 + 4 = 102; height = padT(24) + 24*24 + 4 = 604
      expect(svg).toContain('viewBox="0 0 102 604"');
    });
  });
});
