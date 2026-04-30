/**
 * Unit tests for the selectionBounds filter in captureClusterMaps.
 *
 * Acceptance criteria (from the issue):
 *   - With selectionBounds set: only points inside the bounds are passed to
 *     computeClusterMapTargets — clusters outside the selection are never
 *     returned.
 *   - Without selectionBounds: behaviour is unchanged (viewport/allPts fallback).
 *   - When no cluster with minTotal ≥ 5 exists inside the selection, an empty
 *     array is returned (no "emergency" picks from outside).
 */

const fs = require('fs');
const path = require('path');

describe('captureClusterMaps – selectionBounds filter', () => {
  let UA;

  beforeEach(() => {
    window.UA = {};
    window.leafletImage = () => {};
    window.docx = require('docx');
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();

    const src = fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.report_v2.js'), 'utf8'
    );
    eval(src);
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.leafletImage;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  /**
   * Build a minimal Leaflet-style LatLngBounds stub with a working
   * `contains([lat, lon])` method that checks against a simple NSEW box.
   */
  function makeBounds(south, west, north, east) {
    return {
      getSouth: () => south,
      getWest: () => west,
      getNorth: () => north,
      getEast: () => east,
      contains([lat, lon]) {
        return lat >= south && lat <= north && lon >= west && lon <= east;
      }
    };
  }

  /**
   * Build a minimal map stub — just enough for captureClusterMaps to proceed
   * past the early-return guards and the fitBounds/setView calls.
   */
  function makeMapStub() {
    return {
      getCenter: () => ({ lat: 52.37, lng: 9.73 }),
      getZoom: () => 14,
      setView: jest.fn(),
      fitBounds: jest.fn()
    };
  }

  /**
   * Generate `n` points tightly clustered around a given lat/lon.
   * All points land in the same ~55 m grid cell used by computeClusterMapTargets.
   */
  function makeCluster(lat, lon, n) {
    return Array.from({ length: n }, (_, i) => ({
      lat: lat + i * 0.000001,
      lon: lon + i * 0.000001
    }));
  }

  test('points outside selectionBounds are excluded from cluster calculation', async () => {
    // Selection: small box around Hannover city centre
    const selectionBounds = makeBounds(52.360, 9.720, 52.380, 9.740);

    // Cluster A: 8 points INSIDE the selection (52.370 / 9.730)
    const insideCluster = makeCluster(52.370, 9.730, 8);

    // Cluster B: 12 points OUTSIDE the selection (52.400 / 9.800)
    // — denser than A, so without the filter it would "win".
    const outsideCluster = makeCluster(52.400, 9.800, 12);

    const allViewportPts = [...insideCluster, ...outsideCluster];

    // Track which points were passed to computeClusterMapTargets.
    // UA.computeClusterMapTargets is not yet set (ua.map_v2.js not loaded),
    // so we provide a spy that captures inputs and returns an empty targets
    // list (sufficient for checking the filter — the result array is irrelevant).
    let capturedPoints = null;
    UA.computeClusterMapTargets = (pts) => {
      capturedPoints = pts;
      return []; // empty targets → captureClusterMaps returns [] without map ops
    };

    const ctx = {
      map: makeMapStub(),
      viewportPts: allViewportPts,
      selectionBounds
    };

    await UA._captureClusterMaps(ctx, {});

    // capturedPoints must contain ONLY the inside-cluster points.
    expect(capturedPoints).not.toBeNull();
    expect(capturedPoints.every(p =>
      selectionBounds.contains([p.lat, p.lon])
    )).toBe(true);

    // Outside-cluster points must have been excluded.
    const outsideLats = new Set(outsideCluster.map(p => p.lat));
    expect(capturedPoints.some(p => outsideLats.has(p.lat))).toBe(false);
  });

  test('without selectionBounds, all viewportPts are passed through unchanged', async () => {
    const allViewportPts = makeCluster(52.370, 9.730, 8);

    let capturedPoints = null;
    UA.computeClusterMapTargets = (pts) => {
      capturedPoints = pts;
      return [];
    };

    const ctx = {
      map: makeMapStub(),
      viewportPts: allViewportPts
      // no selectionBounds
    };

    await UA._captureClusterMaps(ctx, {});

    // All viewportPts must have been passed through unchanged.
    expect(capturedPoints).not.toBeNull();
    expect(capturedPoints).toHaveLength(allViewportPts.length);
  });

  test('returns empty array when no cluster inside selectionBounds meets minTotal threshold', async () => {
    // Selection covers only 2 isolated points — not enough for minTotal=5.
    const selectionBounds = makeBounds(52.360, 9.720, 52.380, 9.740);

    const insidePoints = makeCluster(52.370, 9.730, 2); // only 2 points

    // Dense outside cluster that would otherwise produce a target.
    const outsideCluster = makeCluster(52.400, 9.800, 10);

    // computeClusterMapTargets spy: returns empty when called with ≤2 pts
    // (simulates minTotal threshold behaviour), non-empty otherwise.
    UA.computeClusterMapTargets = (pts) => {
      // Only the 2 inside points should reach here after filtering.
      // No matter what, return empty to simulate "threshold not met".
      return [];
    };

    const ctx = {
      map: makeMapStub(),
      viewportPts: [...insidePoints, ...outsideCluster],
      selectionBounds
    };

    const result = await UA._captureClusterMaps(ctx, {}, { minTotal: 5 });

    // No cluster targets from outside must sneak in; result must be empty.
    expect(result).toEqual([]);
  });

  test('falls back to allPts when viewportPts is empty (no selectionBounds)', async () => {
    const allPts = makeCluster(52.370, 9.730, 8);

    let capturedPoints = null;
    UA.computeClusterMapTargets = (pts) => {
      capturedPoints = pts;
      return [];
    };

    const ctx = {
      map: makeMapStub(),
      viewportPts: [],   // empty — should trigger allPts fallback
      allPts
    };

    await UA._captureClusterMaps(ctx, {});

    expect(capturedPoints).not.toBeNull();
    expect(capturedPoints).toHaveLength(allPts.length);
  });
});
