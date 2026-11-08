/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { readRisSnapshot, writeRisSnapshot: writeSnapshot } = require('../../server/political-context/services/risSnapshot');
const { refreshRisCatalogues, validateRisDirectory } = require('../../scripts/refresh-ris-catalogues');

const NOW = new Date('2026-11-07T10:00:00.000Z');
const OLD = new Date('2026-10-20T09:00:00.000Z');
const FRESH = new Date('2026-11-03T09:00:00.000Z');
const STALE = new Date('2026-10-28T09:00:00.000Z');
const FALLBACK = new Date('2026-10-31T09:00:00.000Z');
const EXPIRY = new Date('2026-11-14T09:00:00.000Z');
const SITE = 'https://carstenartur.github.io/Unfallatlas/data/ris/';
const OFFICIAL = {
  bonn: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers',
  hannover: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/Termine.xsp?view=TermineRat',
};

let root;
let directory;
let published;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-publication-test-'));
  directory = path.join(root, 'local');
  published = path.join(root, 'published');
});

afterEach(async () => fs.rm(root, { force: true, recursive: true }));

function writeRisSnapshot(folder, city, value, options) {
  return writeSnapshot(folder, city, value, { ...options, schemaVersion: value.locationRevision === 3 ? 2 : 1 });
}

function catalogue(city, { count = 2, from = city === 'hannover' ? '2014-01-01' : '2026-01-02', to = '2026-10-15', complete = city === 'bonn', body } = {}) {
  const gremium = body || (city === 'bonn' ? 'Bonn' : 'Ratsversammlung');
  return {
    locationRevision: 3,
    sources: [OFFICIAL[city]],
    coverage: { from, to, bodies: [gremium], complete, warnings: complete ? [] : ['Amtliche Auswahl.'],
      ...(city === 'hannover' ? { scope: 'citywide' } : {}) },
    records: Array.from({ length: count }, (_, i) => ({
      id: `${city}:${i + 1}`, title: `Radverkehr ${i + 1}`, number: `${i + 1}/2026`, type: 'Antrag',
      date: to, gremium, url: `${new URL(OFFICIAL[city]).origin}/paper/${i + 1}`, source: city,
      locationAssessment: { status: i === 0 ? 'mapped' : 'unresolved', sources: [i === 0 ? 'official' : 'title'],
        reasons: i === 0 ? [] : ['no_specific_location'], truncated: false },
      ...(i === 0 ? { geometry: { type: 'Point', coordinates: [9.73, 52.37] }, locationSource: 'official' } : {}),
    })),
  };
}

function legacyCatalogue(city, options) {
  const value = catalogue(city, options);
  value.locationRevision = 1;
  value.records.forEach(record => delete record.locationAssessment);
  return value;
}

function regionalCatalogue() {
  const value = catalogue('hannover');
  value.sources.push('https://ris.hannit.de/public/vo040');
  value.coverage.bodies.push('Regionsversammlung');
  value.records.push({ id: 'region-hannover-ris:vo:2003037', title: 'Radwege in Garbsen',
    number: value.records[0].number, type: 'Sonstige', date: '2023-08-24', gremium: 'Regionsversammlung',
    source: 'region-hannover-ris', url: 'https://ris.hannit.de/public/vo020?VOLFDNR=2003037&refresh=false' });
  value.history = { pending: false, interrupted: false, pendingYears: [] };
  value.sourceStatuses = [{ source: 'region-hannover-ris', status: 'partial', url: 'https://ris.hannit.de/public/vo040',
    retrievedAt: NOW.toISOString(), from: '2014-01-01', to: '2026-10-15', recordCount: 1, message: 'Öffentliche Vorlagen.' }];
  return value;
}

function fetchPages({ decoded = false, tamper } = {}) {
  return async (url, { redirect, credentials }) => {
    expect(url).toMatch(/^https:\/\/carstenartur\.github\.io\/Unfallatlas\/data\/ris\/[a-z0-9.]+$/);
    expect(redirect).toBe('error');
    expect(credentials).toBe('omit');
    const filename = url.slice(SITE.length);
    let bytes;
    try {
      bytes = await fs.readFile(path.join(published, filename));
    } catch (error) {
      if (error.code === 'ENOENT') return new Response(null, { status: 404 });
      throw error;
    }
    if (tamper === filename) return new Response('damaged');
    return new Response(decoded && filename.endsWith('.gz') ? gunzipSync(bytes) : bytes);
  };
}

function refresh(options) {
  return refreshRisCatalogues({ directory, now: NOW, fetchPublished: fetchPages(), ...options });
}

async function seedFallback(target) {
  const manifest = await writeRisSnapshot(target, 'bonn', catalogue('bonn'), { now: FALLBACK });
  manifest.refreshFailure = { attemptedAt: NOW.toISOString(), reason: 'OParl HTTP 503', expiresAt: EXPIRY.toISOString() };
  await fs.writeFile(path.join(target, 'bonn.json'), JSON.stringify(manifest));
  return manifest;
}

test('restores a fresh deployed snapshot in a clean checkout without contacting the source', async () => {
  const manifest = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: FRESH });
  const outcomes = await refresh({
    cities: ['bonn'], fetchPublished: fetchPages({ decoded: true }),
    collect: () => { throw new Error('The source must not be contacted for a fresh snapshot'); },
  });
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'current', generatedAt: FRESH.toISOString() }]);
  const snapshot = await readRisSnapshot(directory, 'bonn');
  expect(snapshot.manifest).toEqual(manifest);
  expect(snapshot.features.features).toHaveLength(1);
});

test('restore-only uses the deployed snapshot even when it is stale', async () => {
  const prior = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: STALE });
  const outcomes = await refresh({
    restoreOnly: true, cities: ['bonn'], collect: () => catalogue('bonn', { count: 7 }),
  });
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'restored', generatedAt: STALE.toISOString() }]);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
});

