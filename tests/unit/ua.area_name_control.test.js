'use strict';
const fs = require('fs');
const path = require('path');
let UA, ctx;
function bounds(north = 50.7355) {
  return { getSouth: () => 50.73, getWest: () => 7.091, getNorth: () => north, getEast: () => 7.101 };
}
beforeEach(() => {
  history.replaceState(null, '', '/werkbank_v2.html?city=Bonn&selSouth=50.73&selWest=7.091&selNorth=50.7355&selEast=7.101');
  document.body.innerHTML = '<input id="areaNameInput"><input id="areaSearchTermsInput"><button id="btnConfirmAreaName"></button><button id="btnResetAreaName"></button><div id="areaNameStatus"></div>';
  window.UA = { setQS(updates) { const u = new URL(location.href); for (const [k,v] of Object.entries(updates)) v == null ? u.searchParams.delete(k) : u.searchParams.set(k,v); history.replaceState(null,'',u); },
    computeExportReport: jest.fn(async () => ({ structured: {} })),
    PoliticalContext: { buildSearchTerms: () => ['Bonn', 'Adenauerallee', 'Südstadt'] } };
  eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.area_name_control.js'), 'utf8'));
  UA = window.UA;
  ctx = { CITY_RAW: 'Bonn', selectionBounds: bounds() };
});
test('explicit user confirmation supplies shareable name and multiple political place terms without adopting midpoint hints', async () => {
  const render = jest.fn(); UA.AreaNameControl.bind(ctx, render);
  document.getElementById('areaNameInput').value = 'Hbf / Münsterplatz & Innenstadt';
  document.getElementById('areaSearchTermsInput').value = 'Münsterplatz; Maximilianstraße; Thomas-Mann-Straße';
  document.getElementById('btnConfirmAreaName').click();
  expect(ctx.areaNameOverride).toBe('Hbf / Münsterplatz & Innenstadt');
  expect(new URL(location.href).searchParams.get('areaName')).toBe(ctx.areaNameOverride);
  expect(UA.PoliticalContext.buildSearchTerms(ctx)).toEqual(['Hbf / Münsterplatz & Innenstadt', 'Bonn', 'Münsterplatz', 'Maximilianstraße', 'Thomas-Mann-Straße']);
  expect(render).toHaveBeenCalledTimes(1);
  expect(document.getElementById('areaNameStatus').textContent).toContain('bestätigt');
  document.getElementById('btnResetAreaName').click();
  expect(ctx.areaNameOverride).toBeUndefined();
  expect(new URL(location.href).searchParams.has('areaName')).toBe(false);
});
test('changed geometry invalidates confirmation before the production report is invoked', async () => {
  UA.AreaNameControl.bind(ctx, jest.fn());
  document.getElementById('areaNameInput').value = 'Hbf'; document.getElementById('btnConfirmAreaName').click();
  ctx.selectionBounds = bounds(50.74);
  await UA.computeExportReport(ctx);
  expect(ctx.areaNameOverride).toBeUndefined();
  expect(new URL(location.href).searchParams.has('areaName')).toBe(false);
  expect(document.getElementById('areaNameStatus').textContent).toContain('erneut');
});
test('a shared explicit name restores for exactly the current geometry and stays plain text', () => {
  UA.setQS({areaName: '<img src=x onerror=alert(1)>', areaSearchTerms: 'Münsterplatz;Thomas-Mann-Straße', areaNameGeometry: JSON.stringify(['Bonn',50.73,7.091,50.7355,7.101])});
  UA.AreaNameControl.bind(ctx, jest.fn());
  expect(ctx.areaNameOverride).toBe('<img src=x onerror=alert(1)>');
  expect(document.getElementById('areaNameStatus').querySelector('img')).toBeNull();
  expect(UA.PoliticalContext.buildSearchTerms(ctx)).toContain('Thomas-Mann-Straße');
});

test('late political module still receives confirmed place terms when the report is generated', async () => {
  delete UA.PoliticalContext.buildSearchTerms;
  UA.AreaNameControl.bind(ctx, jest.fn());
  UA.PoliticalContext.buildSearchTerms = () => ['Bonn', 'Adenauerallee'];
  document.getElementById('areaNameInput').value = 'Hbf';
  document.getElementById('areaSearchTermsInput').value = 'Münsterplatz; Thomas-Mann-Straße';
  document.getElementById('btnConfirmAreaName').click();
  await UA.computeExportReport(ctx);
  expect(UA.PoliticalContext.buildSearchTerms(ctx)).toEqual(['Hbf','Bonn','Münsterplatz','Thomas-Mann-Straße']);
});

