/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const elevation = require('../../js/ua.elevation_provider');
const riskProducer = require('../../scripts/producers/osm_elevation_risk_producer');
const producer = require('../../scripts/producers/hannover_dgm1_road_profile_producer');

function rawOsm() {
  return {
    source: 'OpenStreetMap (Overpass)',
    ways: {
      '1': { highway: 'primary', bridge: 'no', tunnel: 'no', layer: '0', embankment: 'no', cutting: 'no' },
      '2': { highway: 'secondary', bridge: 'yes', tunnel: 'no', layer: '1', embankment: 'no', cutting: 'no' },
      '3': { highway: 'residential', bridge: 'no', tunnel: 'no', layer: '0', embankment: 'no', cutting: 'no' },
    },
    wayGeometries: {
      '1': [
        { lat: 52.37, lon: 9.7000 },
        { lat: 52.37, lon: 9.7010 },
        { lat: 52.37, lon: 9.7020 },
      ],
      '2': [
        { lat: 52.371, lon: 9.7000 },
        { lat: 52.371, lon: 9.7010 },
        { lat: 52.371, lon: 9.7020 },
      ],
      '3': [
        { lat: 52.372, lon: 9.70000 },
        { lat: 52.372, lon: 9.70005 },
      ],
    },
    structureTags: {
      schemaVersion: 1,
      producerVersion: '1.0.0',
      retrievedAt: '2026-07-30T18:00:00.000Z',
      coverage: 'full',
      wayCount: 3,
      fields: [...riskProducer.REQUIRED_STRUCTURE_FIELDS],
      queryFingerprint: 'a'.repeat(64),
    },
  };
}

function preparedOsm() {
  return riskProducer.applyElevationRiskTags(rawOsm(), {
    derivedAt: '2026-07-30T18:00:01.000Z',
  });
}

function testProvider(events) {
  const base = elevation.createProvider({
    descriptor: elevation.createHannoverDgm1Descriptor('2026-07-30T18:00:02Z'),
    canProvide: ({ city }) => city === 'Hannover',
    async sampleElevations(coordinates) {
      return coordinates.map(point => (point.lon - 9.7) * 3400 + (point.lat - 52.37) * 10);
    },
  });
  return Object.freeze({
    ...base,
    manifest: Object.freeze({
      sha256: 'b'.repeat(64),
      dataSha256: 'c'.repeat(64),
      grid: Object.freeze({ crs: 'EPSG:25832', resolutionMeters: 1 }),
    }),
    async preload() {
      events.push('preload');
      return Object.freeze({ pointCount: 1000, sha256: 'c'.repeat(64) });
    },
  });
}

