'use strict';

const client = require('../../server/political-context/providers/bonnOparlClient.js');
const provider = require('../../server/political-context/providers/bonnAllrisProvider.js');
const portalSearchService = require('../../server/political-context/services/portalSearchService.js');

function jsonRouter(handler) {
  return jest.fn(async url => handler(new URL(url)));
}

describe('bonnOparlClient – structured OParl traversal', () => {
  test('follows external-list pagination and preserves the first-page filters', async () => {
    const fetchJsonImpl = jsonRouter(url => {
      if (url.searchParams.get('page') === '2') {
        return {
          data: [{ id: 'paper-2' }],
          pagination: { currentPage: 2, totalPages: 2 },
          links: { self: url.href, next: null },
        };
      }
      return {
        data: [{ id: 'paper-1' }],
        pagination: { currentPage: 1, totalPages: 2 },
        links: { self: url.href, next: 'https://oparl.example/papers?page=2&created_since=2020-01-01T00%3A00%3A00Z' },
      };
    });

    const out = await client.fetchExternalList('https://oparl.example/papers', {
      fetchJsonImpl,
      maxPages: 5,
      query: {
        created_since: '2020-01-01T00:00:00Z',
        omit_internal: 'true',
        limit: 100,
      },
    });

    expect(out.items.map(item => item.id)).toEqual(['paper-1', 'paper-2']);
    expect(out.pagesFetched).toBe(2);
    expect(out.truncated).toBe(false);
    const firstUrl = new URL(fetchJsonImpl.mock.calls[0][0]);
    expect(firstUrl.searchParams.get('created_since')).toBe('2020-01-01T00:00:00Z');
    expect(firstUrl.searchParams.get('omit_internal')).toBe('true');
    expect(firstUrl.searchParams.get('limit')).toBe('100');
  });

  test('rejects inconsistent pagination metadata without links.next', async () => {
    const fetchJsonImpl = jest.fn(async () => ({
      data: [],
      pagination: { currentPage: 1, totalPages: 2 },
      links: { next: null },
    }));

    await expect(client.fetchExternalList('https://oparl.example/papers', {
      fetchJsonImpl,
      maxPages: 5,
    })).rejects.toMatchObject({ code: 'OPARL_INVALID_LIST' });
  });

  test('rejects non-Bonn network hosts and non-official evidence links', () => {
    let error;
    try { client._internal.assertAllowedNetworkUrl('https://example.org/system'); }
    catch (caught) { error = caught; }
    expect(error).toMatchObject({ code: 'OPARL_UNTRUSTED_HOST' });
    expect(client.mapPaper({
      name: 'Untrusted paper',
      web: 'https://example.org/paper/1',
      id: 'https://example.org/oparl/paper/1',
    }, { value: 'paper', normalized: 'paper' })).toBeNull();
  });

  test('rejects cyclic pagination instead of silently looping', async () => {
    const fetchJsonImpl = jest.fn(async url => ({
      data: [],
      links: { next: url },
    }));

    await expect(client.fetchExternalList('https://oparl.example/papers', {
      fetchJsonImpl,
      maxPages: 5,
    })).rejects.toMatchObject({ code: 'OPARL_PAGINATION_CYCLE' });
  });

  test('resolves Bonn Body, matches papers locally, keeps direct web links and deduplicates', async () => {
    const fetchJsonImpl = jsonRouter(url => {
      if (url.pathname === '/system') {
        return {
          id: url.href,
          type: 'https://schema.oparl.org/1.1/System',
          oparlVersion: 'https://schema.oparl.org/1.1/',
          body: 'https://oparl.example/bodies',
        };
      }
      if (url.pathname === '/bodies') {
        return {
          data: [{
            id: 'https://oparl.example/body/bonn',
            type: 'https://schema.oparl.org/1.1/Body',
            ags: '05314000',
            shortName: 'Bonn',
            name: 'Bundesstadt Bonn',
            paper: 'https://oparl.example/papers',
          }],
          links: { next: null },
        };
      }
      if (url.pathname === '/papers' && url.searchParams.get('page') === '2') {
        return {
          data: [{
            id: 'https://oparl.example/paper/1',
            type: 'https://schema.oparl.org/1.1/Paper',
            name: 'Radverkehr in der Adenauerallee verbessern',
            reference: 'DS 2026-001',
            date: '2026-02-01',
            paperType: 'Antrag',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=1',
            keyword: ['Adenauerallee', 'Radverkehr'],
          }, {
            id: 'https://oparl.example/paper/2',
            type: 'https://schema.oparl.org/1.1/Paper',
            name: 'Verkehrssicherheit am Bertha-von-Suttner-Platz',
            reference: 'DS 2026-002',
            date: '2026-03-01',
            paperType: 'Vorlage',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=2',
            keyword: ['Verkehrssicherheit'],
          }],
          links: { next: null },
        };
      }
      if (url.pathname === '/papers') {
        return {
          data: [{
            id: 'https://oparl.example/paper/1',
            type: 'https://schema.oparl.org/1.1/Paper',
            name: 'Radverkehr in der Adenauerallee verbessern',
            reference: 'DS 2026-001',
            date: '2026-02-01',
            paperType: 'Antrag',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=1',
            keyword: ['Adenauerallee', 'Radverkehr'],
          }, {
            id: 'https://oparl.example/paper/irrelevant',
            name: 'Jahresabschluss Kulturamt',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=99',
          }],
          links: { next: 'https://oparl.example/papers?page=2' },
        };
      }
      throw new Error(`Unexpected URL ${url.href}`);
    });

    const out = await client.searchOparl({
      systemUrl: 'https://oparl.example/system',
      searchTerms: ['Bonn', 'Adenauerallee', 'Verkehrssicherheit'],
      fetchJsonImpl,
      now: new Date('2026-08-21T00:00:00Z'),
      maxPages: 5,
    });

    expect(out.meta.status).toBe('results-found');
    expect(out.meta.pagesFetched).toBe(3);
    expect(out.meta.scannedItems).toBe(4);
    expect(out.meta.truncated).toBe(false);
    expect(out.results).toHaveLength(2);
    expect(out.results.map(result => result.url)).toEqual([
      'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=1',
      'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=2',
    ]);
    expect(out.results[0]).toMatchObject({
      title: expect.stringContaining('Adenauerallee'),
      referenceType: 'Antrag',
      locationMatch: 'street',
    });
  });

  test('marks a bounded paper crawl as incomplete instead of a completed no-result search', async () => {
    const fetchJsonImpl = jsonRouter(url => {
      if (url.pathname === '/system') return { body: 'https://oparl.example/bodies' };
      if (url.pathname === '/bodies') {
        return {
          data: [{ ags: '05314000', name: 'Bonn', paper: 'https://oparl.example/papers' }],
          links: { next: null },
        };
      }
      if (url.pathname === '/papers') {
        return {
          data: [{
            id: 'https://oparl.example/paper/1',
            name: 'Adenauerallee Radverkehr',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=1',
          }],
          links: { next: 'https://oparl.example/papers?page=2' },
        };
      }
      throw new Error(`Unexpected URL ${url.href}`);
    });

    const out = await client.searchOparl({
      systemUrl: 'https://oparl.example/system',
      searchTerms: ['Adenauerallee'],
      fetchJsonImpl,
      maxPages: 1,
    });

    expect(out.meta.status).toBe('partial-results');
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.nextUrl).toContain('page=2');
    expect(out.results).toHaveLength(1);
  });
});

