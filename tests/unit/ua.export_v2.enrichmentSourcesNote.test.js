/**
 * PR-E – Tests for the enrichment-sources note (Topographie/OSM/DTV-Proxy).
 *
 * The note must appear ONLY when the dataset actually carries context
 * fields (ctx.contextCapabilities.hasAny). Otherwise the structured
 * payload exposes `enrichmentSourcesNote: null` so DOCX/PDF/HTML/TEXT
 * renderers can do a single null check.
 */

describe('UA.computeExportReport – PR-E enrichment-sources note', () => {
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

    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    mockWindow.location = { href: 'http://localhost/?city=Hannover' };

    load('ua.export_v2.js');
    UA = mockWindow.UA;
  });

  function makeCtx(extra) {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw,
      getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }),
      contains: (latlng) => {
        const [la, lo] = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
        return la >= sw.lat && la <= ne.lat && lo >= sw.lng && lo <= ne.lng;
      },
    };
    UA.reverseGeocode = async () => null;
    return Object.assign({
      CITY_RAW: 'Hannover',
      allPts: [],
      selectionBounds: bounds,
      exportOptions: { includeCosts: false, includeMeasures: false },
    }, extra || {});
  }

  test('exposes ENRICHMENT_SOURCES_NOTE constant on UA with required source attribution', () => {
    expect(UA.ENRICHMENT_SOURCES_NOTE).toBeDefined();
    expect(typeof UA.ENRICHMENT_SOURCES_NOTE.title).toBe('string');
    expect(UA.ENRICHMENT_SOURCES_NOTE.title).toMatch(/Kontextdaten/);
    expect(Array.isArray(UA.ENRICHMENT_SOURCES_NOTE.sources)).toBe(true);
    expect(UA.ENRICHMENT_SOURCES_NOTE.sources.length).toBeGreaterThanOrEqual(2);
    // Plan-Anforderung („SRTM 30 m via OpenTopography, OSM Stand …"):
    // SRTM-Quelle und OSM-Quelle müssen separat ausgewiesen sein.
    const labels = UA.ENRICHMENT_SOURCES_NOTE.sources.map(s => s.label).join(' | ');
    expect(labels).toMatch(/SRTM/);
    expect(labels).toMatch(/OpenStreetMap/i);
    // Disclaimer-Botschaft („Umgebung, nicht Ursache") muss erhalten bleiben.
    expect(UA.ENRICHMENT_SOURCES_NOTE.body).toMatch(/Umgebung/);
    expect(UA.ENRICHMENT_SOURCES_NOTE.body).toMatch(/nicht.*(Ursach|Ursachen)/i);
  });

  test('pickEnrichmentSourcesNote returns null without context capabilities', () => {
    expect(UA._pickEnrichmentSourcesNote({})).toBeNull();
    expect(UA._pickEnrichmentSourcesNote({ contextCapabilities: {} })).toBeNull();
    expect(UA._pickEnrichmentSourcesNote({ contextCapabilities: { hasAny: false } })).toBeNull();
  });

  test('pickEnrichmentSourcesNote returns the note when hasAny is true', () => {
    const note = UA._pickEnrichmentSourcesNote({ contextCapabilities: { hasAny: true } });
    expect(note).toBe(UA.ENRICHMENT_SOURCES_NOTE);
  });

  test('structured payload sets enrichmentSourcesNote = null when no context fields are present', async () => {
    const r = await UA.computeExportReport(makeCtx());
    expect(r.structured).toBeDefined();
    expect(r.structured.enrichmentSourcesNote).toBeNull();
    // And neither TEXT nor HTML must mention the source title.
    expect(r.text).not.toMatch(/Kontextdaten – Datenquellen/);
    expect(r.html).not.toMatch(/Kontextdaten – Datenquellen/);
  });

  test('structured payload + TEXT + HTML render the note when hasAny capability is set', async () => {
    const ctx = makeCtx({ contextCapabilities: { hasAny: true, hasSlope: true } });
    const r = await UA.computeExportReport(ctx);
    expect(r.structured.enrichmentSourcesNote).toBe(UA.ENRICHMENT_SOURCES_NOTE);
    // TEXT contains title + at least one source label.
    expect(r.text).toContain(UA.ENRICHMENT_SOURCES_NOTE.title);
    expect(r.text).toMatch(/SRTM/);
    expect(r.text).toMatch(/OpenStreetMap/);
    // HTML contains title and at least one source URL.
    expect(r.html).toContain(UA.ENRICHMENT_SOURCES_NOTE.title);
    expect(r.html).toMatch(/openstreetmap\.org/);
  });
});
