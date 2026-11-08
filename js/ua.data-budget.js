(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) (root.UA = root.UA || {}).DataBudget = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  function abortError() {
    const error = new Error('Data request aborted');
    error.name = 'AbortError';
    return error;
  }

  function createScheduler(maxConcurrent = 6) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new RangeError('Invalid request concurrency');
    const queue = [];
    let active = 0;
    function drain() {
      while (active < maxConcurrent && queue.length) {
        const item = queue.shift();
        item.signal?.removeEventListener('abort', item.abort);
        if (item.signal?.aborted) { item.reject(abortError()); continue; }
        active++;
        Promise.resolve().then(item.task).then(value => {
          active--; drain(); item.resolve(value);
        }, error => {
          active--; drain(); item.reject(error);
        });
      }
    }
    function run(task, { signal } = {}) {
      if (signal?.aborted) return Promise.reject(abortError());
      return new Promise((resolve, reject) => {
        const item = { task, signal, resolve, reject };
        item.abort = () => {
          const index = queue.indexOf(item);
          if (index < 0) return;
          queue.splice(index, 1);
          signal.removeEventListener('abort', item.abort);
          reject(abortError());
        };
        signal?.addEventListener('abort', item.abort, { once: true });
        queue.push(item);
        drain();
      });
    }
    return { run, stats: () => ({ active, queued: queue.length, maxConcurrent }) };
  }

  async function mapLimit(items, limit, mapper) {
    const scheduler = createScheduler(limit);
    return Promise.all(items.map((item, index) => scheduler.run(() => mapper(item, index))));
  }

  // Values may be parsed objects; the accounting unit is decoded source bytes.
  // A separate entry cap bounds metadata overhead, including zero-byte entries.
  function createByteCache(maxBytes, { maxEntries = 2048 } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !(maxEntries > 0)) throw new RangeError('Invalid cache budget');
    const entries = new Map();
    let bytes = 0;
    function remove(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      bytes -= entry.bytes;
      return entries.delete(key);
    }
    function get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      entries.delete(key); entries.set(key, entry);
      return entry.value;
    }
    function set(key, value, decodedBytes) {
      if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 0) throw new RangeError('Invalid decoded byte size');
      remove(key);
      if (decodedBytes > maxBytes) return false;
      while (entries.size && (bytes + decodedBytes > maxBytes || entries.size >= maxEntries)) {
        remove(entries.keys().next().value);
      }
      entries.set(key, { value, bytes: decodedBytes });
      bytes += decodedBytes;
      return true;
    }
    return { get, set, has: key => entries.has(key), delete: remove,
      clear() { entries.clear(); bytes = 0; },
      stats: () => ({ bytes, entries: entries.size, maxBytes }) };
  }

  return Object.freeze({ createScheduler, mapLimit, createByteCache });
});
