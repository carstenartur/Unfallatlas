/** @jest-environment node */
'use strict';

const { EventEmitter } = require('node:events');
const https = require('node:https');
const { PassThrough } = require('node:stream');
const {
  collectBonnCatalogue, searchOparl, SYSTEM_URL, DIRECT_PAPER_LIST_URL,
} = require('../../server/political-context/providers/bonnOparlClient.js');

const BASE = 'https://www.bonn.sitzung-online.de';
const BODIES_URL = `${BASE}/oparl/bodies`;
const paperId = number => `${BASE}/oparl/papers/${number}`;
const publicUrl = number => `${BASE}/public/vo020?VOLFDNR=${number}`;
const opts = { now: '2026-11-07', lookbackYears: 5, maxPages: 3 };

const point = { type: 'Point', coordinates: [7.104, 50.724] };
const paper = (number, fields) => ({
  id: paperId(number),
  type: 'https://schema.oparl.org/1.1/Paper',
  web: publicUrl(number),
  name: `Vorgang ${number}`,
  ...fields,
});
const original = paper(42, {
  name: 'Radverkehr in der Adenauerallee',
  reference: '260920-01 ST',
  paperType: 'Anfrage',
  date: '2026-06-04',
  consultation: [{ organization: [{ name: 'Verkehrsausschuss' }] }],
  location: [{ description: 'Adenauerallee', geojson: { type: 'Feature', geometry: point } }],
});
const answer = paper(43, {
  name: 'Antwort zur Anfrage zum Radverkehr',
  reference: '260920-01 ST F1',
  paperType: 'Beantwortung einer Anfrage',
  date: '2026-07-15',
  relatedPaper: ['https://example.org/paper/1', paperId(42)],
  consultation: [{ meeting: { location: { geojson: point } } }],
  location: [{ geojson: { type: 'Point', coordinates: [250, 50] } }],
});
const unknownDate = paper(99, {
  name: 'Sanierung der Kita',
  date: '2026-02-30',
  modified: '2026-08-01T08:00:00Z',
  created: '2000-01-01T00:00:00Z',
});

function pageUrl(page) {
  return `${DIRECT_PAPER_LIST_URL}?page=${page}`;
}

function fixture(pages, bodyLinks = {}) {
  return value => {
    const url = new URL(value);
    if (url.origin !== BASE) throw new Error(`Unexpected host: ${url.origin}`);
    if (url.pathname === '/oparl/system') return { body: BODIES_URL };
    if (url.pathname === '/oparl/bodies') {
      return {
        data: [{ id: `${BODIES_URL}/1`, name: 'Bundesstadt Bonn', ags: '05314000', paper: DIRECT_PAPER_LIST_URL }],
        links: bodyLinks,
      };
    }
    if (url.pathname === '/oparl/bodies/1/papers') {
      const page = url.searchParams.get('page');
      const payload = pages[page];
      if (payload instanceof Error) throw payload;
      if (payload) return payload;
    }
    throw new Error(`Unexpected request: ${url.href}`);
  };
}

function fetchFixture(pages, bodyLinks) {
  return jest.fn(async url => fixture(pages, bodyLinks)(url));
}

function mockBonnTransport(serveFixture) {
  const requests = [];
  jest.spyOn(https, 'get').mockImplementation((url, _options, callback) => {
    requests.push(url);
    const request = new EventEmitter();
    setImmediate(() => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { 'content-type': 'application/json' };
      try {
        const payload = serveFixture(url);
        callback(response);
        response.end(JSON.stringify(payload));
      } catch (error) {
        request.emit('error', error);
      }
    });
    return request;
  });
  return requests;
}

function loadClientWithCacheOptions(options) {
  jest.replaceProperty(process, 'env', { ...process.env, ...options });
  let client;
  jest.isolateModules(() => {
    client = require('../../server/political-context/providers/bonnOparlClient.js');
  });
  return client;
}

afterEach(() => jest.restoreAllMocks());

