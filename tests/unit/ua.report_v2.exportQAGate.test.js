/**
 * QA-PR „Export-Semantik vor Layout" — Pre-flight QA-Gate.
 *
 * UA.runExportQAGate(content) prüft den pdfMake-content-Baum auf
 * verbotene Tokens:
 *   - Beteiligten-Emojis (🚲/🚗/🚶/🚌/🏍/🚛)
 *   - FontAwesome / Private-Use-Codepoints
 *   - „Fetch is aborted", „Beteiligungsmaske", isoliertes „Scope"
 *   - „undefined" / „null" als Zellinhalt
 *   - „+ :"-Muster (Beteiligungs-Kombi ohne Textlabel)
 *
 * Wenn der Gate auslöst, bricht UA.exportToPDF mit einer lesbaren
 * Fehlermeldung ab — der QA-Reviewer bekommt also nie ein Dokument mit
 * Symbolen oder Entwicklerjargon zu sehen.
 */

const fs = require('fs');
const path = require('path');

describe('UA.runExportQAGate', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {}, location: { href: 'http://localhost/' } };
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function (window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);
    const reportPath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    (function (window) { eval(fs.readFileSync(reportPath, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  test('exposes runExportQAGate as a function', () => {
    expect(typeof UA.runExportQAGate).toBe('function');
  });

  test('passes for clean verwaltungstauglichen content', () => {
    const content = [
      { text: 'BEZIRKSRATSANTRAG', style: 'header' },
      { text: 'ANTRAG / BESCHLUSSVORSCHLAG' },
      {
        table: {
          body: [
            [{ text: 'Kombination' }, { text: 'Anzahl' }],
            [{ text: 'Radverkehr + PKW' }, { text: '15' }],
            [{ text: 'Sonstige Beteiligte' }, { text: '3' }]
          ]
        }
      }
    ];
    expect(UA.runExportQAGate(content)).toEqual({ ok: true });
  });

  test('catches involvement emojis', () => {
    const content = [{ text: '🚲+🚗' }];
    const r = UA.runExportQAGate(content);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'glyph')).toBe(true);
  });

  test('catches Private-Use-Area glyphs (FontAwesome o. ä.)', () => {
    const content = [{ text: 'Wert: \uF000 OK' }];
    const r = UA.runExportQAGate(content);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'glyph')).toBe(true);
  });

  test('catches "Fetch is aborted" technical error message', () => {
    const content = [{ text: 'Nicht verfügbar (Fetch is aborted)' }];
    const r = UA.runExportQAGate(content);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => /Fetch is aborted/.test(v.reason))).toBe(true);
  });

  test('catches "Beteiligungsmaske" / "Aktiver Filter-Scope" / "Vergleichs-Baseline" / "Muster-Analyse"', () => {
    const samples = [
      'Beteiligungsmaske > 0',
      'Aktiver Filter-Scope: foo',
      'Vergleichs-Baseline: bar',
      'Muster-Analyse: baz'
    ];
    for (const s of samples) {
      const r = UA.runExportQAGate([{ text: s }]);
      expect(r.ok).toBe(false);
    }
  });

  test('catches isolated "Scope" word but tolerates compound German terms', () => {
    expect(UA.runExportQAGate([{ text: 'Scope der Auswertung' }]).ok).toBe(false);
    // German compounds wie "Auswertungsbereich" sind erlaubt — kein "Scope"-Token.
    expect(UA.runExportQAGate([{ text: 'Auswertungsbereich' }]).ok).toBe(true);
  });

  test('catches "undefined" / "null" placeholder cells but not embedded text', () => {
    expect(UA.runExportQAGate([{ text: 'undefined' }]).ok).toBe(false);
    expect(UA.runExportQAGate([{ text: 'null' }]).ok).toBe(false);
    // Embedded substring (not a standalone cell) is tolerated.
    expect(UA.runExportQAGate([{ text: 'Wert ist nicht null gesetzt' }]).ok).toBe(true);
  });

  test('catches "+ :" pattern (cross-table without text labels)', () => {
    const content = [{ text: '+ : 4' }];
    const r = UA.runExportQAGate(content);
    expect(r.ok).toBe(false);
    expect(r.violations.some(v => v.kind === 'symbolOnly')).toBe(true);
  });

  test('walks deep into table.body / stack / columns nodes', () => {
    const content = {
      stack: [
        { columns: [
          { text: 'OK' },
          { text: '🚲' }
        ] }
      ]
    };
    const r = UA.runExportQAGate(content);
    expect(r.ok).toBe(false);
  });
});

