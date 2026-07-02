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
