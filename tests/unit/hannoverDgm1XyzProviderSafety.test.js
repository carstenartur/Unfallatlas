"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const dgm1 = require("../../scripts/providers/hannover_dgm1_xyz_provider");

function writeFile(root, relative, contents) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function regularGrid(bounds, elevation = 100) {
  const lines = [];
  for (let y = bounds.minNorthing; y <= bounds.maxNorthing; y += 1) {
    for (let x = bounds.minEasting; x <= bounds.maxEasting; x += 1) {
      lines.push(`${x} ${y} ${elevation}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function createFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-dgm1-safety-"));
  const bounds = options.bounds || {
    minEasting: 549000,
    maxEasting: 549001,
    minNorthing: 5803000,
    maxNorthing: 5803001,
  };
  const contents = options.contents || regularGrid(bounds);
  const dataFile = writeFile(root, "data/dgm1.xyz", contents);
  const manifest = {
    schemaVersion: 1,
    sourceId: "hannover.dgm1",
    retrievedAt: "2026-07-28T12:00:00Z",
    distribution: {
      url: "https://www.hannover.de/dgm1-test.xyz",
      path: "data/dgm1.xyz",
      sha256: dgm1.sha256File(dataFile),
      bytes: fs.statSync(dataFile).size,
    },
    grid: {
      crs: "EPSG:25832",
      resolutionMeters: 1,
      ...bounds,
      maxCells: 100,
    },
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFile(root, "manifest.json", manifestText);
  return {
    root,
    options: {
      allowedRoot: root,
      manifestPath: "manifest.json",
      expectedManifestSha256: dgm1.sha256Buffer(Buffer.from(manifestText)),
    },
  };
}

describe("Hannover DGM1 operational safety", () => {
  const roots = [];

  afterEach(() => {
    jest.restoreAllMocks();
    while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
  });

  test("reports invalid import roots as DGM1 domain errors", () => {
    const missing = path.join(os.tmpdir(), `missing-dgm1-${Date.now()}`);
    expect(() =>
      dgm1.createHannoverDgm1XyzProvider({
        allowedRoot: missing,
        manifestPath: "manifest.json",
        expectedManifestSha256: "a".repeat(64),
      }),
    ).toThrow(/missing_root: allowedRoot does not exist/);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-dgm1-root-file-"));
    roots.push(root);
    writeFile(root, "not-a-directory", "file\n");
    expect(() =>
      dgm1.createHannoverDgm1XyzProvider({
        allowedRoot: path.join(root, "not-a-directory"),
        manifestPath: "manifest.json",
        expectedManifestSha256: "a".repeat(64),
      }),
    ).toThrow(/invalid_root: allowedRoot must be a directory/);
  });

  test("returns null for one unsupported UTM coordinate without failing a valid sample", async () => {
    const valid = { lon: 9.732, lat: 52.375 };
    const projected = dgm1.wgs84ToUtm32(valid);
    const bounds = {
      minEasting: Math.floor(projected.easting),
      maxEasting: Math.floor(projected.easting) + 1,
      minNorthing: Math.floor(projected.northing),
      maxNorthing: Math.floor(projected.northing) + 1,
    };
    const fixture = createFixture({ bounds });
    roots.push(fixture.root);
    const provider = dgm1.createHannoverDgm1XyzProvider(fixture.options);
    const values = await provider.sampleElevations([
      { lon: 13.4, lat: 52.5 },
      valid,
    ]);
    expect(values).toEqual([null, 100]);
  });

  test("caps the parser allocation at an explicit 256 MiB byte budget", () => {
    expect(dgm1.DEFAULT_MAX_CELLS * dgm1.GRID_BYTES_PER_CELL).toBeLessThanOrEqual(
      dgm1.DEFAULT_MAX_GRID_BYTES,
    );
    expect(() =>
      dgm1.normalizeManifest({
        schemaVersion: 1,
        sourceId: "hannover.dgm1",
        retrievedAt: "2026-07-28T12:00:00Z",
        distribution: {
          url: "https://www.hannover.de/dgm1.xyz",
          path: "dgm1.xyz",
          sha256: "a".repeat(64),
          bytes: 1,
        },
        grid: {
          crs: "EPSG:25832",
          resolutionMeters: 1,
          minEasting: 0,
          maxEasting: 1,
          minNorthing: 0,
          maxNorthing: 1,
          maxCells: dgm1.DEFAULT_MAX_CELLS + 1,
        },
      }),
    ).toThrow(/unsafe_grid_limit/);
  });

  test("destroys the XYZ stream after a parser exception", async () => {
    const fixture = createFixture({
      contents: "549000 5803000 100\n549000 5803000 101\n",
    });
    roots.push(fixture.root);
    const originalCreateReadStream = fs.createReadStream.bind(fs);
    let stream;
    jest.spyOn(fs, "createReadStream").mockImplementation((...args) => {
      stream = originalCreateReadStream(...args);
      jest.spyOn(stream, "destroy");
      return stream;
    });
    const provider = dgm1.createHannoverDgm1XyzProvider(fixture.options);
    await expect(provider.preload()).rejects.toThrow(/duplicate_xyz/);
    expect(stream.destroy).toHaveBeenCalled();
  });
});
