'use strict';

const client = require('../../server/political-context/providers/bonnOparlClient.js');

describe('bonnOparlClient – official Bonn Paper collection', () => {
  test('scans newest pages backwards and applies the lookback to the business date locally', async () => {
    const fetchJsonImpl = jest.fn(async value => {
      const url = new URL(value);
      if (url.pathname.endsWith('/oparl/system')) {
        throw new client.OParlClientError(
          client.OParlClientErrorCode.INVALID_JSON,
          'The discovery endpoint returned HTML.'
        );
      }
      if (url.pathname.endsWith('/oparl/bodies/1/papers')
          && url.searchParams.get('page') === '1') {
        expect(url.searchParams.get('limit')).toBe('100');
        expect(url.searchParams.get('size')).toBe('100');
        expect(url.searchParams.has('omit_internal')).toBe(false);
        expect(url.searchParams.has('created_since')).toBe(false);
        return {
          data: [{
            id: 'https://www.bonn.sitzung-online.de/oparl/papers/old',
            name: 'Historischer Radverkehrsvorgang',
            date: '2011-06-01',
            paperType: 'Mitteilung',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=1',
            keyword: ['Radverkehr'],
          }],
          pagination: { currentPage: 1, totalPages: 2 },
          links: {
            next: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2&size=100',
            last: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2&size=100',
          },
        };
      }
      if (url.pathname.endsWith('/oparl/bodies/1/papers')
          && url.searchParams.get('page') === '2') {
        return {
          data: [{
            id: 'https://www.bonn.sitzung-online.de/oparl/papers/42',
            name: 'Radverkehr in der Adenauerallee verbessern',
            reference: 'DS 2026-42',
            date: '2026-06-01',
            created: '2000-01-01T00:00:00+01:00',
            paperType: 'Antrag',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=42',
            keyword: ['Adenauerallee', 'Radverkehr'],
          }],
          pagination: { currentPage: 2, totalPages: 2 },
          links: {
            prev: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=1&size=100',
            last: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2&size=100',
          },
        };
      }
      throw new Error(`Unexpected URL ${url.href}`);
    });

    const out = await client.searchOparl({
      searchTerms: ['Adenauerallee', 'Radverkehr'],
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
      pagesFetched: 2,
      scanPagesFetched: 2,
      discoveryPagesFetched: 1,
      traversalDirection: 'newest-first',
      scannedItems: 2,
      eligibleItems: 1,
      excludedOutsideLookback: 1,
      truncated: false,
    });
    expect(out.meta.warnings.join(' ')).toMatch(/neuesten Seiten rückwärts/);
    expect(out.meta.queryLog).toEqual(expect.arrayContaining([
      expect.objectContaining({ query: 'Adenauerallee', status: 'results-found', count: 1 }),
      expect.objectContaining({ query: 'Radverkehr', status: 'results-found', count: 1 }),
    ]));
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      title: expect.stringContaining('Adenauerallee'),
      url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=42',
      referenceType: 'Antrag',
      locationMatch: 'street',
    });
    expect(fetchJsonImpl).toHaveBeenCalledTimes(3);
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

  test('marks a bounded newest-first scan as partial and exposes the next older page', async () => {
    const fetchJsonImpl = jest.fn(async value => {
      const url = new URL(value);
      if (url.pathname.endsWith('/oparl/system')) {
        throw new client.OParlClientError(
          client.OParlClientErrorCode.INVALID_JSON,
          'The discovery endpoint returned HTML.'
        );
      }
      if (url.searchParams.get('page') === '1') {
        return {
          data: [],
          pagination: { currentPage: 1, totalPages: 4 },
          links: {
            next: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2&size=100',
            last: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=4&size=100',
          },
        };
      }
      if (url.searchParams.get('page') === '4') {
        return {
          data: [{
            id: 'https://www.bonn.sitzung-online.de/oparl/papers/99',
            name: 'Radverkehr sicherer gestalten',
            date: '2026-07-01',
            paperType: 'Antrag',
            web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=99',
            keyword: ['Radverkehr'],
          }],
          pagination: { currentPage: 4, totalPages: 4 },
          links: {
            prev: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=3&size=100',
            last: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=4&size=100',
          },
        };
      }
      throw new Error(`Unexpected URL ${url.href}`);
    });

    const out = await client.searchOparl({
      searchTerms: ['Radverkehr'],
      fetchJsonImpl,
      maxPages: 1,
    });

    expect(out.meta.status).toBe('partial-results');
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.nextUrl).toContain('page=3');
    expect(out.meta.scanPagesFetched).toBe(1);
    expect(out.results).toHaveLength(1);
  });

  test('rejects pagination links that leave the official Bonn host boundary', async () => {
    const source = {
      paperListUrl: client.DIRECT_PAPER_LIST_URL,
      discoveryMode: 'direct-paper-list',
    };
    const fetchJsonImpl = jest.fn(async () => ({
      data: [],
      pagination: { currentPage: 1, totalPages: 2 },
      links: {
        next: 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2',
        last: 'https://attacker.example/oparl/bodies/1/papers?page=2',
      },
    }));

    await expect(client._internal.fetchOfficialBonnPaperList(
      source,
      { maxPages: 1 },
      fetchJsonImpl
    )).rejects.toMatchObject({ code: 'OPARL_UNTRUSTED_HOST' });
  });
});
