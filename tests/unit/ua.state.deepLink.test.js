'use strict';

const fs = require('fs');
const path = require('path');

function loadStateModules(href) {
  const mockWindow = {
    UA: {},
    location: {
      href,
      search: new URL(href).search,
      replace: jest.fn(),
    },
  };
  const utils = fs.readFileSync(path.resolve(__dirname, '../../js/ua.utils.js'), 'utf8');
  const state = fs.readFileSync(path.resolve(__dirname, '../../js/ua.state.js'), 'utf8');
  (function(window) { eval(utils); })(mockWindow);
  (function(window) { eval(state); })(mockWindow);
  return mockWindow.UA;
}

function makeCtx() {
  return {
    CITY_RAW: 'Hannover',
    involvementMode: 'or',
    showCluster: true,
    showHeatmap: false,
    showOnlyAboveAverage: false,
    ui: {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      dayTypeEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      maxPointsEl: { value: '100000' },
      viewportPaddingEl: { value: '20' },
      heatRadiusEl: { value: '25' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      incGkfzEl: { checked: false },
      incSonEl: { checked: false },
    },
    map: {
      setView: jest.fn(),
      getCenter: () => ({ lat: 52.3759, lng: 9.7320 }),
      getZoom: () => 12,
    },
    selectionBounds: null,
  };
}

function storeDifferentState() {
  localStorage.setItem('ua_state_hannover', JSON.stringify({
    severity: '2',
    roadCondition: '1',
    dayType: 'weekend',
    hourFrom: 7,
    hourTo: 9,
    maxPoints: 500,
    viewportPaddingPct: 50,
    heatRadius: 40,
    includeCyclist: 0,
    includePedestrian: 0,
    includeCar: 0,
    includeMotorcycle: 1,
    includeGkfz: 1,
    includeSonstig: 1,
    involvementMode: 'solo',
    showCluster: 0,
    showHeatmap: 1,
    showOnlyAboveAverage: 1,
    centerLat: 52.4,
    centerLon: 9.8,
    zoom: 15,
    sel: null,
  }));
}

describe('UA.state explicit deep-link precedence', () => {
  beforeEach(() => localStorage.clear());

  test.each([
    'showCluster=1',
    'severity=2',
    'includeCyclist=1',
    'mapMode=standard',
    'selSouth=52&selWest=9&selNorth=53&selEast=10',
  ])('does not restore localStorage when URL contains %s', (parameter) => {
    const UA = loadStateModules(`http://localhost:8000/werkbank_v2.html?city=Hannover&${parameter}`);
    const ctx = makeCtx();
    storeDifferentState();

    expect(UA.explicitAnalysisParamsPresent()).toBe(true);
    expect(UA.restoreCityStateIfNoUrlView(ctx)).toBe(false);
    expect(ctx.showCluster).toBe(true);
    expect(ctx.showHeatmap).toBe(false);
    expect(ctx.ui.severityEl.value).toBe('all');
    expect(ctx.ui.hFromEl.value).toBe('0');
    expect(ctx.map.setView).not.toHaveBeenCalled();
  });

  test('still restores a saved state for a city-only URL', () => {
    const UA = loadStateModules('http://localhost:8000/werkbank_v2.html?city=Hannover');
    const ctx = makeCtx();
    storeDifferentState();

    expect(UA.explicitAnalysisParamsPresent()).toBe(false);
    expect(UA.restoreCityStateIfNoUrlView(ctx)).toBe(true);
    expect(ctx.showCluster).toBe(false);
    expect(ctx.showHeatmap).toBe(true);
    expect(ctx.ui.severityEl.value).toBe('2');
    expect(ctx.ui.hFromEl.value).toBe('7');
    expect(ctx.map.setView).toHaveBeenCalledWith([52.4, 9.8], 15);
  });

  test('export-only navigation may intentionally reuse the saved analysis', () => {
    const UA = loadStateModules('http://localhost:8000/werkbank_v2.html?city=Hannover&export=1');
    const ctx = makeCtx();
    storeDifferentState();

    expect(UA.explicitAnalysisParamsPresent()).toBe(false);
    expect(UA.restoreCityStateIfNoUrlView(ctx)).toBe(true);
    expect(ctx.involvementMode).toBe('solo');
  });

  test('view coordinates remain an explicit state boundary', () => {
    const UA = loadStateModules(
      'http://localhost:8000/werkbank_v2.html?city=Hannover&centerLat=52.3&centerLon=9.7&zoom=13',
    );
    const ctx = makeCtx();
    storeDifferentState();

    expect(UA.viewParamsPresent()).toBe(true);
    expect(UA.restoreCityStateIfNoUrlView(ctx)).toBe(false);
    expect(ctx.map.setView).not.toHaveBeenCalled();
  });
});
