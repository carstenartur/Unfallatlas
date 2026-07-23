'use strict';

const tableHints = require('../../scripts/rendered-table-hints');

function word(text, xMin, yMin, xMax, yMax) {
  return { text, xMin, yMin, xMax, yMax, fontSize: 9 };
}

function severityWords() {
  return [
    word('Kategorie', 78, 679, 120, 688),
    word('Anzahl', 228, 679, 258, 688),
    word('Anteil', 378, 679, 404, 688),
    word('1', 78, 691, 83, 700),
    word('–', 85, 691, 90, 700),
    word('Getötete', 93, 691, 126, 700),
    word('1', 228, 691, 233, 700),
    word('4,2', 378, 691, 391, 700),
    word('%', 393, 691, 402, 700),
    word('2', 78, 703, 83, 712),
    word('–', 85, 703, 90, 712),
    word('Schwerverletzte', 93, 703, 157, 712),
    word('6', 228, 703, 233, 712),
    word('25,0', 378, 703, 396, 712),
    word('%', 398, 703, 407, 712),
    word('3', 78, 715, 83, 724),
    word('–', 85, 715, 90, 724),
    word('Leichtverletzte', 93, 715, 152, 724),
    word('17', 228, 715, 238, 724),
    word('70,8', 378, 715, 396, 724),
    word('%', 398, 715, 407, 724),
  ];
}

function wrappedSeverityWords() {
  return [
    word('Kategorie', 78, 100, 120, 109),
    word('Anzahl', 228, 100, 258, 109),
    word('Anteil', 378, 100, 404, 109),
    word('2', 78, 112, 83, 121),
    word('–', 85, 112, 90, 121),
    word('Schwer', 93, 112, 125, 121),
    word('6', 228, 112, 233, 121),
    word('25,0', 378, 112, 396, 121),
    word('verletzte', 93, 124, 135, 133),
    word('%', 398, 124, 407, 133),
  ];
}

function hint(overrides = {}) {
  return {
    page: 1,
    tableId: 'severity',
    headers: ['Kategorie', 'Anzahl', 'Anteil'],
    rows: [
      {
        rowId: 'severity.fatal',
        cellPatterns: ['^1\\s*–\\s*Getötete$', '^1$', '^4,2%$'],
      },
      {
        rowId: 'severity.serious',
        cellPatterns: ['^2\\s*–\\s*Schwerverletzte$', '^6$', '^25,0%$'],
      },
      {
        rowId: 'severity.light',
        cellPatterns: ['^3\\s*–\\s*Leichtverletzte$', '^17$', '^70,8%$'],
      },
    ],
    ...overrides,
  };
}

