/** @jest-environment jsdom */
'use strict';

test('keeps linked originals and answers once each and separates selected cities', async () => {
  require('../../js/ua.political-context.js');
  const ctx = { CITY_RAW: 'Hannover' };
  const base = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/';
  const original = { id: 'orig', title: 'Anfrage', url: base + '1047-2026' };
  const answer = { id: 'answer', title: 'Verwaltungsantwort', url: base + '1047-2026F1', relatedTo: 'orig' };
  const add = window.UA.PoliticalContext.addReferences;
  await add(ctx, [original]);
  await add(ctx, [original, answer]);
  expect(ctx.politicalReferences).toEqual([original, answer]);
  ctx.CITY_RAW = 'Bonn';
  const bonn = { title: 'Bonner Vorlage', url: 'https://www.bonn.sitzung-online.de/public/VO020?VOLFDNR=2028602' };
  await add(ctx, [bonn, { title: 'invalid', url: 'javascript:void(0)' }]);
  expect(ctx.politicalReferences).toEqual([bonn]);
  document.body.innerHTML = '<div id="polCtxResults">Alter Treffer</div><input id="polCtxSearchInput" value="Bonn">';
  ctx.CITY_RAW = 'Hannover';
  ctx.politicalSearchRequest = Symbol('Bonn');
  window.UA.lastPoliticalContextResearch = { city: 'Bonn', searchTerms: ['Adenauerallee'] };
  window.UA.PoliticalContext.resetCity(ctx);
  expect(ctx.politicalReferences).toEqual([]);
  expect(ctx.politicalSearchRequest).toBeNull();
  expect(window.UA.lastPoliticalContextResearch).toBeNull();
  expect(document.getElementById('polCtxResults').childNodes).toHaveLength(0);
  expect(document.getElementById('polCtxSearchInput').value).toBe('');
});

test('leaves previously selected references intact if a snapshot selection cannot be verified', async () => {
  require('../../js/ua.political-context.js');
  const api = window.UA.PoliticalContext;
  const original = { title: 'Amtliche Vorlage', url: 'https://www.bonn.sitzung-online.de/public/' };
  const missing = { id: 'missing', ...original, snapshot: { city: 'bonn', sha256: 'a'.repeat(64) } };
  const ctx = { CITY_RAW: 'Bonn', politicalReferences: [original] };
  window.UA.RisCatalogue = {
    cityKey: value => value.toLowerCase(),
    resolveReferences: jest.fn().mockRejectedValue(new Error('Der Vorgang ist im aktuellen Katalog nicht enthalten.'))
  };
  await expect(Promise.resolve(api.addReferences(ctx, [missing]))).rejects.toThrow(/aktuellen Katalog/);
  expect(ctx.politicalReferences).toEqual([original]);
});

