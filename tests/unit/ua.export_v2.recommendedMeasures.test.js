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
 *   4) Missing location context leaves a documented need for field checks.
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
    load('ua.context_measures.js');
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

  // The rail fixtures need bicycle-only cases. Speed-limit fixtures add car involvement.
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

  function makeMixedCtx(opts) {
    const ctx = makeCtx(opts);
    ctx.allPts.forEach(point => { point.props.IstPKW = '1'; });
    ctx.baselineCounts.byMask = { 4: 950, 5: 50 };
    return ctx;
  }

  test('osmContext drop case suppresses tempo_30 and surfaces it in filteredOut', async () => {
    const r = await UA.computeExportReport(makeMixedCtx({ osmContextOverride: osmDrop() }));
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
    const r = await UA.computeExportReport(makeMixedCtx({ osmContextOverride: osmKept() }));
    const rm = r.structured.recommendedMeasures;
    expect(rm).toBeDefined();
    expect(rm.measures.find(m => m.measure.id === 'tempo_30')).toBeDefined();
    expect((rm.filteredOut || []).find(f => f.id === 'tempo_30')).toBeUndefined();
    const {guidance} = rm.measures.find(item => item.measure.id === 'tempo_30');
    for (const output of [r.text, r.html]) {
      expect(output).toContain(guidance.url);
      expect(output).toContain(guidance.check);
      expect(output).toContain(guidance.scope);
      expect(output).not.toMatch(/Geschätzte Amortisation|erwartete Reduktion/);
    }
  });

  // ----------------------------------------------------------------------
  // (2) trendQualifier is in the final view model AND rendered everywhere
  // ----------------------------------------------------------------------

  test('economicImpact.trendQualifier is set and "Mehrjahres-Trend" is rendered in TEXT and HTML', async () => {
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: osmKept() }));
    expect(r.structured.economicImpact).toBeTruthy();
    for (const output of [r.text, r.html]) {
      expect(output).toContain('je Unfall eine Person');
      expect(output).toContain('Preisstand 2023');
      expect(output).toContain('verkehrsbericht_2024.pdf#page=6');
      expect(output).toContain('131.878 €');
      expect(output).not.toContain('Geschätzte externe Kosten im Bereich');
    }
    // 4-year flat series ≈ "stagnierend" or "rückläufig"/"unbestimmt"; in any case
    // one of the four allowed values from UA.trend.
    expect(['steigend', 'stagnierend', 'rückläufig', 'unbestimmt'])
      .toContain(r.structured.economicImpact.trendQualifier);
    // Must show up in the human-readable output paths, not just in the data model.
    expect(r.text).toMatch(/Mehrjahres-Trend/);
    expect(r.html).toMatch(/Mehrjahres-Trend/);
  });

  // ----------------------------------------------------------------------
  // (3) Missing context and a confirmed rail context
  // ----------------------------------------------------------------------

  test('missing local evidence suppresses the ranked catalog and requests field checks', async () => {
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: null }));
    expect(r.structured.recommendedMeasures).toBeNull();
    expect(r.structured.measureAssessmentNote).toMatch(/Vor-Ort-Prüfung/);
    expect(r.text).toContain(r.structured.measureAssessmentNote);
    expect(r.html).toContain(r.structured.measureAssessmentNote);
    expect(r.text).not.toMatch(/Amortisation|Tempo-30-Anordnung/);
    expect(r.structured.motion).toBeNull();
  });

  test('an OSM timeout remains visible without a quantitative catalog recommendation', async () => {
    const stub = { quality: { error: 'HTTP 504', fetchedAt: new Date().toISOString() } };
    const r = await UA.computeExportReport(makeCtx({ osmContextOverride: stub }));
    expect(r.structured.recommendedMeasures).toBeNull();
    expect(r.text).toContain('OSM-Kontextdaten konnten beim Export nicht geladen werden.');
    expect(r.html).toMatch(/Vor-Ort-Prüfung/);
  });

  test('the decision prioritizes a verified rail context and counts only the relevant accident types', async () => {
    const osm = osmKept();
    osm.contexts.tramTrackWays = 2;
    const ctx = makeCtx({ osmContextOverride: osm });
    ctx.confirmedAreaName = 'Testknoten';
    ctx.allPts.slice(0, 3).forEach(p => { p.props.utyp1 = '1'; });
    ctx.allPts.slice(0, 2).forEach(p => { p.props.ukategorie = '2'; });
    ctx.allPts[3].props.ukategorie = '2';
    ctx.allPts[3].props.utyp1 = '3';
    const r = await UA.computeExportReport(ctx);

    expect(r.structured.recommendedMeasures).toBeNull();
    expect(r.structured.motion.requests.join(' ')).toMatch(/Gleisquerungen.*Querungswinkel/);
    expect(r.structured.motion.rationale).toMatch(/3 Fahrunfälle mit Radbeteiligung.*zwei Unfälle mit Schwerverletzten|3 Fahrunfälle mit Radbeteiligung.*2 Unfälle mit Schwerverletzten/);
    expect(r.structured.motion.rationale).toMatch(/Unfallursache/);
    expect(r.text).toContain(r.structured.motion.requests[0]);
    expect(r.html).toContain(r.structured.motion.requests[0]);
  });

  test('the Hannover selection uses published ATKIS track geometry when Overpass is unavailable', async () => {
    const tracks = require('../../data/mobility/hannover-tram-context.json');
    const offline = global.fetch;
    global.fetch = jest.fn(async url => url === 'data/mobility/hannover-tram-context.json'
      ? { ok: true, json: async () => tracks }
      : offline(url));
    UA.osmContext.fetchOsmContext = async () => ({ quality: { error: 'timeout' } });
    const ctx = makeCtx();
    ctx.selectionBounds.getSouthWest = () => ({ lat: 52.391108, lng: 9.719819 });
    ctx.selectionBounds.getNorthEast = () => ({ lat: 52.391889, lng: 9.721093 });
    ctx.allPts[0].props.utyp1 = '1';
    const r = await UA.computeExportReport(ctx);
    expect(r.structured.motion.source.label).toContain('LGLN');
    expect(r.structured.motion.rationale).toContain('1 Fahrunfall mit Radbeteiligung');
    expect(r.structured.recommendedMeasures).toBeNull();

    const distant = makeCtx();
    distant.allPts[0].props.utyp1 = '1';
    distant.selectionBounds.getSouthWest = () => ({ lat: 52.2, lng: 9.6 });
    distant.selectionBounds.getNorthEast = () => ({ lat: 52.201, lng: 9.601 });
    const other = await UA.computeExportReport(distant);
    expect(other.structured.motion).toBeNull();
    expect(other.structured.measureAssessmentNote).toMatch(/Vor-Ort-Prüfung/);
  });

  // ----------------------------------------------------------------------
  // (4) recommendedMeasures.osmCoverage faithfully reflects axes coverage
  // ----------------------------------------------------------------------

  test('osmCoverage reports speed axis as covered when dominantMaxspeed is known', async () => {
    const r = await UA.computeExportReport(makeMixedCtx({ osmContextOverride: osmKept() }));
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
    expect(UA.trendQualifierTextDocx('stagnierend')).toMatch(/ohne deutlichen Rückgang/);
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