describe('rendered table hints', () => {
  test('reconstructs final header and data row boxes from Poppler words', () => {
    const rows = tableHints.applyTableHints(severityWords(), [hint()], 1);

    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      rowId: 'severity.header',
      tableId: 'severity',
      repeatedHeader: false,
      cells: ['Kategorie', 'Anzahl', 'Anteil'],
    });
    expect(rows.slice(1).map((row) => row.cells)).toEqual([
      ['1 – Getötete', '1', '4,2%'],
      ['2 – Schwerverletzte', '6', '25,0%'],
      ['3 – Leichtverletzte', '17', '70,8%'],
    ]);
    expect(rows.every((row) => row.xMin < row.xMax && row.yMin < row.yMax)).toBe(true);
    expect(rows[1].yMin).toBeGreaterThan(rows[0].yMax);
  });

  test('reconstructs wrapped cells from consecutive final-page lines', () => {
    const rows = tableHints.applyTableHints(wrappedSeverityWords(), [hint({
      maxLinesPerRow: 2,
      rows: [{
        rowId: 'severity.serious',
        cellPatterns: ['^2\\s*–\\s*Schwer verletzte$', '^6$', '^25,0%$'],
      }],
    })], 1);

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      rowId: 'severity.serious',
      cells: ['2 – Schwer verletzte', '6', '25,0%'],
      yMin: 112,
      yMax: 133,
    });
  });

  test('marks a continuation-page header as an actual repeated header', () => {
    const rows = tableHints.applyTableHints(severityWords(), [hint({
      page: 2,
      repeatedHeader: true,
      rows: [hint().rows[2]],
    })], 2);

    expect(rows[0]).toMatchObject({
      rowId: 'severity.header.page2',
      tableId: 'severity',
      repeatedHeader: true,
    });
    expect(rows[1].rowId).toBe('severity.light');
  });

  test('requires repeatedHeader to be an actual boolean', () => {
    expect(() => tableHints.applyTableHints(
      severityWords(),
      [hint({ repeatedHeader: 'false' })],
      1,
    )).toThrow(/invalid_table_hint/);
  });

  test('ignores hints declared for another page', () => {
    expect(tableHints.applyTableHints(severityWords(), [hint()], 2)).toEqual([]);
  });

  test('honours an explicit zero line tolerance', () => {
    const shiftedHeader = severityWords().map((item) =>
      item.text === 'Anteil'
        ? { ...item, yMin: item.yMin + 1, yMax: item.yMax + 1 }
        : item
    );

    expect(tableHints.applyTableHints(shiftedHeader, [hint()], 1)).toHaveLength(4);
    expect(() => tableHints.applyTableHints(
      shiftedHeader,
      [hint({ lineTolerance: 0 })],
      1,
    )).toThrow(/table_header_missing/);
  });

  test('rejects invalid line tolerances and row wrapping budgets', () => {
    expect(() => tableHints.applyTableHints(
      severityWords(),
      [hint({ lineTolerance: -1 })],
      1,
    )).toThrow(/invalid_table_hint/);
    expect(() => tableHints.applyTableHints(
      severityWords(),
      [hint({ lineTolerance: 'not-a-number' })],
      1,
    )).toThrow(/invalid_table_hint/);
    expect(() => tableHints.applyTableHints(
      wrappedSeverityWords(),
      [hint({ maxLinesPerRow: 0, rows: [hint().rows[1]] })],
      1,
    )).toThrow(/invalid_table_hint/);
    expect(() => tableHints.applyTableHints(
      wrappedSeverityWords(),
      [hint({ rows: [{ ...hint().rows[1], maxLines: 1.5 }] })],
      1,
    )).toThrow(/invalid_table_hint/);
  });

  test('fails when wrapped final text exceeds the declared line budget', () => {
    expect(() => tableHints.applyTableHints(wrappedSeverityWords(), [hint({
      maxLinesPerRow: 1,
      rows: [{
        rowId: 'severity.serious',
        cellPatterns: ['^2\\s*–\\s*Schwer verletzte$', '^6$', '^25,0%$'],
      }],
    })], 1)).toThrow(/table_row_missing|table_cell_mismatch/);
  });

  test('fails when the final cell text no longer matches the Golden contract', () => {
    const changed = severityWords().map((item) =>
      item.text === '17' ? { ...item, text: '16' } : item
    );
    expect(() => tableHints.applyTableHints(changed, [hint()], 1))
      .toThrow(/table_cell_mismatch/);
  });

  test('fails when the final header or row is missing', () => {
    expect(() => tableHints.applyTableHints(
      severityWords().filter((item) => item.text !== 'Kategorie'),
      [hint()],
      1,
    )).toThrow(/table_header_missing/);

    expect(() => tableHints.applyTableHints(
      severityWords().filter((item) => item.text !== 'Schwerverletzte'),
      [hint()],
      1,
    )).toThrow(/table_row_missing/);
  });

  test('normalizes punctuation without hiding numeric differences', () => {
    expect(tableHints.normalizeText(' 4,2  % ')).toBe('4,2%');
    expect(tableHints.normalizeText('1 — Getötete')).toBe('1 – Getötete');
  });
});
