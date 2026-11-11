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
  require('../../js/ua.export_template_defaults.js');
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
  require('../../js/ua.site_discovery.js');
  const change = { label: 'Dokumentierte Änderung', date: '2024-08-21', precision: 'documented-by',
    url: 'https://www.hannover.de/beispiel' };
  window.UA.SiteDiscovery = {
    ...window.UA.SiteDiscovery,
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
      city: 'hannover', revision: site.revision, counts: { junction: 1 },
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
  expect(report.structured.meta.areaName).toBe('Testknoten');
  expect(report.text).toMatch(/Betreff:\s*[^\n]*Testknoten/);
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

test.each([
  ['2', 'turning:5', /Abbiegebeziehungen/, /Signalphasen/],
  ['4', '4:6', /Querungswege/, /Wartezeiten/],
  ['6', '6:5', /Fahrtrichtungen/, /Seitenabstände/],
])('binds type %s to the motion in the preview and text, even beside an unrelated bike crash', async (type, key, examination, option) => {
  require('../../js/ua.site_discovery.js');
  const props = type === '4' ? { istfuss: '1', istpkw: '1' } : { istrad: '1', istpkw: '1' };
  const allPts = [2023, 2024, 2024].map((year, i) => point('focus-' + i, year, { ...props, utyp1: type }));
  allPts.push(point('other', 2024, { istrad: '1', utyp1: '1' }));
  const ctx = context({
    allPts, areaNameOverride: 'Testplatz', discoveryFocus: { key, query: {}, bounds: selected },
    exportOptions: { includeCosts: false, osmContextOverride: { summary: {}, source: { publisher: 'OSM', license: 'ODbL', retrievedVia: 'test' }, contexts: { tramTrackWays: 1 } } },
  });
  ctx.ui.incPedEl.checked = true;
  window.UA.osmContext = { fetchOsmContext: jest.fn() };
  const { structured, html, text } = await window.UA.computeExportReport(ctx);
  expect(structured.motion?.discoveryEvidence).toMatchObject({ key, count: 3, byYear: { 2023: 1, 2024: 2 } });
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const output of [structured.motion.requests.join(' '), text, box.textContent]) {
    expect(output).toMatch(examination);
    expect(output).toMatch(option);
    expect(output).toMatch(/Zuständigkeit/);
    expect(output).toMatch(/Vorher-Nachher/);
  }
  require('../../js/ua.semantic_filing_gate.js');
  require('../../js/ua.evidence_safe_semantics.js');
  const normalized = window.UA.semanticFilingGate.normaliseReport({ structured, text, html });
  const final = window.UA.EvidenceSafeSemantics.safeReport(normalized);
  expect(final.structured.executiveSummary.classification).toContain(structured.discoveryFocus.label);
  expect(final.structured.executiveSummary.bullets[0]).toContain('3 Fälle');
  expect(structured.motion.rationale).toContain(structured.discoveryFocus.label);
  expect(structured.motion.rationale).toContain('3 Fälle');
  expect(structured.motion.requests.join(' ')).not.toMatch(/Gleisquerung/);
});

test('only a documented decision at the selected network site changes the resolution into a follow-up', async () => {
  require('../../js/ua.report_v2.js');
  discoveryProvider();
  require('../../js/ua.review_network.js');
  const site = { id: 'j:22', revision: '38f771' };
  const result = { network: { city: 'hannover', revision: site.revision, counts: { junction: 1 }, sites: new Map([
    [site.id, { id: site.id, kind: 'junction', label: 'Testknoten', bounds: selected }],
  ]) }, bySite: new Map([[site.id, [points[1]]]]) };
  const decision = { kind: 'council-decision', date: '2021-06-07', precision: 'documented-by',
    number: '1/2021', label: 'DS 1/2021: Der Bezirksrat beschloss die Aufpflasterung.', url: 'https://example.org/ratsinfo/1' };
  const first = { ...decision, kind: 'implementation-status', date: '2022-09-26', number: '2/2022', label: 'Planung begonnen.', url: 'https://example.org/ratsinfo/2' };
  const last = { ...first, date: '2023-12-04', number: '3/2023', label: 'DS 3/2023: Kein Umsetzungstermin.', url: 'https://example.org/ratsinfo/3' };
  const unrelated = { ...decision, kind: 'construction', label: 'Fahrbahn erneuert.' };
  // row is the network producer boundary. Only this row belongs to the selected site.
  const row = window.UA.ReviewNetwork.row;
  const compute = async (changes, key = 'turning:5') => {
    window.UA.ReviewNetwork = { ...window.UA.ReviewNetwork, row: (...args) => ({ ...row(...args), changes }) };
    return window.UA.computeExportReport(context({
      discoveryFocus: { query, key, bounds: selected, site },
      reviewNetworkResult: result, exportOptions: { includeCosts: false },
    }));
  };
  const report = await compute([last, unrelated, decision, first]);
  const resolution = report.structured.motion.requests.join(' ');
  expect(resolution).toContain(decision.label);
  expect(resolution).toContain('07.06.2021');
  expect(resolution).toContain(last.label);
  expect(resolution).toContain('04.12.2023');
  expect(resolution).toMatch(/aktuellen Planungs- und Umsetzungsstand/);
  expect(resolution).not.toContain(unrelated.label);
  expect(report.structured.motion.priorWork).toEqual([decision, first, last]);
  const preview = document.createElement('div');
  preview.innerHTML = report.html;
  const resolutionLinks = [...preview.querySelectorAll('ol li:first-child a')];
  expect(resolutionLinks.map(link => [link.textContent, link.href])).toEqual([
    ['DS 1/2021', decision.url], ['DS 3/2023', last.url],
  ]);
  for (const source of [decision, first, last]) {
    expect(preview.querySelector('a[href="' + source.url + '"]')).not.toBeNull();
    expect(report.text).toContain(source.url);
  }
  const withoutPattern = await compute([decision, last], null);
  expect(withoutPattern.structured.motion.requests.join(' ')).toContain(decision.label);
  expect(withoutPattern.structured.motion.discoveryEvidence).toBeUndefined();
  expect(withoutPattern.structured.motion.rationale).not.toMatch(/Muster|Häufung/);
  const noDecision = await compute([unrelated, first]);
  expect(noDecision.structured.motion.requests.join(' ')).not.toMatch(/früheren Beschluss|aktuellen Planungs- und Umsetzungsstand/);
  window.UA.SiteDiscovery.loadSites = async () => [{ bounds: selected, changes: [decision, last, unrelated] }];
  const nearby = await window.UA.computeExportReport(context({ exportOptions: { includeCosts: false } }));
  expect(nearby.structured.motion?.priorWork || []).toHaveLength(0);
  expect(nearby.structured.siteChanges).toEqual([unrelated]);
  expect(nearby.text).not.toContain(last.url);
  const stale = await window.UA.computeExportReport(context({
    discoveryFocus: { query, key: 'turning:5', bounds: selected, site: { ...site, revision: 'old' } },
    reviewNetworkResult: result, exportOptions: { includeCosts: false },
  }));
  expect(stale.structured.siteNetwork.status).toBe('unavailable');
  expect(stale.text).not.toContain(last.url);
});

