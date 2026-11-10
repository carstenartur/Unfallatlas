'use strict';

const bounds = { south: 52.37, west: 9.70, north: 52.3702, east: 9.75 };
const location = (id, name, type, lon, lat) => ({
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: { id, name, type },
});
const poi = (...features) => ({
  features,
  properties: {
    retrievedAt: '2026-08-01T05:06:55Z',
    source: { requiredAttribution: '© OpenStreetMap contributors' },
  },
});
const planUrl = 'https://www.hannover.de/content/download/1/file/schulwegplan.pdf';
const school = (routes = []) => ({
  name: 'Grundschule Beispiel',
  osmId: 'osm:way:1',
  plans: [{ name: 'Schulwegplan', url: planUrl, routes }],
});
const catalog = (...schools) => ({ year: 2026, schools });

beforeEach(() => {
  jest.resetModules();
  window.UA = {};
  require('../../js/ua.facility_context.js');
});

afterEach(() => {
  delete window.UA;
});

test('uses the actual rectangle rather than the enclosing circle for POI counts', () => {
  const result = window.UA.FacilityContext.analyze(poi(
    location('osm:way:1', 'Innen', 'school', 9.73, 52.3701),
    location('osm:node:2', 'Nah am Ostende', 'childcare', 9.751, 52.3705),
    location('osm:node:3', 'Weit nördlich der Mitte', 'kindergarten', 9.725, 52.378),
  ), bounds);

  expect(result.totalWithin).toBe(1);
  expect(result.totalNear).toBe(1);
  expect(result.withinByType).toEqual({ school: 1 });
  expect(result.nearByType).toEqual({ childcare: 1 });
  expect(result.facilities.map(item => item.name)).toEqual(['Innen', 'Nah am Ostende']);
});

test('links official plans by OSM ID while preserving the separate point source', () => {
  const result = window.UA.FacilityContext.analyze(poi(
    location('osm:way:1', 'Grundschule Beispiel (OSM)', 'school', 9.73, 52.3701),
    location('osm:node:2', 'Grundschule Beispiel', 'school', 9.73, 52.3701),
    location('osm:way:3', 'Kita Beispiel', 'childcare', 9.74, 52.3701),
  ), bounds, catalog(school(), { ...school(), osmId: 'osm:way:3' }));

  expect(result.facilities.find(item => item.id === 'osm:way:1')).toMatchObject({
    name: 'Grundschule Beispiel',
    relation: 'vor Ort prüfen',
    source: { label: expect.stringContaining('Hannover'), url: planUrl, date: '2026' },
    locationSource: { label: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/way/1', date: '2026-08-01' },
    reason: expect.stringContaining('Eingang'),
  });
  expect(result.facilities.filter(item => item.id !== 'osm:way:1').map(item => item.relation))
    .toEqual(['im Umfeld', 'im Umfeld']);
});

test('confirms only licensed, explicitly verified school-route lines intersecting the selected rectangle', () => {
  const result = window.UA.FacilityContext.analyze(poi(
    location('osm:way:1', 'Grundschule Beispiel', 'school', 9.76, 52.37),
  ), bounds, catalog(school([
    { verified: true, geometry: { type: 'LineString', coordinates: [[9.69, 52.3701], [9.76, 52.3701]] } },
    {
      verified: true, license: 'Datenlizenz Deutschland – Namensnennung 2.0',
      geometry: { type: 'LineString', coordinates: [[9.7499, 52.3703], [9.7504, 52.3699]] },
    },
    {
      verified: true, license: 'Datenlizenz Deutschland – Namensnennung 2.0',
      geometry: { type: 'MultiLineString', coordinates: [[[9.69, 52.3701], [9.76, 52.3701]]] },
    },
  ])));

  expect(result.totalWithin + result.totalNear).toBe(0);
  expect(result.facilities).toEqual([expect.objectContaining({
    relation: 'Wegebezug belegt',
    source: expect.objectContaining({ url: planUrl }),
    routeCrossing: { geometryType: 'MultiLineString', license: 'Datenlizenz Deutschland – Namensnennung 2.0' },
  })]);
});

test('does not confirm a route whose bounding box alone overlaps the selection', () => {
  const result = window.UA.FacilityContext.analyze(poi(
    location('osm:way:1', 'Grundschule Beispiel', 'school', 9.74, 52.3701),
  ), bounds, catalog(school([{
    verified: true, license: 'Datenlizenz Deutschland – Namensnennung 2.0',
    geometry: { type: 'LineString', coordinates: [[9.7499, 52.3703], [9.7504, 52.3699]] },
  }])));

  expect(result.facilities[0].relation).toBe('vor Ort prüfen');
});
