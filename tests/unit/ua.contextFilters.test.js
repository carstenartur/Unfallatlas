'use strict';

/**
 * Tests for PR-D context filters added to ua.filters.js:
 *   - UA.matchesContextFilters (pure predicate)
 *   - integration with UA.matchesNonInvolvementFilters / UA.applyFilters
 *
 * These cover the wire-up between the new ctx.contextFilters state shape
 * (populated by ua.ui.js helpers) and the actual filtering pipeline,
 * without booting a DOM.
 */

const fs   = require('fs');
const path = require('path');

function loadFilters() {
  const win = { UA: {} };
  const load = (rel) => {
    const p = path.resolve(__dirname, '../../js/' + rel);
    (function (window) { eval(fs.readFileSync(p, 'utf8')); })(win);
  };
  load('ua.utils.js');
  load('ua.filters.js');
  return win.UA;
}

function makeUi(overrides = {}) {
  return Object.assign({
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
  }, overrides);
}

describe('UA.matchesContextFilters — pure predicate', () => {
  test('returns true when no filters are active', () => {
    const UA = loadFilters();
    const ctx = { contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: false } };
    expect(UA.matchesContextFilters(ctx, { slope_class: 'flat' })).toBe(true);
    expect(UA.matchesContextFilters(ctx, {})).toBe(true);
  });

  test('returns true when ctx.contextFilters is missing (back-compat)', () => {
    const UA = loadFilters();
    expect(UA.matchesContextFilters({}, { slope_class: 'steep' })).toBe(true);
  });

  test('slope filter: OR within row, accepts only listed classes', () => {
    const UA = loadFilters();
    const ctx = { contextFilters: { slopeClasses: new Set(['flat','gentle']), trafficClasses: new Set(), onlyMatchedWays: false } };
    expect(UA.matchesContextFilters(ctx, { slope_class: 'flat' })).toBe(true);
    expect(UA.matchesContextFilters(ctx, { slope_class: 'gentle' })).toBe(true);
    expect(UA.matchesContextFilters(ctx, { slope_class: 'steep' })).toBe(false);
    // Missing field is rejected when slope filter is active.
    expect(UA.matchesContextFilters(ctx, {})).toBe(false);
  });

  test('traffic filter: OR within row, AND across rows', () => {
    const UA = loadFilters();
    const ctx = { contextFilters: { slopeClasses: new Set(['flat']), trafficClasses: new Set(['high','very_high']), onlyMatchedWays: false } };
    expect(UA.matchesContextFilters(ctx, { slope_class: 'flat', traffic_proxy_class: 'high' })).toBe(true);
    expect(UA.matchesContextFilters(ctx, { slope_class: 'flat', traffic_proxy_class: 'low'  })).toBe(false);
    expect(UA.matchesContextFilters(ctx, { slope_class: 'steep', traffic_proxy_class: 'high' })).toBe(false);
  });

  test('onlyMatchedWays requires a non-empty matched_way_id', () => {
    const UA = loadFilters();
    const ctx = { contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: true } };
    expect(UA.matchesContextFilters(ctx, { matched_way_id: 'W42' })).toBe(true);
    expect(UA.matchesContextFilters(ctx, { matched_way_id: '' })).toBe(false);
    expect(UA.matchesContextFilters(ctx, { matched_way_id: null })).toBe(false);
    expect(UA.matchesContextFilters(ctx, {})).toBe(false);
  });
});

describe('Integration: matchesNonInvolvementFilters consults context filters', () => {
  test('rejects features whose slope_class is not in active set', () => {
    const UA = loadFilters();
    const ctx = {
      ui: makeUi(),
      contextFilters: { slopeClasses: new Set(['steep']), trafficClasses: new Set(), onlyMatchedWays: false },
    };
    const acceptedPr = { ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10, slope_class: 'steep' };
    const rejectedPr = { ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10, slope_class: 'flat' };
    expect(UA.matchesNonInvolvementFilters(ctx, acceptedPr)).toBe(true);
    expect(UA.matchesNonInvolvementFilters(ctx, rejectedPr)).toBe(false);
  });

  test('applyFilters honours context filters end-to-end', () => {
    const UA = loadFilters();
    const ctx = {
      ui: makeUi(),
      involvementMode: 'or',
      allPts: [
        { lat: 50.7, lon: 7.1, props: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10, slope_class: 'flat',  traffic_proxy_class: 'low'  } },
        { lat: 50.7, lon: 7.1, props: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10, slope_class: 'steep', traffic_proxy_class: 'high' } },
        { lat: 50.7, lon: 7.1, props: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10, slope_class: 'steep', traffic_proxy_class: 'low'  } },
      ],
      contextFilters: { slopeClasses: new Set(['steep']), trafficClasses: new Set(['high']), onlyMatchedWays: false },
    };
    UA.applyFilters(ctx);
    expect(ctx.filteredAll.length).toBe(1);
    expect(ctx.filteredAll[0].props.slope_class).toBe('steep');
    expect(ctx.filteredAll[0].props.traffic_proxy_class).toBe('high');
  });

  test('applyFilters with no contextFilters set keeps existing behaviour (back-compat)', () => {
    const UA = loadFilters();
    const ctx = {
      ui: makeUi(),
      involvementMode: 'or',
      allPts: [
        { lat: 50.7, lon: 7.1, props: { istrad: '1', ukategorie: 1, strzustand: '0', uwochentag: '3', ustunde: 10 } },
      ],
    };
    UA.applyFilters(ctx);
    expect(ctx.filteredAll.length).toBe(1);
  });
});
