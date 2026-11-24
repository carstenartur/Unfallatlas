/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRenewalTransport, renewalDay } = require('../../scripts/ris-scheduled-renewal');

const date = new Date('2026-11-24T04:20:00Z');
const day = '2026-11-24';
const bonn = 'https://www.bonn.sitzung-online.de/oparl/system';
const sim = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/Suche.xsp';
const region = 'https://ris.hannit.de/public/vo040';
let directory;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-daily-renewal-')); });
afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

function transport(options = {}) {
  return createRenewalTransport({ directory, day, startDay: day, city: 'hannover', now: () => date,
    intervalMs: 0, maxRequests: 3, maxBytes: 15, ...options });
}

test('only the earliest scheduled Pages run created today can claim the UTC day, including after cache loss', async () => {
  const entry = id => ({ id, path: '.github/workflows/deploy-pages-current-data.yml' });
  const list = (...runs) => async () => Response.json({ total_count: runs.length, workflow_runs: runs });
  const env = { GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '100', GITHUB_REPOSITORY: 'example/main', GITHUB_REF: 'refs/heads/main' };
  await expect(renewalDay(env, list(entry(101), entry(100)), date, day)).resolves.toBe(day);
  for (const overrides of [{ GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_EVENT_NAME: 'push' }, { GITHUB_REF: 'refs/heads/feature' }]) {
    await expect(renewalDay({ ...env, ...overrides }, list(entry(100)), date, day)).resolves.toBe('');
  }
  await expect(renewalDay(env, list(entry(99), entry(100)), date, day)).resolves.toBe('');
  await expect(renewalDay(env, list(entry(99)), date, day)).resolves.toBe('');
  await expect(renewalDay(env, async () => new Response(null, { status: 503 }), date, day)).rejects.toThrow();
});

test('competing and subsequent processes cannot reuse one city/day allowance', async () => {
  const results = await Promise.allSettled([transport(), transport()]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  await expect(transport()).rejects.toThrow(/claimed|EEXIST/i);
});

test('enforces pooled request and response-byte limits under concurrent loads on distinct hosts', async () => {
  const fetch = jest.fn(async () => new Response('123456'));
  const budget = await transport({ fetch, maxRequests: 2 });
  const responses = await Promise.allSettled([sim, region, sim, region].map(url => budget.read(url)));
  expect(responses.map(result => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected', 'rejected']);
  expect(fetch).toHaveBeenCalledTimes(2);
  const log = await fs.readFile(budget.journal, 'utf8');
  expect(log).toContain('ris.hannit.de');
  expect(log).not.toContain('vo040');
});

test('an oversized chunked response stops before a second network operation', async () => {
  const fetch = jest.fn(async () => new Response('12345678901234567890'));
  const budget = await transport({ fetch });
  await expect(budget.read(region)).rejects.toThrow(/byte/i);
  await expect(budget.read(sim)).rejects.toThrow(/byte|budget/i);
  expect(fetch).toHaveBeenCalledTimes(1);
  const entries = (await fs.readFile(budget.journal, 'utf8')).trim().split('\n').map(JSON.parse);
  expect(entries.at(-1).totalBytes).toBe(15);
});

test('the scheduled transport reads exactly the accepted body with a matching declared length', async () => {
  const fetch = jest.fn(async () => new Response('a'.repeat(15), { headers: { 'content-length': '15' } }));
  const budget = await transport({ fetch });
  await expect(budget.read(region)).resolves.toMatchObject({ text: 'a'.repeat(15) });
  await expect(budget.read(sim)).rejects.toThrow(/byte|budget/i);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([401, 403, 429, 503, 302, 'gate'])('stops queued requests after denial %s, without redirects or solving challenges', async denial => {
  const fetch = jest.fn(async () => denial === 'gate' ? new Response('<altcha-widget>') : new Response('', { status: denial }));
  const budget = await transport({ fetch });
  const results = await Promise.allSettled([budget.read(region), budget.read(region)]);
  expect(results.every(item => item.status === 'rejected')).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][1].redirect).toBe('manual');
});

test('respects Retry-After across UTC dates and process restarts', async () => {
  const fetch = async () => new Response(null, { status: 429, headers: { 'Retry-After': '172800' } });
  const first = await transport({ fetch });
  await expect(first.read(region)).rejects.toThrow();
  await first.close();
  const nextFetch = jest.fn();
  const next = await transport({ day: '2026-11-25', now: () => new Date('2026-11-25T06:00:00Z'), fetch: nextFetch });
  await expect(next.read(region)).rejects.toThrow(/blocked|cooldown/i);
  expect(nextFetch).not.toHaveBeenCalled();
});

test('allows only city-specific public source routes and stops at UTC midnight', async () => {
  let clock = date;
  const fetch = jest.fn(async () => new Response('ok'));
  const budget = await transport({ fetch, now: () => clock });
  for (const url of [bonn, 'https://ris.hannit.de/_gate/verify', 'https://example.org/page']) {
    await expect(budget.read(url)).rejects.toThrow();
  }
  clock = new Date('2026-11-25Z');
  await expect(budget.read(region)).rejects.toThrow(/day/i);
  expect(fetch).not.toHaveBeenCalled();
});

test('a real Bonn collector uses the scheduled transport and respects a municipal rejection on direct-list fallback', async () => {
  const { collectOfficial } = require('../../scripts/refresh-ris-catalogues');
  const now = new Date();
  const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 429 }));
  const network = jest.spyOn(require('node:https'), 'get').mockImplementation(() => { throw new Error('Unbudgeted municipal request'); });
  try {
    const result = await collectOfficial('bonn', now, { sourceDirectory: directory, workBudget: 320, renewalDay: now.toISOString().slice(0, 10), renewalStartDay: now.toISOString().slice(0, 10) });
    expect(result.records).toHaveLength(0);
    expect(result.coverage.complete).toBe(false);
    expect(network).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(bonn);
  } finally { network.mockRestore(); fetch.mockRestore(); }
});


test('the unapproved schedule stays offline even on the first scheduled run', async () => {
  const fetch = jest.fn();
  const env = { GITHUB_EVENT_NAME: 'schedule', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '100', GITHUB_REPOSITORY: 'example/main', GITHUB_REF: 'refs/heads/main' };
  await expect(renewalDay(env, fetch, date)).resolves.toBe('');
  expect(fetch).not.toHaveBeenCalled();
});

test.each([429, 200])('reserves response allowance before a socket and charges it on unmeasured HTTP %s', async status => {
  const budget = await transport({ fetch: async () => new Response('body already buffered', {
    status, headers: { 'content-length': '21' } }) });
  await expect(budget.read(region)).rejects.toThrow();
  await expect(budget.read(sim)).rejects.toThrow(/budget/i);
  const [, before, after] = (await fs.readFile(budget.journal, 'utf8')).trim().split('\n').map(JSON.parse);
  expect(before.reservedBytes).toBe(15);
  expect(after).toMatchObject({bodyBytesRead: 0, chargedBytes: 15, totalBytes: 15});
});

test('a lost or incomplete prior receipt cannot clear an unknown host cooldown', async () => {
  const next = () => transport({ day: '2026-11-25', now: () => new Date('2026-11-25T06:00:00Z') });
  await expect(next()).rejects.toThrow(/receipt/i);
  const first = await transport({ fetch: async () => new Response('ok') });
  await first.read(sim);
  await expect(next()).rejects.toThrow(/receipt/i);
});
