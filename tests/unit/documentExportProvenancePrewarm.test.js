'use strict';

function makeContext() {
  return {
    CITY_RAW: 'Bonn',
    allPts: [{ lat: 50.73, lon: 7.10, props: { year: '2024' } }],
    dataRetrievedAt: '2026-07-22T12:00:00Z',
    selectionBounds: {
      getSouth: () => 50.70,
      getWest: () => 7.05,
      getNorth: () => 50.76,
      getEast: () => 7.15,
    },
    involvementMode: 'or',
    contextFilters: {
      slopeClasses: new Set(['steep']),
      trafficClasses: new Set(['high']),
      onlyMatchedWays: true,
    },
    ui: {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      dayTypeEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
    },
  };
}

function setup(options = {}) {
  jest.resetModules();
  document.body.innerHTML = '<button id="btnOpenExport" type="button">Export</button>';

  const ctx = options.ctx || makeContext();
  const snapshots = options.snapshots || [{ manifest: { artifactId: 'snapshot-1' } }];
  const createSnapshot = options.createSnapshot || jest.fn(async () => snapshots.shift());
  const word = options.word || jest.fn(async current => ({
    format: 'word',
    manifestDuringRender: current && current.exportSourceManifest,
  }));
  const pdf = options.pdf || jest.fn(async current => ({
    format: 'pdf',
    manifestDuringRender: current && current.exportSourceManifest,
  }));

  window.UA = {
    documentExportProvenanceRuntime: { createSnapshot },
    exportToWord: word,
    exportToPDF: pdf,
    getRuntimeContext: () => ctx,
    exportProvenance: {
      boundsObject: current => ({
        south: current.selectionBounds.getSouth(),
        west: current.selectionBounds.getWest(),
        north: current.selectionBounds.getNorth(),
        east: current.selectionBounds.getEast(),
      }),
      scenarioFilters: current => ({
        severity: current.ui.severityEl.value,
        roadCondition: current.ui.roadConditionEl.value,
        dayType: current.ui.dayTypeEl.value,
        hourFrom: Number(current.ui.hFromEl.value),
        hourTo: Number(current.ui.hToEl.value),
        involvementMode: current.involvementMode,
        contextSlopeClasses: Array.from(current.contextFilters.slopeClasses).sort(),
        contextTrafficClasses: Array.from(current.contextFilters.trafficClasses).sort(),
        onlyMatchedWays: current.contextFilters.onlyMatchedWays === true,
      }),
    },
  };

  const api = require('../../js/ua.document_export_prewarm');
  return {
    api,
    ctx,
    createSnapshot,
    word,
    pdf,
    runtime: window.UA.documentExportPrewarmRuntime,
  };
}

describe('document export provenance prewarm', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete window.UA;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  test('reuses one unchanged snapshot for prewarm and the later PDF export', async () => {
    const snapshot = { manifest: { artifactId: 'prewarmed-bonn' } };
    const { ctx, runtime, createSnapshot, pdf } = setup({ snapshots: [snapshot] });

    await expect(runtime.prewarm(ctx)).resolves.toBe(snapshot);
    const result = await window.UA.exportToPDF(ctx, { includeMap: true });

    expect(createSnapshot).toHaveBeenCalledTimes(1);
    expect(pdf).toHaveBeenCalledTimes(1);
    expect(result.manifestDuringRender).toBe(snapshot.manifest);
    expect(Object.prototype.hasOwnProperty.call(ctx, 'exportSourceManifest')).toBe(false);
  });

  test('unchanged repeated prewarms share the same in-flight promise', async () => {
    let resolveSnapshot;
    const createSnapshot = jest.fn(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    const { ctx, runtime } = setup({ createSnapshot });

    const first = runtime.prewarm(ctx);
    const second = runtime.prewarm(ctx);

    expect(second).toBe(first);
    expect(createSnapshot).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(createSnapshot).toHaveBeenCalledTimes(1);
    const snapshot = { manifest: { artifactId: 'shared' } };
    resolveSnapshot(snapshot);
    await expect(first).resolves.toBe(snapshot);
    await expect(second).resolves.toBe(snapshot);
  });

  test('filter changes invalidate the cached snapshot', async () => {
    const first = { manifest: { artifactId: 'severity-all' } };
    const second = { manifest: { artifactId: 'severity-fatal' } };
    const { ctx, runtime, createSnapshot } = setup({ snapshots: [first, second] });

    await expect(runtime.prewarm(ctx)).resolves.toBe(first);
    ctx.ui.severityEl.value = '1';
    await expect(runtime.prewarm(ctx)).resolves.toBe(second);

    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });

  test('a state change during calculation discards the stale result and recalculates', async () => {
    let resolveFirst;
    const stale = { manifest: { artifactId: 'stale' } };
    const current = { manifest: { artifactId: 'current' } };
    const createSnapshot = jest.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(current);
    const { ctx, runtime } = setup({ createSnapshot });

    const resultPromise = runtime.prewarm(ctx);
    await Promise.resolve();
    ctx.contextFilters.trafficClasses.add('very_high');
    resolveFirst(stale);

    await expect(resultPromise).resolves.toBe(current);
    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });

  test('failed prewarm is evicted so a later attempt can succeed', async () => {
    const recovered = { manifest: { artifactId: 'recovered' } };
    const createSnapshot = jest.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(recovered);
    const { ctx, runtime } = setup({ createSnapshot });

    await expect(runtime.prewarm(ctx)).rejects.toThrow('temporary failure');
    await expect(runtime.prewarm(ctx)).resolves.toBe(recovered);
    expect(createSnapshot).toHaveBeenCalledTimes(2);
  });

  test('an explicit caller-supplied manifest is preserved and bypasses prewarm', async () => {
    const explicit = { artifactId: 'caller-owned' };
    const ctx = makeContext();
    ctx.exportSourceManifest = explicit;
    const { createSnapshot, pdf } = setup({ ctx });

    const result = await window.UA.exportToPDF(ctx);

    expect(createSnapshot).not.toHaveBeenCalled();
    expect(pdf).toHaveBeenCalledTimes(1);
    expect(result.manifestDuringRender).toBe(explicit);
    expect(ctx.exportSourceManifest).toBe(explicit);
  });

  test('temporary manifest is removed even when the wrapped renderer fails', async () => {
    const snapshot = { manifest: { artifactId: 'failure-snapshot' } };
    const pdf = jest.fn(async current => {
      expect(current.exportSourceManifest).toBe(snapshot.manifest);
      throw new Error('renderer failed');
    });
    const { ctx } = setup({ snapshots: [snapshot], pdf });

    await expect(window.UA.exportToPDF(ctx)).rejects.toThrow('renderer failed');
    expect(Object.prototype.hasOwnProperty.call(ctx, 'exportSourceManifest')).toBe(false);
  });

  test('opening the export dialog starts prewarming the runtime context', async () => {
    const snapshot = { manifest: { artifactId: 'dialog-prewarm' } };
    const { createSnapshot } = setup({ snapshots: [snapshot] });

    document.getElementById('btnOpenExport').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(createSnapshot).toHaveBeenCalledTimes(1);
  });
});
