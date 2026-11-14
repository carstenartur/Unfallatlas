'use strict';

const fs = require('node:fs');
const path = require('node:path');

function load(names) {
  const win = { UA: {}, location: { search: '', href: 'https://example.test/atlas/werkbank_v2.html?foo=1&export=1&siteNetworkId=old&siteEvalSource=study&find=0' } };
  for (const name of names) {
    const code = fs.readFileSync(path.join(__dirname, '../../js/' + name + '.js'), 'utf8');
    (function (window) { eval(code); })(win);
  }
  return win.UA;
}
const ctx = { CITY_RAW: 'Bonn' };
const bounds = { west: 7, south: 50, east: 7.001, north: 50.001 };
const selection = { bounds, query: { fromYear: 2020, type: 'turning' }, changes: [], points: [] };
const change = (kind, date, label = kind) => ({ kind, date, precision: 'documented-by', label, url: 'https://example.test/' + kind });
const feature = (id, coordinates) => ({ geometry: { type: 'LineString', coordinates }, properties: { geometryId: id, accuracy: 'derived' } });

function fixture() {
  const UA = load(['ua.ris-layer','ua.site_evaluation','ua.site_case']);
  const box = document.createElement('section');
  document.body.replaceChildren(box);
  return { UA, box };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('an area permalink isolates the current site and restores exact scope and query; preserves active layers and evaluation', () => {
  const { SiteCase } = load(['ua.site_case']);
  const url = new URL(SiteCase.permalink(ctx, selection));
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ city: 'Bonn', find: '1', selWest: '7', selEast: '7.001', siteFocus: 'all', siteFrom: '2020', siteType: 'turning', siteEvalSource: 'study', foo: '1' });
  expect(url.searchParams.has('siteNetworkId')).toBe(false);
  expect(url.searchParams.has('export')).toBe(false);
  const net = { id: 'j:7', revision: 'revision2026' };
  const n = new URL(SiteCase.permalink(ctx, { ...selection, site: net, pattern: {key:'turning:5'} }));
  expect(n.searchParams.get('siteNetworkId')).toBe(net.id);
  expect(n.searchParams.get('siteNetworkRev')).toBe(net.revision);
  expect(n.searchParams.get('siteFocus')).toBe('turning:5');
});

test('distinguishes a promised measure and last report from operation, and keeps dated evidence and attachments', async () => {
  const {UA,box} = fixture();
  UA.SiteEvaluation = { ...UA.SiteEvaluation, render: jest.fn() };
  const history = [
    change('implementation-status','2023-12-04','Planung ruhte'),
    { ...change('council-decision','2021-06-07','Aufpflasterung beschlossen'), attachment:{label:'Anlage',url:'https://example.test/attachment'} },
    {...change('in-service','2024-01-01','Bericht ohne Inbetriebnahmedatum')},
  ];
  UA.SiteCase.render(box, {ctx, selection:{...selection, changes:history}});
  expect(box.textContent).toContain('Umsetzungsstand');
  expect(box.querySelector('a[href="https://example.test/attachment"]')).not.toBeNull();
  expect(UA.SiteEvaluation.render.mock.calls[0][1].implementation).toBeNull();
  history.push({...change('in-service','2024-05','Verkehrsführung geändert'),precision:'month'});
  UA.SiteCase.render(box, {ctx, selection:{...selection, changes:history}});
  expect(UA.SiteEvaluation.render.mock.calls.at(-1)[1].implementation.date).toBe('2024-05');
  expect(box.textContent).toContain('Inbetriebnahme');
});

