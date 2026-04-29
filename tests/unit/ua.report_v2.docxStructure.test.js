/**
 * QA-Gate für DOCX-Export (PR-QA „Dokumenthygiene").
 *
 * Statt nur zu prüfen, dass der Packer ein nicht-leeres Blob liefert,
 * öffnet dieser Test das tatsächlich erzeugte DOCX-ZIP und validiert
 * die OOXML-Struktur gegen die professionellen QA-Befunde, die zum
 * Stopper für PDF-/Word-/LibreOffice-Rendering geführt hatten:
 *
 *   1. Keine Dateien mit Endung `.undefined` im DOCX (leeres `type`-Feld
 *      bei `ImageRun` führte zu `word/media/...undefined`, was den
 *      LibreOffice-Headless-Export hängen ließ).
 *   2. Alle `word/media/*` referenzieren auf eine erlaubte Bildendung
 *      (.png, .jpg, .jpeg, .gif, .bmp, .svg, .emf, .wmf — alle in OOXML
 *      gültigen Raster-/Vektor-Formate).
 *   3. Alle `<wp:docPr>`-Elemente haben eindeutige `id`-Attribute.
 *   4. Alle `<wp:docPr>`-Elemente haben einen nicht-leeren Alt-Text
 *      (`descr` oder `title`).
 *   5. Alle Bild-Relationships (`r:id` → `Target`) zeigen auf eine
 *      tatsächlich im ZIP existierende Mediendatei.
 *   6. Sichtbarer Text in Tabellenzellen enthält keinen rohen URL > 80
 *      Zeichen — lange URLs gehören als Hyperlink hinter einem kurzen
 *      Linktext, nicht roh in eine Zelle.
 *   7. `[Content_Types].xml` listet alle Bildendungen, die in der
 *      `word/media`-Sammlung tatsächlich vorkommen.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

describe('UA.report_v2 – DOCX structural QA gate', () => {
  let UA;

  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;

    window.UA = {};
    window.docx = require('docx');
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();
    // leafletImage stub returns a tiny valid PNG so the map paths run.
    window.leafletImage = (map, cb) => setTimeout(() => cb(null, {
      toDataURL: () =>
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    }), 5);

    const filePath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    eval(fs.readFileSync(filePath, 'utf8'));
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
    delete window.leafletImage;
    jest.restoreAllMocks();
  });

  /**
   * Run exportToWord and return the produced ZIP entries as a JSZip object.
   * Stubs URL.createObjectURL/revoke since jsdom doesn't implement them.
   */
  async function exportAndUnzip(ctx, reportData, options) {
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:mock');
    URL.revokeObjectURL = jest.fn();
    try {
      await UA.exportToWord(ctx, reportData, options);
      const blob = window.saveAs.mock.calls[0][0];
      const buf = await new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsArrayBuffer(blob);
      });
      return await JSZip.loadAsync(buf);
    } finally {
      if (origCreate === undefined) delete URL.createObjectURL; else URL.createObjectURL = origCreate;
      if (origRevoke === undefined) delete URL.revokeObjectURL; else URL.revokeObjectURL = origRevoke;
    }
  }

  function makeFixtureCtx() {
    // Fixture loosely modelled after the Hannover/Deisterstraße case
    // mentioned in the QA review — a Bezirksrat antrag with map images
    // and a long Werkbank-URL.
    return {
      CITY_RAW: 'Hannover',
      map: {
        getCenter: () => ({ lat: 52.3759, lng: 9.7320 }),
        getZoom: () => 16,
        eachLayer: () => {},
        fitBounds: jest.fn(),
        setView: jest.fn(),
        getBounds: () => ({
          getSouth: () => 52.37, getNorth: () => 52.38,
          getWest: () => 9.72, getEast: () => 9.74
        })
      },
      selectionBounds: {
        getSouth: () => 52.37, getNorth: () => 52.38,
        getWest: () => 9.72, getEast: () => 9.74
      }
    };
  }

  function makeFixtureReportData() {
    // A long URL that — without the fix — would land *raw* in a table
    // cell as the Werkbank-Link value (>80 chars, layout breaker).
    const longLink =
      'https://example.test/werkbank?city=hannover&area=Deisterstrasse&severity=all' +
      '&dayType=all&hourFrom=0&hourTo=24&includeCyclist=1&includePedestrian=1' +
      '&includeCar=1&showHeatmap=1&showCluster=1&showOnlyAboveAverage=0';
    expect(longLink.length).toBeGreaterThan(120);
    return {
      text: 'Sachverhalt:\nDeisterstraße — Antrag.',
      structured: {
        meta: {
          city: 'Hannover',
          areaName: 'Deisterstraße',
          date: '01.01.2026',
          link: longLink,
          filters: {
            severity: 'all',
            dayType: 'all',
            includeCyclist: true,
            includeCar: true
          },
          gremium: { typ: 'Bezirksrat', gremium: 'Bezirksrat Linden-Limmer' }
        },
        severity: { total: 12, bySev: { '1': 0, '2': 3, '3': 9 } },
        accidentDetails: { total: 12, rows: [], groups: [] }
      }
    };
  }

  /** Read entry as utf-8 text. */
  const readText = (zip, name) => zip.file(name).async('string');

  test('produced DOCX has none of the known QA blockers', async () => {
    const zip = await exportAndUnzip(makeFixtureCtx(), makeFixtureReportData(), { includeMap: true });

    const fileNames = Object.keys(zip.files).filter(n => !zip.files[n].dir);

    // (1) keine .undefined Mediendatei
    const undefinedFiles = fileNames.filter(n => /\.undefined$/i.test(n));
    expect(undefinedFiles).toEqual([]);

    // (2) jede Mediendatei hat eine erlaubte Bildendung
    const mediaFiles = fileNames.filter(n => /^word\/media\//.test(n));
    expect(mediaFiles.length).toBeGreaterThan(0); // includeMap:true → mind. 1 Bild
    const ALLOWED_EXT = /\.(png|jpe?g|gif|bmp|svg|emf|wmf)$/i;
    for (const m of mediaFiles) {
      expect(m).toMatch(ALLOWED_EXT);
    }

    // (3) eindeutige docPr ids
    const documentXml = await readText(zip, 'word/document.xml');
    const docPrIds = [...documentXml.matchAll(/<wp:docPr\b[^/]*\bid="([^"]+)"/g)].map(m => m[1]);
    expect(docPrIds.length).toBeGreaterThan(0);
    expect(new Set(docPrIds).size).toBe(docPrIds.length);

    // (4) jeder docPr hat einen nicht-leeren Alt-Text (descr ODER title)
    const docPrTags = [...documentXml.matchAll(/<wp:docPr\b[^/]*\/>/g)].map(m => m[0]);
    for (const tag of docPrTags) {
      const descr = (tag.match(/\bdescr="([^"]*)"/) || [, ''])[1];
      const title = (tag.match(/\btitle="([^"]*)"/) || [, ''])[1];
      expect((descr + title).trim().length).toBeGreaterThan(0);
    }

    // (5) Bild-Relationships zeigen auf existierende Targets
    const relsXml = await readText(zip, 'word/_rels/document.xml.rels');
    const imageRels = [...relsXml.matchAll(
      /<Relationship\b[^>]*Type="[^"]*\/image"[^>]*Target="([^"]+)"/g
    )].map(m => m[1]);
    for (const target of imageRels) {
      const resolved = target.startsWith('/')
        ? target.slice(1)
        : `word/${target.replace(/^(\.\.\/)/, '')}`;
      expect(fileNames).toContain(resolved);
      // Doppelt absichern: niemand smuggelt eine `.undefined`-Endung durch.
      expect(resolved).not.toMatch(/\.undefined$/i);
    }

    // (6) keine sichtbar gerenderten URLs > 80 Zeichen in Tabellenzellen
    // (lange Links müssen als Hyperlink hinter kurzem Text laufen).
    const cellTextRuns = [...documentXml.matchAll(
      /<w:tc\b[^]*?<\/w:tc>/g
    )];
    for (const tcMatch of cellTextRuns) {
      const tcXml = tcMatch[0];
      // alle <w:t>…</w:t> innerhalb dieser Zelle einsammeln
      const texts = [...tcXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]);
      for (const text of texts) {
        // URLs erkennen
        const urls = text.match(/https?:\/\/\S+/g) || [];
        for (const url of urls) {
          expect(url.length).toBeLessThanOrEqual(80);
        }
      }
    }

    // (7) Content Types enthält jede vorkommende Bildendung
    const contentTypesXml = await readText(zip, '[Content_Types].xml');
    const usedExts = new Set(mediaFiles.map(n => n.split('.').pop().toLowerCase()));
    for (const ext of usedExts) {
      // entweder als Default-Eintrag pro Erweiterung …
      const hasDefault = new RegExp(`<Default[^>]*Extension="${ext}"`, 'i').test(contentTypesXml);
      // … oder als Override für die konkrete Datei.
      const hasOverride = mediaFiles.some(m =>
        new RegExp(`<Override[^>]*PartName="/${m}"`, 'i').test(contentTypesXml)
      );
      expect(hasDefault || hasOverride).toBe(true);
    }
  });

  test('Werkbank-Link is rendered as short hyperlinked label, not as raw URL', async () => {
    const zip = await exportAndUnzip(makeFixtureCtx(), makeFixtureReportData(), { includeMap: false });
    const documentXml = await readText(zip, 'word/document.xml');
    // Sichtbarer Anker-Text muss der Kurztext sein.
    expect(documentXml).toContain('Werkbank-Link öffnen');
    // Der vollständige URL ist nur als Relationship-Target erlaubt, nicht
    // im sichtbaren Text-Run.
    const visibleTexts = [...documentXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]);
    const longRawUrl = visibleTexts.find(t => /https:\/\/example\.test\/werkbank\?/.test(t));
    expect(longRawUrl).toBeUndefined();
  });

  test('raw filter values like "all" are translated to readable labels', async () => {
    const zip = await exportAndUnzip(makeFixtureCtx(), makeFixtureReportData(), { includeMap: false });
    const documentXml = await readText(zip, 'word/document.xml');
    // Aktuelle Übersetzung: "all" → "Alle (keine Einschränkung)"
    expect(documentXml).toContain('Alle (keine Einschränkung)');
    // Es darf keine Filterzelle "all" als sichtbarer Wert mehr existieren.
    const visibleTexts = [...documentXml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map(t => t[1]);
    expect(visibleTexts.filter(t => t.trim() === 'all')).toHaveLength(0);
  });
});
