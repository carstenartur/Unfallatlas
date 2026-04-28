/**
 * Tests for UA.computeTopHotspots — the data-only helper behind the
 * "Argumentationsansicht" map overlay (Task 2). Runs without a Leaflet map.
 */

describe('UA.computeTopHotspots', () => {
  let UA;
  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const win = { UA: {}, location: { href: 'http://localhost/' } };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
    };
    // Make UA.maskFromProps available (used by the helper).
    load('ua.utils.js');
    load('ua.filters.js');
    // ua.map_v2.js touches L only inside other helpers, computeTopHotspots
    // path itself is Leaflet-free.
    win.L = {};
    load('ua.map_v2.js');
    UA = win.UA;
  });

  test('returns empty array on missing or non-array input', () => {
    expect(UA.computeTopHotspots(null)).toEqual([]);
    expect(UA.computeTopHotspots(undefined)).toEqual([]);
    expect(UA.computeTopHotspots('not-an-array')).toEqual([]);
  });

  test('skips points with non-numeric coordinates', () => {
    const out = UA.computeTopHotspots([
      { lat: 'x', lon: 1, props: { istrad: '1' } },
      { lat: 1, lon: NaN, props: { istrad: '1' } }
    ], { minTotal: 1 });
    expect(out).toEqual([]);
  });

  test('groups points into ~50 m bins via the lat/lon fallback key', () => {
    // Two clusters that should land in two different bins; each bin
    // contains 5 + 3 points respectively. minTotal=2 → both included.
    const cluster1 = Array.from({ length: 5 }, (_, i) => ({
      lat: 52.3760 + i * 0.00001, // ≈1 m apart, same bin
      lon: 9.7320 + i * 0.00001,
      props: { istrad: '1', istpkw: '1' }
    }));
    const cluster2 = Array.from({ length: 3 }, (_, i) => ({
      lat: 52.3900 + i * 0.00001, // ≈1.5 km away
      lon: 9.7500 + i * 0.00001,
      props: { istrad: '1' }
    }));
    const out = UA.computeTopHotspots([...cluster1, ...cluster2], { k: 3, minTotal: 2 });
    expect(out).toHaveLength(2);
    expect(out[0].total).toBe(5);
    expect(out[1].total).toBe(3);
    // Centroid roughly matches the cluster centre.
    expect(Math.abs(out[0].lat - 52.3760)).toBeLessThan(0.001);
    expect(Math.abs(out[0].lon - 9.7320)).toBeLessThan(0.001);
  });

  test('top-K cap honoured (k=3 by default, configurable)', () => {
    // 5 distinct bins of decreasing size.
    const pts = [];
    for (let bin = 0; bin < 5; bin++) {
      for (let n = 0; n <= bin; n++) {
        pts.push({
          lat: 52.0 + bin * 0.01,
          lon: 9.0 + bin * 0.01,
          props: { istrad: '1' }
        });
      }
    }
    const top3 = UA.computeTopHotspots(pts, { minTotal: 1 });
    expect(top3).toHaveLength(3);
    expect(top3[0].total).toBe(5);
    expect(top3[2].total).toBe(3);
    const top1 = UA.computeTopHotspots(pts, { k: 1, minTotal: 1 });
    expect(top1).toHaveLength(1);
    expect(top1[0].total).toBe(5);
  });

  test('minTotal threshold drops sparse cells', () => {
    const pts = [
      { lat: 52.0, lon: 9.0, props: { istrad: '1' } },
      { lat: 52.0, lon: 9.0, props: { istrad: '1' } },
      { lat: 52.5, lon: 9.5, props: { istrad: '1' } } // singleton
    ];
    const out = UA.computeTopHotspots(pts, { minTotal: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(2);
  });

  test('reports the dominant involvement mask per hotspot', () => {
    const pts = [
      // Bin A: 3× Rad+PKW, 1× Rad → dominant Rad+PKW (mask 5)
      { lat: 52.1, lon: 9.1, props: { istrad: '1', istpkw: '1' } },
      { lat: 52.1, lon: 9.1, props: { istrad: '1', istpkw: '1' } },
      { lat: 52.1, lon: 9.1, props: { istrad: '1', istpkw: '1' } },
      { lat: 52.1, lon: 9.1, props: { istrad: '1' } }
    ];
    const out = UA.computeTopHotspots(pts, { minTotal: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].dominantMask).toBe(5); // Rad(1)+PKW(4)
    expect(out[0].dominantCount).toBe(3);
  });

  test('respects a caller-supplied cellKeyFn (Leaflet path simulated)', () => {
    // Force everything into a single key, regardless of coordinates.
    const out = UA.computeTopHotspots(
      [
        { lat: 1, lon: 1, props: { istrad: '1' } },
        { lat: 999, lon: -999, props: { istpkw: '1' } }
      ],
      { minTotal: 2, cellKeyFn: () => 'singleton' }
    );
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(2);
  });

  test('deterministic ordering on count ties (key tie-break)', () => {
    const pts = [
      { lat: 52.0, lon: 9.0, props: { istrad: '1' } },
      { lat: 52.0, lon: 9.0, props: { istrad: '1' } },
      { lat: 52.5, lon: 9.5, props: { istrad: '1' } },
      { lat: 52.5, lon: 9.5, props: { istrad: '1' } }
    ];
    const a = UA.computeTopHotspots(pts, { minTotal: 2 });
    const b = UA.computeTopHotspots(pts, { minTotal: 2 });
    expect(a.map(h => h.key)).toEqual(b.map(h => h.key));
  });
});
