'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const elevation = require('../../js/ua.elevation_provider');
const producer = require('../../scripts/producers/osm_elevation_risk_producer');

const ANCHOR = { lat: 52.3759, lon: 9.732 };
const METERS_PER_DEGREE_LON = 111320 * Math.cos((ANCHOR.lat * Math.PI) / 180);

function eastWestRoad(lengthMeters = 140) {
  const halfDegrees = lengthMeters / 2 / METERS_PER_DEGREE_LON;
  return [
    { lat: ANCHOR.lat, lon: ANCHOR.lon - halfDegrees },
    { lat: ANCHOR.lat, lon: ANCHOR.lon + halfDegrees },
  ];
}

function linearProvider() {
  return elevation.createProvider({
    descriptor: {
      ...elevation.createHannoverDgm1Descriptor('2026-07-28'),
      id: 'test.dgm.risk',
    },
    sampleElevations: (coordinates) => coordinates.map((coordinate) => {
      const x = (coordinate.lon - ANCHOR.lon) * METERS_PER_DEGREE_LON;
      return 100 + x * 0.05;
    }),
  });
}

function dataset(overrides = {}) {
  return {
    source: 'OpenStreetMap (Overpass)',
    ways: {
      '3': { highway: 'primary', bridge: 'viaduct', layer: '1' },
      '11': { highway: 'secondary', tunnel: 'culvert', layer: '-1' },
      '20': { highway: 'residential', embankment: 'dyke', cutting: 'no' },
    },
    wayGeometries: {
      '3': eastWestRoad(),
      '11': eastWestRoad(),
      '20': eastWestRoad(),
    },
    structureTags: {
      schemaVersion: 1,
      producerVersion: '1.0.0',
      coverage: 'full',
      wayCount: 3,
      fields: ['bridge', 'tunnel', 'layer', 'embankment', 'cutting'],
      queryFingerprint: 'a'.repeat(64),
    },
    ...overrides,
  };
}

