'use strict';

const fs = require('fs');
const path = require('path');

function loadRuntime(href) {
  const win = {
    UA: {},
    location: { href },
    history: { replaceState: jest.fn() },
  };
  const load = (relative) => {
    const file = path.resolve(__dirname, '../../js', relative);
    (function evaluate(window) { eval(fs.readFileSync(file, 'utf8')); })(win);
  };
  load('ua.utils.js');
  load('ua.ui.js');
  // Production order: the URL codec installs the preservation wrapper after UI.
  load('ua.map_scene_url_codec.js');
  load('ua.filters.js');
  return win.UA;
}

function chip(value, kind) {
  return {
    checked: false,
    dataset: kind === 'slope' ? { ctxSlope: value } : { ctxTraffic: value },
  };
}

function uiFixture() {
  return {
    ctxFilterSection: { hidden: true },
    ctxFilterEmpty: { hidden: true },
    ctxSlopeRow: { hidden: true },
    ctxTrafficRow: { hidden: true },
    ctxOnlyMatchedRow: { hidden: true },
    ctxOnlyMatchedEl: { checked: false },
    ctxSlopeChipEls: ['flat', 'gentle', 'moderate', 'steep', 'very_steep']
      .map((value) => chip(value, 'slope')),
    ctxTrafficChipEls: ['low', 'medium', 'high', 'very_high']
      .map((value) => chip(value, 'traffic')),
  };
}

describe('context-filter URL state and provenance', () => {
  const href = 'http://localhost/werkbank_v2.html?city=Bonn' +
    '&ctxSlope=steep,very_steep&ctxTraffic=high,very_high&ctxOnlyMatched=1';

  beforeEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-ua-sticky-city-installed');
    document.getElementById('ua-sticky-city-selector-style')?.remove();
  });

  test('capability projection hides unavailable rows without erasing requested state', () => {
    const UA = loadRuntime(href);
    const ui = uiFixture();
    const ctx = { ui, contextCapabilities: {} };
    UA.initContextFilters(ctx);
    const sync = jest.fn();
    UA.syncAllToUrl = sync;

    UA.refreshContextFilterVisibility(ctx);

    expect(ui.ctxFilterSection.hidden).toBe(false);
    expect(ui.ctxFilterEmpty.hidden).toBe(false);
    expect(ui.ctxSlopeRow.hidden).toBe(true);
    expect(ui.ctxTrafficRow.hidden).toBe(true);
    expect(ui.ctxOnlyMatchedRow.hidden).toBe(true);
    expect([...ctx.contextFilters.slopeClasses].sort()).toEqual(['steep', 'very_steep']);
    expect([...ctx.contextFilters.trafficClasses].sort()).toEqual(['high', 'very_high']);
    expect(ctx.contextFilters.onlyMatchedWays).toBe(true);
    expect(ui.ctxSlopeChipEls.filter((entry) => entry.checked).map((entry) => entry.dataset.ctxSlope))
      .toEqual(['steep', 'very_steep']);
    expect(ui.ctxTrafficChipEls.filter((entry) => entry.checked).map((entry) => entry.dataset.ctxTraffic))
      .toEqual(['high', 'very_high']);
    expect(ui.ctxOnlyMatchedEl.checked).toBe(true);
    expect(sync).not.toHaveBeenCalled();
  });

  test('requested filters are a no-op without capabilities but become active when data is available', () => {
    const UA = loadRuntime(href);
    const ctx = { ui: uiFixture(), contextCapabilities: {} };
    UA.initContextFilters(ctx);
    UA.refreshContextFilterVisibility(ctx);

    const unmatched = {
      slope_class: 'flat',
      traffic_proxy_class: 'low',
      matched_way_id: null,
    };
    expect(UA.matchesContextFilters(ctx, unmatched)).toBe(true);

    ctx.contextCapabilities = {
      hasSlope: true,
      hasTrafficProxy: true,
      hasOsmContext: true,
    };
    UA.refreshContextFilterVisibility(ctx);
    expect(ctx.ui.ctxFilterEmpty.hidden).toBe(true);
    expect(ctx.ui.ctxSlopeRow.hidden).toBe(false);
    expect(ctx.ui.ctxTrafficRow.hidden).toBe(false);
    expect(ctx.ui.ctxOnlyMatchedRow.hidden).toBe(false);
    expect(UA.matchesContextFilters(ctx, unmatched)).toBe(false);
    expect(UA.matchesContextFilters(ctx, {
      slope_class: 'steep',
      traffic_proxy_class: 'very_high',
      matched_way_id: '123',
    })).toBe(true);
  });

  test('wrapper installation is explicit and does not replace itself on duplicate codec evaluation', () => {
    const UA = loadRuntime(href);
    const installed = UA.refreshContextFilterVisibility;
    expect(UA.__contextFilterUrlPreservationInstalled).toBe(true);

    const file = path.resolve(__dirname, '../../js/ua.map_scene_url_codec.js');
    const win = { UA, location: { href }, history: { replaceState: jest.fn() } };
    (function evaluate(window) { eval(fs.readFileSync(file, 'utf8')); })(win);

    expect(UA.refreshContextFilterVisibility).toBe(installed);
  });

  test('installs a responsive sticky city row exactly once', () => {
    document.body.innerHTML = `
      <div id="panel">
        <div class="panelHeader">Header</div>
        <div class="panelBody">
          <div class="row"><label>Stadt</label><select id="citySel"></select></div>
        </div>
      </div>`;
    const header = document.querySelector('.panelHeader');
    header.getBoundingClientRect = () => ({ height: 47.5 });
    const UA = loadRuntime(href);
    const panel = document.getElementById('panel');
    const row = document.getElementById('citySel').closest('.row');

    expect(row.classList.contains('ua-sticky-city-row')).toBe(true);
    expect(panel.style.getPropertyValue('--ua-panel-header-height')).toBe('47.5px');
    expect(document.getElementById('ua-sticky-city-selector-style').textContent)
      .toContain('position: sticky');
    expect(document.documentElement.dataset.uaStickyCityInstalled).toBe('1');
    expect(UA.installStickyCitySelector(document)).toBe(false);
    expect(document.querySelectorAll('#ua-sticky-city-selector-style')).toHaveLength(1);
  });
});
