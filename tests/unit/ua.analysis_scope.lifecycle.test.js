'use strict';

const fs = require('node:fs');
const path = require('node:path');

const sources = Object.fromEntries(['ua.lifecycle.js', 'ua.ui.js', 'ua.map_v2.js', 'ua.analysis_scope.js']
  .map(name => [name, fs.readFileSync(path.resolve(__dirname, '../../js', name), 'utf8')]));
const LOAD_ERROR = 'Daten konnten nicht geladen werden. Bitte später erneut versuchen oder Quelle prüfen.';

function evaluate(name, win) {
  (function (window) { eval(sources[name]); })(win); // eslint-disable-line no-eval
}

function loadRuntime({ loading = true } = {}) {
  document.body.innerHTML = '<select id="citySel" aria-busy="true"></select>'
    + '<div id="stat" role="status" title="Ladezustand">Lade Daten…</div>';
  const win = { UA: {}, location: { href: 'http://localhost/werkbank_v2.html?city=Hannover' } };
  evaluate('ua.lifecycle.js', win);
  evaluate('ua.ui.js', win);
  evaluate('ua.map_v2.js', win);
  const UA = win.UA;
  const ctx = {
    CITY_RAW: 'Hannover', lifecyclePrimary: true, allPts: [], filteredAll: [], filteredCapped: [], viewportPts: [],
    map: { getBounds: () => ({ south: 52.36, west: 9.72, north: 52.39, east: 9.75 }) },
    ui: { citySel: document.getElementById('citySel'), statEl: document.getElementById('stat'),
      incBikeEl: { checked: true }, incCarEl: { checked: true } },
  };
  UA.getRuntimeContext = () => ctx;
  let resolveOptional, resolveProvenance;
  UA.optionalModulePromises = { politicalContext: new Promise(resolve => { resolveOptional = resolve; }) };
  UA.exportProvenanceReady = new Promise(resolve => { resolveProvenance = resolve; });
  if (loading) UA._lifecycleReporter.beginLoad('Hannover');
  evaluate('ua.analysis_scope.js', win);
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return { UA, ctx, resolveOptional, resolveProvenance };
}

function point(id, lat = 52.376, lon = 9.731) {
  return { id, lat, lon, props: { istrad: '1', istpkw: '1' } };
}

describe('analysis scope status ownership during application loading', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  // Break caught: the real deferred scope refresh writes successful zero-count
  // text over the error produced by the application's existing UI failure path.
  test('late scope timers and module completion preserve a failed data-load message', async () => {
    const { UA, ctx, resolveOptional, resolveProvenance } = loadRuntime();
    UA._lifecycleReporter.fail(new Error('Injected accident-data HTTP 503'));
    UA.markCityDropdownError(ctx);
    ctx.ui.statEl.setAttribute('role', 'alert');

    await jest.advanceTimersByTimeAsync(1500);

    expect(UA.lifecycle.getSnapshot().status).toBe('error');
    expect(ctx.ui.statEl.textContent).toBe(LOAD_ERROR);
    expect(ctx.ui.statEl.getAttribute('role')).toBe('alert');
    resolveOptional(true);
    resolveProvenance(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(ctx.ui.statEl.textContent).toBe(LOAD_ERROR);
  });

  test.each([false, true])('scope refresh preserves the pending message before data arrives (loading=%s)', async loading => {
    const { UA, ctx, resolveOptional, resolveProvenance } = loadRuntime({ loading });
    await jest.advanceTimersByTimeAsync(1500);
    resolveOptional(true);
    resolveProvenance(true);
    await jest.advanceTimersByTimeAsync(0);

    expect(UA.lifecycle.getSnapshot().status).toBe(loading ? 'loading' : 'booting');
    expect(ctx.ui.statEl.textContent).toBe('Lade Daten…');
    expect(ctx.ui.statEl.title).toBe('Ladezustand');
  });

  test('loaded data updates exact counts while rendering and after readiness', async () => {
    const { UA, ctx, resolveOptional, resolveProvenance } = loadRuntime();
    ctx.allPts = [point('visible'), point('outside', 53, 10)];
    ctx.filteredAll = ctx.allPts;
    ctx.filteredCapped = ctx.allPts;
    UA._lifecycleReporter.recordData({ city: 'Hannover', loaded: 2 });
    const revision = UA._lifecycleReporter.beginRender({ city: 'Hannover', loaded: 2,
      layers: { cluster: { requested: true, expected: 1, complete: false } } });
    UA.updateStats(ctx);
    expect(UA.lifecycle.getSnapshot().status).toBe('rendering');
    expect(ctx.ui.statEl.textContent).toBe('Stadt: Hannover | geladen: 2 | stadtweit nach Filtern: 2 | sichtbar: 1');

    UA._lifecycleReporter.reportLayer(revision, 'cluster', { complete: true, visible: 1 });
    UA._lifecycleReporter.finishRender(revision);
    ctx.allPts.push(point('second-visible'));
    resolveOptional(true);
    resolveProvenance(true);
    await jest.advanceTimersByTimeAsync(1500);
    expect(UA.lifecycle.getSnapshot().status).toBe('ready');
    expect(ctx.ui.statEl.textContent).toBe('Stadt: Hannover | geladen: 3 | stadtweit nach Filtern: 3 | sichtbar: 2');
  });

  test('a successfully loaded empty population still displays truthful zero counts', () => {
    const { UA, ctx } = loadRuntime();
    UA._lifecycleReporter.recordData({ city: 'Hannover', loaded: 0 });
    const revision = UA._lifecycleReporter.beginRender({ city: 'Hannover', loaded: 0, layers: {} });
    UA._lifecycleReporter.finishRender(revision);
    UA.updateStats(ctx);
    expect(ctx.ui.statEl.textContent).toBe('Stadt: Hannover | geladen: 0 | stadtweit nach Filtern: 0 | sichtbar: 0');
  });

  test('the primary loading failure does not suppress counts for an independent preview', () => {
    const { UA, ctx } = loadRuntime();
    UA._lifecycleReporter.fail(new Error('Primary data unavailable'));
    UA.markCityDropdownError(ctx);
    const points = [point('preview')];
    const preview = { ...ctx, lifecyclePrimary: false, allPts: points, filteredAll: points, filteredCapped: points,
      ui: { ...ctx.ui, statEl: document.createElement('div') } };
    UA.updateStats(preview);
    expect(preview.ui.statEl.textContent).toBe('Stadt: Hannover | geladen: 1 | stadtweit nach Filtern: 1 | sichtbar: 1');
    expect(ctx.ui.statEl.textContent).toBe(LOAD_ERROR);
  });
});