describe('UA.exportToPDF QA-Gate Integration', () => {
  let UA;

  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;
    window.UA = {};
    window.docx = require('docx');
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.report_v2.js'), 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  function makeFixtureCtx() {
    return {
      CITY_RAW: 'Hannover',
      map: { getCenter: () => ({ lat: 52.37, lng: 9.73 }), getZoom: () => 14 }
    };
  }

  test('passes a clean fixture (no forbidden tokens) and produces a PDF', async () => {
    const reportData = {
      text: 'Sachverhalt:\nClean text only.\n\nBeschlussvorschlag:\nVerwaltung prüfen.',
      structured: {
        meta: { city: 'Hannover', date: '01.01.2026' },
        severity: { total: 5, bySev: { '2': 5 } }
      }
    };
    let downloaded = false;
    const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      const doc = realCreatePdf(def);
      doc.download = jest.fn(() => { downloaded = true; });
      return doc;
    });
    await UA.exportToPDF(makeFixtureCtx(), reportData, { includeMap: false });
    expect(downloaded).toBe(true);
  });

  test('aborts the export with a readable error when forbidden glyphs leak in', async () => {
    // Construct a reportData payload that puts an emoji into a sichtbaren
    // Anlagen-style cell via accidentDetails.rows[0].involved (the renderer
    // routes this through proseLabelForExport, but if the helper is bypassed
    // the gate still fires). We bypass the helper by stubbing it to return
    // the raw input, simulating a regression.
    const origProse = UA.proseLabelForExport;
    UA.proseLabelForExport = (s) => String(s == null ? '' : s);
    try {
      const reportData = {
        text: '',
        structured: {
          meta: { city: 'Hannover', date: '01.01.2026' },
          severity: { total: 1, bySev: { '2': 1 } },
          accidentDetails: {
            rows: [
              { lat: 52.38, lon: 9.73, year: 2023, severity: '2', sevLabel: 'Schwer', involved: '🚲+🚗', hour: 8, weekday: 'Mo', roadCondition: 'trocken', mask: 5 }
            ],
            total: 1,
            truncated: false
          }
        }
      };
      let err;
      try {
        await UA.exportToPDF(makeFixtureCtx(), reportData, { includeMap: false });
      } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect(err.message).toMatch(/Export abgebrochen/);
      expect(Array.isArray(err.qaViolations)).toBe(true);
      expect(err.qaViolations.some(v => v.kind === 'glyph')).toBe(true);
    } finally {
      UA.proseLabelForExport = origProse;
    }
  });

  test('options._skipQAGate=true allows tests to bypass the gate', async () => {
    const origProse = UA.proseLabelForExport;
    UA.proseLabelForExport = (s) => String(s == null ? '' : s);
    try {
      const reportData = {
        text: '',
        structured: {
          meta: { city: 'Hannover', date: '01.01.2026' },
          severity: { total: 1, bySev: { '2': 1 } },
          accidentDetails: {
            rows: [
              { lat: 52.38, lon: 9.73, year: 2023, severity: '2', sevLabel: 'Schwer', involved: '🚲+🚗', hour: 8, weekday: 'Mo', roadCondition: 'trocken', mask: 5 }
            ],
            total: 1,
            truncated: false
          }
        }
      };
      const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
      jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
        const doc = realCreatePdf(def);
        doc.download = jest.fn();
        return doc;
      });
      // No throw expected with _skipQAGate.
      await UA.exportToPDF(makeFixtureCtx(), reportData, { includeMap: false, _skipQAGate: true });
    } finally {
      UA.proseLabelForExport = origProse;
    }
  });
});
