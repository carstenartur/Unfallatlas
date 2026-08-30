/** @jest-environment jsdom */
'use strict';

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn(async () => body),
  };
}

function paper(overrides = {}) {
  return {
    id: 'https://www.bonn.sitzung-online.de/oparl/papers/42',
    name: 'Radverkehr in der Adenauerallee verbessern',
    reference: 'DS 2026-42',
    date: '2026-06-01',
    paperType: 'Antrag',
    web: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=42',
    keyword: ['Adenauerallee', 'Radverkehr'],
    ...overrides,
  };
}

describe('Bonn political-context browser fallback', () => {
  let originalSearch;
  let ctx;

  function install(searchImpl, options = {}) {
    jest.resetModules();
    document.body.innerHTML = [
      '<div id="polCtxStatus"></div>',
      '<div id="polCtxResults"><div>Trefferliste</div></div>',
    ].join('');
    ctx = { CITY_RAW: 'Bonn' };
    originalSearch = jest.fn(searchImpl);
    window.UA = {
      PoliticalContext: { search: originalSearch },
      getRuntimeContext: () => ctx,
      ...(options.publicStaticProfile ? {
        PUBLIC_DISTRIBUTION_PROFILE: { id: 'public-preview-core-v1' },
        resolvePublicPoliticalContextEndpoint: () => null,
      } : {}),
    };
    delete window.UA_CONFIG;
    window.fetch = jest.fn();
    require('../../js/ua.political-context-browser-fallback.js');
    return window.UA.PoliticalContextBrowserFallback;
  }

  afterEach(() => {
    delete window.UA;
    delete window.UA_CONFIG;
    delete window.fetch;
    jest.restoreAllMocks();
  });

  test('uses the normal server result without contacting OParl', async () => {
    const serverResult = {
      references: [{ title: 'Server-Treffer' }],
      meta: { supported: true, providerKey: 'bonn-allris' },
    };
    install(async () => serverResult);

    await expect(window.UA.PoliticalContext.search({
      city: 'Bonn',
      searchTerms: ['Adenauerallee'],
    })).resolves.toBe(serverResult);

    expect(originalSearch).toHaveBeenCalledTimes(1);
    expect(window.fetch).not.toHaveBeenCalled();
  });

  test('recovers a static-host HTTP 405 through the official Bonn OParl collection', async () => {
    install(async () => {
      const error = new Error('HTTP 405');
      error.status = 405;
      throw error;
    });
    window.UA_CONFIG = { bonnPoliticalBrowserMaxPages: 2 };

    const firstUrl =
      'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=1&limit=100&size=100';
    const lastUrl =
      'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=2&limit=100&size=100';

    window.fetch.mockImplementation(async (url, options) => {
      expect(options).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        cache: 'no-store',
      });
      if (url === firstUrl) {
        return response(200, {
          data: [],
          pagination: { currentPage: 1, totalPages: 2 },
          links: { last: lastUrl },
        });
      }
      if (url === lastUrl) {
        return response(200, {
          data: [paper()],
          pagination: { currentPage: 2, totalPages: 2 },
          links: { prev: firstUrl, last: lastUrl },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const result = await window.UA.PoliticalContext.search({
      city: 'Bonn',
      searchTerms: ['Bonn', 'Adenauerallee'],
      maxResults: 1,
    });

    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({
      title: expect.stringContaining('Adenauerallee'),
      type: 'Antrag',
      source: 'bonn-oparl-browser',
      url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=42',
      aiGating: expect.objectContaining({ allowed: false }),
    });
    expect(result.meta).toMatchObject({
      city: 'Bonn',
      providerKey: 'bonn-allris',
      supported: true,
      searchStatus: 'partial-results',
      sourceType: 'oparl-1.1-browser-fallback',
      truncated: true,
      pagesFetched: 2,
      scanPagesFetched: 1,
      scannedItems: 1,
    });
    expect(result.meta.searchStatus).not.toBe('searched-no-results');
    expect(result.meta.queryLog).toEqual(expect.arrayContaining([
      expect.objectContaining({
        query: 'Adenauerallee',
        status: 'partial-results',
        count: 1,
      }),
    ]));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(document.getElementById('polCtxStatus').textContent)
      .toMatch(/begrenzten.*OParl-Teilsuche/i);
    expect(document.getElementById('polCtxBrowserFallbackNotice').textContent)
      .toMatch(/fehlende Treffer sind kein Nullbefund/i);
  });

  test('does not emit the known Pages POST when the public Bonn profile has no backend', async () => {
    install(async () => {
      throw new Error('The static-host POST must not be attempted.');
    }, { publicStaticProfile: true });

    window.fetch.mockResolvedValue(response(200, {
      data: [paper()],
      pagination: { currentPage: 1, totalPages: 1 },
      links: {},
    }));

    const result = await window.UA.PoliticalContext.search({
      city: 'Bonn',
      searchTerms: ['Adenauerallee'],
      maxResults: 1,
    });

    expect(originalSearch).not.toHaveBeenCalled();
    expect(result.meta.searchStatus).toBe('partial-results');
    expect(result.references[0].source).toBe('bonn-oparl-browser');
    expect(result.meta.attempts[0].status).toBe('not-attempted-static-profile');
    expect(result.meta.browserFallback).toMatchObject({
      serverBypassed: true,
      serverStatus: null,
    });
  });

  test('recovers the public transport guard backend-required signal for Bonn', async () => {
    install(async () => {
      const error = new Error('Server backend required.');
      error.code = 'POLITICAL_CONTEXT_BACKEND_REQUIRED';
      throw error;
    });
    window.fetch.mockResolvedValue(response(200, {
      data: [paper()],
      pagination: { currentPage: 1, totalPages: 1 },
      links: {},
    }));

    await expect(window.UA.PoliticalContext.search({
      city: 'Bonn',
      searchTerms: ['Adenauerallee'],
      maxResults: 1,
    })).resolves.toMatchObject({
      meta: { searchStatus: 'partial-results' },
      references: [expect.objectContaining({ source: 'bonn-oparl-browser' })],
    });
  });

  test('keeps the fallback around a later public transport reassignment', async () => {
    install(async () => ({ references: [], meta: {} }));
    const guard = jest.fn(async () => {
      const error = new Error('Backend required.');
      error.code = 'POLITICAL_CONTEXT_BACKEND_REQUIRED';
      throw error;
    });
    window.UA.PoliticalContext.search = guard;
    window.fetch.mockResolvedValue(response(200, {
      data: [paper()],
      pagination: { currentPage: 1, totalPages: 1 },
      links: {},
    }));

    expect(window.UA.PoliticalContext.search._uaBonnBrowserFallbackWrapped).toBe(true);
    await expect(window.UA.PoliticalContext.search({
      city: 'Bonn', searchTerms: ['Adenauerallee'], maxResults: 1,
    })).resolves.toMatchObject({ meta: { searchStatus: 'partial-results' } });
    expect(guard).toHaveBeenCalledTimes(1);
  });

  test('never turns an empty bounded browser scan into searched-no-results', async () => {
    install(async () => {
      const error = new Error('HTTP 405');
      error.status = 405;
      throw error;
    });
    window.fetch.mockResolvedValue(response(200, {
      data: [],
      pagination: { currentPage: 1, totalPages: 1 },
      links: {},
    }));

    await expect(window.UA.PoliticalContext.search({
      city: 'Bonn',
      searchTerms: ['Adenauerallee'],
    })).rejects.toMatchObject({
      code: 'POLITICAL_CONTEXT_BROWSER_SEARCH_INCOMPLETE',
      message: expect.stringMatching(/kein belastbarer Nullbefund/i),
    });
  });

  test('explains the server requirement for non-Bonn cities instead of exposing HTTP 405', async () => {
    install(async () => {
      const error = new Error('HTTP 405');
      error.status = 405;
      throw error;
    });

    await expect(window.UA.PoliticalContext.search({
      city: 'Hannover',
      searchTerms: ['Limmerstraße'],
    })).rejects.toMatchObject({
      code: 'POLITICAL_CONTEXT_BACKEND_REQUIRED',
      status: 405,
      message: expect.stringMatching(/benötigt.*Unfallwerkbank-Server/i),
    });
    expect(window.fetch).not.toHaveBeenCalled();
  });

  test('does not hide genuine server errors behind the browser fallback', async () => {
    const failure = Object.assign(new Error('HTTP 500'), { status: 500 });
    install(async () => { throw failure; });

    await expect(window.UA.PoliticalContext.search({
      city: 'Bonn',
      searchTerms: ['Adenauerallee'],
    })).rejects.toBe(failure);
    expect(window.fetch).not.toHaveBeenCalled();
  });

  test('rejects OParl pagination links leaving the official Bonn host boundary', () => {
    const api = install(async () => ({ references: [], meta: {} }));

    expect(() => api._internal.parsePage({
      data: [],
      pagination: { currentPage: 1, totalPages: 2 },
      links: { last: 'https://attacker.example/oparl/bodies/1/papers?page=2' },
    }, 'https://www.bonn.sitzung-online.de/oparl/bodies/1/papers?page=1&size=100&limit=100'))
      .toThrow(/Nicht vertrauenswürdige|Ungültige/);
  });
});
