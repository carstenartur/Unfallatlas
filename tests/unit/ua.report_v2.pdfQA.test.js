/**
 * Layout-PR „PDF-/DOCX-QA": Akzeptanztest für den PDF-Export.
 *
 * Ziel des begleitenden PRs ist, dass der PDF-Output ohne HTML-Vergleich
 * als einreichungsreifes Verwaltungsdokument lesbar ist. Dieser Test
 * gated diese Anforderung von zwei Seiten:
 *
 *   (A) Semantische Struktur über das pdfMake-`docDefinition.content`-
 *       Modell — alle Pflicht-Sektionen (Titel, Antrag, Begründung,
 *       Sachverhalt/Unfalllage, Maßnahmen, Anlagen) sind als sichtbare
 *       Heading-Texte vorhanden, der Anlagen-Abschnitt erzwingt einen
 *       Seitenumbruch, und Sektionen tauchen genau einmal auf (kein
 *       doppelter Beschlussvorschlag).
 *
 *   (B) Sanity-Check des erzeugten PDF-Streams — die Bytes beginnen mit
 *       `%PDF`, sind > 1 KB groß und enthalten keine rohen Debug-Werte
 *       wie ein einzelnes „all", „Build: -" oder „Quelle: -" als
 *       sichtbarer Zellinhalt.
 *
 * Wir parsen bewusst nicht binär per pdfjs-dist — pdfjs-dist v5 liefert
 * nur ESM-Builds, die in Jest+CJS schwer einzubinden sind, und das
 * `docDefinition`-Modell ist die einzige Quelle, aus der pdfMake den
 * sichtbaren Text rendert. Eine Lücke zwischen Modell und Rendering
 * gäbe es nur bei einem pdfMake-Bug — der hier nicht relevant ist.
 */

const fs = require('fs');
const path = require('path');

