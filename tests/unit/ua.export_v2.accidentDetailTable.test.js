/**
 * Unit tests for accidentDetailTable in ua.export_v2.js
 * Tests: grouping by severity, per-group cap, histogram bit-counting, empty groups, sorting.
 */

describe('accidentDetailTable', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

    // ua.export_v2.js depends on UA.COMBO_LABEL and UA.maskFromProps from ua.filters.js
    // and UA.escHtml / UA.normKey from ua.utils.js.
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function(window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);

    const filtersPath = path.resolve(__dirname, '../../js/ua.filters.js');
    (function(window) { eval(fs.readFileSync(filtersPath, 'utf8')); })(mockWindow);

    // Load ua.accident_views.js (must precede ua.export_v2.js)
    const viewsPath = path.resolve(__dirname, '../../js/ua.accident_views.js');
    (function(window) { eval(fs.readFileSync(viewsPath, 'utf8')); })(mockWindow);

    // Minimal stubs needed by ua.export_v2.js at load time
    mockWindow.fetch = async () => ({ ok: false });
    mockWindow.L = { latLngBounds: () => {} };

    const exportPath = path.resolve(__dirname, '../../js/ua.export_v2.js');
    (function(window) { eval(fs.readFileSync(exportPath, 'utf8')); })(mockWindow);

    UA = mockWindow.UA;
  });

  // Helper: build a minimal point object
  function pt(ukategorie, year, ustunde, maskProps = { IstRad: '1' }) {
    return {
      lat: 52.0,
      lon: 9.7,
      props: {
        ukategorie: String(ukategorie),
        year: String(year),
        ustunde: String(ustunde),
        uwochentag: '2',
        strzustand: '0',
        IstFuss: '0', IstPKW: '0', IstKrad: '0',
        ...maskProps
      }
    };
  }

  test('returns groups in severity order 1 → 2 → 3', () => {
    const pts = [
      pt('3', 2022, 10),
      pt('1', 2020, 8),
      pt('2', 2021, 9)
    ];
    const result = UA.accidentDetailTable(pts);
    expect(result.groups.map(g => g.sevKey)).toEqual(['1', '2', '3']);
  });

  test('empty groups are omitted', () => {
    // Only severity 2 and 3
    const pts = [pt('2', 2021, 10), pt('3', 2022, 11)];
    const result = UA.accidentDetailTable(pts);
    expect(result.groups.map(g => g.sevKey)).toEqual(['2', '3']);
    expect(result.groups.find(g => g.sevKey === '1')).toBeUndefined();
  });

  test('within a group, rows are sorted year desc then hour asc', () => {
    const pts = [
      pt('2', 2021, 15),
      pt('2', 2023, 10),
      pt('2', 2023, 7),
      pt('2', 2021, 5)
    ];
    const result = UA.accidentDetailTable(pts);
    const rows = result.groups[0].rows;
    // 2023 before 2021; within same year, hour ascending
    expect(rows[0].year).toBe(2023);
    expect(rows[0].hour).toBe(7);
    expect(rows[1].year).toBe(2023);
    expect(rows[1].hour).toBe(10);
    expect(rows[2].year).toBe(2021);
    expect(rows[2].hour).toBe(5);
    expect(rows[3].year).toBe(2021);
    expect(rows[3].hour).toBe(15);
  });

  test('per-group cap limits rows and sets overflow', () => {
    const pts = Array.from({ length: 25 }, (_, i) => pt('3', 2022, i % 24));
    const result = UA.accidentDetailTable(pts, 20);
    const g = result.groups[0];
    expect(g.count).toBe(25);
    expect(g.rows.length).toBe(20);
    expect(g.overflow).toBe(5);
    expect(result.truncated).toBe(true);
  });

  test('default cap is 20 per group', () => {
    const pts = Array.from({ length: 30 }, (_, i) => pt('3', 2022, i % 24));
    const result = UA.accidentDetailTable(pts);
    expect(result.groups[0].rows.length).toBe(20);
    expect(result.groups[0].overflow).toBe(10);
  });

  test('no overflow when count <= maxRows', () => {
    const pts = [pt('2', 2021, 8), pt('2', 2022, 9)];
    const result = UA.accidentDetailTable(pts, 20);
    expect(result.groups[0].overflow).toBe(0);
    expect(result.truncated).toBe(false);
  });

  test('flattened rows equals all group rows concatenated', () => {
    const pts = [pt('1', 2020, 8), pt('2', 2021, 9), pt('3', 2022, 10)];
    const result = UA.accidentDetailTable(pts);
    const expected = result.groups.flatMap(g => g.rows);
    expect(result.rows).toEqual(expected);
  });

  test('total counts all items regardless of cap', () => {
    const pts = Array.from({ length: 25 }, () => pt('3', 2022, 10));
    const result = UA.accidentDetailTable(pts, 20);
    expect(result.total).toBe(25);
  });

  test('histogram bit-counting: mask=5 (Rad+PKW) counts in both Rad and PKW', () => {
    // mask 5 = bit1 (Rad) | bit4 (PKW)
    const pts = [
      { lat: 52.0, lon: 9.7, props: { ukategorie: '2', year: '2022', ustunde: '10', uwochentag: '2', strzustand: '0', IstRad: '1', IstFuss: '0', IstPKW: '1', IstKrad: '0' } },
      { lat: 52.0, lon: 9.7, props: { ukategorie: '2', year: '2022', ustunde: '11', uwochentag: '2', strzustand: '0', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0' } }
    ];
    const result = UA.accidentDetailTable(pts);
    const g = result.groups[0]; // sev=2
    // 🚲 appears in both accidents (count=2), 🚗 only in first (count=1)
    expect(g.histogram).toContain('🚲: 2');
    expect(g.histogram).toContain('🚗: 1');
    // 🚶 not in any accident
    expect(g.histogram).not.toContain('🚶');
  });

  test('histogram only includes involvement types with count > 0', () => {
    // mask 2 = Fußgänger only
    const pts = [
      { lat: 52.0, lon: 9.7, props: { ukategorie: '3', year: '2022', ustunde: '10', uwochentag: '2', strzustand: '0', IstRad: '0', IstFuss: '1', IstPKW: '0', IstKrad: '0' } }
    ];
    const result = UA.accidentDetailTable(pts);
    const g = result.groups[0];
    expect(g.histogram).toContain('🚶: 1');
    expect(g.histogram).not.toContain('🚲');
    expect(g.histogram).not.toContain('🚗');
  });

  test('points with mask=0 are excluded', () => {
    // All IstXxx = '0' → mask 0
    const pts = [
      { lat: 52.0, lon: 9.7, props: { ukategorie: '2', year: '2022', ustunde: '10', uwochentag: '2', strzustand: '0', IstRad: '0', IstFuss: '0', IstPKW: '0', IstKrad: '0' } },
      pt('2', 2021, 9)
    ];
    const result = UA.accidentDetailTable(pts);
    expect(result.total).toBe(1);
  });

  test('WEEKDAY_LABEL_MAP maps individual days correctly', () => {
    const pts = [
      { lat: 52.0, lon: 9.7, props: { ukategorie: '3', year: '2022', ustunde: '10', uwochentag: '1', strzustand: '0', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0' } }, // So
      { lat: 52.0, lon: 9.7, props: { ukategorie: '3', year: '2022', ustunde: '11', uwochentag: '2', strzustand: '0', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0' } }, // Mo
      { lat: 52.0, lon: 9.7, props: { ukategorie: '3', year: '2022', ustunde: '12', uwochentag: '6', strzustand: '0', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0' } }, // Fr
      { lat: 52.0, lon: 9.7, props: { ukategorie: '3', year: '2022', ustunde: '13', uwochentag: '7', strzustand: '0', IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0' } }  // Sa
    ];
    const result = UA.accidentDetailTable(pts);
    const weekdays = result.rows.map(r => r.weekday);
    expect(weekdays).toContain('So');
    expect(weekdays).toContain('Mo');
    expect(weekdays).toContain('Fr');
    expect(weekdays).toContain('Sa');
    // Must NOT contain the old grouped weekday label 'Mo–Fr'
    expect(weekdays).not.toContain('Mo–Fr');
  });

  test('groups property and count reflect total group size before cap', () => {
    const pts = Array.from({ length: 5 }, () => pt('1', 2022, 10));
    const result = UA.accidentDetailTable(pts, 3);
    expect(result.groups[0].count).toBe(5);
    expect(result.groups[0].rows.length).toBe(3);
  });

  test('groups have correct sevLabel', () => {
    const pts = [pt('1', 2020, 8), pt('2', 2021, 9), pt('3', 2022, 10)];
    const result = UA.accidentDetailTable(pts);
    expect(result.groups[0].sevLabel).toBe('Getötet');
    expect(result.groups[1].sevLabel).toBe('Schwerverletzt');
    expect(result.groups[2].sevLabel).toBe('Leichtverletzt');
  });
});