test('catalogues official Papers across pages with exact references, dates and document geography', async () => {
  const out = await collectBonnCatalogue({
    ...opts,
    fetchJsonImpl: fetchFixture({
      1: {
        data: [paper(10, { date: '2019-05-01' }), original],
        links: { next: pageUrl(2), last: pageUrl(2) },
        pagination: { currentPage: 1, totalPages: 2, totalElements: 4 },
      },
      2: {
        data: [answer, unknownDate],
        links: { prev: pageUrl(1) },
        pagination: { currentPage: 2, totalPages: 2, totalElements: 4 },
      },
    }),
  });

  expect(out.sources).toEqual([SYSTEM_URL, DIRECT_PAPER_LIST_URL]);
  expect(out.coverage).toMatchObject({
    complete: true, from: '2026-06-04', to: '2026-07-15', bodies: ['Bundesstadt Bonn'],
  });
  expect(out.records).toHaveLength(3);
  const byId = new Map(out.records.map(record => [record.id, record]));
  expect(byId.get(paperId(42))).toEqual({
    id: paperId(42), url: publicUrl(42), title: 'Radverkehr in der Adenauerallee',
    number: '260920-01 ST', type: 'Anfrage', date: '2026-06-04', source: 'bonn-oparl',
    gremium: 'Verkehrsausschuss', geometry: point, locationSource: 'official', locationLabel: 'Adenauerallee',
  });
  expect(byId.get(paperId(43))).toMatchObject({
    number: '260920-01 ST F1', relatedTo: paperId(42), type: 'Verwaltungsantwort',
  });
  expect(byId.get(paperId(43))).not.toHaveProperty('geometry');
  expect(byId.get(paperId(99))).toMatchObject({ date: null });
});

test('follows links.next when the official list supplies no reverse links', async () => {
  const out = await collectBonnCatalogue({
    ...opts,
    fetchJsonImpl: fetchFixture({
      1: { data: [original], links: { next: '?page=2' } },
      2: { data: [answer] },
    }),
  });

  expect(out.records.map(record => record.id)).toEqual([paperId(42), paperId(43)]);
  expect(out.coverage.complete).toBe(true);
});

test('retains document lines and areas but does not relabel declared coordinate systems', async () => {
  const line = { type: 'LineString', coordinates: [[7.10, 50.72], [7.11, 50.72]] };
  const area = { type: 'Polygon', coordinates: [[[7.10, 50.72], [7.11, 50.72], [7.10, 50.73], [7.10, 50.72]]] };
  const crs = { type: 'name', properties: { name: 'EPSG:25832' } };
  const rows = [
    paper(1, { location: [{ geojson: line }] }),
    paper(2, { location: [{ geojson: { type: 'Feature', geometry: area } }] }),
    paper(3, { location: [{ geojson: { type: 'Feature', geometry: line, crs } }] }),
    paper(4, { location: [{ geojson: { type: 'Feature', geometry: { ...area, crs } } }] }),
  ];
  const out = await collectBonnCatalogue({ ...opts, fetchJsonImpl: fetchFixture({ 1: { data: rows } }) });

  expect(out.records.map(record => record.geometry)).toEqual([line, area, undefined, undefined]);
  expect(out.coverage.complete).toBe(true);
});

test('keeps a bounded reverse scan useful without claiming full coverage', async () => {
  const out = await collectBonnCatalogue({
    ...opts, maxPages: 1,
    fetchJsonImpl: fetchFixture({
      1: { data: [original], links: { next: pageUrl(2), last: pageUrl(2) } },
      2: { data: [answer], links: { prev: pageUrl(1) } },
    }),
  });

  expect(out.records.map(record => record.id)).toEqual([paperId(43)]);
  expect(out.coverage).toMatchObject({
    complete: false, from: '2026-07-15', to: '2026-07-15', warnings: [expect.stringMatching(/Seitenlimit/i)],
  });
});

