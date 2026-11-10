/** @jest-environment node */
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createRisSourceCache } = require('../../server/political-context/services/risSourceCache');
const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
const { collectLandtagCatalogue, collectHannoverAdditionalSources, buildCatalogueUrl } = require('../../server/political-context/providers/hannoverAdditionalSources');
const fixture = name => fs.readFile(path.join(__dirname, '../fixtures/political-sources', name), 'utf8');
const NOW = new Date('2026-11-08T12:00:00.000Z');
let directory, sourceCache, checkpoint;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'additional-sources-'));
  sourceCache = createRisSourceCache({ directory, now: () => NOW.getTime() });
  checkpoint = createRisSourceCheckpoint({ directory });
});
afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

test('catalogue builds only verified filters and resumes a bounded partition without dropping earlier records', async () => {
  const url = buildCatalogueUrl({ year: 2025, month: 11, number: '19/8980', importer: 'printed_matter' });
  expect(new URL(url).searchParams.get('nltdocuments-number')).toBe('19/8980');
  expect(new URL(url).searchParams.get('nltdocuments-year')).toBe('2025');
  expect(() => buildCatalogueUrl({ importer: 'invented', year: -1 })).toThrow(/filter/i);
  const original = await fixture('landtag-catalogue.html');
  const next = 'https://www.landtag-niedersachsen.de/dokumentensuche/?tx_nltdocuments_documents%5BcurrentPage%5D=2&cHash=issued';
  const first = original.replace('Anzahl Ergebnisse: 1', 'Anzahl Ergebnisse: 2')
    .replace('page-next disable" aria-disabled="true', 'page-next')
    .replace('?tx_nltdocuments_documents%5BcurrentPage%5D=1', next.replace(/&/g, '&amp;'));
  const second = original.replace('Anzahl Ergebnisse: 1', 'Anzahl Ergebnisse: 2').replaceAll('8980', '8981').replaceAll('08980', '08981')
    .replace('Radverkehr, Gehwege und Konfliktlagen in der hannoverschen Eilenriede', 'Radverkehr in der Landeshauptstadt Hannover');
  let requests = 0;
  const request = async requested => { requests++; return requested === next ? second : first; };
  const opts = { now: NOW, sourceCache, checkpoint, request, maxPages: 1, filters: { year: 2025, month: 11 } };
  const partial = await collectLandtagCatalogue(opts);
  expect(partial.records.map(r => r.number)).toEqual(['19/8980']);
  expect(partial.sourceStatus).toMatchObject({ status: 'partial', recordCount: 1 });
  expect(partial.continuation).toBe(next);
  // Incomplete backfill must also resume across a weekly build interval.
  const complete = await collectLandtagCatalogue({ ...opts, now: new Date('2026-11-16T12:00:00.000Z') });
  expect(complete.records.map(r => r.number)).toEqual(['19/8980', '19/8981']);
  expect(complete.continuation).toBeNull();
  expect(complete.partitionComplete).toBe(true);
  expect(complete.sourceStatus.status).toBe('partial'); // one partition cannot establish complete source coverage
  expect(requests).toBe(2);
});

test('catalogue failure preserves prior verified records and source clock without advancing the checkpoint', async () => {
  const original = await fixture('landtag-catalogue.html');
  const next = 'https://www.landtag-niedersachsen.de/dokumentensuche/?page=2';
  const first = original.replace('Anzahl Ergebnisse: 1', 'Anzahl Ergebnisse: 2')
    .replace('page-next disable" aria-disabled="true', 'page-next')
    .replace('?tx_nltdocuments_documents%5BcurrentPage%5D=1', next);
  const opts = { now: NOW, sourceCache, checkpoint, request: async () => first, maxPages: 1, filters: { year: 2025 } };
  await collectLandtagCatalogue(opts);
  const failed = await collectLandtagCatalogue({ ...opts, now: new Date('2026-11-09T12:00:00.000Z'), request: async () => { throw new Error('upstream unavailable'); } });
  expect(failed.records).toHaveLength(1);
  expect(failed.sourceStatus).toMatchObject({ status: 'failed', retrievedAt: '2026-11-08T12:00:00.000Z', recordCount: 1 });
  expect(failed.continuation).toBe(next);
});