test('a stale shared name cannot be rebound to a different rectangle on reload before a report or search', () => {
  UA.AreaNameControl.bind(ctx, jest.fn());
  document.getElementById('areaNameInput').value = 'Area A';
  document.getElementById('btnConfirmAreaName').click();
  // Match the old draw order, with no report/search reconciliation in between.
  ctx.selectionBounds = bounds(50.74);
  UA.setQS({selNorth:'50.740000'});
  delete document.getElementById('btnConfirmAreaName').dataset.uaBound;
  const restored = {CITY_RAW:'Bonn',selectionBounds:bounds(50.74)};
  UA.AreaNameControl.bind(restored, jest.fn());
  expect(restored.areaNameOverride).toBeUndefined();
  expect(new URL(location.href).searchParams.has('areaName')).toBe(false);
});

test('a viewport-only shared name waits for map hydration then restores against its original geometry', () => {
  const key = JSON.stringify(['Bonn',50.73,7.091,50.7355,7.101]);
  UA.setQS({selSouth:null,selWest:null,selNorth:null,selEast:null,areaName:'Viewport A',areaNameGeometry:key});
  let hydrating=true;
  UA.isHydrating=()=>hydrating;
  UA.syncViewToUrl=jest.fn();
  const restored={CITY_RAW:'Bonn',map:{getBounds:()=>bounds(52.4)}};
  UA.AreaNameControl.bind(restored,jest.fn());
  expect(restored.areaNameOverride).toBeUndefined();
  restored.map.getBounds=()=>bounds(); hydrating=false;
  UA.syncViewToUrl(restored);
  expect(restored.areaNameOverride).toBe('Viewport A');
  expect(new URL(location.href).searchParams.get('areaName')).toBe('Viewport A');
});

test('real view URL synchronization invalidates the name before a changed geometry can be shared', () => {
  eval(fs.readFileSync(path.resolve(__dirname,'../../js/ua.ui.js'),'utf8'));
  UA.saveCityState=jest.fn();
  ctx.map={getCenter:()=>({lat:50.733,lng:7.096}),getZoom:()=>16};
  UA.AreaNameControl.bind(ctx,jest.fn());
  document.getElementById('areaNameInput').value='Area A';document.getElementById('btnConfirmAreaName').click();
  ctx.selectionBounds=bounds(50.74);
  UA.syncViewToUrl(ctx);
  const shared=new URL(location.href);
  expect(Number(shared.searchParams.get('selNorth'))).toBe(50.74);
  expect(shared.searchParams.has('areaName')).toBe(false);
  expect(shared.searchParams.has('areaNameGeometry')).toBe(false);
});

test('unbound legacy names remain editable but need confirmation for the current area', () => {
  UA.setQS({areaName:'Old unbound name'});
  UA.AreaNameControl.bind(ctx,jest.fn());
  expect(ctx.areaNameOverride).toBeUndefined();
  expect(document.getElementById('areaNameInput').value).toBe('Old unbound name');
  expect(document.getElementById('areaNameStatus').textContent).toContain('erneut');
});

test('a city switch cannot restore another city\'s name binding', () => {
  UA.setQS({city:'Hannover',areaName:'Bonn Area',areaNameGeometry:JSON.stringify(['Bonn',50.73,7.091,50.7355,7.101])});
  const next={CITY_RAW:'Hannover',selectionBounds:bounds()};
  UA.AreaNameControl.bind(next,jest.fn());
  expect(next.areaNameOverride).toBeUndefined();
  expect(new URL(location.href).searchParams.has('areaName')).toBe(false);
});

test('same-geometry sharing uses the same six-decimal precision as selection URLs', () => {
  ctx.selectionBounds=bounds(50.73550000000001);
  UA.AreaNameControl.bind(ctx,jest.fn());
  document.getElementById('areaNameInput').value='Area A';document.getElementById('btnConfirmAreaName').click();
  expect(new URL(location.href).searchParams.get('areaNameGeometry')).toBe(JSON.stringify(['Bonn',50.73,7.091,50.7355,7.101]));
  delete document.getElementById('btnConfirmAreaName').dataset.uaBound;
  const restored={CITY_RAW:'Bonn',selectionBounds:bounds()};
  UA.AreaNameControl.bind(restored,jest.fn());
  expect(restored.areaNameOverride).toBe('Area A');
});

