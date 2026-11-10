'use strict';

const fs = require('fs');
const path = require('path');

function loadState(params = '') {
  const win = { UA: {} };
  win.UA.qs = () => new URLSearchParams(params);
  win.UA.setQS = jest.fn();
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.state.js'), 'utf8'));
  })(win);
  return win.UA;
}

const bounds = { south: 52.36770600225075, west: 9.739235043525698, north: 52.3688753291183, east: 9.741144776344301 };
const selection = {
  getSouth: () => bounds.south,
  getWest: () => bounds.west,
  getNorth: () => bounds.north,
  getEast: () => bounds.east,
};
const query = { fromYear: 2023, toYear: 2025, severity: 'serious', type: 'turning', involvement: 'bike' };

test('shares exact geometry with the selected evidence pattern and year range', () => {
  const UA = loadState('siteFocus=turning%3A5&siteFrom=2023&siteTo=2025&siteSeverity=serious&siteType=turning&siteInvolvement=bike');
  const ctx = { selectionBounds: selection };
  const restored = UA.restoreDiscoveryFocus(ctx);
  expect(restored).toEqual({ bounds, query, key: 'turning:5' });
  expect(ctx.discoveryFocus).toEqual(restored);
  expect(UA.explicitAnalysisParamsPresent()).toBe(true);

  UA.setDiscoveryFocus(ctx, restored);
  expect(UA.setQS).toHaveBeenCalledWith({ siteFocus: 'turning:5', siteFrom: 2023, siteTo: 2025, siteSeverity: 'serious', siteType: 'turning', siteInvolvement: 'bike', siteMapFilters: null });
});

test('a focus cannot survive a geometry change or malformed shared years', () => {
  const UA = loadState('siteFocus=turning%3A5&siteFrom=2025&siteTo=2023');
  const ctx = { selectionBounds: selection };
  expect(UA.restoreDiscoveryFocus(ctx)).toBeNull();
  const otherBounds = { ...bounds, east: bounds.east + 0.000001 };
  expect(UA.setDiscoveryFocus(ctx, { bounds: otherBounds, query, key: 'turning:5' })).toBeNull();
  expect(ctx.discoveryFocus).toBeNull();
  expect(UA.setQS).toHaveBeenCalledWith({ siteFocus: null, siteFrom: null, siteTo: null, siteSeverity: null, siteType: null, siteInvolvement: null, siteMapFilters: null });
});
