'use strict';

const {
  parseLocalizedInteger,
  visibleCountFromStatus,
} = require('../../scripts/parse-localized-count.cjs');

describe('localized integer status parser', () => {
  test.each([
    ['18,230', 18230],
    ['18.230', 18230],
    ['18 230', 18230],
    ['18\u00A0230', 18230],
    ['18\u202F230', 18230],
    ['1,234,567', 1234567],
    ['1.234.567', 1234567],
    ['42', 42],
  ])('parses integer %s without treating grouping as decimals', (text, expected) => {
    expect(parseLocalizedInteger(text)).toBe(expected);
  });

  test.each([
    ['Stadt: Hannover | geladen: 19,248 | im Viewport: 18,230', 18230],
    ['im Viewport: 18.230 Unfälle', 18230],
    ['im Viewport: 18\u00A0230 Unfälle', 18230],
    ['im Viewport: 18\u202F230 Unfälle', 18230],
    ['lokal 1.234 Unfälle | Stadt 99.999', 1234],
    ['lokal 7 Unfälle', 7],
  ])('extracts the visible count from %s', (status, expected) => {
    expect(visibleCountFromStatus(status)).toBe(expected);
  });

  test('does not combine unrelated counts beyond the matched field', () => {
    expect(visibleCountFromStatus(
      'im Viewport: 18,230 | davon schwer: 932 | geladen: 19,248',
    )).toBe(18230);
  });

  test.each([
    ['', null],
    [null, null],
    ['keine Zahl', null],
    ['999999999999999999999999', null],
  ])('rejects missing or unsafe integer input %#', (value, expected) => {
    expect(parseLocalizedInteger(value)).toBe(expected);
  });

  test.each([
    ['', 0],
    ['Stadt: Hannover | geladen: 19,248', 0],
    ['im Viewport: keine Unfälle', 0],
    ['lokal unbekannt', 0],
  ])('returns zero when no visible-count field can be parsed %#', (status, expected) => {
    expect(visibleCountFromStatus(status)).toBe(expected);
  });
});
