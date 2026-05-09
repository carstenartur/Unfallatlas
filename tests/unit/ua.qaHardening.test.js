'use strict';

/**
 * QA hardening regression tests for PR #260 (final review).
 *
 * Covers contracts that span multiple modules and that were called out
 * explicitly in the merge-readiness review:
 *
 *   1. A stale URL context filter for a city that DOES NOT carry the
 *      corresponding enrichment must NOT silently filter the dataset
 *      to zero. Verified end-to-end via UA.applyFilters.
 *
 *   2. A failed ways_<city>.json load (404 / network error / corrupt
 *      JSON) must NOT break popup composition or filtering. Popups
 *      degrade to whatever the per-feature properties carry; filters
 *      treat onlyMatchedWays as gated off when capability is missing.
 *
 *   3. Popup HTML must never contain the literal "undefined" or "null"
 *      strings, even for sparse / partially-enriched features. This is
 *      the "no popup contains undefined/null" merge gate.
 *
 * The tests exercise the actual modules (ua.filters.js,
 * ua.popup_context.js, ua.context_layers.js) — no production code is
 * stubbed.
 */

const fs   = require('fs');
const path = require('path');

function loadAll(href = 'http://localhost/') {
  const win = {
    UA: {},
    location: { href },
    history: { replaceState: () => {} },
  };
  const load = (rel) => {
    const p = path.resolve(__dirname, '../../js/' + rel);
    (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
  };
  load('ua.utils.js');
  load('ua.filters.js');
  load('ua.context_layers.js');
  load('ua.popup_context.js');
  return { UA: win.UA, win };
}

function makeUi() {
  return {
    severityEl:        { value: 'all' },
    dayTypeEl:         { value: 'all' },
    roadConditionEl:   { value: 'all' },
    hFromEl:           { value: '0' },
    hToEl:             { value: '23' },
    maxPointsEl:       { value: '100000' },
    viewportPaddingEl: { value: '20' },
    incBikeEl: { checked: true },
    incPedEl:  { checked: true },
    incCarEl:  { checked: true },
    incMotoEl: { checked: false },
    incGkfzEl: { checked: false },
    incSonEl:  { checked: false },
  };
}

describe('QA hardening — stale URL context filter on non-enriched dataset', () => {
  test('applyFilters keeps all points when ctxSlope is set but capability is missing', () => {
    const { UA } = loadAll('http://localhost/?ctxSlope=flat,steep');
    // Detect on a FeatureCollection without any enrichment fields → no caps.
    const gj = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.1, 50.7] },
          properties: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10 } },
        { type: 'Feature', geometry: { type: 'Point', coordinates: [7.2, 50.8] },
          properties: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 11 } },
      ],
    };
    const detection = UA.contextLayers.detect(gj);
    const caps = UA.contextLayers.capabilitiesFromDetection(detection);
    expect(caps.hasSlope).toBe(false);
    expect(caps.hasAny).toBe(false);

    const ctx = {
      ui: makeUi(),
      involvementMode: 'or',
      contextCapabilities: caps,
      // Simulate the stale URL state: hydrated chips, but no UI cleanup yet.
      contextFilters: { slopeClasses: new Set(['flat','steep']), trafficClasses: new Set(['high']), onlyMatchedWays: true },
      allPts: [
        { lat: 50.7, lon: 7.1, props: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10 } },
        { lat: 50.8, lon: 7.2, props: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 11 } },
      ],
    };
    UA.applyFilters(ctx);
    // Critical: the stale filter must NOT have filtered anything out.
    expect(ctx.filteredAll.length).toBe(2);
  });
});

describe('QA hardening — failed ways_<city>.json load resilience', () => {
  test('popup composition degrades gracefully when ctx.contextLayerState is null (load failed)', () => {
    const { UA } = loadAll();
    const props = {
      // A feature that DOES have OSM context per-feature, but no ways state.
      matched_way_id: 'W42',
      highway: 'residential',  // already present per-feature
      slope_class: 'flat',
    };
    const ctx = {
      contextCapabilities: { hasSlope: true, hasOsmContext: true, hasAny: true },
      contextLayerState: null,  // ← simulated failed ways_<city>.json load
    };
    const html = UA.composeAccidentPopupHtml(ctx, props, { baseHtml: '' });
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toMatch(/undefined/i);
    expect(html).not.toMatch(/>\s*null\s*</);
    // Per-feature highway must still render.
    expect(html).toMatch(/residential/i);
  });

  test('popup composition does not crash when state.ways is null (404 → state={ways:null,...})', () => {
    const { UA } = loadAll();
    const props = { matched_way_id: 'W42', highway: 'tertiary' };
    const ctx = {
      contextCapabilities: { hasOsmContext: true, hasAny: true },
      contextLayerState: { slug: 'bonn', ways: null, meta: null, dicts: null },
    };
    const html = UA.composeAccidentPopupHtml(ctx, props, { baseHtml: '' });
    expect(typeof html).toBe('string');
    expect(html).not.toMatch(/undefined/i);
    expect(html).toMatch(/tertiary/i);
  });

  test('filter onlyMatchedWays is a no-op when ways load failed and capability is missing', () => {
    const { UA } = loadAll();
    const ctx = {
      ui: makeUi(),
      involvementMode: 'or',
      contextCapabilities: { hasSlope: false, hasTrafficProxy: false, hasOsmContext: false, hasAny: false },
      contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: true },
      contextLayerState: null,
      allPts: [
        // No matched_way_id on either point — would normally be filtered out.
        { lat: 50.7, lon: 7.1, props: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10 } },
      ],
    };
    UA.applyFilters(ctx);
    expect(ctx.filteredAll.length).toBe(1);
  });
});