test('a drawn Bonn selection intersects the true geometry, pins catalogue pages, and deduplicates documents', async () => {
  const {UA,box} = fixture();
  const manifest = { generatedAt:'2026-11-13T00:00:00Z' };
  const hits = [feature('outside', [[6.999,50.0005],[7.0005,49.999]]), feature('street', [[6.99,50.0005],[7.01,50.0005]])];
  const record = {id:'a',date:'2026-02-02',number:'DS/123',title:'Zufahrt prüfen',url:'https://example.test/ris/a',gremium:'Rat Bonn'};
  UA.RisCatalogue = {
    loadMap:jest.fn(async()=>({partitioned:true,manifest,features:{features:hits}})),
    loadFeatureRecords:jest.fn(async(city,id,page)=>({records:[record],links:[{recordId:'a',accuracy:'derived',label:'Beispielstraße'}],nextPage:page === 0 ? 1 : null,complete:true})),
    snapshotStatus:()=>({complete:false, warnings:['Teilbestand']}),
  };
  UA.RisDetails={open:jest.fn()};
  UA.SiteCase.render(box,{ctx,selection});
  expect(UA.RisCatalogue.loadMap).not.toHaveBeenCalled();
  box.querySelector('.site-case-ris').open=true;
  await tick(); await tick();
  expect(UA.RisCatalogue.loadMap).toHaveBeenCalledWith('Bonn',expect.objectContaining({bounds:[7,50,7.001,50.001]}));
  expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenCalledWith('Bonn','street',0,{snapshot:manifest});
  expect(UA.RisCatalogue.loadFeatureRecords.mock.calls.some(call=>call[1]==='outside')).toBe(false);
  expect(box.textContent).toContain('Beispielstraße');
  expect(box.textContent).toContain('Teilbestand');
  const more = [...box.querySelectorAll('button')].find(b=>b.textContent.includes('Weitere'));
  more.click(); await tick();
  expect(UA.RisCatalogue.loadFeatureRecords).toHaveBeenCalledWith('Bonn','street',1,{snapshot:manifest});
  expect(box.querySelectorAll('a[href="https://example.test/ris/a"]')).toHaveLength(1);
  [...box.querySelectorAll('button')].find(b=>b.textContent==='Beratungsverlauf').click();
  expect(UA.RisDetails.open).toHaveBeenCalledWith(ctx,'a',expect.objectContaining({section:'history'}));
});

test('catalogue failures allow retry and old requests cannot overwrite a replacement case', async () => {
  const {UA,box} = fixture();
  let finish;
  UA.RisCatalogue={loadMap:jest.fn().mockRejectedValueOnce(new Error('Netzfehler')).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}))};
  UA.SiteCase.render(box,{ctx,selection});
  box.querySelector('.site-case-ris').open = true;
  await tick(); await tick();
  expect(box.textContent).toContain('Netzfehler');
  [...box.querySelectorAll('button')].find(b=>b.textContent.includes('erneut')).click();
  UA.SiteCase.render(box,{ctx,selection:{...selection, changes:[change('council-decision','2026-04-01','Aktueller Fall')]}});
  finish({features:{features:[]},manifest:{}});
  await tick();
  expect(box.textContent).toContain('Aktueller Fall');
  expect(box.querySelector('.site-case-ris').open).toBe(false);
});

test('legacy catalogue matches precise site points and overview is never counted as a document', async () => {
  const {UA,box} = fixture();
  const record={id:'r',title:'Bezug',url:'https://example.test/r'};
  UA.RisCatalogue={loadMap:jest.fn()
    .mockResolvedValueOnce({records:[record],features:{features:[{geometry:{type:'Point',coordinates:[7,50]},properties:{recordId:'r',accuracy:'official'}}]},manifest:{}})
    .mockResolvedValueOnce({partitioned:true,overview:true,features:{features:[]},manifest:{}})};
  UA.SiteCase.render(box,{ctx,selection}); box.querySelector('.site-case-ris').open=true;
  await tick();await tick();
  expect(box.textContent).toContain('Ortsangabe aus dem Ratsinformationssystem');
  expect(box.textContent).toContain('vom im Antrag genannten Ort abweichen');
  UA.SiteCase.render(box,{ctx,selection}); box.querySelector('.site-case-ris').open=true;
  await tick();await tick();
  expect(box.textContent).toContain('Übersichtszellen');
});
