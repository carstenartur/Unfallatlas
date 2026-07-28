"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const elevation = require("../../js/ua.elevation_provider");
const dgm1 = require("../../scripts/providers/hannover_dgm1_xyz_provider");

const DATASET_URL =
  "https://www.hannover.de/Leben-in-der-Region-Hannover/Verwaltungen-Kommunen/Die-Verwaltung-der-Landeshauptstadt-Hannover/Dezernate-und-Fachbereiche-der-LHH/Stadtentwicklung-und-Bauen/Fachbereich-Planen-und-Stadtentwicklung/Geoinformation/Open-GeoData/3D-Stadtmodell-und-Gel%C3%A4ndemodell/Digitales-Gel%C3%A4ndemodell-DGM1";

function writeFile(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function writeJson(root, relative, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  return {
    file: writeFile(root, relative, contents),
    relative,
    sha256: dgm1.sha256Buffer(Buffer.from(contents)),
  };
}

function gridText(bounds, elevationAt, overrides = {}) {
  const lines = [];
  for (let y = bounds.minNorthing; y <= bounds.maxNorthing; y += 1) {
    for (let x = bounds.minEasting; x <= bounds.maxEasting; x += 1) {
      const key = `${x},${y}`;
      const z = Object.hasOwn(overrides, key)
        ? overrides[key]
        : elevationAt(x, y);
      lines.push(`${x} ${y} ${z}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-dgm1-xyz-"));
  const bounds = options.bounds;
  const contents = options.contents || gridText(bounds, options.elevationAt);
  const dataRelative = options.dataRelative || "data/dgm1.xyz";
  const dataFile = writeFile(root, dataRelative, contents);
  const manifest = {
    schemaVersion: 1,
    sourceId: "hannover.dgm1",
    retrievedAt: "2026-07-28T12:00:00Z",
    distribution: {
      url: options.distributionUrl || `${DATASET_URL}?download=xyz-test-fixture`,
      path: dataRelative,
      sha256: dgm1.sha256File(dataFile),
      bytes: fs.statSync(dataFile).size,
      publicationDate: "2024-01-15",
    },
    grid: {
      crs: "EPSG:25832",
      resolutionMeters: 1,
      ...bounds,
      maxCells: options.maxCells || 1_000_000,
      ...(options.noDataValue == null
        ? {}
        : { noDataValue: options.noDataValue }),
    },
    ...(options.manifestOverrides || {}),
  };
  const writtenManifest = writeJson(root, "manifest.json", manifest);
  return {
    root,
    bounds,
    dataFile,
    manifest,
    providerOptions: {
      allowedRoot: root,
      manifestPath: "manifest.json",
      expectedManifestSha256: writtenManifest.sha256,
    },
  };
}

describe("Hannover DGM1 ASCII XYZ provider", () => {
  const roots = [];

  afterEach(() => {
    while (roots.length) {
      fs.rmSync(roots.pop(), { recursive: true, force: true });
    }
  });

  test("projects WGS84 gold coordinates to EPSG:25832 within centimetres", () => {
    const cases = [
      {
        coordinate: { lon: 9.732, lat: 52.375 },
        easting: 549830.870901727,
        northing: 5803000.232663571,
      },
      {
        coordinate: { lon: 9.7, lat: 52.4 },
        easting: 547625.587274984,
        northing: 5805759.373077576,
      },
      {
        coordinate: { lon: 9.8, lat: 52.3 },
        easting: 554552.106372788,
        northing: 5794707.262864829,
      },
    ];
    for (const expected of cases) {
      const actual = dgm1.wgs84ToUtm32(expected.coordinate);
      expect(actual.easting).toBeCloseTo(expected.easting, 2);
      expect(actual.northing).toBeCloseTo(expected.northing, 2);
    }
  });

  test("loads a hash-pinned 1 m grid and bilinearly samples the published CRS", async () => {
    const coordinate = { lon: 9.732, lat: 52.375 };
    const projected = dgm1.wgs84ToUtm32(coordinate);
    const bounds = {
      minEasting: Math.floor(projected.easting) - 1,
      maxEasting: Math.floor(projected.easting) + 2,
      minNorthing: Math.floor(projected.northing) - 1,
      maxNorthing: Math.floor(projected.northing) + 2,
    };
    const fixture = createFixture({
      bounds,
      elevationAt: (x, y) =>
        100 +
        0.5 * (x - bounds.minEasting) +
        0.25 * (y - bounds.minNorthing),
    });
    roots.push(fixture.root);
    const provider = dgm1.createHannoverDgm1XyzProvider(
      fixture.providerOptions,
    );

    expect(await provider.canProvide({ city: "Hannover" })).toBe(true);
    expect(await provider.canProvide({ city: "Bonn" })).toBe(false);
    expect(provider.descriptor).toEqual(
      expect.objectContaining({
        id: "hannover.dgm1",
        resolutionMeters: 1,
        modelType: "DTM",
        horizontalCrs: "EPSG:25832",
        datasetUrl: DATASET_URL,
      }),
    );
    const [sample] = await provider.sampleElevations([coordinate]);
    const expected =
      100 +
      0.5 * (projected.easting - bounds.minEasting) +
      0.25 * (projected.northing - bounds.minNorthing);
    expect(sample).toBeCloseTo(expected, 4);
    expect(await provider.preload()).toEqual(
      expect.objectContaining({
        pointCount: 16,
        sha256: fixture.manifest.distribution.sha256,
      }),
    );
  });

  test("feeds the shared robust profile estimator with a synthetic 10 percent gold slope", async () => {
    const west = { lon: 9.731, lat: 52.375 };
    const east = { lon: 9.733, lat: 52.375 };
    const anchor = { lon: 9.732, lat: 52.375 };
    const projected = [west, east, anchor].map(dgm1.wgs84ToUtm32);
    const bounds = {
      minEasting: Math.floor(Math.min(...projected.map((item) => item.easting))) - 3,
      maxEasting: Math.ceil(Math.max(...projected.map((item) => item.easting))) + 3,
      minNorthing: Math.floor(Math.min(...projected.map((item) => item.northing))) - 3,
      maxNorthing: Math.ceil(Math.max(...projected.map((item) => item.northing))) + 3,
    };
    const fixture = createFixture({
      bounds,
      maxCells: 10_000,
      elevationAt: (x) => 50 + 0.1 * (x - bounds.minEasting),
    });
    roots.push(fixture.root);
    const provider = dgm1.createHannoverDgm1XyzProvider(
      fixture.providerOptions,
    );
    const result = await elevation.computeRoadGradient(
      provider,
      [west, east],
      anchor,
      {
        windowMeters: 50,
        spacingMeters: 5,
        matchQuality: "high",
        context: { city: "Hannover" },
      },
    );

    expect(result.semanticType).toBe("road_longitudinal_gradient");
    expect(result.gradientPercent).toBeCloseTo(10, 1);
    expect(result.quality).toBe("high");
    expect(result.sampleCount).toBeGreaterThanOrEqual(15);
    expect(result.source.id).toBe("hannover.dgm1");
    expect(result.statement).toMatch(/Straßenlängsneigung/);
  });

  test("returns no sample when one of the four interpolation cells is NoData", async () => {
    const coordinate = { lon: 9.732, lat: 52.375 };
    const projected = dgm1.wgs84ToUtm32(coordinate);
    const bounds = {
      minEasting: Math.floor(projected.easting),
      maxEasting: Math.floor(projected.easting) + 1,
      minNorthing: Math.floor(projected.northing),
      maxNorthing: Math.floor(projected.northing) + 1,
    };
    const missing = `${bounds.maxEasting},${bounds.maxNorthing}`;
    const contents = gridText(bounds, () => 100, { [missing]: -9999 });
    const fixture = createFixture({
      bounds,
      contents,
      elevationAt: () => 100,
      noDataValue: -9999,
    });
    roots.push(fixture.root);
    const provider = dgm1.createHannoverDgm1XyzProvider(
      fixture.providerOptions,
    );
    expect(await provider.sampleElevations([coordinate])).toEqual([null]);
  });

  test("fails closed on manifest or distribution drift", async () => {
    const bounds = {
      minEasting: 549000,
      maxEasting: 549001,
      minNorthing: 5803000,
      maxNorthing: 5803001,
    };
    const fixture = createFixture({
      bounds,
      elevationAt: () => 100,
    });
    roots.push(fixture.root);
    expect(() =>
      dgm1.createHannoverDgm1XyzProvider({
        ...fixture.providerOptions,
        expectedManifestSha256: "a".repeat(64),
      }),
    ).toThrow(/manifest_hash_mismatch/);

    const provider = dgm1.createHannoverDgm1XyzProvider(
      fixture.providerOptions,
    );
    fs.appendFileSync(fixture.dataFile, "# drift\n");
    await expect(provider.preload()).rejects.toThrow(/distribution_size_mismatch/);
  });

  test("rejects duplicate cells, grid misalignment and path traversal", async () => {
    const bounds = {
      minEasting: 549000,
      maxEasting: 549001,
      minNorthing: 5803000,
      maxNorthing: 5803001,
    };
    const duplicateFixture = createFixture({
      bounds,
      contents:
        "549000 5803000 100\n" +
        "549000 5803000 101\n" +
        "549001 5803000 100\n" +
        "549000 5803001 100\n" +
        "549001 5803001 100\n",
      elevationAt: () => 100,
    });
    roots.push(duplicateFixture.root);
    const duplicateProvider = dgm1.createHannoverDgm1XyzProvider(
      duplicateFixture.providerOptions,
    );
    await expect(duplicateProvider.preload()).rejects.toThrow(/duplicate_xyz/);

    expect(() =>
      dgm1.normalizeManifest({
        ...duplicateFixture.manifest,
        grid: {
          ...duplicateFixture.manifest.grid,
          maxEasting: 549001.5,
        },
      }),
    ).toThrow(/misaligned_bounds/);

    expect(() =>
      dgm1.createHannoverDgm1XyzProvider({
        ...duplicateFixture.providerOptions,
        manifestPath: "../manifest.json",
      }),
    ).toThrow(/unsafe_path/);
  });

  test("rejects source files whose declared allocation exceeds the pinned safety limit", () => {
    const manifest = {
      schemaVersion: 1,
      sourceId: "hannover.dgm1",
      retrievedAt: "2026-07-28T12:00:00Z",
      distribution: {
        url: DATASET_URL,
        path: "dgm1.xyz",
        sha256: "a".repeat(64),
        bytes: 1,
      },
      grid: {
        crs: "EPSG:25832",
        resolutionMeters: 1,
        minEasting: 0,
        maxEasting: 100,
        minNorthing: 0,
        maxNorthing: 100,
        maxCells: 100,
      },
    };
    expect(() => dgm1.normalizeManifest(manifest)).toThrow(/grid_too_large/);
  });
});
