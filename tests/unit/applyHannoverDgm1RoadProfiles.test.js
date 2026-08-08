'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const adapter = require('../../scripts/apply-hannover-dgm1-road-profiles');
const producer = require('../../scripts/producers/hannover_dgm1_road_profile_producer');

function writeJson(logicalPath, value, gzip = true) {
  fs.mkdirSync(path.dirname(logicalPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(value));
  if (gzip) fs.writeFileSync(`${logicalPath}.gz`, zlib.gzipSync(bytes, { level: 9, mtime: 0 }));
  else fs.writeFileSync(logicalPath, bytes);
}

function readJson(logicalPath) {
  if (fs.existsSync(logicalPath)) return JSON.parse(fs.readFileSync(logicalPath, 'utf8'));
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(`${logicalPath}.gz`)).toString('utf8'));
}

function descriptor() {
  return {
    id: adapter.SOURCE_ID,
    publisher: 'Landeshauptstadt Hannover – Geoinformation',
    datasetTitle: 'Digitales Geländemodell DGM1',
    datasetUrl: 'https://example.test/dgm1',
    distributionUrl: 'https://example.test/dgm1.zip',
    licenseId: 'CC-BY-4.0',
    licenseName: 'Creative Commons Attribution 4.0 International',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    requiredAttribution: '© Landeshauptstadt Hannover, CC BY 4.0',
    resolutionMeters: 1,
    modelType: 'DTM',
    horizontalCrs: 'EPSG:25832',
    acquisitionPeriod: '2010',
    publicationDate: '2024-01-15',
    retrievedAt: '2026-08-08T00:00:00Z',
    priority: 1,
  };
}

function computedResult(overrides = {}) {
  return {
    schemaVersion: 1,
    semanticType: 'road_longitudinal_gradient',
    usable: true,
    gradientPercent: 4.2,
    gradientRangePercent: [4, 4],
    direction: 'uphill_along_geometry',
    windowMeters: 50,
    profileLengthMeters: 100,
    spacingMeters: 1,
    sampleCount: 101,
    residualMadMeters: 0.02,
    uncertaintyPercent: 0.2,
    quality: 'high',
    uncertaintyReasons: [],
    matchDistanceMeters: 0,
    source: descriptor(),
    method: 'theil-sen-linear-profile-v1',
    statement: 'Straßenlängsneigung: 4,2 %.',
    ...overrides,
  };
}

function profileArtifact() {
  return {
    schemaVersion: producer.SCHEMA_VERSION,
    type: producer.ARTIFACT_TYPE,
    producerVersion: producer.PRODUCER_VERSION,
    city: 'Hannover',
    generatedAt: '2026-08-08T00:00:00Z',
    windowsMeters: [20, 50],
    method: 'theil-sen-linear-profile-v1',
    source: {
      descriptor: descriptor(),
      manifestSha256: 'a'.repeat(64),
      distributionSha256: 'b'.repeat(64),
      grid: { resolutionMeters: 1 },
      preloadedPointCount: 1000,
    },
    osm: {},
    coverage: {
      totalWays: 2,
      computed20m: 2,
      computed50m: 2,
      usable20m: 1,
      usable50m: 1,
      unavailable20m: 0,
      unavailable50m: 0,
      unusableByRisk20m: 1,
      unusableByRisk50m: 1,
    },
    profiles: {
      W1: {
        wayId: 'W1',
        windows: {
          20: { status: 'computed', windowMeters: 20, result: computedResult({ windowMeters: 20, gradientPercent: 3.8, sampleCount: 41 }) },
          50: { status: 'computed', windowMeters: 50, result: computedResult() },
        },
      },
      W2: {
        wayId: 'W2',
        windows: {
          20: {
            status: 'computed',
            windowMeters: 20,
            result: computedResult({
              windowMeters: 20,
              usable: false,
              gradientPercent: null,
              direction: null,
              quality: 'unusable',
              uncertaintyReasons: ['bridge_surface_not_represented_by_dtm'],
            }),
          },
          50: {
            status: 'computed',
            windowMeters: 50,
            result: computedResult({
              usable: false,
              gradientPercent: null,
              direction: null,
              quality: 'unusable',
              uncertaintyReasons: ['bridge_surface_not_represented_by_dtm'],
            }),
          },
        },
      },
    },
    truthBoundary: {},
  };
}

function prepareRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-dgm1-apply-'));
  writeJson(path.join(root, '.build/context-provider/hannover-dgm1-road-profiles.json'), profileArtifact(), false);
  writeJson(path.join(root, 'out/ways_hannover.json'), {
    schemaVersion: 3,
    coverage: 'full',
    tileIndexUrl: 'out/ctxtiles/hannover/index.json',
  });
  writeJson(path.join(root, 'out/ctxtiles/hannover/index.json'), {
    schemaVersion: 3,
    tiles: [{ x: 4318, y: 2688 }],
  });
  writeJson(path.join(root, 'out/ctxtiles/hannover/4318/2688.json'), {
    schemaVersion: 3,
    ways: {
      W1: { road_slope_percent: 99, road_slope_source: 'SRTM' },
      W2: { road_slope_percent: 88, road_slope_class: 'very_steep' },
    },
    geometries: {
      W1: [52.3, 9.7, 52.31, 9.71],
      W2: [52.4, 9.8, 52.41, 9.81],
    },
  });
  writeJson(path.join(root, 'out/output_all_years_hannover.enrichment.meta.json'), {
    schemaVersion: 3,
    sources: { dem: { source: 'SRTM Local Tiles', resolutionM: 30 } },
    counts: {},
  });
  return root;
}

describe('apply-hannover-dgm1-road-profiles', () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test('replaces coarse way slopes with official 1 m road profiles and preserves risk exclusions', () => {
    root = prepareRoot();
    const result = adapter.applyHannoverDgm1RoadProfiles({ root });
    expect(result).toEqual(expect.objectContaining({
      profileWays: 2,
      uniqueWaysObserved: 2,
      appliedWayRows: 1,
      sourceId: 'hannover.dgm1',
      resolutionMeters: 1,
    }));

    const tile = readJson(path.join(root, 'out/ctxtiles/hannover/4318/2688.json'));
    expect(tile.ways.W1).toEqual(expect.objectContaining({
      road_slope_percent: 4.2,
      road_slope_class: 'moderate',
      road_slope_method: 'theil-sen-linear-profile-v1',
      road_slope_sample_count: 101,
      road_slope_confidence: 'high',
      road_slope_source_id: 'hannover.dgm1',
      road_slope_source: 'Digitales Geländemodell DGM1',
      road_slope_resolution_m: 1,
      road_slope_profile_window_m: 50,
      road_slope_reliable_for_road: true,
      road_slope_uncertainty_percent: 0.2,
    }));
    expect(tile.ways.W2.road_slope_percent).toBeUndefined();
    expect(tile.ways.W2.road_slope_class).toBeUndefined();
    expect(tile.ways.W2).toEqual(expect.objectContaining({
      road_slope_source_id: 'hannover.dgm1',
      road_slope_reliable_for_road: false,
      road_slope_missing_reason: 'bridge_surface_not_represented_by_dtm',
    }));

    const meta = readJson(path.join(root, 'out/output_all_years_hannover.enrichment.meta.json'));
    expect(meta.sources.dem).toEqual({ source: 'SRTM Local Tiles', resolutionM: 30 });
    expect(meta.sources.roadSlope).toEqual(expect.objectContaining({
      sourceId: 'hannover.dgm1',
      resolutionM: 1,
      licenseId: 'CC-BY-4.0',
      method: 'theil-sen-linear-profile-v1',
      windowsMeters: [20, 50],
    }));
    expect(meta.roadSlope).toEqual(expect.objectContaining({
      sourceId: 'hannover.dgm1',
      runtimeWayRowsWithUsableGradient: 1,
      failClosed: true,
    }));
  });

  test('rolls every runtime artifact back when an atomic install step fails', () => {
    root = prepareRoot();
    const paths = [
      path.join(root, 'out/ways_hannover.json.gz'),
      path.join(root, 'out/ctxtiles/hannover/4318/2688.json.gz'),
      path.join(root, 'out/output_all_years_hannover.enrichment.meta.json.gz'),
    ];
    const before = Object.fromEntries(paths.map(file => [file, fs.readFileSync(file)]));

    expect(() => adapter.applyHannoverDgm1RoadProfiles({
      root,
      onCommitStep({ step }) {
        if (step === 1) throw new Error('simulated commit failure');
      },
    })).toThrow(/simulated commit failure/);

    for (const file of paths) expect(fs.readFileSync(file).equals(before[file])).toBe(true);
  });

  test('fails closed when runtime context contains a way outside the validated profile artifact', () => {
    root = prepareRoot();
    const tilePath = path.join(root, 'out/ctxtiles/hannover/4318/2688.json');
    const tile = readJson(tilePath);
    tile.ways.W3 = { road_slope_percent: 1 };
    writeJson(tilePath, tile);

    expect(() => adapter.applyHannoverDgm1RoadProfiles({ root }))
      .toThrow(/way W3 without a DGM1 profile/);
  });
});