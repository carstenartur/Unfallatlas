'use strict';

const client = require('../../server/political-context/providers/bonnOparlClient.js');

describe('bonnOparlClient – official direct collection fallback', () => {
  test('uses the bounded official Paper collection when the System document is unavailable', async () => {
    const fetchJsonImpl = jest.fn(async value => {
      const url = new URL(value);
      if (url.pathname.endsWith('/oparl/system')) {
        throw new client.OParlClientError(
          client.OParlClientErrorCode.INVALID_JSON,
          'The discovery endpoint returned HTML.'
        );
      }
      if (url.pathname.endsWith('/oparl/papers')) {
        expect(url.searchParams.get('body')).toBe('1');
        expect(url.searchParams.get('created_since')).toBe('2016-01-01T00:00:00Z');
        return {
          data: [{
            id: 'https://www.bonn.sitzung-online.de/public/oparl/papers/42',
            name: 'Radverkehr in der Adenauerallee verbessern',
            reference: 'DS 2026-42',
            date: '2026-06-01',
            paperType: 'Antrag',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=42',
            keyword: ['Adenauerallee', 'Radverkehr'],
          }],
          links: { next: null },
        };
      }
      throw new Error(`Unexpected URL ${url.href}`);
    });

    const out = await client.searchOparl({
      searchTerms: ['Adenauerallee'],
      fetchJsonImpl,
      now: new Date('2026-08-21T00:00:00Z'),
      lookbackYears: 10,
      maxPages: 2,
    });

    expect(out.meta).toMatchObject({
      status: 'results-found',
      sourceType: 'oparl-1.1',
      sourceUrl: client.DIRECT_PAPER_LIST_URL,
      paperListUrl: client.DIRECT_PAPER_LIST_URL,
      discoveryMode: 'direct-paper-list',
      pagesFetched: 1,
      scannedItems: 1,
      truncated: false,
    });
    expect(out.meta.warnings.join(' ')).toMatch(/Systemdokument.*direkte Paper-Sammlung/);
    expect(out.meta.queryLog[0]).toMatchObject({
      query: 'Adenauerallee',
      url: client.DIRECT_PAPER_LIST_URL,
      status: 'results-found',
      count: 1,
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      title: expect.stringContaining('Adenauerallee'),
      url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=42',
      referenceType: 'Antrag',
      locationMatch: 'street',
    });
  });

  test('does not replace a caller-supplied non-Bonn discovery path with the Bonn fallback', async () => {
    const error = new client.OParlClientError(
      client.OParlClientErrorCode.INVALID_JSON,
      'Broken custom endpoint.'
    );
    await expect(client.searchOparl({
      systemUrl: 'https://oparl.example/system',
      searchTerms: ['Adenauerallee'],
      fetchJsonImpl: jest.fn(async () => { throw error; }),
    })).rejects.toBe(error);
  });

  test('retries the direct collection without optional list filters after HTTP 400', async () => {
    const fetchJsonImpl = jest.fn(async value => {
      const url = new URL(value);
      if (url.pathname.endsWith('/oparl/system')) {
        throw new client.OParlClientError(
          client.OParlClientErrorCode.INVALID_JSON,
          'The discovery endpoint returned HTML.'
        );
      }
      if (url.pathname.endsWith('/oparl/papers') && url.searchParams.has('created_since')) {
        throw new client.OParlClientError(
          client.OParlClientErrorCode.HTTP_ERROR,
          'Unsupported optional filter.',
          { status: 400 }
        );
      }
      if (url.pathname.endsWith('/oparl/papers')) {
        expect(url.searchParams.get('body')).toBe('1');
        expect(url.searchParams.has('created_since')).toBe(false);
        return { data: [], links: { next: null } };
      }
      throw new Error(`Unexpected URL ${url.href}`);
    });

    const out = await client.searchOparl({
      searchTerms: ['Adenauerallee'],
      fetchJsonImpl,
      maxPages: 1,
    });

    expect(out.meta.status).toBe('searched-no-results');
    expect(out.meta.warnings.join(' ')).toMatch(/ohne diese Filter wiederholt/);
    expect(fetchJsonImpl).toHaveBeenCalledTimes(3);
  });
});