test('discards snapshot adoption when the city changes and returns while verification is pending', async () => {
  require('../../js/ua.political-context.js');
  const api = window.UA.PoliticalContext;
  const ctx = { CITY_RAW: 'Bonn' };
  const reference = {
    id: 'official', title: 'Amtliche Vorlage', url: 'https://www.bonn.sitzung-online.de/public/',
    snapshot: { city: 'bonn', sha256: 'a'.repeat(64) }
  };
  let finish;
  window.UA.RisCatalogue = {
    cityKey: value => value.toLowerCase(),
    resolveReferences: () => new Promise(resolve => { finish = resolve; })
  };
  const adoption = Promise.resolve(api.addReferences(ctx, [reference]));
  ctx.CITY_RAW = 'Hannover';
  api.resetCity(ctx);
  ctx.CITY_RAW = 'Bonn';
  api.resetCity(ctx);
  finish?.([reference]);
  await expect(adoption).rejects.toThrow(/Stadt/);
  expect(ctx.politicalReferences).toEqual([]);
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

test('shows literal search terms without interpreting them as markup', async () => {
  require('../../js/ua.political-context.js');
  document.body.innerHTML = '<input id="polCtxSearchInput"><div id="polCtxBasis"></div>'
    + '<div id="polCtxStatus"></div><div id="polCtxResults"></div>';
  document.getElementById('polCtxSearchInput').value = '<img src=x>, Limmerstraße';
  const api = window.UA.PoliticalContext;
  const search = jest.spyOn(api, 'search').mockResolvedValue({
    references: [], meta: { supported: true, searchStatus: 'searched-no-results' }
  });
  try {
    await api._runSearch({ CITY_RAW: 'Hannover' });
    const basis = document.getElementById('polCtxBasis');
    expect(basis.querySelector('img')).toBeNull();
    expect([...basis.querySelectorAll('strong')].map(term => term.textContent))
      .toEqual(['<img src=x>', 'Limmerstraße']);
  } finally {
    search.mockRestore();
  }
});

test('shows the named places and their evidence in a search result, including text-only places', async () => {
  require('../../js/ua.utils.js');
  require('../../js/ua.political-context.js');
  document.body.innerHTML = '<input id="polCtxSearchInput" value="Limmerstraße">'
    + '<div id="polCtxStatus"></div><div id="polCtxResults"></div>';
  const api = window.UA.PoliticalContext;
  const search = jest.spyOn(api, 'search').mockResolvedValue({
    references: [{
      id: 'hannover-sim:15-1570-2026', title: 'Verbesserung der Querungen', type: 'Antrag',
      url: 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/15-1570-2026',
      locations: [{
        label: 'Limmerstraße / Kötnerholzweg', kind: 'junction', mapped: true,
        evidence: { source: 'title', text: 'Querung Limmerstraße / Kötnerholzweg' }
      }, {
        label: 'Spielplatz <img src=x>', kind: 'place', mapped: false,
        evidence: { source: 'document', text: 'am Spielplatz <img src=x>' }
      }]
    }],
    meta: { supported: true, searchStatus: 'results-found' }
  });
  try {
    await api._runSearch({ CITY_RAW: 'Hannover' });
    const result = document.querySelector('.polCtxRef');
    const [junction, place] = result.querySelectorAll('li');
    expect(junction?.textContent).toContain('Kreuzung');
    expect(junction.textContent).toContain('Limmerstraße / Kötnerholzweg');
    expect(junction.textContent).toContain('Titel: „Querung Limmerstraße / Kötnerholzweg“');
    expect(place.textContent).toContain('Spielplatz <img src=x>');
    expect(place.textContent).toContain('Nicht auf der Karte verortet');
    expect(place.textContent).toContain('Dokument: „am Spielplatz <img src=x>“');
    expect(result.querySelector('img')).toBeNull();
    result.querySelector('input[type="checkbox"]').click();
    expect(api.getSelectedReferences()[0].title).toBe('Verbesserung der Querungen');
  } finally {
    search.mockRestore();
  }
});

test.each([
  ['unresolved', ['no_specific_location'], false, /Kein eindeutiger Ortsbezug/],
  ['unavailable', ['gazetteer_unavailable'], false, /Keine geeigneten Geodaten/],
  ['partial', ['document_text_unavailable', 'location_limit'], true, /Teilweise auf der Karte verortet/],
])('shows the %s assessment even without a list of named locations', async (status, reasons, truncated, explanation) => {
  require('../../js/ua.utils.js');
  require('../../js/ua.political-context.js');
  document.body.innerHTML = '<input id="polCtxSearchInput" value="Radverkehr">'
    + '<div id="polCtxStatus"></div><div id="polCtxResults"></div>';
  const api = window.UA.PoliticalContext;
  const search = jest.spyOn(api, 'search').mockResolvedValue({
    references: [{
      id: 'bonn-paper-123', title: 'Radverkehr verbessern', type: 'Antrag',
      url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123',
      locationAssessment: { status, sources: ['title'], reasons, truncated },
    }], meta: { supported: true, searchStatus: 'results-found' },
  });
  try {
    await api._runSearch({ CITY_RAW: 'Bonn' });
    const result = document.querySelector('.polCtxRef');
    const assessment = result.querySelector('[aria-label="Ortsprüfung"]');
    expect(assessment?.textContent).toMatch(explanation);
    expect(assessment.textContent).toContain('Titel');
    if (truncated) expect(assessment.textContent).toMatch(/begrenzt|nicht alle/i);
    if (reasons.includes('document_text_unavailable')) expect(assessment.textContent).toMatch(/Dokumenttext.*nicht.*verfügbar/i);
    expect([...result.querySelectorAll('button')].some(button => button.textContent === 'Auf Karte zeigen')).toBe(false);
  } finally {
    search.mockRestore();
  }
});
