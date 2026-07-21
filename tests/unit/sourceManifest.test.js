"use strict";

const sourceManifest = require("../../js/ua.source_manifest");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function accidentSource(overrides = {}) {
  return {
    sourceId: "accidents.de.unfallatlas",
    role: "accidents",
    publisher: "Statistische Ämter des Bundes und der Länder",
    datasetTitle: "Unfallatlas – Straßenverkehrsunfälle mit Personenschaden",
    datasetUrl: "https://unfallatlas.statistikportal.de/",
    distributionUrl: "https://example.org/unfallatlas/2024.zip",
    licenseId: "DL-DE-BY-2.0",
    licenseName: "Datenlizenz Deutschland – Namensnennung – Version 2.0",
    licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
    requiredAttribution:
      "© Statistische Ämter des Bundes und der Länder, Unfallatlas",
    temporalCoverage: "2016–2024",
    spatialCoverage: "Bonn",
    versionOrPublicationDate: "2025-07-01",
    retrievedAt: "2026-07-21T12:00:00Z",
    contentHash: HASH_A,
    changedOrDerived: true,
    changeNotice:
      "Gefiltert, reprojiziert und für die Unfallwerkbank zusammengeführt.",
    permissions: {
      permitsRedistribution: true,
      permitsDerivatives: true,
      commercialUseAllowed: true,
    },
    qualityNotes: ["Nur polizeilich erfasste Unfälle mit Personenschaden."],
    ...overrides,
  };
}

function osmSource(overrides = {}) {
  return {
    sourceId: "roads.openstreetmap",
    role: "road_context",
    publisher: "OpenStreetMap-Mitwirkende",
    datasetTitle: "OpenStreetMap-Datenbank",
    datasetUrl: "https://www.openstreetmap.org/",
    licenseId: "ODbL-1.0",
    licenseName: "Open Data Commons Open Database License 1.0",
    licenseUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    requiredAttribution: "© OpenStreetMap-Mitwirkende",
    retrievedAt: "2026-07-21",
    changedOrDerived: true,
    changeNotice:
      "Straßengeometrien und Tags räumlich gefiltert und abgeleitete Klassen erzeugt.",
    ...overrides,
  };
}

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: "location-brief.bonn.2026-07-21",
    artifactHash: HASH_B,
    generatedAt: "2026-07-21T12:05:00Z",
    applicationVersion: "2.1.4",
    buildFingerprint: HASH_A,
    dataFingerprint: HASH_B,
    scenario: {
      city: "Bonn",
      bounds: { south: 50.73, west: 7.09, north: 50.74, east: 7.1 },
      filters: { severity: "all", involvementMode: "and" },
      years: [2024, 2022, 2024, 2023],
    },
    sources: [osmSource(), accidentSource()],
    transformations: [
      {
        transformationId: "transform.accident-filter",
        label: "Unfallauswahl",
        description: "Wendet Stadt-, Bereichs- und Beteiligungsfilter an.",
        sourceIds: ["accidents.de.unfallatlas"],
        outputFields: ["accidents", "severityCounts"],
        softwareVersion: "2.1.4",
        parameters: {
          involvementMode: "and",
          includeCyclist: true,
          includeCar: true,
        },
      },
      {
        transformationId: "transform.road-context",
        label: "Straßenkontext",
        description: "Matched Unfallorte auf gefilterte OSM-Straßengeometrien.",
        sourceIds: ["roads.openstreetmap", "accidents.de.unfallatlas"],
        outputFields: ["roadContext"],
      },
    ],
    ...overrides,
  };
}

