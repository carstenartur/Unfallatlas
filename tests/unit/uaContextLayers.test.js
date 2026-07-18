'use strict';

/**
 * Tests for js/ua.context_layers.js
 *
 * Covers the lazy loader, the field-detection probe, the dictionary
 * resolution, and the hot-path regression: a FeatureCollection with no
 * enrichment fields at all must still report `availableFields == []`
 * without throwing or doing any I/O.
 */

const fs   = require('fs');
const path = require('path');

function loadModule() {
  const win = { UA: {}, requestIdleCallback: undefined };
  const filePath = path.resolve(__dirname, '../../js/ua.context_layers.js');
  const src = fs.readFileSync(filePath, 'utf8');
  // The module references `window.UA`; emulate that.
  (function (window) { eval(src); })(win);
  return win.UA;
}

describe('UA.contextLayers — public API surface', () => {
  test('exposes detect / load / loadAtIdle / resolveWay', () => {
    const UA = loadModule();
    expect(typeof UA.contextLayers.detect).toBe('function');
    expect(typeof UA.contextLayers.load).toBe('function');
    expect(typeof UA.contextLayers.loadAtIdle).toBe('function');
    expect(typeof UA.contextLayers.resolveWay).toBe('function');
    expect(Array.isArray(UA.contextLayers.PER_FEATURE_FIELDS)).toBe(true);
  });
});

describe('UA.contextLayers.detect — backward-compatibility regression', () => {
  test('un-enriched FeatureCollection (the current on-disk format) is handled gracefully', () => {
    const UA = loadModule();
    const gj = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
          properties: { id: '1', ukategorie: '2' } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.2, 50.8] },
          properties: { id: '2', ukategorie: '3' } },
      ],
    };
    const r = UA.contextLayers.detect(gj);
    expect(r.availableFields).toEqual([]);
    expect(r.hasDicts).toBe(false);
  });

  test('enriched FeatureCollection reports the fields actually present', () => {
    const UA = loadModule();
    const gj = {
      type: 'FeatureCollection',
      properties: { enrichmentDicts: { highway: ['residential'] } },
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
          properties: {
            id: '1',
            matched_way_id: 'W1',
            elevation_m: 123.4,
            slope_class: 'very_steep',
            traffic_proxy_class: 'very_high',
            highway: 'residential',
            road_slope_percent: 4.2,
          } },
      ],
    };
    const r = UA.contextLayers.detect(gj);
    expect(r.hasDicts).toBe(true);
    expect(r.availableFields).toEqual(expect.arrayContaining([
      'matched_way_id', 'elevation_m', 'slope_class', 'traffic_proxy_class', 'highway', 'road_slope_percent',
    ]));
    // Fields not on the sample stay out of the list (no false positives).
    expect(r.availableFields).not.toContain('slope_source');
  });

  test('handles malformed input without throwing', () => {
    const UA = loadModule();
    expect(() => UA.contextLayers.detect(null)).not.toThrow();
    expect(() => UA.contextLayers.detect({})).not.toThrow();
    expect(UA.contextLayers.detect(null).availableFields).toEqual([]);
  });
});

