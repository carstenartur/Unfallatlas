'use strict';

const fs = require('fs');
const path = require('path');

function script(name) {
  const file = path.resolve(__dirname, '../../js', name);
  (function (window) { eval(fs.readFileSync(file, 'utf8')); })(window);
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred() { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }

describe('shareable independent RIS details', () => {
  let ctx, UA;
  const snapshot = { city: 'hannover', sha256: 'a'.repeat(64), mapSha256: 'b'.repeat(64) };
  const record = { id: 'region-hannover-ris:vo:2003037', title: 'Radverkehr am Mittellandkanal',
    source: 'region-hannover-ris', number: '2073 (V) BDs', type: 'Beschlussdrucksache',
    url: 'https://ris.hannit.de/public/vo020?VOLFDNR=2003037', snapshot,
    events: [{ date: '2023-09-19', body: 'Regionsversammlung', outcome: 'ungeändert beschlossen',
      url: 'https://ris.hannit.de/public/to020?TOLFDNR=1', evidence: 'Öffentlicher Beratungsverlauf' }],
    relationships: [], locations: [] };
  const empty = { total: 0, start: 0, page: 0, nextPage: null, complete: true, missing: [], known: true };

  beforeEach(() => {
    document.body.innerHTML = '<button id="origin">Vorgang öffnen</button><main id="map"></main>';
    history.replaceState({}, '', '/werkbank_v2.html?city=Hannover&centerLat=52.375000&centerLon=9.732000&zoom=13');
    UA = window.UA = {};
    for (const name of ['ua.utils.js', 'ua.ris_view_state.js', 'ua.ris-record-view.js', 'ua.ris-details.js']) script(name);
    UA.RisCatalogue = {
      loadManifest: jest.fn().mockResolvedValue({ city: 'hannover', records: { sha256: snapshot.sha256 } }),
      loadRecord: jest.fn().mockResolvedValue(record),
      loadRecordEvents: jest.fn().mockResolvedValue({ ...empty, events: record.events, total: 1 }),
      loadRecordRelationships: jest.fn().mockResolvedValue({ ...empty, relationships: [] }),
      loadRelatedRecords: jest.fn().mockResolvedValue({ ...empty, records: [] }),
      loadRecordLocations: jest.fn().mockResolvedValue({ ...empty, locations: [] }),
      loadRecordGeometries: jest.fn().mockResolvedValue({ ...empty, geometryIds: [] }),
    };
    UA.syncAllToUrl = context => UA.setQS(UA.RisViewState.toQuery(context.risView));
    ctx = { CITY_RAW: 'Hannover', risView: {}, contextOverlays: { active: { ris: false } },
      politicalContextCityRevision: Symbol('city'), map: { closePopup: jest.fn(), setView: jest.fn() } };
  });

  afterEach(() => { UA.RisDetails?.close(ctx); delete window.UA; });

  async function pendingLocation() {
    const geometryId = 'geometry:' + 'c'.repeat(64);
    const locations = Array.from({ length: 65 }, (_, index) => ({
      id: 'location:' + (index + 1).toString(16).padStart(64, '0'), geometryId,
      label: `Kanalweg ${index + 1}`, kind: 'section', mapped: true,
      evidence: { source: 'document', text: `Öffentlicher Beleg für Kanalweg ${index + 1}.` },
    }));
    const located = { ...record, locations: locations.slice(0, 64), locationCount: 65, locationsNextPage: 1,
      geometryIds: [geometryId], geometryNextPage: null };
    UA.RisCatalogue.loadRecord.mockResolvedValue(located);
    UA.RisCatalogue.loadRecordLocations.mockResolvedValue({ ...empty, locations: locations.slice(64), total: 65, start: 64, page: 1 });
    const pending = deferred();
    UA.RisLayer = { showLocation: jest.fn().mockReturnValue(pending.promise) };
    const target = document.createElement('button');
    target.textContent = 'Kartenlage'; document.getElementById('map').append(target);
    await UA.RisDetails.open(ctx, record.id, { section: 'locations' });
    await flush();
    const panel = document.querySelector('#risDetails');
    const control = panel.querySelector('[aria-label="Auf Karte zeigen: Kanalweg 1"]');
    control.focus(); control.click();
    return { pending, target, panel, control, guard: UA.RisLayer.showLocation.mock.calls[0][3] };
  }

  async function navigateLocationView(panel, action) {
    const control = action === 'history' || action === 'locations'
      ? [...panel.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === (action === 'history' ? 'Beratungsverlauf' : 'Orte'))
      : panel.querySelector(`[aria-label="${{ next: 'Nächste Seite Orte', previous: 'Vorherige Seite Orte',
        collapse: 'Vorgangsansicht einklappen', expand: 'Vorgangsansicht ausklappen' }[action]}"]`);
    control.focus(); control.click();
    await flush();
  }

  test('an unlocated regional document opens without changing layers or map and its link survives reload', async () => {
    document.getElementById('origin').focus();
    await UA.RisDetails?.open(ctx, record.id, { trigger: document.activeElement });
    await flush();
    const panel = document.querySelector('#risDetails');
    expect(panel?.textContent).toContain('Radverkehr am Mittellandkanal');
    expect(panel?.textContent).toContain('Regionsversammlung');
    expect(new URL(location.href).searchParams.get('risRecord')).toBe(record.id);
    expect(ctx.contextOverlays.active.ris).toBe(false);
    expect(ctx.map.setView).not.toHaveBeenCalled();
    expect(new URL(location.href).searchParams.get('centerLat')).toBe('52.375000');
    const shared = UA.RisViewState.fromSearch(location.search);
    UA.RisDetails.close(ctx);
    ctx.risView = shared;
    await UA.RisDetails.refresh(ctx);
    await flush();
    expect(document.querySelector('#risDetails')?.hidden).toBe(false);
    expect(document.querySelector('#risDetails')?.textContent).toContain(record.title);
  });

  test('closing clears the URL selection, restores focus and prevents a pending response from reopening', async () => {
    const pending = deferred();
    UA.RisCatalogue.loadRecord.mockReturnValue(pending.promise);
    const origin = document.getElementById('origin'); origin.focus();
    const opening = UA.RisDetails?.open(ctx, record.id, { trigger: origin });
    await flush();
    const close = document.querySelector('#risDetails [aria-label="Vorgangsansicht schließen"]');
    expect(close).not.toBeNull();
    close.click();
    pending.resolve(record);
    await opening;
    expect(document.querySelector('#risDetails').hidden).toBe(true);
    expect(new URL(location.href).searchParams.has('risRecord')).toBe(false);
    expect(document.activeElement).toBe(origin);
  });

  test('a city change invalidates the detail request and clears the previous city record', async () => {
    const pending = deferred();
    UA.RisCatalogue.loadRecord.mockReturnValue(pending.promise);
    const opening = UA.RisDetails?.open(ctx, record.id);
    await flush();
    ctx.CITY_RAW = 'Bonn';
    ctx.politicalContextCityRevision = Symbol('new-city');
    await UA.RisDetails?.refresh(ctx);
    pending.resolve(record);
    await opening;
    expect(document.querySelector('#risDetails')?.hidden).toBe(true);
    expect(ctx.risView.recordId).toBeNull();
    expect(new URL(location.href).searchParams.has('risRecord')).toBe(false);
  });

  test('collapse and restore preserve the selected record in the share URL', async () => {
    await UA.RisDetails?.open(ctx, record.id);
    await flush();
    const collapse = document.querySelector('#risDetails [aria-label="Vorgangsansicht einklappen"]');
    expect(collapse).not.toBeNull();
    collapse.click();
    expect(document.querySelector('.ris-details__body').hidden).toBe(true);
    expect(new URL(location.href).searchParams.get('risCollapsed')).toBe('1');
    expect(new URL(location.href).searchParams.get('risRecord')).toBe(record.id);
    document.querySelector('#risDetails [aria-label="Vorgangsansicht ausklappen"]').click();
    expect(document.querySelector('.ris-details__body').hidden).toBe(false);
    expect(new URL(location.href).searchParams.has('risCollapsed')).toBe(false);
  });

  test('showing a location on mobile collapses the open list while retaining its search state', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = () => ({ matches: true });
    try {
      ctx.risView = { listOpen: true, query: 'Kanalweg', sourceLevels: ['region'] };
      const { pending, target } = await pendingLocation();
      pending.resolve(target); await flush();
      expect(ctx.risView).toMatchObject({ listOpen: true, listCollapsed: true, collapsed: true,
        query: 'Kanalweg', sourceLevels: ['region'] });
      expect(document.activeElement).toBe(target);
      expect(new URL(location.href).searchParams.get('risListCollapsed')).toBe('1');
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  test('failed report validation shows the error without a success confirmation', async () => {
    UA.PoliticalContext = { addReferences: jest.fn().mockRejectedValue(new Error('Der Datenstand hat sich geändert.')) };
    await UA.RisDetails.open(ctx, record.id);
    const panel = document.querySelector('#risDetails');
    [...panel.querySelectorAll('button')].find(button => button.textContent === 'Für Bericht übernehmen').click();
    await flush();
    expect(panel.textContent).toContain('Der Datenstand hat sich geändert.');
    expect(panel.textContent).not.toContain('Vorgang für den Bericht übernommen.');
  });

  test('a late document response cannot replace a subsequently selected record', async () => {
    const pending = deferred();
    const next = { ...record, id: 'region-hannover-ris:vo:2003261', title: 'Änderungsantrag zum Kanalweg' };
    UA.RisCatalogue.loadRecord.mockImplementation((city, id) => id === record.id ? pending.promise : Promise.resolve(next));
    const opening = UA.RisDetails.open(ctx, record.id);
    await flush();
    await UA.RisDetails.open(ctx, next.id);
    pending.resolve(record);
    await opening;
    const panel = document.querySelector('#risDetails');
    expect(panel.textContent).toContain(next.title);
    expect(panel.textContent).not.toContain(record.title);
    expect(new URL(location.href).searchParams.get('risRecord')).toBe(next.id);
  });

  // Break caught: the layer's operation guard revives after changing or revisiting the view.
  test.each([
    ['section change', ['history']],
    ['leaving and returning to the section', ['history', 'locations']],
    ['location page change', ['next']],
    ['leaving and returning to the page', ['next', 'previous']],
    ['collapse', ['collapse']],
    ['collapse and expand', ['collapse', 'expand']],
  ])('invalidates a pending map action permanently after %s', async (_label, actions) => {
    const { pending, target, panel, control, guard } = await pendingLocation();
    expect(guard()).toBe(true);
    for (const action of actions) await navigateLocationView(panel, action);
    const selected = { ...ctx.risView };
    const focused = document.activeElement;
    expect(guard()).toBe(false);
    expect(control.getAttribute('aria-disabled')).not.toBe('true');
    expect(panel.querySelector('.ris-details__status').textContent).not.toContain('Kartenlage wird geöffnet');
    pending.resolve(target); await flush();
    expect(guard()).toBe(false);
    expect(ctx.risView).toEqual(selected);
    expect(document.activeElement).toBe(focused);
    expect(document.activeElement).not.toBe(target);
  });

  // Break caught: fixing stale responses by invalidating every refresh also cancels valid map navigation.
  test('an unchanged view lets its deferred map action finish, collapse and focus the map', async () => {
    const { pending, target, panel, guard } = await pendingLocation();
    await UA.RisDetails.refresh(ctx);
    expect(guard()).toBe(true);
    pending.resolve(target); await flush();
    expect(ctx.risView.collapsed).toBe(true);
    expect(document.activeElement).toBe(target);
    expect(panel.querySelector('.ris-details__status').textContent).toBe('');
    await navigateLocationView(panel, 'expand');
    expect(panel.querySelector('[aria-label="Auf Karte zeigen: Kanalweg 1"]').getAttribute('aria-disabled')).not.toBe('true');
  });

  // Break caught: an abandoned promise re-enables or completes a newer action on a cached button.
  test('a returned location control can start a new action while the abandoned action is unresolved', async () => {
    const { pending, target, panel, control, guard } = await pendingLocation();
    await navigateLocationView(panel, 'history');
    await navigateLocationView(panel, 'locations');
    const newer = deferred();
    UA.RisLayer.showLocation.mockReturnValueOnce(newer.promise);
    control.click();
    expect(UA.RisLayer.showLocation).toHaveBeenCalledTimes(2);
    const newGuard = UA.RisLayer.showLocation.mock.calls[1][3];
    expect(guard()).toBe(false);
    expect(newGuard()).toBe(true);
    pending.resolve(target); await flush();
    expect(ctx.risView.collapsed).toBe(false);
    expect(control.getAttribute('aria-disabled')).toBe('true');
    expect(newGuard()).toBe(true);
    newer.resolve(target); await flush();
    expect(ctx.risView.collapsed).toBe(true);
    expect(document.activeElement).toBe(target);
  });

  // Break caught: an old rejected map request writes feedback into a newly selected section.
  test('a rejected obsolete map action leaves the current section and feedback unchanged', async () => {
    const { pending, panel } = await pendingLocation();
    await navigateLocationView(panel, 'history');
    const feedback = panel.querySelector('.ris-details__status').textContent;
    pending.reject(new Error('Veraltete Kartenfehlermeldung')); await flush();
    expect(ctx.risView.section).toBe('history');
    expect(ctx.risView.collapsed).toBe(false);
    expect(panel.querySelector('.ris-details__status').textContent).toBe(feedback);
    expect(panel.textContent).not.toContain('Veraltete Kartenfehlermeldung');
  });

  // Break caught: a renderer correction does not reach canonical state and the shared URL.
  test.each([
    ['history', 'events', 'eventsPage', 'risEventsPage', 'loadRecordEvents'],
    ['relations', 'relationships', 'relationsPage', 'risRelationsPage', 'loadRecordRelationships'],
  ])('removes an unknown %s page from the shared URL with bounded catalogue reads', async (section, field, pageKey, queryKey, method) => {
    const unknown = { ...record };
    delete unknown.events; delete unknown.relationships;
    UA.RisCatalogue.loadRecord.mockResolvedValue(unknown);
    UA.RisCatalogue[method].mockImplementation(async (_city, _id, page) => ({
      [field]: [], known: false, total: null, start: 0, page, nextPage: null, complete: true, missing: [],
    }));
    ctx.risView = UA.RisViewState.normalize({ recordId: record.id, section, [pageKey]: 999 });
    UA.syncAllToUrl(ctx);
    expect(new URL(location.href).searchParams.get(queryKey)).toBe('999');
    await UA.RisDetails.refresh(ctx); await flush(); await flush();
    expect(ctx.risView[pageKey]).toBe(0);
    expect(new URL(location.href).searchParams.has(queryKey)).toBe(false);
    expect(UA.RisCatalogue[method].mock.calls.map(call => call[2])).toEqual([999, 0]);
    expect(document.querySelector(`[data-ris-collection="${field}"]`).textContent).toContain('im geprüften Datenbestand nicht dokumentiert.');
  });
});
