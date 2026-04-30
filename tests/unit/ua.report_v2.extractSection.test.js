/**
 * Focused unit test for the internal `extractSection` helper in
 * js/ua.report_v2.js. The helper drives SACHVERHALT extraction for both
 * DOCX and PDF export. Its default stop list MUST cover every block
 * header that the TEXT renderer in js/ua.export_v2.js emits after
 * "Sachverhalt:", otherwise post-Sachverhalt blocks (Mehrjahres-Trend,
 * Stunden-Heatmap, …) leak into the SACHVERHALT paragraph as raw
 * pipe-text and then render again later as proper structured tables.
 *
 * extractSection is a private function — we exercise it indirectly via
 * UA.exportToPDF in tests/unit/ua.report_v2.pdfQA.test.js. Here we
 * additionally re-evaluate the IIFE in a sandbox and surface the helper
 * by parsing its source, so the regression is pinned by a precise unit
 * test that does not depend on pdfMake/docx.
 */

const fs = require('fs');
const path = require('path');

function loadExtractSection() {
  // Re-export extractSection from ua.report_v2.js by appending a
  // window.UA._test_extractSection assignment inside the same IIFE. We
  // achieve this by injecting a marker function call onto window before
  // loading and patching the source so the helper becomes addressable.
  const filePath = path.resolve(__dirname, '../../js/ua.report_v2.js');
  let src = fs.readFileSync(filePath, 'utf8');
  // Inject a single line right before the IIFE close that surfaces
  // extractSection on window.UA. We don't want to modify the production
  // file, so do it on the in-memory copy only.
  const marker = '\n  UA._test_extractSection = extractSection;\n';
  src = src.replace(/\n}\)\(\);\s*$/, marker + '\n})();\n');

  const win = { UA: {}, location: { href: 'http://localhost/' } };
  // Provide minimal stubs the IIFE may touch at load time.
  win.docx = undefined;
  win.pdfMake = undefined;
  // eslint-disable-next-line no-eval
  (function (window) { eval(src); })(win);
  return win.UA._test_extractSection;
}

describe('extractSection (post-Sachverhalt stop-list)', () => {
  let extractSection;
  beforeAll(() => {
    extractSection = loadExtractSection();
  });

  test('exposed for testing', () => {
    expect(typeof extractSection).toBe('function');
  });

  test('truncates SACHVERHALT at "Auffälligkeiten (Top-Abweichungen…)"', () => {
    const lines = [
      'Sachverhalt:',
      'Im markierten Bereich häufen sich Unfälle mit Radfahrenden.',
      'Auffälligkeiten (Top-Abweichungen, Anteil im Ausschnitt vs. Stadt):',
      '- Rad: lokal 50,0 % vs Stadt 20,0 % (Faktor 2,50).',
      'Mehrjahres-Trend (Gesamtzahl pro Jahr):',
      '  Jahr | Getötete | Schwerverletzte | Leichtverletzte | Summe',
      '  2019 | 0 | 2 | 36 | 38'
    ];
    const out = extractSection(lines, 'Sachverhalt:');
    expect(out).toEqual([
      'Im markierten Bereich häufen sich Unfälle mit Radfahrenden.'
    ]);
  });

  test('truncates SACHVERHALT at "Mehrjahres-Trend" even without Auffälligkeiten', () => {
    const lines = [
      'Sachverhalt:',
      'Beschreibungstext.',
      'Mehrjahres-Trend (Gesamtzahl pro Jahr):',
      '  Jahr | Getötete | Schwerverletzte | Leichtverletzte | Summe',
      '  2019 | 0 | 2 | 36 | 38'
    ];
    const out = extractSection(lines, 'Sachverhalt:');
    expect(out).toEqual(['Beschreibungstext.']);
    // Critical: no pipe-table line leaks through.
    for (const l of out) {
      expect(l).not.toMatch(/Jahr\s*\|\s*Getötete\s*\|/);
      expect(l).not.toMatch(/^\s*\d{4}\s*\|\s*\d+\s*\|/);
    }
  });

  test.each([
    'URSACHEN UND MASSNAHMEN (kurz):',
    'Bewertung / Interpretation (heuristisch):',
    'Methodik (Kurzbeschreibung):',
    'Stunden-Heatmap (Werktag vs. Wochenende):',
    'Verkehrsräumlicher Kontext (OSM):',
    'Volkswirtschaftliche Bedeutung (Schätzung):',
    'Empfohlene Maßnahmen (automatischer Vorschlag, basierend auf detektierten Mustern):',
    'POI-Analyse',
    'Bezugsdokumente:',
    'Beschlussvorschlag:'
  ])('truncates SACHVERHALT at "%s"', (header) => {
    const lines = [
      'Sachverhalt:',
      'Beschreibungstext.',
      header,
      'Folgezeile, die nicht im SACHVERHALT auftauchen darf.'
    ];
    const out = extractSection(lines, 'Sachverhalt:');
    expect(out).toEqual(['Beschreibungstext.']);
  });

  test('respects an explicit per-call stop list and ignores defaults', () => {
    const lines = [
      'Sachverhalt:',
      'A',
      'Mehrjahres-Trend (Gesamtzahl pro Jahr):',
      'B',
      'Beschlussvorschlag:',
      'C'
    ];
    // Caller passes an explicit stop list that does NOT include
    // Mehrjahres-Trend; we expect B to be included (stops at
    // Beschlussvorschlag) — this proves the per-call override is honoured.
    const out = extractSection(lines, 'Sachverhalt:', ['Beschlussvorschlag:']);
    expect(out).toEqual(['A', 'Mehrjahres-Trend (Gesamtzahl pro Jahr):', 'B']);
  });
});
