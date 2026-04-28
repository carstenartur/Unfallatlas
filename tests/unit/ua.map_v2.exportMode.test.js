/**
 * Tests for the export-map helpers in ua.map_v2.js:
 *  - UA.computeClusterMapTargets   (pure function, no Leaflet)
 *  - UA.beginExportMapMode / UA.endExportMapMode (round-trip with stubbed Leaflet)
 *
 * These helpers drive the multi-map export pipeline (Tasks 1–5 of the
 * "improve PDF map visualization" brief): high-contrast accident points
 * overlaid on a dimmed heatmap, plus zoomed cluster maps centered on
 * actual coordinate centroids.
 */

describe('ua.map_v2 export helpers', () => {
  let UA;
  let win;

  // Minimal Leaflet stub — we only need the surface UA.beginExportMapMode
  // touches: layerGroup() with addTo(map)/remove(), circleMarker()
  // (ignored payload), and a map with addLayer/removeLayer.
  function makeLeafletStub() {
    const removed = [];
    const added = [];
    function makeLayer(kind) {
      const layer = {
        kind,
        children: [],
        addTo(m) { (m.addLayer && m.addLayer(layer)); return layer; },
        remove() { layer._removed = true; }
      };
      return layer;
    }
    return {
      added,
      removed,
      stub: {
        layerGroup: () => {
          const lg = makeLayer('group');
          // A real layerGroup proxies addLayer() to its children.
          lg.addLayer = (m) => { lg.children.push(m); return lg; };
          return lg;
        },
        circleMarker: (latlng, opts) => {
          const m = { latlng, opts, addTo(layer) { layer.children.push(m); return m; } };
          return m;
        }
      }
    };
  }

  function loadModules(extraWin) {
    const fs = require('fs');
    const path = require('path');
    win = Object.assign({ UA: {}, location: { href: 'http://localhost/' } }, extraWin || {});
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.map_v2.js');
    UA = win.UA;
  }

  // ---------------------------------------------------------------
  // UA.computeClusterMapTargets — pure helper, deterministic.
  // ---------------------------------------------------------------
  describe('UA.computeClusterMapTargets', () => {
    beforeEach(() => {
      // computeTopHotspots itself is Leaflet-free; provide a no-op L
      // so the surrounding module loads cleanly.
      loadModules({ L: {} });
    });

    test('returns no targets when there are no real hotspots', () => {
      const pts = [
        { lat: 52.0, lon: 9.7, props: { istrad: '1' } },
        { lat: 52.1, lon: 9.8, props: { istrad: '1' } },
        { lat: 52.2, lon: 9.9, props: { istrad: '1' } }
      ];
      expect(UA.computeClusterMapTargets(pts, { minTotal: 5 })).toEqual([]);
    });

    test('chooses zoom level by point density (≥20 → 19, ≥10 → 18, else → 17)', () => {
      // One dense cluster of 22 points → zoom 19.
      const dense = [];
      for (let i = 0; i < 22; i++) dense.push({ lat: 52.37500 + i * 0.000005, lon: 9.73000 + i * 0.000005, props: {} });
      const denseTargets = UA.computeClusterMapTargets(dense, { minTotal: 2 });
      expect(denseTargets.length).toBe(1);
      expect(denseTargets[0].zoom).toBe(19);
      expect(denseTargets[0].total).toBe(22);
      expect(denseTargets[0].label).toBe('Hauptcluster');

      // 12 points → zoom 18.
      const mid = [];
      for (let i = 0; i < 12; i++) mid.push({ lat: 52.37500 + i * 0.000005, lon: 9.73000 + i * 0.000005, props: {} });
      expect(UA.computeClusterMapTargets(mid, { minTotal: 2 })[0].zoom).toBe(18);

      // 6 points → zoom 17.
      const small = [];
      for (let i = 0; i < 6; i++) small.push({ lat: 52.37500 + i * 0.000005, lon: 9.73000 + i * 0.000005, props: {} });
      expect(UA.computeClusterMapTargets(small, { minTotal: 2 })[0].zoom).toBe(17);
    });

    test('emits up to two targets when clusters are far enough apart', () => {
      const pts = [];
      // Cluster A around (52.37500, 9.73000) – 8 pts.
      for (let i = 0; i < 8; i++) pts.push({ lat: 52.37500 + i * 0.000005, lon: 9.73000 + i * 0.000005, props: {} });
      // Cluster B ~700 m away – 6 pts.
      for (let i = 0; i < 6; i++) pts.push({ lat: 52.38000 + i * 0.000005, lon: 9.73500 + i * 0.000005, props: {} });
      const t = UA.computeClusterMapTargets(pts, { minTotal: 2 });
      expect(t.length).toBe(2);
      expect(t[0].label).toBe('Hauptcluster');
      expect(t[1].label).toBe('Sekundärcluster');
      expect(t[0].total).toBeGreaterThanOrEqual(t[1].total);
    });

    test('drops the secondary target when it is too close to the primary (no duplicate maps)', () => {
      const pts = [];
      // Two cells ~50 m apart – within minSeparationM=200.
      for (let i = 0; i < 6; i++) pts.push({ lat: 52.37500 + i * 0.000005, lon: 9.73000 + i * 0.000005, props: {} });
      for (let i = 0; i < 5; i++) pts.push({ lat: 52.37550 + i * 0.000005, lon: 9.73020 + i * 0.000005, props: {} });
      const t = UA.computeClusterMapTargets(pts, { minTotal: 2, minSeparationM: 200 });
      expect(t.length).toBe(1);
    });

    test('respects maxTargets=0 → empty result', () => {
      const pts = Array.from({ length: 8 }, (_, i) => ({ lat: 52.375 + i * 0.000005, lon: 9.73 + i * 0.000005, props: {} }));
      expect(UA.computeClusterMapTargets(pts, { maxTargets: 0, minTotal: 2 })).toEqual([]);
    });
  });

  // ---------------------------------------------------------------
  // UA.beginExportMapMode / endExportMapMode — round-trip on a
  // stubbed Leaflet map. We verify that:
  //  - severity overlay is added,
  //  - heat opacity is dimmed and restored,
  //  - end is idempotent and survives a missing token.
  // ---------------------------------------------------------------
  describe('UA.beginExportMapMode / endExportMapMode', () => {
    let added;

    beforeEach(() => {
      const { stub } = makeLeafletStub();
      loadModules({ L: stub });
      added = [];
    });

    function makeCtx(extra) {
      const map = {
        layers: [],
        addLayer(l) { this.layers.push(l); added.push(l); return this; },
        removeLayer(l) { this.layers = this.layers.filter(x => x !== l); }
      };
      return Object.assign({
        map,
        viewportPts: [
          { lat: 52.37, lon: 9.73, props: { ukategorie: '1' } },
          { lat: 52.371, lon: 9.731, props: { ukategorie: '2' } },
          { lat: 52.372, lon: 9.732, props: { ukategorie: '3' } }
        ]
      }, extra || {});
    }

    test('adds an overlay layer and dims the heatmap canvas, end restores both', () => {
      const heatCanvas = { style: { opacity: '0.6' } };
      const ctx = makeCtx({ heatLayer: { _canvas: heatCanvas } });
      const tok = UA.beginExportMapMode(ctx);
      expect(tok.active).toBe(true);
      expect(tok.layer).toBeTruthy();
      // Three valid points → overlay layer should now hold three children.
      expect(tok.layer.children.length).toBe(3);
      // Heat opacity should have been clamped down to ≤ 0.35.
      expect(parseFloat(heatCanvas.style.opacity)).toBeLessThanOrEqual(0.35);

      UA.endExportMapMode(ctx, tok);
      expect(tok.layer === null || tok.layer._removed === true).toBe(true);
      // Original opacity (0.6) restored.
      expect(heatCanvas.style.opacity).toBe('0.6');
      expect(ctx._exportMapToken).toBeFalsy();
    });

    test('skips invalid coordinates – overlay only contains the valid ones', () => {
      const ctx = makeCtx({
        viewportPts: [
          { lat: 52.37, lon: 9.73, props: { ukategorie: '1' } },
          { lat: NaN, lon: 9.73, props: { ukategorie: '1' } },
          null,
          { lat: 52.38, lon: undefined, props: { ukategorie: '1' } }
        ]
      });
      const tok = UA.beginExportMapMode(ctx);
      expect(tok.layer.children.length).toBe(1);
      UA.endExportMapMode(ctx, tok);
    });

    test('is idempotent: a second begin returns the same token, end is safe to call twice', () => {
      const ctx = makeCtx();
      const t1 = UA.beginExportMapMode(ctx);
      const t2 = UA.beginExportMapMode(ctx);
      expect(t2).toBe(t1);
      UA.endExportMapMode(ctx, t1);
      expect(() => UA.endExportMapMode(ctx, t1)).not.toThrow();
    });

    test('end without a token is a no-op (graceful fallback)', () => {
      const ctx = makeCtx();
      expect(() => UA.endExportMapMode(ctx, null)).not.toThrow();
      expect(() => UA.endExportMapMode(ctx)).not.toThrow();
    });

    test('returns inactive token when ctx has no map (no crash)', () => {
      const tok = UA.beginExportMapMode({});
      expect(tok.active).toBe(false);
      expect(tok.layer).toBe(null);
    });
  });
});
