/**
 * Unit tests for UA.accidentViews (strategy registry for the accident detail section).
 */

describe('UA.accidentViews', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

    // ua.utils.js provides UA.escHtml; ua.filters.js provides UA.COMBO_LABEL.
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function(window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);

    const filtersPath = path.resolve(__dirname, '../../js/ua.filters.js');
    (function(window) { eval(fs.readFileSync(filtersPath, 'utf8')); })(mockWindow);

    const viewsPath = path.resolve(__dirname, '../../js/ua.accident_views.js');
    (function(window) { eval(fs.readFileSync(viewsPath, 'utf8')); })(mockWindow);

    UA = mockWindow.UA;
  });

  // Helper to build a minimal item (already in the post-extraction shape from accidentDetailTable).
  function item({ severity = "2", year = 2022, hour = 10, mask = 1, lat = 52.0, lon = 9.7 } = {}) {
    const sevLabelMap = { "1": "Getötet", "2": "Schwerverletzt", "3": "Leichtverletzt" };
    const involved = (UA.COMBO_LABEL && UA.COMBO_LABEL[mask]) || ("Mask " + mask);
    return {
      lat, lon, year,
      severity: String(severity),
      sevLabel: sevLabelMap[String(severity)] || "?",
      involved,
      hour,
      weekday: "Mo",
      roadCondition: "trocken",
      mask
    };
  }

  // ---------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------
  describe('registry', () => {
    test('exposes bySeverity, byInvolvement, flat strategies', () => {
      expect(UA.accidentViews).toBeDefined();
      expect(UA.accidentViews.bySeverity).toBeDefined();
      expect(UA.accidentViews.byInvolvement).toBeDefined();
      expect(UA.accidentViews.flat).toBeDefined();
    });

    test('each strategy has the required interface', () => {
      for (const id of ['bySeverity', 'byInvolvement', 'flat']) {
        const v = UA.accidentViews[id];
        expect(v.id).toBe(id);
        expect(typeof v.label).toBe('string');
        expect(typeof v.group).toBe('function');
        expect(typeof v.renderHeader.text).toBe('function');
        expect(typeof v.renderHeader.html).toBe('function');
        expect(typeof v.renderHeader.docx).toBe('function');
        expect(typeof v.renderRow.text).toBe('function');
        expect(typeof v.renderRow.html).toBe('function');
        expect(typeof v.renderRow.docx).toBe('function');
        expect(typeof v.rowCap).toBe('number');
      }
    });

    test('resolveAccidentView falls back to default for unknown ids', () => {
      expect(UA.resolveAccidentView('bogus').id).toBe(UA.ACCIDENT_VIEW_DEFAULT);
      expect(UA.resolveAccidentView('byInvolvement').id).toBe('byInvolvement');
      expect(UA.resolveAccidentView(undefined).id).toBe(UA.ACCIDENT_VIEW_DEFAULT);
    });
  });

  // ---------------------------------------------------------------------
  // bySeverity
  // ---------------------------------------------------------------------
  describe('bySeverity.group', () => {
    test('returns groups in severity order 1 → 2 → 3, omits empty groups', () => {
      const items = [
        item({ severity: "3", year: 2022 }),
        item({ severity: "1", year: 2020 })
      ];
      const groups = UA.accidentViews.bySeverity.group(items);
      expect(groups.map(g => g.key)).toEqual(['1', '3']);
    });

    test('within group: year desc, then hour asc', () => {
      const items = [
        item({ severity: "2", year: 2021, hour: 15 }),
        item({ severity: "2", year: 2023, hour: 10 }),
        item({ severity: "2", year: 2023, hour: 7 }),
        item({ severity: "2", year: 2021, hour: 5 })
      ];
      const groups = UA.accidentViews.bySeverity.group(items);
      const rows = groups[0].items;
      expect(rows.map(r => [r.year, r.hour])).toEqual([
        [2023, 7], [2023, 10], [2021, 5], [2021, 15]
      ]);
    });

    test('meta contains plural sevLabel and histogram', () => {
      const items = [
        item({ severity: "1", mask: 5 }),  // Rad+PKW
        item({ severity: "1", mask: 1 })   // Rad
      ];
      const [g] = UA.accidentViews.bySeverity.group(items);
      expect(g.meta.sevLabel).toBe('Getötete');
      expect(g.meta.totalCount).toBe(2);
      expect(g.meta.histogram).toContain('🚲: 2');
      expect(g.meta.histogram).toContain('🚗: 1');
    });
  });

  // ---------------------------------------------------------------------
  // byInvolvement
  // ---------------------------------------------------------------------
  describe('byInvolvement.group', () => {
    test('items with mask=5 and mask=4 land in different groups', () => {
      const items = [
        item({ mask: 5, severity: "2" }),
        item({ mask: 5, severity: "3" }),
        item({ mask: 4, severity: "3" })
      ];
      const groups = UA.accidentViews.byInvolvement.group(items);
      const masks = groups.map(g => g.meta.mask).sort();
      expect(masks).toEqual([4, 5]);
    });

    test('most frequent pattern first (sort by count desc, mask asc tiebreaker)', () => {
      const items = [
        item({ mask: 4 }), item({ mask: 4 }), item({ mask: 4 }),
        item({ mask: 1 }), item({ mask: 1 }),
        item({ mask: 5 })
      ];
      const groups = UA.accidentViews.byInvolvement.group(items);
      expect(groups[0].meta.mask).toBe(4); // 3 items
      expect(groups[1].meta.mask).toBe(1); // 2 items
      expect(groups[2].meta.mask).toBe(5); // 1 item
    });

    test('tiebreaker: equal totalCount → mask ascending', () => {
      const items = [
        item({ mask: 4 }),
        item({ mask: 1 })
      ];
      const groups = UA.accidentViews.byInvolvement.group(items);
      expect(groups[0].meta.mask).toBe(1);
      expect(groups[1].meta.mask).toBe(4);
    });

    test('meta.severityCounts and severityBadges reflect group composition', () => {
      const items = [
        item({ mask: 5, severity: "1" }),
        item({ mask: 5, severity: "2" }),
        item({ mask: 5, severity: "2" }),
        item({ mask: 5, severity: "3" })
      ];
      const [g] = UA.accidentViews.byInvolvement.group(items);
      expect(g.meta.severityCounts).toEqual({ "1": 1, "2": 2, "3": 1 });
      // Badges in fixed order † S L, only counts > 0
      expect(g.meta.severityBadges).toBe('† 1 / S 2 / L 1');
    });

    test('within group: severity ascending, then year descending', () => {
      const items = [
        item({ mask: 5, severity: "3", year: 2020 }),
        item({ mask: 5, severity: "1", year: 2018 }),
        item({ mask: 5, severity: "3", year: 2022 }),
        item({ mask: 5, severity: "2", year: 2021 })
      ];
      const [g] = UA.accidentViews.byInvolvement.group(items);
      expect(g.items.map(r => [r.severity, r.year])).toEqual([
        ["1", 2018], ["2", 2021], ["3", 2022], ["3", 2020]
      ]);
    });
  });

  // ---------------------------------------------------------------------
  // flat
  // ---------------------------------------------------------------------
  describe('flat.group', () => {
    test('returns exactly one group containing all items', () => {
      const items = [
        item({ severity: "1", year: 2020 }),
        item({ severity: "3", year: 2022 }),
        item({ severity: "2", year: 2021 })
      ];
      const groups = UA.accidentViews.flat.group(items);
      expect(groups.length).toBe(1);
      expect(groups[0].items.length).toBe(3);
      expect(groups[0].key).toBe('all');
    });

    test('sorts year desc, then severity asc', () => {
      const items = [
        item({ severity: "3", year: 2022 }),
        item({ severity: "1", year: 2022 }),
        item({ severity: "2", year: 2023 })
      ];
      const [g] = UA.accidentViews.flat.group(items);
      expect(g.items.map(r => [r.year, r.severity])).toEqual([
        [2023, "2"], [2022, "1"], [2022, "3"]
      ]);
    });

    test('returns empty array on empty input', () => {
      expect(UA.accidentViews.flat.group([])).toEqual([]);
    });

    test('rowCap is 50 (legacy)', () => {
      expect(UA.accidentViews.flat.rowCap).toBe(50);
    });
  });

  // ---------------------------------------------------------------------
  // Per-group cap (via applyAccidentView)
  // ---------------------------------------------------------------------
  describe('applyAccidentView per-group cap', () => {
    test('bySeverity caps at 20 with overflow', () => {
      const items = Array.from({ length: 25 }, (_, i) => item({ severity: "3", hour: i % 24 }));
      const r = UA.applyAccidentView(items, 'bySeverity');
      expect(r.groups.length).toBe(1);
      expect(r.groups[0].count).toBe(25);
      expect(r.groups[0].rows.length).toBe(20);
      expect(r.groups[0].overflow).toBe(5);
      expect(r.truncated).toBe(true);
    });

    test('byInvolvement caps at 20 per group', () => {
      const items = Array.from({ length: 25 }, () => item({ mask: 1 }));
      const r = UA.applyAccidentView(items, 'byInvolvement');
      expect(r.groups[0].count).toBe(25);
      expect(r.groups[0].rows.length).toBe(20);
      expect(r.groups[0].overflow).toBe(5);
    });

    test('flat caps at 50', () => {
      const items = Array.from({ length: 60 }, (_, i) => item({ severity: "3", year: 2022, hour: i % 24 }));
      const r = UA.applyAccidentView(items, 'flat');
      expect(r.groups[0].count).toBe(60);
      expect(r.groups[0].rows.length).toBe(50);
      expect(r.groups[0].overflow).toBe(10);
    });
  });

  // ---------------------------------------------------------------------
  // Header rendering snapshots (text)
  // ---------------------------------------------------------------------
  describe('header rendering (text)', () => {
    test('bySeverity header text format', () => {
      const items = [
        item({ severity: "1", mask: 5 }),
        item({ severity: "1", mask: 1 })
      ];
      const r = UA.applyAccidentView(items, 'bySeverity');
      expect(r.groups[0].headers.text).toBe('--- Getötete (n=2) | 🚲: 2 · 🚗: 1 ---');
    });

    test('byInvolvement header text format', () => {
      const items = [
        item({ mask: 5, severity: "1" }),
        item({ mask: 5, severity: "2" })
      ];
      const r = UA.applyAccidentView(items, 'byInvolvement');
      expect(r.groups[0].headers.text).toBe('--- 🚲+🚗 (n=2) [† 1 / S 1] ---');
    });

    test('flat header text is empty (single ungrouped section)', () => {
      const r = UA.applyAccidentView([item({ severity: "2" })], 'flat');
      expect(r.groups[0].headers.text).toBe('');
    });
  });

  // ---------------------------------------------------------------------
  // Renderer-format consistency: text and html produce the same cell data
  // ---------------------------------------------------------------------
  describe('renderRow format consistency', () => {
    test('bySeverity: text and html row reference identical cell values', () => {
      const it = item({ severity: "2", year: 2022, hour: 8, mask: 1 });
      const v = UA.accidentViews.bySeverity;
      const txt = v.renderRow.text(it, 0);
      const html = v.renderRow.html(it, 0);
      // Both must contain the same primary cell strings
      for (const needle of ['2022', '🚲', '08:00', 'Mo', 'trocken']) {
        expect(txt).toContain(needle);
        expect(html).toContain(needle);
      }
    });

    test('byInvolvement: text and html include the severity column', () => {
      const it = item({ severity: "1", year: 2022, hour: 8, mask: 4 });
      const v = UA.accidentViews.byInvolvement;
      const txt = v.renderRow.text(it, 0);
      const html = v.renderRow.html(it, 0);
      // Severity label appears (singular form "Getötet")
      expect(txt).toContain('Getötet');
      expect(html).toContain('Getötet');
    });

    test('docx row producer returns a cell array with the expected length', () => {
      const it = item({ severity: "2", year: 2022, hour: 8, mask: 1 });
      // bySeverity has 7 columns (no severity column): #, Jahr, Beteiligte, Uhrzeit, Wochentag, Fahrbahnzustand, Koordinaten
      expect(UA.accidentViews.bySeverity.renderRow.docx(it, 0)).toHaveLength(7);
      // byInvolvement / flat have 8 columns (severity included)
      expect(UA.accidentViews.byInvolvement.renderRow.docx(it, 0)).toHaveLength(8);
      expect(UA.accidentViews.flat.renderRow.docx(it, 0)).toHaveLength(8);
    });
  });

  // ---------------------------------------------------------------------
  // applyAccidentView return shape
  // ---------------------------------------------------------------------
  describe('applyAccidentView return shape', () => {
    test('contains viewId, columns, groups, total, truncated', () => {
      const items = [item({ severity: "1" })];
      const r = UA.applyAccidentView(items, 'bySeverity');
      expect(r.viewId).toBe('bySeverity');
      expect(Array.isArray(r.columns)).toBe(true);
      expect(r.columns.length).toBeGreaterThan(0);
      expect(Array.isArray(r.groups)).toBe(true);
      expect(r.total).toBe(1);
      expect(r.truncated).toBe(false);
    });

    test('groups[].headers contains pre-rendered text/html/docx', () => {
      const r = UA.applyAccidentView([item({ severity: "1" })], 'bySeverity');
      const h = r.groups[0].headers;
      expect(typeof h.text).toBe('string');
      expect(typeof h.html).toBe('string');
      expect(Array.isArray(h.docx)).toBe(true);
    });

    test('unknown viewId falls back to default (bySeverity)', () => {
      const r = UA.applyAccidentView([item({ severity: "1" })], 'totally-unknown');
      expect(r.viewId).toBe(UA.ACCIDENT_VIEW_DEFAULT);
    });
  });
});