describe('bonnAllrisProvider – official HTML link boundary', () => {
  test('drops externally hosted links even when their path resembles a Bonn template', () => {
    const html = `
      <table><tr>
        <td><a href="https://attacker.example/vo020?VOLFDNR=123">Antrag Adenauerallee</a></td>
        <td>01.08.2026</td>
      </tr></table>`;
    expect(provider.parseResults(html)).toEqual([]);
  });
});

describe('bonnAllrisProvider – OParl preference and fail-closed fallback', () => {
  test('uses complete OParl results without redundant HTML requests', async () => {
    const fetchHtmlImpl = jest.fn();
    const out = await provider.search({
      searchTerms: ['Adenauerallee'],
      fetchHtmlImpl,
      searchOparlImpl: jest.fn(async () => ({
        results: [{ title: 'Antrag Adenauerallee', url: 'https://example.test/paper/1', sourceType: 'oparl-1.1' }],
        meta: {
          status: 'results-found',
          sourceUrl: provider.OPARL_SYSTEM_URL,
          queryLog: [{
            query: 'Adenauerallee', source: 'bonn-oparl', sourceType: 'oparl-1.1',
            url: provider.OPARL_SYSTEM_URL, status: 'results-found',
          }],
          pagesFetched: 2,
          scannedItems: 50,
          truncated: false,
          warnings: [],
        },
      })),
    });

    expect(fetchHtmlImpl).not.toHaveBeenCalled();
    expect(out.meta).toMatchObject({
      status: 'results-found',
      sourceType: 'oparl-1.1',
      pagesFetched: 2,
      scannedItems: 50,
    });
    expect(out.results).toHaveLength(1);
  });

  test('falls back to the official HTML search when OParl is unavailable', async () => {
    const fetchHtmlImpl = jest.fn(async url => {
      expect(url).toContain('www.bonn.sitzung-online.de/public/tr010');
      return `
        <table><tr>
          <td><a href="vo020?VOLFDNR=123">Antrag zur Verkehrssicherheit Adenauerallee</a></td>
          <td>01.08.2026</td><td>Mobilitätsausschuss</td><td>2026/1234</td>
        </tr></table>`;
    });
    const oparlError = Object.assign(new Error('OParl down'), { code: 'OPARL_HTTP_ERROR' });

    const out = await provider.search({
      searchTerms: ['Adenauerallee'],
      searchOparlImpl: jest.fn(async () => { throw oparlError; }),
      fetchHtmlImpl,
    });

    expect(out.meta.status).toBe('results-found');
    expect(out.meta.sourceType).toBe('html-scraping');
    expect(out.meta.warnings.join(' ')).toMatch(/OParl-Abruf fehlgeschlagen/);
    expect(out.meta.queryLog.some(entry => entry.status === 'failed')).toBe(true);
    expect(out.results[0].url).toBe('https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123');
  });

  test('does not call the legacy endpoint merely because the modern portal returned zero hits', async () => {
    const fetchHtmlImpl = jest.fn(async () => '<html><body>keine Treffer</body></html>');
    const out = await provider.search({
      searchTerms: ['Adenauerallee'],
      searchOparlImpl: jest.fn(async () => { throw new Error('OParl down'); }),
      fetchHtmlImpl,
    });

    expect(fetchHtmlImpl).toHaveBeenCalledTimes(1);
    expect(out.results).toEqual([]);
    expect(out.meta.status).toBe('searched-no-results');
  });

  test('throws when no structured or HTML source completed, so failure cannot become no-results', async () => {
    await expect(provider.search({
      searchTerms: ['Adenauerallee'],
      searchOparlImpl: jest.fn(async () => { throw new Error('OParl down'); }),
      fetchHtmlImpl: jest.fn(async () => { throw new Error('Portal down'); }),
    })).rejects.toMatchObject({
      code: 'POLITICAL_PROVIDER_UNAVAILABLE',
      providerKey: 'bonn-allris',
    });
  });
});

