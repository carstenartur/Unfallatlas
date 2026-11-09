'use strict';

const fs = require('fs');
const path = require('path');
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const load = name => (function (window) { eval(fs.readFileSync(path.resolve(__dirname, '../../js', name), 'utf8')); })(window);
const cursor = 'ris2.eyJ2IjoxfQ.' + 'a'.repeat(64);
const generation = 'b'.repeat(64);
const snapshot = { city: 'hannover', generation };
const record = { id: 'region-hannover-ris:42', title: 'Radweg an der Leine', type: 'Beschlussdrucksache',
  number: '42/2026', source: 'region-hannover-ris', url: 'https://ris.hannit.de/public/vo020?VOLFDNR=42',
  sourceContext: { level: 'region', publisher: 'Region Hannover' }, snapshot };
const result = references => ({ references, meta: { city: 'Hannover', supported: true,
  searchStatus: references.length ? 'partial-results' : 'incomplete', snapshot, generation,
  sourceUrl: 'https://ris.hannit.de/public/', complete: false, warnings: [] } });

describe('Ratsatlas-style research workspace', () => {
  let UA, ctx;
  beforeEach(() => {
    history.replaceState({}, '', '/werkbank_v2.html?city=Hannover&zoom=14');
    document.body.innerHTML = `<main id="map" tabindex="0"></main><button id="btnPolCtxOpen">Ratsdokumente</button>
      <section id="polCtxPanel" class="ris-browser" style="display:none" aria-hidden="true">
        <button id="polCtxBtnClose">Schließen</button><button id="polCtxBtnCollapse">Einklappen</button>
        <div class="ris-browser__body"><input id="polCtxSearchInput"><select id="polCtxLevel">
          <option value="">Alle Ebenen</option value="city">Stadt</option><option value="region">Region</option>
          <option value="state">Land</option><option value="federal">Deutschland</option><option value="eu">EU</option>
        </select><button id="polCtxBtnSearch">Suche starten</button><div id="polCtxBasis"></div>
        <div id="polCtxStatus"></div><div id="polCtxResults"></div><button id="polCtxBtnAdopt">Übernehmen</button></div>
      </section>`;
    UA = window.UA = {};
    load('ua.utils.js'); load('ua.ris_view_state.js'); load('ua.political-context.js');
    UA.syncAllToUrl = context => UA.setQS(UA.RisViewState.toQuery(context.risView));
    UA.RisDetails = { open: jest.fn(), close: jest.fn(), refresh: jest.fn() };
    ctx = { CITY_RAW: 'Hannover', risView: UA.RisViewState.normalize(), politicalContextCityRevision: Symbol('city'),
      map: { getContainer: () => document.getElementById('map') } };
    UA.PoliticalContext.init(ctx);
    UA.PoliticalContext.search = jest.fn().mockResolvedValue(result([record]));
  });

  afterEach(() => { document.getElementById('polCtxBtnClose').click(); delete window.UA; });

  async function search() {
    await UA.PoliticalContext.openPanel(ctx);
    document.getElementById('polCtxSearchInput').value = 'Radweg';
    document.getElementById('polCtxLevel').value = 'region';
    await UA.PoliticalContext._runSearch(ctx);
  }

  test('opens a nonmodal list without making the map inert', async () => {
    await UA.PoliticalContext.openPanel(ctx);
    const panel = document.getElementById('polCtxPanel');
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(document.getElementById('map').inert).not.toBe(true);
    expect(document.getElementById('map').getAttribute('aria-hidden')).not.toBe('true');
    expect(ctx.risView.listOpen).toBe(true);
  });

  test('keeps the searched list and export selection when a document opens', async () => {
    await search();
    const check = document.querySelector('.polCtxCheck'); check.checked = true;
    const open = document.querySelector('[data-ris-open-record]');
    expect(open).not.toBeNull();
    open.click();
    expect(UA.RisDetails.open).toHaveBeenCalledWith(ctx, record.id, expect.objectContaining({ trigger: open }));
    expect(document.getElementById('polCtxPanel').style.display).toBe('flex');
    expect(document.querySelector('.polCtxCheck').checked).toBe(true);
    expect(document.querySelector('.polCtxRef').getAttribute('aria-current')).toBe('true');
    expect(document.querySelector('.polCtxRef').textContent).toContain('Region');
  });

  test('searches the selected source level and shares query and filter', async () => {
    await search();
    expect(UA.PoliticalContext.search).toHaveBeenCalledWith(expect.objectContaining({ searchTerms: ['Radweg'], sourceLevels: ['region'] }));
    const query = new URL(location.href).searchParams;
    expect(query.get('risList')).toBe('1');
    expect(query.get('risQuery')).toBe('Radweg');
    expect(query.get('risLevels')).toBe('region');
  });

  test.each([
    ['generation', snapshot],
    ['catalogue sha256', { city: 'hannover', sha256: generation }],
  ])('an empty bounded page shares its exact page with %s snapshot identity', async (_label, pageSnapshot) => {
    UA.PoliticalContext.search.mockResolvedValueOnce({ ...result([]), meta: { ...result([]).meta, snapshot: pageSnapshot, nextPage: cursor } })
      .mockResolvedValueOnce(result([record]));
    await search();
    const next = [...document.querySelectorAll('button')].find(button => button.textContent.includes('Weitere Suchtreffer'));
    expect(next).toBeDefined();
    document.getElementById('polCtxResults').scrollTop = 500;
    next.focus();
    next.click(); await flush();
    expect(UA.PoliticalContext.search).toHaveBeenLastCalledWith(expect.objectContaining({ page: cursor, snapshot: pageSnapshot, sourceLevels: ['region'] }));
    expect(new URL(location.href).searchParams.get('risSearchPage')).toBe(cursor);
    expect(new URL(location.href).searchParams.get('risSearchSnapshot')).toBe(generation);
    expect(document.querySelectorAll('.polCtxRef')).toHaveLength(1);
    expect(document.getElementById('polCtxResults').scrollTop).toBe(0);
    expect(document.activeElement).toBe(document.querySelector('[data-ris-open-record]'));
  });

  test('restores a shared filtered page directly without refetching every preceding page', async () => {
    ctx.risView = UA.RisViewState.normalize({ listOpen: true, query: 'Radweg', sourceLevels: ['region'], searchCursor: cursor, searchGeneration: generation });
    await UA.PoliticalContext.refreshPanel?.(ctx); await flush();
    expect(UA.PoliticalContext.search).toHaveBeenCalledTimes(1);
    expect(UA.PoliticalContext.search).toHaveBeenCalledWith(expect.objectContaining({ page: cursor,
      snapshot: { city: 'hannover', sha256: generation }, searchTerms: ['Radweg'], sourceLevels: ['region'] }));
    expect(document.getElementById('polCtxSearchInput').value).toBe('Radweg');
    expect(document.getElementById('polCtxLevel').value).toBe('region');
  });

  test('reopening restarts a cancelled replacement of the same query and releases search controls', async () => {
    await search();
    let finishCancelled;
    UA.PoliticalContext.search.mockReturnValueOnce(new Promise(resolve => { finishCancelled = resolve; }))
      .mockResolvedValueOnce(result([record]));
    const pending = UA.PoliticalContext._runSearch(ctx);
    document.getElementById('polCtxBtnClose').click();
    const enabledAfterClose = !document.getElementById('polCtxBtnSearch').disabled;
    await UA.PoliticalContext.openPanel(ctx);
    finishCancelled(result([{ ...record, title: 'Veraltete Wiederholung' }]));
    await pending;
    expect(enabledAfterClose).toBe(true);
    expect(UA.PoliticalContext.search).toHaveBeenCalledTimes(3);
    expect(document.querySelectorAll('.polCtxRef')).toHaveLength(1);
    expect(document.getElementById('polCtxResults').textContent).toContain(record.title);
    expect(document.getElementById('polCtxResults').textContent).not.toContain('Veraltete Wiederholung');
    expect(document.getElementById('polCtxBtnSearch').disabled).toBe(false);
    expect(document.getElementById('polCtxResults').getAttribute('aria-busy')).toBe('false');
  });

  test('late results cannot replace a newer filtered search or reopen a closed list', async () => {
    let resolve;
    UA.PoliticalContext.search.mockReturnValueOnce(new Promise(done => { resolve = done; })).mockResolvedValueOnce(result([record]));
    await UA.PoliticalContext.openPanel(ctx);
    document.getElementById('polCtxSearchInput').value = 'Alt';
    const pending = UA.PoliticalContext._runSearch(ctx);
    document.getElementById('polCtxSearchInput').value = 'Radweg';
    await UA.PoliticalContext._runSearch(ctx);
    document.getElementById('polCtxBtnClose').click();
    resolve(result([{ ...record, id: 'old', title: 'Veraltete Anfrage' }]));
    await pending;
    expect(document.getElementById('polCtxResults').textContent).not.toContain('Veraltete Anfrage');
    expect(document.getElementById('polCtxPanel').style.display).toBe('none');
    expect(ctx.risView.listOpen).toBe(false);
  });
});

describe('shared list state boundary', () => {
  beforeEach(() => { window.UA = {}; load('ua.ris_view_state.js'); });
  test('round trips list state independently of a selected document', () => {
    const state = { listOpen: true, listCollapsed: true, query: 'Leine, Radweg', sourceLevels: ['region', 'state'], searchCursor: cursor, searchGeneration: generation };
    const query = window.UA.RisViewState.toQuery(state);
    const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== null));
    expect(window.UA.RisViewState.fromSearch(search)).toMatchObject(state);
  });
  test('rejects unbounded query, unsupported levels and malformed continuation', () => {
    const state = window.UA.RisViewState.normalize({ listOpen: true, query: 'x'.repeat(513), sourceLevels: ['region', 'nonsense', 'region'], searchCursor: 'unsafe', searchGeneration: generation });
    expect(state.query.length).toBeLessThanOrEqual(512);
    expect(state.sourceLevels).toEqual(['region']);
    expect(state.searchCursor).toBeNull();
    expect(state.searchGeneration).toBeNull();
  });
});
