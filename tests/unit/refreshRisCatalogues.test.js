/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const { readRisSnapshot, writeRisSnapshot: writeSnapshot } = require('../../server/political-context/services/risSnapshot');
const { refreshRisCatalogues, validateRisDirectory, collectOfficial, parseRefreshArguments } = require('../../scripts/refresh-ris-catalogues');
const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
const { composeHannoverCatalogue } = require('../../server/political-context/providers/hannoverCatalogueComposition');
const { combineHannoverCatalogues } = require('../../server/political-context/providers/hannoverCatalogue');
const { parseProposalHtml } = require('../../server/political-context/providers/regionHannoverCatalogue');

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
  return writeSnapshot(folder, city, value, { ...options, schemaVersion: value.locationRevision >= 3 ? 2 : 1 });
}

function catalogue(city, { count = 2, from = city === 'hannover' ? '2014-01-01' : '2026-01-02', to = '2026-10-15', complete = city === 'bonn', body } = {}) {
  const gremium = body || (city === 'bonn' ? 'Bonn' : 'Ratsversammlung');
  return {
    locationRevision: city === 'hannover' ? 9 : 5,
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
  return refreshRisCatalogues({ directory, now: NOW, fetchPublished: fetchPages(), historyStartYear: 2014, ...options });
}

describe('Pages refresh duration budget', () => {
  const minute = 60_000;

  test('parses the overall duration separately from the source duration', () => {
    expect(parseRefreshArguments(['--max-refresh-duration-ms', '3900000', '--max-duration-ms', '600000']))
      .toEqual({ maxRefreshDurationMs: 65 * minute, maxDurationMs: 10 * minute });
    expect(() => parseRefreshArguments(['--max-refresh-duration-ms', '3900000', '--max-refresh-duration-ms', '3900000']))
      .toThrow(/Usage/);
  });

  test.each([0, -1, 1.5, Infinity])('rejects an invalid overall duration (%s)', async maxRefreshDurationMs => {
    await expect(refresh({ cities: ['hannover'], maxRefreshDurationMs, collect: async () => catalogue('hannover') }))
      .rejects.toThrow(/refresh.*duration/i);
  });

  test.each([undefined, 10 * minute])('counts eleven minutes of restore time while keeping the source clock fixed (source cap %s)', async maxDurationMs => {
    await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FALLBACK });
    const elapsed = jest.spyOn(performance, 'now').mockReturnValue(0);
    const fetchPage = fetchPages();
    const collect = jest.fn(async () => catalogue('hannover'));
    try {
      await expect(refresh({ cities: ['hannover'], maxRefreshDurationMs: 65 * minute, maxDurationMs, collect,
        fetchPublished: async (...args) => {
          const response = await fetchPage(...args);
          elapsed.mockReturnValue(11 * minute);
          return response;
        },
      })).resolves.toMatchObject([{ status: 'published' }]);
      expect(collect).toHaveBeenCalledWith('hannover', NOW, expect.objectContaining({
        maxDurationMs: maxDurationMs ?? 47 * minute, workerTimeoutMs: 49 * minute,
      }));
      expect((await readRisSnapshot(directory, 'hannover')).manifest.generatedAt).toBe(NOW.toISOString());
    } finally {
      elapsed.mockRestore();
    }
  });

  test('retains the verified fallback and its original age when restore exhausts the source budget', async () => {
    const prior = await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FALLBACK });
    const elapsed = jest.spyOn(performance, 'now').mockReturnValue(0);
    const fetchPage = fetchPages();
    const collect = jest.fn(async () => catalogue('hannover'));
    try {
      await expect(refresh({ cities: ['hannover'], maxRefreshDurationMs: 65 * minute, collect,
        fetchPublished: async (...args) => {
          const response = await fetchPage(...args);
          elapsed.mockReturnValue(58 * minute);
          return response;
        },
      })).resolves.toMatchObject([{ status: 'retained', generatedAt: prior.generatedAt, reason: expect.stringMatching(/budget/i) }]);
      expect(collect).not.toHaveBeenCalled();
      const { manifest, records } = await readRisSnapshot(directory, 'hannover');
      expect(records).toHaveLength(2);
      expect(manifest.generatedAt).toBe(prior.generatedAt);
      expect(manifest.refreshFailure).toMatchObject({ attemptedAt: NOW.toISOString(), expiresAt: EXPIRY.toISOString() });
    } finally {
      elapsed.mockRestore();
    }
  });
});

const checkpointRetry = { city: 'hannover', sourceCacheKey: 'ris-sources-v1-Linux-42502618892-1', minimumRecords: 3 };

function unknownSimComposition(withSupplement) {
  const city = catalogue('hannover', { count: 3 });
  const url = 'https://www.landtag-niedersachsen.de/dokumentensuche/';
  const additional = { records: withSupplement ? [{ ...city.records[1], id: 'landtag:19-8980',
    source: 'niedersachsen-landtag', url }] : [], sourceStatuses: withSupplement ? [{ source: 'landtag-catalogue',
    status: 'partial', url, retrievedAt: FRESH.toISOString(), from: null, to: null, recordCount: 1, message: 'Partial source' }] : [] };
  return composeHannoverCatalogue(city, additional, { now: NOW });
}

test.each([false, true])('unknown SIM clocks cannot publish using now or supplementary freshness (supplement=%s)', async withSupplement => {
  const incoming = unknownSimComposition(withSupplement);
  expect(incoming.sourceStatuses[0].retrievedAt).toBeNull();
  await expect(refresh({ cities: ['hannover'], collect: async () => incoming }))
    .resolves.toMatchObject([{ status: 'unavailable', reason: expect.stringMatching(/SIM.*verified.*timestamp/i) }]);
  await expect(readRisSnapshot(directory, 'hannover')).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([false, true])('unknown SIM clocks retain the valid previous snapshot and its age (supplement=%s)', async withSupplement => {
  const prior = await writeRisSnapshot(directory, 'hannover', catalogue('hannover', { count: 3 }), { now: FALLBACK });
  const before = await readRisSnapshot(directory, 'hannover');
  await expect(refresh({ cities: ['hannover'], collect: async () => unknownSimComposition(withSupplement) }))
    .resolves.toMatchObject([{ status: 'retained', generatedAt: prior.generatedAt,
      reason: expect.stringMatching(/SIM.*verified.*timestamp/i) }]);
  const after = await readRisSnapshot(directory, 'hannover');
  expect(after.manifest).toEqual({ ...prior,
    sources: [...prior.sources, 'https://ris.hannit.de/public/vo040'],
    sourceStatuses: [expect.objectContaining({ source: 'region-hannover-ris', status: 'failed', retrievedAt: null, recordCount: 0 })],
    refreshFailure: { attemptedAt: NOW.toISOString(), expiresAt: EXPIRY.toISOString(), reason: expect.any(String) },
  });
  expect(after.records).toEqual(before.records);
});

test('checkpoint recovery with unknown SIM time fails instead of reporting a retained snapshot as recovered', async () => {
  const prior = await writeRisSnapshot(directory, 'hannover', catalogue('hannover', { count: 3 }), { now: FALLBACK });
  await expect(refresh({ cities: ['hannover'], checkpointRetry, collect: async () => unknownSimComposition(true) }))
    .rejects.toThrow(/recovery.*SIM.*verified.*timestamp/i);
  expect((await readRisSnapshot(directory, 'hannover')).manifest).toEqual(prior);
});

test('explicit checkpoint recovery bypasses only source retry backoff and forces zero source work', async () => {
  const prior = await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FALLBACK });
  prior.refreshFailure = { attemptedAt: NOW.toISOString(), reason: 'Amtlicher Abruf fehlgeschlagen.', expiresAt: EXPIRY.toISOString() };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const collect = jest.fn((city, now, options) => {
    expect(options).toMatchObject({ workBudget: 0, checkpointOnly: true });
    return { ...catalogue(city, { count: 3 }), history: { pending: true, interrupted: true } };
  });
  await expect(refresh({ cities: ['hannover'], checkpointRetry, collect })).resolves.toMatchObject([
    { status: 'published', records: 3 },
  ]);
  expect(collect).toHaveBeenCalledTimes(1);
  await expect(refresh({ cities: ['hannover'], checkpointRetry, workBudget: 1, collect })).rejects.toThrow(/zero|0/);
});

