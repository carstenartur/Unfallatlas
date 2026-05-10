'use strict';

/**
 * PR-berlin-slope-qa: regression tests for js/ua.context_road_layer.js
 *
 * The original report claimed Berlin renders almost entirely as
 * very_steep on `mapLayer=slope`. Investigation showed the per-tile
 * `road_slope_class` distribution is plausible (`flat` dominates), so
 * the bug — if any — would have to live in the renderer's class →
 * colour mapping. These tests pin the dict-decoding contract so a
 * stray entry under `dicts.road_slope_class` cannot collapse every
 * way to a single class on screen.
 *
 * The Leaflet stub mirrors tests/unit/uaContextRoadLayer.test.js so
 * the polyline → colour assertions stay deterministic without a real
 * canvas.
 */

const fs   = require('fs');
const path = require('path');

function loadModule() {
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
        return lg;
      },
      polyline: (latlngs, opts) => {
        const obj = {
          _latlngs: latlngs,
          _opts: opts,
          feature: null,
          _tooltip: null,
          bindTooltip: function (text, tOpts) { this._tooltip = { text, opts: tOpts }; return this; },
        };
        polylineCalls.push(obj);
        return obj;
      },
    },
    document: global.document,
  };
  const filePath = path.resolve(__dirname, '../../js/ua.context_road_layer.js');
  const src = fs.readFileSync(filePath, 'utf8');
  (function (window, document) { eval(src); })(win, global.document);
  return { UA: win.UA, polylineCalls };
}

describe('UA.contextRoadLayer.classifySlopeFromAttrs — explicit road_slope_class wins', () => {
  test('returns "flat" verbatim regardless of road_slope_percent', () => {
    const { UA } = loadModule();
    // The validator histogram is computed from road_slope_class; the
    // renderer must agree, otherwise on-screen colour and the build-
    // time gate disagree about what the city actually looks like.
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({
      road_slope_class: 'flat', road_slope_percent: 50,
    })).toBe('flat');
  });

  test('returns "very_steep" only when explicitly set on the way', () => {
    const { UA } = loadModule();
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({
      road_slope_class: 'very_steep', road_slope_percent: -1,
    })).toBe('very_steep');
    // Without the explicit class, a near-zero percent must classify
    // as flat — the original Berlin report would have meant a percent
    // → class miscoding here, not in the data.
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({
      road_slope_percent: 0.05,
    })).toBe('flat');
    expect(UA.contextRoadLayer.classifySlopeFromAttrs({
      road_slope_percent: 0,
    })).toBe('flat');
  });

  test('every documented class string round-trips through the classifier', () => {
    const { UA } = loadModule();
    for (const cls of UA.contextRoadLayer.SLOPE_CLASS_VALUES) {
      expect(UA.contextRoadLayer.classifySlopeFromAttrs({ road_slope_class: cls })).toBe(cls);
    }
  });
});

