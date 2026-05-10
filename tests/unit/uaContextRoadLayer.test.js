'use strict';

/**
 * Tests for js/ua.context_road_layer.js
 *
 * Covers the pure helpers (class → colour, classification from per-way
 * attrs, polyline decode), the layer builder against a fake Leaflet
 * stub + fake hydrated state, and the legend HTML.
 */

const fs   = require('fs');
const path = require('path');

function loadModule() {
  // Stub Leaflet just enough to record calls without DOM.
  const layerGroupCalls = [];
  const polylineCalls = [];
  const fakeRenderer  = { _id: 'canvas' };
  const win = {
    UA: {},
    L: {
      canvas: () => fakeRenderer,
      layerGroup: () => {
        const layers = [];
        const lg = {
          _layers: layers,
          addLayer: (l) => { layers.push(l); return lg; },
          getLayers: () => layers.slice(),
          addTo: () => lg,
          remove: () => lg,
        };
        layerGroupCalls.push(lg);
        return lg;
      },
      polyline: (latlngs, opts) => {
        const obj = { _latlngs: latlngs, _opts: opts, feature: null };
        polylineCalls.push(obj);
        return obj;
      },
    },
    document: global.document,
  };
  const filePath = path.resolve(__dirname, '../../js/ua.context_road_layer.js');
  const src = fs.readFileSync(filePath, 'utf8');
  (function (window, document) { eval(src); })(win, global.document);
  return { UA: win.UA, polylineCalls, layerGroupCalls };
}

describe('UA.contextRoadLayer — class colour mappings', () => {
  test('exposes ordered class lists matching the chip filters', () => {
    const { UA } = loadModule();
    expect(UA.contextRoadLayer.SLOPE_CLASS_VALUES)
      .toEqual(['flat', 'gentle', 'moderate', 'steep', 'very_steep']);
    expect(UA.contextRoadLayer.TRAFFIC_CLASS_VALUES)
      .toEqual(['low', 'medium', 'high', 'very_high']);
  });

  test('slopeClassColor / trafficClassColor return ordered ramps and null for unknown', () => {
    const { UA } = loadModule();
    for (const cls of UA.contextRoadLayer.SLOPE_CLASS_VALUES) {
      expect(UA.contextRoadLayer.slopeClassColor(cls)).toMatch(/^#[0-9a-f]{6}$/i);
    }
    for (const cls of UA.contextRoadLayer.TRAFFIC_CLASS_VALUES) {
      expect(UA.contextRoadLayer.trafficClassColor(cls)).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(UA.contextRoadLayer.slopeClassColor('bogus')).toBeNull();
    expect(UA.contextRoadLayer.trafficClassColor(null)).toBeNull();
  });

  test('classifySlope/classifyTrafficProxy match the documented thresholds', () => {
    const { UA } = loadModule();
    expect(UA.contextRoadLayer.classifySlope(0)).toBe('flat');
    expect(UA.contextRoadLayer.classifySlope(3)).toBe('gentle');
    expect(UA.contextRoadLayer.classifySlope(-3)).toBe('gentle');
    expect(UA.contextRoadLayer.classifySlope(8)).toBe('steep');
    expect(UA.contextRoadLayer.classifySlope(15)).toBe('very_steep');
    expect(UA.contextRoadLayer.classifyTrafficProxy(500)).toBe('low');
    expect(UA.contextRoadLayer.classifyTrafficProxy(20000)).toBe('very_high');
    expect(UA.contextRoadLayer.classifySlope(undefined)).toBeNull();
  });
});

describe('UA.contextRoadLayer — classify*FromAttrs', () => {
  test('classifySlopeFromAttrs prefers explicit road_slope_class, then road_slope_percent, then osm_incline', () => {
    const { UA } = loadModule();
    // PR-bielefeld-slope: the renderer must honour the class chosen by
    // the enrichment pipeline, so the validator's class histogram and
    // the on-screen colour always agree.
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({
      road_slope_class: 'steep', road_slope_percent: 1,
    })).toBe('steep');
    // Unknown class string falls through to numeric reclassification.
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({
      road_slope_class: 'bogus', road_slope_percent: 5,
    })).toBe('moderate');
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({ road_slope_percent: 5 })).toBe('moderate');
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({ osm_incline: '7%' })).toBe('steep');
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({ osm_incline: 'up' })).toBeNull();
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({})).toBeNull();
    expect(UA.contextRoadLayer.classifySlopeFromAttrs(null)).toBeNull();
  });

  test('classifyTrafficFromAttrs prefers explicit DTV value, falls back to highway proxy', () => {
    const { UA } = loadModule();
    expect(UA.contextRoadLayer.classifyTrafficFromAttrs({ traffic_volume_value: 8000 })).toBe('high');
    expect(UA.contextRoadLayer.classifyTrafficFromAttrs({ highway: 'motorway' })).toBe('very_high');
    expect(UA.contextRoadLayer.classifyTrafficFromAttrs({ highway: 'residential' })).toBe('low');
    expect(UA.contextRoadLayer.classifyTrafficFromAttrs({ highway: 'unknown_kind' })).toBeNull();
    expect(UA.contextRoadLayer.classifyTrafficFromAttrs({})).toBeNull();
  });
});

