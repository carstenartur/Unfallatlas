'use strict';

/**
 * Hot-path regression: js/ua.data_v2.js MUST keep working unchanged on
 * both the old (un-enriched) and the new (enriched) per-city GeoJSON
 * format. This is the explicit contract of plan §C.6 — the loader
 * takes no dependency on enrichment fields, reading them is a free
 * `?.` away for any UI module that wants them.
 */

const fs   = require('fs');
const path = require('path');

function loadDataModule() {
  const win = { UA: {} };
  // ua.data_v2.js depends on UA.normKey from ua.utils.js — provide a
  // minimal stub so we don't have to load the full utils file just for
  // this read-side regression.
  win.UA.normKey = (s) => String(s ?? '').toLowerCase();
  const filePath = path.resolve(__dirname, '../../js/ua.data_v2.js');
  (function (window) { eval(fs.readFileSync(filePath, 'utf8')); })(win);
  return win.UA;
}

describe('UA.extractPoints — backward-compatibility with un-enriched files', () => {
  test('parses a vanilla pre-enrichment FeatureCollection (the format on disk today)', () => {
    const UA = loadDataModule();
    const gj = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
          properties: { id: '1', ukategorie: '2', istrad: '0', istpkw: '1' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.2, 50.8] },
          properties: { id: '2', ukategorie: '3', istrad: '1', istpkw: '0' } },
      ],
    };
    const pts = UA.extractPoints(gj);
    expect(pts).toHaveLength(2);
    expect(pts[0]).toEqual({ lat: 50.7, lon: 7.1, props: gj.features[0].properties });
    expect(pts[0].props.elevation_m).toBeUndefined();
  });

  test('parses an enriched FeatureCollection identically and exposes new fields via .props', () => {
    const UA = loadDataModule();
    const gj = {
      type: 'FeatureCollection',
      // The new top-level enrichmentDicts must NOT confuse the loader.
      properties: { enrichmentDicts: { highway: ['residential'] } },
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
          properties: {
            id: '1', ukategorie: '2', istrad: '0', istpkw: '1',
            // New optional enrichment fields:
            matched_way_id: 'W1', elevation_m: 123.5, slope_class: 'steep',
            traffic_proxy_class: 'high',
          },
        },
      ],
    };
    const pts = UA.extractPoints(gj);
    expect(pts).toHaveLength(1);
    expect(pts[0].lat).toBe(50.7);
    expect(pts[0].lon).toBe(7.1);
    // Old fields untouched
    expect(pts[0].props.ukategorie).toBe('2');
    // New fields available for any UI module that opts in
    expect(pts[0].props.elevation_m).toBe(123.5);
    expect(pts[0].props.matched_way_id).toBe('W1');
    expect(pts[0].props.traffic_proxy_class).toBe('high');
  });

  test('drops invalid geometries the same way it always did', () => {
    const UA = loadDataModule();
    const gj = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] }, properties: { id: '1' } },
        { type: 'Feature', geometry: { type: 'LineString', coordinates: [[1,1],[2,2]] }, properties: { id: '2' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: ['x', 'y'] }, properties: { id: '3' } },
        { type: 'Feature', geometry: null, properties: { id: '4' } },
      ],
    };
    const pts = UA.extractPoints(gj);
    expect(pts).toHaveLength(1);
    expect(pts[0].props.id).toBe('1');
  });
});

describe('URL builders are unaffected by enrichment', () => {
  test('buildDataUrl still points at the original per-city GeoJSON', () => {
    const UA = loadDataModule();
    expect(UA.buildDataUrl('Bonn')).toBe('out/output_all_years_bonn.geojson');
  });
});

