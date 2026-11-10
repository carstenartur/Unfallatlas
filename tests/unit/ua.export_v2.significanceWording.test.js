'use strict';

const fs = require('fs');
const path = require('path');

describe('rendered pattern comparison describes its one-sided Wilson flag', () => {
  let UA;
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, text: async () => '', json: async () => ({}) });
    const mockWindow = { UA: {}, location: { href: 'http://localhost/?city=Bonn' }, fetch: global.fetch };
    for (const name of ['ua.utils.js', 'ua.filters.js', 'ua.accident_views.js', 'ua.stats.js', 'ua.export_template_defaults.js', 'ua.export_v2.js']) {
      (function (window) { eval(fs.readFileSync(path.join(__dirname, '../../js', name), 'utf8')); })(mockWindow);
    }
    UA = mockWindow.UA;
    UA.reverseGeocode = async () => null;
  });

  afterEach(() => { global.fetch = originalFetch; });

  function context(localBikeCount, cityBikeCount) {
    const point = (local, bike) => ({
      lat: local ? 52.25 : 53, lon: 9.8,
      props: { year: '2025', ukategorie: '3', ustunde: '12', uwochentag: '3', strzustand: '0',
        IstRad: bike ? '1' : '0', IstPKW: bike ? '0' : '1' },
    });
    const allPts = [
      ...Array.from({ length: 100 }, (_, i) => point(true, i < localBikeCount)),
      ...Array.from({ length: 900 }, (_, i) => point(false, i < cityBikeCount - localBikeCount)),
    ];
    return {
      CITY_RAW: 'Bonn', allPts,
      selectionBounds: {
        getSouthWest: () => ({ lat: 52, lng: 9.7 }),
        getNorthEast: () => ({ lat: 52.5, lng: 9.9 }),
        getCenter: () => ({ lat: 52.25, lng: 9.8 }),
        contains: ([lat]) => lat < 52.5,
      },
      ui: {
        severityEl: { value: 'all' }, roadConditionEl: { value: 'all' }, dayTypeEl: { value: 'all' },
        hFromEl: { value: '0' }, hToEl: { value: '23' },
        ...Object.fromEntries(['Bike', 'Ped', 'Car', 'Moto', 'Gkfz', 'Son'].map(name => [`inc${name}El`, { checked: true }])),
      },
      exportOptions: { includeCosts: false, includeMeasures: false, mode: 'technical' },
      exportMode: 'technical',
    };
  }

  test.each([
    ['entirely below', 10, 200, false],
    ['overlapping', 15, 100, false],
    ['entirely above', 30, 100, true],
  ])('an interval %s the city share keeps the actual statistics and truthful rendered tooltip', async (position, localCount, cityCount, significant) => {
    const report = await UA.computeExportReport(context(localCount, cityCount));
    const row = report.structured.deviations.rows.find(item => item.mask === 1);
    expect(row).toMatchObject({ locCnt: localCount, baseCnt: cityCount,
      locR: localCount / 100, baseR: cityCount / 1000, isSignificant: significant });
    if (position === 'entirely below') expect(row.ciHigh).toBeLessThan(row.baseR);
    else if (position === 'entirely above') expect(row.ciLow).toBeGreaterThan(row.baseR);
    else { expect(row.ciLow).toBeLessThan(row.baseR); expect(row.ciHigh).toBeGreaterThan(row.baseR); }

    const document = new DOMParser().parseFromString(report.html, 'text/html');
    const renderedRow = Array.from(document.querySelectorAll('tr')).find(item =>
      item.querySelector('.pill') && item.cells[1]?.textContent.trim() === String(localCount));
    expect(renderedRow).toBeDefined();
    const tooltip = renderedRow.cells[4].getAttribute('title');
    if (significant) expect(tooltip).toBeNull();
    else {
      expect(tooltip).toMatch(/Keine statistisch abgesicherte Überrepräsentation/);
      expect(tooltip).not.toMatch(/schließt Stadtwert ein|kleine Datenmenge/);
    }
    expect(report.text).not.toMatch(/nicht signifikant – kleine Datenmenge|nicht signifikant \(kleine Fallzahlen\)/);
    if (position === 'overlapping') expect(report.text).toMatch(/Keine statistisch abgesicherte Überrepräsentation/);
    expect(report.structured.methodikScope.limitations).toMatchObject({
      inference: 'exploratory', multiplicityAdjustment: 'none', referenceIncludesLocal: true, localIntervalOnly: true,
    });
  });
});