test('restore-only reports the missing city and still restores the available one', async () => {
  const prior = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: STALE });
  await expect(refresh({ restoreOnly: true, collect: city => catalogue(city) }))
    .rejects.toThrow(/hannover.*no deployed snapshot/i);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
  await expect(readRisSnapshot(directory, 'hannover')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a source failure marks the retained city while an independent city publishes', async () => {
  const prior = await writeRisSnapshot(directory, 'bonn', catalogue('bonn'), { now: FALLBACK });
  const outcomes = await refresh({
    collect: city => {
      if (city === 'bonn') throw new Error('OParl HTTP 503\n<script>private diagnostic</script>');
      return catalogue('hannover');
    },
  });
  expect(outcomes).toMatchObject([
    { city: 'bonn', status: 'retained', generatedAt: FALLBACK.toISOString(), reason: expect.stringContaining('OParl HTTP 503') },
    { city: 'hannover', status: 'published', generatedAt: NOW.toISOString() },
  ]);
  const manifestText = await fs.readFile(path.join(directory, 'bonn.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  expect(manifest).toEqual({ ...prior, refreshFailure: {
    attemptedAt: NOW.toISOString(), expiresAt: EXPIRY.toISOString(), reason: expect.any(String),
  } });
  expect(manifest.refreshFailure.reason.length).toBeGreaterThan(0);
  expect(manifestText).not.toContain('private diagnostic');
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(manifest);
  expect((await fs.readdir(directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  expect((await readRisSnapshot(directory, 'hannover')).records).toHaveLength(2);
});

test.each([
  ['unverified completeness', { complete: false }],
  ['a shortened historical range', { from: '2026-07-01' }],
  ['a loss of recent coverage', { to: '2026-10-01' }],
  ['a missing historical council', { body: 'Ein anderes Gremium' }],
  ['a large loss of indexed records', { count: 1 }],
])('retains the deployed snapshot for %s', async (_name, changed) => {
  const prior = await writeRisSnapshot(published, 'bonn', catalogue('bonn', { count: 4 }), { now: FALLBACK });
  const outcomes = await refresh({
    cities: ['bonn'], collect: () => catalogue('bonn', { count: 4, ...changed }),
  });
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'retained', generatedAt: FALLBACK.toISOString() }]);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual({ ...prior, refreshFailure: {
    attemptedAt: NOW.toISOString(), expiresAt: EXPIRY.toISOString(), reason: expect.any(String),
  } });
});

test('keeps the original expiry and coverage baseline after another failed refresh', async () => {
  const prior = await seedFallback(published);
  const retry = new Date('2026-11-10T12:00:00.000Z');
  await expect(refresh({
    cities: ['bonn'], now: retry, collect: () => catalogue('bonn', { from: '2026-07-01' }),
  })).resolves.toMatchObject([{ city: 'bonn', status: 'retained', reason: expect.stringMatching(/coverage is narrower/i) }]);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual({ ...prior, refreshFailure: {
    attemptedAt: retry.toISOString(), expiresAt: EXPIRY.toISOString(), reason: expect.any(String),
  } });
});

test('does not replace a known failure with an unmarked copy of the same generation', async () => {
  const prior = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: FRESH });
  const manifest = { ...prior, refreshFailure: {
    attemptedAt: '2026-11-05T10:00:00.000Z', expiresAt: '2026-11-17T09:00:00.000Z', reason: 'OParl HTTP 503',
  } };
  await fs.writeFile(path.join(published, 'bonn.json'), JSON.stringify(manifest));
  await writeRisSnapshot(directory, 'bonn', catalogue('bonn'), { now: FRESH });
  await refresh({ cities: ['bonn'], collect: () => catalogue('bonn', { count: 3 }) });
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(manifest);
});

test('publishes a successful recovery without carrying forward the failure', async () => {
  await seedFallback(published);
  const retry = new Date(NOW.getTime() + 6 * 60 * 60_000);
  await expect(refresh({ cities: ['bonn'], now: retry, collect: () => catalogue('bonn', { count: 3 }) }))
    .resolves.toMatchObject([{ city: 'bonn', status: 'published', generatedAt: retry.toISOString() }]);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).not.toHaveProperty('refreshFailure');
});

test('does not reinstall a deployed fallback that expires during an ongoing outage', async () => {
  await seedFallback(published);
  await expect(refresh({
    cities: ['bonn'], now: EXPIRY, collect: () => { throw new Error('OParl HTTP 503'); },
  })).resolves.toMatchObject([{ city: 'bonn', status: 'unavailable', reason: expect.stringMatching(/expired/i) }]);
  expect(await validateRisDirectory(directory)).toEqual([]);
});

test('does not install a fallback that expires while the official crawl is running', async () => {
  await seedFallback(published);
  jest.useFakeTimers({
    now: new Date('2026-11-14T08:59:59.999Z'),
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout'],
  });
  try {
    await expect(refresh({
      cities: ['bonn'], now: undefined,
      collect: () => { jest.setSystemTime(EXPIRY); throw new Error('OParl HTTP 503'); },
    })).resolves.toMatchObject([{ city: 'bonn', status: 'unavailable', reason: expect.stringMatching(/expired/i) }]);
    expect(await validateRisDirectory(directory)).toEqual([]);
  } finally {
    jest.useRealTimers();
  }
});

test('omits an expired legacy snapshot when the first refresh attempt fails', async () => {
  await writeRisSnapshot(directory, 'bonn', catalogue('bonn'), { now: OLD });
  await expect(refresh({ cities: ['bonn'], collect: () => { throw new Error('OParl HTTP 503'); } }))
    .resolves.toMatchObject([{ city: 'bonn', status: 'unavailable', reason: expect.stringMatching(/expired/i) }]);
  expect(await validateRisDirectory(directory)).toEqual([]);
});

test('restore-only refuses a deployed fallback at its expiry', async () => {
  await seedFallback(published);
  await expect(refresh({ cities: ['bonn'], now: EXPIRY, restoreOnly: true })).rejects.toThrow(/bonn.*expired/i);
  expect(await validateRisDirectory(directory)).toEqual([]);
});

test('restore-only and publication validation reject an overdue unmarked snapshot', async () => {
  await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: OLD });
  await expect(refresh({ cities: ['bonn'], restoreOnly: true })).rejects.toThrow(/bonn.*expired/i);
  await expect(validateRisDirectory(published, { now: NOW })).rejects.toThrow(/bonn.*expired/i);
});

test('fails closed if the only verified fallback is expired and the deployed state is unknown', async () => {
  const prior = await seedFallback(directory);
  await expect(refresh({
    cities: ['bonn'], now: EXPIRY,
    collect: () => { throw new Error('OParl HTTP 503'); },
    fetchPublished: async () => new Response(null, { status: 503 }),
  })).rejects.toThrow(/expired.*could not verify the deployed fallback/i);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
});

test('omits a first-time city with an unavailable source rather than manufacturing an empty snapshot', async () => {
  const outcomes = await refresh({ cities: ['bonn'], collect: () => ({ ...catalogue('bonn'), records: [] }) });
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'unavailable' }]);
  expect(await validateRisDirectory(directory)).toEqual([]);
});

test('fails closed if the previously deployed city is damaged and its source is unavailable', async () => {
  const manifest = await writeSnapshot(published, 'bonn', catalogue('bonn'), { now: OLD });
  await expect(refresh({
    cities: ['bonn'], fetchPublished: fetchPages({ tamper: manifest.map.path }),
    collect: () => { throw new Error('OParl HTTP 503'); },
  })).rejects.toThrow(/bonn.*OParl HTTP 503/i);
  expect(await validateRisDirectory(directory)).toEqual([]);
});

