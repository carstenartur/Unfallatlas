'use strict';

const selected = { south: 52.37, west: 9.70, north: 52.3702, east: 9.75 };
const query = { fromYear: 2024, toYear: 2025, severity: 'all', type: 'turning' };
const point = (id, year, props) => ({
  lat: 52.3701, lon: 9.73,
  props: { id, year, ukategorie: '3', ustunde: '8', utyp1: '2', ...props },
});
const points = [
  point('older bike', 2023, { istrad: '1', istpkw: '1' }),
  point('recent bike', 2024, { istrad: '1', istpkw: '1' }),
  point('recent car', 2024, { istpkw: '1', istfuss: '1' }),
  point('filtered hour', 2024, { istrad: '1', istpkw: '1', ustunde: '22' }),
];
const ui = () => ({
  severityEl: { value: 'all' }, roadConditionEl: { value: 'all' },
  dayTypeEl: { value: 'all' }, hFromEl: { value: '6' }, hToEl: { value: '20' },
  incBikeEl: { checked: true }, incPedEl: { checked: false },
  incCarEl: { checked: false }, incMotoEl: { checked: false },
});

beforeEach(() => {
  jest.resetModules();
  window.UA = {};
  window.fetch = async () => ({ ok: false });
  window.L = require('leaflet');
  require('../../js/ua.utils.js');
  require('../../js/ua.filters.js');
  require('../../js/ua.accident_views.js');
  require('../../js/ua.facility_context.js');
  require('../../js/ua.export_v2.js');
  window.UA.reverseGeocode = async () => null;
});

afterEach(() => {
  delete window.UA;
  delete window.fetch;
  delete window.L;
});

function context(overrides = {}) {
  return {
    CITY_RAW: 'Hannover', allPts: points, ui: ui(), involvementMode: 'or',
    selectionBounds: L.latLngBounds([selected.south, selected.west], [selected.north, selected.east]),
    discoveryFocus: { query, key: 'turning:5', bounds: selected },
    exportOptions: { includeCosts: false, includeMeasures: false },
    ...overrides,
  };
}

test('a point inside the circumcircle but far from a long selection is excluded from report POIs', async () => {
  const poiData = { features: [{
    geometry: { type: 'Point', coordinates: [9.725, 52.378] },
    properties: { type: 'kindergarten', name: 'Abgelegene Kita' },
  }] };
  const report = await window.UA.computeExportReport(context({ poiData }));
  expect(report.structured.poi?.totalNear).toBe(0);
});

function discoveryProvider() {
  const change = { label: 'Dokumentierte Änderung', date: '2024-08-21', precision: 'documented-by',
    url: 'https://www.hannover.de/beispiel' };
  window.UA.SiteDiscovery = {
    filterPoints: (rows, criteria) => rows.filter(({ props }) =>
      props.year >= criteria.fromYear && props.year <= criteria.toYear),
    patternForPoints: (rows, key = 'automatic') => ({ key, label: 'Abbiegen', points: rows }),
    loadSites: async () => [
      { bounds: selected, changes: [change] },
      { bounds: { south: 51, north: 51.5, west: 10, east: 11 }, changes: [{ ...change, date: '1999' }] },
    ],
  };
  return change;
}

test('restricts explicit discovery focus to the matching query and active involvement without trimming the annex', async () => {
  const change = discoveryProvider();
  const report = await window.UA.computeExportReport(context());
  expect(report.structured.discoveryFocus.key).toBe('turning:5');
  expect(report.structured.discoveryFocus.query).toEqual(query);
  expect(report.structured.discoveryFocus.points.map(({ props }) => props.id)).toEqual(['recent bike']);
  expect(report.structured.siteChanges).toEqual([change]);
  expect(report.structured.totalAccidents).toBe(3);
});

test('does not reuse a discovery query after the marked rectangle changes', async () => {
  discoveryProvider();
  const report = await window.UA.computeExportReport(context({
    discoveryFocus: { query, key: 'turning:5', bounds: { ...selected, east: selected.east + 0.00000001 } },
  }));
  expect(report.structured.discoveryFocus.key).toBe('automatic');
  expect(report.structured.discoveryFocus.points.map(({ props }) => props.id)).toEqual(['older bike', 'recent bike']);
});

test('a network report preserves the assigned cohort and the rectangular evidence separately', async () => {
  discoveryProvider();
  require('../../js/ua.review_network.js');
  const site = { id: 'j:22', revision: '398a1a71f25db801' };
  const result = {
    network: {
      city: 'hannover', revision: site.revision,
      sites: new Map([[site.id, { id: site.id, label: 'Testknoten', kind: 'junction', bounds: selected }]]),
      source: { label: 'OSM', url: 'https://www.openstreetmap.org/', date: '2026-11-08' },
    },
    bySite: new Map([[site.id, [points[1], points[3]]]]),
  };
  const report = await window.UA.computeExportReport(context({
    discoveryFocus: { query, key: 'turning:5', bounds: selected, site },
    reviewNetworkPromise: Promise.resolve(result),
  }));
  expect(report.structured.siteNetwork).toMatchObject({
    status: 'available', site, label: 'Testknoten', assignedCount: 2, queryCount: 2, mapCount: 1, mappedPoints: [points[1]],
  });
  expect(report.structured.discoveryFocus).toMatchObject({ site, points: [points[1]] });
  expect(report.structured.totalAccidents).toBe(3);
  expect(report.text).toContain('Testknoten');
});

test('an unavailable network revision does not turn the rectangle into an assigned cohort', async () => {
  discoveryProvider();
  const site = { id: 'j:22', revision: '398a1a71f25db801' };
  const report = await window.UA.computeExportReport(context({
    discoveryFocus: { query, key: 'turning:5', bounds: selected, site },
    reviewNetworkPromise: Promise.resolve(null),
  }));
  expect(report.structured.siteNetwork).toMatchObject({ status: 'unavailable', site });
  expect(report.structured.discoveryFocus).toBeNull();
  expect(report.structured.totalAccidents).toBe(3);
});
