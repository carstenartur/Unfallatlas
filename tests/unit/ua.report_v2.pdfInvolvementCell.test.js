/**
 * Unit tests for pdfInvolvementCell — the inline-SVG icon helper that
 * makes vehicle/cyclist/pedestrian symbols visible in PDF table cells
 * (since pdfMake's default Roboto font cannot render emoji glyphs).
 *
 * We don't want to fully render a PDF here, so we exercise the helper via
 * the UA.* surface that ua.report_v2.js exposes for testing.
 */

describe('UA.pdfInvolvementCell', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {}, location: { href: 'http://localhost/' } };
    const fs = require('fs');
    const path = require('path');
    // ua.report_v2.js depends on a few utilities; load just enough so the
    // outer IIFE can finish without throwing. We intentionally don't load
    // pdfMake / docx — pdfInvolvementCell is a pure function that only
    // builds plain pdfMake-compatible objects.
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function (window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);
    const reportPath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    (function (window) { eval(fs.readFileSync(reportPath, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  test('exposes pdfInvolvementCell as a function', () => {
    expect(typeof UA.pdfInvolvementCell).toBe('function');
  });

  test('returns the input string unchanged when no involvement emoji is present', () => {
    expect(UA.pdfInvolvementCell('Gesamt')).toBe('Gesamt');
    expect(UA.pdfInvolvementCell('')).toBe('');
    expect(UA.pdfInvolvementCell(null)).toBe('');
    expect(UA.pdfInvolvementCell(undefined)).toBe('');
  });

  test('produces a columns node with one SVG per involvement emoji', () => {
    // 🚲+🚗 → bike icon, "+" text, car icon
    const cell = UA.pdfInvolvementCell('\u{1F6B2}+\u{1F697}');
    expect(typeof cell).toBe('object');
    expect(Array.isArray(cell.columns)).toBe(true);
    const svgs = cell.columns.filter(c => c && typeof c.svg === 'string');
    expect(svgs.length).toBe(2);
    // SVG payloads should be self-contained <svg>… documents with path data.
    for (const s of svgs) {
      expect(s.svg).toMatch(/^<svg/);
      expect(s.svg).toMatch(/<path/);
    }
    // The plain "+" text fragment must survive.
    const texts = cell.columns.filter(c => c && typeof c.text === 'string');
    expect(texts.some(t => t.text === '+')).toBe(true);
  });

  test('handles all six involvement classes (🚲 🚶 🚗 🏍 🚛 🚌)', () => {
    const allSix = '\u{1F6B2}+\u{1F6B6}+\u{1F697}+\u{1F3CD}+\u{1F69B}+\u{1F68C}';
    const cell = UA.pdfInvolvementCell(allSix);
    const svgs = cell.columns.filter(c => c && typeof c.svg === 'string');
    expect(svgs.length).toBe(6);
  });

  test('strips the VS-16 variation selector after 🏍 and still emits an icon', () => {
    // 🏍 frequently arrives as 🏍️ (with U+FE0F). The helper must look these up
    // by stripping the variation selector before mapping to an icon key.
    const cell = UA.pdfInvolvementCell('\u{1F3CD}\uFE0F');
    expect(typeof cell).toBe('object');
    const svgs = cell.columns.filter(c => c && typeof c.svg === 'string');
    expect(svgs.length).toBe(1);
  });

  test('preserves count suffix text (e.g. "🚲: 4")', () => {
    const cell = UA.pdfInvolvementCell('\u{1F6B2}: 4');
    expect(typeof cell).toBe('object');
    const svgs = cell.columns.filter(c => c && typeof c.svg === 'string');
    expect(svgs.length).toBe(1);
    const txt = cell.columns.filter(c => c && typeof c.text === 'string').map(c => c.text).join('');
    expect(txt).toContain('4');
  });

  test('respects fontSize / iconSize options', () => {
    const cell = UA.pdfInvolvementCell('\u{1F6B2}', { fontSize: 7, iconSize: 9 });
    const svg = cell.columns.find(c => c && typeof c.svg === 'string');
    expect(svg.width).toBe(9);
    expect(svg.height).toBe(9);
  });

  test('does NOT leave any raw emoji code point in the resulting object', () => {
    const cell = UA.pdfInvolvementCell('\u{1F6B2}+\u{1F697}');
    // Walk the structure and assert no string contains an involvement emoji.
    const blob = JSON.stringify(cell);
    expect(blob).not.toMatch(/\u{1F6B2}/u);
    expect(blob).not.toMatch(/\u{1F697}/u);
  });
});