describe("renderer-independent source manifest", () => {
  test("normalizes one deterministic immutable manifest for every renderer", () => {
    const normalized = sourceManifest.normalizeManifest(validManifest());

    expect(normalized.schemaVersion).toBe(1);
    expect(normalized.scenario.years).toEqual([2022, 2023, 2024]);
    expect(normalized.sources.map((source) => source.sourceId)).toEqual([
      "accidents.de.unfallatlas",
      "roads.openstreetmap",
    ]);
    expect(
      normalized.transformations.map((item) => item.transformationId),
    ).toEqual(["transform.accident-filter", "transform.road-context"]);
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.sources[0])).toBe(true);
    expect(sourceManifest.stableStringify(normalized)).toBe(
      sourceManifest.stableStringify(
        sourceManifest.normalizeManifest(
          validManifest({
            sources: [accidentSource(), osmSource()],
          }),
        ),
      ),
    );
  });

  test("publishes the same browser and Node API", () => {
    expect(window.UA.sourceManifest).toBe(sourceManifest);
    expect(sourceManifest.SOURCE_ROLES).toContain("traffic_count");
    expect(
      sourceManifest.LICENSE_POLICIES["DL-DE-BY-2.0"].requiresAttribution,
    ).toBe(true);
  });

  test("canonicalizes accepted licence aliases but not arbitrary licences", () => {
    const normalized = sourceManifest.normalizeManifest(
      validManifest({
        sources: [
          accidentSource({ licenseId: "dl-de/by-2-0" }),
          osmSource({ licenseId: "ODbL 1.0" }),
        ],
      }),
    );
    expect(normalized.sources.map((source) => source.licenseId)).toEqual([
      "DL-DE-BY-2.0",
      "ODbL-1.0",
    ]);

    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          sources: [
            accidentSource({ licenseId: "Custom-Portal-Terms" }),
            osmSource(),
          ],
        }),
      ),
    ).toThrow(/unsupported_license/);
  });

  test.each([
    ["publisher", ""],
    ["datasetTitle", ""],
    ["datasetUrl", ""],
    ["licenseUrl", ""],
    ["retrievedAt", "not-a-date"],
  ])(
    "fails closed when required source field %s is invalid",
    (field, value) => {
      expect(() =>
        sourceManifest.normalizeManifest(
          validManifest({
            sources: [accidentSource({ [field]: value }), osmSource()],
          }),
        ),
      ).toThrow();
    },
  );

  test("requires HTTPS dataset, distribution and licence links", () => {
    for (const mutation of [
      { datasetUrl: "http://example.org/dataset" },
      { distributionUrl: "ftp://example.org/data.zip" },
      { licenseUrl: "javascript:alert(1)" },
    ]) {
      expect(() =>
        sourceManifest.normalizeManifest(
          validManifest({
            sources: [accidentSource(mutation), osmSource()],
          }),
        ),
      ).toThrow(/(?:unsafe_url|invalid_url)/);
    }
  });

  test("enforces attribution and modification notices from licence policy", () => {
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          sources: [accidentSource({ requiredAttribution: "" }), osmSource()],
        }),
      ),
    ).toThrow(/missing_attribution/);

    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          sources: [accidentSource({ changeNotice: "" }), osmSource()],
        }),
      ),
    ).toThrow(/missing_change_notice/);

    const cc0 = accidentSource({
      licenseId: "CC0-1.0",
      licenseName: "Creative Commons CC0 1.0 Universal",
      requiredAttribution: undefined,
      changeNotice: undefined,
    });
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          sources: [cc0, osmSource()],
        }),
      ),
    ).not.toThrow();
  });

  test("rejects misleading licence names and restrictive permissions", () => {
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          sources: [accidentSource({ licenseName: "Open Data" }), osmSource()],
        }),
      ),
    ).toThrow(/license_name_mismatch/);

    for (const permissions of [
      { permitsRedistribution: false },
      { permitsDerivatives: false },
      { commercialUseAllowed: false },
    ]) {
      expect(() =>
        sourceManifest.normalizeManifest(
          validManifest({
            sources: [accidentSource({ permissions }), osmSource()],
          }),
        ),
      ).toThrow(/restricted_source/);
    }
  });

  test("rejects duplicate and orphaned source references", () => {
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          sources: [accidentSource(), accidentSource()],
        }),
      ),
    ).toThrow(/duplicate_source_id/);

    const manifest = validManifest();
    manifest.transformations[0].sourceIds.push("missing.source");
    expect(() => sourceManifest.normalizeManifest(manifest)).toThrow(
      /orphaned_source_reference/,
    );
  });

  test("rejects duplicate transformation IDs and unknown fields", () => {
    const duplicate = validManifest();
    duplicate.transformations.push({ ...duplicate.transformations[0] });
    expect(() => sourceManifest.normalizeManifest(duplicate)).toThrow(
      /duplicate_transformation_id/,
    );

    expect(() =>
      sourceManifest.normalizeManifest({ ...validManifest(), debug: true }),
    ).toThrow(/unknown_field/);
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          sources: [{ ...accidentSource(), typo: true }, osmSource()],
        }),
      ),
    ).toThrow(/unknown_field/);
  });

  test("rejects invalid fingerprints, artifact hashes, bounds and years", () => {
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({ buildFingerprint: "abc" }),
      ),
    ).toThrow(/invalid_sha256/);
    expect(() =>
      sourceManifest.normalizeManifest(validManifest({ artifactHash: "abc" })),
    ).toThrow(/invalid_sha256/);
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          scenario: {
            ...validManifest().scenario,
            bounds: { south: 51, west: 7, north: 50, east: 8 },
          },
        }),
      ),
    ).toThrow(/invalid_bounds/);
    expect(() =>
      sourceManifest.normalizeManifest(
        validManifest({
          scenario: { ...validManifest().scenario, years: [2024, 1899] },
        }),
      ),
    ).toThrow(/invalid_year/);
  });

  test("derives field-specific source IDs only through declared transformations", () => {
    const manifest = validManifest();
    expect(
      sourceManifest.sourceIdsForFields(manifest, ["severityCounts"]),
    ).toEqual(["accidents.de.unfallatlas"]);
    expect(
      sourceManifest.sourceIdsForFields(manifest, ["roadContext"]),
    ).toEqual(["accidents.de.unfallatlas", "roads.openstreetmap"]);
    expect(sourceManifest.sourceIdsForFields(manifest, ["unknown"])).toEqual(
      [],
    );
  });

  test("produces renderer-ready source summaries with linked dataset and licence URLs", () => {
    const summaries = sourceManifest.visibleSourceSummary(validManifest());
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toEqual(
      expect.objectContaining({
        sourceId: "accidents.de.unfallatlas",
        datasetUrl: "https://unfallatlas.statistikportal.de/",
        licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
        changedOrDerived: true,
      }),
    );
    expect(summaries.every((item) => item.label && item.licenseLabel)).toBe(
      true,
    );
  });

  test("omits an empty optional distribution URL from canonical output", () => {
    const normalized = sourceManifest.normalizeManifest(
      validManifest({
        sources: [accidentSource({ distributionUrl: "" }), osmSource()],
      }),
    );
    expect(normalized.sources[0]).not.toHaveProperty("distributionUrl");
    expect(sourceManifest.stableStringify(normalized)).not.toContain(
      "distributionUrl",
    );
  });

  test.each([
    [
      "impossible retrieval date",
      validManifest({
        sources: [accidentSource({ retrievedAt: "2026-02-31" }), osmSource()],
      }),
    ],
    [
      "impossible publication date",
      validManifest({
        sources: [
          accidentSource({ versionOrPublicationDate: "2026-02-31" }),
          osmSource(),
        ],
      }),
    ],
    [
      "invalid generated timestamp",
      validManifest({ generatedAt: "2026-07-21T25:00:00Z" }),
    ],
    [
      "invalid timezone offset",
      validManifest({ generatedAt: "2026-07-21T12:00:00+14:30" }),
    ],
  ])("rejects %s without Date.parse normalization", (_label, manifest) => {
    expect(() => sourceManifest.normalizeManifest(manifest)).toThrow(
      /invalid_date/,
    );
  });

  test.each([
    [
      "scenario years",
      validManifest({
        scenario: { ...validManifest().scenario, years: "2024" },
      }),
      "manifest.scenario.years",
    ],
    [
      "transformations",
      validManifest({ transformations: {} }),
      "manifest.transformations",
    ],
  ])(
    "reports invalid array types for %s through SourceManifestError",
    (_label, manifest, path) => {
      try {
        sourceManifest.normalizeManifest(manifest);
        throw new Error("expected normalization to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(sourceManifest.SourceManifestError);
        expect(error.code).toBe("invalid_array");
        expect(error.path).toBe(path);
      }
    },
  );

  test.each([
    ["empty", []],
    ["missing", undefined],
  ])(
    "requires every transformation to reference at least one source (%s)",
    (_label, sourceIds) => {
      const manifest = validManifest();
      if (sourceIds === undefined) delete manifest.transformations[0].sourceIds;
      else manifest.transformations[0].sourceIds = sourceIds;
      expect(() => sourceManifest.normalizeManifest(manifest)).toThrow(
        /(?:empty_array|missing_required_value)/,
      );
    },
  );
});
