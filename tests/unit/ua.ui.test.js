/**
 * Unit tests for ua.ui.js – URL-roundtrip and syncHourUI logic
 */

describe('UA.ui - URL-Roundtrip and syncHourUI', () => {
  let UA;
  let mockWindow;

  function loadModules(locationHref = 'http://localhost:8000/werkbank_v2.html') {
    mockWindow = {
      UA: {},
      location: { href: locationHref },
      history: { replaceState: jest.fn() },
    };

    const fs = require('fs');
    const path = require('path');

    // Load ua.utils.js first
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function(window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);

    // Load ua.ui.js
    const uiPath = path.resolve(__dirname, '../../js/ua.ui.js');
    (function(window) { eval(fs.readFileSync(uiPath, 'utf8')); })(mockWindow);

    UA = mockWindow.UA;
  }

  function makeUi(overrides = {}) {
    return {
      severityEl: { value: 'all' },
      dayTypeEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      hFromEl: { value: '0', min: '0', max: '23' },
      hToEl: { value: '23', min: '0', max: '23' },
      hFromLbl: { textContent: '' },
      hToLbl: { textContent: '' },
      hourFill: { style: {} },
      maxPointsEl: { value: '100000' },
      viewportPaddingEl: { value: '20' },
      heatRadiusEl: { value: '25' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      ...overrides,
    };
  }

  function makeCtx(overrides = {}) {
    return {
      CITY_RAW: 'Hannover',
      involvementMode: 'or',
      showCluster: true,
      showHeatmap: true,
      showOnlyAboveAverage: false,
      showSchools: true,
      showKindergartens: true,
      selectionBounds: null,
      map: {
        getCenter: () => ({ lat: 52.0, lng: 9.0 }),
        getZoom: () => 12,
      },
      ...overrides,
    };
  }

  // ─── syncAllToUrl – showSchools und showKindergartens ─────────────────────

  describe('syncAllToUrl', () => {
    test('setzt showSchools und showKindergartens in die URL', () => {
      loadModules();
      const ctx = makeCtx({ showSchools: true, showKindergartens: false });
      ctx.ui = makeUi();

      const allCalls = [];
      UA.setQS = (params) => { allCalls.push(params); };
      UA.saveCityState = () => {};

      UA.syncAllToUrl(ctx);

      // First call is the main syncAllToUrl setQS call
      const mainParams = allCalls[0];
      expect(mainParams).not.toBeUndefined();
      expect(mainParams.showSchools).toBe(1);
      expect(mainParams.showKindergartens).toBe(0);
    });

    test('setzt showSchools=0 wenn showSchools=false', () => {
      loadModules();
      const ctx = makeCtx({ showSchools: false, showKindergartens: true });
      ctx.ui = makeUi();

      const allCalls = [];
      UA.setQS = (params) => { allCalls.push(params); };
      UA.saveCityState = () => {};

      UA.syncAllToUrl(ctx);

      const mainParams = allCalls[0];
      expect(mainParams.showSchools).toBe(0);
      expect(mainParams.showKindergartens).toBe(1);
    });

    test('enthält alle Pflichtparameter', () => {
      loadModules();
      const ctx = makeCtx();
      ctx.ui = makeUi();

      const allCalls = [];
      UA.setQS = (params) => { allCalls.push(params); };
      UA.saveCityState = () => {};

      UA.syncAllToUrl(ctx);

      const mainParams = allCalls[0];
      expect(mainParams).toHaveProperty('showCluster');
      expect(mainParams).toHaveProperty('showHeatmap');
      expect(mainParams).toHaveProperty('showOnlyAboveAverage');
      expect(mainParams).toHaveProperty('showSchools');
      expect(mainParams).toHaveProperty('showKindergartens');
      expect(mainParams).toHaveProperty('severity');
      expect(mainParams).toHaveProperty('involvementMode');
    });
  });

  // ─── syncHourUI ───────────────────────────────────────────────────────────

  describe('syncHourUI', () => {
    test('from > to wird auf from korrigiert wenn "from" geändert', () => {
      loadModules();
      const ctx = makeCtx();
      ctx.ui = makeUi({ hFromEl: { value: '18', min: '0', max: '23' }, hToEl: { value: '6', min: '0', max: '23' }, hFromLbl: { textContent: '' }, hToLbl: { textContent: '' }, hourFill: { style: {} } });

      UA.syncHourUI(ctx, 'from');

      // hToEl should be corrected to equal hFrom (18)
      expect(ctx.ui.hToEl.value).toBe('18');
    });

    test('to < from wird auf to korrigiert wenn "to" geändert', () => {
      loadModules();
      const ctx = makeCtx();
      ctx.ui = makeUi({ hFromEl: { value: '12', min: '0', max: '23' }, hToEl: { value: '6', min: '0', max: '23' }, hFromLbl: { textContent: '' }, hToLbl: { textContent: '' }, hourFill: { style: {} } });

      UA.syncHourUI(ctx, 'to');

      // hFromEl should be corrected to equal hTo (6)
      expect(ctx.ui.hFromEl.value).toBe('6');
    });
  });
});
