'use strict';

function installDom() {
  document.head.innerHTML = '';
  document.body.innerHTML = `
    <select id="citySel" aria-busy="true">
      <option value="" disabled selected>Städte werden geladen …</option>
    </select>
    <div id="panelBody"></div>
    <div id="videoExportContainer"></div>
    <button id="polCtxBtnSearch" type="button">Politisch suchen</button>
    <button id="btnPolCtxOpen" type="button">Politische Recherche öffnen</button>
    <div id="polCtxStatus"></div>
    <div id="polCtxResults"></div>
  `;
}

function loadPublicPreview(overrides = {}) {
  jest.resetModules();
  installDom();
  window.history.replaceState({}, '', overrides.url || '/werkbank_v2.html?city=Bonn');
  window.UA = {
    loadCitiesList: overrides.loadCitiesList || jest.fn(async (ctx) => [ctx.CITY_RAW, 'Hannover']),
    setCityDropdown: overrides.setCityDropdown || jest.fn(),
    bindUi: overrides.bindUi || jest.fn(),
    ...overrides.ua,
  };
  require('../../js/ua.public-preview.js');
  return window.UA;
}

describe('public Pages QA hardening', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete window.UA;
  });

  test('shows the URL city immediately instead of a permanent loading placeholder', () => {
    loadPublicPreview({ url: '/werkbank_v2.html?city=Bonn' });

    const select = document.getElementById('citySel');
    expect(select.value).toBe('Bonn');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Bonn',
      'Weitere Städte werden geladen …',
    ]);
    expect(select.getAttribute('aria-busy')).toBe('true');
    expect(select.getAttribute('aria-label')).toContain('Bonn ausgewählt');
  });

  test('returns the active city immediately and adopts a late cities.txt result in the background', async () => {
    jest.useFakeTimers();
    let resolveCities;
    const originalLoad = jest.fn(() => new Promise((resolve) => {
      resolveCities = resolve;
    }));
    const setCityDropdown = jest.fn();
    const UA = loadPublicPreview({
      loadCitiesList: originalLoad,
      setCityDropdown,
      ua: { PUBLIC_CITY_LIST_WARNING_MS: 25 },
    });
    const ctx = { CITY_RAW: 'Bonn', ui: { citySel: document.getElementById('citySel') } };

    const resultPromise = UA.loadCitiesList(ctx);
    await expect(resultPromise).resolves.toEqual(['Bonn']);
    await Promise.resolve();
    expect(originalLoad).toHaveBeenCalledWith(ctx);

    resolveCities(['Berlin', 'Bonn', 'Hannover']);
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(setCityDropdown).toHaveBeenCalledWith(ctx, ['Berlin', 'Bonn', 'Hannover']);
  });

  test('keeps the public notice compact and makes a conflicting selection visible', () => {
    const fitBounds = jest.fn();
    const selectionBounds = {
      contains: jest.fn(() => false),
    };
    const ctx = {
      map: {
        getCenter: jest.fn(() => ({ lat: 52.3759, lng: 9.7320 })),
        fitBounds,
      },
      selectionBounds,
      ui: {
        exportMapModeHintEl: document.createElement('div'),
      },
    };
    const originalBindUi = jest.fn();
    const UA = loadPublicPreview({ bindUi: originalBindUi });

    UA.bindUi(ctx);

    expect(originalBindUi).toHaveBeenCalledWith(ctx);
    expect(fitBounds).toHaveBeenCalledWith(selectionBounds, expect.objectContaining({
      maxZoom: 18,
      animate: false,
    }));
    expect(ctx.urlConsistencyRepair).toBe('selection-preferred-over-conflicting-center');

    const notice = document.getElementById('publicPreviewNotice');
    expect(notice).toBeInstanceOf(HTMLDetailsElement);
    expect(notice.open).toBe(false);
    expect(notice.querySelector('summary').textContent)
      .toContain('Serverfunktionen transparent gekennzeichnet');
    expect(notice.textContent)
      .toContain('Politische Recherche und Videoexport benötigen ein Server-Backend');
  });

  test('suppresses the impossible Pages POST and exposes official Bonn links without a backend', async () => {
    const originalSearch = jest.fn();
    const fetchSpy = jest.spyOn(global, 'fetch');
    const UA = loadPublicPreview({
      ua: {
        PoliticalContext: {
          search: originalSearch,
          buildSearchTerms: jest.fn(() => ['Bonn', 'Adenauerallee']),
        },
      },
    });

    expect(document.getElementById('polCtxBtnSearch').disabled).toBe(true);
    expect(document.getElementById('polCtxStatus').textContent)
      .toMatch(/kein fehlerhafter API-Aufruf/i);
    expect(document.getElementById('polCtxResults').textContent)
      .toContain('Ratsinformationssystem öffnen');
    expect([...document.querySelectorAll('#polCtxResults a')].map(link => link.href))
      .toEqual(expect.arrayContaining([
        'https://www.bonn.sitzung-online.de/public/',
        expect.stringMatching(/^https:\/\/www\.bonn\.sitzung-online\.de\/public\/tr010\?q=Adenauerallee$/),
      ]));

    await expect(UA.PoliticalContext.search({ city: 'Bonn' })).rejects.toMatchObject({
      code: 'POLITICAL_CONTEXT_BACKEND_REQUIRED',
    });
    expect(originalSearch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('uses only an explicitly configured HTTP backend for political search', async () => {
    const endpoint = 'https://api.example.test/political-context/search';
    const payload = { references: [], meta: { supported: false } };
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn(async () => payload),
    });
    const originalSearch = jest.fn();
    const UA = loadPublicPreview({
      ua: {
        POLITICAL_CONTEXT_ENDPOINT: endpoint,
        PoliticalContext: { search: originalSearch },
      },
    });

    expect(document.getElementById('polCtxBtnSearch').disabled).toBe(false);
    await expect(UA.PoliticalContext.search({ city: 'Bonn', maxResults: 1 }))
      .resolves.toBe(payload);
    expect(fetchSpy).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Bonn', maxResults: 1 }),
    }));
    expect(originalSearch).not.toHaveBeenCalled();
  });

  test('does not recenter when the URL center is already inside the selected area', () => {
    const fitBounds = jest.fn();
    const ctx = {
      map: {
        getCenter: jest.fn(() => ({ lat: 50.7326, lng: 7.0963 })),
        fitBounds,
      },
      selectionBounds: {
        contains: jest.fn(() => true),
      },
      ui: {},
    };
    const UA = loadPublicPreview();

    UA.bindUi(ctx);

    expect(fitBounds).not.toHaveBeenCalled();
    expect(ctx.urlConsistencyRepair).toBeUndefined();
  });
});