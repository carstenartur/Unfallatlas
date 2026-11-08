/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRisSourceCache } = require('../../server/political-context/services/risSourceCache');
const unicode = require('../../scripts/check-hidden-unicode');

const KEY = 'https://example.org/public/paper/123';
const REVISION = '2026-11-08';
const PAYLOAD = { id: '123', title: 'Öffentliche Drucksache', text: 'Ein öffentlicher Maßnahmentext.' };
const unexpectedLoad = () => { throw new Error('A valid cache entry must not reload the source'); };
let root;
let directory;
let time;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ua-ris-source-'));
  directory = path.join(root, 'cache');
  time = Date.parse('2026-11-08T10:00:00Z');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function cache(options = {}) {
  return createRisSourceCache({ directory, now: () => time, ...options });
}

async function cacheFile() {
  const names = await fs.readdir(directory);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  return path.join(directory, names[0]);
}

async function cacheFiles() {
  try { return await fs.readdir(directory); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

test('resumes from a completed source response in a fresh cache instance', async () => {
  const first = cache();
  await expect(first.getOrLoad(KEY, REVISION, async () => PAYLOAD)).resolves.toEqual(PAYLOAD);
  expect(first.stats).toEqual({ hits: 0, misses: 1, writes: 1 });

  const resumed = cache();
  await expect(resumed.getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(PAYLOAD);
  expect(resumed.stats).toEqual({ hits: 1, misses: 0, writes: 0 });
  await cacheFile();
});

test('exposes original verification metadata from existing envelopes without changing payload-only callers', async () => {
  const verifiedAt = time;
  await cache().getOrLoad(KEY, REVISION, () => PAYLOAD);
  const filename = await cacheFile();
  const before = await fs.readFile(filename, 'utf8');
  time += 6 * 86400000;
  const resumed = cache();
  await expect(resumed.getOrLoadWithMetadata(KEY, REVISION, unexpectedLoad))
    .resolves.toEqual({ payload: PAYLOAD, cachedAt: verifiedAt });
  await expect(resumed.getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(PAYLOAD);
  expect(await fs.readFile(filename, 'utf8')).toBe(before);
  expect(resumed.stats).toEqual({ hits: 2, misses: 0, writes: 0 });
});

test('reads an expired envelope clock without renewing or exposing its payload', async () => {
  const verifiedAt = time;
  await cache().getOrLoad(KEY, REVISION, () => PAYLOAD);
  const filename = await cacheFile();
  const before = await fs.readFile(filename, 'utf8');
  time += 19 * 86400000;
  const source = cache();
  await expect(source.getMetadata(KEY, REVISION)).resolves.toEqual({ cachedAt: verifiedAt });
  expect(source.stats).toEqual({ hits: 0, misses: 0, writes: 0 });
  expect(await fs.readFile(filename, 'utf8')).toBe(before);
  await expect(source.getOrLoad(KEY, REVISION, () => { throw new Error('Expired payload requires a source read'); }))
    .rejects.toThrow('Expired payload requires a source read');
  expect(await fs.readFile(filename, 'utf8')).toBe(before);
});

test.each(['key', 'revision', 'schema', 'future', 'oversized', 'symlink'])('rejects unsafe or mismatched metadata: %s', async fault => {
  await cache().getOrLoad(KEY, REVISION, () => PAYLOAD);
  const filename = await cacheFile();
  const entry = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (fault === 'key') entry.key += '/other';
  if (fault === 'revision') entry.revision = 'other';
  if (fault === 'schema') entry.schemaVersion = 2;
  if (fault === 'future') entry.cachedAt = time + 1;
  await fs.writeFile(filename, JSON.stringify(entry));
  if (fault === 'symlink') {
    const target = path.join(root, 'public-response.json');
    await fs.rename(filename, target);
    await fs.symlink(target, filename);
  }
  const source = cache(fault === 'oversized' ? { maxEntryBytes: 10 } : {});
  await expect(source.getMetadata(KEY, REVISION)).resolves.toBeNull();
  expect(source.stats).toEqual({ hits: 0, misses: 0, writes: 0 });
});

test('reloads a changed source revision and resumes its new response', async () => {
  const source = cache();
  await source.getOrLoad(KEY, REVISION, () => PAYLOAD);
  await source.getOrLoad(KEY, REVISION, unexpectedLoad);
  const changed = { ...PAYLOAD, title: 'Geänderte Drucksache' };

  await expect(source.getOrLoad(KEY, '2026-11-09', () => changed)).resolves.toEqual(changed);
  await expect(cache().getOrLoad(KEY, '2026-11-09', unexpectedLoad)).resolves.toEqual(changed);
  expect(source.stats).toEqual({ hits: 1, misses: 2, writes: 2 });
});

test('expires a cached response at its maximum age', async () => {
  const source = cache({ maxAgeMs: 100 });
  await source.getOrLoad(KEY, REVISION, () => PAYLOAD);
  time += 99;
  await expect(source.getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(PAYLOAD);
  time += 1;
  const refreshed = { ...PAYLOAD, text: 'Erneut geprüft.' };
  await expect(source.getOrLoad(KEY, REVISION, () => refreshed)).resolves.toEqual(refreshed);
  await expect(source.getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(refreshed);
  expect(source.stats).toEqual({ hits: 2, misses: 2, writes: 2 });
});

test('replaces a corrupt cache file with a newly verified source response', async () => {
  await cache().getOrLoad(KEY, REVISION, () => PAYLOAD);
  const filename = await cacheFile();
  await fs.writeFile(filename, '{unfinished');

  const resumed = cache();
  const repaired = { ...PAYLOAD, text: 'Erneut geladen.' };
  await expect(resumed.getOrLoad(KEY, REVISION, () => repaired)).resolves.toEqual(repaired);
  await expect(cache().getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(repaired);
  expect(resumed.stats).toEqual({ hits: 0, misses: 1, writes: 1 });
});

test.each([
  ['schema', entry => { entry.schemaVersion = 99; }],
  ['source key', entry => { entry.key = 'https://example.org/a-different-source'; }],
  ['revision', entry => { entry.revision = 'a-different-revision'; }],
  ['timestamp type', entry => { entry.cachedAt = 'yesterday'; }],
  ['future timestamp', entry => { entry.cachedAt = time + 1; }],
  ['missing payload', entry => { delete entry.payload; }],
])('rejects a cache entry with an invalid %s', async (_label, change) => {
  await cache().getOrLoad(KEY, REVISION, () => PAYLOAD);
  const filename = await cacheFile();
  const entry = JSON.parse(await fs.readFile(filename, 'utf8'));
  change(entry);
  await fs.writeFile(filename, JSON.stringify(entry));

  const resumed = cache();
  const repaired = { id: 'newly-loaded' };
  await expect(resumed.getOrLoad(KEY, REVISION, () => repaired)).resolves.toEqual(repaired);
  expect(resumed.stats).toEqual({ hits: 0, misses: 1, writes: 1 });
});

test('retries failed loaders without recording the failure as a cache hit', async () => {
  const source = cache();
  await expect(source.getOrLoad(KEY, REVISION, async () => {
    throw new Error('Temporary source outage');
  })).rejects.toThrow('Temporary source outage');
  expect(await cacheFiles()).toEqual([]);
  expect(source.stats).toEqual({ hits: 0, misses: 1, writes: 0 });

  await expect(source.getOrLoad(KEY, REVISION, () => PAYLOAD)).resolves.toEqual(PAYLOAD);
  await expect(cache().getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(PAYLOAD);
  expect(source.stats).toEqual({ hits: 0, misses: 2, writes: 1 });
});

test('deduplicates concurrent requests for the same source and revision', async () => {
  const source = cache();
  let calls = 0;
  let release;
  let started;
  const loading = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const loader = () => { calls += 1; started(); return response; };
  const requests = Array.from({ length: 5 }, () => source.getOrLoad(KEY, REVISION, loader));

  await loading;
  release(PAYLOAD);
  await expect(Promise.all(requests)).resolves.toEqual(Array(5).fill(PAYLOAD));
  expect(calls).toBe(1);
  expect(source.stats).toEqual({ hits: 0, misses: 1, writes: 1 });
  await cacheFile();
});

test('keeps source keys and revisions inside hashed cache filenames', async () => {
  const source = cache();
  const key = '../escaped.json';
  const revision = '../../another-escaped.json';
  await expect(source.getOrLoad(key, revision, () => PAYLOAD)).resolves.toEqual(PAYLOAD);
  expect(await fs.readdir(root)).toEqual(['cache']);
  await cacheFile();
  await expect(cache().getOrLoad(key, revision, unexpectedLoad)).resolves.toEqual(PAYLOAD);
});

test('treats an oversized cache file as a miss before loading it into JSON', async () => {
  await cache().getOrLoad(KEY, REVISION, () => PAYLOAD);
  const filename = await cacheFile();
  await fs.writeFile(filename, JSON.stringify({ payload: 'x'.repeat(4096) }));
  const source = cache({ maxEntryBytes: 1024 });
  await expect(source.getOrLoad(KEY, REVISION, () => PAYLOAD)).resolves.toEqual(PAYLOAD);
  expect(source.stats).toEqual({ hits: 0, misses: 1, writes: 1 });
  await expect(cache().getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(PAYLOAD);
});

test.each([
  ['undefined', () => undefined],
  ['BigInt', () => ({ value: 1n })],
  ['circular data', () => { const value = {}; value.self = value; return value; }],
  ['oversized data', () => ({ text: 'x'.repeat(4096) })],
])('never installs %s as a successful cache entry', async (_label, loader) => {
  const source = cache({ maxEntryBytes: 1024 });
  await expect(source.getOrLoad(KEY, REVISION, loader)).rejects.toThrow();
  expect(await cacheFiles()).toEqual([]);
  expect(source.stats).toEqual({ hits: 0, misses: 1, writes: 0 });
  await expect(source.getOrLoad(KEY, REVISION, () => PAYLOAD)).resolves.toEqual(PAYLOAD);
});

test('leaves an earlier response intact when its refresh cannot be serialized', async () => {
  const source = cache({ maxAgeMs: 100 });
  await source.getOrLoad(KEY, REVISION, () => PAYLOAD);
  const filename = await cacheFile();
  const originalBytes = await fs.readFile(filename);
  time += 100;
  await expect(source.getOrLoad(KEY, REVISION, () => ({ invalid: 1n }))).rejects.toThrow();
  expect(await fs.readFile(filename)).toEqual(originalBytes);
  await cacheFile();
});

test('preserves public source Unicode without introducing hidden controls into the checkout', async () => {
  const payload = { text: 'Druck\u00adsache mit \u202e und \u200b sowie Straße 🚲' };
  await cache().getOrLoad(KEY, REVISION, () => payload);
  expect(unicode.scanRepository(root)).toEqual([]);
  await expect(cache().getOrLoad(KEY, REVISION, unexpectedLoad)).resolves.toEqual(payload);
});
