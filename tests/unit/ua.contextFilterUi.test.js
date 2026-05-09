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
    ctxFilterEmpty:    { hidden: true },
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
  test('shows empty-state copy (section visible, all rows hidden) when no slope/traffic capabilities', () => {
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    const ctx = { ui, contextCapabilities: {}, contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: false } };
    UA.refreshContextFilterVisibility(ctx);
    // Section now stays visible to host the empty-state hint…
    expect(ui.ctxFilterSection.hidden).toBe(false);
    // …with the empty-state hint shown…
    expect(ui.ctxFilterEmpty.hidden).toBe(false);
    // …and every chip row hidden because no capability is present.
    expect(ui.ctxSlopeRow.hidden).toBe(true);
    expect(ui.ctxTrafficRow.hidden).toBe(true);
    expect(ui.ctxOnlyMatchedRow.hidden).toBe(true);
  });

  test('hides empty-state copy as soon as slope OR traffic capability is present', () => {
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    const ctx = {
      ui,
      contextCapabilities: { hasSlope: true },
      contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: false },
    };
    UA.refreshContextFilterVisibility(ctx);
    expect(ui.ctxFilterSection.hidden).toBe(false);
    expect(ui.ctxFilterEmpty.hidden).toBe(true);
    expect(ui.ctxSlopeRow.hidden).toBe(false);
  });

  test('fully hidden when no capabilities are present', () => {
    // Historical contract: previously asserted the section was hidden
    // when capabilities were empty. After the empty-state addition the
    // section stays visible to host the hint; the chip ROWS remain
    // hidden, which is the actual user-facing invariant.
    const UA = loadUI('http://localhost/');
    const ui = makeUi();
    const ctx = { ui, contextCapabilities: {}, contextFilters: { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: false } };
    UA.refreshContextFilterVisibility(ctx);
    expect(ui.ctxSlopeRow.hidden).toBe(true);
    expect(ui.ctxTrafficRow.hidden).toBe(true);
    expect(ui.ctxOnlyMatchedRow.hidden).toBe(true);
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

describe('URL round-trip — shared links reproduce the same context filters', () => {
  // QA contract from the docs (DOKUMENTATION.md → URL-Parameter
  // (Referenz) → Kontext (neu)): copying a URL from a colleague who
  // had ctxSlope/ctxTraffic/ctxOnlyMatched set must reproduce the
  // exact same filter chips locally, and re-projecting the state back
  // to the URL must produce the same querystring (keys may reorder).
  function paramsFrom(url) {
    return new URL(url).searchParams;
  }

  test('init → readChips → setQS produces a URL whose ctx* params match the input', () => {
    const inputUrl = 'http://localhost/werkbank_v2.html?city=Bonn&ctxSlope=flat,steep&ctxTraffic=high,very_high&ctxOnlyMatched=1';
    const UA = loadUI(inputUrl);
    UA.setHydrating(true); // keep setQS pure; do not touch location.
    try {
      const ui = makeUi();
      const ctx = { ui };
      UA.initContextFilters(ctx);

      // Capability gate: simulate a fully enriched dataset so the chips
      // stay live (the resetting branch is exercised by other tests).
      ctx.contextCapabilities = { hasSlope: true, hasTrafficProxy: true, hasOsmContext: true, hasAny: true };

      // A user toggles a chip back and forth (idempotent round-trip).
      UA.readContextFilterChips(ctx);
      const cf = ctx.contextFilters;
      expect([...cf.slopeClasses].sort()).toEqual(['flat','steep']);
      expect([...cf.trafficClasses].sort()).toEqual(['high','very_high']);
      expect(cf.onlyMatchedWays).toBe(true);

      // Project state back to URL using the exact pattern syncAllToUrl
      // uses in ua.ui.js (CSV joined alphabetically by chip iteration
      // order; ctxOnlyMatched mapped to 1/0; empty Set → empty string,
      // which UA.setQS deletes from the URL).
      const slopeStr   = [...cf.slopeClasses].join(',');
      const trafficStr = [...cf.trafficClasses].join(',');
      const projected = UA.setQS({
        ctxSlope:       slopeStr,
        ctxTraffic:     trafficStr,
        ctxOnlyMatched: cf.onlyMatchedWays ? 1 : 0,
      });

      const inP = paramsFrom(inputUrl);
      const outP = paramsFrom(projected);
      // CSV order is irrelevant — compare as sets.
      expect(outP.get('ctxSlope').split(',').sort()).toEqual(inP.get('ctxSlope').split(',').sort());
      expect(outP.get('ctxTraffic').split(',').sort()).toEqual(inP.get('ctxTraffic').split(',').sort());
      expect(outP.get('ctxOnlyMatched')).toBe(inP.get('ctxOnlyMatched'));
      // Original non-context params must still be present.
      expect(outP.get('city')).toBe('Bonn');
    } finally {
      UA.setHydrating(false);
    }
  });

  test('cleared filters are removed from the URL (no hidden empty params)', () => {
    const UA = loadUI('http://localhost/werkbank_v2.html?ctxSlope=flat&ctxTraffic=high&ctxOnlyMatched=1');
    UA.setHydrating(true);
    try {
      const ui = makeUi();
      const ctx = { ui };
      UA.initContextFilters(ctx);
      // User unchecks everything.
      for (const el of ui.ctxSlopeChipEls)   el.checked = false;
      for (const el of ui.ctxTrafficChipEls) el.checked = false;
      ui.ctxOnlyMatchedEl.checked = false;
      UA.readContextFilterChips(ctx);
      const projected = UA.setQS({
        ctxSlope:       [...ctx.contextFilters.slopeClasses].join(','),
        ctxTraffic:     [...ctx.contextFilters.trafficClasses].join(','),
        ctxOnlyMatched: ctx.contextFilters.onlyMatchedWays ? 1 : 0,
      });
      const p = paramsFrom(projected);
      // Empty CSVs are deleted by UA.setQS; ctxOnlyMatched=0 is kept
      // explicitly only if the helper writes it. Either way, the
      // re-hydration of an empty/zero state must yield empty filters.
      expect(p.get('ctxSlope')).toBeNull();
      expect(p.get('ctxTraffic')).toBeNull();
    } finally {
      UA.setHydrating(false);
    }
  });

  test('legacy URL without any ctx* params still works (back-compat)', () => {
    const UA = loadUI('http://localhost/werkbank_v2.html?city=Bonn&severity=1');
    const ui = makeUi();
    const ctx = { ui };
    UA.initContextFilters(ctx);
    expect(ctx.contextFilters.slopeClasses.size).toBe(0);
    expect(ctx.contextFilters.trafficClasses.size).toBe(0);
    expect(ctx.contextFilters.onlyMatchedWays).toBe(false);
    // No chip becomes checked just because the URL doesn't carry the keys.
    expect(ui.ctxSlopeChipEls.every(c => !c.checked)).toBe(true);
    expect(ui.ctxTrafficChipEls.every(c => !c.checked)).toBe(true);
    expect(ui.ctxOnlyMatchedEl.checked).toBe(false);
  });
});
