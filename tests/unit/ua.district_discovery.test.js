'use strict';

const fs = require('fs');
const path = require('path');

function load(win, name) {
  const source = fs.readFileSync(path.resolve(__dirname, '../../js', name + '.js'), 'utf8');
  (function (window) { eval(source); })(win);
}

let UA;
beforeEach(() => {
  const win = { UA: {} };
  for (const name of ['ua.spatial-grid', 'ua.district_discovery']) load(win, name);
  UA = win.UA;
});

const bounds = { south: 52, north: 52.0002, west: 9, east: 9.0002 };
const school = (name, lon, lat, type = 'school') => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { type, name }
});

test('school screening includes a documented crossing with zero accidents and distinguishes actual proximity from a route', () => {
  const schools = UA.DistrictDiscovery.schoolIndex({features: [school('Westschule', 9.0001, 52.001)]});
  const network = {sites: new Map([
    ['crossing', {id: 'crossing', kind:'crossing', bounds, coordinates:[52.0001,9.0001], crossingFeatures:['unmarked']}],
    ['missing', {id: 'missing', kind:'crossing', bounds, coordinates:[52.0001,9.0001]}],
    ['lit', {id: 'lit', kind:'crossing', bounds, coordinates:[52.0001,9.0001], crossingFeatures:['lit','marked']}],
    ['outside', {id: 'outside', kind:'crossing', bounds, coordinates:[52.004,9.0001], crossingFeatures:['unlit']}],
  ])};
  UA.ReviewNetwork = {row: (_, id) => ({...network.sites.get(id), count:0, points:[], severeCount:0})};
  const result = UA.DistrictDiscovery.schoolCrossings({network}, {}, schools);
  expect(result.map(x=>x.id)).toEqual(['crossing']);
  expect(result[0].school.name).toBe('Westschule');
  expect(result[0].count).toBe(0);
  expect(UA.DistrictDiscovery.reason(result[0], 'school')).toMatch(/Westschule/);
  expect(UA.DistrictDiscovery.reason(result[0], 'school')).toMatch(/ohne Markierung/);
});

test('ranking counts only recurring patterns or severe occurrences for the chosen question', () => {
  const row = (id,count,severeCount,n=0) => ({id,label:id,count,severeCount,pattern:n ? {label:'Abbiegen',points:Array(n)} : null});
  const rows = [row('busy',19,0),row('repeat',8,1,5),row('severe',4,3,3)];
  expect(UA.DistrictDiscovery.rank(rows,'pattern').map(r=>r.id)).toEqual(['repeat','severe']);
  expect(UA.DistrictDiscovery.rank(rows,'severe').map(r=>r.id)).toEqual(['severe','repeat']);
  expect(UA.DistrictDiscovery.reason(rows[1],'pattern')).toContain('5');
  expect(rows.map(r=>r.id)).toEqual(['busy','repeat','severe']);
});

test('district search uses the configured municipal boundaries and excludes overlapping footprints', async () => {
  const feature = {properties:{district:'Mitte'}, geometry:{type:'Polygon',coordinates:[[[9,52],[10,52],[10,53],[9,53],[9,52]]]}};
  const collection = {features:[feature]};
  UA.DistrictBoundaries = {loadGremienData:jest.fn(async () => ({stadtbezirksgrenzen:'local.geojson'})),
    loadDistrictBoundaries:jest.fn(async () => collection),districtForSelection:jest.fn(()=>null)};
  const districts = await UA.DistrictDiscovery.loadDistricts('Bonn');
  expect(districts.names).toEqual(['Mitte']);
  expect(UA.DistrictDiscovery.inDistrict({bounds},'Mitte',districts)).toBe(false);
  expect(UA.DistrictBoundaries.districtForSelection).toHaveBeenCalledWith([feature],
    {lng:bounds.west,lat:bounds.south}, {lng:bounds.east,lat:bounds.north});
  UA.DistrictBoundaries.loadGremienData.mockResolvedValue({});
  expect(await UA.DistrictDiscovery.loadDistricts('Bonn')).toBeNull();
});

test.each([
  ['Hannover', 'Mitte', 9.72679, 52.37572, 13],
  ['Bonn', 'Beuel', 7.1210, 50.7381, 4],
])('%s applies published municipal polygons to a small case footprint', async (city, district, lon, lat, count) => {
  load({UA}, 'ua.export_v2');
  const original = global.fetch;
  try {
    global.fetch = jest.fn(async url => ({
      ok:true, json:async () => JSON.parse(fs.readFileSync(path.resolve(__dirname,'../..',url),'utf8'))
    }));
    const districts = await UA.DistrictDiscovery.loadDistricts(city);
    expect(districts.names).toHaveLength(count);
    const row = {bounds:{south:lat-.00005, north:lat+.00005, east:lon+.00005, west:lon-.00005}};
    expect(UA.DistrictDiscovery.inDistrict(row, district, districts)).toBe(true);
    expect(districts.names.filter(name => UA.DistrictDiscovery.inDistrict(row,name,districts))).toEqual([district]);
  } finally { global.fetch = original; }
});

