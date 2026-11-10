'use strict';

const fs = require('node:fs');
const path = require('node:path');
const spatialGrid = require('../../js/ua.spatial-grid');

const revision = '398a1a71f25db801';
const source = {
  label: '© OpenStreetMap contributors, BBBike',
  url: 'https://download.bbbike.org/osm/bbbike/Hannover/',
  licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
  date: '2026-11-08',
  sha256: 'a'.repeat(64),
};
const boundarySource = {
  label: 'Landeshauptstadt Hannover',
  url: 'https://www.hannover.de/',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
};
const segments = [
  ['s:7:1:2', 'segment', 'Nordweg', [7], [52.37000, 9.7300, 52.37000, 9.7340]],
  ['s:8:3:4', 'segment', 'Südweg', [8], [52.37004, 9.7300, 52.37004, 9.7340]],
];
const nodes = [
  ['j:22', 'junction', 'Nordweg / Querstraße', [7, 9], [52.37000, 9.7320]],
  ['q:25', 'crossing', 'Querung am Nordweg', [7], [52.37000, 9.7335]],
];

function setup(parts = [segments, nodes], indexChanges = {}) {
  const networkIndex = {
    schemaVersion: 1, city: 'hannover', revision, source, boundarySource,
    counts: { segment: 2, junction: 1, crossing: 1 }, parts: [1, 2],
    ...indexChanges,
  };
  const win = { UA: { SpatialGrid: spatialGrid, normKey: city => city.toLowerCase() } };
  win.UA.DataResources = {
    fetchJson: jest.fn(async (kind, params) => ({
      reviewNetworkCatalog: { schemaVersion: 1, cities: { hannover: revision } },
      reviewNetworkIndex: networkIndex,
      reviewNetworkPart: { schemaVersion: 1, revision, sites: parts[params?.part - 1] },
    })[kind]),
  };
  for (const module of ['ua.site_discovery', 'ua.review_network']) {
    const file = path.resolve(__dirname, '../../js', module + '.js');
    if (fs.existsSync(file)) {
      (function (window) { eval(fs.readFileSync(file, 'utf8')); })(win);
    }
  }
  return win.UA;
}

const crash = (lat, lon, way, year = 2025) => ({
  lat, lon,
  props: { year, ukategorie: 2, utyp1: 2, istrad: 1, istpkw: 1, matched_way_id: way },
});

test('an unconfigured city only reads the optional catalog', async () => {
  const UA = setup();
  expect(UA.ReviewNetwork).toBeDefined();
  await expect(UA.ReviewNetwork.load('Bonn')).resolves.toBeNull();
  expect(UA.DataResources.fetchJson.mock.calls.map(args => args[0])).toEqual(['reviewNetworkCatalog']);
});

test('register snapshots validate source, counts and unique stable IDs across parts', async () => {
  const UA = setup();
  expect(UA.ReviewNetwork).toBeDefined();
  const network = await UA.ReviewNetwork.load('Hannover');
  expect(network).toMatchObject({ city: 'hannover', revision, source, counts: { segment: 2, junction: 1, crossing: 1 } });
  expect(network.sites.size).toBe(4);
  const duplicate = setup([segments, [nodes[0], segments[0]]]);
  await expect(duplicate.ReviewNetwork.load('Hannover')).resolves.toBeNull();
  const differentRevision = setup(undefined, { revision: '061eb006768ff115' });
  await expect(differentRevision.ReviewNetwork.load('Hannover')).resolves.toBeNull();
  const mismatchedCount = setup(undefined, { counts: { segment: 4, junction: 1, crossing: 1 } });
  await expect(mismatchedCount.ReviewNetwork.load('Hannover')).resolves.toBeNull();
});

test.each([true, false])('falls back from a stalled fetch when another part is missing %s', async missing => {
  const UA = setup();
  const read = UA.DataResources.fetchJson.getMockImplementation();
  UA.DataResources.fetchJson.mockImplementation((kind, params) => {
    if (kind !== 'reviewNetworkPart') return read(kind, params);
    return missing && params.part === 1 ? Promise.resolve(null) : new Promise(() => {});
  });
  jest.useFakeTimers();
  try {
    const limit = missing ? 10 : 30000;
    const outcome = Promise.race([
      UA.ReviewNetwork.load('Hannover'),
      new Promise(resolve => setTimeout(() => resolve('pending'), limit)),
    ]);
    await jest.advanceTimersByTimeAsync(limit);
    await expect(outcome).resolves.toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

test('spatially assigns each recorded case once and preserves ambiguous and unmatched cases', async () => {
  const UA = setup();
  expect(UA.ReviewNetwork).toBeDefined();
  const network = await UA.ReviewNetwork.load('Hannover');
  const north = crash(52.37004, 9.7310, 7);
  const junction = crash(52.37000, 9.7320, 7);
  const crossing = crash(52.37000, 9.7335, 7, 2023);
  const ambiguous = crash(52.37002, 9.7311);
  const outside = crash(52.39, 9.7311);
  const result = UA.ReviewNetwork.analyze(network, [north, junction, crossing, ambiguous, outside]);
  expect(result.counts).toEqual({ total: 5, assigned: 3, ambiguous: 1, unmatched: 1 });
  expect(result.bySite.get('s:7:1:2')).toEqual([north]);
  expect(result.bySite.get('j:22')).toEqual([junction]);
  expect(result.bySite.get('q:25')).toEqual([crossing]);
  expect(result.assignments.get(ambiguous).status).toBe('ambiguous');
  expect(result.assignments.get(outside).status).toBe('unmatched');
  expect(new Set([...result.bySite.values()].flat()).size).toBe(3);
  expect(UA.ReviewNetwork.rows(result, { fromYear: 2024 }, { onlyEmpty: true }).map(row => row.id).sort())
    .toEqual(['q:25', 's:8:3:4']);
  const q = UA.ReviewNetwork.row(result, 'q:25', { fromYear: 2024 });
  expect(q).toMatchObject({ id: 'q:25', kind: 'crossing', points: [], count: 0, assignedCount: 1 });
  expect(UA.ReviewNetwork.row(result, 'j:22', {}, () => false).count).toBe(0);
});
