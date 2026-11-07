/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { readRisSnapshot, writeRisSnapshot } = require('../../server/political-context/services/risSnapshot');
const { refreshRisCatalogues, validateRisDirectory } = require('../../scripts/refresh-ris-catalogues');

const NOW = new Date('2026-11-07T10:00:00.000Z');
const OLD = new Date('2026-10-20T09:00:00.000Z');
const FRESH = new Date('2026-11-03T09:00:00.000Z');
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

function catalogue(city, { count = 2, from = '2026-01-02', to = '2026-10-15', complete = city === 'bonn', body } = {}) {
  const gremium = body || (city === 'bonn' ? 'Bonn' : 'Ratsversammlung');
  return {
    sources: [OFFICIAL[city]],
    coverage: { from, to, bodies: [gremium], complete, warnings: complete ? [] : ['Amtliche Auswahl.'] },
    records: Array.from({ length: count }, (_, i) => ({
      id: `${city}:${i + 1}`, title: `Radverkehr ${i + 1}`, number: `${i + 1}/2026`, type: 'Antrag',
      date: to, gremium, url: `${new URL(OFFICIAL[city]).origin}/paper/${i + 1}`, source: city,
      ...(i === 0 ? { geometry: { type: 'Point', coordinates: [9.73, 52.37] }, locationSource: 'official' } : {}),
    })),
  };
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
  const prior = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: OLD });
  const outcomes = await refresh({
    restoreOnly: true, cities: ['bonn'], collect: () => catalogue('bonn', { count: 7 }),
  });
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'restored', generatedAt: OLD.toISOString() }]);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
});

test('restore-only reports the missing city and still restores the available one', async () => {
  const prior = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: OLD });
  await expect(refresh({ restoreOnly: true, collect: city => catalogue(city) }))
    .rejects.toThrow(/hannover.*no deployed snapshot/i);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
  await expect(readRisSnapshot(directory, 'hannover')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('a source failure preserves the old city while an independent city publishes', async () => {
  const prior = await writeRisSnapshot(directory, 'bonn', catalogue('bonn'), { now: OLD });
  const outcomes = await refresh({
    collect: city => {
      if (city === 'bonn') throw new Error('OParl HTTP 503');
      return catalogue('hannover');
    },
  });
  expect(outcomes).toMatchObject([
    { city: 'bonn', status: 'retained', generatedAt: OLD.toISOString(), reason: 'OParl HTTP 503' },
    { city: 'hannover', status: 'published', generatedAt: NOW.toISOString() },
  ]);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
  expect((await readRisSnapshot(directory, 'hannover')).records).toHaveLength(2);
});

test.each([
  ['unverified completeness', { complete: false }],
  ['a shortened historical range', { from: '2026-07-01' }],
  ['a loss of recent coverage', { to: '2026-10-01' }],
  ['a missing historical council', { body: 'Ein anderes Gremium' }],
  ['a large loss of indexed records', { count: 1 }],
])('retains the deployed snapshot for %s', async (_name, changed) => {
  const prior = await writeRisSnapshot(published, 'bonn', catalogue('bonn', { count: 4 }), { now: OLD });
  const outcomes = await refresh({
    cities: ['bonn'], collect: () => catalogue('bonn', { count: 4, ...changed }),
  });
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'retained', generatedAt: OLD.toISOString() }]);
  expect((await readRisSnapshot(directory, 'bonn')).manifest).toEqual(prior);
});

test('omits a first-time city with an unavailable source rather than manufacturing an empty snapshot', async () => {
  const outcomes = await refresh({ cities: ['bonn'], collect: () => ({ ...catalogue('bonn'), records: [] }) });
  expect(outcomes).toMatchObject([{ city: 'bonn', status: 'unavailable' }]);
  expect(await validateRisDirectory(directory)).toEqual([]);
});

test('fails closed if the previously deployed city is damaged and its source is unavailable', async () => {
  const manifest = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: OLD });
  await expect(refresh({
    cities: ['bonn'], fetchPublished: fetchPages({ tamper: manifest.map.path }),
    collect: () => { throw new Error('OParl HTTP 503'); },
  })).rejects.toThrow(/bonn.*OParl HTTP 503/i);
  expect(await validateRisDirectory(directory)).toEqual([]);
});

test('does not fetch a foreign asset URL supplied by a deployed manifest', async () => {
  const manifest = await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: OLD });
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
  const manifest = await writeRisSnapshot(directory, 'bonn', catalogue('bonn'), { now: OLD });
  await expect(validateRisDirectory(directory)).resolves.toMatchObject([{ city: 'bonn' }]);
  await fs.writeFile(path.join(directory, manifest.map.path), 'not a gzip file');
  await expect(validateRisDirectory(directory)).rejects.toThrow(/map gzip/i);
  await fs.rm(path.join(directory, manifest.map.path));
  await expect(validateRisDirectory(directory)).rejects.toThrow(/missing.*map asset/i);
});

test('production artifact validation requires both city snapshots', async () => {
  await writeRisSnapshot(directory, 'bonn', catalogue('bonn'), { now: OLD });
  await expect(validateRisDirectory(directory, { requireAll: true })).rejects.toThrow(/missing.*hannover/i);
  await writeRisSnapshot(directory, 'hannover', catalogue('hannover'), { now: OLD });
  await expect(validateRisDirectory(directory, { requireAll: true })).resolves.toMatchObject([
    { city: 'bonn' }, { city: 'hannover' },
  ]);
});
