'use strict';

const fs = require('fs');
const path = require('path');

function loadLifecycle() {
  const win = {
    UA: {},
    L: {},
    location: { href: 'http://localhost/' },
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.lifecycle.js'), 'utf8');
  (function (window) { eval(source); })(win);
  return { win, lifecycle: win.UA.lifecycle, reporter: win.UA._lifecycleReporter };
}

function loadMapModule(win) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.map_v2.js'), 'utf8');
  (function (window) { eval(source); })(win);
}

function beginClusterRender(reporter, overrides = {}) {
  return reporter.beginRender({
    city: 'Bonn',
    loaded: 100,
    filtered: 40,
    viewport: 12,
    coverage: { mode: 'full-city', complete: true, provider: 'static' },
    layers: {
      cluster: { requested: true, expected: 12, processed: 0, complete: false },
      heatmap: { requested: false, complete: true },
    },
    ...overrides,
  });
}

describe('UA.lifecycle', () => {
  test('loads before the map and application producers', () => {
    const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
    const lifecycleIndex = html.indexOf('js/ua.lifecycle.js');
    expect(lifecycleIndex).toBeGreaterThan(-1);
    expect(lifecycleIndex).toBeLessThan(html.indexOf('js/ua.map_v2.js'));
    expect(lifecycleIndex).toBeLessThan(html.indexOf('js/ua.app_v2.js'));
  });

  test('exposes only frozen contract objects and detached diagnostics', () => {
    const { lifecycle, reporter } = loadLifecycle();
    expect(Object.isFrozen(lifecycle)).toBe(true);
    expect(Object.keys(lifecycle)).toEqual(['getSnapshot', 'whenReady']);

    reporter.beginLoad('Bonn');
    reporter.recordData({
      city: 'Bonn',
      loaded: 100,
      coverage: { mode: 'full-city', complete: true, bounds: { south: 50 } },
    });

    const snapshot = lifecycle.getSnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.counts)).toBe(true);
    expect(Object.isFrozen(snapshot.coverage)).toBe(true);
    expect(Object.isFrozen(snapshot.coverage.bounds)).toBe(true);
    expect(snapshot).not.toHaveProperty('ctx');
    expect(snapshot).not.toHaveProperty('map');
  });

  test('whenReady waits for submitted render and requested layer completion', async () => {
    const { lifecycle, reporter } = loadLifecycle();
    reporter.beginLoad('Bonn');
    const revision = beginClusterRender(reporter);
    let resolved = false;
    const ready = lifecycle.whenReady({
      city: 'Bonn',
      minLoaded: 1,
      minFiltered: 1,
      minViewport: 1,
      requireCompleteCoverage: true,
      layers: ['cluster'],
    }, { timeoutMs: 1000 }).then((snapshot) => {
      resolved = true;
      return snapshot;
    });

    reporter.finishRender(revision);
    await Promise.resolve();
    expect(resolved).toBe(false);

    reporter.reportLayer(revision, 'cluster', {
      processed: 12,
      visible: 12,
      complete: true,
    });
    const snapshot = await ready;
    expect(snapshot.status).toBe('ready');
    expect(snapshot.render.completedRevision).toBe(revision);
    expect(snapshot.render.layers.cluster).toMatchObject({
      requested: true,
      expected: 12,
      processed: 12,
      complete: true,
    });
  });

  test('ignores stale asynchronous layer reports from older render revisions', async () => {
    const { lifecycle, reporter } = loadLifecycle();
    const staleRevision = beginClusterRender(reporter);
    const currentRevision = beginClusterRender(reporter, { viewport: 7 });

    reporter.reportLayer(staleRevision, 'cluster', {
      processed: 12,
      complete: true,
    });
    reporter.finishRender(currentRevision);
    expect(lifecycle.getSnapshot().status).toBe('rendering');
    expect(lifecycle.getSnapshot().render.layers.cluster.complete).toBe(false);

    reporter.reportLayer(currentRevision, 'cluster', {
      expected: 7,
      processed: 7,
      visible: 7,
      complete: true,
    });
    await expect(lifecycle.whenReady({ layers: ['cluster'], minViewport: 1 }))
      .resolves.toMatchObject({ status: 'ready' });
  });

  test('only an explicitly primary map context advances global diagnostics', () => {
    const { win, lifecycle } = loadLifecycle();
    loadMapModule(win);
    win.UA.refreshContextOverlayZOrder = jest.fn();

    const makeCtx = (city, lifecyclePrimary) => ({
      CITY_RAW: city,
      lifecyclePrimary,
      map: { getZoom: () => 12 },
      allPts: [{ lat: 50.7, lon: 7.1, props: {} }],
      filteredAll: [{ lat: 50.7, lon: 7.1, props: {} }],
      filteredCapped: [{ lat: 50.7, lon: 7.1, props: {} }],
      viewportPts: [{ lat: 50.7, lon: 7.1, props: {} }],
      accidentDataCoverage: { mode: 'full-city', complete: true },
      showCluster: false,
      showHeatmap: false,
      showOnlyAboveAverage: false,
      showSchools: false,
      showKindergartens: false,
      showArgumentation: false,
      ui: { statEl: { textContent: '' } },
      _dataChanged: true,
    });

    win.UA.renderLayers(makeCtx('Bonn', true));
    const primarySnapshot = lifecycle.getSnapshot();
    expect(primarySnapshot).toMatchObject({
      status: 'ready',
      city: 'Bonn',
      counts: { loaded: 1, filtered: 1, viewport: 1 },
    });

    win.UA.renderLayers(makeCtx('Preview', false));
    expect(lifecycle.getSnapshot()).toBe(primarySnapshot);
  });

  test('criteria fail closed for incomplete coverage and insufficient counts', async () => {
    const { lifecycle, reporter } = loadLifecycle();
    const revision = beginClusterRender(reporter, {
      loaded: 1,
      filtered: 0,
      viewport: 0,
      coverage: { mode: 'viewport-partial', complete: false },
      layers: { cluster: { requested: true, expected: 0, processed: 0, complete: true } },
    });
    reporter.finishRender(revision);

    await expect(lifecycle.whenReady({
      minLoaded: 1,
      minFiltered: 1,
      minViewport: 1,
      requireCompleteCoverage: true,
      layers: ['cluster'],
    }, { timeoutMs: 10 })).rejects.toThrow('did not become ready');
  });

  test('an explicitly expected layer must contain visible output', async () => {
    const { lifecycle, reporter } = loadLifecycle();
    const revision = reporter.beginRender({
      city: 'Bonn',
      loaded: 100,
      filtered: 40,
      viewport: 12,
      coverage: { mode: 'full-city', complete: true },
      layers: {
        poi: {
          requested: true,
          expected: 25,
          processed: 0,
          visible: 0,
          complete: true,
        },
      },
    });
    reporter.finishRender(revision);

    await expect(lifecycle.whenReady({
      minLoaded: 1,
      minFiltered: 1,
      minViewport: 1,
      requireCompleteCoverage: true,
      layers: ['poi'],
    }, { timeoutMs: 10 })).rejects.toThrow('did not become ready');
  });

  test('propagates lifecycle failures to current and future waiters', async () => {
    const { lifecycle, reporter } = loadLifecycle();
    reporter.beginLoad('Bonn');
    const pending = lifecycle.whenReady({ minLoaded: 1 }, { timeoutMs: 1000 });
    reporter.fail(new Error('GeoJSON failed'));

    await expect(pending).rejects.toThrow('GeoJSON failed');
    await expect(lifecycle.whenReady()).rejects.toThrow('GeoJSON failed');
    expect(lifecycle.getSnapshot()).toMatchObject({ status: 'error', error: 'GeoJSON failed' });
  });
});