describe('QA hardening — popup HTML never contains "undefined" or rendered "null"', () => {
  function popupFor(props, caps) {
    const { UA } = loadAll();
    return UA.composeAccidentPopupHtml(
      { contextCapabilities: caps, contextLayerState: null },
      props,
      { baseHtml: '' }
    );
  }

  // Spec 1: every required capability flag explicitly true, but every
  // per-feature value missing/null → popup helper must return null
  // (rather than render headers with "undefined" rows).
  test('all caps true but no per-feature values → returns null (no empty popup)', () => {
    const html = popupFor({}, { hasElevation: true, hasSlope: true, hasOsmContext: true, hasTrafficProxy: true, hasAny: true });
    expect(html).toBeNull();
  });

  // Spec 2: sparse features (one field present per capability) must
  // NOT leak the literal "undefined" anywhere — even though many
  // optional sub-fields are still missing.
  test.each([
    ['only elevation_m',         { elevation_m: 123.4 },                 { hasElevation: true, hasAny: true }],
    ['only slope_class',         { slope_class: 'gentle' },              { hasSlope: true, hasAny: true }],
    ['only traffic_proxy_class', { traffic_proxy_class: 'high' },        { hasTrafficProxy: true, hasAny: true }],
    ['only matched_way_id',      { matched_way_id: 'W7', highway: 'residential' }, { hasOsmContext: true, hasAny: true }],
    ['mixed sparse',             { elevation_m: 50, slope_class: 'flat', traffic_proxy_class: 'low', matched_way_id: 'W1', highway: 'tertiary' }, { hasElevation: true, hasSlope: true, hasTrafficProxy: true, hasOsmContext: true, hasAny: true }],
  ])('no "undefined" / "null" literal leaks for %s', (_label, props, caps) => {
    const html = popupFor(props, caps);
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    // Disallow the literal substring "undefined" anywhere in the output.
    expect(html).not.toMatch(/undefined/i);
    // Disallow rendered "null" as a visible cell value (between tags).
    // Note: we deliberately allow class names like "data-…" etc., but a
    // bare ">null<" would be a rendering bug.
    expect(html).not.toMatch(/>\s*null\s*</i);
    // And nothing like ">: <" (label with empty value) should appear.
    expect(html).not.toMatch(/>:\s*<\/[a-z]+>/);
  });

  // Spec 3: explicitly null/undefined values on present capabilities
  // must be skipped, not rendered as empty rows.
  test('explicit null / undefined fields are skipped, not rendered', () => {
    const html = popupFor(
      { elevation_m: null, slope_percent: undefined, slope_class: 'moderate', traffic_proxy_class: undefined },
      { hasElevation: true, hasSlope: true, hasTrafficProxy: true, hasAny: true }
    );
    expect(typeof html).toBe('string');
    expect(html).not.toMatch(/undefined/i);
    expect(html).not.toMatch(/>\s*null\s*</);
    // The one present field should still render.
    expect(html).toMatch(/mäßig/);
  });
});

describe('QA hardening — UI labels say "proxy" / "geschätzt", never "gemessen"', () => {
  // Merge-readiness contract: traffic-related user-facing strings must
  // make it explicit that the value is a proxy and not measured. This
  // guards against future copy edits that might accidentally relabel
  // the proxy as "Verkehrsdichte" (measured density).
  test('popup traffic section labels itself as proxy, not measured', () => {
    const { UA } = loadAll();
    const html = UA.composeAccidentPopupHtml(
      { contextCapabilities: { hasTrafficProxy: true, hasAny: true } },
      { traffic_proxy_class: 'high' },
      { baseHtml: '' }
    );
    expect(html).toMatch(/proxy/i);
    // Must never be presented as a measurement.
    expect(html).not.toMatch(/gemessene Verkehr/i);
    expect(html).not.toMatch(/Verkehrsdichte/);
  });

  test('ENRICHMENT_SOURCES_NOTE body explicitly disclaims measured density and uses "Proxy"', () => {
    // Load only what export_v2 needs — re-using the popup loader keeps the test self-contained.
    const win = { UA: {}, location: { href: 'http://localhost/' }, history: { replaceState: () => {} } };
    const load = (rel) => { const p = path.resolve(__dirname, '../../js/' + rel); (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win); };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    win.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    win.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    const note = win.UA.ENRICHMENT_SOURCES_NOTE;
    expect(note.body).toMatch(/Proxy/);
    expect(note.body).toMatch(/keine gemessene Verkehrsdichte/i);
    // No FGSV/BASt-Heuristik claim.
    const allText = note.body + ' ' + note.sources.map(s => s.label).join(' ');
    expect(allText).not.toMatch(/FGSV/);
    expect(allText).not.toMatch(/BASt-Heuristik/);
    expect(allText).not.toMatch(/BASt/);
  });
});
