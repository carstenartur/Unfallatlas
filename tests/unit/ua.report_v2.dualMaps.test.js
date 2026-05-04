/**
 * Doppelte Karten + Caption-Transparenz (Antrags-PR).
 *
 * Akzeptanzkriterien:
 *   - Bei aktiver Beteiligungs-Restriktion (1..5 von 6 Kategorien
 *     ausgewählt) rendert der PDF-Export eine zusätzliche
 *     "Übersichtskarte – alle Beteiligungs-Kombinationen" VOR der
 *     existierenden Hauptkarte.
 *   - Die Hauptkarte wird in diesem Fall als "Auswahl-Karte – Unfälle
 *     mit Beteiligung ‹X›" beschriftet.
 *   - Direkt unter der Auswahl-Karte erscheint der Hinweissatz
 *     "Nur Unfälle mit Beteiligung ‹X› dargestellt.".
 *   - Detail-/Cluster-Captions referenzieren weiterhin die Auswahl-Karte
 *     ("Teilmenge der M Unfälle aus Abbildung 2."), nicht die alle-
 *     Kombinationen-Übersicht.
 *   - Ohne Restriktion (alle sechs Kategorien aktiv) bleibt das
 *     bestehende Verhalten erhalten (eine einzige Übersichtskarte,
 *     "Abbildung 1").
 */

const fs = require('fs');
const path = require('path');

