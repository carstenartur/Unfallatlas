'use strict';

const fs = require('fs');
const path = require('path');

function loadState(href) {
  const win = {
    UA: {},
    location: {
      href,
      search: new URL(href).search,
      replace: jest.fn(),
    },
  };
  const p = path.resolve(__dirname, '../../js/ua.state.js');
  (function(window) { eval(fs.readFileSync(p, 'utf8')); })(win);
  return win;
}

describe('UA.cleanUrlIfNeeded', () => {
  test('preserves document evidence keys and opens the map from older export links', () => {
    const input = 'http://localhost/werkbank_v2.html?city=Hannover&evidenceScope=complete&evidenceLabels=1&evidenceAccident=A021&export=1';
    const win = loadState(input);
    expect(win.UA.cleanUrlIfNeeded()).toBe(true);
    const canonical = new URL(win.location.replace.mock.calls[0][0]);
    expect(Object.fromEntries(canonical.searchParams)).toEqual({
      city: 'Hannover', evidenceScope: 'complete', evidenceLabels: '1', evidenceAccident: 'A021',
    });
    expect(loadState(canonical.href).UA.cleanUrlIfNeeded()).toBe(false);
    expect(loadState('http://localhost/werkbank_v2.html?city=Hannover&export=1').UA.cleanUrlIfNeeded()).toBe(false);
  });

  const listQuery = {
    risList: '1', risListCollapsed: '1', risQuery: 'Leine, Radweg', risLevels: 'region,state',
    risSearchPage: 'ris2.eyJ2IjoxfQ.' + 'a'.repeat(64), risSearchSnapshot: 'b'.repeat(64),
  };

  test('accepts all RIS view parameters without redirecting or discarding the shared document', () => {
    const href = 'http://localhost/werkbank_v2.html?city=Hannover&mapLayer=ris&risSelectionOnly=1&risRecord=region-hannover-ris%3A123&risView=relations&risCollapsed=1&risEventsPage=2&risRelationsPage=3&risRelatedPage=4&risLocationsPage=5&' + new URLSearchParams(listQuery);
    const win = loadState(href);

    expect(win.UA.cleanUrlIfNeeded()).toBe(false);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  test('legacy cleanup retains the exact encoded RIS record identity and all document options', () => {
    const query = new URLSearchParams({
      city: 'Hannover', kat: '2', mapLayer: 'slope,traffic,ris', risSelectionOnly: '1',
      risRecord: 'region-hannover-ris:2026/123+Anfrage A', risView: 'locations', risCollapsed: '1',
      risEventsPage: '2', risRelationsPage: '3', risRelatedPage: '4', risLocationsPage: '5',
      ...listQuery,
    });
    const win = loadState(`http://localhost/werkbank_v2.html?${query}`);

    expect(win.UA.cleanUrlIfNeeded()).toBe(true);
    const cleaned = new URL(win.location.replace.mock.calls[0][0]);
    expect(Object.fromEntries(cleaned.searchParams)).toEqual({
      city: 'Hannover', severity: '2', mapLayer: 'slope,traffic,ris', risSelectionOnly: '1',
      risRecord: 'region-hannover-ris:2026/123+Anfrage A', risView: 'locations', risCollapsed: '1',
      risEventsPage: '2', risRelationsPage: '3', risRelatedPage: '4', risLocationsPage: '5',
      ...listQuery,
    });
  });

  test('accepts map/context params as canonical (no unknown/reload)', () => {
    const href = 'http://localhost/werkbank_v2.html?city=Bonn&mapMode=hybrid&orthophotoOpacity=70&mapLayer=slope,traffic&ctxSlope=steep,very_steep&ctxTraffic=high&ctxOnlyMatched=1';
    const win = loadState(href);

    const didReload = win.UA.cleanUrlIfNeeded();

    expect(didReload).toBe(false);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  test('canonical rebuild keeps map/context/debug params in CANON order', () => {
    const href = 'http://localhost/werkbank_v2.html?city=Berlin&city=Bonn&mapMode=analysis&orthophotoOpacity=65&mapLayer=slope,traffic&ctxSlope=steep,very_steep&ctxTraffic=high&ctxOnlyMatched=1&debugSlope=1&debugSlopeSamples=1';
    const win = loadState(href);

    const didReload = win.UA.cleanUrlIfNeeded();

    expect(didReload).toBe(true);
    expect(win.location.replace).toHaveBeenCalledTimes(1);
    const cleaned = new URL(win.location.replace.mock.calls[0][0]);
    expect(cleaned.search.slice(1)).toBe(
      'city=Bonn&mapMode=analysis&orthophotoOpacity=65&ctxSlope=steep%2Cvery_steep&ctxTraffic=high&ctxOnlyMatched=1&mapLayer=slope%2Ctraffic&debugSlope=1&debugSlopeSamples=1'
    );
  });
});
