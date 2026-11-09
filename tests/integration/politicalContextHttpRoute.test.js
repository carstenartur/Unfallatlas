/** @jest-environment node */
'use strict';

const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('node:fs/promises');
const os = require('node:os');
const { writeRisSnapshot } = require('../../server/political-context/services/risSnapshot');

const ROOT = path.resolve(__dirname, '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => error ? reject(error) : resolve(address.port));
    });
  });
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('production political-context HTTP route', () => {
  let child;
  let baseUrl;
  let stdout = '';
  let stderr = '';
  let fixtureDirectory;

  beforeAll(async () => {
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'political-http-levels-'));
    const source = 'https://www.bonn.sitzung-online.de/public/';
    await writeRisSnapshot(fixtureDirectory, 'bonn', { sources: [source],
      coverage: { from: null, to: null, bodies: [], warnings: [], complete: true },
      records: [['a-city', 'city'], ['b-state', 'state'], ['c-state', 'state']].map(([id, level]) => ({
        id, title: `Schulweg ${id}`, type: 'Antrag', number: id, date: null, gremium: null,
        source: 'fixture-source', url: source + id, sourceContext: { level, publisher: 'Amtliche Testquelle',
          issuer: null, documentKind: 'Antrag', status: 'proposal', publicationDate: null, documentDate: null, meetingDate: null },
      })) }, { schemaVersion: 2 });
    const liveRecords = [...Array.from({ length: 20 }, (_, i) => [`live-city-${i}`, 'city']),
      ['live-state', 'state'], ['live-region', 'region']].map(([id, level]) => ({
      title: `Schulweg ${id}`, type: 'Antrag', url: `https://example.org/${id}`,
      sourceContext: { level, publisher: 'Amtliche Testquelle', issuer: null, documentKind: 'Antrag',
        status: 'proposal', publicationDate: null, documentDate: null, meetingDate: null },
    }));
    // Use a real immutable catalogue and the real live-search service. Only the
    // catalogue location and providers' external acquisition are fixture-owned.
    const preload = path.join(fixtureDirectory, 'published-source.cjs');
    await fs.writeFile(preload, `const api = require(${JSON.stringify(path.join(ROOT, 'server/political-context/services/risSnapshotSearch.js'))});
const create = api.createRisSnapshotSearch;
api.createRisSnapshotSearch = () => create(${JSON.stringify(fixtureDirectory)});
for (const file of ['berlinAllrisProvider.js', 'bonnAllrisProvider.js', 'hamburgParldokProvider.js', 'hannoverCompositeProvider.js']) {
  const provider = require(${JSON.stringify(path.join(ROOT, 'server/political-context/providers'))} + '/' + file);
  provider.search = async () => ${JSON.stringify(liveRecords)};
}
`);
    child = spawn(process.execPath, ['--require', preload, path.join(ROOT, 'server', 'start.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'test',
        ANALYSIS_SERVICE_ENABLED: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    const deadline = Date.now() + 25_000;
    let lastError = null;
    while (Date.now() < deadline) {
      if (child.exitCode != null) {
        throw new Error(
          `Unfallwerkbank server exited before readiness (code=${child.exitCode}).\n`
            + `stdout:\n${stdout}\nstderr:\n${stderr}`
        );
      }
      try {
        const response = await fetch(`${baseUrl}/api/health`);
        if (response.ok) return;
        lastError = new Error(`Health endpoint returned HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await delay(100);
    }
    throw new Error(
      `Unfallwerkbank server did not become ready: ${lastError && lastError.message}\n`
        + `stdout:\n${stdout}\nstderr:\n${stderr}`
    );
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode == null) {
      child.kill('SIGTERM');
      const exited = new Promise(resolve => child.once('exit', resolve));
      await Promise.race([exited, delay(5_000)]);
      if (child.exitCode == null) {
        child.kill('SIGKILL');
        await Promise.race([exited, delay(2_000)]);
      }
    }
    if (fixtureDirectory) await fs.rm(fixtureDirectory, { recursive: true, force: true });
  });

  test('accepts the real POST route instead of returning 404/405', async () => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        city: 'Musterstadt',
        searchTerms: ['Radverkehr'],
        maxResults: 1,
      }),
    });

    expect(response.status).not.toBe(404);
    expect(response.status).not.toBe(405);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/application\/json/i);

    const body = await response.json();
    expect(body).toMatchObject({
      references: [],
      meta: {
        city: 'Musterstadt',
        supported: false,
      },
    });
  });

  test('rejects malformed or unbound RIS search continuations', async () => {
    for (const continuation of [{ page: 'tampered' }, { page: `ris2.abc.${'a'.repeat(64)}` }]) {
      const response = await fetch(`${baseUrl}/api/political-context/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: 'Hannover', searchTerms: ['Radverkehr'], ...continuation })
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'RIS_SNAPSHOT_CURSOR_INVALID' });
    }
  });

  test('rejects malformed political level filters before source acquisition', async () => {
    for (const sourceLevels of [null, 'state', ['unknown'], ['state', 'unknown']]) {
      const response = await fetch(`${baseUrl}/api/political-context/search`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: 'Musterstadt', searchTerms: ['Schulweg'], sourceLevels })
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: 'RIS_SOURCE_LEVELS_INVALID' });
    }
  });

  test('published city searches keep selected levels and bind them to HTTP continuations', async () => {
    const params = { city: 'Bonn', searchTerms: ['Schulweg'], maxResults: 1, sourceLevels: ['state'] };
    const query = body => fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const firstResponse = await query(params);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json();
    expect(first.references.map(value => value.id)).toEqual(['b-state']);
    const continuation = { ...params, page: first.meta.nextPage, snapshot: first.meta.snapshot };
    const secondResponse = await query(continuation);
    expect(secondResponse.status).toBe(200);
    expect((await secondResponse.json()).references.map(value => value.id)).toEqual(['c-state']);
    const changed = await query({ ...continuation, sourceLevels: ['city'] });
    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({ code: 'RIS_SNAPSHOT_CURSOR_INVALID' });
  });

  test('an initial non-Hannover level search falls back to the live service when no snapshot exists, filtering before the cap', async () => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Berlin', searchTerms: ['Schulweg'], sourceLevels: ['state'], maxResults: 1 }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.references.map(value => value.url)).toEqual(['https://example.org/live-state']);
    expect(result.references[0].sourceContext.level).toBe('state');
    expect(result.meta).toMatchObject({ providerKey: 'berlin-allris', totalFound: 1 });
  });

  test.each([undefined, ['state']])('Hannover keeps its published-catalogue requirement when the snapshot is missing (levels=%j)', async sourceLevels => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Hannover', searchTerms: ['Schulweg'], sourceLevels, maxResults: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ references: [], meta: { searchStatus: 'incomplete', providerKey: 'hannover-sim' } });
  });

  test('a non-Hannover continuation never changes to live results when its snapshot is missing', async () => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Berlin', searchTerms: ['Schulweg'], sourceLevels: ['state'],
        page: `ris2.abc.${'a'.repeat(64)}`, snapshot: { city: 'berlin', sha256: 'b'.repeat(64) } }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH' });
  });

  test.each(['{', JSON.stringify({ schemaVersion: 2, city: 'hamburg' })])('a present but invalid snapshot fails closed instead of using live results: %s', async content => {
    await fs.writeFile(path.join(fixtureDirectory, 'hamburg.json'), content);
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Hamburg', searchTerms: ['Schulweg'], sourceLevels: ['state'], maxResults: 1 }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'POLITICAL_SEARCH_FAILED' });
  });

  test('an empty published result remains authoritative even when the live provider has matching levels', async () => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Bonn', searchTerms: ['Schulweg'], sourceLevels: ['region'], maxResults: 1 }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ references: [], meta: { providerKey: 'ris-snapshot', searchStatus: 'searched-no-results' } });
  });

  test('validates POST payloads through the production handler', async () => {
    const response = await fetch(`${baseUrl}/api/political-context/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({
      code: 'CITY_REQUIRED',
      category: 'invalid_request',
    });
  });
});
