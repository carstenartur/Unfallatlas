/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { gunzipSync, gzipSync } = require('node:zlib');

const producer = path.resolve(__dirname, '../../scripts/build-review-network.py');

function rectangle(west, south, east, north) {
  return [[west, south], [east, south], [east, north], [west, north], [west, south]];
}

function polygon(...coordinates) {
  return { type: 'Feature', geometry: { type: 'Polygon', coordinates } };
}

function node(id, lat, lon, tags = '') {
  return `<node id="${id}" lat="${lat}" lon="${lon}">${tags}</node>`;
}

function way(id, refs, tags = '<tag k="highway" v="residential"/>') {
  return `<way id="${id}">${refs.map(ref => `<nd ref="${ref}"/>`).join('')}${tags}</way>`;
}

describe('offline review network producer', () => {
  let directory;

  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'review-network-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  function runProducer(records, features = [polygon(rectangle(9, 52, 9.01, 52.01))]) {
    const osm = path.join(directory, 'fixture.osm.gz');
    const boundary = path.join(directory, 'districts.geojson');
    const output = path.join(directory, 'output');
    fs.writeFileSync(osm, gzipSync(Buffer.from(`<osm version="0.6">${records.join('')}</osm>`)));
    fs.writeFileSync(boundary, JSON.stringify({
      type: 'FeatureCollection', features,
      source: { label: 'City districts', url: 'https://example.org/boundary' },
      metadata: { licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
    }));

    const result = spawnSync('python3', [
      producer, '--city', 'test_city', '--osm', osm, '--boundary', boundary, '--output', output,
      '--source-url', 'https://example.org/osm', '--source-date', '2026-11-08',
    ], { encoding: 'utf8' });
    return { output, result };
  }

  function generate(records, features) {
    const { output, result } = runProducer(records, features);
    expect({ status: result.status, error: result.stderr }).toEqual({ status: 0, error: '' });

    const catalog = JSON.parse(fs.readFileSync(path.join(output, 'catalog.json')));
    const city = path.join(output, 'test_city');
    const index = JSON.parse(fs.readFileSync(path.join(city, 'index.json')));
    const parts = index.parts.map(id => fs.readFileSync(path.join(city, `${id}.json.gz`)));
    const sites = parts.flatMap(part => JSON.parse(gunzipSync(part)).sites);
    return { catalog, index, parts, sites };
  }

  test('finds junctions at shared branching road nodes and preserves overpasses', () => {
    const { sites } = generate([
      node(1, 52.004, 9.003), node(2, 52.004, 9.004), node(3, 52.004, 9.005),
      node(4, 52.003, 9.004), node(5, 52.005, 9.0045), node(6, 52.003, 9.0045),
      node(7, 52.004, 9.006),
      way(100, [1, 2, 3]), way(101, [4, 2]),
      way(102, [5, 6], '<tag k="highway" v="residential"/><tag k="bridge" v="yes"/><tag k="layer" v="1"/>'),
      way(103, [3, 7]),
    ]);

    const junctions = sites.filter(row => row[1] === 'junction');
    expect(junctions.map(([id, , , wayIds, coordinates]) => [id, wayIds, coordinates]))
      .toEqual([['j:2', ['100', '101'], [52.004, 9.004]]]);
    expect(sites.filter(row => row[1] === 'segment' && row[3][0] === '100').map(row => row[4]))
      .toEqual([[52.004, 9.003, 52.004, 9.004], [52.004, 9.004, 52.004, 9.005]]);
  });

  test('splits a road at a branching node revisited by the same way', () => {
    const { sites } = generate([
      node(1, 52.004, 9.003), node(2, 52.004, 9.004), node(3, 52.004, 9.0045),
      node(4, 52.0045, 9.004), node(5, 52.003, 9.004),
      way(100, [1, 2, 3, 4, 2, 5]),
    ]);

    expect(sites.filter(row => row[1] === 'junction').map(row => [row[0], row[3], row[4]]))
      .toEqual([['j:2', ['100'], [52.004, 9.004]]]);
    expect(sites.filter(row => row[1] === 'segment').map(row => row[4])).toEqual([
      [52.004, 9.003, 52.004, 9.004],
      [52.004, 9.004, 52.004, 9.0045, 52.0045, 9.004, 52.004, 9.004],
      [52.004, 9.004, 52.003, 9.004],
    ]);
  });

  test('uses explicit OSM crossing tags and consolidates ways at the same road node', () => {
    const crossingWay = '<tag k="highway" v="footway"/><tag k="footway" v="crossing"/>';
    const { sites } = generate([
      node(1, 52.004, 9.003), node(2, 52.004, 9.004, '<tag k="highway" v="crossing"/>'),
      node(3, 52.004, 9.005, '<tag k="crossing" v="no"/>'),
      node(4, 52.003, 9.004), node(5, 52.005, 9.004),
      node(6, 52.004, 9.006), node(7, 52.003, 9.006), node(8, 52.005, 9.006),
      node(9, 52.003, 9.007), node(10, 52.005, 9.007),
      way(100, [1, 2, 3, 6]), way(200, [4, 2, 5], crossingWay),
      way(201, [7, 6, 8], '<tag k="highway" v="footway"/>'),
      way(202, [9, 10], '<tag k="highway" v="cycleway"/><tag k="crossing" v="marked"/>'),
    ]);

    const crossings = sites.filter(row => row[1] === 'crossing');
    expect(crossings.map(([id, , , wayIds, coordinates]) => [id, wayIds, coordinates])).toEqual([
      ['c:n:2', ['100', '200'], [52.004, 9.004]],
      ['c:w:202:1', ['202'], [52.004, 9.007]],
    ]);
  });

  test('clips through city coverage with outside endpoints and preserves a hole', () => {
    const { sites } = generate([
      node(1, 52.005, 9.001), node(2, 52.005, 9.005),
      node(3, 52.006, 9.001), node(4, 52.006, 9.005),
      way(100, [1, 2]), way(101, [3, 4]),
    ], [
      polygon(rectangle(9.002, 52.004, 9.003, 52.007), rectangle(9.0024, 52.0045, 9.0026, 52.0055)),
      polygon(rectangle(9.003, 52.004, 9.004, 52.007)),
    ]);

    expect(sites.filter(row => row[3][0] === '100').map(row => row[4])).toEqual([
      [52.005, 9.002, 52.005, 9.0024], [52.005, 9.0026, 52.005, 9.004],
    ]);
    expect(sites.filter(row => row[3][0] === '101').map(row => row[4])).toEqual([
      [52.006, 9.002, 52.006, 9.004],
    ]);
  });

  test('keeps fallback crossing IDs at their mapped locations when a way is reversed', () => {
    const nodes = [node(1, 52.005, 9), node(2, 52.005, 9.006)];
    const tagged = '<tag k="highway" v="footway"/><tag k="footway" v="crossing"/>';
    const districts = [polygon(rectangle(9.001, 52.004, 9.002, 52.006)),
      polygon(rectangle(9.004, 52.004, 9.005, 52.006))];
    const forward = generate([...nodes, way(100, [1, 2]), way(200, [1, 2], tagged)], districts);
    const reversed = generate([...nodes, way(100, [1, 2]), way(200, [2, 1], tagged)], districts);
    expect(forward.sites.filter(row => row[1] === 'crossing').map(row => [row[0], row[4]]))
      .toEqual([['c:w:200:1', [52.005, 9.0015]], ['c:w:200:2', [52.005, 9.0045]]]);
    expect(reversed.sites).toEqual(forward.sites);
  });

  test('splits long roads into bounded, continuous local segments', () => {
    const { sites } = generate([node(1, 52.002, 9.004), node(2, 52.008, 9.004), way(100, [1, 2])]);
    const segments = sites.map(row => row[4]);
    expect(segments).toHaveLength(3);
    expect(segments[0].slice(0, 2)).toEqual([52.002, 9.004]);
    expect(segments[2].slice(-2)).toEqual([52.008, 9.004]);
    for (let i = 0; i < segments.length; i += 1) {
      const points = segments[i];
      expect((points[2] - points[0]) * 111195).toBeLessThan(250.02);
      if (i > 0) expect(segments[i - 1].slice(-2)).toEqual(points.slice(0, 2));
    }
  });

  test('rebuilds identical versioned output from the same source bytes', () => {
    const records = [node(1, 52.004, 9.003), node(2, 52.004, 9.004), way(100, [1, 2])];
    const first = generate(records);
    expect(first.index).toMatchObject({
      schemaVersion: 1, city: 'test_city', counts: { segment: 1, junction: 0, crossing: 0 },
      source: { date: '2026-11-08', url: 'https://example.org/osm', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      boundarySource: { label: 'City districts', url: 'https://example.org/boundary', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' },
    });
    expect(first.catalog).toEqual({ schemaVersion: 1, cities: { 'test_city': first.index.revision } });
    expect(first.parts[0].readUInt32LE(4)).toBe(0);
    expect(JSON.parse(gunzipSync(first.parts[0])).revision).toBe(first.index.revision);
    expect(generate(records)).toEqual(first);
    expect(generate([way(100, [2, 1]), records[1], records[0]]).sites).toEqual(first.sites);
  });

  test('preserves the published revision when a new part cannot be written', () => {
    const nodes = [node(1, 52.004, 9.003), node(2, 52.004, 9.004)];
    const first = generate([...nodes, way(100, [1, 2])]);
    const city = path.join(directory, 'output', 'test_city');
    fs.mkdirSync(path.join(city, '2.json.gz'));

    const newWays = Array.from({ length: 4001 }, (_, index) => way(1000 + index, [1, 2]));
    const { output, result } = runProducer([...nodes, ...newWays]);
    expect(result.status).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(output, 'catalog.json')))).toEqual(first.catalog);
    expect(JSON.parse(fs.readFileSync(path.join(city, 'index.json')))).toEqual(first.index);
    expect(fs.readFileSync(path.join(city, '1.json.gz')).equals(first.parts[0])).toBe(true);
  });
});