test('independent collectors cache real responses and leave Region proposal retrieval to the document index', async () => {
  const [catalogue, rss, notice] = await Promise.all([fixture('landtag-catalogue.html'), fixture('landtag-rss.xml'), fixture('region-notice.html')]);
  const index = '<h1>Regionsversammlung und Ausschüsse</h1><a href="/Regionsversammlung-und-Aussch%C3%BCsse/21.04.2026-Regionsversammlung">lesen</a>';
  const requested = [];
  const request = async url => {
    requested.push(url);
    if (url.includes('ris.hannit.de')) throw new Error('Region proposals belong to the document index');
    if (url.includes('drucksachen.xml')) throw new Error('feed unavailable');
    if (url.includes('stenoberichte.xml')) return rss;
    if (url.includes('/dokumentensuche/')) return catalogue;
    if (url.endsWith('/Regionsversammlung-und-Aussch%C3%BCsse')) return index;
    return notice;
  };
  const opts = { now: NOW, sourceCache, checkpoint, request, maxPages: 1, filters: { number: '19/8980' } };
  const first = await collectHannoverAdditionalSources(opts);
  expect(first.records.map(r => r.title)).toEqual(expect.arrayContaining([
    'Radverkehr, Gehwege und Konfliktlagen in der hannoverschen Eilenriede',
    'Bestellung einer zusätzlichen Linie während der Qualitätsoffensive Hamburg-Hannover zwischen Celle und Hannover.'
  ]));
  expect(first.sourceStatuses).toEqual(expect.arrayContaining([
    expect.objectContaining({ source: 'region-hannover-ris', status: 'partial', retrievedAt: null, recordCount: 0,
      message: expect.stringMatching(/nicht Bestandteil dieser Live-Suche.*Dokumentenindex/) }),
    expect.objectContaining({ source: 'landtag-rss-drucksachen', status: 'failed' }),
    expect.objectContaining({ source: 'region-hannover-bekanntmachungen', status: 'partial' })
  ]));
  const before = requested.length;
  const second = await collectHannoverAdditionalSources(opts);
  expect(second.records).toEqual(first.records);
  expect(requested.slice(before)).toEqual(['https://www.landtag-niedersachsen.de/rss/drucksachen.xml']);
  expect(requested.some(url => new URL(url).hostname === 'ris.hannit.de')).toBe(false);
  expect(first.coverage.complete).toBe(false);
  expect(first.sourceStatuses.every(s => Object.keys(s).sort().join(',') === 'from,message,recordCount,retrievedAt,source,status,to,url')).toBe(true);
});

test('zero catalogue work budget makes no catalogue request and exposes a resumable partial source', async () => {
  const result = await collectLandtagCatalogue({ now: NOW, sourceCache, checkpoint, request: async () => { throw new Error('must not fetch'); }, maxPages: 0 });
  expect(result.records).toEqual([]);
  expect(result.sourceStatus.status).toBe('partial');
  expect(result.continuation).toContain('/dokumentensuche/');
});

test('background search verifies archive hits against the official catalogue and recovers them without network', async () => {
  const document = await fixture('landtag-catalogue.html');
  const pdfPath = '/drucksachen/drucksachen_19_10000/08501-09000/19-08980.pdf';
  const hit = number => `<h3 class="results-topic"><a href="${pdfPath.replace('08980', number)}">Radverkehr in der Eilenriede</a></h3>`;
  const html = `<div class="result-set"><p>2 Treffer für „Radverkehr“.</p></div><div class="results-list">${hit('08980')}${hit('08981')}</div>`;
  const request = jest.fn(async url => {
    if (new URL(url).pathname === '/service/suche/') return html;
    if (new URL(url).pathname === '/dokumentensuche/') return document;
    throw new Error('source unavailable');
  });
  const options = { now: NOW, sourceCache, checkpoint, request, includeCatalogue: false, maxNotices: 0 };
  const interactive = await collectHannoverAdditionalSources(options);
  expect(interactive.sourceStatuses.some(s => s.source === 'landtag-archive')).toBe(false);
  expect(request.mock.calls.some(([url]) => url.includes('/service/suche/'))).toBe(false);
  request.mockClear();
  const result = await collectHannoverAdditionalSources({ ...options, includeArchive: true });
  expect(result.records).toEqual([expect.objectContaining({ number: '19/8980', sourceContext: expect.objectContaining({ level: 'state' }) })]);
  expect(result.sourceStatuses).toContainEqual(expect.objectContaining({ source: 'landtag-archive', status: 'failed',
    retrievedAt: NOW.toISOString(), recordCount: 1 }));
  expect(request.mock.calls.filter(([url]) => url.includes('/dokumentensuche/')).map(([url]) =>
    new URL(url).searchParams.get('nltdocuments-number')).sort()).toEqual(['19/8980', '19/8981']);
  request.mockClear();
  const recovered = await collectHannoverAdditionalSources({ ...options, includeArchive: true, workBudget: 0 });
  expect(request).not.toHaveBeenCalled();
  expect(recovered.records).toEqual(result.records);
  expect(recovered.sourceStatuses).toContainEqual(expect.objectContaining({ source: 'landtag-archive', status: 'partial',
    retrievedAt: NOW.toISOString(), recordCount: 1 }));
});

test('zero additional-source work budget performs no network request and reports uncollected sources as partial', async () => {
  let requests = 0;
  const result = await collectHannoverAdditionalSources({ now: NOW, sourceCache, checkpoint, workBudget: 0,
    request: async () => { requests++; throw new Error('must not fetch'); } });
  expect(requests).toBe(0);
  expect(result.sourceStatuses.map(s => s.status)).toEqual(['partial','partial','partial','partial','partial']);
});

test('successful responses verified after acquisition starts are not mistaken for future cache corruption', async () => {
  const now = new Date(Date.now() - 1000);
  const realClockCache = createRisSourceCache({ directory });
  const html = await fixture('landtag-catalogue.html');
  const result = await collectLandtagCatalogue({ now, sourceCache: realClockCache, checkpoint,
    request: async () => html, maxPages: 1, filters: { number: '19/8980' } });
  expect(result.records).toHaveLength(1);
  expect(result.sourceStatus.status).toBe('partial');
  expect(result.sourceStatus.retrievedAt > now.toISOString()).toBe(true);
});