test.each(['too-small', 'failed', 'expired', 'narrower'])('checkpoint recovery fails closed for a %s candidate instead of accepting retention', async problem => {
  await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FALLBACK });
  const collect = () => {
    if (problem === 'failed') throw new Error('Missing Hannover checkpoint');
    const next = catalogue('hannover', { count: problem === 'too-small' ? 2 : 3,
      ...(problem === 'narrower' ? { from: '2020-01-01' } : {}) });
    if (problem === 'expired') next.generatedAt = OLD.toISOString();
    return next;
  };
  await expect(refresh({ cities: ['hannover'], checkpointRetry, collect })).rejects.toThrow(/recovery/i);
  await expect(fs.readFile(path.join(directory, 'hannover.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('checkpoint recovery restores Bonn without collecting it', async () => {
  await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: FRESH });
  await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FALLBACK });
  const collect = jest.fn(city => {
    expect(city).toBe('hannover');
    return catalogue(city, { count: 3 });
  });
  await expect(refresh({ checkpointRetry, collect })).resolves.toMatchObject([
    { city: 'bonn', status: 'restored' }, { city: 'hannover', status: 'published', records: 3 },
  ]);
  expect(collect).toHaveBeenCalledTimes(1);
});

test('checkpoint-only collection requires every historical year and never queries official sources', async () => {
  const sourceDirectory = path.join(root, 'source-cache');
  const options = { sourceDirectory, checkpointOnly: true, workBudget: 0, historyStartYear: 2014 };
  await expect(collectOfficial('hannover', NOW, options)).rejects.toThrow(/checkpoint/i);
  const checkpoint = createRisSourceCheckpoint({ directory: sourceDirectory });
  for (let year = 2014; year < NOW.getUTCFullYear(); year++) {
    const data = catalogue('hannover', { count: 3 });
    data.records.forEach(record => { record.detailVerifiedAt = FRESH.toISOString(); });
    await checkpoint.write('hannover-sim', 'public-year-search:true', year, 'sim-history-v1', { catalogue: data });
  }
  await expect(collectOfficial('hannover', NOW, options)).rejects.toThrow(/checkpoint.*2026/i);
  const latest = catalogue('hannover', { count: 3 });
  latest.records.forEach(record => { record.detailVerifiedAt = FRESH.toISOString(); });
  await checkpoint.write('hannover-sim', 'public-year-search:true', 2026, 'sim-history-v1', { catalogue: latest });
  const externalFetch = jest.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Unexpected source fetch'); });
  const externalHttps = jest.spyOn(require('node:https'), 'get').mockImplementation(() => { throw new Error('Unexpected source HTTPS'); });
  try {
    // A SIM-only recovery must not silently drop the now-required region.
    await expect(collectOfficial('hannover', NOW, options)).rejects.toThrow(/Region Hannover.*usable/);
    const html = await fs.readFile(path.join(__dirname, '../fixtures/region-hannover/proposal-answer.html'), 'utf8');
    const detail = parseProposalHtml(html, 'https://ris.hannit.de/public/vo020?VOLFDNR=2007454&refresh=false');
    await checkpoint.write('region-hannover-ris', 'public-proposals', 2026, 'region-hannover-public-v1', { records: [{
      metadata: { ...detail, date: '2026-11-06', sourceContext: { ...detail.sourceContext, publicationDate: '2026-11-06' } },
      metadataVerifiedAt: NOW.toISOString(), detail, detailVerifiedAt: NOW.toISOString(),
    }] });
    const next = await collectOfficial('hannover', NOW, { ...options, previousCoverage: { from: '2004-01-01' },
      previousSourceStatuses: [{ source: 'hannover-sim', from: '2014-01-01' },
        { source: 'region-hannover-ris', from: '2004-01-01', recordCount: 1 }] });
    expect(next.records).toHaveLength(4);
    expect(next.history.pending).toBe(true);
    expect(next.sourceStatuses.find(status => status.source === 'hannover-sim').retrievedAt).toBe(FRESH.toISOString());
    expect(next.generatedAt).toBe(FRESH.toISOString());
    expect(externalFetch).not.toHaveBeenCalled();
    expect(externalHttps).not.toHaveBeenCalled();
  } finally { externalFetch.mockRestore(); externalHttps.mockRestore(); }
});

test('expands the published Hannover SIM range to the earliest offered year by default', async () => {
  const previous = catalogue('hannover');
  await writeRisSnapshot(published, 'hannover', previous, { now: FRESH });
  const collect = jest.fn(async () => catalogue('hannover', { count: 3, from: '1999-01-01' }));
  const [outcome] = await refresh({ cities: ['hannover'], historyStartYear: undefined, collect });
  expect(collect).toHaveBeenCalledWith('hannover', NOW, expect.objectContaining({ historyStartYear: 1999 }));
  expect(outcome).toMatchObject({ status: 'published', records: 3 });
  expect((await readRisSnapshot(directory, 'hannover')).manifest.coverage.from).toBe('1999-01-01');
});

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

test.each([502, 503, 504])('restores an unchanged v2 snapshot after a required links asset returns HTTP %s once', async status => {
  const prior = await writeRisSnapshot(published, 'bonn', {
    ...catalogue('bonn'), withdrawalsRecordedAt: FRESH.toISOString(),
  }, { now: FRESH });
  const before = await readRisSnapshot(published, 'bonn');
  const serve = fetchPages();
  const linksRequests = [];
  let rejectedResponse;
  const fetchPublished = async (url, options) => {
    if (url.endsWith('.links.json.gz')) {
      linksRequests.push({ url, ...options });
      if (linksRequests.length === 1) {
        rejectedResponse = new Response('Temporary upstream failure', { status });
        return rejectedResponse;
      }
    }
    return serve(url, options);
  };
  const collect = jest.fn(() => { throw new Error('A fresh fallback must not refresh the source'); });
  await expect(refresh({ cities: ['bonn'], restoreOnly: true, fetchPublished, collect }))
    .resolves.toMatchObject([{ status: 'restored', generatedAt: FRESH.toISOString() }]);
  const after = await readRisSnapshot(directory, 'bonn');
  expect(after).toEqual(before);
  expect(after.manifest).toEqual(prior);
  expect(linksRequests).toHaveLength(2);
  expect(linksRequests[1]).toMatchObject({ url: linksRequests[0].url,
    redirect: 'error', credentials: 'omit', cache: 'force-cache' });
  expect(linksRequests[1].signal).not.toBe(linksRequests[0].signal);
  expect(rejectedResponse.body.locked).toBe(false);
  expect(await rejectedResponse.body.getReader().read()).toEqual({ done: true, value: undefined });
  expect(collect).not.toHaveBeenCalled();
});

