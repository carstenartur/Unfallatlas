"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const traffic = require("../../js/ua.traffic_provider");
const snapshots = require("../../scripts/providers/traffic_snapshot_provider");

const DISTRIBUTION_HASH = "b".repeat(64);

function source(sourceId) {
  return snapshots.OPEN_DATA_SOURCE_CATALOG[sourceId];
}

function observationFor(sourceId, overrides = {}) {
  const entry = source(sourceId);
  return {
    observationId: `${sourceId}.gold-1`,
    measurementType: entry.descriptor.measurementType,
    mode: entry.coverage.modes[0],
    year: entry.coverage.toYear,
    period:
      sourceId === "traffic.count.berlin-bicycle-hourly-2012-2025"
        ? "Stundenwert 08:00–09:00"
        : "DTVw",
    value: 18500,
    unit: entry.descriptor.unit,
    geometry: { type: "Point", coordinates: [7.095, 50.735] },
    direction: "Querschnitt, beide Richtungen",
    qualityNotes: ["Deterministische Testbeobachtung."],
    ...overrides,
  };
}

function snapshotValue(sourceId, overrides = {}) {
  const entry = source(sourceId);
  return {
    schemaVersion: 1,
    snapshotId: `${sourceId}.snapshot-1`,
    sourceId,
    retrievedAt: "2026-07-28T12:00:00Z",
    distribution: {
      url: entry.descriptor.distributionUrl,
      sha256: DISTRIBUTION_HASH,
      bytes: 12345,
      mediaType:
        sourceId === "traffic.count.berlin-bicycle-hourly-2012-2025"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : sourceId === "traffic.model.berlin-dtvw-2023"
            ? "application/gml+xml"
            : "text/csv",
      ...(entry.descriptor.versionOrPublicationDate
        ? {
            versionOrPublicationDate:
              entry.descriptor.versionOrPublicationDate,
          }
        : {}),
    },
    coverage: {
      city: entry.coverage.city,
      fromYear: entry.coverage.fromYear,
      toYear: entry.coverage.toYear,
      modes: [...entry.coverage.modes],
    },
    observations: [observationFor(sourceId)],
    ...overrides,
  };
}

function writeJson(root, relativePath, value) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, contents);
  return {
    file,
    relativePath,
    sha256: snapshots.sha256Buffer(Buffer.from(contents)),
  };
}

function providerOptions(root, sourceId, overrides = {}) {
  const written = writeJson(
    root,
    `${sourceId.replace(/[^a-z0-9]+/gi, "-")}.json`,
    snapshotValue(sourceId, overrides.snapshot),
  );
  return {
    sourceId,
    allowedRoot: root,
    snapshotPath: written.relativePath,
    expectedSnapshotSha256: written.sha256,
    written,
    ...overrides.options,
  };
}

