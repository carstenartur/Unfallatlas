/**
 * Integration test: `computeExportReport` exposes `structured.osmContext`
 * (#C4) and renders the verkehrsräumlicher Kontext block in text/HTML.
 *
 * The fetch happens via `UA.osmContext.fetchOsmContext` — we shortcut it
 * with `exportOptions.osmContextOverride` to keep the test hermetic.
 */

describe('UA.computeExportReport – structured.osmContext (#C4)', () => {
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
    load('ua.trend.js');
    load('ua.heatmap.js');
    load('ua.osm_context.js');
    mockWindow.fetch = async () => ({ ok: false, json: async () => ({}), text: async () => '' });
    mockWindow.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
    UA.osmContext.clearCache();
  });

  function pt() {
    return {
      lat: 52.25, lon: 9.8,
      props: {
        year: '2022',
        ukategorie: '3',
        ustunde: '8',
        uwochentag: '1',
        strzustand: '0',
        IstRad: '1', IstFuss: '0', IstPKW: '0', IstKrad: '0', IstGkfz: '0', IstSonstig: '0'
      }
    };
  }

  function makeCtx(opts) {
    const sw = { lat: 52.0, lng: 9.7 };
    const ne = { lat: 52.5, lng: 9.9 };
    const bounds = {
      getSouthWest: () => sw, getNorthEast: () => ne,
      getCenter: () => ({ lat: 52.25, lng: 9.8 }), contains: () => true
    };
    UA.reverseGeocode = async () => null;
    const ui = {
      severityEl: { value: 'all' }, roadConditionEl: { value: 'all' },
      hFromEl: { value: '0' }, hToEl: { value: '23' }, dayTypeEl: { value: 'all' },
      incBikeEl: { checked: true }, incPedEl: { checked: true }, incCarEl: { checked: true },
      incMotoEl: { checked: true }, incGkfzEl: { checked: true }, incSonEl: { checked: true }
    };
    return {
      CITY_RAW: 'Hannover',
      allPts: [pt(), pt()],
      selectionBounds: bounds,
      ui,
      exportOptions: Object.assign({ includeCosts: false, includeMeasures: false, includeHeatmap: false }, opts || {})
    };
  }

  test('passes through an explicit osmContextOverride into structured.osmContext', async () => {
    // Build the exact aggregated payload `fetchOsmContext` would have returned
    // and short-circuit the network with `osmContextOverride`. Ensures the
    // wiring path is independent of any real Overpass fetch.
    const fakeOsm = UA.osmContext.aggregate([
      { type: 'way', tags: { highway: 'primary', maxspeed: '50', lanes: '2' } },
      { type: 'way', tags: { highway: 'cycleway' } },
      { type: 'node', tags: { highway: 'traffic_signals' } }
    ]);
    fakeOsm.bbox = { south: 52, west: 9.7, north: 52.5, east: 9.9 };
    fakeOsm.quality = { elementCount: 3, fetchedAt: new Date().toISOString(), endpoint: 'mock' };

    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: fakeOsm }));
    expect(r.structured.osmContext).toBeDefined();
    expect(r.structured.osmContext.summary.dominantMaxspeed).toBe(50);
    expect(r.structured.osmContext.summary.cycleInfraWays).toBe(1);
    expect(r.structured.osmContext.summary.trafficSignals).toBe(1);
    // The text and HTML render paths show the OSM section
    expect(r.text).toContain('Verkehrsräumlicher Kontext (OSM)');
    expect(r.text).toMatch(/Tempolimit 50 km\/h/);
    expect(r.text).toMatch(/OpenStreetMap-Mitwirkende/);
    expect(r.html).toContain('Verkehrsräumlicher Kontext (OSM)');
    expect(r.html).toContain('50 km/h');
  });

  test('renders a verwaltungstauglichen error hint when osmContext.quality.error is present', async () => {
    // QA-PR „Export-Semantik vor Layout": Anstelle des rohen Fehlerstrings
    // („Fetch is aborted" / „HTTP 504") rendert der Export einen für die
    // Verwaltung lesbaren Hinweis. Der originale Fehlerstring darf NICHT
    // im sichtbaren Text/HTML auftauchen.
    const stub = { quality: { error: 'HTTP 504', fetchedAt: new Date().toISOString() } };
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: stub }));
    expect(r.structured.osmContext).toEqual(stub);
    expect(r.text).toMatch(/OSM-Kontextdaten konnten beim Export nicht geladen werden\./);
    expect(r.text).not.toMatch(/HTTP 504/);
    expect(r.html).toContain('OSM-Kontextdaten konnten beim Export nicht geladen werden.');
    expect(r.html).not.toContain('HTTP 504');
  });

  test('exportOptions.includeOsmContext=false suppresses the section entirely', async () => {
    const r = await UA.computeExportReport(makeCtx({ includeOsmContext: false }));
    expect(r.structured.osmContext).toBeNull();
    expect(r.text).not.toContain('Verkehrsräumlicher Kontext');
    expect(r.html).not.toContain('Verkehrsräumlicher Kontext');
  });

  test('includeOsmContext defaults to ON, override=null keeps it null without network call', async () => {
    // override===null means: pretend the fetch returned null (e.g. invalid bbox).
    // The block must therefore not appear.
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: null }));
    expect(r.structured.osmContext).toBeNull();
    expect(r.text).not.toContain('Verkehrsräumlicher Kontext');
  });
});
