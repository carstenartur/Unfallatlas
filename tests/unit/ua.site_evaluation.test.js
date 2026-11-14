'use strict';

const { JSDOM } = require('jsdom');
const fs = require('node:fs');

function app(url = 'https://example.org/werkbank_v2.html?city=Test') {
  const dom = new JSDOM('<main></main>', { url, runScripts: 'outside-only' });
  const win = dom.window;
  for (const file of ['ua.core.js', 'ua.site_discovery.js', 'ua.site_evaluation.js', 'ua.site_case.js']) {
    win.eval(fs.readFileSync('js/' + file, 'utf8'));
  }
  win.UA.setQS = patch => {
    const address = new URL(win.location.href);
    for (const [key, value] of Object.entries(patch)) {
      if (value == null) address.searchParams.delete(key);
      else address.searchParams.set(key, value);
    }
    win.history.replaceState(null, '', address);
  };
  win.UA.DataResources = {fetchJson: jest.fn(async () => release)};
  return win;
}
const event = {kind: 'in-service', date: '2022-12', precision: 'month', label: 'Eröffnung', url: 'https://stadt.test/eroeffnung'};
const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const point = (year, type = '3') => ({lat: 52, lon: 9, props: {year, utyp1: type, ukategorie: '2', istrad: '1', istpkw: '1'}});
const points = [point(2019), point(2021), point(2022), point(2023), point(2024, '1')];
const release = {
  schemaVersion:1, contract:'unfallwerkbank-accident-data-release/v1',
  cities:[{city:'Test', slug:'test', years, byYear:{2019:2,2020:1,2021:2,2022:2,2023:2,2024:2,2025:1}}]
};
const bounds = {south: 51.99, north: 52.01, west: 8.99, east: 9.01};
function state(win) {
  const ctx = {CITY_RAW:'Test', allPts:years.map(y => point(y)).concat(points), accidentDataCoverage:{city:'Test',complete:true,mode:'full-city',provider:'static'}};
  const selection = {bounds, areaPoints:points, query:{fromYear:2020,toYear:2021}, pattern:{key:'turning:5',label:'Rad und Pkw'},complete:true};
  return {ctx, selection, implementation:event, release};
}

test('compares equal complete calendar years, keeps the target pattern and excludes commissioning year', () => {
  const win=app(), api=win.UA.SiteEvaluation;
  const result=api.evaluate(state(win));
  expect(result.before).toMatchObject({years:[2019,2020,2021],count:2});
  expect(result.after).toMatchObject({years:[2023,2024,2025],count:1});
  expect(result.reference).toHaveLength(0);
});
test('an administrative document date, incomplete coverage and years separated by a data gap give no impact result', () => {
  const win=app(), api=win.UA.SiteEvaluation, s=state(win);
  expect(api.evaluate({...s,implementation:{...event,kind:'council-decision'}}).status).toBe('no-date');
  expect(api.evaluate({...s,ctx:{...s.ctx,accidentDataCoverage:{complete:false}}}).status).toBe('incomplete');
  expect(api.evaluate({...s,ctx:{...s.ctx,allPts:[point(2020),point(2023)]}}).status).toBe('waiting');
});
test('a verified event after the last available annual dataset starts a pending review, including the missing years', async () => {
  const win=app(), s=state(win), panel=win.document.querySelector('main');
  win.UA.SiteEvaluation.render(panel,{...s,implementation:{...event,date:'2026-03'}});
  expect(panel.textContent).not.toContain('2027');
  panel.querySelector('.site-evaluation').open = true;
  await tick();
  expect(panel.textContent).toContain('2027');
  expect(panel.textContent).toContain('offen');
});

test('private data cannot certify full years even when the counts match the official release', async () => {
  const win = app(), s = state(win), panel = win.document.querySelector('main');
  s.ctx.accidentDataCoverage.provider = 'custom';
  expect(win.UA.SiteEvaluation.evaluate(s).status).toBe('unverified-years');
  win.UA.SiteEvaluation.render(panel, s);
  panel.querySelector('details').open = true;
  await tick();
  expect(panel.textContent).toContain('Jahresabdeckung');
  expect(panel.querySelector('table')).toBeNull();
  expect(win.UA.DataResources.fetchJson).not.toHaveBeenCalled();
});