test.each([
  ['a failed page', { 1: { data: [original], links: { next: pageUrl(2) } }, 2: new Error('HTTP 404') }],
  ['an empty page', { 1: { data: [] } }],
  ['a pagination cycle', { 1: { data: [original], links: { next: pageUrl(1) } } }],
  ['a skipped reverse page', {
    1: { data: [original], links: { next: pageUrl(2), last: pageUrl(3) } },
    3: { data: [answer], links: { prev: pageUrl(1) } },
  }],
  ['a last page that links to an unread newer page', {
    1: { data: [original], links: { next: pageUrl(2), last: pageUrl(2) } },
    2: { data: [answer], links: { prev: pageUrl(1), next: pageUrl(3) } },
  }],
  ['a repeated record across pages', {
    1: { data: [original], links: { next: pageUrl(2), last: pageUrl(2) } },
    2: { data: [original], links: { prev: pageUrl(1) } },
  }],
  ['inconsistent totals', { 1: { data: [original], pagination: { totalElements: 2 } } }],
])('does not claim full coverage with %s', async (_case, pages) => {
  const out = await collectBonnCatalogue({ ...opts, fetchJsonImpl: fetchFixture(pages) });

  expect(out.coverage.complete).toBe(false);
  expect(out.coverage.warnings.length).toBeGreaterThan(0);
});

test('does not claim full coverage when discovery is truncated', async () => {
  const out = await collectBonnCatalogue({
    ...opts, maxBodyPages: 1,
    fetchJsonImpl: fetchFixture({ 1: { data: [original] } }, { next: '?page=2' }),
  });

  expect(out.records.map(record => record.id)).toEqual([paperId(42)]);
  expect(out.coverage).toMatchObject({
    complete: false, warnings: [expect.stringMatching(/Body-Liste.*Seitenlimit/)],
  });
});

test('preserves current portal links and replaces retired BoRIS URLs with current source IDs', async () => {
  const alias = 'https://bonn.sitzung-online.de';
  const aliasCitation = `${alias}/public/vo020?VOLFDNR=42`;
  const out = await collectBonnCatalogue({
    ...opts,
    fetchJsonImpl: fetchFixture({
      1: { data: [
        { ...original, web: aliasCitation },
        { ...answer, web: 'https://www2.bonn.de/bo_ris/vo020.asp?VOLFDNR=43' },
      ] },
    }),
  });

  expect(out.records.map(record => record.url)).toEqual([aliasCitation, paperId(43)]);
  expect(out.sources).toEqual([SYSTEM_URL, DIRECT_PAPER_LIST_URL, `${alias}/`]);
  expect(out.coverage.complete).toBe(true);
});

test('does not follow discovered links outside the official hosts', async () => {
  const fetchJsonImpl = jest.fn(async () => ({ body: 'https://example.org/bodies' }));
  const out = await collectBonnCatalogue({ ...opts, fetchJsonImpl });

  expect(fetchJsonImpl.mock.calls.map(([url]) => url)).toEqual([SYSTEM_URL]);
  expect(out.records).toEqual([]);
  expect(out.coverage).toMatchObject({
    complete: false, warnings: [expect.stringMatching(/OPARL_UNTRUSTED_HOST/)],
  });
});

test('reports discovery fallback while verifying the official direct Paper list', async () => {
  const serveFixture = fixture({ 1: { data: [original] } });
  const out = await collectBonnCatalogue({
    ...opts,
    fetchJsonImpl: async url => {
      if (url === SYSTEM_URL) throw new Error('Discovery unavailable');
      return serveFixture(url);
    },
  });

  expect(out.sources).toEqual([DIRECT_PAPER_LIST_URL]);
  expect(out.records.map(record => record.id)).toEqual([paperId(42)]);
  expect(out.coverage).toMatchObject({
    complete: true, warnings: [expect.stringMatching(/Discovery unavailable/)],
  });
});