describe('UA.contextRoadLayer — decodeGeometry', () => {
  test('decodes a flat lat/lon array into [[lat,lon], ...]', () => {
    const { UA } = loadModule();
    expect(UA.contextRoadLayer.decodeGeometry([50, 7, 50.001, 7.001]))
      .toEqual([[50, 7], [50.001, 7.001]]);
  });

  test('returns null on malformed input', () => {
    const { UA } = loadModule();
    expect(UA.contextRoadLayer.decodeGeometry(null)).toBeNull();
    expect(UA.contextRoadLayer.decodeGeometry([1, 2])).toBeNull();         // <2 points
    expect(UA.contextRoadLayer.decodeGeometry([1, 2, 3])).toBeNull();      // odd length
    expect(UA.contextRoadLayer.decodeGeometry([NaN, 1, 2, 3])).toBeNull(); // non-finite
  });
});

describe('UA.contextRoadLayer — buildSlopeLayer / buildTrafficLayer', () => {
  function fakeState() {
    return {
      ways: {
        'W1': { highway: 0, road_slope_percent: 7 },   // → "steep"
        'W2': { highway: 1 },                          // → no slope
        'W3': { highway: 2, road_slope_percent: 1 },   // → "flat"
      },
      dicts: { highway: ['residential', 'service', 'motorway'] },
      geometries: {
        'W1': [50, 7, 50.001, 7.001],
        'W2': [50.1, 7, 50.101, 7.001],
        'W3': [50.2, 7, 50.201, 7.001],
        'W_no_attrs': [50.3, 7, 50.301, 7.001],   // no entry in ways → skipped
      },
    };
  }

  test('buildSlopeLayer renders coloured polylines for ways with a slope class and neutral grey for the rest (default showUnclassified)', () => {
    const { UA, polylineCalls } = loadModule();
    const layer = UA.contextRoadLayer.buildSlopeLayer(fakeState());
    // W1 + W3 (with slope class) plus W2 + W_no_attrs (no slope) — every
    // way present in `state.geometries` becomes a polyline; classified
    // ways get the colour ramp, the rest fall back to neutral grey.
    expect(layer.getLayers()).toHaveLength(4);
    // Coloured swatches for the two classified ways…
    const colors = polylineCalls.map(p => p._opts.color);
    expect(colors).toEqual(expect.arrayContaining([
      UA.contextRoadLayer.slopeClassColor('steep'),
      UA.contextRoadLayer.slopeClassColor('flat'),
      UA.contextRoadLayer.SLOPE_NO_SIGNAL_COLOR,
    ]));
    // Each line carries a tiny feature payload for hover tooltips.
    const okClasses = UA.contextRoadLayer.SLOPE_CLASS_VALUES.concat(['no_signal']);
    for (const p of polylineCalls) {
      expect(p.feature.properties.kind).toBe('slope');
      expect(typeof p.feature.properties.way_id).toBe('string');
      expect(okClasses).toContain(p.feature.properties.class);
    }
    // The unclassified way is tagged with class === 'no_signal'.
    const noSignal = polylineCalls.find(p => p.feature.properties.class === 'no_signal');
    expect(noSignal).toBeTruthy();
    expect(noSignal.feature.properties.way_id).toBe('W2');
  });

  test('buildSlopeLayer with showUnclassified:false renders only classified ways (legacy behaviour)', () => {
    const { UA } = loadModule();
    const layer = UA.contextRoadLayer.buildSlopeLayer(fakeState(), { showUnclassified: false });
    expect(layer.getLayers()).toHaveLength(2);  // W1 + W3 only
  });

  test('buildTrafficLayer uses the resolved highway dict for classification', () => {
    const { UA, polylineCalls } = loadModule();
    const layer = UA.contextRoadLayer.buildTrafficLayer(fakeState());
    // All three ways have a `highway` value → all three get a traffic class.
    expect(layer.getLayers()).toHaveLength(3);
    // motorway → very_high
    const veryHigh = polylineCalls.find(
      p => p._opts.color === UA.contextRoadLayer.trafficClassColor('very_high'));
    expect(veryHigh).toBeTruthy();
    expect(veryHigh.feature.properties.kind).toBe('traffic');
  });

  test('returns an empty layer when state has no geometries (lazy-load not done)', () => {
    const { UA } = loadModule();
    const layer = UA.contextRoadLayer.buildSlopeLayer({ ways: {}, dicts: {} });
    expect(layer.getLayers()).toHaveLength(0);
  });

  test('opts.bounds restricts emitted polylines to the viewport AABB (PR-E full-network)', () => {
    const { UA } = loadModule();
    // Bounds covering only W1's lat/lon (lat≈50.000, lon≈7.000) — W2
    // (lat≈50.1) and W3 (lat≈50.2) must be filtered out even though
    // their attrs would otherwise produce a class.
    const bounds = {
      getSouth: () => 49.9, getNorth: () => 50.05,
      getWest:  () => 6.9,  getEast:  () => 7.1,
    };
    const layer = UA.contextRoadLayer.buildSlopeLayer(fakeState(), { bounds });
    const ids = layer.getLayers().map(l => l.feature.properties.way_id);
    expect(ids).toEqual(['W1']);
  });
});

