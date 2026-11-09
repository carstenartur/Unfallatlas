'use strict';

const fs = require('fs');
const path = require('path');
const L = require('leaflet');

const listDefaults = { listOpen: false, listCollapsed: false, query: '', sourceLevels: [], searchCursor: null, searchGeneration: null };
const defaults = {
  ...listDefaults,
  selectionOnly: false, recordId: null, section: 'history', collapsed: false,
  eventsPage: 0, relationsPage: 0, relatedPage: 0, locationsPage: 0,
};
const workedView = {
  ...listDefaults,
  selectionOnly: true, recordId: 'region-hannover-ris:2026/123', section: 'relations', collapsed: true,
  eventsPage: 2, relationsPage: 3, relatedPage: 4, locationsPage: 5,
};
const risQuery = {
  risSelectionOnly: '1', risRecord: 'region-hannover-ris:2026/123', risView: 'relations', risCollapsed: '1',
  risEventsPage: '2', risRelationsPage: '3', risRelatedPage: '4', risLocationsPage: '5',
};

function load(win, name) {
  (function (window) { eval(fs.readFileSync(path.resolve(__dirname, '../../js', name), 'utf8')); })(win);
}

function loadModules() {
  const browser = window;
  const navigation = [];
  const win = {
    UA: {}, L,
    location: {
      get href() { return browser.location.href; },
      get search() { return browser.location.search; },
      assign(url) { navigation.push(url); },
      replace(url) { navigation.push(url); },
    },
  };
  for (const name of ['ua.utils.js', 'ua.ris_view_state.js', 'ua.state.js', 'ua.ui.js', 'ua.map_v2.js']) load(win, name);
  return { win, UA: win.UA, navigation };
}

function attachMap(ctx) {
  let center = { lat: 52.3759, lng: 9.732 };
  let zoom = 12;
  ctx.map = {
    getCenter: () => ({ ...center }), getZoom: () => zoom,
    setView(position, nextZoom) { center = { lat: position[0], lng: position[1] }; zoom = nextZoom; },
    getBounds: () => L.latLngBounds([52.35, 9.7], [52.4, 9.8]),
    on() {}, off() {},
  };
  ctx.drawnItems = L.featureGroup();
  ctx.selectionBounds = null;
}

function makeContext(UA) {
  const ctx = {
    CITY_RAW: 'Hannover', involvementMode: 'or', showCluster: true, showHeatmap: true,
    showOnlyAboveAverage: false, showSchools: true, showKindergartens: true, showArgumentation: true,
    contextOverlays: { active: { slope: true, traffic: true, ris: true } },
    risView: { ...workedView },
  };
  attachMap(ctx);
  UA.bindDom(ctx);
  UA.setCityDropdown(ctx, ['Hannover', 'Bonn']);
  return ctx;
}

function savedState() {
  return {
    severity: '2', roadCondition: '1', dayType: 'weekend', hourFrom: 7, hourTo: 9,
    maxPoints: 500, viewportPaddingPct: 50, heatRadius: 40,
    includeCyclist: 0, includePedestrian: 0, includeCar: 0, includeMotorcycle: 1,
    includeGkfz: 1, includeSonstig: 1, involvementMode: 'solo', showCluster: 0,
    showHeatmap: 1, showOnlyAboveAverage: 1, centerLat: 52.4, centerLon: 9.8, zoom: 15,
    sel: { s: 52.39, w: 9.79, n: 52.41, e: 9.81 },
    contextOverlays: { active: { slope: false, traffic: true, ris: true } },
    risView: { ...workedView, recordId: 'region-hannover-ris:saved' },
  };
}

function flush() { return new Promise(resolve => setTimeout(resolve, 0)); }

async function startApp() {
  const modules = loadModules();
  const { UA, win } = modules;
  const trace = { initial: null, layers: [], details: [] };
  // Keep the actual state, UI, storage and startup paths. Only replace external
  // data access and Leaflet rendering; the assertions cover their state boundary.
  UA.initLeaflet = ctx => {
    trace.initial = { view: ctx.risView && { ...ctx.risView }, ris: ctx.contextOverlays?.active?.ris };
    attachMap(ctx);
  };
  UA.loadCitiesList = async () => ['Hannover', 'Bonn'];
  UA.loadCityData = async ctx => {
    ctx.allPts = [{ lat: 52.375, lng: 9.732 }];
    ctx.contextCapabilities = { hasSlope: true, hasTrafficProxy: true, hasOsmContext: true };
  };
  UA.loadPOIData = async () => {};
  UA.fitToAllPoints = ctx => ctx.map.setView([52.3759, 9.732], 12);
  UA.applyFilters = ctx => { ctx.filteredAll = ctx.allPts; };
  UA.applyViewportFilter = ctx => { ctx.viewportPts = ctx.filteredAll; };
  UA.renderLayers = () => {};
  UA.refreshContextOverlays = () => {};
  UA.RisLayer = { refresh(ctx) { trace.layers.push({ hydrating: UA.isHydrating(), selection: !!ctx.selectionBounds }); } };
  UA.RisDetails = { refresh(ctx) {
    trace.details.push({
      hydrating: UA.isHydrating(), view: ctx.risView && { ...ctx.risView },
      center: ctx.map.getCenter(), query: Object.fromEntries(UA.qs()),
    });
  } };
  load(win, 'ua.app_v2.js');
  await flush();
  return { ...modules, ctx: UA.getRuntimeContext(), trace };
}

