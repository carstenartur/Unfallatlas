/**
 * Integration tests for topDeviations() in ua.export_v2.js
 * Verifies that CI fields (ciLow, ciHigh, isSignificant) are correctly populated.
 */

describe('topDeviations – CI integration', () => {
  let UA;

  // Helper: build a point with IstRad=1 (Rad solo, mask=1) at lat/lon within fake bounds
  function radPt(lat, lon) {
    return {
      lat,
      lon,
      props: {
        ukategorie: '3',
        year: '2022',
        ustunde: '10',
        uwochentag: '2',
        strzustand: '0',
        IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '0', IstSonstig: '0'
      }
    };
  }

  // Helper: build a PKW point (mask=4)
  function pkwPt(lat, lon) {
    return {
      lat,
      lon,
      props: {
        ukategorie: '3',
        year: '2022',
        ustunde: '10',
        uwochentag: '2',
        strzustand: '0',
        IstRad: '0', IstFuss: '0', IstPKW: '1', IstKrad: '0', IstGkfz: '0', IstSonstig: '0'
      }
    };
  }

  // Mask constants (6-bit: Rad=1, Fuß=2, PKW=4, Krad=8, Gkfz=16, Sonstig=32)
  const MASK_RAD = 1;
  const MASK_PKW = 4;

  // Fake bounds that cover lat 52.0-52.1, lon 9.7-9.8
  const fakeBounds = {
    getNorthEast: () => ({ lat: 52.1, lng: 9.8 }),
    getSouthWest: () => ({ lat: 52.0, lng: 9.7 }),
    getCenter: () => ({ lat: 52.05, lng: 9.75 }),
    // inBounds() calls b.contains([p.lat, p.lon])
    contains: (arr) => arr[0] >= 52.0 && arr[0] <= 52.1 && arr[1] >= 9.7 && arr[1] <= 9.8,
    pad: () => fakeBounds
  };

  // Minimal ui stub that passes all non-involvement filters (accept everything)
  const acceptAllUi = {
    severityEl:     { value: 'all' },
    roadConditionEl:{ value: 'all' },
    dayTypeEl:      { value: 'all' },
    hFromEl:        { value: '0' },
    hToEl:          { value: '23' }
  };

  beforeEach(() => {
    const mockWindow = { UA: {}, L: { latLngBounds: () => {} } };
    mockWindow.fetch = async () => ({ ok: false });

    const fs = require('fs');
    const path = require('path');

    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function(window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);

    const filtersPath = path.resolve(__dirname, '../../js/ua.filters.js');
    (function(window) { eval(fs.readFileSync(filtersPath, 'utf8')); })(mockWindow);

    const viewsPath = path.resolve(__dirname, '../../js/ua.accident_views.js');
    (function(window) { eval(fs.readFileSync(viewsPath, 'utf8')); })(mockWindow);

    const statsPath = path.resolve(__dirname, '../../js/ua.stats.js');
    (function(window) { eval(fs.readFileSync(statsPath, 'utf8')); })(mockWindow);

    const exportPath = path.resolve(__dirname, '../../js/ua.export_v2.js');
    (function(window) { eval(fs.readFileSync(exportPath, 'utf8')); })(mockWindow);

    UA = mockWindow.UA;
  });

  test('each focus row contains ciLow, ciHigh, isSignificant fields', () => {
    // Build baseline: 200 total, 40 Rad, 160 PKW (Rad base rate = 0.20)
    const allPts = [];
    // 40 Rad in the whole city (baseline)
    for (let i = 0; i < 40; i++) allPts.push(radPt(52.05, 9.75));
    // 160 PKW
    for (let i = 0; i < 160; i++) allPts.push(pkwPt(52.05, 9.75));

    const ctx = {
      allPts,
      drawBounds: fakeBounds,
      ui: acceptAllUi,
      CITY_RAW: 'TestCity'
    };

    const result = UA.topDeviations(ctx, fakeBounds);
    expect(result.rows.length).toBeGreaterThan(0);

    for (const r of result.rows) {
      expect(r).toHaveProperty('ciLow');
      expect(r).toHaveProperty('ciHigh');
      expect(r).toHaveProperty('isSignificant');
      expect(typeof r.ciLow).toBe('number');
      expect(typeof r.ciHigh).toBe('number');
      expect(typeof r.isSignificant).toBe('boolean');
      expect(r.ciLow).toBeGreaterThanOrEqual(0);
      expect(r.ciHigh).toBeLessThanOrEqual(1);
      expect(r.ciLow).toBeLessThanOrEqual(r.ciHigh);
    }
  });

  test('isSignificant=false when local n is small (k=3, n=10, baseR=0.20)', () => {
    // Local area: 3 Rad out of 10 total → locR=0.30, baseR from baseline
    // Baseline: 200 total, 40 Rad → baseR=0.20
    // Wilson CI for k=3, n=10: roughly [0.067, 0.652] – includes 0.20 → NOT significant
    const localPts = [];
    for (let i = 0; i < 3; i++) localPts.push(radPt(52.05, 9.75)); // within bounds
    for (let i = 0; i < 7; i++) localPts.push(pkwPt(52.05, 9.75));  // within bounds

    // Baseline via baselineCounts
    const baselineCounts = { total: 200, byMask: { [MASK_RAD]: 40, [MASK_PKW]: 160 } };

    const ctx = {
      allPts: localPts,
      drawBounds: fakeBounds,
      ui: acceptAllUi,
      baselineCounts,
      CITY_RAW: 'TestCity'
    };

    const result = UA.topDeviations(ctx, fakeBounds);
    const radRow = result.rows.find(r => r.mask === MASK_RAD);
    expect(radRow).toBeDefined();
    expect(radRow.isSignificant).toBe(false);
    expect(radRow.ciLow).toBeLessThanOrEqual(0.20);   // CI includes baseR
  });

  test('isSignificant=true when local n is large and clearly above baseline', () => {
    // Local: 80 Rad out of 100 → locR=0.80; baseline: 40/200=0.20
    // Wilson CI for k=80, n=100: roughly [0.71, 0.87] – both above 0.20 → significant
    const localPts = [];
    for (let i = 0; i < 80; i++) localPts.push(radPt(52.05, 9.75));
    for (let i = 0; i < 20; i++) localPts.push(pkwPt(52.05, 9.75));

    const baselineCounts = { total: 200, byMask: { [MASK_RAD]: 40, [MASK_PKW]: 160 } };

    const ctx = {
      allPts: localPts,
      drawBounds: fakeBounds,
      ui: acceptAllUi,
      baselineCounts,
      CITY_RAW: 'TestCity'
    };

    const result = UA.topDeviations(ctx, fakeBounds);
    const radRow = result.rows.find(r => r.mask === MASK_RAD);
    expect(radRow).toBeDefined();
    expect(radRow.isSignificant).toBe(true);
    expect(radRow.ciLow).toBeGreaterThan(0.20);  // CI entirely above baseR
  });

  test('focus rows inherit CI fields from rows', () => {
    // Focus rows should also have CI fields
    const localPts = [];
    for (let i = 0; i < 5; i++) localPts.push(radPt(52.05, 9.75));
    for (let i = 0; i < 5; i++) localPts.push(pkwPt(52.05, 9.75));

    const baselineCounts = { total: 200, byMask: { [MASK_RAD]: 20, [MASK_PKW]: 180 } };

    const ctx = {
      allPts: localPts,
      drawBounds: fakeBounds,
      ui: acceptAllUi,
      baselineCounts,
      CITY_RAW: 'TestCity'
    };

    const result = UA.topDeviations(ctx, fakeBounds);
    for (const r of result.focus) {
      expect(r).toHaveProperty('ciLow');
      expect(r).toHaveProperty('ciHigh');
      expect(r).toHaveProperty('isSignificant');
    }
  });

  test('isSignificant=true even when baseR=0 (city baseline lacks the mask)', () => {
    // Local: 5 Rad / 0 PKW. Baseline: zero Rad ever recorded city-wide
    // → baseR=0; Wilson CI for k=5,n=5 is roughly [0.57, 1.0] which strictly
    //   excludes baseR=0 → the pattern MUST be marked significant.
    // Regression guard: previously the guard `baseR > 0` forced isSignificant
    // to false in this case (review point #2 on PR #221).
    const localPts = [];
    for (let i = 0; i < 5; i++) localPts.push(radPt(52.05, 9.75));

    const baselineCounts = { total: 200, byMask: { [MASK_PKW]: 200 } }; // no Rad in baseline

    const ctx = {
      allPts: localPts,
      drawBounds: fakeBounds,
      ui: acceptAllUi,
      baselineCounts,
      CITY_RAW: 'TestCity'
    };

    const result = UA.topDeviations(ctx, fakeBounds);
    const radRow = result.rows.find(r => r.mask === MASK_RAD);
    expect(radRow).toBeDefined();
    expect(radRow.baseR).toBe(0);
    expect(radRow.ciLow).toBeGreaterThan(0);
    expect(radRow.isSignificant).toBe(true);
  });
});
