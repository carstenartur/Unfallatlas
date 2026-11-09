/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeRisSnapshot, readRisSnapshot } = require('../../server/political-context/services/risSnapshot');
const { createCatalogue } = require('../../js/ua.ris-catalogue');

const now = new Date('2026-11-09T10:00:00.000Z');
const source = 'https://example.org/ris/';
const context = level => ({ level, publisher: 'Amtliche Quelle', issuer: null, documentKind: 'Antrag',
  status: 'proposal', publicationDate: null, documentDate: null, meetingDate: null });
const record = (id, level, extra = {}) => ({ id, title: `Schulweg ${id}`, type: 'Antrag', number: id,
  date: '2026-11-01', gremium: null, url: source + id, source: 'test-source', sourceContext: context(level), ...extra });
let dir;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-levels-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const write = (records, schemaVersion = 2) => writeRisSnapshot(dir, 'test', { records, sources: [source],
  coverage: { from: null, to: null, bodies: [], warnings: [], complete: true } }, { now, schemaVersion });
const browser = () => createCatalogue({ base: 'https://example.org/', now: () => now, fetch: async url => {
  try { return new Response(await fs.readFile(path.join(dir, new URL(url).pathname.split('/').pop()))); }
  catch { return new Response(null, { status: 404 }); }
} });

test.each([1, 2])('filters before the search result limit in schema %i', async schemaVersion => {
  await write([...Array.from({ length: 20 }, (_, i) => record(`a-${i}`, 'city')),
    record('z-state', 'state'), record('z-region', 'region')], schemaVersion);
  const result = await browser().search({ city: 'test', searchTerms: ['Schulweg'], maxResults: 1, sourceLevels: ['state'] });
  expect(result.references.map(value => value.id)).toEqual(['z-state']);
});

test.each([1, 2])('keeps explicit cross-level links and source identity through publication and reload in schema %i', async schemaVersion => {
  const levels = ['city', 'region', 'state', 'federal', 'eu'];
  const edge = { type: 'related', targetId: 'record-eu', targetUrl: source + 'record-eu', label: 'Amtlicher EU-Verweis',
    targetRole: null, evidence: 'Im städtischen Original ausdrücklich genannter EU-Vorgang.' };
  const rows = levels.map((level, index) => record(`record-${level}`, level, {
    ...(index ? { relatedTo: `record-${levels[index - 1]}` } : { relationships: [edge] })
  }));
  await write(rows, schemaVersion);
  const full = await readRisSnapshot(dir, 'test');
  expect(full.records.find(value => value.id === 'record-city').relationships).toEqual([edge]);
  expect(full.records.map(value => value.sourceContext.level).sort()).toEqual(['city', 'eu', 'federal', 'region', 'state']);
  const catalogue = browser();
  const filtered = await catalogue.search({ city: 'test', searchTerms: ['Schulweg'], maxResults: 10, sourceLevels: ['city'] });
  expect(filtered.references.map(value => value.id)).toEqual(['record-city']);
  // A list filter must never rewrite or restrict the independently sourced relation graph.
  expect((await catalogue.loadRelatedRecords('test', 'record-city')).records.some(value => value.sourceContext.level === 'region')).toBe(true);
  expect((await catalogue.loadRecordRelationships('test', 'record-city')).relationships).toEqual([edge]);
  const restored = JSON.parse(JSON.stringify(filtered.references));
  expect((await catalogue.resolveReferences('test', restored))[0].sourceContext.level).toBe('city');
  expect((await catalogue.loadRecord('test', edge.targetId)).sourceContext.level).toBe('eu');
});

test('an empty bounded filtered page remains resumable until later matching levels are reached', async () => {
  await write([...Array.from({ length: 320 }, (_, i) => record(`a-${String(i).padStart(3, '0')}`, 'city')),
    record('z-state-1', 'state'), record('z-state-2', 'state')]);
  const catalogue = browser();
  const params = { city: 'test', searchTerms: ['Schulweg'], maxResults: 10, sourceLevels: ['state'] };
  let result = await catalogue.search(params);
  expect(result.references).toEqual([]);
  expect(result.meta.searchStatus).toBe('incomplete');
  expect(result.meta.nextPage).toEqual(expect.any(String));
  const found = [];
  for (let pages = 0; ; pages++) {
    expect(pages).toBeLessThan(10);
    expect(result.meta.scannedItems).toBeLessThanOrEqual(256);
    found.push(...result.references.map(value => value.id));
    if (result.meta.nextPage === null) break;
    result = await catalogue.search({ ...params, page: result.meta.nextPage, snapshot: result.meta.snapshot });
  }
  expect(found).toEqual(['z-state-1', 'z-state-2']);
  expect(result.meta.searchStatus).toBe('results-found');
});

test('continuations bind the canonical selected levels while empty filters preserve unfiltered cursors', async () => {
  await write([record('a-city', 'city'), record('b-state', 'state'), record('c-state', 'state'), record('d-region', 'region')]);
  const catalogue = browser();
  const params = { city: 'test', searchTerms: ['Schulweg'], maxResults: 1 };
  const first = await catalogue.search({ ...params, sourceLevels: ['region', 'state'] });
  const continuation = { ...params, page: first.meta.nextPage, snapshot: first.meta.snapshot };
  await expect(catalogue.search({ ...continuation, sourceLevels: ['city'] })).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_CURSOR_INVALID' });
  await expect(catalogue.search({ ...continuation, sourceLevels: ['state', 'region'] })).resolves.toMatchObject({ references: [{ id: 'c-state' }] });
  const ordinary = await catalogue.search(params);
  await expect(catalogue.search({ ...params, sourceLevels: [], page: ordinary.meta.nextPage, snapshot: ordinary.meta.snapshot }))
    .resolves.toMatchObject({ references: [{ id: 'b-state' }] });
});

test.each([null, 'state', ['unknown'], ['state', 'unknown'], [1]])('rejects invalid source level filters without broadening the query: %j', async sourceLevels => {
  await write([record('one', 'city')]);
  await expect(browser().search({ city: 'test', searchTerms: ['Schulweg'], sourceLevels }))
    .rejects.toMatchObject({ code: 'RIS_SOURCE_LEVELS_INVALID' });
});

test('shared source metadata normalizes levels and preserves unknown source identity', () => {
  const sources = require('../../js/ua.ris-sources');
  expect(sources.normalizeLevels(['eu', 'city', 'unknown', 'region', 'city', null, 'state', 'federal']))
    .toEqual(['city', 'region', 'state', 'federal', 'eu']);
  expect(sources.normalizeLevels('city')).toEqual([]);
  expect(sources.levelOf({ source: 'niedersachsen-landtag' })).toBe('state');
  expect(sources.levelOf({ source: 'hannover-sim', sourceContext: context('region') })).toBe('region');
  expect(sources.levelOf({ source: 'unknown' })).toBeNull();
  expect(sources.sourceLabel({ source: 'unknown', sourceContext: context('eu') })).toBe('Amtliche Quelle');
  expect(sources.sourceLabel({ source: 'unknown' })).toBe('unknown');
});
