/**
 * Unit tests for ua.filters.js filter logic
 */

describe('UA.filters - Filter Logic', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

    // Load ua.utils.js first (needed for WEEKEND_SET)
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function(window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);

    // Load ua.filters.js
    const filtersPath = path.resolve(__dirname, '../../js/ua.filters.js');
    (function(window) { eval(fs.readFileSync(filtersPath, 'utf8')); })(mockWindow);

    UA = mockWindow.UA;
  });

  function makeUi(overrides = {}) {
    return {
      severityEl: { value: 'all' },
      dayTypeEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      maxPointsEl: { value: '100000' },
      viewportPaddingEl: { value: '20' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      incGkfzEl: { checked: false },
      incSonEl: { checked: false },
      ...overrides,
    };
  }

  function makeCtx(overrides = {}) {
    return {
      ui: makeUi(),
      involvementMode: 'or',
      allPts: [],
      ...overrides,
    };
  }

  // ─── maskFromProps ────────────────────────────────────────────────────────

  describe('maskFromProps', () => {
    test('Fahrrad-only ergibt Maske 1', () => {
      const pr = { istrad: '1', istfuss: '0', istpkw: '0', istkrad: '0' };
      expect(UA.maskFromProps(pr)).toBe(1);
    });

    test('alle vier klassischen Beteiligungen ergibt Maske 15', () => {
      const pr = { istrad: '1', istfuss: '1', istpkw: '1', istkrad: '1' };
      expect(UA.maskFromProps(pr)).toBe(15);
    });

    test('leere Props ergibt 0', () => {
      expect(UA.maskFromProps({})).toBe(0);
    });

    test('Fußgänger-only ergibt Maske 2', () => {
      const pr = { istrad: '0', istfuss: '1', istpkw: '0', istkrad: '0' };
      expect(UA.maskFromProps(pr)).toBe(2);
    });

    test('PKW-only ergibt Maske 4', () => {
      const pr = { istrad: '0', istfuss: '0', istpkw: '1', istkrad: '0' };
      expect(UA.maskFromProps(pr)).toBe(4);
    });

    test('Motorrad-only ergibt Maske 8', () => {
      const pr = { istrad: '0', istfuss: '0', istpkw: '0', istkrad: '1' };
      expect(UA.maskFromProps(pr)).toBe(8);
    });

    test('Gkfz-only ergibt Maske 16', () => {
      const pr = { istrad: '0', istfuss: '0', istpkw: '0', istkrad: '0', istgkfz: '1', istsonstig: '0' };
      expect(UA.maskFromProps(pr)).toBe(16);
    });

    test('Sonstig-only ergibt Maske 32', () => {
      const pr = { istrad: '0', istfuss: '0', istpkw: '0', istkrad: '0', istgkfz: '0', istsonstig: '1' };
      expect(UA.maskFromProps(pr)).toBe(32);
    });

    test('Rad+Gkfz ergibt Maske 17', () => {
      const pr = { istrad: '1', istfuss: '0', istpkw: '0', istkrad: '0', istgkfz: '1' };
      expect(UA.maskFromProps(pr)).toBe(17);
    });

    test('Fuss+Gkfz ergibt Maske 18', () => {
      const pr = { istrad: '0', istfuss: '1', istpkw: '0', istkrad: '0', istgkfz: '1' };
      expect(UA.maskFromProps(pr)).toBe(18);
    });

    test('alle sechs Beteiligungen ergibt Maske 63', () => {
      const pr = { istrad: '1', istfuss: '1', istpkw: '1', istkrad: '1', istgkfz: '1', istsonstig: '1' };
      expect(UA.maskFromProps(pr)).toBe(63);
    });
  });

  // ─── matchesInvolvementFilter ─────────────────────────────────────────────

  describe('matchesInvolvementFilter', () => {
    describe('OR-Modus', () => {
      test('Bike aktiviert, Unfall mit Bike → true', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: true }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false } }),
          involvementMode: 'or',
        });
        expect(UA.matchesInvolvementFilter(ctx, 1 /* bike */)).toBe(true);
      });

      test('nur Bike aktiviert, Unfall nur Car → false', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: true }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false } }),
          involvementMode: 'or',
        });
        expect(UA.matchesInvolvementFilter(ctx, 4 /* car */)).toBe(false);
      });

      test('mehrere aktiviert, Unfall hat einen → true', () => {
        const ctx = makeCtx({ involvementMode: 'or' });
        // default ui: bike+ped+car checked, moto not
        expect(UA.matchesInvolvementFilter(ctx, 4 /* car */)).toBe(true);
      });
    });

    describe('AND-Modus', () => {
      test('Bike+Car aktiviert, Unfall hat beides → true', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: true }, incPedEl: { checked: false }, incCarEl: { checked: true }, incMotoEl: { checked: false } }),
          involvementMode: 'and',
        });
        expect(UA.matchesInvolvementFilter(ctx, 5 /* bike+car */)).toBe(true);
      });

      test('Bike+Car aktiviert, Unfall nur Bike → false', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: true }, incPedEl: { checked: false }, incCarEl: { checked: true }, incMotoEl: { checked: false } }),
          involvementMode: 'and',
        });
        expect(UA.matchesInvolvementFilter(ctx, 1 /* bike only */)).toBe(false);
      });
    });

    describe('SOLO-Modus', () => {
      test('Bike aktiviert, Unfall nur Bike → true', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: true }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false } }),
          involvementMode: 'solo',
        });
        expect(UA.matchesInvolvementFilter(ctx, 1 /* bike only */)).toBe(true);
      });

      test('Bike aktiviert, Unfall Bike+Car → false', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: true }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false } }),
          involvementMode: 'solo',
        });
        expect(UA.matchesInvolvementFilter(ctx, 5 /* bike+car */)).toBe(false);
      });
    });

    test('keine Beteiligung aktiviert → false', () => {
      const ctx = makeCtx({
        ui: makeUi({ incBikeEl: { checked: false }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false } }),
        involvementMode: 'or',
      });
      expect(UA.matchesInvolvementFilter(ctx, 1)).toBe(false);
    });

    describe('Gkfz/Sonstig-Filter', () => {
      test('Gkfz aktiviert im OR-Modus, Unfall mit Gkfz → true', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: false }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false }, incGkfzEl: { checked: true } }),
          involvementMode: 'or',
        });
        expect(UA.matchesInvolvementFilter(ctx, 16 /* gkfz */)).toBe(true);
      });

      test('Gkfz aktiviert, Unfall nur PKW → false', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: false }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false }, incGkfzEl: { checked: true } }),
          involvementMode: 'or',
        });
        expect(UA.matchesInvolvementFilter(ctx, 4 /* car */)).toBe(false);
      });

      test('Gkfz im SOLO-Modus, Unfall nur Gkfz → true', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: false }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false }, incGkfzEl: { checked: true } }),
          involvementMode: 'solo',
        });
        expect(UA.matchesInvolvementFilter(ctx, 16 /* gkfz only */)).toBe(true);
      });

      test('Gkfz im SOLO-Modus, Unfall Rad+Gkfz → false (zwei Beteiligte)', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: false }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false }, incGkfzEl: { checked: true } }),
          involvementMode: 'solo',
        });
        expect(UA.matchesInvolvementFilter(ctx, 17 /* rad+gkfz */)).toBe(false);
      });

      test('Bike+Gkfz im AND-Modus, Unfall Rad+Gkfz → true', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: true }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false }, incGkfzEl: { checked: true } }),
          involvementMode: 'and',
        });
        expect(UA.matchesInvolvementFilter(ctx, 17 /* rad+gkfz */)).toBe(true);
      });

      test('Sonstig aktiviert im OR-Modus, Unfall mit Sonstig → true', () => {
        const ctx = makeCtx({
          ui: makeUi({ incBikeEl: { checked: false }, incPedEl: { checked: false }, incCarEl: { checked: false }, incMotoEl: { checked: false }, incSonEl: { checked: true } }),
          involvementMode: 'or',
        });
        expect(UA.matchesInvolvementFilter(ctx, 32 /* sonstig */)).toBe(true);
      });
    });
  });

  // ─── matchesNonInvolvementFilters ─────────────────────────────────────────

  describe('matchesNonInvolvementFilters', () => {
    test('Severity=1 filtert Kategorie 2 raus', () => {
      const ctx = makeCtx({ ui: makeUi({ severityEl: { value: '1' } }) });
      const pr = { ukategorie: 2, strzustand: null, uwochentag: '3', ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(false);
    });

    test('Severity=1 lässt Kategorie 1 durch', () => {
      const ctx = makeCtx({ ui: makeUi({ severityEl: { value: '1' } }) });
      const pr = { ukategorie: 1, strzustand: null, uwochentag: '3', ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(true);
    });

    test('dayType=weekend filtert Wochentag raus', () => {
      const ctx = makeCtx({ ui: makeUi({ dayTypeEl: { value: 'weekend' } }) });
      const pr = { ukategorie: 1, strzustand: null, uwochentag: '3' /* Mittwoch */, ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(false);
    });

    test('dayType=weekend lässt Sonntag (1) durch', () => {
      const ctx = makeCtx({ ui: makeUi({ dayTypeEl: { value: 'weekend' } }) });
      const pr = { ukategorie: 1, strzustand: null, uwochentag: '1' /* Sonntag */, ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(true);
    });

    test('dayType=weekend lässt Samstag (7) durch', () => {
      const ctx = makeCtx({ ui: makeUi({ dayTypeEl: { value: 'weekend' } }) });
      const pr = { ukategorie: 1, strzustand: null, uwochentag: '7' /* Samstag */, ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(true);
    });

    test('hourRange 6-18 filtert Stunde 3 raus', () => {
      const ctx = makeCtx({ ui: makeUi({ hFromEl: { value: '6' }, hToEl: { value: '18' } }) });
      const pr = { ukategorie: 1, strzustand: null, uwochentag: '3', ustunde: 3 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(false);
    });

    test('hourRange 6-18 lässt Stunde 12 durch', () => {
      const ctx = makeCtx({ ui: makeUi({ hFromEl: { value: '6' }, hToEl: { value: '18' } }) });
      const pr = { ukategorie: 1, strzustand: null, uwochentag: '3', ustunde: 12 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(true);
    });

    test('roadCondition=1 filtert Zustand 2 raus', () => {
      const ctx = makeCtx({ ui: makeUi({ roadConditionEl: { value: '1' } }) });
      const pr = { ukategorie: 1, strzustand: 2, uwochentag: '3', ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(false);
    });

    test('roadCondition=__unknown__ akzeptiert leere/null Werte', () => {
      const ctx = makeCtx({ ui: makeUi({ roadConditionEl: { value: '__unknown__' } }) });
      const pr = { ukategorie: 1, strzustand: null, uwochentag: '3', ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(true);
    });

    test('roadCondition=__unknown__ filtert bekannten Zustand raus', () => {
      const ctx = makeCtx({ ui: makeUi({ roadConditionEl: { value: '__unknown__' } }) });
      const pr = { ukategorie: 1, strzustand: 1, uwochentag: '3', ustunde: 10 };
      expect(UA.matchesNonInvolvementFilters(ctx, pr)).toBe(false);
    });
  });

  // ─── applyFilters ─────────────────────────────────────────────────────────

  describe('applyFilters', () => {
    function makePoint(props) {
      return { lat: 52.0, lon: 9.0, props };
    }

    test('maxPoints=500 capped bei 500, filteredAll enthält alle', () => {
      const pts = Array.from({ length: 600 }, () => makePoint({
        istrad: '1', istfuss: '0', istpkw: '0', istkrad: '0',
        ukategorie: 1, strzustand: null, uwochentag: '3', ustunde: 10
      }));
      const ctx = makeCtx({
        ui: makeUi({ maxPointsEl: { value: '500' } }),
        allPts: pts,
      });
      UA.applyFilters(ctx);
      expect(ctx.filteredAll.length).toBe(600);
      expect(ctx.filteredCapped.length).toBe(500);
    });

    test('applyFilters mit Severity-Filter kombiniert', () => {
      const pts = [
        makePoint({ istrad: '1', istfuss: '0', istpkw: '0', istkrad: '0', ukategorie: 1, strzustand: null, uwochentag: '3', ustunde: 10 }),
        makePoint({ istrad: '1', istfuss: '0', istpkw: '0', istkrad: '0', ukategorie: 2, strzustand: null, uwochentag: '3', ustunde: 10 }),
        makePoint({ istrad: '1', istfuss: '0', istpkw: '0', istkrad: '0', ukategorie: 3, strzustand: null, uwochentag: '3', ustunde: 10 }),
      ];
      const ctx = makeCtx({
        ui: makeUi({ severityEl: { value: '1' } }),
        allPts: pts,
      });
      UA.applyFilters(ctx);
      expect(ctx.filteredAll.length).toBe(1);
      expect(ctx.filteredAll[0].props.ukategorie).toBe(1);
    });

    test('applyFilters mit mask=0 (keine Beteiligung) wird herausgefiltert', () => {
      const pts = [
        makePoint({ istrad: '0', istfuss: '0', istpkw: '0', istkrad: '0', ukategorie: 1, strzustand: null, uwochentag: '3', ustunde: 10 }),
      ];
      const ctx = makeCtx({ allPts: pts });
      UA.applyFilters(ctx);
      expect(ctx.filteredAll.length).toBe(0);
    });
  });
});