describe('UA.contextRoadLayer — buildLegend', () => {
  test('returns a DOM element with one swatch + label per class, swatches use the slope ramp + appended "kein Steigungssignal" row', () => {
    const { UA } = loadModule();
    const el = UA.contextRoadLayer.buildLegend('slope');
    expect(el.tagName).toBe('DIV');
    expect(el.className).toMatch(/context-road-legend/);
    const rows = el.querySelectorAll('.context-road-legend__row');
    expect(rows.length).toBe(UA.contextRoadLayer.SLOPE_CLASS_VALUES.length);
    // Each row's swatch background must match the documented slope ramp colour
    // for its class — guards against ramp/legend drift.
    rows.forEach((row, i) => {
      const cls = UA.contextRoadLayer.SLOPE_CLASS_VALUES[i];
      const sw  = row.querySelector('.context-road-legend__swatch');
      const expected = UA.contextRoadLayer.slopeClassColor(cls);
      // jsdom normalises CSS colour to rgb(...). Match either form.
      const bg = sw.style.background || sw.style.backgroundColor;
      expect(bg).toBeTruthy();
      // Accept the original "#rrggbb" or the rgb(r, g, b) form jsdom produces.
      const r = parseInt(expected.slice(1, 3), 16);
      const g = parseInt(expected.slice(3, 5), 16);
      const b = parseInt(expected.slice(5, 7), 16);
      const rgb = `rgb(${r}, ${g}, ${b})`;
      expect([expected, rgb]).toContain(bg);
    });
    // "kein Steigungssignal" row is appended below the colour ramp.
    const noSignal = el.querySelector('.context-road-legend__nosignal');
    expect(noSignal).toBeTruthy();
    expect(noSignal.querySelector('.context-road-legend__label').textContent)
      .toMatch(/kein Steigungssignal/);
    const noSignalSw = noSignal.querySelector('.context-road-legend__swatch');
    const expectedGrey = UA.contextRoadLayer.SLOPE_NO_SIGNAL_COLOR;
    const r = parseInt(expectedGrey.slice(1, 3), 16);
    const g = parseInt(expectedGrey.slice(3, 5), 16);
    const b = parseInt(expectedGrey.slice(5, 7), 16);
    const bg = noSignalSw.style.background || noSignalSw.style.backgroundColor;
    expect([expectedGrey, `rgb(${r}, ${g}, ${b})`]).toContain(bg);
  });

  test('traffic legend uses the traffic ramp and has no "no signal" row', () => {
    const { UA } = loadModule();
    const el = UA.contextRoadLayer.buildLegend('traffic');
    const rows = el.querySelectorAll('.context-road-legend__row');
    expect(rows.length).toBe(UA.contextRoadLayer.TRAFFIC_CLASS_VALUES.length);
    expect(el.querySelector('.context-road-legend__title').textContent)
      .toMatch(/Verkehr/);
    expect(el.querySelector('.context-road-legend__nosignal')).toBeNull();
    // Low-confidence is a slope-only concept; the traffic legend must
    // not gain a stray row.
    expect(el.querySelector('.context-road-legend__lowconfidence')).toBeNull();
  });

  test('slope legend includes a "geringe Konfidenz" row using SLOPE_LOW_CONFIDENCE_COLOR', () => {
    const { UA } = loadModule();
    const el = UA.contextRoadLayer.buildLegend('slope');
    const lowConf = el.querySelector('.context-road-legend__lowconfidence');
    expect(lowConf).toBeTruthy();
    expect(lowConf.querySelector('.context-road-legend__label').textContent)
      .toMatch(/geringe Konfidenz/);
    const sw = lowConf.querySelector('.context-road-legend__swatch');
    const expected = UA.contextRoadLayer.SLOPE_LOW_CONFIDENCE_COLOR;
    const r = parseInt(expected.slice(1, 3), 16);
    const g = parseInt(expected.slice(3, 5), 16);
    const b = parseInt(expected.slice(5, 7), 16);
    const bg = sw.style.background || sw.style.backgroundColor;
    expect([expected, `rgb(${r}, ${g}, ${b})`]).toContain(bg);
    // Order: ramp rows → low-confidence → no-signal. This is a
    // deliberate visual hierarchy ("trustworthy → unreliable → absent").
    const children = Array.from(el.children);
    const rampLast = children.findIndex(c => c.className === 'context-road-legend__row' && c === el.querySelectorAll('.context-road-legend__row')[UA.contextRoadLayer.SLOPE_CLASS_VALUES.length - 1]);
    const lowIdx   = children.findIndex(c => c.className === 'context-road-legend__lowconfidence');
    const noIdx    = children.findIndex(c => c.className === 'context-road-legend__nosignal');
    expect(lowIdx).toBeGreaterThan(rampLast);
    expect(noIdx).toBeGreaterThan(lowIdx);
  });
});