test('coalesces production reads across search terms and catalogue until the cache expires', async () => {
  const requests = mockBonnTransport(fixture({ 1: { data: [original, unknownDate] } }));
  let clock = Date.parse('2026-11-07T00:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => clock);

  const [catalogue, street, daycare] = await Promise.all([
    collectBonnCatalogue(opts),
    searchOparl({ ...opts, searchTerms: ['Adenauerallee'] }),
    searchOparl({ ...opts, searchTerms: ['Kita'] }),
  ]);
  expect(catalogue.records).toHaveLength(2);
  expect(street.results.map(result => result.number)).toEqual(['260920-01 ST']);
  expect(daycare.results.map(result => result.title)).toEqual(['Sanierung der Kita']);
  expect(requests).toHaveLength(3);

  const injected = await collectBonnCatalogue({
    ...opts, fetchJsonImpl: fetchFixture({ 1: { data: [answer] } }),
  });
  expect(injected.records.map(record => record.id)).toEqual([paperId(43)]);
  const cached = await searchOparl({ ...opts, searchTerms: ['260920-01 ST'] });
  expect(cached.results.map(result => result.url)).toEqual([publicUrl(42)]);
  expect(requests).toHaveLength(3);

  await collectBonnCatalogue({ ...opts, maxPages: 4 });
  expect(requests).toHaveLength(6);

  clock += 24 * 60 * 60 * 1000;
  await searchOparl({ ...opts, searchTerms: ['Kita'] });
  expect(requests).toHaveLength(9);
});

test('does not retain a failed or incomplete production read for the next request', async () => {
  const pages = { 1: new Error('OParl 404') };
  const requests = mockBonnTransport(fixture(pages));
  const options = { ...opts, maxPages: 1 };

  const failed = await collectBonnCatalogue(options);
  expect(failed.coverage.complete).toBe(false);
  expect(failed.records).toEqual([]);

  pages[1] = { data: [original], links: { next: pageUrl(2) } };
  const incomplete = await collectBonnCatalogue(options);
  expect(incomplete.coverage.complete).toBe(false);
  expect(incomplete.records.map(record => record.id)).toEqual([paperId(42)]);

  pages[1] = { data: [answer] };
  const recovered = await collectBonnCatalogue(options);
  expect(recovered.coverage.complete).toBe(true);
  expect(recovered.records.map(record => record.id)).toEqual([paperId(43)]);
  expect(requests).toHaveLength(9);
});

test('coalesces a third catalogue key while two other keys are still loading', async () => {
  const requests = mockBonnTransport(fixture({ 1: { data: [original] } }));
  const searches = await Promise.all([
    searchOparl({ ...opts, maxPages: 11, searchTerms: ['Adenauerallee'] }),
    searchOparl({ ...opts, maxPages: 12, searchTerms: ['Adenauerallee'] }),
    searchOparl({ ...opts, maxPages: 13, searchTerms: ['Adenauerallee'] }),
    searchOparl({ ...opts, maxPages: 13, searchTerms: ['Radverkehr'] }),
  ]);

  expect(searches.map(search => search.results.map(result => result.url)))
    .toEqual([[publicUrl(42)], [publicUrl(42)], [publicUrl(42)], [publicUrl(42)]]);
  expect(requests.filter(url => url === SYSTEM_URL)).toHaveLength(3);
  expect(requests).toHaveLength(9);
});

test.each([
  ['bytes', { BONN_OPARL_CACHE_MAX_BYTES: '8192' }],
  ['items', { BONN_OPARL_CACHE_MAX_ITEMS: '3' }],
])('evicts older snapshots when the retained catalogue %s exceed the shared budget', async (_unit, config) => {
  const client = loadClientWithCacheOptions(config);
  const large = paper(55, { name: 'Verkehrsplanung '.repeat(300) });
  const requests = mockBonnTransport(fixture({ 1: { data: [original, large] } }));
  const firstScope = { ...opts, maxPages: 4 };
  const secondScope = { ...opts, maxPages: 5 };

  await client.collectBonnCatalogue(firstScope);
  await client.collectBonnCatalogue(firstScope);
  expect(requests).toHaveLength(3);

  await client.collectBonnCatalogue(secondScope);
  await client.collectBonnCatalogue(secondScope);
  expect(requests).toHaveLength(6);

  await client.collectBonnCatalogue(firstScope);
  expect(requests).toHaveLength(9);
});

test('shares an oversized read while pending and does not retain it after it finishes', async () => {
  const client = loadClientWithCacheOptions({ BONN_OPARL_CACHE_MAX_BYTES: '2048' });
  const large = paper(56, { name: 'Verkehrsplanung '.repeat(300) });
  const requests = mockBonnTransport(fixture({ 1: { data: [large] } }));

  const [catalogue, search] = await Promise.all([
    client.collectBonnCatalogue(opts),
    client.searchOparl({ ...opts, searchTerms: ['Verkehrsplanung'] }),
  ]);
  expect(catalogue.coverage.complete).toBe(true);
  expect(search.results.map(result => result.url)).toEqual([publicUrl(56)]);
  expect(requests).toHaveLength(3);

  const repeated = await client.collectBonnCatalogue(opts);
  expect(repeated.records.map(record => record.id)).toEqual([paperId(56)]);
  expect(requests).toHaveLength(6);
});

test('fits a small cache budget after discarding unused fields and keeps nested Bonn evidence', async () => {
  const client = loadClientWithCacheOptions({ BONN_OPARL_CACHE_MAX_BYTES: '4096' });
  const unused = 'x'.repeat(64 * 1024);
  const citation = `${BASE}/public/getfile?file=59`;
  const row = paper(59, {
    name: 'Neue Verkehrsführung',
    reference: '260999',
    paperType: 'Stellungnahme',
    date: '2026-08-01',
    web: null,
    mainFile: { name: 'Bürgerbeteiligung', web: citation, unused },
    auxiliaryFile: [{ fileName: 'Oxfordstraße.pdf', unused }],
    consultation: { organization: { shortName: 'Mobilitätsausschuss', unused }, meeting: { unused } },
    location: [{
      locality: 'Nordstadt',
      geojson: { type: 'Feature', geometry: { ...point, unused }, properties: { name: 'Vorgangsort', unused } },
    }],
    relatedPaper: [{ id: paperId(42), unused }],
    keyword: ['Schulweg'],
    unused,
  });
  const serveFixture = fixture({ 1: { data: [row], pagination: { totalElements: 1, unused } } });
  const requests = mockBonnTransport(url => {
    const payload = serveFixture(url);
    if (new URL(url).pathname === '/oparl/bodies') payload.data[0].unused = unused;
    return payload;
  });

  const catalogue = await client.collectBonnCatalogue(opts);
  const search = await client.searchOparl({
    ...opts, searchTerms: ['Oxfordstraße', 'Bürgerbeteiligung', 'Nordstadt', 'Schulweg'],
  });
  expect(requests).toHaveLength(3);
  expect(catalogue.coverage.complete).toBe(true);
  expect(catalogue.records).toEqual([{
    id: paperId(59), title: 'Neue Verkehrsführung', type: 'Verwaltungsantwort',
    number: '260999', date: '2026-08-01', gremium: 'Mobilitätsausschuss', url: citation,
    source: 'bonn-oparl', relatedTo: paperId(42), geometry: point,
    locationSource: 'official', locationLabel: 'Vorgangsort',
  }]);
  expect(search.results).toEqual([expect.objectContaining({ url: citation, snippet: 'Stellungnahme | Schulweg' })]);
  expect(search.meta.queryLog.map(entry => entry.count)).toEqual([1, 1, 1, 1]);
});

test('refreshes an expired snapshot once at the configured TTL', async () => {
  const client = loadClientWithCacheOptions({ BONN_OPARL_CACHE_TTL_MS: '1000' });
  const requests = mockBonnTransport(fixture({ 1: { data: [original] } }));
  let clock = Date.parse('2026-11-07T00:00:00Z');
  jest.spyOn(Date, 'now').mockImplementation(() => clock);

  await client.collectBonnCatalogue(opts);
  clock += 999;
  await client.collectBonnCatalogue(opts);
  expect(requests).toHaveLength(3);

  clock += 1;
  await Promise.all([
    client.collectBonnCatalogue(opts),
    client.searchOparl({ ...opts, searchTerms: ['Adenauerallee'] }),
  ]);
  expect(requests).toHaveLength(6);
});

test('keeps simultaneous caller-injected readers isolated', async () => {
  const [first, second] = await Promise.all([
    collectBonnCatalogue({ ...opts, fetchJsonImpl: fetchFixture({ 1: { data: [original] } }) }),
    collectBonnCatalogue({ ...opts, fetchJsonImpl: fetchFixture({ 1: { data: [answer] } }) }),
  ]);

  expect(first.records.map(record => record.id)).toEqual([paperId(42)]);
  expect(second.records.map(record => record.id)).toEqual([paperId(43)]);
});

test('resumes official page work from a durable cursor and retains completed historical years', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bonn-history-'));
  try {
    const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
    const checkpoint = createRisSourceCheckpoint({ directory: folder });
    const fetchJsonImpl = fetchFixture({
      1: { data: [paper(10, { date: '2014-05-01' })], links: { next: pageUrl(2), last: pageUrl(3) } },
      2: { data: [original], links: { prev: pageUrl(1), next: pageUrl(3) } },
      3: { data: [answer], links: { prev: pageUrl(2) } },
    });
    const first = await collectBonnCatalogue({ ...opts, lookbackYears: 12, checkpoint, workBudget: 1, fetchJsonImpl });
    expect(first.records.map(record => record.id)).toEqual([paperId(43)]);
    expect(first.coverage.complete).toBe(false);
    const second = await collectBonnCatalogue({ ...opts, lookbackYears: 12, checkpoint, workBudget: 3, fetchJsonImpl });
    expect(second.records.map(record => record.id)).toEqual(expect.arrayContaining([paperId(10), paperId(42), paperId(43)]));
    expect(second.coverage.complete).toBe(true);
    expect(second.coverage.from).toBe('2014-05-01');
    const third = await collectBonnCatalogue({ ...opts, checkpoint, workBudget: 3, fetchJsonImpl });
    expect(third.records).toHaveLength(3);
    expect(third.coverage.from).toBe('2014-05-01');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('reconciles a corrected Paper year and an undated deletion by stable ID', async () => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bonn-year-correction-'));
  try {
    const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
    const checkpoint = createRisSourceCheckpoint({ directory: folder });
    const collect = data => collectBonnCatalogue({ ...opts, checkpoint, fetchJsonImpl: fetchFixture({
      1: { data: [...data, answer], pagination: { currentPage: 1, totalPages: 1, totalElements: data.length + 1 } },
    }) });
    expect((await collect([paper(42, { name: 'Old title', date: '2025-01-01' })])).coverage.complete).toBe(true);
    const corrected = await collect([paper(42, { name: 'Corrected title', date: '2026-01-01' })]);
    expect(corrected.records.find(record => record.id === paperId(42))).toMatchObject({ title: 'Corrected title', date: '2026-01-01' });
    expect(corrected.coverage.complete).toBe(true);
    const deleted = await collect([{ id: paperId(42), deleted: true }]);
    expect(deleted.records.map(record => record.id)).toEqual([paperId(43)]);
    expect(deleted.coverage.complete).toBe(true);
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test.each([[false, 'annual'], [false, 'cursor'], [true, 'annual'], [true, 'cursor']])(
  'recovers a Paper move/deletion after interruption (deleted=%s, write=%s)', async (deleted, phase) => {
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bonn-page-journal-'));
    try {
      const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
      const checkpoint = createRisSourceCheckpoint({ directory: folder });
      const payload = changed => ({ 1: { data: [changed, answer], pagination: { currentPage: 1, totalPages: 1, totalElements: 2 } } });
      await collectBonnCatalogue({ ...opts, checkpoint, fetchJsonImpl: fetchFixture(payload(paper(42, { name: 'Old title', date: '2025-01-01' }))) });
      let interrupted = false;
      const unreliable = { ...checkpoint, write: async (source, scope, year, revision, work) => {
        const target = phase === 'annual' ? !scope.endsWith(':cursor') && year === 2026 : scope.endsWith(':cursor') && !work.pendingPage;
        if (!interrupted && target) { interrupted = true; throw new Error('Simulated interruption during annual reconciliation'); }
        return checkpoint.write(source, scope, year, revision, work);
      } };
      const changed = deleted ? { id: paperId(42), deleted: true } : paper(42, { name: 'Corrected title', date: '2026-01-01' });
      const failed = await collectBonnCatalogue({ ...opts, checkpoint: unreliable, fetchJsonImpl: fetchFixture(payload(changed)) });
      expect(interrupted).toBe(true);
      expect(failed.coverage.complete).toBe(false);
      const recovered = await collectBonnCatalogue({ ...opts, workBudget: 0,
        checkpoint: createRisSourceCheckpoint({ directory: folder }), fetchJsonImpl: fetchFixture(payload(changed)) });
      expect(recovered.coverage.complete).toBe(true);
      if (deleted) expect(recovered.records.map(record => record.id)).toEqual([paperId(43)]);
      else expect(recovered.records.find(record => record.id === paperId(42))).toMatchObject({ title: 'Corrected title', date: '2026-01-01' });
      expect(recovered.coverage.warnings.join(' ')).not.toMatch(/mehrfach/);
    } finally { await fs.rm(folder, { recursive: true, force: true }); }
  }
);

test.each([false, true])('recovers pending December page work in January without a source scan (deleted=%s)', async deleted => {
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'bonn-calendar-journal-'));
  try {
    const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
    const checkpoint = createRisSourceCheckpoint({ directory: folder });
    const payload = changed => ({ 1: { data: [changed, answer], pagination: { currentPage: 1, totalPages: 1, totalElements: 2 } } });
    const december = { ...opts, now: '2026-12-31T23:55:00Z' };
    await collectBonnCatalogue({ ...december, checkpoint, fetchJsonImpl: fetchFixture(payload(paper(42, { name: 'Old title', date: '2025-01-01' }))) });
    let interrupted = false;
    const unreliable = { ...checkpoint, write: async (source, scope, year, revision, work) => {
      // A correction loses its old durable copy before the destination write;
      // a deletion is interrupted before removing the old durable live copy.
      if (!interrupted && !scope.endsWith(':cursor') && year === (deleted ? 2025 : 2026)) {
        interrupted = true;
        throw new Error('Simulated annual write interruption on New Year Eve');
      }
      return checkpoint.write(source, scope, year, revision, work);
    } };
    const changed = deleted ? { id: paperId(42), deleted: true } : paper(42, { name: 'Corrected title', date: '2026-01-01' });
    await collectBonnCatalogue({ ...december, checkpoint: unreliable, fetchJsonImpl: fetchFixture(payload(changed)) });
    expect(interrupted).toBe(true);
    const reopened = createRisSourceCheckpoint({ directory: folder });
    const recovered = await collectBonnCatalogue({ ...opts, now: '2027-01-01T00:05:00Z', workBudget: 0,
      checkpoint: reopened, fetchJsonImpl: fetchFixture(payload(changed)) });
    if (deleted) expect(recovered.records.map(record => record.id)).toEqual([paperId(43)]);
    else expect(recovered.records.find(record => record.id === paperId(42))).toMatchObject({ title: 'Corrected title', date: '2026-01-01' });
    expect(recovered.coverage.complete).toBe(true);
    const scope = `official-pages:${DIRECT_PAPER_LIST_URL}?page=1&limit=100&size=100`;
    const saved = await reopened.read('bonn-oparl', scope, 2026, 'bonn-pages-v1');
    expect(saved.papers[paperId(42)]).toMatchObject(deleted ? { deleted: true } : { name: 'Corrected title' });
    expect((await reopened.read('bonn-oparl', `${scope}:cursor`, 2026, 'bonn-pages-v1')).pendingPage).toBeUndefined();
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});