test('an unavailable selected site cannot substitute one bicycle crash from the surrounding rectangle', async () => {
  require('../../js/ua.site_discovery.js');
  window.UA.osmContext = { fetchOsmContext: jest.fn() };
  const focus = { ...context().discoveryFocus, site: { id: 'j:22', revision: 'old' } };
  const report = await window.UA.computeExportReport(context({
    allPts: [point('surrounding rail', 2024, { istrad: '1', utyp1: '1' })],
    discoveryFocus: focus, reviewNetworkPromise: Promise.resolve(null),
    exportOptions: { includeCosts: false, osmContextOverride: { summary: {}, source: { publisher: 'OSM', license: 'ODbL', retrievedVia: 'test' }, contexts: { tramTrackWays: 1 } } },
  }));
  expect(report.structured.motion?.requests.join(' ') || '').not.toMatch(/Gleisquerung/);
  expect(report.structured.siteNetwork.status).toBe('unavailable');
});

test('the documented junction hypothesis follows the selected pattern, its source and its testable alternative', async () => {
  require('../../js/ua.site_discovery.js');
  require('../../js/ua.review_network.js');
  require('../../js/ua.report_v2.js');
  const index = require('../../data/mobility/review-network/hannover/index.json');
  const site = { id: 'j:60655478', revision: index.revision };
  const history = index.caseHistory.find(record => record.id === site.id);
  const sources = history.changes;
  const published = sources.find(record => record.number === '15-2377/2023 F1');
  const atSite = [point('bike and car', 2024, { istrad: '1', istpkw: '1' }),
    point('other pattern', 2024, { istrad: '1', istpkw: '1', utyp1: '6' })];
  const compute = async (key, changes) => {
    const result = { network: { city: 'hannover', revision: site.revision,
      counts: { junction: 1 }, sites: new Map([[site.id, {
        id: site.id, kind: 'junction', label: 'Brühlstraße / Escherstraße', bounds: selected, changes
      }]]) }, bySite: new Map([[site.id, atSite]]) };
    return window.UA.computeExportReport(context({ allPts: atSite,
      discoveryFocus: { query: {}, key, bounds: selected, site },
      reviewNetworkResult: result, exportOptions: { includeCosts: false } }));
  };
  const report = await compute('turning:5', sources);
  const { motion } = report.structured;
  const preview = document.createElement('div');
  preview.innerHTML = report.html;
  for (const output of [motion.rationale, report.text, preview.textContent]) {
    expect(output).toMatch(/Arbeitshypothese/);
    expect(output).toMatch(/Lücke.*Brühlstraße/);
    expect(output).toMatch(/von rechts/);
    expect(output).toMatch(/342/);
    expect(output).toMatch(/244/);
    expect(output).toContain('diese Polizeifälle zur Auswahl');
  }
  expect(motion.discoveryEvidence.count).toBe(1);
  expect(motion.requests.join(' ')).toMatch(/Unfallskizzen.*Kollisionspunkt/);
  expect(motion.requests.join(' ')).toMatch(/Escherstraße.*Brühlstraße/);
  expect(motion.requests.join(' ')).toMatch(/Warteposition/);
  expect(motion.requests.join(' ')).not.toMatch(/17 Fälle/);
  expect(preview.querySelector('a[href="' + published.attachment.url + '"]')).not.toBeNull();
  for (const [key, changes] of [['6:5', sources], ['turning:5', sources.filter(r => r !== published)]]) {
    const other = await compute(key, changes);
    expect(other.structured.motion.rationale).not.toContain('Arbeitshypothese');
    expect(other.structured.motion.requests.join(' ')).not.toContain('Warteposition');
  }
});
