/**
 * Phase 1.2 (PDF-Layout-Härtung): the year-table builder must expose
 *
 *   - `classes`     emoji-form labels for HTML/PDF (where pdfInvolvementCell
 *                   substitutes SVG icons; the "+" stays as a separator
 *                   between SVGs and is intentional)
 *   - `textClasses` deterministic bracket-form labels ("[Rad]+[PKW]: 4")
 *                   so DOCX and plain-text consumers never end up with
 *                   bare "+", "=", "0" artefacts when the consumer's font
 *                   does not have an emoji glyph.
 *
 * Both arrays must use ": " as the count separator (not "="), per the QA
 * rules in the master plan ("+, =, 0 → [Rad], [Fuss], etc.").
 */

describe('UA.computeExportReport – yearTable encoding (Phase 1.2)', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const mockWindow = { UA: {}, location: { href: 'http://localhost/' } };
    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };
    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeCtx(points) {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: () => true
    };
    UA.reverseGeocode = async () => null;
    const ui = {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      dayTypeEl: { value: 'all' },
      incBikeEl: { checked: true },
      incPedEl: { checked: true },
      incCarEl: { checked: true },
      incMotoEl: { checked: true },
      incGkfzEl: { checked: true },
      incSonEl: { checked: true }
    };
    return {
      CITY_RAW: 'Hannover',
      allPts: points,
      selectionBounds: bounds,
      ui,
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
  }

  function pt(year, masks) {
    return {
      lat: 52.25, lon: 9.8,
      props: {
        year: String(year),
        ukategorie: '3',
        ustunde: '12',
        uwochentag: '3',
        strzustand: '0',
        IstRad:  masks.bike ? '1' : '0',
        IstFuss: masks.ped  ? '1' : '0',
        IstPKW:  masks.car  ? '1' : '0',
        IstKrad: '0', IstGkfz: '0', IstSonstig: '0'
      }
    };
  }

  test('yearTable rows expose classes (emoji) and textClasses (bracket) with ": " separator', async () => {
    const points = [
      pt(2022, { bike: true }),
      pt(2022, { bike: true }),
      pt(2022, { bike: true, car: true }),
      pt(2023, { car: true })
    ];
    const r = await UA.computeExportReport(makeCtx(points));
    const yt = r.structured.yearTable;
    expect(Array.isArray(yt)).toBe(true);

    const y2022 = yt.find(row => row.year === 2022);
    expect(y2022).toBeTruthy();
    expect(Array.isArray(y2022.classes)).toBe(true);
    expect(Array.isArray(y2022.textClasses)).toBe(true);
    expect(y2022.classes.length).toBe(y2022.textClasses.length);

    // No "=" anywhere — separator is ": " in both forms.
    for (const s of y2022.classes)     expect(s).not.toMatch(/=/);
    for (const s of y2022.textClasses) expect(s).not.toMatch(/=/);
    for (const s of y2022.textClasses) expect(s).toMatch(/: \d+$/);

    // textClasses must use bracket labels and never contain raw emoji.
    const EMOJI = /[\u{1F6B2}\u{1F6B6}\u{1F697}\u{1F3CD}\u{1F69B}\u{1F68C}]/u;
    for (const s of y2022.textClasses) {
      expect(s).toMatch(/\[(Rad|Fuss|PKW|Krad|Lkw|Sonst)\]/);
      expect(EMOJI.test(s)).toBe(false);
    }

    // Combo "Rad+PKW" with 1 occurrence must render as "[Rad]+[PKW]: 1".
    expect(y2022.textClasses).toContain('[Rad]+[PKW]: 1');
    // Solo Rad with 2 occurrences → "[Rad]: 2".
    expect(y2022.textClasses).toContain('[Rad]: 2');

    // Emoji form must contain the bike glyph for the [Rad] row.
    const radEmojiRow = y2022.classes.find(s => /^\u{1F6B2}: /u.test(s));
    expect(radEmojiRow).toBeDefined();
  });
});