test('does not fetch a foreign asset URL supplied by a deployed manifest', async () => {
  const manifest = await writeSnapshot(published, 'bonn', catalogue('bonn'), { now: OLD });
  manifest.records.path = 'https://untrusted.example/snapshot.json.gz';
  await fs.writeFile(path.join(published, 'bonn.json'), JSON.stringify(manifest));
  const requests = [];
  const fetch = fetchPages();
  const outcomes = await refresh({
    cities: ['bonn'], collect: () => catalogue('bonn'),
    fetchPublished: (...args) => {
      requests.push(args[0]);
      return fetch(...args);
    },
  });
  expect(requests).toEqual([`${SITE}bonn.json`]);
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'published' }]);
});

test('artifact validation refuses a manifest with a corrupt or missing map asset', async () => {
  const manifest = await writeSnapshot(directory, 'bonn', catalogue('bonn'), { now: FRESH });
  await expect(validateRisDirectory(directory, { now: NOW })).resolves.toMatchObject([{ city: 'bonn' }]);
  await fs.writeFile(path.join(directory, manifest.map.path), 'not a gzip file');
  await expect(validateRisDirectory(directory)).rejects.toThrow(/map gzip/i);
  await fs.rm(path.join(directory, manifest.map.path));
  await expect(validateRisDirectory(directory)).rejects.toThrow(/missing.*map asset/i);
});

test('artifact validation accepts the verified fallback until its expiry', async () => {
  const manifest = await seedFallback(directory);
  await expect(validateRisDirectory(directory, { now: new Date('2026-11-14T08:59:59.999Z') })).resolves.toEqual([manifest]);
  await expect(validateRisDirectory(directory, { now: EXPIRY })).rejects.toThrow(/bonn.*expired/i);
});

test('production artifact validation requires both city snapshots', async () => {
  await writeRisSnapshot(directory, 'bonn', catalogue('bonn'), { now: FRESH });
  await expect(validateRisDirectory(directory, { requireAll: true })).rejects.toThrow(/missing.*hannover/i);
  await writeRisSnapshot(directory, 'hannover', catalogue('hannover'), { now: FRESH });
  await expect(validateRisDirectory(directory, { requireAll: true, now: NOW })).resolves.toMatchObject([
    { city: 'bonn' }, { city: 'hannover' },
  ]);
});

test('rebuilds a fresh legacy Hannover snapshot once to publish measure locations', async () => {
  const legacy = catalogue('hannover');
  legacy.locationRevision = 1;
  legacy.records.forEach(record => delete record.locationAssessment);
  await writeRisSnapshot(published, 'hannover', legacy, { now: FRESH });
  const collect = jest.fn(() => regionalCatalogue());
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([
    { city: 'hannover', status: 'published' },
  ]);
  const { manifest } = await readRisSnapshot(directory, 'hannover');
  expect(manifest.locationRevision).toBe(3);
  expect(manifest.locationAssessment.attempted).toBe(manifest.recordCount);
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([
    { city: 'hannover', status: 'current' },
  ]);
  expect(collect).toHaveBeenCalledTimes(1);
});

test('adds Region records to a fresh city-only snapshot once, retaining city identities and map geometry', async () => {
  const prior = await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FRESH });
  const collect = jest.fn(() => regionalCatalogue());
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'published', records: 3 }]);
  const snapshot = await readRisSnapshot(directory, 'hannover');
  expect(snapshot.records.map(record => record.id)).toEqual(expect.arrayContaining(['hannover:1', 'hannover:2', 'region-hannover-ris:vo:2003037']));
  expect(snapshot.manifest.sources).toContain('https://ris.hannit.de/public/vo040');
  expect(snapshot.manifest.provenance.provider).toBe('hannover-official-sources');
  expect(snapshot.manifest.locationAssessment.attempted).toBe(3);
  expect(snapshot.features.features).toHaveLength(prior.geometryCount);
  expect(snapshot.features.features[0].properties.recordId).toBe('hannover:1');
  expect(snapshot.records.find(record => record.source === 'region-hannover-ris').url).toContain('VOLFDNR=2003037');
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'current', records: 3 }]);
  expect(collect).toHaveBeenCalledTimes(1);
});

test.each(['failure', 'missing-source'])('retains the mixed catalogue and its clock after a regional %s', async problem => {
  const prior = await writeRisSnapshot(published, 'hannover', regionalCatalogue(), { now: FALLBACK });
  const collect = problem === 'failure' ? () => { throw new Error('Region HTTP 503'); } : () => catalogue('hannover', { count: 3 });
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'retained', generatedAt: FALLBACK.toISOString() }]);
  const snapshot = await readRisSnapshot(directory, 'hannover');
  expect(snapshot.records.some(record => record.source === 'region-hannover-ris')).toBe(true);
  expect(snapshot.manifest.generatedAt).toBe(prior.generatedAt);
  expect(snapshot.manifest.refreshFailure.expiresAt).toBe(EXPIRY.toISOString());
});

test('a regional link with a blocked zero-record status still triggers the first actual import', async () => {
  const prior = catalogue('hannover');
  prior.sources.push('https://ris.hannit.de/public/');
  prior.sourceStatuses = [{ source: 'region-hannover-ris', status: 'blocked', url: 'https://ris.hannit.de/public/',
    retrievedAt: null, from: null, to: null, recordCount: 0, message: 'Früher nur als manueller Link erfasst.' }];
  await writeRisSnapshot(published, 'hannover', prior, { now: FRESH });
  const collect = jest.fn(() => regionalCatalogue());
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'published', records: 3 }]);
  expect(collect).toHaveBeenCalledTimes(1);
});

test.each([false, true])('an old city-only failure permits the first Region import but preserves its subsequent retry backoff (fail=%s)', async fail => {
  const prior = await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FRESH });
  prior.refreshFailure = { attemptedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    expiresAt: new Date(FRESH.getTime() + 14 * 86400000).toISOString(), reason: 'Früherer SIM-Abruf fehlgeschlagen.' };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const collect = jest.fn(() => { if (fail) throw new Error('Region HTTP 429'); return regionalCatalogue(); });
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: fail ? 'retained' : 'published' }]);
  expect(collect).toHaveBeenCalledTimes(1);
  if (fail) {
    const snapshot = await readRisSnapshot(directory, 'hannover');
    expect(snapshot.manifest.sourceStatuses).toContainEqual(expect.objectContaining({ source: 'region-hannover-ris', status: 'failed', recordCount: 0 }));
    await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'current' }]);
    expect(collect).toHaveBeenCalledTimes(1);
  }
});

test('a successful cached Region upgrade wins over an old deployed failure with the same source clock', async () => {
  const prior = await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FRESH });
  prior.refreshFailure = { attemptedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    expiresAt: new Date(FRESH.getTime() + 14 * 86400000).toISOString(), reason: 'Früherer SIM-Abruf fehlgeschlagen.' };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const current = regionalCatalogue();
  current.generatedAt = FRESH.toISOString();
  const collect = jest.fn(() => current);
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'published', records: 3 }]);
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'current', records: 3 }]);
  expect(collect).toHaveBeenCalledTimes(1);
});

