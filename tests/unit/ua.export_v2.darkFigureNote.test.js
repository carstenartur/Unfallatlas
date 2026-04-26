/**
 * Unit tests for #C3 Dunkelziffer-Disclaimer in computeExportReport.
 *
 * The dark-figure note must appear as a mandatory block in the text output,
 * the HTML preview, and on the structured payload (so DOCX/PDF renderers can
 * pick it up).  This is a pure additive contract (no toggle).
 */

describe('UA.computeExportReport – Dunkelziffer-Pflichthinweis (#C3)', () => {
  let UA;

  beforeEach(() => {
    const mockWindow = { UA: {} };
    const fs = require('fs');
    const path = require('path');

    const load = (rel) => {
      const p = path.resolve(__dirname, '../../js/' + rel);
      (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    };

    load('ua.utils.js');
    load('ua.filters.js');
    load('ua.accident_views.js');

    // Stub fetch so optional template / catalog loads don't blow up.
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    // Minimal Leaflet stub: only used to call getCenter()/getBounds() shapes.
    mockWindow.L = { latLngBounds: () => {} };
    // computeExportReport reads window.location.href to populate the link var.
    mockWindow.location = { href: 'http://localhost/?city=Hannover' };

    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeCtx() {
    // A trivial ctx that exercises the happy path of computeExportReport without
    // depending on a real Leaflet map. We supply selectionBounds so boundsForExport
    // never reaches ctx.map.
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: (latlng) => {
        const [la, lo] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
        return la >= sw.lat && la <= ne.lat && lo >= sw.lng && lo <= ne.lng;
      }
    };
    UA.reverseGeocode = async () => null;
    return {
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: bounds,
      // Disable optional sections we don't care about for this test.
      exportOptions: { includeCosts: false, includeMeasures: false }
    };
  }

  test('exposes DARK_FIGURE_NOTE constant on UA with required fields', () => {
    expect(UA.DARK_FIGURE_NOTE).toBeDefined();
    expect(typeof UA.DARK_FIGURE_NOTE.title).toBe('string');
    expect(UA.DARK_FIGURE_NOTE.title.length).toBeGreaterThan(0);
    expect(typeof UA.DARK_FIGURE_NOTE.body).toBe('string');
    expect(UA.DARK_FIGURE_NOTE.body).toMatch(/Dunkelziffer/i);
    // Source attribution (BASt / UDV) must be present so adressees can verify.
    expect(UA.DARK_FIGURE_NOTE.sourceLabel).toMatch(/BASt/);
    expect(UA.DARK_FIGURE_NOTE.sourceLabel).toMatch(/UDV/);
    // Faktor-Spannweite 2–10× muss im Body erwähnt sein (vom Plan gefordert).
    expect(UA.DARK_FIGURE_NOTE.body).toMatch(/2[\u2013-]10/);
  });

  test('text output contains the dark-figure title, body, and source attribution', async () => {
    const ctx = makeCtx();
    const r = await UA.computeExportReport(ctx);
    expect(typeof r.text).toBe('string');
    expect(r.text).toContain(UA.DARK_FIGURE_NOTE.title);
    // A representative substring of the body (avoid full-string match which is brittle).
    expect(r.text).toMatch(/Dunkelziffer/);
    // Source attribution must be visible in the rendered text.
    expect(r.text).toMatch(/BASt/);
    expect(r.text).toMatch(/UDV/);
  });

  test('html output contains the dark-figure block (escaped) and source link', async () => {
    const ctx = makeCtx();
    const r = await UA.computeExportReport(ctx);
    expect(typeof r.html).toBe('string');
    expect(r.html).toContain(UA.DARK_FIGURE_NOTE.title);
    expect(r.html).toMatch(/Dunkelziffer/);
    expect(r.html).toMatch(/bast\.de/);
  });

  test('structured payload exposes darkFigureNote so DOCX/PDF can render it', async () => {
    const ctx = makeCtx();
    const r = await UA.computeExportReport(ctx);
    expect(r.structured).toBeDefined();
    expect(r.structured.darkFigureNote).toBeDefined();
    expect(r.structured.darkFigureNote.title).toBe(UA.DARK_FIGURE_NOTE.title);
    expect(r.structured.darkFigureNote.body).toBe(UA.DARK_FIGURE_NOTE.body);
    expect(r.structured.darkFigureNote.sourceLabel).toBe(UA.DARK_FIGURE_NOTE.sourceLabel);
  });

  test('dark-figure block is mandatory (cannot be disabled via exportOptions toggles)', async () => {
    // Even if a hypothetical caller passes `includeDarkFigure: false`, the block
    // must remain — there is intentionally no toggle for this safeguard.
    const ctx = makeCtx();
    ctx.exportOptions = {
      includeCosts: false,
      includeMeasures: false,
      includeDarkFigure: false  // not honoured by design
    };
    const r = await UA.computeExportReport(ctx);
    expect(r.text).toContain(UA.DARK_FIGURE_NOTE.title);
    expect(r.structured.darkFigureNote).toBeTruthy();
  });
});
