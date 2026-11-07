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

test('keeps simultaneous caller-injected readers isolated', async () => {
  const [first, second] = await Promise.all([
    collectBonnCatalogue({ ...opts, fetchJsonImpl: fetchFixture({ 1: { data: [original] } }) }),
    collectBonnCatalogue({ ...opts, fetchJsonImpl: fetchFixture({ 1: { data: [answer] } }) }),
  ]);

  expect(first.records.map(record => record.id)).toEqual([paperId(42)]);
  expect(second.records.map(record => record.id)).toEqual([paperId(43)]);
});
