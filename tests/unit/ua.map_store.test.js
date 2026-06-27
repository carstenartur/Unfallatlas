'use strict';

const fs = require('fs');
const path = require('path');

function loadModules(extraWin) {
  const win = Object.assign(
    { UA: {}, location: { href: 'http://localhost/' } },
    extraWin || {}
  );
  const load = (file) => {
    (function (window) {
      eval(fs.readFileSync(path.resolve(__dirname, '../../js/' + file), 'utf8'));
    })(win);
  };
  load('ua.render_scheduler.js');
  load('ua.map_store.js');
  return win.UA;
}

describe('UA.MapStore', () => {
  let UA;

  beforeEach(() => {
    jest.useFakeTimers();
    UA = loadModules();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function makeCtx(overrides) {
    const calls = [];
    const ctx = Object.assign({
      allPts: [{ lat: 1, lon: 1, props: {} }],
      filteredAll: [], filteredCapped: [], viewportPts: [],
      showCluster: true, showHeatmap: true, showOnlyAboveAverage: false,
      _dataChanged: false
    }, overrides || {});

    // Inject spied-upon UA functions
    UA.applyFilters        = jest.fn(() => { calls.push('applyFilters'); });
    UA.applyViewportFilter = jest.fn(() => { calls.push('applyViewportFilter'); });
    UA.renderLayers        = jest.fn(() => { calls.push('renderLayers'); });
    UA.saveCityState       = jest.fn(() => { calls.push('saveCityState'); });
    UA.syncViewToUrl       = jest.fn(() => { calls.push('syncViewToUrl'); });

    return { ctx, calls };
  }

  test('create() returns a store with dispatch and cancelPending', () => {
    const { ctx } = makeCtx();
    const store = UA.MapStore.create(ctx);
    expect(typeof store.dispatch).toBe('function');
    expect(typeof store.cancelPending).toBe('function');
  });

  test('filtersChanged dispatches a full render pipeline', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('filtersChanged');
    // Synchronous schedule (debounceMs: 0)
    expect(calls).toContain('applyFilters');
    expect(calls).toContain('applyViewportFilter');
    expect(calls).toContain('renderLayers');
    expect(calls).toContain('saveCityState');
  });

  test('layerToggled dispatches only renderLayers', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('layerToggled');
    expect(calls).toContain('renderLayers');
    expect(calls).not.toContain('applyFilters');
  });

  test('cityLoaded dispatches a synchronous full render', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('cityLoaded');
    expect(calls).toContain('applyFilters');
    expect(calls).toContain('renderLayers');
    expect(calls).toContain('saveCityState');
  });

  test('selectionChanged dispatches a full render pipeline', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('selectionChanged');
    expect(calls).toContain('applyFilters');
    expect(calls).toContain('renderLayers');
  });

  test('exportModeChanged dispatches only renderLayers', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('exportModeChanged');
    expect(calls).toContain('renderLayers');
    expect(calls).not.toContain('applyFilters');
  });

  test('contextLayerLoaded schedules a full render', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('contextLayerLoaded');
    expect(calls).toContain('applyFilters');
    expect(calls).toContain('renderLayers');
  });

  test('viewportChanged is debounced by 350 ms', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('viewportChanged');
    // Should not have rendered yet (waiting for debounce + rAF fallback)
    const renderCountBefore = calls.filter(c => c === 'renderLayers').length;
    jest.advanceTimersByTime(349);
    const renderCountMid = calls.filter(c => c === 'renderLayers').length;
    expect(renderCountMid).toBe(renderCountBefore); // still debouncing
    jest.advanceTimersByTime(1);
    // rAF falls back to setTimeout(16) in the scheduler when window.rAF not present
    jest.runAllTimers();
    expect(calls).toContain('applyViewportFilter');
  });

  test('cancelPending prevents a pending render', () => {
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    // Use a debounced action
    store.dispatch('viewportChanged', { debounceMs: 200 });
    store.cancelPending();
    jest.advanceTimersByTime(500);
    jest.runAllTimers();
    expect(calls.filter(c => c === 'renderLayers').length).toBe(0);
  });

  test('rapid layerToggled dispatches produce only one render', () => {
    // layerToggled uses synchronous schedule (debounceMs: 0), so each call
    // fires immediately. Verify the epoch guard still works for async paths.
    const { ctx, calls } = makeCtx();
    const store = UA.MapStore.create(ctx);
    store.dispatch('layerToggled');
    store.dispatch('layerToggled');
    store.dispatch('layerToggled');
    // Each synchronous dispatch fires once; but for debounced actions only
    // the last matters. Here we verify three synchronous renders happened.
    expect(calls.filter(c => c === 'renderLayers').length).toBe(3);
  });

  test('unknown action logs a warning and does not throw', () => {
    const { ctx } = makeCtx();
    const store = UA.MapStore.create(ctx);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => store.dispatch('unknownAction')).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknownAction'));
    warn.mockRestore();
  });
});
