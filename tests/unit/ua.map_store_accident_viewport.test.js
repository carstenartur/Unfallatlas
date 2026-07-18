'use strict';

const fs = require('fs');
const path = require('path');

function load(file, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js', file), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

function makeUA() {
  const win = {
    UA: {},
    requestAnimationFrame: callback => setTimeout(callback, 0),
    cancelAnimationFrame: id => clearTimeout(id),
  };
  load('ua.render_scheduler.js', win);
  load('ua.map_store.js', win);
  return win.UA;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('MapStore viewport accident lifecycle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  function context(mode = 'viewport') {
    return {
      accidentDataMode: mode,
      accidentViewportController: { invalidate: jest.fn() },
      allPts: [{ lat: 50.73, lon: 7.1, props: {} }],
      filteredAll: [],
      filteredCapped: [],
      viewportPts: [],
    };
  }

  function installRenderSpies(UA) {
    UA.applyFilters = jest.fn();
    UA.applyViewportFilter = jest.fn();
    UA.renderLayers = jest.fn();
    UA.syncViewToUrl = jest.fn();
    UA.saveCityState = jest.fn();
  }

  test('invalidates an in-flight tile request immediately when the viewport changes', () => {
    const UA = makeUA();
    installRenderSpies(UA);
    UA.requestAccidentViewport = jest.fn();
    const ctx = context();
    const store = UA.MapStore.create(ctx);

    store.dispatch('viewportChanged', { debounceMs: 350 });

    expect(ctx.accidentViewportController.invalidate).toHaveBeenCalledTimes(1);
    expect(UA.requestAccidentViewport).not.toHaveBeenCalled();
  });

  test('only the latest scheduler epoch may commit asynchronous tile data', async () => {
    const UA = makeUA();
    installRenderSpies(UA);
    const first = deferred();
    const second = deferred();
    UA.requestAccidentViewport = jest.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    UA.commitAccidentViewportResult = jest.fn(() => true);
    const ctx = context();
    const store = UA.MapStore.create(ctx);

    store.dispatch('viewportChanged', { debounceMs: 0 });
    jest.runOnlyPendingTimers();
    expect(UA.requestAccidentViewport).toHaveBeenCalledTimes(1);

    store.dispatch('viewportChanged', { debounceMs: 0 });
    jest.runOnlyPendingTimers();
    expect(UA.requestAccidentViewport).toHaveBeenCalledTimes(2);

    first.resolve({ committed: true, epoch: 1, marker: 'old' });
    await flushPromises();
    expect(UA.commitAccidentViewportResult).not.toHaveBeenCalled();

    const current = { committed: true, epoch: 2, marker: 'current' };
    second.resolve(current);
    await flushPromises();

    expect(UA.commitAccidentViewportResult).toHaveBeenCalledTimes(1);
    expect(UA.commitAccidentViewportResult).toHaveBeenCalledWith(ctx, current);
    expect(UA.applyFilters).toHaveBeenCalledTimes(1);
    expect(UA.applyViewportFilter).toHaveBeenCalledTimes(1);
    expect(UA.renderLayers).toHaveBeenCalledTimes(1);
    expect(UA.syncViewToUrl).toHaveBeenCalledTimes(1);
  });

  test('a current result that changes only coverage does not rerun global filters', async () => {
    const UA = makeUA();
    installRenderSpies(UA);
    UA.requestAccidentViewport = jest.fn(async () => ({ committed: true }));
    UA.commitAccidentViewportResult = jest.fn(() => false);
    const ctx = context();
    const store = UA.MapStore.create(ctx);

    store.dispatch('viewportChanged', { debounceMs: 0 });
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(UA.applyFilters).not.toHaveBeenCalled();
    expect(UA.applyViewportFilter).toHaveBeenCalledTimes(1);
    expect(UA.renderLayers).toHaveBeenCalledTimes(1);
  });

  test('full-city mode never asks the tiled provider during pan or zoom', async () => {
    const UA = makeUA();
    installRenderSpies(UA);
    UA.requestAccidentViewport = jest.fn();
    UA.commitAccidentViewportResult = jest.fn();
    const ctx = context('full');
    const store = UA.MapStore.create(ctx);

    store.dispatch('viewportChanged', { debounceMs: 0 });
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(ctx.accidentViewportController.invalidate).not.toHaveBeenCalled();
    expect(UA.requestAccidentViewport).not.toHaveBeenCalled();
    expect(UA.commitAccidentViewportResult).not.toHaveBeenCalled();
    expect(UA.applyViewportFilter).toHaveBeenCalledTimes(1);
    expect(UA.renderLayers).toHaveBeenCalledTimes(1);
  });

  test('cancelPending invalidates both scheduler and viewport controller epochs', () => {
    const UA = makeUA();
    installRenderSpies(UA);
    const ctx = context();
    const store = UA.MapStore.create(ctx);

    store.dispatch('viewportChanged', { debounceMs: 100 });
    store.cancelPending();
    jest.advanceTimersByTime(200);

    expect(ctx.accidentViewportController.invalidate).toHaveBeenCalledTimes(2);
    expect(UA.renderLayers).not.toHaveBeenCalled();
  });
});