describe('UA.loadCityData — PR-C lazy load wiring for ways_<city>.json', () => {
  function loadDataAndContextLayers(opts) {
    const fs = require('fs');
    const path = require('path');
    // The lazy loader (UA.contextLayers.loadAtIdle) closes over `window`
    // captured at module-evaluation time. To deterministically exercise
    // the requestIdleCallback branch (rather than the setTimeout
    // fallback), install the shim on the `win` sandbox *before* the
    // module sources are evaluated. opts.idle = false skips the shim
    // so we can also cover the setTimeout fallback path on demand.
    const win = { UA: {}, location: { href: 'http://localhost/' } };
    if (!opts || opts.idle !== false) {
      win.requestIdleCallback = (cb) => cb();
    }
    win.UA.normKey = (s) => String(s ?? '').toLowerCase();
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
    };
    load('ua.context_layers.js');
    load('ua.data_v2.js');
    return win.UA;
  }

  test('triggers loadAtIdle and stashes resolved state on ctx.contextLayerState when hasOsmContext', async () => {
    const UA = loadDataAndContextLayers();
    UA.contextLayers.clearCache();

    const fcGeojson = {
      type: 'FeatureCollection',
      properties: { enrichmentDicts: { highway: ['residential'] } },
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [7.1, 50.7] },
        properties: { id: '1', matched_way_id: 'W1', elevation_m: 1 },
      }],
    };
    const waysJson = { 'W1': { highway: 0, maxspeed: 30 } };

    let calls = 0;
    global.fetch = (url) => {
      calls++;
      if (url.endsWith('output_all_years_bonn.geojson')) {
        return Promise.resolve({ ok: true, json: async () => fcGeojson });
      }
      if (url.endsWith('ways_bonn.json')) {
        return Promise.resolve({ ok: true, json: async () => waysJson });
      }
      // sidecar meta is optional → 404
      return Promise.resolve({ ok: false });
    };

    try {
      const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: null } } };
      await UA.loadCityData(ctx);
      expect(ctx.contextCapabilities.hasOsmContext).toBe(true);
      // loadAtIdle is fire-and-forget — flush microtasks.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(ctx.contextLayerState).toBeTruthy();
      expect(ctx.contextLayerState.ways).toEqual(waysJson);
      expect(ctx.contextLayerState.dicts).toEqual({ highway: ['residential'] });
      expect(calls).toBeGreaterThanOrEqual(2);
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('does NOT trigger lazy load when geojson has no OSM context fields', async () => {
    const UA = loadDataAndContextLayers();
    UA.contextLayers.clearCache();
    const fcGeojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [7.1, 50.7] },
        properties: { id: '1', ukategorie: '2' },
      }],
    };
    const fetched = [];
    global.fetch = (url) => {
      fetched.push(url);
      return Promise.resolve({ ok: true, json: async () => fcGeojson });
    };
    try {
      const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: null } } };
      await UA.loadCityData(ctx);
      await new Promise((r) => setTimeout(r, 0));
      expect(ctx.contextCapabilities.hasOsmContext).toBe(false);
      expect(ctx.contextLayerState).toBeNull();
      // Only the geojson was fetched — no ways_*.json / sidecar requests.
      expect(fetched.filter((u) => u.includes('ways_'))).toHaveLength(0);
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('city-switch race: late-resolving ways for previous city does NOT overwrite new state', async () => {
    const UA = loadDataAndContextLayers();
    UA.contextLayers.clearCache();
    const bonnGeojson = {
      type: 'FeatureCollection',
      properties: { enrichmentDicts: {} },
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
        properties: { id: '1', matched_way_id: 'W1' } }],
    };
    let resolveWays;
    global.fetch = (url) => {
      if (url.endsWith('output_all_years_bonn.geojson')) {
        return Promise.resolve({ ok: true, json: async () => bonnGeojson });
      }
      if (url.endsWith('ways_bonn.json')) {
        // Defer the resolution so we can flip ctx.CITY_RAW first.
        return new Promise((res) => { resolveWays = () => res({ ok: true, json: async () => ({ 'W1': { highway: 0 } }) }); });
      }
      return Promise.resolve({ ok: false });
    };
    try {
      const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: null } } };
      await UA.loadCityData(ctx);
      // User switched city before ways_*.json finished loading.
      ctx.CITY_RAW = 'Köln';
      // Now let the deferred ways response resolve.
      resolveWays();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      // The stale Bonn payload must NOT be stashed into the new ctx.
      expect(ctx.contextLayerState).toBeNull();
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('triggers a lightweight UA.renderLayers re-render when state arrives AFTER markers were built (cluster/heat layer present)', async () => {
    const UA = loadDataAndContextLayers();
    UA.contextLayers.clearCache();
    const gj = {
      type: 'FeatureCollection',
      properties: { enrichmentDicts: {} },
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
        properties: { id: '1', matched_way_id: 'W1' } }],
    };
    global.fetch = (url) => {
      if (url.endsWith('output_all_years_bonn.geojson')) return Promise.resolve({ ok: true, json: async () => gj });
      if (url.endsWith('ways_bonn.json')) return Promise.resolve({ ok: true, json: async () => ({ 'W1': { highway: 0 } }) });
      return Promise.resolve({ ok: false });
    };
    try {
      let renderCalls = 0;
      UA.renderLayers = (c) => { renderCalls++; expect(c._dataChanged).toBe(true); };
      // Simulate an already-rendered map: clusterLayer present.
      const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: null } }, map: {}, clusterLayer: {} };
      await UA.loadCityData(ctx);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(renderCalls).toBeGreaterThanOrEqual(1);
      expect(ctx.contextLayerState).toBeTruthy();
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('skips the post-load re-render when no marker layer has been built yet (perf hardening for large GeoJSON)', async () => {
    // Defense in depth: if ways_<city>.json finishes BEFORE the first
    // renderLayers() call (typical fast-cache hit), the imminent first
    // render will already see ctx.contextLayerState and there is no
    // already-bound popup that needs refreshing — re-rendering would
    // be a wasted full marker rebuild for huge cities.
    const UA = loadDataAndContextLayers();
    UA.contextLayers.clearCache();
    const gj = {
      type: 'FeatureCollection',
      properties: { enrichmentDicts: {} },
      features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
        properties: { id: '1', matched_way_id: 'W1' } }],
    };
    global.fetch = (url) => {
      if (url.endsWith('output_all_years_bonn.geojson')) return Promise.resolve({ ok: true, json: async () => gj });
      if (url.endsWith('ways_bonn.json')) return Promise.resolve({ ok: true, json: async () => ({ 'W1': { highway: 0 } }) });
      return Promise.resolve({ ok: false });
    };
    try {
      let renderCalls = 0;
      UA.renderLayers = () => { renderCalls++; };
      // No clusterLayer / heatLayer on ctx → first render hasn't run yet.
      const ctx = { CITY_RAW: 'Bonn', ui: { dataSourceCode: { textContent: null } }, map: {} };
      await UA.loadCityData(ctx);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(renderCalls).toBe(0);
      // The state must still be stashed so the imminent first render picks it up.
      expect(ctx.contextLayerState).toBeTruthy();
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });
});