describe('OSM elevation risk normalization', () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test.each([
    [null, 'no'],
    ['', 'no'],
    ['no', 'no'],
    ['false', 'no'],
    ['0', 'no'],
    ['none', 'no'],
    ['yes', 'yes'],
    ['true', 'yes'],
    ['1', 'yes'],
    ['viaduct', 'yes'],
    ['culvert', 'yes'],
    ['dyke', 'yes'],
  ])('normalizes structure-presence value %p to %s', (value, expected) => {
    expect(producer.normalizePresence(value)).toBe(expected);
  });

  test.each([
    [null, '0'],
    ['', '0'],
    ['0', '0'],
    ['-0', '0'],
    ['+1', '1'],
    ['-2', '-2'],
    [3, '3'],
  ])('normalizes OSM layer %p to %s', (value, expected) => {
    expect(producer.normalizeLayer(value)).toBe(expected);
  });

  test('rejects non-integer and implausible OSM layers', () => {
    for (const value of ['1.5', 'ground', 101, -101, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => producer.normalizeLayer(value)).toThrow(/invalid_layer/);
    }
  });

  test('requires exact full structure-tag coverage before deriving risk tags', () => {
    expect(() => producer.validateStructureCoverage(dataset({
      structureTags: { ...dataset().structureTags, coverage: 'partial' },
    }))).toThrow(/incomplete_structure_coverage/);

    expect(() => producer.validateStructureCoverage(dataset({
      structureTags: { ...dataset().structureTags, wayCount: 2 },
    }))).toThrow(/structure_coverage_mismatch/);

    expect(() => producer.validateStructureCoverage(dataset({
      structureTags: {
        ...dataset().structureTags,
        fields: ['bridge', 'tunnel', 'layer'],
      },
    }))).toThrow(/invalid_structure_contract/);
  });

  test('preserves raw OSM values and adds a fully validated per-way consumer contract', () => {
    const input = dataset();
    const output = producer.applyElevationRiskTags(input, {
      derivedAt: '2026-07-28T23:00:00Z',
    });

    expect(output.ways['3']).toEqual(expect.objectContaining({
      bridge: 'viaduct',
      layer: '1',
      elevationRiskTags: {
        bridge: 'yes',
        tunnel: 'no',
        layer: '1',
        embankment: 'no',
        cutting: 'no',
      },
    }));
    expect(output.ways['11'].elevationRiskTags).toEqual({
      bridge: 'no',
      tunnel: 'yes',
      layer: '-1',
      embankment: 'no',
      cutting: 'no',
    });
    expect(output.ways['20'].elevationRiskTags).toEqual({
      bridge: 'no',
      tunnel: 'no',
      layer: '0',
      embankment: 'yes',
      cutting: 'no',
    });
    expect(output.elevationRiskTags).toEqual(expect.objectContaining({
      schemaVersion: 1,
      producerVersion: producer.PRODUCER_VERSION,
      coverage: 'full',
      wayCount: 3,
      derivedAt: '2026-07-28T23:00:00.000Z',
      sourceStructureQueryFingerprint: 'a'.repeat(64),
      sourceStructureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      contract: {
        presenceValues: ['yes', 'no'],
        layer: 'canonical-integer-string',
        consumer: 'js/ua.elevation_provider.js#computeRoadGradient.osmTags',
      },
    }));
    expect(producer.validateElevationRiskContract(output)).toEqual(
      expect.objectContaining({
        wayIds: ['3', '11', '20'],
        sourceStructureFingerprint: output.elevationRiskTags.sourceStructureFingerprint,
      }),
    );
    expect(input.ways['3'].elevationRiskTags).toBeUndefined();
  });

  test('rejects stale, tampered or structurally widened derived risk tags', () => {
    const correct = producer.applyElevationRiskTags(dataset(), {
      derivedAt: '2026-07-28T23:00:00Z',
    });

    const tamperedWay = JSON.parse(JSON.stringify(correct));
    tamperedWay.ways['3'].elevationRiskTags.bridge = 'no';
    expect(() => producer.validateElevationRiskContract(tamperedWay))
      .toThrow(/stale or tampered bridge risk/);

    const extraField = JSON.parse(JSON.stringify(correct));
    extraField.ways['3'].elevationRiskTags.trustMe = 'yes';
    expect(() => producer.validateElevationRiskContract(extraField))
      .toThrow(/unexpected or missing fields/);

    const staleQuery = JSON.parse(JSON.stringify(correct));
    staleQuery.elevationRiskTags.sourceStructureQueryFingerprint = 'b'.repeat(64);
    expect(() => producer.validateElevationRiskContract(staleQuery))
      .toThrow(/another structure query/);

    const staleRaw = JSON.parse(JSON.stringify(correct));
    staleRaw.ways['20'].embankment = 'no';
    expect(() => producer.validateElevationRiskContract(staleRaw))
      .toThrow(/stale for the current raw structure tags/);
  });

  test.each([
    ['3', 'bridge_surface_not_represented_by_dtm'],
    ['11', 'tunnel_surface_not_represented_by_dtm'],
  ])('makes typed bridge/tunnel value on way %s unusable in the shared DGM core', async (wayId, reason) => {
    const output = producer.applyElevationRiskTags(dataset(), {
      derivedAt: '2026-07-28T23:00:00Z',
    });
    const result = await elevation.computeRoadGradient(
      linearProvider(),
      output.wayGeometries[wayId],
      ANCHOR,
      {
        windowMeters: 40,
        spacingMeters: 4,
        matchQuality: 'high',
        osmTags: output.ways[wayId].elevationRiskTags,
      },
    );

    expect(result.usable).toBe(false);
    expect(result.gradientPercent).toBeNull();
    expect(result.quality).toBe('unusable');
    expect(result.uncertaintyReasons).toContain(reason);
  });

  test('records typed embankment uncertainty without discarding an otherwise usable DGM profile', async () => {
    const output = producer.applyElevationRiskTags(dataset(), {
      derivedAt: '2026-07-28T23:00:00Z',
    });
    const result = await elevation.computeRoadGradient(
      linearProvider(),
      output.wayGeometries['20'],
      ANCHOR,
      {
        windowMeters: 40,
        spacingMeters: 4,
        matchQuality: 'high',
        osmTags: output.ways['20'].elevationRiskTags,
      },
    );

    expect(result.usable).toBe(true);
    expect(result.quality).toMatch(/^(high|medium|low)$/);
    expect(result.uncertaintyReasons).toContain(
      'embankment_may_differ_from_terrain',
    );
  });

  test('writes atomically, skips only a fully valid contract and repairs derived or raw drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-risk-'));
    roots.push(root);
    const file = path.join(root, 'osm_hannover.json');
    fs.writeFileSync(file, JSON.stringify(dataset()));

    const first = producer.processFile({
      inputFile: file,
      derivedAt: '2026-07-28T23:00:00Z',
    });
    expect(first).toEqual(expect.objectContaining({
      skipped: false,
      wayCount: 3,
      inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceStructureFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(first.outputSha256).not.toBe(first.inputSha256);
    expect(fs.readdirSync(root).filter((name) => name.includes('.tmp-'))).toEqual([]);

    const second = producer.processFile({ inputFile: file });
    expect(second).toEqual(expect.objectContaining({
      skipped: true,
      reason: 'already current',
      inputSha256: first.outputSha256,
      outputSha256: first.outputSha256,
    }));

    const tampered = JSON.parse(fs.readFileSync(file, 'utf8'));
    tampered.ways['3'].elevationRiskTags.bridge = 'no';
    fs.writeFileSync(file, JSON.stringify(tampered));
    const repairedDerived = producer.processFile({
      inputFile: file,
      derivedAt: '2026-07-28T23:03:00Z',
    });
    expect(repairedDerived.skipped).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).ways['3'].elevationRiskTags.bridge)
      .toBe('yes');

    const changed = JSON.parse(fs.readFileSync(file, 'utf8'));
    changed.ways['20'].embankment = 'no';
    fs.writeFileSync(file, JSON.stringify(changed));
    const repairedRaw = producer.processFile({
      inputFile: file,
      derivedAt: '2026-07-28T23:05:00Z',
    });
    expect(repairedRaw.skipped).toBe(false);
    const finalValue = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(finalValue.ways['20'].elevationRiskTags.embankment).toBe('no');
    expect(() => producer.validateElevationRiskContract(finalValue)).not.toThrow();
  });

  test('rejects symlink inputs and outputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-osm-risk-safety-'));
    roots.push(root);
    const target = path.join(root, 'target.json');
    const link = path.join(root, 'link.json');
    fs.writeFileSync(target, JSON.stringify(dataset()));
    fs.symlinkSync(target, link);
    expect(() => producer.resolveRegularFile(link, 'input')).toThrow(/unsafe_file/);
    expect(() => producer.processFile({ inputFile: target, outputFile: link }))
      .toThrow(/unsafe_file/);
  });
});