describe('UA.contextRoadLayer.buildSlopeLayer — dict decoding cannot collapse classes', () => {
  // Construct a hydrated state with one way per slope class, all
  // sharing the same `dicts.highway` table the v3 enrichment would
  // ship. None of the road_slope_* fields are in DICT_FIELDS, so the
  // resolver in buildLayer must pass them through as plain strings.
  function fakeState() {
    return {
      ways: {
        Wflat:       { highway: 0, road_slope_class: 'flat',       road_slope_percent: 1 },
        Wgentle:     { highway: 0, road_slope_class: 'gentle',     road_slope_percent: 3 },
        Wmoderate:   { highway: 0, road_slope_class: 'moderate',   road_slope_percent: 5 },
        Wsteep:      { highway: 0, road_slope_class: 'steep',      road_slope_percent: 8 },
        Wvery_steep: { highway: 0, road_slope_class: 'very_steep', road_slope_percent: 15 },
      },
      dicts: { highway: ['residential'] },
      geometries: {
        Wflat:       [50.0,   7,   50.001,   7.001],
        Wgentle:     [50.01,  7,   50.011,   7.001],
        Wmoderate:   [50.02,  7,   50.021,   7.001],
        Wsteep:      [50.03,  7,   50.031,   7.001],
        Wvery_steep: [50.04,  7,   50.041,   7.001],
      },
    };
  }

  test('every class produces its own colour — no collapse to very_steep', () => {
    const { UA, polylineCalls } = loadModule();
    UA.contextRoadLayer.buildSlopeLayer(fakeState());
    const expectedByWay = {
      Wflat:       UA.contextRoadLayer.slopeClassColor('flat'),
      Wgentle:     UA.contextRoadLayer.slopeClassColor('gentle'),
      Wmoderate:   UA.contextRoadLayer.slopeClassColor('moderate'),
      Wsteep:      UA.contextRoadLayer.slopeClassColor('steep'),
      Wvery_steep: UA.contextRoadLayer.slopeClassColor('very_steep'),
    };
    const actualByWay = {};
    for (const p of polylineCalls) {
      actualByWay[p.feature.properties.way_id] = p._opts.color;
    }
    expect(actualByWay).toEqual(expectedByWay);
    // Sanity: the on-screen distribution is exactly one polyline per
    // class — never a single class dominating.
    const colours = Object.values(actualByWay);
    expect(new Set(colours).size).toBe(5);
  });

  test('a stray dicts.road_slope_class does NOT re-encode the per-way class', () => {
    // If road_slope_class were ever added to DICT_FIELDS by mistake,
    // the renderer would receive it as an integer index. We must not
    // index into the dict — strings stay strings, integers stay
    // integers. This guards against the exact failure mode where one
    // entry in `dicts.road_slope_class` could colour every way the
    // same.
    const { UA, polylineCalls } = loadModule();
    const s = fakeState();
    s.dicts.road_slope_class = ['very_steep'];           // stray dict
    UA.contextRoadLayer.buildSlopeLayer(s);
    // None of the rendered polylines should have been re-coloured to
    // very_steep because of the stray dict — the per-way string must
    // win over `dicts[0]`.
    const veryRed = UA.contextRoadLayer.slopeClassColor('very_steep');
    const reds = polylineCalls.filter(p => p._opts.color === veryRed);
    expect(reds).toHaveLength(1);                        // only Wvery_steep
    expect(reds[0].feature.properties.way_id).toBe('Wvery_steep');
  });
});

describe('UA.contextRoadLayer.buildSlopeLayer — debug.showPercent tooltip', () => {
  function fakeState() {
    return {
      ways: {
        W1: { road_slope_class: 'gentle', road_slope_percent: 3.4 },
        W2: { road_slope_class: 'flat',   road_slope_percent: -0.7 },
      },
      dicts: {},
      geometries: {
        W1: [50.0, 7, 50.001, 7.001],
        W2: [50.1, 7, 50.101, 7.001],
      },
    };
  }

  test('binds a permanent "<n> %" tooltip per polyline when debug.showPercent is true', () => {
    const { UA, polylineCalls } = loadModule();
    UA.contextRoadLayer.buildSlopeLayer(fakeState(), { debug: { showPercent: true } });
    // Every polyline with a numeric road_slope_percent must carry a
    // tooltip whose text is "<percent> %".
    const byId = {};
    for (const p of polylineCalls) byId[p.feature.properties.way_id] = p;
    expect(byId.W1._tooltip).toBeTruthy();
    expect(byId.W1._tooltip.text).toBe('3.4 %');
    expect(byId.W1._tooltip.opts.permanent).toBe(true);
    expect(byId.W2._tooltip.text).toBe('-0.7 %');
  });

  test('no tooltip when debug.showPercent is omitted (default)', () => {
    const { UA, polylineCalls } = loadModule();
    UA.contextRoadLayer.buildSlopeLayer(fakeState());
    for (const p of polylineCalls) {
      expect(p._tooltip).toBeNull();
    }
  });
});
