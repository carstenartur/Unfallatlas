/**
 * Unit tests for PR 2 / Spec-Items 4 + 6:
 *   - structured.meta.activeFilterScope
 *   - structured.meta.patternAnalysisScope
 *   - structured.meta.baselineScope
 *   - structured.methodikScope (scope explanation and explicit inference limits)
 *
 * Diese Felder werden von DOCX/PDF/HTML/AI-Renderern referenziert, um den
 * Bezugsrahmen aller Fallzahlen explizit zu machen ("Hinweis zur Zählweise"-
 * Box + Methodik-Block). Sie müssen deterministisch aus ctx.ui-Filtern,
 * Bounding-Box und CITY_RAW abgeleitet werden.
 */

describe('UA.computeExportReport – scope fields (PR 2)', () => {
  let UA, load;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');
    load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      // eslint-disable-next-line no-eval
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    mockWindow.location = { href: 'http://localhost/?city=Hannover' };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeBounds() {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    return {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getSouth: () => sw.lat,
      getWest: () => sw.lng,
      getNorth: () => ne.lat,
      getEast: () => ne.lng,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: (latlng) => {
        const [la, lo] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
        return la >= sw.lat && la <= ne.lat && lo >= sw.lng && lo <= ne.lng;
      }
    };
  }

  function makeUI() {
    return {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      dayTypeEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: true },
      incGkfzEl: { checked: true },
      incSonEl: { checked: true }
    };
  }

  function makeCtx(extra) {
    return Object.assign({
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: makeBounds(),
      ui: makeUI(),
      exportOptions: { includeCosts: false, includeMeasures: false }
    }, extra || {});
  }

  test('exposes activeFilterScope on structured.meta with bounds + filters + activeFilterMask', async () => {
    UA.reverseGeocode = async () => null;
    const r = await UA.computeExportReport(makeCtx());
    const scope = r.structured.meta.activeFilterScope;
    expect(scope).toBeDefined();
    expect(typeof scope.bounds).toBe('string');
    expect(scope.bounds).toMatch(/52\.\d+,9\.\d+ – 52\.\d+,9\.\d+/);
    expect(scope.filters).toBeDefined();
    expect(scope.filters.severity).toBe('all');
    expect(typeof scope.activeFilterMask).toBe('number');
    expect(scope.involvementMode).toBe('or');
  });

  test('exposes patternAnalysisScope describing involvement-filtered population', async () => {
    UA.reverseGeocode = async () => null;
    const r = await UA.computeExportReport(makeCtx());
    const scope = r.structured.meta.patternAnalysisScope;
    expect(scope).toBeDefined();
    expect(scope.basis).toMatch(/Beteiligungsmaske > 0/);
    expect(scope.bounds).toBe(r.structured.meta.bounds);
    expect(scope.filters).toBeDefined();
  });

  test('exposes baselineScope referring to city-wide population with non-involvement filters only', async () => {
    UA.reverseGeocode = async () => null;
    const r = await UA.computeExportReport(makeCtx());
    const scope = r.structured.meta.baselineScope;
    expect(scope).toBeDefined();
    expect(scope.basis).toMatch(/Stadtweite Population/);
    expect(scope.city).toBe('Hannover');
    // Baseline filters MUST exclude beteiligungsbezogene Felder
    expect(scope.filters).toBeDefined();
    expect(scope.filters).not.toHaveProperty('includeCyclist');
    expect(scope.filters).not.toHaveProperty('includeCar');
    expect(scope.filters).not.toHaveProperty('involvementMode');
    expect(scope.filters).toHaveProperty('severity');
    expect(scope.filters).toHaveProperty('dayType');
  });

  test('carries the exploratory limitation in structured methodology and visible preview', async () => {
    UA.reverseGeocode = async () => null;
    const r = await UA.computeExportReport(makeCtx());
    const ms = r.structured.methodikScope;
    expect(ms).toBeDefined();
    expect(typeof ms.title).toBe('string');
    expect(ms.title).toMatch(/Methodik/i);
    expect(Array.isArray(ms.lines)).toBe(true);
    expect(ms.lines.length).toBe(4);
    expect(ms.limitations).toMatchObject({ inference: 'exploratory', multiplicityAdjustment: 'none', referenceIncludesLocal: true });
    expect(ms.limitations.note).toMatch(/explorativ.*unbereinigt.*Mehrfachtestkorrektur/is);
    expect(ms.limitations.note).toMatch(/Baseline.*ausgewählten Bereich/is);
    expect(ms.lines[3]).toBe(ms.limitations.note);
    expect(r.html).toContain(ms.limitations.note);
    expect(r.text).toContain(ms.limitations.note);
    expect(ms.lines[0]).toMatch(/Auswertungsbereich/);
    expect(ms.lines[1]).toMatch(/Analyse auffälliger Unfallmuster/);
    expect(ms.lines[2]).toMatch(/Vergleich mit dem Stadtgebiet/);
    // Baseline-Satz nennt die Stadt namentlich.
    expect(ms.lines[2]).toMatch(/Hannover/);
  });

  test('preserves the qualification through the actual runtime AnalysisScope wrapper', async () => {
    load('ua.analysis_scope.js');
    const report = await UA.computeExportReport(makeCtx());
    const method = report.structured.methodikScope;
    expect(method.title).toBe('Methodik – eindeutige Zählbereiche');
    expect(method.limitations).toEqual(UA.patternComparisonLimitations);
    expect(method.lines).toContain(UA.patternComparisonLimitations.note);
    expect(report.html).toContain(UA.patternComparisonLimitations.note);
  });

  test('an unconfirmed reverse-geocoded midpoint does not name the investigation area', async () => {
    UA.reverseGeocode = async () => ({ label: 'Linden-Limmer' });
    const r = await UA.computeExportReport(makeCtx());
    const scope = r.structured.meta.activeFilterScope;
    expect(scope.areaName).toMatch(/^Markierter Untersuchungsbereich in Hannover \(/);
    expect(scope.areaName).toContain(scope.bounds);
    expect(r.structured.methodikScope.lines[0]).toContain(scope.areaName);
    expect(r.structured.methodikScope.lines[0]).not.toMatch(/Linden-Limmer/);
  });

  test('methodikScope uses the area name confirmed through the geometry-bound control', async () => {
    document.body.innerHTML = '<input id="areaNameInput"><input id="areaSearchTermsInput">'
      + '<button id="btnConfirmAreaName"></button><button id="btnResetAreaName"></button><div id="areaNameStatus"></div>';
    UA.setQS = jest.fn();
    load('ua.area_name_control.js');
    UA.reverseGeocode = async () => ({ label: 'Unbestätigter Mittelpunktname' });
    const ctx = makeCtx();
    UA.AreaNameControl.bind(ctx, jest.fn());
    document.getElementById('areaNameInput').value = 'Bestätigter Untersuchungsbereich Linden-Limmer';
    document.getElementById('btnConfirmAreaName').click();
    expect(JSON.parse(ctx._confirmedAreaGeometry)).toEqual(['Hannover', 52, 9.7, 52.5, 9.9]);

    const r = await UA.computeExportReport(ctx);
    expect(r.structured.meta.activeFilterScope.areaName).toBe('Bestätigter Untersuchungsbereich Linden-Limmer');
    expect(r.structured.methodikScope.lines[0]).toContain('Bestätigter Untersuchungsbereich Linden-Limmer');
    expect(r.structured.methodikScope.lines[0]).not.toContain('Unbestätigter Mittelpunktname');
  });
});
