/** @jest-environment node */
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { gunzipSync } = require('node:zlib');
const { writeRisSnapshot, readRisSnapshot, enumerateSnapshotAssets } = require('../../server/political-context/services/risSnapshot');
const P = require('../../js/ua.ris-partitions');
const service = () => require('../../server/political-context/services/risProvenance');
const sourceProjectionFingerprint = (...args) => service().sourceProjectionFingerprint(...args);
const collectionProvenance = (...args) => service().collectionProvenance(...args);
const verified = '2026-11-07T09:00:00.000Z';
const built = '2026-11-08T10:00:00.000Z';
const row = { id: 'one', title: 'Schulweg', type: 'Antrag', number: null, date: '2026-11-01', gremium: null,
  source: 'RIS', url: 'https://example.org/ris/one' };
const coverage = { from: '2026-01-01', to: '2026-11-07', bodies: ['Rat'], complete: false, warnings: [] };
const input = () => ({ records: [row], sources: ['https://example.org/ris/'], generatedAt: verified, coverage });
const provenance = () => ({ schemaVersion: 1, producer: { name: 'unfallwerkbank-ris', version: 'ris-provenance-v1' },
  builtAt: built, sourceVerifiedAt: verified, provider: 'test-ris', normalizationRevision: 'test-v1',
  sourceFingerprint: { algorithm: 'sha256', kind: 'provider-projection-v1', sha256: 'a'.repeat(64) },
  collection: { pages: null, rawItems: null, normalizedItems: 1, requestedFrom: null, requestedTo: null,
    limits: { maxPages: null, pageSize: null, maxDocuments: null, workBudget: null, maxDurationMs: null },
    continuation: { pending: null, interrupted: null, pendingYears: [], reason: null } },
  rights: { status: 'not-specified', license: null, attribution: [] },
  distribution: { compression: 'gzip', assetCount: 7, compressedBytes: 100, uncompressedBytes: 1000 } });
let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-provenance-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

test.each([1, 2])('round-trips optional provenance and accounts every unique asset for schema %i', async schemaVersion => {
  const m = await writeRisSnapshot(dir, 'test', { ...input(), provenance: provenance() }, { now: new Date(built), schemaVersion });
  const refs = await enumerateSnapshotAssets(dir, m);
  const unique = [...new Map(refs.map(ref => [ref.path, ref])).values()];
  let compressedBytes = 0, uncompressedBytes = 0;
  for (const ref of unique) { const b = await fs.readFile(path.join(dir, ref.path)); compressedBytes += b.length; uncompressedBytes += gunzipSync(b).length; }
  expect(m.provenance).toMatchObject({ builtAt: built, sourceVerifiedAt: verified, collection: { normalizedItems: 1, rawItems: null },
    distribution: { compression: 'gzip', assetCount: unique.length, compressedBytes, uncompressedBytes } });
  expect((await readRisSnapshot(dir, 'test')).manifest.provenance).toEqual(m.provenance);
  expect(m.generatedAt).toBe(verified);
});

test('legacy snapshots stay without invented acquisition metadata', async () => {
  const m = await writeRisSnapshot(dir, 'test', input(), { now: new Date(built), schemaVersion: 2 });
  expect(m).not.toHaveProperty('provenance');
  expect((await readRisSnapshot(dir, 'test')).manifest).not.toHaveProperty('provenance');
});

test('build clock and provenance do not change immutable content generation', async () => {
  const a = await writeRisSnapshot(dir, 'test', { ...input(), provenance: provenance() }, { now: new Date(built), schemaVersion: 2 });
  const b = await writeRisSnapshot(dir, 'test', { ...input(), provenance: provenance() }, { now: new Date('2026-11-09T10:00:00Z'), schemaVersion: 2 });
  expect(b.generation).toBe(a.generation);
  expect(b.provenance.builtAt).toBe('2026-11-09T10:00:00.000Z');
  expect(b.provenance.sourceVerifiedAt).toBe(verified);
});

test('projection digest ignores row/key order, enrichment and cache clocks but binds provider content', () => {
  const other = { ...row, id: 'two', title: 'Querung' };
  const a = sourceProjectionFingerprint([row, other]);
  const reordered = Object.fromEntries(Object.entries(row).reverse());
  expect(sourceProjectionFingerprint([other, { ...reordered, locations: [{ geometry: 'derived' }], detailVerifiedAt: built, cache: 'hit', locationEvidenceUnavailable: true }])).toEqual(a);
  expect(sourceProjectionFingerprint([{ ...row, title: 'Geänderter Schulweg' }, other])).not.toEqual(a);
  expect(sourceProjectionFingerprint([{ ...row, locationEvidence: ['Amtlicher Text'] }, other])).not.toEqual(a);
});