describe('UA.contextLayers.resolveWay — int-code → string round-trip', () => {
  test('maps int-coded categoricals back via the dictionaries', () => {
    const UA = loadModule();
    const state = {
      ways: { 'W1': { highway: 1, maxspeed: 30, lanes: 2 } },
      dicts: { highway: ['residential', 'secondary'] },
    };
    expect(UA.contextLayers.resolveWay(state, 'W1'))
      .toEqual({ highway: 'secondary', maxspeed: 30, lanes: 2 });
  });

  test('passes through fields that have no dictionary', () => {
    const UA = loadModule();
    const state = { ways: { 'W1': { osm_incline: 'up', maxspeed: 50 } }, dicts: {} };
    expect(UA.contextLayers.resolveWay(state, 'W1'))
      .toEqual({ osm_incline: 'up', maxspeed: 50 });
  });

  test('returns null for unknown ways', () => {
    const UA = loadModule();
    expect(UA.contextLayers.resolveWay({ ways: {}, dicts: {} }, 'WX')).toBeNull();
    expect(UA.contextLayers.resolveWay(null, 'W1')).toBeNull();
  });

  test('does not mutate its input', () => {
    const UA = loadModule();
    const state = { ways: { 'W1': { highway: 0 } }, dicts: { highway: ['residential'] } };
    const before = JSON.stringify(state);
    UA.contextLayers.resolveWay(state, 'W1');
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('UA.contextLayers.load — lazy + cached', () => {
  test('caches per city: load() returns the same Promise on repeated calls', () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    // Stub fetch so no real network access happens. We only need to
    // verify the caching contract here, not the network round-trip.
    const calls = [];
    global.fetch = (url) => {
      calls.push(url);
      return Promise.resolve({ ok: false });
    };
    try {
      const p1 = UA.contextLayers.load({}, 'Bonn');
      const p2 = UA.contextLayers.load({}, 'Bonn');
      expect(p1).toBe(p2);
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('reads dicts from ctx.geojsonProps.enrichmentDicts (doc-aligned path)', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    global.fetch = () => Promise.resolve({ ok: false });
    try {
      const ctx = { geojsonProps: { enrichmentDicts: { highway: ['residential', 'secondary'] } } };
      const state = await UA.contextLayers.load(ctx, 'Bonn');
      expect(state.dicts).toEqual({ highway: ['residential', 'secondary'] });
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('falls back to ctx.enrichmentDicts when geojsonProps is absent (back-compat)', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    global.fetch = () => Promise.resolve({ ok: false });
    try {
      const ctx = { enrichmentDicts: { highway: ['x'] } };
      const state = await UA.contextLayers.load(ctx, 'Köln');
      expect(state.dicts).toEqual({ highway: ['x'] });
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('v2 ways_<city>.json shape — parses { ways, geometries } into state.ways + state.geometries', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    const v2 = {
      schemaVersion: 2,
      ways: { 'W1': { highway: 0 } },
      geometries: { 'W1': [50, 7, 50.001, 7.001] },
    };
    global.fetch = (url) => {
      if (url.endsWith('ways_bonn.json')) return Promise.resolve({ ok: true, json: async () => v2 });
      return Promise.resolve({ ok: false });
    };
    try {
      const state = await UA.contextLayers.load({}, 'Bonn');
      expect(state.ways).toEqual({ 'W1': { highway: 0 } });
      expect(state.geometries).toEqual({ 'W1': [50, 7, 50.001, 7.001] });
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('v3 sidecar path: load() reads tileIndexPath from *.enrichment.meta.json and builds tile URL index', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    const meta = {
      schemaVersion: 3,
      tileIndexPath: 'ctxtiles/bonn/index.json',
    };
    const manifest = {
      schemaVersion: 3,
      z: 13,
      tiles: [{ x: 4280, y: 2730 }],
    };
    global.fetch = (url) => {
      if (url.endsWith('ways_bonn.json')) return Promise.resolve({ ok: false });
      if (url.endsWith('output_all_years_bonn.enrichment.meta.json')) return Promise.resolve({ ok: true, json: async () => meta });
      if (url.endsWith('ctxtiles/bonn/index.json')) return Promise.resolve({ ok: true, json: async () => manifest });
      return Promise.resolve({ ok: false });
    };
    try {
      const state = await UA.contextLayers.load({}, 'Bonn');
      expect(state.tileIndex).toBeTruthy();
      expect(state.tileIndexUrl).toBe('out/ctxtiles/bonn/index.json');
      expect(state.tileIndex.tileUrlByKey.get('4280/2730')).toBe('out/ctxtiles/bonn/4280/2730.json');
      expect(state.ways).toEqual({});
      expect(state.geometries).toEqual({});
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('v3 sidecar path normalizes backslashes in tileIndexPath', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    const meta = {
      schemaVersion: 3,
      tileIndexPath: 'ctxtiles\\bonn\\index.json',
    };
    const manifest = { schemaVersion: 3, z: 13, tiles: [{ x: 4280, y: 2730 }] };
    global.fetch = (url) => {
      if (url.endsWith('ways_bonn.json')) return Promise.resolve({ ok: false });
      if (url.endsWith('output_all_years_bonn.enrichment.meta.json')) return Promise.resolve({ ok: true, json: async () => meta });
      if (url.endsWith('ctxtiles/bonn/index.json')) return Promise.resolve({ ok: true, json: async () => manifest });
      return Promise.resolve({ ok: false });
    };
    try {
      const state = await UA.contextLayers.load({}, 'Bonn');
      expect(state.tileIndexUrl).toBe('out/ctxtiles/bonn/index.json');
      expect(state.tileIndex.tileUrlByKey.get('4280/2730')).toBe('out/ctxtiles/bonn/4280/2730.json');
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('v1 (legacy) flat ways_<city>.json shape — still parses, geometries=null', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    const v1 = { 'W1': { highway: 0 }, 'W2': { highway: 1 } };
    global.fetch = (url) => {
      if (url.endsWith('ways_bonn.json')) return Promise.resolve({ ok: true, json: async () => v1 });
      return Promise.resolve({ ok: false });
    };
    try {
      const state = await UA.contextLayers.load({}, 'Bonn');
      expect(state.ways).toEqual(v1);
      expect(state.geometries).toBeNull();
    } finally {
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  test('exposes SUPPORTED_WAYS_SCHEMA_VERSIONS as a frozen-ish constant covering v1 + v2 + v3', () => {
    const UA = loadModule();
    expect(Array.isArray(UA.contextLayers.SUPPORTED_WAYS_SCHEMA_VERSIONS)).toBe(true);
    expect(UA.contextLayers.SUPPORTED_WAYS_SCHEMA_VERSIONS).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  test('unknown future schemaVersion (e.g. v9) → state.ways/geometries=null + one console.warn', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    const v9 = {
      schemaVersion: 9,
      ways: { 'W1': { highway: 0 } },
      geometries: { 'W1': [50, 7, 50.001, 7.001] },
      somethingNew: { foo: 'bar' },
    };
    let calls = 0;
    global.fetch = (url) => {
      if (url.endsWith('ways_future.json')) return Promise.resolve({ ok: true, json: async () => v9 });
      return Promise.resolve({ ok: false });
    };
    const origWarn = console.warn;
    const seen = [];
    console.warn = (...args) => { seen.push(args.join(' ')); calls++; };
    try {
      const state = await UA.contextLayers.load({}, 'future');
      expect(state.ways).toBeNull();
      expect(state.geometries).toBeNull();
      // Capability detection downstream sees null/no-fields => hasOsmContext=false.
      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]).toMatch(/schemaVersion=9/);
      expect(seen[0]).toMatch(/SUPPORTED_WAYS_SCHEMA_VERSIONS/);

      // Second load (different city) must warn for that one too, but
      // a re-load of the same slug must NOT spam the console.
      const before = calls;
      // Same slug — cached, no second fetch, no second warn.
      await UA.contextLayers.load({}, 'future');
      expect(calls).toBe(before);
    } finally {
      console.warn = origWarn;
      delete global.fetch;
      UA.contextLayers.clearCache();
    }
  });

  // ----------------------------------------------------------------------
  // v3 (full-network tile envelope) — see scripts/enrich_geojson.js
  // ----------------------------------------------------------------------

  test('v3 envelope: load() resolves with coverage/tileIndex; ways/geometries start empty and are populated by loadTilesForBbox', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();

    const envelope = {
      schemaVersion: 3,
      coverage: 'full',
      tileIndexUrl: 'out/ctxtiles/bonn/index.json',
    };
    // Manifest with two tiles; we'll pretend the bounds intersects only one.
    const manifest = {
      schemaVersion: 3,
      z: 13,
      coverage: 'full',
      tiles: [
        { x: 4280, y: 2730, wayCount: 1 },
        { x: 4290, y: 2730, wayCount: 1 },
      ],
      wayIndex: { W1: [4280, 2730], W2: [4290, 2730] },
      dicts: { highway: ['residential', 'secondary'] },
    };
    const tileA = {
      schemaVersion: 3,
      ways: { W1: { highway: 0, maxspeed: 30 } },
      geometries: { W1: [50, 7, 50.001, 7.001] },
    };
    const tileB = {
      schemaVersion: 3,
      ways: { W2: { highway: 1, maxspeed: 50 } },
      geometries: { W2: [51, 8, 51.001, 8.001] },
    };
    const fetchCalls = [];
    UA.fetchJsonCompressed = async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.endsWith('ways_bonn.json')) return envelope;
      if (url.endsWith('ctxtiles/bonn/index.json')) return manifest;
      if (url.endsWith('ctxtiles/bonn/4280/2730.json')) return tileA;
      if (url.endsWith('ctxtiles/bonn/4290/2730.json')) return tileB;
      throw new Error(`unexpected URL: ${url}`);
    };
    try {
      const state = await UA.contextLayers.load({}, 'Bonn');
      expect(state.coverage).toBe('full');
      expect(state.tileIndex).toBeTruthy();
      expect(state.tileIndex.tiles).toHaveLength(2);
      // Manifest dicts win over (absent) FC dicts.
      expect(state.dicts.highway).toEqual(['residential', 'secondary']);
      // Empty before any tile fetch.
      expect(Object.keys(state.ways)).toEqual([]);
      expect(Object.keys(state.geometries)).toEqual([]);

      // Bounds that only covers tile A's lat/lon area.
      const xLon = (4280 / Math.pow(2, 13)) * 360 - 180; // NW corner lon of tile A
      const xLonNext = (4281 / Math.pow(2, 13)) * 360 - 180;
      const n = Math.PI - (2 * Math.PI * 2730) / Math.pow(2, 13);
      const yLat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
      const n2 = Math.PI - (2 * Math.PI * 2731) / Math.pow(2, 13);
      const yLatNext = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n2) - Math.exp(-n2)));
      const bounds = {
        getSouth: () => Math.min(yLat, yLatNext) + 0.001,
        getNorth: () => Math.max(yLat, yLatNext) - 0.001,
        getWest:  () => xLon + 0.001,
        getEast:  () => xLonNext - 0.001,
      };
      const merged = await UA.contextLayers.loadTilesForBbox(state, bounds);
      // Only tile A was within bounds → only tile A fetched as gzip-only.
      const tileFetches = fetchCalls.filter(c => /ctxtiles\/bonn\/\d+\/\d+\.json$/.test(c.url));
      expect(tileFetches).toEqual([{
        url: 'out/ctxtiles/bonn/4280/2730.json',
        options: { cache: 'force-cache', gzipOnly: true },
      }]);
      expect(merged.ways.W1).toBeDefined();
      expect(merged.geometries.W1).toEqual([50, 7, 50.001, 7.001]);
      expect(merged.ways.W2).toBeUndefined();

      // Calling again with the same bounds re-uses the in-flight cache (no extra fetch).
      const before = fetchCalls.length;
      await UA.contextLayers.loadTilesForBbox(state, bounds);
      expect(fetchCalls.length).toBe(before);
    } finally {
      UA.contextLayers.clearCache();
    }
  });

  test('loadTilesForBbox is a no-op for v1/v2 states (returns the already-loaded data)', async () => {
    const UA = loadModule();
    const state = {
      tileIndex: null, _tileCache: null,
      ways: { W1: { highway: 'residential' } },
      geometries: { W1: [50, 7, 50.001, 7.001] },
    };
    const merged = await UA.contextLayers.loadTilesForBbox(state, { getSouth: () => 0, getNorth: () => 1, getWest: () => 0, getEast: () => 1 });
    expect(merged.ways).toBe(state.ways);
    expect(merged.geometries).toBe(state.geometries);
  });

  test('resolveWayAcrossTiles returns null and triggers a single gzip-only tile fetch for unloaded ways', async () => {
    const UA = loadModule();
    UA.contextLayers.clearCache();
    UA.normKey = (s) => String(s || '').toLowerCase();
    const fetchCalls = [];
    const tile = {
      schemaVersion: 3,
      ways: { Z9: { highway: 0 } },
      geometries: { Z9: [50, 7, 50.001, 7.001] },
    };
    UA.fetchJsonCompressed = async (url, options) => {
      fetchCalls.push({ url, options });
      if (url.endsWith('ctxtiles/x/100/200.json')) return tile;
      throw new Error(`unexpected URL: ${url}`);
    };
    const state = {
      slug: 'x',
      ways: {}, geometries: {},
      tileIndex: { z: 13, dicts: { highway: ['residential'] }, wayIndex: { Z9: [100, 200] }, tiles: [{ x: 100, y: 200, wayCount: 1 }] },
      tileIndexUrl: 'out/ctxtiles/x/index.json',
      _tileCache: new Map(),
      dicts: { highway: ['residential'] },
    };
    // First call — way not loaded yet → null AND a fetch is triggered.
    const r1 = UA.contextLayers.resolveWayAcrossTiles(state, 'Z9');
    expect(r1).toBeNull();
    expect(fetchCalls).toEqual([{
      url: 'out/ctxtiles/x/100/200.json',
      options: { cache: 'force-cache', gzipOnly: true },
    }]);
    await state._tileCache.get('100/200');
    // Second call — way is now resolved with dict-decoded attrs.
    const r2 = UA.contextLayers.resolveWayAcrossTiles(state, 'Z9');
    expect(r2).toEqual({ highway: 'residential' });
    // No new fetch — the way is already in state.
    expect(fetchCalls).toHaveLength(1);
  });
});