test('retained regional IDs absent from a completed fresh crawl keep their original verification clock', async () => {
  const prior = regionalCatalogue();
  prior.records.push({ ...prior.records[2], id: 'region-hannover-ris:vo:historic', title: 'Ältere regionale Vorlage' });
  prior.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  prior.sourceStatuses[0].recordCount = 2;
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const current = regionalCatalogue();
  current.generatedAt = NOW.toISOString();
  await expect(refresh({ cities: ['hannover'], collect: () => current })).resolves.toMatchObject([{ status: 'published', records: 4 }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.records.map(record => record.id)).toContain('region-hannover-ris:vo:historic');
  expect(result.manifest.generatedAt).toBe(FALLBACK.toISOString());
  expect(result.manifest.provenance.sourceVerifiedAt).toBe(FALLBACK.toISOString());
  expect(result.manifest.sourceStatuses[0]).toMatchObject({ retrievedAt: FALLBACK.toISOString(), recordCount: 2 });
});

test('pending new regional detail work does not freeze freshly verified metadata at the previous snapshot clock', async () => {
  await writeRisSnapshot(published, 'hannover', regionalCatalogue(), { now: FALLBACK });
  const current = regionalCatalogue();
  current.generatedAt = NOW.toISOString();
  current.history = { pending: true, interrupted: true, retainPreviousClock: false, pendingYears: [2026] };
  current.records[2].locationEvidenceUnavailable = true;
  await expect(refresh({ cities: ['hannover'], collect: () => current })).resolves.toMatchObject([{ status: 'published', generatedAt: NOW.toISOString() }]);
});

test('an explicitly non-public Region record is removed, including its geometry, despite the normal loss guard', async () => {
  const prior = regionalCatalogue();
  Object.assign(prior.records[2], { geometry: { type: 'Point', coordinates: [9.75, 52.38] }, locationSource: 'official',
    locationAssessment: { status: 'mapped', sources: ['official'], reasons: [], truncated: false } });
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const current = regionalCatalogue();
  current.exclusions = [{ id: prior.records[2].id, url: prior.records[2].url, verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  current.records = current.records.slice(0, 2);
  current.sourceStatuses[0].recordCount = 0;
  await expect(refresh({ cities: ['hannover'], collect: () => current })).resolves.toMatchObject([{ status: 'published', records: 2 }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.records.some(record => record.source === 'region-hannover-ris')).toBe(false);
  expect(result.features.features).toHaveLength(1);
  expect(result.manifest.generatedAt).toBe(NOW.toISOString());
});

test('unverified exclusions cannot remove records from another source', async () => {
  const prior = await writeRisSnapshot(published, 'hannover', regionalCatalogue(), { now: FALLBACK });
  const current = regionalCatalogue();
  current.exclusions = [{ id: 'hannover:1', url: current.records[0].url, verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  await expect(refresh({ cities: ['hannover'], collect: () => current })).resolves.toMatchObject([{ status: 'retained', records: 3 }]);
  expect((await readRisSnapshot(directory, 'hannover')).manifest.generatedAt).toBe(prior.generatedAt);
});

test('an unrelated candidate failure cannot resurrect an explicitly non-public Region record through fallback', async () => {
  const prior = regionalCatalogue();
  prior.provenance = require('../../server/political-context/services/risProvenance').collectionProvenance({
    catalogue: prior, city: 'hannover', records: prior.records, sourceRecords: prior.records,
    sourceVerifiedAt: FALLBACK.toISOString(), now: FALLBACK,
  });
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const current = regionalCatalogue();
  current.generatedAt = OLD.toISOString();
  current.exclusions = [{ id: prior.records[2].id, url: prior.records[2].url, verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  current.records = current.records.slice(0, 2);
  current.sourceStatuses[0].recordCount = 0;
  await expect(refresh({ cities: ['hannover'], collect: () => current }))
    .resolves.toMatchObject([{ status: 'retained', records: 2, generatedAt: FALLBACK.toISOString() }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.records.some(record => record.source === 'region-hannover-ris')).toBe(false);
  expect(result.manifest.sourceStatuses[0].recordCount).toBe(0);
  expect(result.manifest.provenance.sourceFingerprint).toEqual(prior.provenance.sourceFingerprint);
  expect(result.manifest.provenance.collection.normalizedItems).toBe(2);
});

test('source failures carrying confirmed regional exclusions sanitize the fallback as well', async () => {
  const prior = regionalCatalogue();
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const failure = Object.assign(new Error('SIM source failed'), { exclusions: [{ id: prior.records[2].id,
    url: prior.records[2].url, verifiedAt: NOW.toISOString(), reason: 'not-public' }] });
  await expect(refresh({ cities: ['hannover'], collect: () => { throw failure; } }))
    .resolves.toMatchObject([{ status: 'retained', records: 2 }]);
  expect((await readRisSnapshot(directory, 'hannover')).records.some(record => record.source === 'region-hannover-ris')).toBe(false);
});

test('assesses every Bonner record immediately when its fresh snapshot predates the common assessment contract', async () => {
  const legacy = catalogue('bonn');
  delete legacy.locationRevision;
  legacy.records.forEach(record => delete record.locationAssessment);
  await writeRisSnapshot(published, 'bonn', legacy, { now: FRESH });
  const collect = jest.fn(() => catalogue('bonn'));
  await expect(refresh({ cities: ['bonn'], collect })).resolves.toMatchObject([{ city: 'bonn', status: 'published' }]);
  const { manifest, records } = await readRisSnapshot(directory, 'bonn');
  expect(manifest.locationRevision).toBe(3);
  expect(manifest.locationAssessment.attempted).toBe(records.length);
  expect(records.every(record => record.locationAssessment)).toBe(true);
  expect(collect).toHaveBeenCalledTimes(1);
});

test.each(['bonn', 'hannover'])('locally assesses every retained legacy %s record when the official source is unavailable', async city => {
  const legacy = legacyCatalogue(city, { count: 3 });
  const prior = await writeRisSnapshot(published, city, legacy, { now: FALLBACK });
  const before = await readRisSnapshot(published, city);
  const collect = jest.fn(() => { throw new Error('Official HTTP 429'); });
  const outcomes = await refresh({ cities: [city], collect });
  expect(outcomes).toMatchObject([{
    city, status: 'retained', generatedAt: FALLBACK.toISOString(), records: 3,
    reason: expect.stringContaining('Official HTTP 429'), locationAssessment: { attempted: 3 },
  }]);
  const snapshot = await readRisSnapshot(directory, city);
  expect(snapshot.records.map(record => record.id)).toEqual([`${city}:1`, `${city}:2`, `${city}:3`]);
  expect(snapshot.records.every(record => record.locationAssessment)).toBe(true);
  expect(snapshot.records.every(record => record.locationAssessment.reasons.includes('document_text_unavailable'))).toBe(true);
  expect(snapshot.features.features.filter(feature => feature.properties.accuracy === 'official')).toEqual(before.features.features);
  expect(snapshot.manifest).toMatchObject({
    generatedAt: prior.generatedAt, sources: city === 'hannover' ? [...prior.sources, 'https://ris.hannit.de/public/vo040'] : prior.sources,
    coverage: prior.coverage, locationRevision: 3,
    locationAssessment: { attempted: 3, mapped: 0, partial: 1, unresolved: 2, unavailable: 0, truncated: 0 },
    refreshFailure: { attemptedAt: NOW.toISOString(), expiresAt: EXPIRY.toISOString() },
  });
  expect(collect).toHaveBeenCalledTimes(1);
});

test('reuses bounded document evidence and its precise geometry without widening a retained Hannover catalogue', async () => {
  const legacy = legacyCatalogue('hannover', { count: 3 });
  legacy.coverage.scope = 'selected-bodies';
  const evidence = { source: 'document', text: 'An der Kreuzung Davenstedter Straße/Südfeldstraße wird eine Ampel errichtet.' };
  const geometry = { type: 'Point', coordinates: [9.684182, 52.366228] };
  legacy.records[1].locations = [{ kind: 'junction', label: 'Davenstedter Straße / Südfeldstraße', evidence, geometry }];
  const prior = await writeRisSnapshot(published, 'hannover', legacy, { now: FALLBACK });
  await refresh({ cities: ['hannover'], collect: () => { throw new Error('SIM unavailable'); } });
  const snapshot = await readRisSnapshot(directory, 'hannover');
  expect(snapshot.manifest).toMatchObject({ generatedAt: prior.generatedAt, coverage: prior.coverage,
    sources: [...prior.sources, 'https://ris.hannit.de/public/vo040'],
    sourceStatuses: [expect.objectContaining({ source: 'region-hannover-ris', status: 'failed', recordCount: 0, retrievedAt: null })] });
  expect(snapshot.records[1].locations).toEqual([{
    kind: 'junction', label: 'Davenstedter Straße / Südfeldstraße', evidence, mapped: true,
  }]);
  expect(snapshot.records[1].locationAssessment).toEqual({
    status: 'partial', sources: ['title', 'document'], reasons: ['evidence_truncated'], truncated: true,
  });
  expect(snapshot.features.features.find(feature => feature.properties.recordId === 'hannover:2').geometry).toEqual(geometry);
  expect(snapshot.manifest.refreshFailure).toMatchObject({ attemptedAt: NOW.toISOString(), expiresAt: EXPIRY.toISOString() });
});

test.each([FRESH, FALLBACK])('a recent source retry backoff permits local assessment of the %s snapshot without changing source freshness', async generatedAt => {
  const legacy = legacyCatalogue('bonn');
  // A revision alone is not proof that all records have been assessed.
  legacy.locationRevision = 2;
  const prior = await writeRisSnapshot(published, 'bonn', legacy, { now: generatedAt });
  prior.generatedAt = generatedAt.toISOString().replace('.000Z', 'Z');
  prior.refreshFailure = {
    attemptedAt: '2026-11-07T09:30:00.000Z', expiresAt: new Date(generatedAt.getTime() + 14 * 86400000).toISOString(), reason: 'Official HTTP 429',
  };
  await fs.writeFile(path.join(published, 'bonn.json'), JSON.stringify(prior));
  const collect = jest.fn(() => { throw new Error('Retry backoff must prevent another source request'); });
  await expect(refresh({ cities: ['bonn'], collect })).resolves.toMatchObject([{
    status: 'current', generatedAt: prior.generatedAt, locationAssessment: { attempted: 2 },
  }]);
  const snapshot = await readRisSnapshot(directory, 'bonn');
  expect(snapshot.manifest.generatedAt).toBe(prior.generatedAt);
  expect(snapshot.manifest.refreshFailure).toEqual(prior.refreshFailure);
  const upgradedBytes = await fs.readFile(path.join(directory, 'bonn.json'));
  await refresh({ cities: ['bonn'], collect });
  expect(await fs.readFile(path.join(directory, 'bonn.json'))).toEqual(upgradedBytes);
  expect(collect).not.toHaveBeenCalled();
});

test('attempts recovery when a recently failed fallback expires instead of keeping it during the retry backoff', async () => {
  const prior = await seedFallback(published);
  prior.refreshFailure.attemptedAt = new Date(EXPIRY.getTime() - 30 * 60_000).toISOString();
  await fs.writeFile(path.join(published, 'bonn.json'), JSON.stringify(prior));
  const collect = jest.fn(() => catalogue('bonn', { count: 3 }));
  await expect(refresh({ cities: ['bonn'], now: EXPIRY, collect })).resolves.toMatchObject([{
    status: 'published', generatedAt: EXPIRY.toISOString(), records: 3,
  }]);
  expect(collect).toHaveBeenCalledTimes(1);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).not.toHaveProperty('refreshFailure');
});

test('restore-only copies an unassessed legacy snapshot byte for byte', async () => {
  const prior = await writeRisSnapshot(published, 'bonn', legacyCatalogue('bonn'), { now: STALE });
  const filenames = ['bonn.json', prior.records.path, prior.map.path];
  const before = await Promise.all(filenames.map(filename => fs.readFile(path.join(published, filename))));
  const collect = jest.fn(() => { throw new Error('Restore-only must not contact the source'); });
  await expect(refresh({ restoreOnly: true, cities: ['bonn'], collect })).resolves.toMatchObject([{
    status: 'restored', generatedAt: prior.generatedAt,
  }]);
  const after = await Promise.all(filenames.map(filename => fs.readFile(path.join(directory, filename))));
  expect(after).toEqual(before);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
  expect(collect).not.toHaveBeenCalled();
});

test('keeps the verified fallback and reports the reason if local reassessment cannot read its geodata', async () => {
  const prior = await writeRisSnapshot(directory, 'bonn', legacyCatalogue('bonn'), { now: FALLBACK });
  const geodataPath = path.resolve(__dirname, '../../config/ris-locations/bonn.json');
  const readFile = fs.readFile.bind(fs);
  const geodataFailure = jest.spyOn(fs, 'readFile').mockImplementation((filename, ...args) =>
    filename === geodataPath ? Promise.resolve('invalid geodata JSON') : readFile(filename, ...args));
  try {
    await expect(refresh({ cities: ['bonn'], collect: () => { throw new Error('Official HTTP 429'); } }))
      .resolves.toMatchObject([{ status: 'retained', reason: expect.stringMatching(/Official HTTP 429.*local location reassessment failed/i) }]);
    const snapshot = await readRisSnapshot(directory, 'bonn');
    expect(snapshot.manifest).toMatchObject({
      generatedAt: prior.generatedAt, records: prior.records, map: prior.map, coverage: prior.coverage,
      refreshFailure: { attemptedAt: NOW.toISOString(), expiresAt: EXPIRY.toISOString() },
    });
    expect(snapshot.manifest.locationAssessment).toBeUndefined();
    await expect(validateRisDirectory(directory, { now: NOW })).resolves.toHaveLength(1);
  } finally {
    geodataFailure.mockRestore();
  }
});

test('upgrades a fresh selected-committee catalogue to historical citywide discovery using the common format', async () => {
  const legacy = catalogue('hannover', { from: '2026-01-28' });
  legacy.coverage.scope = 'selected-bodies';
  await writeRisSnapshot(published, 'hannover', legacy, { now: FRESH });
  const expanded = catalogue('hannover', { count: 6, body: 'Alle öffentlichen Gremien' });
  expanded.sources = ['https://e-government.hannover-stadt.de/lhhsimwebre.nsf/Suche.xsp'];
  const collect = jest.fn(() => expanded);
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ city: 'hannover', status: 'published', records: 6 }]);
  const { manifest } = await readRisSnapshot(directory, 'hannover');
  expect(manifest.coverage).toMatchObject({ from: '2014-01-01', scope: 'citywide' });
  expect(manifest.sources).toEqual(expanded.sources);
  expect(manifest.locationAssessment.attempted).toBe(6);
});

test('retains citywide coverage when a later refresh only supplies selected bodies', async () => {
  const prior = await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FALLBACK });
  const reduced = catalogue('hannover');
  reduced.coverage.scope = 'selected-bodies';
  await expect(refresh({ cities: ['hannover'], collect: () => reduced }))
    .resolves.toMatchObject([{ city: 'hannover', status: 'retained' }]);
  expect((await readRisSnapshot(directory, 'hannover')).manifest.recordCount).toEqual(prior.recordCount);
});

test('publishes a documented Hannover crossing and the three stated addresses from the checked-in geodata', async () => {
  const { sources, coverage } = catalogue('hannover');
  const records = [
    {
      id: 'hannover-sim:15-0040-2026', number: '15-0040/2026', type: 'Antrag',
      title: 'Errichtung einer Ampel zur Querung der Davenstedter Straße',
      date: null, gremium: 'Stadtbezirksrat Linden-Limmer', source: 'hannover-sim',
      url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-0040-2026',
      locationEvidence: ['An der Kreuzung Davenstedter Straße/Südfeldstraße wird eine Ampel errichtet.'],
    },
    {
      id: 'hannover-sim:15-2517-2025', number: '15-2517/2025', type: 'Antrag',
      title: 'Entzerrung Rad-Fußverkehr Stephanusstr 10, 12 und 14',
      date: null, gremium: 'Stadtbezirksrat Linden-Limmer', source: 'hannover-sim',
      url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2517-2025',
      locationEvidence: ['Die Verwaltung wird gebeten, die Fahrradbügel im Bereich Stephanusstraße 10, 12 und 14 zu verlegen.'],
    },
  ];
  await refresh({ cities: ['hannover'], collect: () => ({ sources, coverage, records }) });
  const snapshot = await readRisSnapshot(directory, 'hannover');
  expect(snapshot.records[0].locations).toMatchObject([
    { kind: 'junction', label: 'Davenstedter Straße / Südfeldstraße', mapped: true },
  ]);
  expect(snapshot.records[1].locations.map(({ label, mapped }) => [label, mapped])).toEqual([
    ['Stephanusstraße 10', true], ['Stephanusstraße 12', true], ['Stephanusstraße 14', true],
  ]);
  expect(snapshot.features.features.map(feature => feature.geometry)).toEqual(expect.arrayContaining([
    { type: 'Point', coordinates: [9.684182, 52.366228] },
    { type: 'Point', coordinates: [9.714685, 52.368463] },
    { type: 'Point', coordinates: [9.714644, 52.368623] },
    { type: 'Point', coordinates: [9.714842, 52.368762] },
  ]));
});

test('extends interrupted historical work without losing previously verified annual records', async () => {
  const priorData = catalogue('hannover', { from: '2010-01-01' });
  await writeRisSnapshot(directory, 'hannover', priorData, { now: FALLBACK });
  let received;
  const partial = catalogue('hannover', { count: 1, from: '2014-01-01', to: '2014-12-31' });
  partial.records[0].id = 'hannover:historical';
  partial.history = { pending: true, interrupted: true };
  const outcomes = await refresh({ cities: ['hannover'], historyStartYear: 2014, workBudget: 1,
    collect: (_city, _now, options) => { received = options; return partial; } });
  expect(received).toMatchObject({ historyStartYear: 2014, workBudget: 1 });
  expect(outcomes).toMatchObject([{ status: 'published', records: 3 }]);
  const snapshot = await readRisSnapshot(directory, 'hannover');
  expect(snapshot.records.map(record => record.id)).toEqual(expect.arrayContaining(['hannover:1', 'hannover:2', 'hannover:historical']));
  expect(snapshot.manifest.generatedAt).toBe(FALLBACK.toISOString());
  expect(snapshot.manifest.coverage).toMatchObject({ from: '2010-01-01', to: '2026-10-15', complete: false });
  expect(snapshot.manifest.coverage.warnings.join(' ')).toMatch(/fortsetzbar/);
});

test('migrates a retained legacy fallback to v2 while preserving original source freshness and expiry', async () => {
  const prior = await writeRisSnapshot(published, 'bonn', legacyCatalogue('bonn'), { now: FALLBACK });
  await refresh({ cities: ['bonn'], collect: () => { throw new Error('HTTP 429'); } });
  const snapshot = await readRisSnapshot(directory, 'bonn');
  expect(snapshot.manifest).toMatchObject({ schemaVersion: 2, generatedAt: prior.generatedAt,
    coverage: prior.coverage, sources: prior.sources, locationRevision: 3,
    refreshFailure: { expiresAt: EXPIRY.toISOString(), attemptedAt: NOW.toISOString() } });
  await expect(validateRisDirectory(directory, { now: NOW })).resolves.toHaveLength(1);
});

test('restores and validates all v2 search and relationship assets before installation', async () => {
  const manifest = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: FRESH });
  expect(manifest.schemaVersion).toBe(2);
  await fs.rm(path.join(published, manifest.roots.search.path));
  await expect(refresh({ cities: ['bonn'], restoreOnly: true })).rejects.toThrow(/published RIS file|missing/i);
  await expect(fs.readFile(path.join(directory, 'bonn.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('pure format migration preserves canonical records and features without changing their assessment', async () => {
  const prior = await writeSnapshot(published, 'bonn', catalogue('bonn'), { now: FRESH });
  const before = await readRisSnapshot(published, 'bonn');
  await refresh({ cities: ['bonn'], collect: () => { throw new Error('fresh source must not be refreshed'); } });
  const after = await readRisSnapshot(directory, 'bonn');
  expect(after.manifest).toMatchObject({ schemaVersion: 2, generatedAt: prior.generatedAt,
    locationRevision: 3, locationAssessment: prior.locationAssessment, coverage: prior.coverage, sources: prior.sources });
  expect(after.manifest.refreshFailure).toBeUndefined();
  expect(after.records).toEqual(before.records);
  expect(after.features.features).toEqual(expect.arrayContaining(before.features.features));
  expect(after.features.features).toHaveLength(before.features.features.length);
});

test.each([false, true])('keeps verified detail evidence, geometry and relations when a listed detail is unavailable (interrupted=%s)', async interrupted => {
  const priorData = catalogue('hannover');
  priorData.records[0].relatedTo = 'hannover:2';
  const evidence = { source: 'document', text: 'An der Kreuzung Davenstedter Straße/Südfeldstraße wird eine Ampel errichtet.' };
  priorData.records[0].locations = [{ kind: 'junction', label: 'Davenstedter Straße / Südfeldstraße', evidence,
    geometry: { type: 'Point', coordinates: [9.684182, 52.366228] } }];
  await writeRisSnapshot(directory, 'hannover', priorData, { now: FALLBACK });
  const before = await readRisSnapshot(directory, 'hannover');
  const next = catalogue('hannover', { count: 1 });
  next.records = [{ id: 'hannover:1', title: 'Aktualisierter amtlicher Listentitel', number: '1/2026', type: 'Anfrage',
    date: '2026-11-06', gremium: null, url: priorData.records[0].url, source: 'hannover',
    locationEvidence: [], locationEvidenceUnavailable: true }];
  next.history = { pending: true, interrupted };
  await expect(refresh({ cities: ['hannover'], collect: () => next })).resolves.toMatchObject([{ status: 'published', records: 2 }]);
  const after = await readRisSnapshot(directory, 'hannover');
  const retained = after.records.find(record => record.id === 'hannover:1');
  expect(retained).toMatchObject({ title: 'Aktualisierter amtlicher Listentitel', date: '2026-11-06', type: 'Anfrage', relatedTo: 'hannover:2',
    locations: before.records[0].locations, locationAssessment: { status: 'partial', reasons: expect.arrayContaining(['document_text_unavailable']) } });
  expect(after.features.features.filter(feature => feature.properties.recordId === 'hannover:1'))
    .toEqual(expect.arrayContaining(before.features.features.filter(feature => feature.properties.recordId === 'hannover:1')));
  expect(after.manifest.generatedAt).toBe(FALLBACK.toISOString());
  expect(after.manifest.coverage.complete).toBe(false);
  expect(after.manifest.coverage.warnings.join(' ')).toMatch(/Detail.*verifiziert|verifiziert.*Detail/i);
});

test('keeps complete title-derived feature labels when newly unavailable detail evidence retains prior locations', async () => {
  const priorData = catalogue('hannover');
  const priorRecord = priorData.records[0];
  priorRecord.title = 'Radverkehr in der Limmerstraße und am Küchengarten';
  delete priorRecord.geometry;
  delete priorRecord.locationSource;
  const evidence = { source: 'title', text: priorRecord.title };
  priorRecord.locations = [
    { kind: 'street', label: 'Limmerstraße', extent: 'part', attribution: 'LGLN, dl-de/by-2-0', evidence,
      geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 52.37]] } },
    { kind: 'place', label: 'Am Küchengarten', attribution: 'Landeshauptstadt Hannover', evidence,
      geometry: { type: 'Point', coordinates: [9.717, 52.372] } },
  ];
  priorRecord.locationAssessment = { status: 'mapped', sources: ['title'], reasons: [], truncated: false };
  await writeRisSnapshot(directory, 'hannover', priorData, { now: FALLBACK });
  const before = await readRisSnapshot(directory, 'hannover');
  expect(before.features.features.map(feature => feature.properties.label)).toEqual([
    'Limmerstraße — kartierter Teil des Straßenverlaufs als Orientierung · LGLN, dl-de/by-2-0',
    'Am Küchengarten — Landeshauptstadt Hannover',
  ]);
  const next = catalogue('hannover');
  next.records[0] = { ...next.records[0], geometry: undefined, locationSource: undefined,
    title: 'Aktualisierter amtlicher Listentitel', locationEvidence: [], locationEvidenceUnavailable: true,
    detailVerifiedAt: FALLBACK.toISOString() };
  next.history = { pending: false, interrupted: false };
  await expect(refresh({ cities: ['hannover'], collect: () => next }))
    .resolves.toMatchObject([{ status: 'published', generatedAt: FALLBACK.toISOString(), records: 2 }]);
  const after = await readRisSnapshot(directory, 'hannover');
  expect(after.features).toEqual(before.features);
  expect(after.records.find(record => record.id === priorRecord.id)).toMatchObject({
    title: 'Aktualisierter amtlicher Listentitel', locations: before.records[0].locations,
    locationAssessment: { status: 'partial', sources: ['title'], reasons: ['document_text_unavailable'] },
  });
  expect(after.manifest.generatedAt).toBe(before.manifest.generatedAt);
});

test('successful changed detail replaces previous evidence and geometry', async () => {
  await writeRisSnapshot(directory, 'hannover', catalogue('hannover'), { now: FALLBACK });
  const next = catalogue('hannover');
  next.records[0].geometry = { type: 'Point', coordinates: [9.8, 52.4] };
  next.records[0].locationEvidence = ['Die Verwaltung verlegt die Querung.'];
  next.history = { pending: false, interrupted: false };
  await refresh({ cities: ['hannover'], collect: () => next });
  const after = await readRisSnapshot(directory, 'hannover');
  expect(after.features.features.find(feature => feature.properties.recordId === 'hannover:1').geometry)
    .toEqual({ type: 'Point', coordinates: [9.8, 52.4] });
  expect(after.manifest.coverage.warnings.join(' ')).not.toMatch(/Detail.*verifiziert|verifiziert.*Detail/i);
});

test('checkpoint detail age also constrains a previous snapshot refresh-failure expiry', async () => {
  const prior = await writeRisSnapshot(directory, 'hannover', catalogue('hannover'), { now: FALLBACK });
  prior.refreshFailure = { attemptedAt: new Date(NOW.getTime() - 7 * 60 * 60_000).toISOString(),
    reason: 'Amtlicher Abruf fehlgeschlagen.', expiresAt: EXPIRY.toISOString() };
  await fs.writeFile(path.join(directory, 'hannover.json'), JSON.stringify(prior));
  const next = catalogue('hannover');
  next.history = { pending: true, interrupted: false };
  next.records[0].locationEvidenceUnavailable = true;
  next.records[0].detailVerifiedAt = STALE.toISOString();
  await expect(refresh({ cities: ['hannover'], collect: () => next })).resolves.toMatchObject([{ status: 'published' }]);
  expect((await readRisSnapshot(directory, 'hannover')).manifest).toMatchObject({ generatedAt: STALE.toISOString(),
    refreshFailure: { ...prior.refreshFailure, expiresAt: '2026-11-11T09:00:00.000Z' } });
});

// Provenance is optional for legacy assets; newly collected facts stay bound
// through fallback and local location-only changes.
test('newly collected provenance binds source time and remains byte-identical in fallback and restore-only', async () => {
  const fresh = catalogue('bonn');
  fresh.generatedAt = FALLBACK.toISOString();
  fresh.cache = { pages: 9, items: 20 };
  await refresh({ cities: ['bonn'], collect: () => fresh });
  const first = await readRisSnapshot(directory, 'bonn');
  expect(first.manifest.provenance).toMatchObject({ builtAt: NOW.toISOString(), sourceVerifiedAt: FALLBACK.toISOString(),
    collection: { pages: 9, rawItems: null, normalizedItems: 2 } });
  const provenance = first.manifest.provenance;
  // Source unavailable: fallback adds only failure metadata, never rewrites facts.
  await refresh({ cities: ['bonn'], collect: () => { throw new Error('source unavailable'); } });
  expect((await readRisSnapshot(directory, 'bonn')).manifest.provenance).toEqual(provenance);
  await fs.mkdir(published, { recursive: true });
  for (const file of await fs.readdir(directory)) await fs.copyFile(path.join(directory, file), path.join(published, file));
  const originalBytes = await fs.readFile(path.join(published, 'bonn.json'));
  await refresh({ cities: ['bonn'], restoreOnly: true, collect: () => { throw new Error('must not collect'); } });
  expect(await fs.readFile(path.join(directory, 'bonn.json'))).toEqual(originalBytes);
});

test.each([false, true])('local v1 migration/reassessment preserves optional acquisition facts (reassess=%s)', async reassess => {
  const { collectionProvenance } = require('../../server/political-context/services/risProvenance');
  const c = reassess ? legacyCatalogue('bonn') : catalogue('bonn');
  const p = collectionProvenance({ catalogue: c, city: 'bonn', records: c.records, sourceRecords: c.records,
    sourceVerifiedAt: FRESH.toISOString(), now: FRESH });
  // Write explicit v1 so the ordinary migration and reassessment paths both run.
  await writeSnapshot(published, 'bonn', { ...c, provenance: p }, { now: FRESH, schemaVersion: 1 });
  await refresh({ cities: ['bonn'], collect: () => { throw new Error('source unavailable'); } });
  const m = (await readRisSnapshot(directory, 'bonn')).manifest;
  expect(m.schemaVersion).toBe(2);
  expect(m.provenance).toMatchObject({ sourceVerifiedAt: FRESH.toISOString(), builtAt: NOW.toISOString(),
    sourceFingerprint: p.sourceFingerprint, collection: p.collection, rights: p.rights });
});

test('even an available cached source detail constrains source verification without an unavailable-detail warning', async () => {
  const next = catalogue('hannover');
  next.generatedAt = FRESH.toISOString();
  next.records[0].detailVerifiedAt = FALLBACK.toISOString();
  await refresh({ cities: ['hannover'], collect: () => next });
  const m = (await readRisSnapshot(directory, 'hannover')).manifest;
  expect(m.generatedAt).toBe(FALLBACK.toISOString());
  expect(m.provenance.sourceVerifiedAt).toBe(FALLBACK.toISOString());
  expect(m.provenance.builtAt).toBe(NOW.toISOString());
  expect(m.coverage.warnings.join(' ')).not.toMatch(/Nicht aktuell verfügbare Details/);
});

test('local migration keeps historical provenance absent when it was never recorded', async () => {
  await writeRisSnapshot(published, 'bonn', legacyCatalogue('bonn'), { now: FRESH });
  await refresh({ cities: ['bonn'], collect: () => { throw new Error('source unavailable'); } });
  const m = (await readRisSnapshot(directory, 'bonn')).manifest;
  expect(m.schemaVersion).toBe(2);
  expect(m.generatedAt).toBe(FRESH.toISOString());
  expect(m).not.toHaveProperty('provenance');
});


test.each([false, true])('local v1 migration/reassessment preserves source statuses and direct timeline facts (reassess=%s)', async reassess => {
  const c = reassess ? legacyCatalogue('bonn') : catalogue('bonn');
  c.sourceStatuses=[{source:'bonn',status:'partial',url:OFFICIAL.bonn,retrievedAt:FRESH.toISOString(),from:null,to:null,recordCount:2,message:'Öffentliche Quelle'}];
  const events=[{date:'2026-10-15',body:'Rat',outcome:'Vertagt',url:OFFICIAL.bonn,evidence:'15.10.2026 Rat Vertagt'}];
  const relationships=[{type:'related',targetId:'bonn:2',targetUrl:c.records[1].url,label:'Amtlicher Bezug',targetRole:null,evidence:'Amtlicher Bezug'}];
  const sourceContext={level:'city',publisher:'Bonn',issuer:null,documentKind:'Vorlage',status:'proposal',publicationDate:null,documentDate:'2026-10-15',meetingDate:null};
  Object.assign(c.records[0],{events,relationships,sourceContext,originalPdfUrl:OFFICIAL.bonn+'/original.pdf'});
  await writeSnapshot(published,'bonn',c,{now:FRESH,schemaVersion:1});
  await refresh({cities:['bonn'],collect:()=>{throw new Error('source unavailable');}});
  const result=await readRisSnapshot(directory,'bonn');
  expect(result.manifest.sourceStatuses).toEqual(c.sourceStatuses);
  expect(result.manifest.generatedAt).toBe(FRESH.toISOString());
  expect(result.records[0]).toMatchObject({events,relationships,sourceContext,originalPdfUrl:OFFICIAL.bonn+'/original.pdf'});
  expect(result.records[1]).not.toHaveProperty('events');
});

test('historical supplementary records omitted by a fresh rolling window retain their old verification clock', async () => {
  const prior = catalogue('hannover');
  prior.records[0].id = 'landtag:historic';
  prior.records[0].source = 'niedersachsen-landtag';
  await writeRisSnapshot(published, 'hannover', prior, { now: STALE });
  const current = { ...catalogue('hannover'), records: [prior.records[1]], generatedAt: NOW.toISOString(),
    history: { pending: false, interrupted: false } };
  const outcome = await refresh({ cities: ['hannover'], collect: () => current });
  expect(outcome).toMatchObject([{ status: 'published' }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.records.map(r => r.id)).toContain('landtag:historic');
  expect(result.manifest.generatedAt).toBe(STALE.toISOString());
  expect(result.manifest.coverage.warnings.join(' ')).toMatch(/ältere Datensätze.*verifizierten Stand/i);
});