beforeEach(() => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../werkbank_v2.html'), 'utf8');
  document.body.innerHTML = new DOMParser().parseFromString(html, 'text/html').body.innerHTML;
  document.querySelectorAll('script').forEach(script => script.remove());
  global.L = L;
  localStorage.clear();
  history.replaceState(null, '', '/werkbank_v2.html?city=Hannover');
});

describe('RIS URL and local storage integration', () => {
  test('syncing a worked view persists its RIS fields and all three layer flags in the copied URL', () => {
    const { UA } = loadModules();
    const ctx = makeContext(UA);
    ctx.selectionBounds = L.latLngBounds([52.37, 9.72], [52.38, 9.74]);

    UA.syncAllToUrl(ctx);

    const query = Object.fromEntries(new URL(window.location.href).searchParams);
    expect(query).toEqual(expect.objectContaining({ ...risQuery, mapLayer: 'slope,traffic,ris', selSouth: '52.370000', zoom: '12' }));
    const stored = JSON.parse(localStorage.getItem('ua_state_hannover'));
    expect(stored.risView).toEqual(workedView);
    expect(stored.contextOverlays).toEqual({ active: { slope: true, traffic: true, ris: true } });
  });

  test('closing the document removes stale detail parameters without disabling the RIS map or selection filter', () => {
    history.replaceState(null, '', `/werkbank_v2.html?${new URLSearchParams({ city: 'Hannover', mapLayer: 'ris', ...risQuery })}`);
    const { UA } = loadModules();
    const ctx = makeContext(UA);
    ctx.risView = { ...workedView, recordId: null };
    ctx.contextOverlays.active = { slope: false, traffic: false, ris: true };

    UA.syncAllToUrl(ctx);

    const query = new URL(window.location.href).searchParams;
    expect(query.get('mapLayer')).toBe('ris');
    expect(query.get('risSelectionOnly')).toBe('1');
    for (const key of ['risRecord', 'risView', 'risCollapsed', 'risEventsPage', 'risRelationsPage', 'risRelatedPage', 'risLocationsPage']) expect(query.has(key)).toBe(false);
    expect(JSON.parse(localStorage.getItem('ua_state_hannover')).risView).toEqual({ ...defaults, selectionOnly: true });
  });

  test('removing the marked rectangle clears only the area filter and keeps the opened document', () => {
    history.replaceState(null, '', `/werkbank_v2.html?${new URLSearchParams({ city: 'Hannover', ...risQuery, selSouth: '52.37', selWest: '9.72', selNorth: '52.38', selEast: '9.74' })}`);
    const { UA } = loadModules();
    const ctx = makeContext(UA);

    UA.syncViewToUrl(ctx, true);

    expect(ctx.risView).toEqual({ ...workedView, selectionOnly: false });
    const query = new URL(window.location.href).searchParams;
    expect(query.has('risSelectionOnly')).toBe(false);
    expect(query.has('selSouth')).toBe(false);
    expect(query.get('risRecord')).toBe('region-hannover-ris:2026/123');
    expect(query.get('risRelatedPage')).toBe('4');
  });

  test('city-only restoration recovers RIS data while retaining the live overlay registry', () => {
    const { UA } = loadModules();
    const ctx = makeContext(UA);
    const registry = ctx.contextOverlays;
    registry.layers = { slope: { live: true } };
    const saved = savedState();
    localStorage.setItem('ua_state_hannover', JSON.stringify(saved));

    expect(UA.restoreCityStateIfNoUrlView(ctx)).toBe(true);

    expect(ctx.risView).toEqual({ ...workedView, recordId: 'region-hannover-ris:saved' });
    expect(ctx.contextOverlays).toBe(registry);
    expect(ctx.contextOverlays.active).toEqual({ slope: false, traffic: true, ris: true });
    expect(ctx.contextOverlays.layers.slope).toEqual({ live: true });
  });

  test('intermediate hydration renders do not overwrite a previously saved city view', () => {
    const { UA } = loadModules();
    const ctx = makeContext(UA);
    const saved = JSON.stringify(savedState());
    localStorage.setItem('ua_state_hannover', saved);

    UA.setHydrating(true);
    UA.saveCityState(ctx);

    expect(localStorage.getItem('ua_state_hannover')).toBe(saved);
  });

  test('changing city removes city-specific document and selection state while retaining layer choices', () => {
    history.replaceState(null, '', `/werkbank_v2.html?${new URLSearchParams({ city: 'Hannover', ...risQuery, mapLayer: 'slope,traffic,ris', severity: '2', centerLat: '52.37', centerLon: '9.73', zoom: '15' })}`);
    const { UA, navigation } = loadModules();
    const ctx = makeContext(UA);
    UA.bindUi(ctx);

    ctx.ui.citySel.value = 'Bonn';
    ctx.ui.citySel.dispatchEvent(new Event('change'));

    expect(navigation).toHaveLength(1);
    expect(Object.fromEntries(new URL(navigation[0]).searchParams)).toEqual({ city: 'Bonn', mapLayer: 'slope,traffic,ris', severity: '2' });
    expect(JSON.parse(localStorage.getItem('ua_state_hannover')).risView).toEqual(workedView);
  });
});