describe('UA.report_v2 – Doppelte Karten + Caption-Transparenz', () => {
  let UA;

  beforeEach(() => {
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;

    window.UA = {};
    window.docx = require('docx');
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();
    window.leafletImage = () => {};

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

  // ----- Helper-Tests ----------------------------------------------------

  describe('UA._activeInvolvementSelection', () => {
    test('returns hasRestriction=false when no codes are set', () => {
      const sel = UA._activeInvolvementSelection({});
      expect(sel.codes).toEqual([]);
      expect(sel.hasRestriction).toBe(false);
      expect(sel.prose).toBe('');
    });

    test('returns hasRestriction=false when all six categories are active', () => {
      const sel = UA._activeInvolvementSelection({
        includeCyclist: true, includePedestrian: true, includeCar: true,
        includeMotorcycle: true, includeGkfz: true, includeSonstig: true
      });
      expect(sel.codes.length).toBe(6);
      expect(sel.hasRestriction).toBe(false);
    });

    test('returns hasRestriction=true with prose label for a strict subset', () => {
      const sel = UA._activeInvolvementSelection({
        includeCyclist: true, includeCar: true
      });
      expect(sel.codes).toEqual(['Rad', 'PKW']);
      expect(sel.hasRestriction).toBe(true);
      // Prose may either be the formatter output or the simple join — both
      // must mention both categories.
      expect(sel.prose).toMatch(/Rad/);
      expect(sel.prose).toMatch(/PKW/);
    });
  });

  describe('UA._selectionHintSentence', () => {
    test('produces the mandated "Nur Unfälle …" wording with guillemets', () => {
      expect(UA._selectionHintSentence('Rad + PKW'))
        .toBe('Nur Unfälle mit Beteiligung \u2039Rad + PKW\u203A dargestellt.');
    });
  });

  describe('UA._getAllCombinationPointsInBounds', () => {
    test('returns points filtered by bounds + non-involvement filters, ignoring the involvement filter', () => {
      const ctx = {
        allPts: [
          { lat: 52.37, lon: 9.73, props: { ukategorie: '3', strzustand: '0', uwochentag: '3', ustunde: '12', istrad: '1' } },
          { lat: 52.37, lon: 9.73, props: { ukategorie: '3', strzustand: '0', uwochentag: '3', ustunde: '12', istpkw: '1' } },
          // outside bounds
          { lat: 60.00, lon: 9.73, props: { ukategorie: '3', strzustand: '0', uwochentag: '3', ustunde: '12', istrad: '1' } },
          // mask = 0 (no involvement at all) → must be skipped
          { lat: 52.37, lon: 9.73, props: { ukategorie: '3', strzustand: '0', uwochentag: '3', ustunde: '12' } },
        ],
        // matchesNonInvolvementFilters/maskFromProps are real (loaded below).
        ui: {
          severityEl: { value: 'all' },
          roadConditionEl: { value: 'all' },
          dayTypeEl: { value: 'all' },
          hFromEl: { value: '0' },
          hToEl: { value: '23' },
          // Involvement UI restricted to bicycle only — must NOT influence
          // the all-combinations point set.
          incBikeEl: { checked: true },
          incPedEl: { checked: false },
          incCarEl: { checked: false },
          incMotoEl: { checked: false }
        },
        selectionBounds: {
          getSouthWest: () => ({ lat: 52.36, lng: 9.72 }),
          getNorthEast: () => ({ lat: 52.38, lng: 9.74 })
        }
      };
      // Load the filters module so matchesNonInvolvementFilters / maskFromProps exist.
      eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.filters.js'), 'utf8'));
      const pts = UA._getAllCombinationPointsInBounds(ctx);
      // Two valid in-bounds points: bicycle + car; mask=0 and out-of-bounds dropped.
      expect(pts.length).toBe(2);
    });
  });

  // ----- PDF integration -------------------------------------------------

  const PNG_DATAURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';

  function collectTexts(node, out) {
    out = out || [];
    if (node == null) return out;
    if (Array.isArray(node)) { for (const i of node) collectTexts(i, out); return out; }
    if (typeof node === 'string') { out.push(node); return out; }
    if (typeof node !== 'object') return out;
    if (typeof node.text === 'string') out.push(node.text);
    else if (Array.isArray(node.text)) collectTexts(node.text, out);
    if (Array.isArray(node.stack))   collectTexts(node.stack, out);
    if (Array.isArray(node.columns)) collectTexts(node.columns, out);
    if (node.table && Array.isArray(node.table.body)) {
      for (const row of node.table.body) for (const cell of row) collectTexts(cell, out);
    }
    return out;
  }

  async function runPdfExport(ctx, reportData, options) {
    let capturedDef;
    const realCreatePdf = window.pdfMake.createPdf.bind(window.pdfMake);
    jest.spyOn(window.pdfMake, 'createPdf').mockImplementation((def) => {
      capturedDef = def;
      const doc = realCreatePdf(def);
      doc.download = jest.fn();
      return doc;
    });
    await UA.exportToPDF(ctx, reportData, options || {});
    return capturedDef;
  }

  function makeCtx(extra) {
    return Object.assign({
      CITY_RAW: 'Hannover',
      map: {
        getCenter: () => ({ lat: 52.37, lng: 9.73 }),
        getZoom: () => 14,
        setView: () => {}
      }
    }, extra || {});
  }

  function reportDataWithFilters(filters) {
    return {
      text: 'Stadt: Hannover\n\n',
      structured: {
        meta: { gremium: { typ: 'BV' }, filters: filters || {} },
        totalAccidents: 262,
        accidentDetails: { total: 262 },
        severity: { total: 262, bySev: { "1": 2, "2": 30, "3": 230 } }
      }
    };
  }

  test('PDF export with active involvement restriction renders dual maps + selection hint', async () => {
    UA.captureExportMapImage = jest.fn(async () => PNG_DATAURL);
    UA._captureDetailMap = jest.fn(async () => PNG_DATAURL);
    UA._captureClusterMaps = jest.fn(async () => []);
    UA._getAllCombinationPointsInBounds = jest.fn(() => new Array(500));

    const sw = { lat: 52.36, lng: 9.72 };
    const ne = { lat: 52.38, lng: 9.74 };
    const selectionBounds = {
      getSouth: () => sw.lat, getWest: () => sw.lng,
      getNorth: () => ne.lat, getEast: () => ne.lng,
      getSouthWest: () => sw, getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.37, lng: 9.73 }),
      contains: () => true
    };
    const ctx = makeCtx({
      selectionBounds,
      viewportPts: Array.from({ length: 32 }, (_, i) => ({
        lat: 52.37 + i * 0.00001, lon: 9.73 + i * 0.00001
      }))
    });

    const def = await runPdfExport(ctx,
      reportDataWithFilters({ includeCyclist: true, includeCar: true }),
      { includeMap: true });
    const texts = collectTexts(def.content).map(String);

    // 1) Übersichtskarte (alle Beteiligungs-Kombinationen) als Abbildung 1.
    const allCombCaption = texts.find(
      t => /^Abbildung 1: Übersichtskarte – alle Beteiligungs-Kombinationen/.test(t));
    expect(allCombCaption).toBeDefined();

    // 2) Auswahl-Karte als Abbildung 2 mit Prosa-Label im Caption.
    const selCaption = texts.find(
      t => /^Abbildung 2: Auswahl-Karte – Unfälle mit Beteiligung \u2039.*Rad.*PKW.*\u203A/.test(t));
    expect(selCaption).toBeDefined();

    // 3) Hinweissatz "Nur Unfälle mit Beteiligung ‹…› dargestellt." erscheint
    //    nach der Auswahl-Karte.
    const hintIdx = texts.findIndex(
      t => /^Nur Unfälle mit Beteiligung \u2039.*\u203A dargestellt\.$/.test(t));
    expect(hintIdx).toBeGreaterThan(-1);
    const selCaptionIdx = texts.findIndex(
      t => /^Abbildung 2: Auswahl-Karte/.test(t));
    expect(hintIdx).toBeGreaterThan(selCaptionIdx);

    // 4) all-combinations overview MUST be invoked with exportPoints override
    //    so the rendered overlay covers the unrestricted set.
    const callsWithExportPoints = UA.captureExportMapImage.mock.calls.filter(
      args => args[1] && Array.isArray(args[1].exportPoints));
    expect(callsWithExportPoints.length).toBeGreaterThanOrEqual(1);

    // 5) Detail-Caption verweist auf die Auswahl-Karte (Abbildung 2), nicht
    //    auf die alle-Kombinationen-Übersicht.
    const detailCaption = texts.find(
      t => /^Abbildung 3: Detailausschnitt/.test(t));
    expect(detailCaption).toBeDefined();
    expect(detailCaption).toMatch(/Teilmenge der 262 Unfälle aus Abbildung 2\.$/);
  });

  test('PDF export without involvement restriction keeps single overview map ("Abbildung 1") and no selection hint', async () => {
    UA.captureExportMapImage = jest.fn(async () => PNG_DATAURL);
    UA._captureClusterMaps = jest.fn(async () => []);

    const ctx = makeCtx();
    // All six categories selected → no restriction.
    const def = await runPdfExport(ctx,
      reportDataWithFilters({
        includeCyclist: true, includePedestrian: true, includeCar: true,
        includeMotorcycle: true, includeGkfz: true, includeSonstig: true
      }),
      { includeMap: true });
    const texts = collectTexts(def.content).map(String);

    // Übersichtskarte stays the first map and uses the legacy caption.
    expect(texts.some(
      t => /^Abbildung 1: Übersichtskarte – gefilterte Unfälle/.test(t))).toBe(true);
    // No "alle Beteiligungs-Kombinationen" extra map.
    expect(texts.some(
      t => /alle Beteiligungs-Kombinationen/.test(t))).toBe(false);
    // No selection hint sentence.
    expect(texts.some(
      t => /^Nur Unfälle mit Beteiligung \u2039/.test(t))).toBe(false);
  });
});
