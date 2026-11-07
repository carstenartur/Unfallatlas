/** @jest-environment jsdom */
'use strict';

test('keeps linked originals and answers once each and separates selected cities', () => {
  require('../../js/ua.political-context.js');
  const ctx = { CITY_RAW: 'Hannover' };
  const base = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/';
  const original = { id: 'orig', title: 'Anfrage', url: base + '1047-2026' };
  const answer = { id: 'answer', title: 'Verwaltungsantwort', url: base + '1047-2026F1', relatedTo: 'orig' };
  const add = window.UA.PoliticalContext.addReferences;
  add(ctx, [original]);
  add(ctx, [original, answer]);
  expect(ctx.politicalReferences).toEqual([original, answer]);
  ctx.CITY_RAW = 'Bonn';
  const bonn = { title: 'Bonner Vorlage', url: 'https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2028602' };
  add(ctx, [bonn, { title: 'invalid', url: 'javascript:void(0)' }]);
  expect(ctx.politicalReferences).toEqual([bonn]);
  document.body.innerHTML = '<div id="polCtxResults">Alter Treffer</div><input id="polCtxSearchInput" value="Bonn">';
  ctx.CITY_RAW = 'Hannover';
  ctx.politicalSearchRequest = Symbol('Bonn');
  window.UA.PoliticalContext.resetCity(ctx);
  expect(ctx.politicalReferences).toEqual([]);
  expect(ctx.politicalSearchRequest).toBeNull();
  expect(document.getElementById('polCtxResults').childNodes).toHaveLength(0);
  expect(document.getElementById('polCtxSearchInput').value).toBe('');
});

test('leaves a focused search input alone when the automatic location hint arrives', async () => {
  document.body.innerHTML = '<div id="polCtxPanel"><input id="polCtxSearchInput"></div>';
  const input = document.getElementById('polCtxSearchInput');
  let locationReady;
  window.UA.createModalController = () => ({ open() {} });
  window.UA.ensureLocationHint = () => new Promise(resolve => { locationReady = resolve; });
  const open = window.UA.PoliticalContext.openPanel({ CITY_RAW: 'Hannover', locationHint: { street: 'Limmerstraße' } });
  input.focus();
  locationReady();
  await open;
  expect(input.value).toBe('');
});
