/**
 * Regression test: captureClusterMaps must restrict cluster-target
 * candidates to points inside ctx.selectionBounds when the user has drawn
 * a selection rectangle. Without this filter, computeClusterMapTargets
 * picks dominant hotspots from anywhere in the viewport, even if the user
 * narrowed the analysis to a specific area — producing cluster maps that
 * are unrelated to the marked rectangle.
 *
 * The filter was originally added in commit 0cd9fba and was accidentally
 * removed during the „Export-Semantik vor Layout" refactor; this test
 * pins the behaviour so it cannot silently regress again.
 */

const fs = require('fs');
const path = require('path');

describe('captureClusterMaps – selectionBounds filter', () => {
  let UA;
  let computeArg;

  beforeEach(() => {
    const win = { UA: {}, location: { href: 'http://localhost/' }, L: { latLngBounds: () => null } };
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function (window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(win);
    const reportPath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    (function (window) { eval(fs.readFileSync(reportPath, 'utf8')); })(win);
    UA = win.UA;

    // Replace computeClusterMapTargets to capture the points it is called with.
    computeArg = null;
    UA.computeClusterMapTargets = (pts) => {
      computeArg = pts;
      return []; // no targets → captureClusterMaps returns []
    };
  });

  function makeCtx(selectionBounds) {
    return {
      map: {
        getCenter: () => ({ lat: 52.37, lng: 9.73 }),
        getZoom: () => 14,
        setView: () => {},
        fitBounds: () => {}
      },
      viewportPts: [
        { lat: 52.37, lon: 9.73 },  // inside
        { lat: 52.50, lon: 9.50 },  // outside
        { lat: 52.371, lon: 9.731 } // inside
      ],
      selectionBounds
    };
  }

  test('with selectionBounds.contains: filters points to those inside the rectangle', async () => {
    const sb = {
      contains: ([lat, lon]) => lat >= 52.36 && lat <= 52.38 && lon >= 9.72 && lon <= 9.74
    };
    const ctx = makeCtx(sb);

    // captureClusterMaps is exposed as UA._captureClusterMaps for testing.
    await UA._captureClusterMaps(ctx, {});

    expect(computeArg).toBeDefined();
    expect(computeArg.length).toBe(2);
    for (const p of computeArg) {
      expect(p.lat).toBeGreaterThanOrEqual(52.36);
      expect(p.lat).toBeLessThanOrEqual(52.38);
    }
  });

  test('without selectionBounds.contains: no filtering — all points are forwarded', async () => {
    const ctx = makeCtx(null);
    await UA._captureClusterMaps(ctx, {});
    expect(computeArg).toBeDefined();
    expect(computeArg.length).toBe(3);
  });
});