function installResearchPanel() {
  document.body.insertAdjacentHTML('beforeend', '<button id="btnPolCtxOpen"></button><div id="polCtxPanel" style="display:none"><button id="polCtxBtnClose"></button><input id="polCtxSearchInput"><button id="polCtxBtnSearch"></button><div id="polCtxStatus"></div><div id="polCtxResults"></div><div id="polCtxBasis"></div></div>');
  for (const file of ['ua.utils.js', 'ua.political-context.js']) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js', file), 'utf8'));
  }
  ctx.locationHint = { street: 'Adenauerallee', district: 'Südstadt', label: 'Adenauerallee, Südstadt' };
  UA.ensureLocationHint = jest.fn(async () => ctx.locationHint);
  UA.PoliticalContext.search = jest.fn(async params => ({ references: [], meta: { city: params.city, searchTerms: params.searchTerms, searchStatus: 'searched-no-results', supported: true } }));
  UA.AreaNameControl.bind(ctx, jest.fn());
  return document.getElementById('polCtxSearchInput');
}
function confirmResearchArea(name, places, north = 50.7355) {
  ctx.selectionBounds = bounds(north);
  document.getElementById('areaNameInput').value = name;
  document.getElementById('areaSearchTermsInput').value = places;
  document.getElementById('btnConfirmAreaName').click();
}
function closeResearchPanel() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

test('reopening research replaces its generated midpoint and area A terms after confirming area B', async () => {
  const input = installResearchPanel();
  await UA.PoliticalContext.openPanel(ctx);
  expect(input.value).toContain('Adenauerallee');
  closeResearchPanel();
  confirmResearchArea('Hbf / Münsterplatz', 'Münsterplatz; Maximilianstraße');
  await UA.PoliticalContext.openPanel(ctx);
  expect(UA.PoliticalContext.search.mock.calls.at(-1)[0].searchTerms).toEqual(['Hbf / Münsterplatz', 'Münsterplatz', 'Maximilianstraße']);
  expect(input.value).not.toMatch(/Adenauerallee|Südstadt/);
  closeResearchPanel();
  confirmResearchArea('Beuel Bahnhof', 'Bahnhofstraße; Beuel', 50.74);
  await UA.PoliticalContext._runSearch(ctx);
  expect(UA.PoliticalContext.search.mock.calls.at(-1)[0].searchTerms).toEqual(['Beuel Bahnhof', 'Bahnhofstraße', 'Beuel']);
  await UA.PoliticalContext.openPanel(ctx);
  expect(UA.PoliticalContext.search.mock.calls.at(-1)[0].searchTerms).toEqual(['Beuel Bahnhof', 'Bahnhofstraße', 'Beuel']);
  expect(input.value).not.toMatch(/Adenauerallee|Südstadt|Münsterplatz|Maximilianstraße/);
});

test.each([null, 'Tempo 30; Schulwegsicherheit'])('explicit manual research input (%s) survives a new area confirmation', async value => {
  const input = installResearchPanel();
  await UA.PoliticalContext.openPanel(ctx);
  // Even choosing to keep the same visible text is an explicit manual edit.
  if (value !== null) input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  const manual = input.value;
  closeResearchPanel();
  confirmResearchArea('Beuel Bahnhof', 'Bahnhofstraße', 50.74);
  await UA.PoliticalContext.openPanel(ctx);
  expect(input.value).toBe(manual);
  expect(UA.PoliticalContext.search.mock.calls.at(-1)[0].searchTerms).toEqual(manual.split(/[,;]+/).map(term => term.trim()));
});

test('AI request and real server variants use confirmed area B rather than midpoint or area A context', async () => {
  installResearchPanel();
  const search = UA.PoliticalContext.search;
  UA.getRuntimeContext = () => ctx;
  UA.aiProposal = { _internal: { mirrorExportOptions() {}, buildExternalAiFactsPackage: value => value } };
  eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.ai_political_evidence.js'), 'utf8'));
  const { buildSearchVariants } = require('../../server/political-context/services/searchVariantBuilder');
  for (const [name, places, north] of [['Hbf / Münsterplatz', 'Münsterplatz; Maximilianstraße', 50.7355], ['Beuel Bahnhof', 'Bahnhofstraße; Beuel', 50.74]]) {
    confirmResearchArea(name, places, north);
    await UA.aiPoliticalEvidence.ensurePoliticalResearch(ctx);
    const request = search.mock.calls.at(-1)[0];
    expect(request.context).toEqual({ location: name, street: '', district: '', gremium: '' });
    const expanded = buildSearchVariants(request.searchTerms, request.context);
    expect(expanded).toContain(name);
    expect(JSON.stringify({ request, expanded })).not.toMatch(/Adenauerallee|Südstadt/);
    if (name === 'Beuel Bahnhof') expect(JSON.stringify({ request, expanded })).not.toMatch(/Münsterplatz|Maximilianstraße/);
  }
  // Confirmation must stop governing research when its geometry is no longer valid.
  ctx.selectionBounds = bounds(50.75);
  expect(UA.aiPoliticalEvidence._internal.currentLocationContext(ctx)).toMatchObject({ street: 'Adenauerallee' });
  expect(ctx.areaNameOverride).toBeUndefined();
});
