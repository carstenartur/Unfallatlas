/**
 * Integration test for `computeExportReport` → recommended-measures pipeline.
 *
 * Closes the visibility gaps from the PR #223 follow-up:
 *   1) `osmContext` is actually piped into `recommendMeasures` (not just sitting
 *       in `structured`).
 *   2) `economicImpact.trendQualifier` lands in the final view model AND in
 *       the rendered Text/HTML output (so it doesn't stay a hidden field).
 *   3) `filteredOut` and the OSM-coverage disclaimer are surfaced in the
 *       output so the user understands why measures were suppressed and
 *       when the suppression couldn't even be checked.
 *   4) Missing OSM context = "no suppression" (defensive) but a visible
 *       hint that the prerequisite axes were not evaluated.
 *
 * Mirrors the loader pattern from ua.export_v2.osmContext.test.js but pulls
 * in the cost + measures helpers as well.
 */

describe('UA.computeExportReport – recommendedMeasures pipeline (PR-#223 follow-up)', () => {
  let UA;
  // Capture the pre-suite global.fetch state so the offline stub doesn't leak
  // into other Jest test files in the same worker (cross-file flakiness).
  const HAD_FETCH = Object.prototype.hasOwnProperty.call(global, 'fetch');
  const ORIG_FETCH = HAD_FETCH ? global.fetch : undefined;

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
    load('ua.costs.js');
    load('ua.measures.js');
    // Network is offline → `loadCostFactors` and `loadCatalog` fall back to
    // the bundled FALLBACK objects, which both contain a `tempo_30` measure
    // with `currentSpeedLimitGt: 30` — exactly what we need to exercise
    // the prerequisites filter. Also satisfies the gremien/reference-docs
    // loaders inside computeExportReport so they don't spam console warnings.
    const fakeFetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
    mockWindow.fetch = fakeFetch;
    global.fetch = fakeFetch;
    mockWindow.L = { latLngBounds: () => {} };
    load('ua.export_v2.js');
    UA = mockWindow.UA;
    UA.osmContext.clearCache();
    UA.costs._resetCache();
    UA.measures._resetCache();
  });

  afterEach(() => {
    if (HAD_FETCH) global.fetch = ORIG_FETCH;
    else delete global.fetch;
  });

  // Build a single accident point. Pattern bit 1 (Rad alone) → matches the
  // FALLBACK `tempo_30` targetPatterns.
  function pt(year, ukategorie) {
    return {
      lat: 52.25, lon: 9.8,
      props: {
        year: String(year),
        ukategorie: String(ukategorie),
        ustunde: '8',
        uwochentag: '3',
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
    // Build a multi-year, Rad-only series. Severity 3 (Leichtverletzte) so
    // the cost block always activates (light × N > 0 → total > 0).
    // 4 years lets the trend classifier produce a stable result.
    const points = [];
    for (const y of [2020, 2021, 2022, 2023]) for (let i = 0; i < 6; i++) points.push(pt(y, 3));
    return {
      CITY_RAW: 'Hannover',
      allPts: points,
      selectionBounds: bounds,
      ui,
      // Baseline mit überwiegend PKW-only (mask=4), damit Rad-only (mask=1)
      // im lokalen Bereich als überrepräsentiert detektiert wird (Faktor ≫ 1,35).
      baselineCounts: { total: 1000, byMask: { 4: 950, 1: 50 } },
      // Default: keep cost + measures + osm + heatmap on so the full pipeline runs.
      exportOptions: Object.assign({}, opts || {})
    };
  }

  // OSM payload with a fast Hauptstraße (50 km/h) and no bike infra → both
  // axes (speed, bikeInfra) belastbar geprüft. tempo_30 should be RECOMMENDED.
  function osmKept() {
    const agg = UA.osmContext.aggregate([
      { type: 'way', tags: { highway: 'primary', maxspeed: '50', lanes: '2', width: '8.0' } },
      { type: 'way', tags: { highway: 'secondary', maxspeed: '50', lanes: '2', width: '7.5' } }
    ]);
    agg.bbox = { south: 52, west: 9.7, north: 52.5, east: 9.9 };
    agg.quality = { elementCount: 2, fetchedAt: new Date().toISOString(), endpoint: 'mock' };
    return agg;
  }

  // OSM payload with a Tempo-30-Zone → tempo_30 must be FILTERED OUT.
  function osmDrop() {
    const agg = UA.osmContext.aggregate([
      { type: 'way', tags: { highway: 'residential', maxspeed: '30', lanes: '1', width: '5.5' } },
      { type: 'way', tags: { highway: 'residential', maxspeed: '30', lanes: '1', width: '5.5' } }
    ]);
    agg.bbox = { south: 52, west: 9.7, north: 52.5, east: 9.9 };
    agg.quality = { elementCount: 2, fetchedAt: new Date().toISOString(), endpoint: 'mock' };
    return agg;
  }

  // ----------------------------------------------------------------------
  // (1) osmContext is wired into recommendMeasures
  // ----------------------------------------------------------------------

  test('osmContext drop case suppresses tempo_30 and surfaces it in filteredOut', async () => {
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: osmDrop() }));
    const rm = r.structured.recommendedMeasures;
    expect(rm).toBeDefined();
    // tempo_30 must NOT be in the active recommendations.
    expect(rm.measures.find(m => m.measure.id === 'tempo_30')).toBeUndefined();
    // …but MUST appear in filteredOut with a human reason mentioning the speed limit.
    const dropped = rm.filteredOut.find(f => f.id === 'tempo_30');
    expect(dropped).toBeDefined();
    expect(dropped.reason).toMatch(/Tempolimit\s+30\s+km\/h/);
    // Output must mention the suppression so it's user-visible (not just internal state).
    expect(r.text).toMatch(/Wegen OSM-Voraussetzungen NICHT empfohlen/);
    expect(r.text).toMatch(/Tempo-30-Anordnung/);
    expect(r.html).toMatch(/Wegen OSM-Voraussetzungen NICHT empfohlen/);
  });

  test('osmContext keep case lets tempo_30 through and reports no filteredOut for it', async () => {
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: osmKept() }));
    const rm = r.structured.recommendedMeasures;
    expect(rm).toBeDefined();
    expect(rm.measures.find(m => m.measure.id === 'tempo_30')).toBeDefined();
    expect((rm.filteredOut || []).find(f => f.id === 'tempo_30')).toBeUndefined();
  });

  // ----------------------------------------------------------------------
  // (2) trendQualifier is in the final view model AND rendered everywhere
  // ----------------------------------------------------------------------

  test('economicImpact.trendQualifier is set and "Mehrjahres-Trend" is rendered in TEXT and HTML', async () => {
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: osmKept() }));
    expect(r.structured.economicImpact).toBeTruthy();
    // 4-year flat series ≈ "stagnierend" or "rückläufig"/"unbestimmt"; in any case
    // one of the four allowed values from UA.trend.
    expect(['steigend', 'stagnierend', 'rückläufig', 'unbestimmt'])
      .toContain(r.structured.economicImpact.trendQualifier);
    // Must show up in the human-readable output paths, not just in the data model.
    expect(r.text).toMatch(/Mehrjahres-Trend/);
    expect(r.html).toMatch(/Mehrjahres-Trend/);
  });

  // ----------------------------------------------------------------------
  // (3) Missing OSM context: NO suppression, but visible disclaimer
  // ----------------------------------------------------------------------

  test('missing osmContext does NOT suppress measures but DOES surface a coverage disclaimer', async () => {
    // override===null mimics a slow/blocked Overpass mirror. Defensive design:
    // we keep the recommendation, but warn that prerequisites couldn't be checked.
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: null }));
    const rm = r.structured.recommendedMeasures;
    expect(rm).toBeDefined();
    // tempo_30 stays in (no false-negative filtering when data is missing)
    expect(rm.measures.find(m => m.measure.id === 'tempo_30')).toBeDefined();
    // osmCoverage should explicitly flag the gap …
    expect(rm.osmCoverage).toBeDefined();
    expect(rm.osmCoverage.present).toBe(false);
    expect(rm.osmCoverage.hasGap).toBe(true);
    // …and the rendered output must not pretend prerequisites were checked.
    expect(r.text).toMatch(/OSM-Datenstand/);
    expect(r.text).toMatch(/nicht abgerufen|nicht geprüft/);
    expect(r.html).toMatch(/OSM-Datenstand/);
  });

  test('osmContext.quality.error stub is surfaced verbatim in the disclaimer', async () => {
    const stub = { quality: { error: 'HTTP 504', fetchedAt: new Date().toISOString() } };
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: stub }));
    const rm = r.structured.recommendedMeasures;
    expect(rm.osmCoverage.error).toBe('HTTP 504');
    expect(r.text).toMatch(/HTTP 504/);
    expect(r.html).toMatch(/HTTP 504/);
  });

  // ----------------------------------------------------------------------
  // (4) recommendedMeasures.osmCoverage faithfully reflects axes coverage
  // ----------------------------------------------------------------------

  test('osmCoverage reports speed axis as covered when dominantMaxspeed is known', async () => {
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: osmKept() }));
    const cov = r.structured.recommendedMeasures.osmCoverage;
    expect(cov.present).toBe(true);
    expect(cov.axes.speed).toBe(true);
    // tempo_30 has only the `currentSpeedLimitGt` prereq → no gap on speed.
    expect(cov.missingAxes).not.toContain('Tempolimit');
  });

  // ----------------------------------------------------------------------
  // (5) DOCX/PDF render helpers stay aligned with TEXT/HTML wording.
  //     ua.report_v2.js exposes them on UA so we can verify the wording
  //     without bootstrapping the full docx/pdfMake stack.
  // ----------------------------------------------------------------------

  test('UA.trendQualifierTextDocx mirrors the TEXT/HTML phrasing for all four classifications', () => {
    // Load report_v2 just for its exported helpers.
    const fs = require('fs');
    const path = require('path');
    const mockWindow = { UA: UA, location: { href: 'http://localhost/' }, document: { createElement: () => ({}), getElementById: () => null } };
    const p = path.resolve(__dirname, '../../js/ua.report_v2.js');
    try { (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow); } catch (_) { /* tolerate missing libs */ }
    expect(typeof UA.trendQualifierTextDocx).toBe('function');
    expect(UA.trendQualifierTextDocx('steigend')).toMatch(/steigend/);
    expect(UA.trendQualifierTextDocx('stagnierend')).toMatch(/stagnierend hoch/);
    expect(UA.trendQualifierTextDocx('rückläufig')).toMatch(/rückläufig/);
    expect(UA.trendQualifierTextDocx('unbestimmt')).toMatch(/unbestimmt/);
    expect(UA.trendQualifierTextDocx(null)).toBeNull();
  });

  test('UA.osmCoverageNoteDocx flags missing context AND missing axes', () => {
    const fs = require('fs');
    const path = require('path');
    const mockWindow = { UA: UA, location: { href: 'http://localhost/' }, document: { createElement: () => ({}), getElementById: () => null } };
    const p = path.resolve(__dirname, '../../js/ua.report_v2.js');
    try { (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow); } catch (_) { /* tolerate missing libs */ }
    expect(typeof UA.osmCoverageNoteDocx).toBe('function');
    expect(UA.osmCoverageNoteDocx({ present: false, error: 'HTTP 504', axes: {}, missingAxes: [], hasGap: false }))
      .toMatch(/HTTP 504/);
    expect(UA.osmCoverageNoteDocx({ present: true, error: null, axes: {}, missingAxes: ['Fahrbahnbreite'], hasGap: true }))
      .toMatch(/mangels Daten nicht geprüft.*Fahrbahnbreite/);
    expect(UA.osmCoverageNoteDocx({ present: true, error: null, axes: {}, missingAxes: [], hasGap: false }))
      .toBeNull();
  });
});