describe("licensed traffic snapshot provider", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-traffic-snapshot-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("ships three reviewed open-data source contracts without a numeric proxy", () => {
    const entries = Object.values(snapshots.OPEN_DATA_SOURCE_CATALOG);
    expect(entries).toHaveLength(3);
    expect(
      entries.map((entry) => entry.descriptor.measurementType).sort(),
    ).toEqual(["count", "count", "model"]);
    for (const entry of entries) {
      expect(entry.descriptor.licenseId).toBe("DL-DE-Zero-2.0");
      expect(entry.descriptor.distributionUrl).toMatch(/^https:\/\//);
      expect(entry.descriptor.measurementType).not.toBe("proxy");
      expect(entry.descriptor.unit).toBeTruthy();
      expect(entry.descriptor.permissions).toEqual({
        permitsRedistribution: true,
        permitsDerivatives: true,
        commercialUseAllowed: true,
      });
    }
  });

  test("creates a measured provider only after snapshot and distribution pins validate", async () => {
    const sourceId = "traffic.count.koeln-kfz-2010-2019";
    const provider = snapshots.createSnapshotProvider(
      providerOptions(root, sourceId),
    );

    expect(provider.id).toBe(sourceId);
    expect(provider.descriptor).toEqual(
      expect.objectContaining({
        measurementType: "count",
        licenseId: "DL-DE-Zero-2.0",
        contentHash: DISTRIBUTION_HASH,
        retrievedAt: "2026-07-28T12:00:00Z",
      }),
    );
    expect(provider.snapshot).toEqual(
      expect.objectContaining({
        distributionSha256: DISTRIBUTION_HASH,
        distributionBytes: 12345,
      }),
    );
    expect(await provider.canProvide({ city: "Koeln" })).toBe(true);
    expect(await provider.canProvide({ city: "Bonn" })).toBe(false);

    const observations = await provider.loadObservations({ city: "Köln" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toEqual(
      expect.objectContaining({
        sourceId,
        measurementType: "count",
        value: 18500,
        unit: "Kfz/24 h",
        year: 2019,
      }),
    );
    expect(observations[0].source.datasetUrl).toBe(
      "https://open.nrw/dataset/kfz-zaehlstellen-und-werte-koeln-k",
    );
  });

  test("registers pinned snapshots and collects only sources covering the requested city", async () => {
    const registrations = [];
    for (const sourceId of Object.keys(snapshots.OPEN_DATA_SOURCE_CATALOG)) {
      const written = writeJson(
        root,
        `snapshots/${sourceId}.json`,
        snapshotValue(sourceId),
      );
      registrations.push({
        sourceId,
        path: written.relativePath,
        sha256: written.sha256,
      });
    }
    writeJson(root, "registry.json", {
      schemaVersion: 1,
      snapshots: registrations,
    });
    const registry = traffic.createRegistry();
    const providers = snapshots.registerSnapshotManifest(registry, {
      allowedRoot: root,
      registryPath: "registry.json",
    });

    expect(providers).toHaveLength(3);
    const berlin = await registry.collect({
      city: "Berlin",
      failOnProviderError: true,
    });
    expect(berlin.map((item) => item.sourceId).sort()).toEqual([
      "traffic.count.berlin-bicycle-hourly-2012-2025",
      "traffic.model.berlin-dtvw-2023",
    ]);
    const koeln = await registry.collect({
      city: "Köln",
      failOnProviderError: true,
    });
    expect(koeln.map((item) => item.sourceId)).toEqual([
      "traffic.count.koeln-kfz-2010-2019",
    ]);
  });

  test("fails closed when the normalized snapshot hash drifts", () => {
    const options = providerOptions(
      root,
      "traffic.count.koeln-kfz-2010-2019",
    );
    options.expectedSnapshotSha256 = "c".repeat(64);
    expect(() => snapshots.createSnapshotProvider(options)).toThrow(
      /snapshot_hash_mismatch/,
    );
  });

  test("fails closed when a snapshot points at another distribution", () => {
    const sourceId = "traffic.model.berlin-dtvw-2023";
    const options = providerOptions(root, sourceId, {
      snapshot: {
        distribution: {
          ...snapshotValue(sourceId).distribution,
          url: "https://example.org/unreviewed.gml",
        },
      },
    });
    expect(() => snapshots.createSnapshotProvider(options)).toThrow(
      /distribution_mismatch/,
    );
  });

  test("rejects observations outside temporal or modal coverage", () => {
    const sourceId = "traffic.count.berlin-bicycle-hourly-2012-2025";
    const badYear = providerOptions(root, sourceId, {
      snapshot: {
        observations: [observationFor(sourceId, { year: 2026 })],
      },
    });
    expect(() => snapshots.createSnapshotProvider(badYear)).toThrow(
      /observation_outside_coverage/,
    );

    const rewritten = writeJson(
      root,
      "bad-mode.json",
      snapshotValue(sourceId, {
        observations: [
          observationFor(sourceId, { mode: "motor_vehicle" }),
        ],
      }),
    );
    expect(() =>
      snapshots.createSnapshotProvider({
        sourceId,
        allowedRoot: root,
        snapshotPath: "bad-mode.json",
        expectedSnapshotSha256: rewritten.sha256,
      }),
    ).toThrow(/observation_outside_coverage/);
  });

  test("rejects source coverage expansion and unknown envelope fields", () => {
    const sourceId = "traffic.model.berlin-dtvw-2023";
    const expanded = providerOptions(root, sourceId, {
      snapshot: {
        coverage: {
          city: "Berlin",
          fromYear: 2022,
          toYear: 2023,
          modes: ["motor_vehicle"],
        },
      },
    });
    expect(() => snapshots.createSnapshotProvider(expanded)).toThrow(
      /coverage_expansion/,
    );

    const rewritten = writeJson(
      root,
      "unknown.json",
      snapshotValue(sourceId, { undocumentedTrustMe: true }),
    );
    expect(() =>
      snapshots.createSnapshotProvider({
        sourceId,
        allowedRoot: root,
        snapshotPath: "unknown.json",
        expectedSnapshotSha256: rewritten.sha256,
      }),
    ).toThrow(/invalid_fields/);
  });

  test("confines registry and snapshot paths to the declared import root", () => {
    const outsideRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "ua-traffic-outside-"),
    );
    try {
      const outside = writeJson(
        outsideRoot,
        "outside.json",
        snapshotValue("traffic.count.koeln-kfz-2010-2019"),
      );
      expect(() =>
        snapshots.createSnapshotProvider({
          sourceId: "traffic.count.koeln-kfz-2010-2019",
          allowedRoot: root,
          snapshotPath: outside.file,
          expectedSnapshotSha256: outside.sha256,
        }),
      ).toThrow(/unsafe_snapshot_path/);
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("requires unique catalog sources in a registry manifest", () => {
    expect(() =>
      snapshots.normalizeRegistryManifest({
        schemaVersion: 1,
        snapshots: [
          {
            sourceId: "traffic.count.koeln-kfz-2010-2019",
            path: "one.json",
            sha256: "a".repeat(64),
          },
          {
            sourceId: "traffic.count.koeln-kfz-2010-2019",
            path: "two.json",
            sha256: "b".repeat(64),
          },
        ],
      }),
    ).toThrow(/duplicate_source/);
  });
});
