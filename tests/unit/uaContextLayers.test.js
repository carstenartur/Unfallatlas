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
});
