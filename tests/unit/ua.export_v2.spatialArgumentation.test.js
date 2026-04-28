/**
 * Tests for Task 6: UA.deriveSpatialArgumentation derives 0–2 sentences
 * describing the spatial pattern (concentrated knot / corridor / multiple
 * separate hotspots / diffuse) from real accident coordinates.
 *
 * Coordinates – not the heatmap – are the source of truth; the heatmap only
 * shows aggregated density and must not be used as the sole basis for
 * spatial conclusions.
 */

describe('UA.deriveSpatialArgumentation (Task 6)', () => {
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

  test('returns no sentence for fewer than 3 points (avoid spurious claims)', () => {
    expect(UA.deriveSpatialArgumentation([])).toEqual([]);
    expect(UA.deriveSpatialArgumentation([{ lat: 52.0, lon: 9.7 }])).toEqual([]);
    expect(UA.deriveSpatialArgumentation([
      { lat: 52.0, lon: 9.7 },
      { lat: 52.001, lon: 9.701 }
    ])).toEqual([]);
  });

  test('detects a single dominant knot when ≥50 % of points fall in one ~55 m cell', () => {
    // 8 points in one cell + 2 isolated → topShare = 8/10 = 80 %.
    const pts = [];
    for (let i = 0; i < 8; i++) pts.push({ lat: 52.37500 + i * 0.00001, lon: 9.73000 + i * 0.00001 });
    pts.push({ lat: 52.40000, lon: 9.80000 });
    pts.push({ lat: 52.42000, lon: 9.82000 });
    const out = UA.deriveSpatialArgumentation(pts);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/konzentrieren sich/);
    expect(out[0]).toMatch(/knotenpunkttypisch/);
    expect(out[0]).toMatch(/8 von 10/);
  });

  test('detects a corridor when top hotspots are spread along one axis', () => {
    // Three tight clusters along the same longitude axis (E–W), >200 m apart.
    // 0.001° lon ≈ 68 m at 52° N → 0.005° ≈ 340 m, 0.010° ≈ 680 m.
    const pts = [];
    const clusterAt = (lat, lon, n) => {
      for (let i = 0; i < n; i++) pts.push({ lat: lat + i * 0.00001, lon: lon + i * 0.00001 });
    };
    clusterAt(52.37500, 9.73000, 4);
    clusterAt(52.37500, 9.73500, 4);
    clusterAt(52.37500, 9.74000, 4);
    const out = UA.deriveSpatialArgumentation(pts);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/Korridor|entlang einer Achse/);
  });

  test('detects a central knot area when 2–3 hotspots are tightly clustered (≤150 m)', () => {
    // Two tight clusters ~80 m apart, no clear share dominance.
    const pts = [];
    for (let i = 0; i < 5; i++) pts.push({ lat: 52.37500 + i * 0.00001, lon: 9.73000 + i * 0.00001 });
    for (let i = 0; i < 5; i++) pts.push({ lat: 52.37570 + i * 0.00001, lon: 9.73080 + i * 0.00001 });
    // a few spread-out points so the top cell does not own ≥ 50 %.
    pts.push({ lat: 52.39000, lon: 9.74000 });
    pts.push({ lat: 52.40000, lon: 9.74500 });
    pts.push({ lat: 52.41000, lon: 9.75000 });
    const out = UA.deriveSpatialArgumentation(pts);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/in unmittelbarer Nähe|zentralen Knotenpunktbereich/);
  });

  test('falls back to "diffuse" wording when no cell reaches the minimum cluster size', () => {
    // 5 single isolated points (each in its own ~55 m cell).
    const pts = [
      { lat: 52.300, lon: 9.700 },
      { lat: 52.310, lon: 9.710 },
      { lat: 52.320, lon: 9.720 },
      { lat: 52.330, lon: 9.730 },
      { lat: 52.340, lon: 9.740 }
    ];
    const out = UA.deriveSpatialArgumentation(pts);
    expect(out.length).toBe(1);
    expect(out[0]).toMatch(/räumlich verteilt|kein dominanter Knotenpunkt/);
  });

  test('ignores points without finite coordinates', () => {
    const pts = [
      { lat: NaN, lon: 9.7 },
      { lat: 52.0, lon: undefined },
      null,
      { lat: 52.0, lon: 9.7 },
      { lat: 52.0, lon: 9.7 }
    ];
    // Only 2 valid points → below threshold, no sentence.
    expect(UA.deriveSpatialArgumentation(pts)).toEqual([]);
  });
});
