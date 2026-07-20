'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const {
  VIDEO_EXPORT_CONTEXT_PARAMS,
  createVideoExportContextFixture,
} = require('../fixtures/videoExportContextFixture');
const {
  installVideoExportFixture,
} = require('../../scripts/install-video-export-fixture');

describe('video-export build fixture', () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('request filters have a non-empty, internally consistent accident intersection', () => {
    const fixture = createVideoExportContextFixture();
    const slope = new Set(VIDEO_EXPORT_CONTEXT_PARAMS.ctxSlope.split(','));
    const traffic = new Set(VIDEO_EXPORT_CONTEXT_PARAMS.ctxTraffic.split(','));
    const matching = fixture.geojson.features.filter(feature => {
      const props = feature.properties || {};
      return slope.has(props.slope_class) &&
        traffic.has(props.traffic_proxy_class) &&
        Boolean(props.matched_way_id) &&
        props.istrad === '1';
    });

    expect(fixture.geojson.features).toHaveLength(12);
    expect(matching).toHaveLength(12);
    expect(new Set(matching.map(feature => feature.properties.matched_way_id)).size)
      .toBeGreaterThanOrEqual(4);
    for (const wayId of new Set(matching.map(feature => feature.properties.matched_way_id))) {
      const way = fixture.ways.ways[wayId];
      expect(way).toEqual(expect.objectContaining({
        road_slope_confidence: 'high',
        traffic_volume_source: 'deterministic-integration-fixture',
      }));
      expect(fixture.ways.geometries[wayId].length).toBeGreaterThanOrEqual(4);
    }
  });

  test('installer emits deterministic gzip inputs before the canonical site build', () => {
    const firstRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-video-fixture-a-'));
    const secondRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-video-fixture-b-'));
    roots.push(firstRoot, secondRoot);
    const first = installVideoExportFixture({ root: firstRoot });
    const second = installVideoExportFixture({ root: secondRoot });
    expect(first).toEqual({ city: 'Bonn', accidents: 12, ways: 4 });
    expect(second).toEqual(first);

    for (const name of [
      'output_all_years_bonn.geojson.gz',
      'ways_bonn.json.gz',
      'output_all_years_bonn.enrichment.meta.json.gz',
    ]) {
      const a = fs.readFileSync(path.join(firstRoot, 'out', name));
      const b = fs.readFileSync(path.join(secondRoot, 'out', name));
      expect(a.equals(b)).toBe(true);
      expect(() => JSON.parse(zlib.gunzipSync(a).toString('utf8'))).not.toThrow();
    }
  });
});