describe('portalSearchService provider envelope compatibility', () => {
  test('accepts both legacy arrays and evidence envelopes', () => {
    expect(portalSearchService.unwrapProviderResult([{ title: 'x' }]))
      .toEqual({ rawResults: [{ title: 'x' }], providerMeta: {} });
    expect(portalSearchService.unwrapProviderResult({
      results: [],
      meta: { status: 'searched-no-results' },
    })).toEqual({
      rawResults: [],
      providerMeta: { status: 'searched-no-results' },
    });
  });

  test('normalizes query logs, source provenance and completeness counters', () => {
    const meta = portalSearchService.normalizeProviderMeta({
      status: 'results-found',
      sourceType: 'oparl-1.1',
      sourceUrl: provider.OPARL_SYSTEM_URL,
      queryLog: [{
        query: 'Adenauerallee', source: 'bonn-oparl', sourceType: 'oparl-1.1',
        url: provider.OPARL_SYSTEM_URL, status: 'results-found', count: 2,
      }],
      pagesFetched: 3,
      scannedItems: 150,
      warnings: ['Fallback geprüft', 'Fallback geprüft'],
    }, 'searched-no-results');

    expect(meta).toMatchObject({
      searchStatus: 'results-found',
      sourceType: 'oparl-1.1',
      sourceUrl: provider.OPARL_SYSTEM_URL,
      pagesFetched: 3,
      scannedItems: 150,
      warnings: ['Fallback geprüft'],
    });
    expect(meta.queryLog[0]).toMatchObject({
      query: 'Adenauerallee',
      source: 'bonn-oparl',
      sourceType: 'oparl-1.1',
      status: 'results-found',
      count: 2,
    });
  });
});