test('a district URL opens the compact search, restores controls, updates result cases and isolates the selection on sharing', async () => {
  document.body.innerHTML = '<button id="btnDiscover">Stellen finden</button>';
  history.replaceState(null,'','/?city=Bonn&find=1&siteDistrict=Beuel&sitePriority=severe&findFrom=2021&findTo=2025');
  const win = { UA:{}, location:window.location, matchMedia:() => ({matches:true}) };
  const L = require('leaflet');
  win.L = L;
  for (const n of ['ua.core','ua.state','ua.spatial-grid','ua.site_discovery','ua.district_discovery','ua.site_discovery_ui']) load(win,n);
  const app = win.UA;
  const rect = {south:50.72, west:7.1, north:50.74, east:7.13};
  const point = (year, category, lon) => ({lat:50.73, lon, props:{year, utyp1:'2', istrad:'1', istpkw:'1', ukategorie:category}});
  const points = [point(2021,'2',7.12), point(2024,'1',7.12), point(2022,'3',7.12), point(2025,'3',7.16)];
  const candidates = (items,query) => {
    const selected = app.SiteDiscovery.filterPoints(items,query);
    return selected.length ? [{id:'beuel',label:'Beueler Straße',bounds:rect,kind:'cell',points:selected,
      count:selected.length,severeCount:selected.filter(p=>p.props.ukategorie !== '3').length,changes:[]}] : [];
  };
  app.SiteDiscovery = {...app.SiteDiscovery,candidates,loadSites:async()=>[]};
  app.DistrictDiscovery = {...app.DistrictDiscovery,
    loadDistricts:async()=>({names:['Bonn','Beuel']}),inDistrict:(row,name)=>name==='Beuel'};
  const ctx = {CITY_RAW:'Bonn',allPts:points,accidentDataCoverage:{complete:true},
    map:{getSize:()=>({x:400,y:800}),removeLayer:jest.fn(),addLayer:jest.fn()}};
  app.setSelectionArea = (context,bounds) => {
    context.selectionBounds = L.latLngBounds([bounds.south,bounds.west],[bounds.north,bounds.east]);
    return true;
  };
  app.SiteCase = {render:jest.fn()};
  app.SiteDiscoveryUI.bind(ctx);
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(document.querySelector('#siteDiscoveryPanel').hidden).toBe(false);
  expect(document.querySelector('.site-discovery-filters').open).toBe(false);
  expect(document.querySelector('#siteDiscoveryFromYear').value).toBe('2021');
  expect(document.querySelector('#siteDiscoveryDistrict').value).toBe('Beuel');
  const candidate = document.querySelector('[data-discovery-candidate]');
  expect(candidate.textContent).toMatch(/2 Unfälle mit tödlichen oder schweren Folgen/);
  candidate.click();
  expect(ctx.discoveryFocus.query.severity).toBe('serious');
  expect(app.SiteCase.render).toHaveBeenLastCalledWith(expect.any(HTMLElement),
    {ctx,selection:expect.objectContaining({points:[points[0],points[1]]})});
  expect(new URLSearchParams(location.search).get('siteDistrict')).toBe('Beuel');
  const district = document.querySelector('#siteDiscoveryDistrict');
  district.value = 'Bonn';
  district.dispatchEvent(new Event('change'));
  expect(document.querySelector('[data-discovery-candidate]')).toBeNull();
  const reopened = new URLSearchParams(location.search);
  expect(reopened.get('find')).toBe('1');
  expect(reopened.get('siteDistrict')).toBe('Bonn');
  expect(reopened.get('siteFocus')).toBeNull();
  expect(reopened.get('findFrom')).toBe('2021');
  expect(reopened.get('sitePriority')).toBe('severe');
  const drawn = [...document.querySelectorAll('button')].find(b=>b.textContent==='Fall zum markierten Bereich öffnen');
  expect(drawn.hidden).toBe(false);
  drawn.click();
  expect(app.SiteCase.render.mock.lastCall[1].selection.label).toBe('Markierter Prüfbereich');
  history.replaceState(null,'','/');
});

test('Bonn priority rows can resolve exact OSM way IDs to published street names', async () => {
  const zlib = require('node:zlib');
  const labels = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.resolve(__dirname, '../../data/mobility/road-labels/bonn.json.gz'))));
  const win = {UA:{DataResources:{fetchJsonUrl:jest.fn(async()=>labels)}}};
  load(win,'ua.local_road_labels');
  expect((await win.UA.loadLocalRoadNames('Bonn')).get('11159137')).toBe('Friedrich-Breuer-Straße');
  expect(await win.UA.loadLocalRoadNames('Berlin')).toBeNull();
  expect(win.UA.DataResources.fetchJsonUrl).toHaveBeenCalledTimes(1);
});