describe('UA.report_v2 – PDF-Export semantische QA', () => {
  let UA;

  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;

    window.UA = {};
    window.docx = require('docx');
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();
    // leafletImage nicht benötigt: alle Tests laufen mit includeMap:false.

    const filePath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    eval(fs.readFileSync(filePath, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    jest.restoreAllMocks();
  });

  /**
   * Run exportToPDF with the real pdfMake pipeline (no `download` side
   * effect), capture both the in-memory `docDefinition` and the produced
   * PDF buffer.
   */
  async function runPdfExport(ctx, reportData, options) {
    let capturedDef;
    let capturedDoc;
    const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      capturedDef = def;
      capturedDoc = realCreatePdf(def);
      capturedDoc.download = jest.fn(); // intercept browser download
      return capturedDoc;
    });

    await UA.exportToPDF(ctx, reportData, options || {});

    const buffer = await new Promise((resolve, reject) => {
      try { capturedDoc.getBuffer((b) => resolve(b)); }
      catch (e) { reject(e); }
    });
    return { definition: capturedDef, buffer };
  }

  /**
   * Recursively walk a pdfMake `content` tree and collect every visible
   * text fragment as a flat array of strings. Handles plain `text`,
   * `text` arrays of inline runs, table bodies, columns, and stack
   * containers — i. e. all node shapes the report renderer emits.
   */
  function collectTexts(node, out) {
    out = out || [];
    if (node == null) return out;
    if (Array.isArray(node)) {
      for (const item of node) collectTexts(item, out);
      return out;
    }
    if (typeof node === 'string') { out.push(node); return out; }
    if (typeof node !== 'object') return out;

    if (typeof node.text === 'string') out.push(node.text);
    else if (Array.isArray(node.text)) collectTexts(node.text, out);

    if (Array.isArray(node.stack))    collectTexts(node.stack, out);
    if (Array.isArray(node.columns))  collectTexts(node.columns, out);
    if (node.table && Array.isArray(node.table.body)) {
      for (const row of node.table.body) {
        for (const cell of row) collectTexts(cell, out);
      }
    }
    return out;
  }

  function makeFixtureCtx() {
    return {
      CITY_RAW: 'Hannover',
      map: {
        getCenter: () => ({ lat: 52.3759, lng: 9.7320 }),
        getZoom: () => 14
      }
    };
  }

  function makeFixtureReportData() {
    return {
      text: [
        'Sachverhalt:',
        'Im markierten Bereich der Deisterstraße häufen sich Unfälle mit Radfahrenden.',
        '',
        'Beschlussvorschlag:',
        'Der Bezirksrat fordert die Verwaltung auf, die Verkehrssicherheit im markierten Bereich kurzfristig zu verbessern.'
      ].join('\n'),
      structured: {
        meta: {
          city: 'Hannover',
          areaName: 'Deisterstraße',
          date: '01.01.2026',
          link: 'https://example.test/werkbank?city=hannover&area=Deisterstrasse',
          filters: {
            severity: 'all',
            dayType: 'all',
            includeCyclist: true,
            includeCar: true,
            hourFrom: 0,
            hourTo: 24
          },
          gremium: { typ: 'Bezirksrat', gremium: 'Bezirksrat Linden-Limmer' }
        },
        severity: { total: 12, bySev: { '1': 0, '2': 3, '3': 9 } },
        accidentDetails: { total: 12, rows: [], groups: [] },
        executiveSummary: {
          classification: 'Auffälliger Unfallschwerpunkt',
          bullets: [
            '12 polizeilich erfasste Unfälle im markierten Bereich.',
            'Schwerpunkt bei schwer verletzten Radfahrenden.'
          ],
          urgency: 'Kurzfristige Maßnahmen geboten.'
        },
        mapReferences: [
          'Die dargestellten Punkte entsprechen exakt den in der Tabelle aufgeführten Unfällen (n = 12).'
        ]
      }
    };
  }

  test('docDefinition enthält alle Pflicht-Sektionen in lesbarer Form', async () => {
    const { definition } = await runPdfExport(makeFixtureCtx(), makeFixtureReportData(), { includeMap: false });
    expect(definition).toBeDefined();
    const allTexts = collectTexts(definition.content);
    const joined = allTexts.join(' | ');

    // (1) Titel
    expect(joined).toContain('BEZIRKSRATSANTRAG');
    // (2) Antrag/Beschlussvorschlag (oben am Dokument)
    expect(joined).toContain('ANTRAG / BESCHLUSSVORSCHLAG');
    // (3) Begründung als Sammelüberschrift
    expect(joined).toContain('BEGRÜNDUNG');
    // (4) Unfalllage / Sachverhalt
    expect(joined).toMatch(/SACHVERHALT|UNFALLLAGE/);
    // (5) Maßnahmen-Block
    expect(joined).toMatch(/MASSNAHMEN|MAßNAHMEN|MASSNAHMENVORSCHL/i);
    // (6) Anlagen
    expect(joined).toContain('ANLAGEN');

    // (7) keine doppelte Antragssektion: BESCHLUSSVORSCHLAG-Heading
    // erscheint genau einmal — entweder am Anfang als ANTRAG /
    // BESCHLUSSVORSCHLAG oder am Ende, aber nicht beides.
    const headingHits = allTexts.filter(t =>
      t === 'BESCHLUSSVORSCHLAG' || t === 'ANTRAG / BESCHLUSSVORSCHLAG'
    );
    expect(headingHits).toHaveLength(1);
  });

  test('ANLAGEN-Heading erzwingt Seitenumbruch (pageBreak vor Anlagen)', async () => {
    const { definition } = await runPdfExport(makeFixtureCtx(), makeFixtureReportData(), { includeMap: false });
    const anlagenIdx = definition.content.findIndex(n =>
      n && typeof n.text === 'string' && n.text === 'ANLAGEN'
    );
    expect(anlagenIdx).toBeGreaterThan(-1);
    expect(definition.content[anlagenIdx].pageBreak).toBe('before');
  });

  test('keine rohen Debug-Werte als sichtbare Inhalte ("all", "Build: -", "Quelle: -")', async () => {
    const { definition } = await runPdfExport(makeFixtureCtx(), makeFixtureReportData(), { includeMap: false });
    const allTexts = collectTexts(definition.content).map(t => String(t).trim());

    // „all" als isolierter Zellinhalt deutet auf einen rohen Filterwert
    // (Severity, Wochentag) hin, der nicht durch UA.formatFilterValue
    // geschickt wurde. Zelleninhalte wie „all" sind das erste Symptom
    // eines unformatierten Rohdaten-Exports.
    expect(allTexts.filter(t => t === 'all')).toHaveLength(0);
    // Klassische Debug-Defaults aus der Renderer-Pipeline:
    expect(allTexts.filter(t => /^Build:\s*-$/.test(t))).toHaveLength(0);
    expect(allTexts.filter(t => /^Quelle:\s*-$/.test(t))).toHaveLength(0);
    // Generischer Schutz vor „undefined"-Lecks im sichtbaren Output.
    expect(allTexts.filter(t => t === 'undefined' || t === 'null')).toHaveLength(0);
  });

  test('erzeugtes PDF beginnt mit %PDF-Magic und ist > 1 KB groß', async () => {
    const { buffer } = await runPdfExport(makeFixtureCtx(), makeFixtureReportData(), { includeMap: false });
    expect(buffer).toBeDefined();
    expect(buffer.length).toBeGreaterThan(1024);
    expect(String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3])).toBe('%PDF');
  });
});