describe('RIS application hydration', () => {
  test('an explicit share overrides local storage before controls mount, then opens details after URL and selection hydration', async () => {
    localStorage.setItem('ua_state_hannover', JSON.stringify(savedState()));
    history.replaceState(null, '', `/werkbank_v2.html?${new URLSearchParams({
      city: 'Hannover', mapLayer: 'slope,traffic,ris', ...risQuery,
      centerLat: '52.375', centerLon: '9.732', zoom: '16',
      selSouth: '52.37', selWest: '9.72', selNorth: '52.38', selEast: '9.74',
    })}`);

    const { ctx, trace } = await startApp();

    expect(trace.initial).toEqual({ view: workedView, ris: true });
    expect(ctx.contextOverlays.active).toEqual({ slope: true, traffic: true, ris: true });
    expect(trace.layers).toContainEqual({ hydrating: false, selection: true });
    expect(trace.details).toHaveLength(1);
    expect(trace.details[0]).toEqual(expect.objectContaining({ hydrating: false, view: workedView, center: { lat: 52.375, lng: 9.732 } }));
    expect(trace.details[0].query).toEqual(expect.objectContaining({ ...risQuery, mapLayer: 'slope,traffic,ris', zoom: '16' }));
    expect(ctx.selectionBounds.toBBoxString()).toBe('9.72,52.37,9.74,52.38');
  });

  test('a city-only entry retains restored document and layer state through the later startup defaults', async () => {
    localStorage.setItem('ua_state_hannover', JSON.stringify(savedState()));

    const { ctx, trace } = await startApp();

    expect(ctx.risView).toEqual({ ...workedView, recordId: 'region-hannover-ris:saved' });
    expect(ctx.contextOverlays.active).toEqual({ slope: false, traffic: true, ris: true });
    expect(ctx.map.getCenter()).toEqual({ lat: 52.4, lng: 9.8 });
    expect(trace.details[0]?.query).toEqual(expect.objectContaining({ mapLayer: 'traffic,ris', risRecord: 'region-hannover-ris:saved', risRelatedPage: '4' }));
  });

  test('a document-only share remains independent of a previously enabled RIS map layer and saved rectangle', async () => {
    localStorage.setItem('ua_state_hannover', JSON.stringify(savedState()));
    history.replaceState(null, '', '/werkbank_v2.html?city=Hannover&risRecord=region-hannover-ris%3Aunmapped&risView=locations');

    const { ctx, trace } = await startApp();

    expect(ctx.risView).toEqual({ ...defaults, recordId: 'region-hannover-ris:unmapped', section: 'locations' });
    expect(ctx.contextOverlays.active).toEqual({ slope: false, traffic: false, ris: false });
    expect(ctx.selectionBounds).toBeNull();
    expect(trace.details[0]?.view.recordId).toBe('region-hannover-ris:unmapped');
    expect(new URL(window.location.href).searchParams.has('mapLayer')).toBe(false);
  });
});

test('an in-place tour city switch invalidates the selected record before loading the next city', async () => {
  history.replaceState(null, '', `/werkbank_v2.html?${new URLSearchParams({ city: 'Hannover', ...risQuery, mapLayer: 'ris' })}`);
  const { UA, win } = loadModules();
  const ctx = makeContext(UA);
  ctx.contextOverlays.active = { slope: false, traffic: false, ris: true };
  let stateAtDataRequest;
  UA.loadCityData = async () => { stateAtDataRequest = { ...ctx.risView }; };
  UA.loadPOIData = async () => {};
  UA.recomputeAndRender = () => {};
  load(win, 'ua.tour.js');
  UA.initTour(ctx);
  document.getElementById('recorderJson').value = JSON.stringify({ steps: [{ action: 'setCity', value: 'Bonn', pause: 1000 }] });

  document.getElementById('recorderBtnPlay').click();
  await flush();
  UA.tourStop();

  expect(ctx.CITY_RAW).toBe('Bonn');
  expect(stateAtDataRequest).toEqual(defaults);
  expect(ctx.risView).toEqual(defaults);
  expect(Object.fromEntries(new URL(window.location.href).searchParams)).toEqual({ city: 'Bonn', mapLayer: 'ris' });
});