test('fresh collection retains reliable page counters without claiming projected items are raw input', () => {
  const value = collectionProvenance({ catalogue: { ...input(), cache: { pages: 12, items: 4 } }, city: 'bonn',
    records: [row], sourceRecords: [row], sourceVerifiedAt: verified, now: new Date(built), sourceOptions: { workBudget: 0 } });
  expect(value.collection).toMatchObject({ pages: 12, rawItems: null, normalizedItems: 1, requestedFrom: null, requestedTo: null,
    limits: { workBudget: 0 } });
  expect(value.rights).toEqual({ status: 'not-specified', license: null, attribution: [] });
});

test('a combined Hannover catalogue declares both providers even when regional evidence was retained', () => {
  const sourceRecords = [{ ...row, source: 'hannover-sim' }, { ...row, id: 'region:one', source: 'region-hannover-ris' }];
  const value = collectionProvenance({ catalogue: input(), city: 'hannover', records: sourceRecords, sourceRecords,
    sourceVerifiedAt: verified, now: new Date(built) });
  expect(value.provider).toBe('hannover-official-sources');
  expect(value.normalizationRevision).toBe('hannover-multi-source-citation-v1');
  expect(value.sourceFingerprint).toEqual(sourceProjectionFingerprint(sourceRecords));
});

test('server and browser share strict bounded provenance validation', async () => {
  const context = { window: { UA: {} } };
  vm.runInNewContext(await fs.readFile(path.resolve(__dirname, '../../js/ua.ris-partitions.js'), 'utf8'), context);
  const browser = context.window.UA.RisPartitions;
  const valid = provenance();
  expect(P.validProvenance(valid, verified, 1, coverage)).toBe(true);
  expect(browser.validProvenance(valid, verified, 1, coverage)).toBe(true);
  const mutations = [
    p => { p.schemaVersion = 2; }, p => { p.sourceVerifiedAt = built; }, p => { p.builtAt = '2026-11-01T00:00:00.000Z'; },
    p => { p.collection.rawItems = Infinity; }, p => { p.collection.normalizedItems = 2; }, p => { p.collection.limits.workBudget = -1; },
    p => { p.collection.continuation.pendingYears = Array(201).fill(2026); }, p => { p.collection.continuation.reason = '/secret/checkpoint'; },
    p => { p.collection.continuation.pending = true; }, p => { p.rights.license = 'invented'; },
    p => { p.sourceFingerprint.sha256 = 'z'.repeat(64); }, p => { p.producer.version = 'x'.repeat(257); },
    p => { p.distribution.compressedBytes = Number.MAX_SAFE_INTEGER + 1; }, p => { p.cookie = 'private'; },
  ];
  for (const mutate of mutations) {
    const p = structuredClone(valid); mutate(p);
    // Pending work contradicts complete coverage, but remains valid for partial coverage.
    const scope = mutate === mutations[8] ? { ...coverage, complete: true } : coverage;
    expect(P.validProvenance(p, verified, 1, scope)).toBe(false);
    expect(browser.validProvenance(p, verified, 1, scope)).toBe(false);
  }
});

test.each([1, 2])('present malformed metadata fails closed in server and browser manifest readers for schema %i', async schemaVersion => {
  const m = await writeRisSnapshot(dir, 'test', { ...input(), provenance: provenance() }, { now: new Date(built), schemaVersion });
  m.provenance.schemaVersion = 99;
  await fs.writeFile(path.join(dir, 'test.json'), JSON.stringify(m));
  await expect(readRisSnapshot(dir, 'test')).rejects.toThrow(/provenance/i);
  const c = require('../../js/ua.ris-catalogue').createCatalogue({ base: 'https://example.org/', now: () => new Date(built),
    fetch: async url => new Response(await fs.readFile(path.join(dir, new URL(url).pathname.split('/').pop()))) });
  await expect(c.loadManifest('test')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('distribution totals bind existing addressed gzip bytes and reject tampered size claims', async () => {
  const initial = await writeRisSnapshot(dir, 'test', input(), { now: new Date(built), schemaVersion: 2 });
  const ref = initial.roots.records;
  const filename = path.join(dir, ref.path);
  const raw = gunzipSync(await fs.readFile(filename));
  // Existing immutable assets may have equivalent decoded bytes compressed by
  // another zlib version/level. Accounting describes the served archive.
  await fs.writeFile(filename, require('node:zlib').gzipSync(raw, { level: 0 }));
  const m = await writeRisSnapshot(dir, 'test', { ...input(), provenance: provenance() }, { now: new Date(built), schemaVersion: 2 });
  await expect(readRisSnapshot(dir, 'test')).resolves.toHaveProperty('manifest.provenance.distribution', m.provenance.distribution);
  m.provenance.distribution.compressedBytes++;
  await fs.writeFile(path.join(dir, 'test.json'), JSON.stringify(m));
  await expect(readRisSnapshot(dir, 'test')).rejects.toThrow(/distribution/);
  await expect(enumerateSnapshotAssets(dir, m)).rejects.toThrow(/distribution/);
});
