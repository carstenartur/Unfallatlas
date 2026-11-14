'use strict';

const { JSDOM } = require('jsdom');
const fs = require('node:fs');

function app(url = 'https://example.org/werkbank_v2.html?city=Test') {
  const dom = new JSDOM('<main></main>', { url, runScripts: 'outside-only' });
  const win = dom.window;
  for (const file of ['ua.site_discovery.js', 'ua.site_evaluation.js', 'ua.site_case.js']) {
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
  return win;
}
const event = {kind: 'in-service', date: '2022-12', precision: 'month', label: 'Eröffnung', url: 'https://stadt.test/eroeffnung'};
const years = [2019, 2020, 2021, 2022, 2023, 2024, 2025];
const point = (year, type = '3') => ({lat: 52, lon: 9, props: {year, utyp1: type, ukategorie: '2', istrad: '1', istpkw: '1'}});
const points = [point(2019), point(2021), point(2022), point(2023), point(2024, '1')];
const bounds = {south: 51.99, north: 52.01, west: 8.99, east: 9.01};
function state(win) {
  const ctx = {CITY_RAW:'Test', allPts:years.map(y => point(y)).concat(points), accidentDataCoverage:{city:'Test',complete:true}};
  const selection = {bounds, areaPoints:points, query:{fromYear:2020,toYear:2021}, pattern:{key:'turning:5',label:'Rad und Pkw'},complete:true};
  return {ctx, selection, implementation:event};
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
  panel.querySelector('input[type="url"]').value = 'https://stadt.test/freigabe';
  panel.querySelector('form').dispatchEvent(new win.Event('submit', {cancelable:true}));
  await tick();
  expect(panel.querySelector('.site-evaluation').open).toBe(true);
  expect(panel.querySelector('table')).not.toBeNull();
  const shared = win.UA.SiteCase.permalink(s.ctx, s.selection);
  const next = app(shared), current = state(next), details = next.document.querySelector('main');
  next.UA.SiteEvaluation.render(details,{...current, implementation:null});
  expect(details.querySelector('a').href).toBe('https://stadt.test/freigabe');
  const other = next.document.createElement('div');
  const selection = {...current.selection, bounds:{...current.selection.bounds, north:53}};
  next.UA.SiteEvaluation.render(other,{...current, selection, implementation:null});
  expect(other.querySelector('a')).toBeNull();
  Array.from(details.querySelectorAll('button')).find(b => b.textContent === 'Eigenen Beleg entfernen').click();
  await tick();
  expect(details.textContent).toContain('fehlt ein belegter Zeitpunkt');
  expect(new URL(next.location.href).searchParams.has('siteEvalSource')).toBe(false);
});