describe('Hannover DGM1 road-profile producer', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test.each([0.00005, 0.000005])('prepares OSM safety first and records unavailable short ways (longitude span %s)', async shortSpan => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hannover-dgm1-profiles-'));
    roots.push(root);
    const osmFile = path.join(root, 'osm_hannover.json');
    const outputFile = path.join(root, 'hannover-dgm1-road-profiles.json');
    const input = preparedOsm();
    input.wayGeometries['3'][1].lon = input.wayGeometries['3'][0].lon + shortSpan;
    fs.writeFileSync(osmFile, JSON.stringify(input));
    const events = [];

    const result = await producer.prepareHannoverDgm1RoadProfiles({
      osmFile,
      outputFile,
      dgmRoot: root,
      dgmManifest: 'unused.json',
      dgmManifestSha256: 'd'.repeat(64),
      generatedAt: '2026-07-30T18:05:00Z',
    }, {
      async prepareOsmElevationContext(options) {
        events.push('context');
        expect(options.inputFile).toBe(fs.realpathSync(osmFile));
        const sha = producer.sha256File(osmFile);
        return Object.freeze({ skipped: true, inputSha256: sha, outputSha256: sha });
      },
      createHannoverDgm1XyzProvider() {
        events.push('provider');
        return testProvider(events);
      },
      async computeRoadGradient(...args) {
        events.push(`compute-${args[3].windowMeters}`);
        return elevation.computeRoadGradient(...args);
      },
    });

    expect(events.slice(0, 3)).toEqual(['context', 'provider', 'preload']);
    expect(result.coverage).toEqual({
      totalWays: 3,
      computed20m: 2,
      computed50m: 2,
      usable20m: 1,
      usable50m: 1,
      unavailable20m: 1,
      unavailable50m: 1,
      unusableByRisk20m: 1,
      unusableByRisk50m: 1,
    });

    const artifact = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
    expect(artifact.source.descriptor.id).toBe('hannover.dgm1');
    expect(artifact.osm.contextPreparation.skipped).toBe(true);
    expect(artifact.profiles['1'].windows['20'].status).toBe('computed');
    expect(artifact.profiles['1'].windows['20'].result.usable).toBe(true);
    expect(artifact.profiles['1'].windows['50'].result.semanticType)
      .toBe('road_longitudinal_gradient');
    expect(artifact.profiles['2'].windows['20'].result.usable).toBe(false);
    expect(artifact.profiles['2'].windows['20'].result.uncertaintyReasons)
      .toContain('bridge_surface_not_represented_by_dtm');
    expect(artifact.profiles['3'].windows['20']).toEqual(expect.objectContaining({
      status: 'unavailable',
      reasonCode: 'insufficient_geometry',
    }));
    expect(artifact.truthBoundary.accidentToWayMatchingPerformed).toBe(false);
    expect(result.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('suppresses both invalid-layer windows and still computes other roads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hannover-invalid-layer-'));
    roots.push(root);
    const raw = rawOsm();
    raw.ways['2'].layer = '-0,7';
    const osmFile = path.join(root, 'osm.json');
    fs.writeFileSync(osmFile, JSON.stringify(riskProducer.applyElevationRiskTags(raw)));
    const outputFile = path.join(root, 'profiles.json');
    await producer.prepareHannoverDgm1RoadProfiles({ osmFile, outputFile }, {
      createHannoverDgm1XyzProvider: () => testProvider([]),
    });
    const { profiles } = JSON.parse(fs.readFileSync(outputFile));
    for (const window of ['20', '50']) {
      expect(profiles['1'].windows[window].result.usable).toBe(true);
      expect(profiles['2'].windows[window]).toMatchObject({ status: 'unavailable', reasonCode: 'invalid_osm_layer' });
      expect(profiles['2'].windows[window].result).toBeUndefined();
    }
  });

  test('excludes only windows reaching the documented B6 bridge boundary', async () => {
    const evidence = require('../fixtures/hannover-dgm1-real/westschnellweg-transition.json');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hannover-bridge-transition-'));
    roots.push(root);
    const raw = rawOsm();
    const { approach, bridge } = evidence;
    raw.ways['1'] = approach.tags;
    raw.wayGeometries['1'] = approach.geometry;
    raw.ways['2'] = bridge.tags;
    raw.wayGeometries['2'] = bridge.geometry;
    // A separate synthetic 66 m road shares that endpoint in reverse order.
    // Its 20 m window stops before the boundary and its 50 m window reaches it.
    const edge = approach.geometry[0];
    raw.wayGeometries['3'] = [{ lat: edge.lat, lon: edge.lon + 0.001 }, edge];
    const osmFile = path.join(root, 'osm.json');
    fs.writeFileSync(osmFile, JSON.stringify(riskProducer.applyElevationRiskTags(raw)));
    const outputFile = path.join(root, 'profiles.json');
    await producer.prepareHannoverDgm1RoadProfiles({ osmFile, outputFile }, {
      createHannoverDgm1XyzProvider: () => testProvider([]),
    });
    const { profiles } = JSON.parse(fs.readFileSync(outputFile));
    for (const window of ['20', '50']) {
      expect(profiles['1'].windows[window].result).toMatchObject({ usable: false, gradientPercent: null });
      expect(profiles['1'].windows[window].result.uncertaintyReasons).toContain('bridge_transition_surface_not_represented_by_dtm');
      expect(profiles['2'].windows[window].result.uncertaintyReasons).toContain('bridge_surface_not_represented_by_dtm');
    }
    expect(profiles['1'].bridgeEndpoints).toEqual({ start: ['2'], end: [] });
    expect(profiles['3'].windows['20'].result.usable).toBe(true);
    expect(profiles['3'].windows['50'].result.gradientPercent).toBeNull();
  });

  test('rejects incomplete way-geometry coverage before constructing the DGM provider', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hannover-dgm1-coverage-'));
    roots.push(root);
    const osm = preparedOsm();
    delete osm.wayGeometries['2'];
    const osmFile = path.join(root, 'osm_hannover.json');
    fs.writeFileSync(osmFile, JSON.stringify(osm));
    const createProvider = jest.fn();

    await expect(producer.prepareHannoverDgm1RoadProfiles({
      osmFile,
      outputFile: path.join(root, 'profiles.json'),
      dgmRoot: root,
      dgmManifest: 'unused.json',
      dgmManifestSha256: 'd'.repeat(64),
    }, {
      async prepareOsmElevationContext() {
        const sha = producer.sha256File(osmFile);
        return { skipped: true, inputSha256: sha, outputSha256: sha };
      },
      createHannoverDgm1XyzProvider: createProvider,
    })).rejects.toThrow(/geometry_coverage_mismatch/);

    expect(createProvider).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'profiles.json'))).toBe(false);
  });

  test('does not overwrite an existing profile artifact when computation fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hannover-dgm1-failure-'));
    roots.push(root);
    const osmFile = path.join(root, 'osm_hannover.json');
    const outputFile = path.join(root, 'profiles.json');
    fs.writeFileSync(osmFile, JSON.stringify(preparedOsm()));
    fs.writeFileSync(outputFile, 'previous-artifact');

    await expect(producer.prepareHannoverDgm1RoadProfiles({
      osmFile,
      outputFile,
      dgmRoot: root,
      dgmManifest: 'unused.json',
      dgmManifestSha256: 'd'.repeat(64),
    }, {
      async prepareOsmElevationContext() {
        const sha = producer.sha256File(osmFile);
        return { skipped: true, inputSha256: sha, outputSha256: sha };
      },
      createHannoverDgm1XyzProvider() {
        return testProvider([]);
      },
      async computeRoadGradient() {
        throw new Error('injected profile failure');
      },
    })).rejects.toThrow(/injected profile failure/);

    expect(fs.readFileSync(outputFile, 'utf8')).toBe('previous-artifact');
    expect(fs.readdirSync(root).filter(name => name.includes('.tmp-'))).toEqual([]);
  });
});