describe('UA.contextRoadLayer — slope renderer / legend colour parity (PR-berlin-slope-renderer)', () => {
  // Every coloured polyline the slope layer emits must use the *exact*
  // colour the legend swatch advertises for that class — otherwise the
  // user sees "deep red on the map but not in the legend" (the Berlin
  // bug). Pin the contract explicitly.
  test('every slope_class renders the same colour as its legend swatch', () => {
    const { UA, polylineCalls } = loadModule();
    const ways = {};
    const geometries = {};
    UA.contextRoadLayer.SLOPE_CLASS_VALUES.forEach((cls, i) => {
      const id = `W_${cls}`;
      ways[id] = { road_slope_class: cls, road_slope_confidence: 'high' };
      // Distinct geometry per class so each polyline call is unambiguous.
      const lat = 50 + i * 0.01;
      geometries[id] = [lat, 7, lat + 0.001, 7.001];
    });
    UA.contextRoadLayer.buildSlopeLayer({ ways, dicts: {}, geometries });
    for (const cls of UA.contextRoadLayer.SLOPE_CLASS_VALUES) {
      const expected = UA.contextRoadLayer.SLOPE_COLORS[cls];
      const line = polylineCalls.find(p => p.feature.properties.way_id === `W_${cls}`);
      expect(line).toBeTruthy();
      expect(line._opts.color).toBe(expected);
      expect(line.feature.properties.class).toBe(cls);
      expect(line.feature.properties.slope_confidence).toBe('high');
    }
  });

  test('low-confidence slope ways render in SLOPE_LOW_CONFIDENCE_COLOR even when class is very_steep (Berlin endpoint-noise fix)', () => {
    const { UA, polylineCalls } = loadModule();
    const state = {
      ways: {
        // The single most damaging signature: a flat residential
        // street whose endpoint-method DEM lookup happened to flip a
        // ~5 cm height delta into "very_steep". With the old policy
        // this rendered deep red across central Berlin.
        'W_low_vs': {
          road_slope_class: 'very_steep',
          road_slope_percent: 12.7,
          road_slope_confidence: 'low',
          road_slope_method: 'endpoint',
          road_slope_sample_count: 1,
        },
        // Same class but high confidence — must keep the ramp colour.
        'W_high_vs': {
          road_slope_class: 'very_steep',
          road_slope_percent: 13.2,
          road_slope_confidence: 'high',
          road_slope_method: 'median_segments',
          road_slope_sample_count: 8,
        },
      },
      dicts: {},
      geometries: {
        'W_low_vs':  [50.0, 7.0, 50.001, 7.001],
        'W_high_vs': [50.1, 7.0, 50.101, 7.001],
      },
    };
    UA.contextRoadLayer.buildSlopeLayer(state);
    const low  = polylineCalls.find(p => p.feature.properties.way_id === 'W_low_vs');
    const high = polylineCalls.find(p => p.feature.properties.way_id === 'W_high_vs');
    expect(low).toBeTruthy();
    expect(high).toBeTruthy();
    // The flat-Berlin signature must NOT render in the deep-red ramp colour.
    expect(low._opts.color).toBe(UA.contextRoadLayer.SLOPE_LOW_CONFIDENCE_COLOR);
    expect(low._opts.color).not.toBe(UA.contextRoadLayer.SLOPE_COLORS.very_steep);
    expect(low.feature.properties.class).toBe('low_confidence');
    // Underlying calculated class + provenance is preserved on the
    // feature payload for hover tooltip / debugging.
    expect(low.feature.properties.slope_class).toBe('very_steep');
    expect(low.feature.properties.slope_confidence).toBe('low');
    expect(low.feature.properties.slope_percent).toBe(12.7);
    expect(low.feature.properties.slope_method).toBe('endpoint');
    expect(low.feature.properties.slope_sample_count).toBe(1);
    // High-confidence very_steep keeps the ramp colour.
    expect(high._opts.color).toBe(UA.contextRoadLayer.SLOPE_COLORS.very_steep);
    expect(high.feature.properties.class).toBe('very_steep');
    expect(high.feature.properties.slope_confidence).toBe('high');
  });

  test('medium-confidence keeps the ramp colour (only "low" is muted)', () => {
    const { UA, polylineCalls } = loadModule();
    UA.contextRoadLayer.buildSlopeLayer({
      ways: { 'W_med': { road_slope_class: 'steep', road_slope_confidence: 'medium' } },
      dicts: {},
      geometries: { 'W_med': [50, 7, 50.001, 7.001] },
    });
    const line = polylineCalls.find(p => p.feature.properties.way_id === 'W_med');
    expect(line._opts.color).toBe(UA.contextRoadLayer.SLOPE_COLORS.steep);
    expect(line.feature.properties.class).toBe('steep');
  });

  test('low confidence does not affect the traffic layer (slope-only policy)', () => {
    const { UA, polylineCalls } = loadModule();
    UA.contextRoadLayer.buildTrafficLayer({
      ways: { 'W_t': { highway: 0, road_slope_confidence: 'low' } },
      dicts: { highway: ['motorway'] },
      geometries: { 'W_t': [50, 7, 50.001, 7.001] },
    });
    const line = polylineCalls.find(p => p.feature.properties.way_id === 'W_t');
    expect(line._opts.color).toBe(UA.contextRoadLayer.TRAFFIC_COLORS.very_high);
  });
});
