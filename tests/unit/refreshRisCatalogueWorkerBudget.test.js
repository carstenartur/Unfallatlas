/** @jest-environment node */
'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

jest.mock('node:worker_threads', () => ({ isMainThread: true, Worker: jest.fn() }));
const { Worker } = require('node:worker_threads');
const { refreshRisCatalogues } = require('../../scripts/refresh-ris-catalogues');

const NOW = new Date('2026-11-07T10:00:00.000Z');
const MINUTE = 60_000;

test.each([
  { total: 65 * MINUTE, source: 47 * MINUTE, worker: 49 * MINUTE },
  { total: undefined, source: undefined, worker: 60 * MINUTE },
])('bounds the worker after an eleven-minute restore (overall budget $total)', async limits => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-worker-budget-'));
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'] });
  const worker = new EventEmitter();
  worker.terminate = jest.fn(async () => {});
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  Worker.mockReset().mockImplementation((_filename, { workerData }) => {
    ready(workerData);
    return worker;
  });
  let operation;
  try {
    operation = refreshRisCatalogues({ directory, cities: ['hannover'], now: NOW, maxRefreshDurationMs: limits.total,
      fetchPublished: async () => {
        jest.advanceTimersByTime(11 * MINUTE);
        return new Response(null, { status: 404 });
      },
    });
    const workerData = await started;
    expect(Worker).toHaveBeenCalledTimes(1);
    expect(workerData.now).toBe(NOW.toISOString());
    expect(workerData.options.maxDurationMs).toBe(limits.source);
    jest.advanceTimersByTime(limits.worker - 1);
    await Promise.resolve();
    expect(worker.terminate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await expect(operation).resolves.toMatchObject([{ city: 'hannover', status: 'unavailable',
      reason: expect.stringMatching(/Source crawl exceeded/) }]);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  } finally {
    if (!worker.terminate.mock.calls.length && worker.listenerCount('error')) worker.emit('error', new Error('End worker test'));
    if (operation) await operation;
    jest.useRealTimers();
    await fs.rm(directory, { force: true, recursive: true });
  }
});