test('the delivered lower-case city URL and release support zero local cases in complete years', () => {
  const win = app(), s = state(win);
  win.eval(fs.readFileSync('js/ua.data_v2.js', 'utf8'));
  win.eval(fs.readFileSync('js/ua.data_paths.js', 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(win.UA.DataResources.url('accidentRelease'),'utf8'));
  const city = manifest.cities.find(item => item.slug === 'bonn');
  const data = JSON.parse(require('node:zlib').gunzipSync(fs.readFileSync(city.artifacts.geojson.path)));
  s.ctx.CITY_RAW = s.ctx.accidentDataCoverage.city = 'bonn';
  s.ctx.allPts = win.UA.extractPoints(data);
  s.selection.areaPoints = [];
  const result = win.UA.SiteEvaluation.evaluate({...s,release:manifest});
  expect(result.before).toMatchObject({years:[2019,2020,2021],count:0});
  expect(result.after).toMatchObject({years:[2023,2024,2025],count:0});
});

test('a partial year limits the contiguous comparison even when that year contains crashes', () => {
  const win = app(), s = state(win), api = win.UA.SiteEvaluation;
  s.ctx.allPts.splice(s.ctx.allPts.findIndex(p => p.props.year === 2024),1);
  expect(api.evaluate(s).after.years).toEqual([2023]);
  s.ctx.allPts.splice(s.ctx.allPts.findIndex(p => p.props.year === 2023),1);
  expect(api.evaluate(s)).toEqual({status:'waiting',beforeNeeded:2021,afterNeeded:2023});
});

test('the current year is excluded even when a manifest lists a matching count', () => {
  const win = app(), s = state(win), current = new Date().getUTCFullYear();
  const yearRange = [current - 2, current - 1, current];
  s.ctx.allPts = yearRange.map(y => point(y));
  s.implementation = {...event,date:String(current - 1) + '-01'};
  s.release = {...release,cities:[{slug:'test',years:yearRange,byYear:Object.fromEntries(yearRange.map(y => [y,1]))}]};
  expect(win.UA.SiteEvaluation.evaluate(s)).toEqual({status:'waiting',beforeNeeded:current-2,afterNeeded:current});
});

test.each([null, {...release,contract:'other'}, {...release,cities:[{...release.cities[0],slug:'andere_stadt'}]}])(
  'missing or mismatched release evidence leaves the result open', proof => {
    const win = app(), s = state(win);
    expect(win.UA.SiteEvaluation.evaluate({...s,release:proof}).status).toBe('unverified-years');
  }
);

test('a release fetch failure gives an open result, and reopening retries it', async () => {
  const win = app(), s = state(win), panel = win.document.querySelector('main');
  const fetch = win.UA.DataResources.fetchJson;
  fetch.mockResolvedValueOnce(null);
  win.UA.SiteEvaluation.render(panel, s);
  expect(fetch).not.toHaveBeenCalled();
  const box = panel.querySelector('details');
  box.open = true;
  await tick();
  expect(fetch).toHaveBeenCalledWith('accidentRelease', {}, {optional:true});
  expect(panel.querySelector('table')).toBeNull();
  expect(panel.textContent).toContain('Jahresabdeckung');
  box.open = false;
  await tick();
  box.open = true;
  await tick();
  expect(panel.querySelector('table')).not.toBeNull();
  expect(fetch).toHaveBeenCalledTimes(2);
});

const tick = () => new Promise(resolve => setTimeout(resolve, 10));

test('station readings are loaded on first open, refreshed for a late file and confined to complete comparison years', async () => {
  const win = app(), s = state(win), panel = win.document.querySelector('main');
  let loaded = false;
  const stationReadings = jest.fn((ctx, bounds, {fromYear, toYear}) => {
    expect(fromYear).toBe(toYear);
    return loaded && fromYear === 2021 ? [{name:'Zählstelle', url:'https://vmz.test/station', text:'2021-07-11 · 0 Fahrräder'}] : [];
  });
  win.UA.HannoverLayers = {stationReadings};
  win.UA.SiteEvaluation.render(panel, s);
  expect(stationReadings).not.toHaveBeenCalled();
  panel.querySelector('.site-evaluation').open = true;
  await tick();
  expect(stationReadings.mock.calls.map(call => call[2].fromYear)).toEqual([2019,2020,2021,2023,2024,2025]);
  expect(panel.textContent).not.toContain('VMZ-Station');
  loaded = true;
  win.UA.SiteEvaluation.refreshTraffic(s.ctx);
  expect(panel.textContent).toContain('0 Fahrräder');
  expect(panel.querySelector('a[href="https://vmz.test/station"]').textContent).toBe('Zählstelle');
  expect(panel.textContent).toContain('unvollständig');
});

test('a source submitted in the case survives sharing and reloading only at this place, and can be removed', async () => {
  const win = app(), s = state(win), panel = win.document.querySelector('main');
  win.UA.SiteEvaluation.render(panel, {...s, implementation:null});
  panel.querySelector('input[type="month"]').value = '2022-12';
  const submitted = 'https://belege.test/Ratsdokument?antrag=123&seite=2#grundriss';
  panel.querySelector('input[type="url"]').value = submitted;
  panel.querySelector('form').dispatchEvent(new win.Event('submit', {cancelable:true}));
  await tick();
  expect(panel.querySelector('.site-evaluation').open).toBe(true);
  expect(panel.querySelector('table')).not.toBeNull();
  expect(panel.textContent).toContain(submitted);
  expect(panel.querySelector('a')).toBeNull();
  const shared = win.UA.SiteCase.permalink(s.ctx, s.selection);
  const next = app(shared), current = state(next), details = next.document.querySelector('main');
  next.UA.SiteEvaluation.render(details,{...current, implementation:null});
  expect(details.textContent).toContain(submitted);
  expect(details.querySelector('a')).toBeNull();
  const clipboard = {writeText:jest.fn().mockResolvedValue(undefined)};
  Object.defineProperty(next.navigator, 'clipboard', {value:clipboard});
  const copy = Array.from(details.querySelectorAll('button')).find(b => b.textContent === 'Quellenadresse kopieren');
  copy.click();
  await tick();
  expect(clipboard.writeText).toHaveBeenCalledWith(submitted);
  expect(details.textContent).toContain('Quellenadresse kopiert');
  clipboard.writeText.mockRejectedValueOnce(new Error('not available'));
  copy.click();
  await tick();
  expect(next.getSelection().toString()).toBe(submitted);
  expect(details.textContent).toContain('manuell kopieren');
  const other = next.document.createElement('div');
  const selection = {...current.selection, bounds:{...current.selection.bounds, north:53}};
  next.UA.SiteEvaluation.render(other,{...current, selection, implementation:null});
  expect(other.textContent).not.toContain(submitted);
  expect(other.textContent).not.toContain('Eigenen Beleg entfernen');
  const official = next.document.createElement('div');
  next.UA.SiteEvaluation.render(official,current);
  const link = official.querySelector('a');
  expect(link.href).toBe(event.url);
  expect(link.textContent).toBe(event.label);
  expect(link.rel).toContain('noopener');
  expect(official.textContent).not.toContain(submitted);
  Array.from(details.querySelectorAll('button')).find(b => b.textContent === 'Eigenen Beleg entfernen').click();
  await tick();
  expect(details.textContent).toContain('fehlt ein belegter Zeitpunkt');
  expect(details.textContent).not.toContain(submitted);
  for (const key of ['siteEvalSource','siteEvalPlace','siteEvalMonth']) {
    expect(new URL(next.location.href).searchParams.has(key)).toBe(false);
  }
});

test('a stale open case cannot delete a source from another place', () => {
  const win = app(), s = state(win), panel = win.document.querySelector('main');
  const submitted = 'https://belege.test/protokoll';
  const place = ['Test','area','',bounds.south,bounds.west,bounds.north,bounds.east].join('|');
  win.UA.setQS({siteEvalPlace:place,siteEvalMonth:event.date,siteEvalSource:submitted});
  win.UA.SiteEvaluation.render(panel,{...s,implementation:null});
  const remove = Array.from(panel.querySelectorAll('button')).find(b => b.textContent === 'Eigenen Beleg entfernen');
  win.UA.setQS({siteEvalPlace:'anderer Ort'});
  remove.click();
  expect(new URL(win.location.href).searchParams.get('siteEvalSource')).toBe(submitted);
});

test.each(['http://stadt.test/bericht','https://user:pass@stadt.test/bericht','unvollständig'])(
  'shared addresses without validated HTTPS evidence do not create an implementation', value => {
    const win = app(), s = state(win), panel = win.document.querySelector('main');
    const place = ['Test','area','',bounds.south,bounds.west,bounds.north,bounds.east].join('|');
    win.UA.setQS({siteEvalPlace:place,siteEvalMonth:event.date,siteEvalSource:value});
    win.UA.SiteEvaluation.render(panel,{...s,implementation:null});
    expect(panel.textContent).toContain('fehlt ein belegter Zeitpunkt');
    expect(panel.textContent).not.toContain(value);
    expect(panel.querySelector('a')).toBeNull();
  }
);
