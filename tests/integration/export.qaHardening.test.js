/**
 * QA-Härtungs-Regressionstest für den Word/PDF-Export.
 *
 * Diese Tests gehen den vollständigen Export-Pfad (UA.exportToWord) gegen
 * eine Antrag-ähnliche Fixture durch und stellen sicher, dass das
 * erzeugte DOCX:
 *
 *   1. Tatsächlich an `saveAs` übergeben wird (also gebaut werden konnte)
 *   2. Eine plausible Größe hat (nicht 0 Byte / nicht „leeres ZIP")
 *   3. Im sichtbaren Text *keine* der bekannten QA-Platzhalter mehr trägt
 *      (z. B. „Quelle: -", „Build: -" — diese kamen aus dem UI-Footer
 *      und durften nie im Antrag erscheinen)
 *   4. Keine rohen Debug-Begriffe wie wörtliches "[Rad]" / "[PKW]" /
 *      "Schweregrad: all" / "Wochentag: all" als sichtbarer Text
 *      enthält — das war ein Stopper im PR-QA-Review.
 *
 * Wir verwenden — wie die anderen Integration-Tests — die echten
 * Export-Bibliotheken und packen das produzierte DOCX-Blob mit JSZip aus,
 * um sichtbaren <w:t>-Text gezielt zu inspizieren.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

describe('QA-Härtung – Word-Export Regressionstest', () => {
  let UA;

  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;

    Object.assign(window, {
      UA: {},
      docx: require('docx'),
      pdfMake: pdfMakeLib,
      saveAs: jest.fn(),
      // leafletImage stub — winziges valides PNG, damit der Map-Pfad
      // durchläuft, aber wir keine echte Karte brauchen.
      leafletImage: (map, cb) => setTimeout(() => cb(null, {
        toDataURL: () =>
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
      }), 5)
    });

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

  /** Ruft exportToWord auf und liefert das produzierte ZIP zurück. */
  async function exportAndUnzip(options = {}) {
    const ctx = {
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
      }
    };

    const reportData = {
      text:
        'Sachverhalt:\nDeisterstraße/Lindener Marktplatz — Bezirksratsantrag.\n\n' +
        'Beschlussvorschlag:\nDer Bezirksrat bittet die Verwaltung um Prüfung der Verkehrssituation.',
      structured: {
        meta: {
          city: 'Hannover',
          areaName: 'Deisterstraße',
          date: '01.01.2026',
          gremium: { typ: 'Bezirksrat', gremium: 'Bezirksrat Linden-Limmer' }
        },
        severity: { total: 12, bySev: { '1': 0, '2': 3, '3': 9 } },
        accidentDetails: { total: 12, rows: [], groups: [] }
      }
    };

    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:mock');
    URL.revokeObjectURL = jest.fn();
    try {
      await UA.exportToWord(ctx, reportData, { includeMap: true, ...options });
      expect(window.saveAs).toHaveBeenCalled();
      const blob = window.saveAs.mock.calls[0][0];
      expect(blob.size).toBeGreaterThan(2000); // plausibel für ein DOCX mit Karte
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

  /** Sammelt allen sichtbaren Text aus <w:t>-Runs der document.xml. */
  async function collectVisibleText(zip) {
    const xml = await zip.file('word/document.xml').async('string');
    return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)]
      .map((m) => m[1])
      .join('\n');
  }

  test('erzeugt ein nicht-leeres DOCX und ruft saveAs', async () => {
    const zip = await exportAndUnzip();
    expect(Object.keys(zip.files).length).toBeGreaterThan(5);
    const visible = await collectVisibleText(zip);
    expect(visible.length).toBeGreaterThan(50);
  });

  test('Antrag enthält keine UI-Footer-Platzhalter („Quelle: -", „Build: -")', async () => {
    const zip = await exportAndUnzip();
    const visible = await collectVisibleText(zip);
    // Diese Strings stammen aus dem Panel-Footer und dürfen niemals in
    // den Antrag rutschen.
    expect(visible).not.toMatch(/Quelle:\s*-/);
    expect(visible).not.toMatch(/Build:\s*-/);
    // Auch der nackte Lade-Platzhalter darf nicht im Antrag stehen.
    expect(visible).not.toMatch(/Lade Daten…/);
    expect(visible).not.toMatch(/Städte werden geladen/);
  });

  test('Antrag enthält keine rohen Debug-/Filter-Tokens als sichtbarer Text', async () => {
    const zip = await exportAndUnzip();
    const visible = await collectVisibleText(zip);

    // Wörtliche Bracket-Tokens („[Rad]", „[PKW]", …) waren ein
    // Hauptkritikpunkt im PR-QA-Review.
    expect(visible).not.toMatch(/\[Rad\]/);
    expect(visible).not.toMatch(/\[PKW\]/);
    expect(visible).not.toMatch(/\[Fuß\]/);

    // Filterzeilen wie „Schweregrad: all" / „Wochentag: all" gehören
    // übersetzt — entweder in lesbare Worte oder gar nicht aufgeführt.
    // Wir verbieten das *exakte* rohe „: all"-Muster im Klartext.
    expect(visible).not.toMatch(/Schweregrad:\s*all\b/i);
    expect(visible).not.toMatch(/Wochentag:\s*all\b/i);
  });
});
