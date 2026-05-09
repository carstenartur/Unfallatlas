'use strict';

/**
 * Tests for PR-D context-filter UI helpers in ua.ui.js:
 *   - UA.initContextFilters (URL → ctx.contextFilters + DOM)
 *   - UA.readContextFilterChips (DOM → ctx.contextFilters)
 *   - UA.refreshContextFilterVisibility (capabilities → section visibility)
 *
 * These cover the wire-up between the URL, the DOM, the
 * ctx.contextFilters state shape consumed by ua.filters.js, and the
 * capability-driven panel reveal — all without booting a real DOM.
 */

const fs   = require('fs');
const path = require('path');

function loadUI(href = 'http://localhost:8000/werkbank_v2.html') {
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
  load('ua.ui.js');
  return win.UA;
}

function makeChip(value, kind /* 'slope' | 'traffic' */) {
  const dataset = {};
  if (kind === 'slope')   dataset.ctxSlope   = value;
  if (kind === 'traffic') dataset.ctxTraffic = value;
  return { checked: false, dataset };
}

function makeUi(overrides = {}) {
  const slopeChips = ['flat','gentle','moderate','steep','very_steep'].map(v => makeChip(v, 'slope'));
  const trafficChips = ['low','medium','high','very_high'].map(v => makeChip(v, 'traffic'));
  return Object.assign({
    ctxFilterSection:  { hidden: true },
    ctxSlopeRow:       { hidden: true },
    ctxTrafficRow:     { hidden: true },
    ctxOnlyMatchedRow: { hidden: true },
    ctxOnlyMatchedEl:  { checked: false },
    ctxSlopeChipEls:   slopeChips,
    ctxTrafficChipEls: trafficChips,
  }, overrides);
}

describe('UA.initContextFilters — URL → state + DOM hydration', () => {
  test('empty URL yields empty filter sets and unchecked chips', () => {
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    const ctx = { ui };
    UA.initContextFilters(ctx);
    expect(ctx.contextFilters.slopeClasses.size).toBe(0);
    expect(ctx.contextFilters.trafficClasses.size).toBe(0);
    expect(ctx.contextFilters.onlyMatchedWays).toBe(false);
    expect(ui.ctxSlopeChipEls.every(c => !c.checked)).toBe(true);
    expect(ui.ctxOnlyMatchedEl.checked).toBe(false);
  });

  test('ctxSlope/ctxTraffic CSV in URL hydrates state and DOM', () => {
    const UA = loadUI('http://localhost/?ctxSlope=flat,steep&ctxTraffic=high&ctxOnlyMatched=1');
    const ui = makeUi();
    const ctx = { ui };
    UA.initContextFilters(ctx);
    expect(Array.from(ctx.contextFilters.slopeClasses).sort()).toEqual(['flat','steep']);
    expect(Array.from(ctx.contextFilters.trafficClasses)).toEqual(['high']);
    expect(ctx.contextFilters.onlyMatchedWays).toBe(true);
    expect(ui.ctxSlopeChipEls.find(c => c.dataset.ctxSlope === 'flat').checked).toBe(true);
    expect(ui.ctxSlopeChipEls.find(c => c.dataset.ctxSlope === 'steep').checked).toBe(true);
    expect(ui.ctxSlopeChipEls.find(c => c.dataset.ctxSlope === 'gentle').checked).toBe(false);
    expect(ui.ctxOnlyMatchedEl.checked).toBe(true);
  });

  test('rejects unknown values from a stale querystring without throwing', () => {
    const UA = loadUI('http://localhost/?ctxSlope=flat,bogus,extreme&ctxTraffic=meh');
    const ui = makeUi();
    const ctx = { ui };
    UA.initContextFilters(ctx);
    expect(Array.from(ctx.contextFilters.slopeClasses)).toEqual(['flat']);
    expect(ctx.contextFilters.trafficClasses.size).toBe(0);
  });
});

describe('UA.readContextFilterChips — DOM → state', () => {
  test('reads checked chips into Sets and onlyMatched flag', () => {
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    ui.ctxSlopeChipEls.find(c => c.dataset.ctxSlope === 'gentle').checked = true;
    ui.ctxTrafficChipEls.find(c => c.dataset.ctxTraffic === 'very_high').checked = true;
    ui.ctxOnlyMatchedEl.checked = true;
    const ctx = { ui };
    UA.readContextFilterChips(ctx);
    expect(Array.from(ctx.contextFilters.slopeClasses)).toEqual(['gentle']);
    expect(Array.from(ctx.contextFilters.trafficClasses)).toEqual(['very_high']);
    expect(ctx.contextFilters.onlyMatchedWays).toBe(true);
  });
});

describe('UA.refreshContextFilterVisibility — capabilities → visibility', () => {
  test('fully hidden when no capabilities are present', () => {
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    const ctx = { ui, contextCapabilities: {}, contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: false } };
    UA.refreshContextFilterVisibility(ctx);
    expect(ui.ctxFilterSection.hidden).toBe(true);
  });

  test('reveals only the rows whose capability is present', () => {
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    const ctx = {
      ui,
      contextCapabilities: { hasSlope: true, hasTrafficProxy: false, hasOsmContext: true },
      contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: false },
    };
    UA.refreshContextFilterVisibility(ctx);
    expect(ui.ctxFilterSection.hidden).toBe(false);
    expect(ui.ctxSlopeRow.hidden).toBe(false);
    expect(ui.ctxTrafficRow.hidden).toBe(true);
    expect(ui.ctxOnlyMatchedRow.hidden).toBe(false);
  });

  test('resets active filters whose capability is no longer present', () => {
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    ui.ctxSlopeChipEls.find(c => c.dataset.ctxSlope === 'flat').checked = true;
    ui.ctxOnlyMatchedEl.checked = true;
    const ctx = {
      ui,
      contextCapabilities: { hasSlope: false, hasTrafficProxy: false, hasOsmContext: false },
      contextFilters: { slopeClasses: new Set(['flat']), trafficClasses: new Set(), onlyMatchedWays: true },
      CITY_RAW: 'Bonn',
    };
    // Stub syncAllToUrl since we don't bring the full UI for this minimal
    // capabilities-driven test; the function's URL-cleanup contract is
    // covered by the ua.ui URL-roundtrip tests separately.
    let urlSyncCalls = 0;
    const origSync = UA.syncAllToUrl;
    UA.syncAllToUrl = () => { urlSyncCalls++; };
    try {
      UA.refreshContextFilterVisibility(ctx);
    } finally {
      UA.syncAllToUrl = origSync;
    }
    expect(ctx.contextFilters.slopeClasses.size).toBe(0);
    expect(ctx.contextFilters.onlyMatchedWays).toBe(false);
    expect(ui.ctxSlopeChipEls.find(c => c.dataset.ctxSlope === 'flat').checked).toBe(false);
    expect(ui.ctxOnlyMatchedEl.checked).toBe(false);
    expect(urlSyncCalls).toBe(1);
  });
});