test('fails closed after three transient responses for a required v2 links asset', async () => {
  await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: FRESH });
  const serve = fetchPages();
  const rejectedResponses = [];
  const fetchPublished = async (url, options) => {
    if (url.endsWith('.links.json.gz')) {
      const response = new Response('Unavailable', { status: 503 });
      rejectedResponses.push(response);
      return response;
    }
    return serve(url, options);
  };
  await expect(refresh({ cities: ['bonn'], restoreOnly: true, fetchPublished })).rejects.toThrow(/HTTP 503/);
  expect(rejectedResponses).toHaveLength(3);
  for (const response of rejectedResponses) {
    expect(await response.body.getReader().read()).toEqual({ done: true, value: undefined });
  }
  await expect(fs.readFile(path.join(directory, 'bonn.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each([
  ['HTTP 404', () => new Response(null, { status: 404 }), /HTTP 404/],
  ['HTTP 500', () => new Response(null, { status: 500 }), /HTTP 500/],
  ['rejected request', () => { throw new Error('Network rejected'); }, /Network rejected/],
  ['corrupt content', () => new Response('damaged'), /hash|digest|checksum|size|bytes/i],
  ['oversized content', () => new Response(Buffer.alloc(16 * 1024 * 1024 + 1)), /size limit/],
])('does not retry a required v2 links asset with %s', async (_failure, respond, expectedError) => {
  await writeRisSnapshot(published, 'bonn', catalogue('bonn'), { now: FRESH });
  const serve = fetchPages();
  let requests = 0;
  const fetchPublished = async (url, options) => {
    if (url.endsWith('.links.json.gz')) {
      requests++;
      return respond();
    }
    return serve(url, options);
  };
  await expect(refresh({ cities: ['bonn'], restoreOnly: true, fetchPublished })).rejects.toThrow(expectedError);
  expect(requests).toBe(1);
  await expect(fs.readFile(path.join(directory, 'bonn.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('does not retry a missing published manifest', async () => {
  const fetchPublished = jest.fn(async () => new Response(null, { status: 404 }));
  await expect(refresh({ cities: ['bonn'], restoreOnly: true, fetchPublished })).rejects.toThrow(/No deployed snapshot/);
  expect(fetchPublished).toHaveBeenCalledTimes(1);
  await expect(fs.readFile(path.join(directory, 'bonn.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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
  expect(manifest.locationRevision).toBe(9);
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

test.each([false, true])('a successful cached Region upgrade wins over an old deployed failure with the same source clock (legacyPortalLink=%s)', async legacyPortalLink => {
  const cityOnly = catalogue('hannover');
  if (legacyPortalLink) cityOnly.sources.push('https://ris.hannit.de/public/');
  const prior = await writeRisSnapshot(published, 'hannover', cityOnly, { now: FRESH });
  prior.refreshFailure = { attemptedAt: new Date(NOW.getTime() - 30 * 60_000).toISOString(),
    expiresAt: new Date(FRESH.getTime() + 14 * 86400000).toISOString(), reason: 'Früherer SIM-Abruf fehlgeschlagen.' };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const current = regionalCatalogue();
  current.generatedAt = FRESH.toISOString();
  const collect = jest.fn(() => current);
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'published', records: 3 }]);
  collect.mockImplementation(() => { throw new Error('Source temporarily unavailable'); });
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'current', records: 3 }]);
  expect(collect).toHaveBeenCalledTimes(1);
});

test.each([false, true].flatMap(fallback => [0, 1].flatMap(remaining => [FALLBACK, FRESH].map(localClock => [fallback, remaining, localClock]))))
('a deployed withdrawal outranks a local snapshot verified before the removal (fallback=%s, remaining=%s, local=%s)', async (fallback, remaining, localClock) => {
  const prior = regionalCatalogue();
  Object.assign(prior.records[2], { geometry: { type: 'Point', coordinates: [9.75, 52.38] }, locationSource: 'official',
    locationAssessment: { status: 'mapped', sources: ['official'], reasons: [], truncated: false } });
  if (remaining) prior.records.push({ ...prior.records[2], id: 'region-hannover-ris:vo:2003038',
    url: 'https://ris.hannit.de/public/vo020?VOLFDNR=2003038' });
  prior.sourceStatuses[0].recordCount = 1 + remaining;
  await writeRisSnapshot(directory, 'hannover', prior, { now: localClock });
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const exclusions = [{ id: prior.records[2].id, url: prior.records[2].url,
    verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  const withdrawn = regionalCatalogue();
  withdrawn.records = prior.records.filter(record => record.id !== prior.records[2].id);
  withdrawn.sourceStatuses[0].recordCount = remaining;
  withdrawn.generatedAt = FALLBACK.toISOString();
  withdrawn.exclusions = exclusions;
  await refresh({ directory: published, cities: ['hannover'], fetchPublished: async () => new Response(null, { status: 404 }),
    collect: () => { if (fallback) throw Object.assign(new Error('SIM unavailable'), { exclusions }); return withdrawn; } });
  const deployed = await readRisSnapshot(published, 'hannover');
  expect(deployed.records).toHaveLength(2 + remaining);
  expect(deployed.manifest.generatedAt).toBe(FALLBACK.toISOString());
  expect(deployed.manifest.withdrawalsRecordedAt).toBe(NOW.toISOString());
  const collect = jest.fn(() => { throw new Error('Source temporarily unavailable'); });
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ records: 2 + remaining }]);
  if (fallback) expect(collect).not.toHaveBeenCalled();
  const restored = await readRisSnapshot(directory, 'hannover');
  expect(restored.records.some(record => record.id === prior.records[2].id)).toBe(false);
  expect(restored.features.features.some(feature => feature.properties.recordId === prior.records[2].id)).toBe(false);
  expect(restored.manifest.withdrawalsRecordedAt).toBe(NOW.toISOString());
});

test.each([1, 2])('withdrawal ordering metadata roundtrips in snapshot v%s and rejects invalid timestamps', async schemaVersion => {
  const value = { ...regionalCatalogue(), withdrawalsRecordedAt: NOW.toISOString() };
  await writeSnapshot(directory, 'hannover', value, { now: FALLBACK, schemaVersion });
  expect((await readRisSnapshot(directory, 'hannover')).manifest.withdrawalsRecordedAt).toBe(NOW.toISOString());
  for (const invalid of ['not-a-date', NOW.toISOString().replace('.000Z', 'Z')]) {
    await expect(writeSnapshot(directory, 'hannover', { ...value, withdrawalsRecordedAt: invalid }, { now: NOW, schemaVersion }))
      .rejects.toThrow(/timestamp|withdrawal/i);
  }
  const manifestPath = path.join(directory, 'hannover.json');
  const malformed = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  malformed.withdrawalsRecordedAt = NOW.toISOString().replace('.000Z', 'Z');
  await fs.writeFile(manifestPath, JSON.stringify(malformed));
  await expect(readRisSnapshot(directory, 'hannover')).rejects.toThrow(/timestamp|withdrawal/i);
});

test.each([false, true])('a withdrawal yields only to a source verified after the removal (verifiedAfter=%s)', async verifiedAfter => {
  const withdrawn = regionalCatalogue();
  withdrawn.records = withdrawn.records.slice(0, 2);
  withdrawn.sourceStatuses[0].recordCount = 0;
  withdrawn.withdrawalsRecordedAt = NOW.toISOString();
  await writeRisSnapshot(directory, 'hannover', withdrawn, { now: FALLBACK });
  const nextDay = new Date(NOW.getTime() + 86400000);
  await writeRisSnapshot(published, 'hannover', regionalCatalogue(), { now: verifiedAfter ? nextDay : FRESH });
  await expect(refresh({ cities: ['hannover'], now: nextDay, collect: () => { throw new Error('Source unavailable'); } }))
    .resolves.toMatchObject([{ records: verifiedAfter ? 3 : 2 }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.records.some(record => record.source === 'region-hannover-ris')).toBe(verifiedAfter);
});

test('a later source collection preserves the withdrawal ordering timestamp without renewing it', async () => {
  const prior = regionalCatalogue();
  prior.withdrawalsRecordedAt = FRESH.toISOString();
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  await refresh({ cities: ['hannover'], collect: () => regionalCatalogue() });
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.manifest.generatedAt).toBe(NOW.toISOString());
  expect(result.manifest.withdrawalsRecordedAt).toBe(FRESH.toISOString());
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

test('pending regional details continue the next day even when the shared snapshot is still fresh', async () => {
  await writeRisSnapshot(published, 'hannover', catalogue('hannover'), { now: FRESH });
  const collect = jest.fn((_city, now) => {
    const current = regionalCatalogue();
    current.generatedAt = now.toISOString();
    current.history = { pending: true, interrupted: true, retainPreviousClock: false, pendingYears: [2026] };
    current.records[2].locationEvidenceUnavailable = true;
    return current;
  });
  await expect(refresh({ cities: ['hannover'], collect })).resolves.toMatchObject([{ status: 'published' }]);
  const nextDay = new Date(NOW.getTime() + 86400000);
  await expect(refresh({ cities: ['hannover'], now: nextDay, collect }))
    .resolves.toMatchObject([{ status: 'published', generatedAt: nextDay.toISOString() }]);
  expect(collect).toHaveBeenCalledTimes(2);
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
  expect(manifest.locationRevision).toBe(5);
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
    coverage: prior.coverage, locationRevision: city === 'hannover' ? 9 : 5,
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

test('backfills counts on a retained v2 manifest without rebuilding its partitions or contacting the source', async () => {
  const value = catalogue('bonn');
  for (const record of value.records) record.source = 'bonn-oparl';
  const prior = await writeRisSnapshot(published, 'bonn', value, { now: FRESH });
  delete prior.levelCounts;
  await fs.writeFile(path.join(published, 'bonn.json'), JSON.stringify(prior));
  const collect = jest.fn(() => { throw new Error('A recent retained catalogue needs no source request'); });

  await refresh({ cities: ['bonn'], collect });

  const { manifest } = await readRisSnapshot(directory, 'bonn');
  expect(manifest).toEqual({ ...prior, levelCounts: { city: { records: 2, mapped: 1 } } });
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
    coverage: prior.coverage, sources: prior.sources, locationRevision: 5,
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
    locationRevision: 5, locationAssessment: prior.locationAssessment, coverage: prior.coverage, sources: prior.sources });
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

test.each(['official', 'derived', 'relation'])('assesses retained legacy %s evidence before publishing new historical records', async evidenceKind => {
  const priorData = legacyCatalogue('hannover');
  const priorRecord = priorData.records[0];
  priorRecord.relatedTo = priorData.records[1].id;
  priorRecord.title = 'Radverkehr in der Limmerstraße';
  if (evidenceKind !== 'official') {
    delete priorRecord.geometry;
    delete priorRecord.locationSource;
  }
  if (evidenceKind === 'derived') priorRecord.locations = [{
    kind: 'street', label: 'Limmerstraße', extent: 'part', attribution: 'LGLN, dl-de/by-2-0',
    evidence: { source: 'document', text: 'Der Radweg in der Limmerstraße wird erneuert.' },
    geometry: { type: 'LineString', coordinates: [[9.71, 52.37], [9.72, 52.37]] },
  }];
  const prior = await writeRisSnapshot(directory, 'hannover', priorData, { now: FALLBACK });
  const before = await readRisSnapshot(directory, 'hannover');
  expect(before.records.every(record => !record.locationAssessment)).toBe(true);

  const next = catalogue('hannover', { count: 3 });
  next.records = [{ id: priorRecord.id, title: 'Aktualisierter amtlicher Listentitel ohne Ortsbezug',
    number: '1/2026', type: 'Anfrage', date: '2026-11-06', gremium: null,
    url: priorRecord.url, source: 'hannover', locationEvidence: [], locationEvidenceUnavailable: true }, next.records[2]];
  next.history = { pending: true, interrupted: false };
  const outcome = await refresh({ cities: ['hannover'], collect: () => next });
  expect(outcome[0].reason).toBeUndefined();
  expect(outcome).toMatchObject([{ status: 'published', records: 3, generatedAt: prior.generatedAt }]);

  const after = await readRisSnapshot(directory, 'hannover');
  const retained = after.records.find(record => record.id === priorRecord.id);
  expect(after.manifest.locationAssessment.attempted).toBe(3);
  expect(after.records.every(record => record.locationAssessment)).toBe(true);
  expect(after.manifest.coverage.complete).toBe(false);
  expect(after.manifest.refreshFailure).toBeUndefined();
  expect(retained).toMatchObject({ title: next.records[0].title, relatedTo: priorRecord.relatedTo,
    locationAssessment: {
      status: 'partial',
      reasons: expect.arrayContaining(['document_text_unavailable']),
    } });
  expect(retained.locations).toEqual(evidenceKind === 'derived' ? before.records[0].locations : [{
    kind: 'street', label: 'Limmerstraße', mapped: true, evidence: { source: 'title', text: priorRecord.title },
  }]);
  expect(retained.locationAssessment.truncated).toBe(evidenceKind === 'derived');
  expect(retained.locationAssessment.sources.includes('official')).toBe(evidenceKind === 'official');
  expect(retained.locationAssessment.sources.includes('document')).toBe(evidenceKind === 'derived');
  expect(after.features.features.filter(feature => feature.properties.recordId === priorRecord.id))
    .toEqual(expect.arrayContaining(before.features.features.filter(feature => feature.properties.recordId === priorRecord.id)));
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

test.each([[6, false], [6, true], [7, false], [7, true], [8, false], [8, true]])('recovers an unmapped revision %s record from dated checkpoint evidence (truncated=%s)', async (revision, truncated) => {
  const previous = catalogue('hannover');
  previous.locationRevision = revision;
  const record = previous.records[1];
  record.title = 'Antwort der Verwaltung auf die Anfrage Geruchsbelästigungen in der Nordstadt';
  record.source = 'hannover-sim';
  record.relatedTo = previous.records[0].id;
  record.locationAssessment.sources = ['title', 'document'];
  const prior = await writeRisSnapshot(directory, 'hannover', previous, { now: FALLBACK });
  const text = 'Das Team Immissionsschutz der Region Hannover hat Nachbarschaftsbeschwerden über Geruchsbelästigungen – verursacht durch die Gaststätte Kebapci Musa in der Gustav-Adolf-Straße 6 -bearbeitet. Es konnte erfolgreich auf den Einbau einer Abluftfilteranlage hingewirkt werden.';
  const context = 'Die Windrichtungsdaten sind für diesen Zeitraum stündlich gemessen worden. Nach Auswertung dieser Daten bleibt festzuhalten, dass für das Jahr 2017 die vorgenannte Grenze von 10% mit für das Kebapci Musa ermittelten 6, 78 % deutlich unterschritten wird.';
  const incoming = { ...previous, generatedAt: NOW.toISOString(), history: { pending: false, interrupted: false },
    records: [previous.records[0], { ...record, title: 'Aktueller Listentitel ohne Ortsangabe', relatedTo: undefined,
      locationEvidence: [text, context], locationEvidenceUnavailable: true,
      locationEvidenceTruncated: truncated, detailVerifiedAt: FALLBACK.toISOString() }] };

  await refresh({ cities: ['hannover'], collect: () => incoming });

  const after = await readRisSnapshot(directory, 'hannover');
  const recovered = after.records.find(item => item.id === record.id);
  expect(recovered).toMatchObject({ title: incoming.records[1].title, relatedTo: record.relatedTo,
    locationAssessment: { status: 'partial', sources: ['title', 'document'], truncated,
      reasons: expect.arrayContaining(['document_text_unavailable']) },
    locations: [{ kind: 'address', label: 'Gustav-Adolf-Straße 6', mapped: true,
      evidence: { source: 'document', text: text.split('. Es konnte')[0] + '.' } }] });
  expect(after.features.features.find(feature => feature.properties.recordId === record.id).geometry)
    .toEqual({ type: 'Point', coordinates: [9.726686, 52.381992] });
  expect(after.manifest).toMatchObject({ locationRevision: 9, generatedAt: prior.generatedAt });
  expect(after.manifest.provenance.sourceVerifiedAt).toBe(prior.generatedAt);
});

test('does not recover an unmapped retained body without its original verification time', async () => {
  const previous = catalogue('hannover');
  previous.locationRevision = 6;
  previous.records[1].locationAssessment.sources = ['title', 'document'];
  const prior = await writeRisSnapshot(directory, 'hannover', previous, { now: FALLBACK });
  const incoming = { ...previous, history: { pending: false, interrupted: false },
    records: [previous.records[0], { ...previous.records[1], locationEvidenceUnavailable: true,
      locationEvidence: ['An der Kreuzung Davenstedter Straße/Südfeldstraße wird eine Ampel errichtet.'] }] };

  await refresh({ cities: ['hannover'], collect: () => incoming });

  const after = await readRisSnapshot(directory, 'hannover');
  expect(after.records[1].locations).toEqual([]);
  expect(after.manifest.generatedAt).toBe(prior.generatedAt);
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
  await writeSnapshot(published, 'bonn', { ...c, provenance: p, withdrawalsRecordedAt: FRESH.toISOString() }, { now: FRESH, schemaVersion: 1 });
  await refresh({ cities: ['bonn'], collect: () => { throw new Error('source unavailable'); } });
  const m = (await readRisSnapshot(directory, 'bonn')).manifest;
  expect(m.schemaVersion).toBe(2);
  expect(m.withdrawalsRecordedAt).toBe(FRESH.toISOString());
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


function unknownSimWithRegion() {
  const city = catalogue('hannover');
  city.records[0].detailVerifiedAt = FRESH.toISOString();
  const combined = regionalCatalogue();
  const region = { records: combined.records.filter(record => record.source === 'region-hannover-ris'),
    sources: ['https://ris.hannit.de/public/vo040'], generatedAt: NOW.toISOString(),
    sourceStatus: combined.sourceStatuses[0], coverage: { ...combined.coverage, scope: undefined } };
  return combineHannoverCatalogues(city, region, { now: NOW });
}

test('fresh ALLRIS evidence cannot publish SIM records with a partly unknown acquisition clock', async () => {
  const next = unknownSimWithRegion();
  expect(next.sourceStatuses.find(source => source.source === 'hannover-sim').retrievedAt).toBeNull();
  await expect(refresh({ cities: ['hannover'], collect: async () => next }))
    .resolves.toMatchObject([{ status: 'unavailable', reason: expect.stringMatching(/SIM.*timestamp/i) }]);
  await expect(readRisSnapshot(directory, 'hannover')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('confirmed ALLRIS withdrawal survives the unknown SIM publication gate without renewing fallback expiry', async () => {
  const prior = regionalCatalogue();
  prior.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const next = unknownSimWithRegion();
  next.exclusions = [{ id: prior.records[2].id, url: prior.records[2].url,
    verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  await expect(refresh({ cities: ['hannover'], collect: async () => next }))
    .resolves.toMatchObject([{ status: 'retained', records: 2, generatedAt: FALLBACK.toISOString(),
      reason: expect.stringMatching(/SIM.*timestamp/i) }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.records.some(record => record.id === prior.records[2].id)).toBe(false);
  expect(result.manifest).toMatchObject({ generatedAt: FALLBACK.toISOString(), withdrawalsRecordedAt: NOW.toISOString(),
    refreshFailure: { expiresAt: EXPIRY.toISOString() } });
  expect(result.manifest.sourceStatuses[0]).toMatchObject({ retrievedAt: FALLBACK.toISOString(), recordCount: 0 });
});

test('offline recovery preserves existing withdrawal ordering and oldest source verification', async () => {
  const prior = regionalCatalogue();
  prior.withdrawalsRecordedAt = FRESH.toISOString();
  prior.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const next = regionalCatalogue();
  next.generatedAt = FALLBACK.toISOString();
  next.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  await expect(refresh({ cities: ['hannover'], checkpointRetry, collect: async () => next }))
    .resolves.toMatchObject([{ status: 'published', generatedAt: FALLBACK.toISOString() }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.manifest.withdrawalsRecordedAt).toBe(FRESH.toISOString());
  expect(result.manifest.generatedAt).toBe(FALLBACK.toISOString());
  expect(result.manifest.sourceStatuses[0].retrievedAt).toBe(FALLBACK.toISOString());
});


function unknownRegionWithSim(explicitStatus = false) {
  const city = { ...catalogue('hannover'), generatedAt: FRESH.toISOString() };
  const base = regionalCatalogue();
  const region = { records: base.records.filter(record => record.source === 'region-hannover-ris'),
    sources: ['https://ris.hannit.de/public/vo040'], coverage: { ...base.coverage, scope: undefined },
    ...(explicitStatus ? { sourceStatus: { ...base.sourceStatuses[0], retrievedAt: null } } : {}) };
  return combineHannoverCatalogues(city, region, { now: NOW });
}

test.each([false, true])('known SIM cannot publish an unverified Region contribution (explicit status=%s)', async explicit => {
  await expect(refresh({ cities: ['hannover'], collect: async () => unknownRegionWithSim(explicit) }))
    .resolves.toMatchObject([{ status: 'unavailable', reason: expect.stringMatching(/Region.*verified.*timestamp/i) }]);
  await expect(readRisSnapshot(directory, 'hannover')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('unknown Region time retains original fallback age and still removes confirmed withdrawals', async () => {
  const prior = regionalCatalogue();
  prior.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  await writeRisSnapshot(published, 'hannover', prior, { now: FALLBACK });
  const next = unknownRegionWithSim();
  const regional = next.records.find(record => record.source === 'region-hannover-ris');
  next.records.push({ ...regional, id: 'region-hannover-ris:vo:2003038', url: 'https://ris.hannit.de/public/vo020?VOLFDNR=2003038' });
  next.sourceStatuses.find(source => source.source === 'region-hannover-ris').recordCount = 2;
  next.exclusions = [{ id: prior.records[2].id, url: prior.records[2].url, verifiedAt: NOW.toISOString(), reason: 'not-public' }];
  await expect(refresh({ cities: ['hannover'], collect: async () => next }))
    .resolves.toMatchObject([{ status: 'retained', records: 2, generatedAt: FALLBACK.toISOString(),
      reason: expect.stringMatching(/Region.*verified.*timestamp/i) }]);
  const result = await readRisSnapshot(directory, 'hannover');
  expect(result.records.some(record => record.source === 'region-hannover-ris')).toBe(false);
  expect(result.manifest).toMatchObject({ generatedAt: FALLBACK.toISOString(), withdrawalsRecordedAt: NOW.toISOString(),
    refreshFailure: { expiresAt: EXPIRY.toISOString() } });
  expect(result.manifest.sourceStatuses[0]).toMatchObject({ retrievedAt: FALLBACK.toISOString(), recordCount: 0 });
});

test('manual recovery cannot accept an unverified Region contribution as a successful publication', async () => {
  const prior = await writeRisSnapshot(directory, 'hannover', regionalCatalogue(), { now: FALLBACK });
  await expect(refresh({ cities: ['hannover'], checkpointRetry, collect: async () => unknownRegionWithSim() }))
    .rejects.toThrow(/recovery.*Region.*verified.*timestamp/i);
  expect((await readRisSnapshot(directory, 'hannover')).manifest).toEqual(prior);
});

test('reassesses revision 3 address evidence locally without refreshing source clocks or inventing full text', async () => {
  const previous = regionalCatalogue();
  previous.locationRevision = 3;
  previous.records[1].title = 'Radverkehr Stephanusstraße 10-14';
  const regional = previous.records[2];
  regional.title = 'Radverkehrsmaßnahme';
  const evidence = { source: 'document', text: 'Radweg in der Ohestraße 6 in Hannover.' };
  regional.locations = [{ kind: 'address', label: 'Ohestraße 6', evidence,
    geometry: { type: 'Point', coordinates: [9.724028, 52.366419] } }];
  regional.locationAssessment = { status: 'mapped', sources: ['title', 'document'], reasons: [], truncated: false };
  const prior = await writeRisSnapshot(published, 'hannover', previous, { now: FALLBACK });
  prior.refreshFailure = { attemptedAt: '2026-11-07T09:30:00.000Z', expiresAt: EXPIRY.toISOString(), reason: 'Official HTTP 429' };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const before = await readRisSnapshot(published, 'hannover');
  const collect = jest.fn(() => { throw new Error('Backoff must prevent another official source request'); });
  await refresh({ cities: ['hannover'], collect });
  const after = await readRisSnapshot(directory, 'hannover');
  expect(after.manifest).toMatchObject({ locationRevision: 9, generatedAt: prior.generatedAt,
    sourceStatuses: prior.sourceStatuses, coverage: prior.coverage, sources: prior.sources, refreshFailure: prior.refreshFailure });
  expect(after.records[1].locations).toEqual([{ kind: 'address', label: 'Stephanusstraße 10-14', mapped: false,
    evidence: { source: 'title', text: 'Radverkehr Stephanusstraße 10-14' } }]);
  expect(after.records[1].locationAssessment.reasons).toContain('document_text_unavailable');
  const restoredRegion = after.records.find(record => record.id === regional.id);
  expect(restoredRegion.locations).toEqual([{ kind: 'address', label: 'Ohestraße 6', evidence, mapped: true }]);
  expect(restoredRegion.locationAssessment.reasons).toContain('evidence_truncated');
  expect(after.features.features.filter(feature => feature.properties.accuracy === 'official'))
    .toEqual(before.features.features.filter(feature => feature.properties.accuracy === 'official'));
  expect(after.features.features.find(feature => feature.properties.recordId === regional.id).geometry)
    .toEqual({ type: 'Point', coordinates: [9.724028, 52.366419] });
  expect(collect).not.toHaveBeenCalled();
});

test('recovers an independent section from revision 7 retained evidence during source backoff', async () => {
  const previous = regionalCatalogue();
  previous.locationRevision = 7;
  const id = 'hannover-sim:15-2724-2022';
  const text = 'die Sodenstraße zwischen Celler Straße und Angerstraße sowie die Eckerstraße zwischen Hallerstraße und Fridastraße werden in das vorgelegte Straßen Sanierungsprogramm der Stadt mit aufgenommen.';
  previous.records[1] = { ...previous.records[1], id, title: 'Straßensanierung Sodenstraße & Eckerstraße',
    source: 'hannover-sim', date: '2022-10-17', number: '15-2724/2022',
    url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-2724-2022',
    locations: [{ kind: 'section', label: 'Sodenstraße', evidence: { source: 'document', text } }],
    locationAssessment: { status: 'unresolved', sources: ['title', 'document'],
      reasons: ['unverified_name', 'unmapped_location'], truncated: false } };
  previous.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  previous.provenance = require('../../server/political-context/services/risProvenance').collectionProvenance({
    catalogue: previous, city: 'hannover', records: previous.records, sourceRecords: previous.records,
    sourceVerifiedAt: FALLBACK.toISOString(), now: FALLBACK,
  });
  const prior = await writeRisSnapshot(published, 'hannover', previous, { now: FALLBACK });
  prior.refreshFailure = { attemptedAt: '2026-11-07T09:30:00.000Z', expiresAt: EXPIRY.toISOString(), reason: 'Official HTTP 429' };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const collect = jest.fn(() => { throw new Error('Backoff must prevent another official source request'); });

  await refresh({ cities: ['hannover'], collect });

  const after = await readRisSnapshot(directory, 'hannover');
  const record = after.records.find(item => item.id === id);
  expect(record.locations).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: 'section', label: 'Sodenstraße', mapped: false,
      evidence: { source: 'document', text } }),
    expect.objectContaining({ kind: 'section', label: 'Eckerstraße, Hallerstraße bis Fridastraße', mapped: true,
      evidence: { source: 'document', text } }),
  ]));
  const geometry = after.features.features.find(feature => feature.properties.recordId === id)?.geometry;
  expect(geometry).toMatchObject({ type: 'LineString' });
  expect(geometry.coordinates).toHaveLength(5);
  expect(geometry.coordinates[0]).toEqual([9.741912, 52.382327]);
  expect(geometry.coordinates.at(-1)).toEqual([9.744746, 52.382256]);
  expect(record.locationAssessment).toMatchObject({ status: 'partial',
    reasons: expect.arrayContaining(['unverified_name', 'unmapped_location', 'evidence_truncated']) });
  expect(after.manifest).toMatchObject({ locationRevision: 9, generatedAt: prior.generatedAt,
    coverage: prior.coverage, refreshFailure: prior.refreshFailure });
  expect(after.manifest.provenance.sourceVerifiedAt).toBe(prior.generatedAt);
  expect(collect).not.toHaveBeenCalled();
});

test('reassesses a published revision 5 Hannover facility title during source backoff', async () => {
  const previous = regionalCatalogue();
  previous.locationRevision = 5;
  const title = 'Neubau Feuer-und Rettungswache Weidendamm, zweiter Bauabschnitt';
  const id = 'hannover-sim:0839-2014';
  previous.records[1] = { ...previous.records[1], id, title, source: 'hannover-sim',
    date: '2014-04-25', number: '0839/2014', url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/0839-2014' };
  const prior = await writeRisSnapshot(published, 'hannover', previous, { now: FALLBACK });
  prior.refreshFailure = { attemptedAt: '2026-11-07T09:30:00.000Z', expiresAt: EXPIRY.toISOString(), reason: 'Official HTTP 429' };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const collect = jest.fn(() => { throw new Error('Backoff must prevent another official source request'); });

  await refresh({ cities: ['hannover'], collect });

  const { manifest, records, features } = await readRisSnapshot(directory, 'hannover');
  expect(manifest).toMatchObject({ locationRevision: 9, generatedAt: prior.generatedAt,
    coverage: prior.coverage, refreshFailure: prior.refreshFailure });
  expect(records.find(record => record.id === id).locations).toEqual([{
    kind: 'place', label: 'Feuer- und Rettungswache 1 (Weidendamm 50)', mapped: true, evidence: { source: 'title', text: title },
  }]);
  expect(features.features.find(feature => feature.properties.recordId === id)).toMatchObject({
    geometry: { type: 'Point', coordinates: [9.725982, 52.38909] },
    properties: { accuracy: 'derived' },
  });
  expect(collect).not.toHaveBeenCalled();
});

test.each([3, 4])('reassesses retained unavailable details from revision %s during a successful catalogue publication', async revision => {
  const previous = regionalCatalogue();
  previous.locationRevision = revision;
  const title = 'Einfacher Bebauungsplan der Innenentwicklung Nr. 1864, Hildesheimer Straße 9 - 15 (ungerade) Aufstellungsbeschluss';
  previous.records[1] = { ...previous.records[1], id: 'hannover-sim:0001-2018', title,
    detailVerifiedAt: FALLBACK.toISOString(), locations: [{ kind: 'address', label: 'Hildesheimer Straße 9',
      evidence: { source: 'title', text: title } }],
    locationAssessment: { status: 'unresolved', sources: ['title'], reasons: ['document_text_unavailable', 'non_traffic_address'], truncated: false } };
  const regional = previous.records[2];
  regional.title = 'BBS 3 Sanierung der Mischluftboxen Entwurfsplanung / HU-Bau';
  regional.id = 'region-hannover-ris:vo:1007559';
  regional.detailVerifiedAt = FALLBACK.toISOString();
  regional.events = [{ date: '2020-06-22', body: 'Schulausschuss', outcome: 'Vertagt', url: regional.url, evidence: '22.06.2020 Schulausschuss Vertagt' }];
  regional.relatedTo = previous.records[1].id;
  const evidence = { source: 'document', text: 'Am Standort Ohestraße 6 in Hannover muss die Funktion der Lüftungsanlage für den Schulbetrieb gewährleistet sein.' };
  regional.locations = [{ kind: 'address', label: 'Ohestraße 6', evidence,
    geometry: { type: 'Point', coordinates: [9.724028, 52.366419] }, attribution: 'Verified original address evidence' }];
  regional.locationAssessment = { status: 'mapped', sources: ['title', 'document'], reasons: [], truncated: false };
  previous.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  const prior = await writeRisSnapshot(directory, 'hannover', previous, { now: FALLBACK });
  const before = await readRisSnapshot(directory, 'hannover');
  const incoming = { ...previous, generatedAt: NOW.toISOString(), locationRevision: undefined,
    history: { pending: false, interrupted: false, pendingYears: [] },
    records: previous.records.map(record => ({ id: record.id, title: record.title, number: record.number,
      date: record.date, type: record.type, url: record.url, source: record.source, gremium: record.gremium,
      locationEvidenceUnavailable: true })) };
  await expect(refresh({ cities: ['hannover'], collect: () => incoming }))
    .resolves.toMatchObject([{ status: 'published', generatedAt: prior.generatedAt }]);
  const after = await readRisSnapshot(directory, 'hannover');
  const corrected = after.records.find(record => record.id === 'hannover-sim:0001-2018');
  expect(corrected.locations).toEqual([{ kind: 'address', label: 'Hildesheimer Straße 9-15', mapped: false,
    evidence: { source: 'title', text: title } }]);
  expect(corrected.locationAssessment.reasons).toContain('document_text_unavailable');
  expect(after.manifest).toMatchObject({ locationRevision: 9, generatedAt: prior.generatedAt,
    sources: prior.sources, sourceStatuses: prior.sourceStatuses,
    coverage: { from: prior.coverage.from, to: prior.coverage.to, bodies: prior.coverage.bodies, complete: false } });
  const preserved = after.records.find(record => record.id === regional.id);
  expect(preserved.locations).toEqual([{ kind: 'address', label: 'Ohestraße 6', evidence, mapped: true }]);
  expect(preserved.locationAssessment).toMatchObject({ status: 'partial', truncated: true,
    reasons: expect.arrayContaining(['document_text_unavailable', 'evidence_truncated']) });
  expect(after.features.features.filter(feature => feature.properties.accuracy === 'official'))
    .toEqual(before.features.features.filter(feature => feature.properties.accuracy === 'official'));
  expect(after.features.features.find(feature => feature.properties.recordId === regional.id).geometry)
    .toEqual(before.features.features.find(feature => feature.properties.recordId === regional.id).geometry);
  expect(preserved.events).toEqual(regional.events);
  expect(preserved.relatedTo).toBe(regional.relatedTo);
  expect(after.features.features.find(feature => feature.properties.recordId === regional.id))
    .toEqual(before.features.features.find(feature => feature.properties.recordId === regional.id));
});

test('never transfers a retained prefix point to a corrected range and leaves revision 9 retained results stable', async () => {
  const previous = catalogue('hannover');
  previous.locationRevision = 4;
  const title = 'Radverkehr Stephanusstraße 10-14';
  const stale = previous.records[1];
  stale.title = title;
  stale.locations = [{ kind: 'address', label: 'Stephanusstraße 10',
    evidence: { source: 'title', text: title }, geometry: { type: 'Point', coordinates: [9.714685, 52.368463] } }];
  stale.locationAssessment = { status: 'mapped', sources: ['title'], reasons: [], truncated: false };
  const prior = await writeRisSnapshot(directory, 'hannover', previous, { now: FALLBACK });
  const incoming = { ...previous, generatedAt: NOW.toISOString(), history: { pending: false, interrupted: false },
    records: [previous.records[0], { ...stale, title: 'Neuer Listentitel: Radverkehr Limmerstraße 12', locationEvidenceUnavailable: true }] };
  const collect = jest.fn(() => incoming);
  await refresh({ cities: ['hannover'], collect });
  const first = await readRisSnapshot(directory, 'hannover');
  const corrected = first.records.find(record => record.id === stale.id);
  expect(corrected.title).toBe(incoming.records[1].title);
  expect(corrected.locations).toEqual([{ kind: 'address', label: 'Stephanusstraße 10-14', mapped: false,
    evidence: { source: 'title', text: title } }]);
  expect(first.features.features.some(feature => feature.properties.recordId === stale.id)).toBe(false);
  expect(first.manifest).toMatchObject({ locationRevision: 9, generatedAt: prior.generatedAt });
  await refresh({ cities: ['hannover'], collect });
  const second = await readRisSnapshot(directory, 'hannover');
  expect(collect).toHaveBeenCalledTimes(2);
  expect(second.records).toEqual(first.records);
  expect(second.features.features).toEqual(first.features.features);
  expect(second.manifest.generatedAt).toBe(first.manifest.generatedAt);
});

test('reassesses an available prior title even when its old snapshot has no recognized title locations', async () => {
  const previous = catalogue('hannover');
  previous.locationRevision = 4;
  const original = previous.records[1];
  original.id = 'hannover-sim:0579-2023';
  original.title = 'Bebauungsplan Nr. 650, Teilaufhebung als Maßnahme der Innenentwicklung – Eintrachtweg 1-15 – Aufstellungsbeschluss, Beschluss über die frühzeitige Beteiligung der Öffentlichkeit';
  original.locations = [];
  original.relatedTo = previous.records[0].id;
  await writeRisSnapshot(directory, 'hannover', previous, { now: FALLBACK });
  const incoming = { ...previous, generatedAt: NOW.toISOString(), history: { pending: false, interrupted: false },
    records: [previous.records[0], { ...original, title: 'Neue Listenfassung ohne Ortsbezug', locationEvidenceUnavailable: true }] };
  await refresh({ cities: ['hannover'], collect: () => incoming });
  const after = await readRisSnapshot(directory, 'hannover');
  const corrected = after.records.find(record => record.id === original.id);
  expect(corrected.title).toBe('Neue Listenfassung ohne Ortsbezug');
  expect(corrected).not.toHaveProperty('locationTitleEvidence');
  expect(corrected.locations).toEqual([{ kind: 'address', label: 'Eintrachtweg 1-15', mapped: false,
    evidence: { source: 'title', text: original.title } }]);
  expect(corrected.relatedTo).toBe(original.relatedTo);
  expect(after.manifest.generatedAt).toBe(FALLBACK.toISOString());
});

test('reassesses every distinct retained regional title quotation independently with its original scope and map identity', async () => {
  const previous = regionalCatalogue();
  previous.locationRevision = 4;
  const regional = previous.records[2];
  regional.title = 'Verkehrssicherheit Ohestraße 6 in Hannover';
  const quotes = ['Radverkehr Ohestraße 6 in Hannover', 'Radverkehr Am Spielfelde 13 A in Hannover'];
  regional.locations = [
    { kind: 'address', label: 'Ohestraße 6', evidence: { source: 'title', text: quotes[0] },
      geometry: { type: 'Point', coordinates: [9.724028, 52.366419] }, attribution: 'Original verified address A' },
    { kind: 'address', label: 'Am Spielfelde 13 A', evidence: { source: 'title', text: quotes[1] },
      geometry: { type: 'Point', coordinates: [9.707019, 52.362972] }, attribution: 'Original verified address B' },
  ];
  regional.locationAssessment = { status: 'mapped', sources: ['title'], reasons: [], truncated: false };
  await writeRisSnapshot(directory, 'hannover', previous, { now: FALLBACK });
  const before = await readRisSnapshot(directory, 'hannover');
  const incoming = { ...previous, generatedAt: NOW.toISOString(), history: { pending: false, interrupted: false },
    records: previous.records.map(record => ({ ...record, title: 'Aktualisierte Listenmetadaten', locationEvidenceUnavailable: true })) };
  await refresh({ cities: ['hannover'], collect: () => incoming });
  const after = await readRisSnapshot(directory, 'hannover');
  const corrected = after.records.find(record => record.id === regional.id);
  expect(corrected.locations).toEqual([
    { kind: 'address', label: 'Ohestraße 6', evidence: { source: 'title', text: quotes[0] }, mapped: true },
    { kind: 'address', label: 'Am Spielfelde 13 A', evidence: { source: 'title', text: quotes[1] }, mapped: true },
  ]);
  expect(corrected.locationAssessment.sources).toEqual(['title']);
  expect(corrected.locationAssessment.reasons).toContain('document_text_unavailable');
  expect(after.features.features.filter(feature => feature.properties.recordId === regional.id))
    .toEqual(before.features.features.filter(feature => feature.properties.recordId === regional.id));
  expect(after.manifest.generatedAt).toBe(FALLBACK.toISOString());
});

test('does not restore a revision 4 petitioners contact point when retaining unavailable details', async () => {
  const previous = catalogue('hannover');
  previous.locationRevision = 4;
  const record = previous.records[1];
  record.id = 'hannover-sim:0271-2020';
  record.title = 'Petition Nr. 02 / 1. Halbjahr 2019 Schriftliche Eingabe der Herren Gregor Bischoff und Gerd Reincke, Herrenhäuser Kirchweg 12, 30167 Hannover zum Thema „Entkopplung der Ampelschaltung am Industrieweg und die Entkopplung aller betreffenden Ampelschaltungen im Stadtgebiet“';
  record.locations = [{ kind: 'address', label: 'Herrenhäuser Kirchweg 12',
    evidence: { source: 'title', text: record.title }, geometry: { type: 'Point', coordinates: [9.71127, 52.391688] } }];
  record.locationAssessment = { status: 'mapped', sources: ['title'], reasons: [], truncated: false };
  const prior = await writeRisSnapshot(directory, 'hannover', previous, { now: FALLBACK });
  const incoming = { ...previous, generatedAt: NOW.toISOString(), history: { pending: false, interrupted: false },
    records: [previous.records[0], { ...record, locationEvidenceUnavailable: true }] };
  await refresh({ cities: ['hannover'], collect: () => incoming });
  const after = await readRisSnapshot(directory, 'hannover');
  const retained = after.records.find(item => item.id === record.id);
  expect(retained.locations).toEqual([{ kind: 'address', label: 'Herrenhäuser Kirchweg 12', mapped: false,
    evidence: { source: 'title', text: record.title } }]);
  expect(retained.locationAssessment.reasons).toEqual(expect.arrayContaining(['document_text_unavailable', 'non_traffic_address']));
  expect(after.features.features.some(feature => feature.properties.recordId === record.id)).toBe(false);
  expect(after.manifest.generatedAt).toBe(prior.generatedAt);
});

test('reassesses an unmapped revision 8 SIM intersection from its retained title during backoff', async () => {
  const previous = regionalCatalogue();
  previous.locationRevision = 8;
  const { id, title, url, number } = require('../../docs/qa/ris-traffic-location-audit-2026-11-10.json').records
    .find(record => record.id === 'hannover-sim:15-2140-2020F1');
  previous.records[1] = { ...previous.records[1], id, title, url, number, source: 'hannover-sim' };
  previous.sourceStatuses[0].retrievedAt = FALLBACK.toISOString();
  previous.provenance = require('../../server/political-context/services/risProvenance').collectionProvenance({
    catalogue: previous, city: 'hannover', records: previous.records, sourceRecords: previous.records,
    sourceVerifiedAt: FALLBACK.toISOString(), now: FALLBACK,
  });
  const prior = await writeRisSnapshot(published, 'hannover', previous, { now: FALLBACK });
  prior.refreshFailure = { attemptedAt: '2026-11-07T09:30:00.000Z', expiresAt: EXPIRY.toISOString(), reason: 'Official HTTP 429' };
  await fs.writeFile(path.join(published, 'hannover.json'), JSON.stringify(prior));
  const collect = jest.fn();
  await refresh({ cities: ['hannover'], collect });
  const after = await readRisSnapshot(directory, 'hannover');
  expect(after.manifest).toMatchObject({ locationRevision: 9, generatedAt: prior.generatedAt,
    coverage: prior.coverage, refreshFailure: prior.refreshFailure });
  expect(after.records.find(record => record.id === id).locations).toEqual([{
    kind: 'junction', label: 'Hannoversche Straße / Grenzstraße / Louise-Schroeder-Straße', mapped: true,
    evidence: { source: 'title', text: title },
  }]);
  expect(after.features.features.find(feature => feature.properties.recordId === id).geometry)
    .toEqual({ type: 'Point', coordinates: [9.827941, 52.384734] });
  expect(collect).not.toHaveBeenCalled();
});
