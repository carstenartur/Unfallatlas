"use strict";

const crypto = require("crypto");
const sourceManifest = require("../../js/ua.source_manifest");
const provenance = require("../../js/ua.artifact_provenance");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function accidentSource() {
  return {
    sourceId: "accidents.de.unfallatlas",
    role: "accidents",
    publisher: "Statistische Ämter des Bundes und der Länder",
    datasetTitle: "Unfallatlas – Straßenverkehrsunfälle mit Personenschaden",
    datasetUrl: "https://unfallatlas.statistikportal.de/",
    licenseId: "DL-DE-BY-2.0",
    licenseName: "Datenlizenz Deutschland – Namensnennung – Version 2.0",
    licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
    requiredAttribution:
      "© Statistische Ämter des Bundes und der Länder, Unfallatlas",
    retrievedAt: "2026-07-21T12:00:00Z",
    changedOrDerived: true,
    changeNotice: "Auf Stadt, Auswahl und Filter eingeschränkt.",
  };
}

function osmSource() {
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
    changeNotice: "Straßengeometrien und Tags räumlich gefiltert.",
  };
}

function manifest(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactId: "bonn-export-2026-07-21",
    generatedAt: "2026-07-21T12:05:00Z",
    applicationVersion: "2.1.4",
    buildFingerprint: HASH_A,
    dataFingerprint: HASH_B,
    scenario: {
      city: "Bonn",
      bounds: { south: 50.73, west: 7.09, north: 50.74, east: 7.1 },
      filters: {
        involvementMode: "and",
        includeCyclist: true,
        includeCar: true,
      },
      years: [2022, 2023, 2024],
    },
    sources: [osmSource(), accidentSource()],
    transformations: [
      {
        transformationId: "transform.accident-filter",
        label: "Unfallauswahl",
        description: "Filtert die Unfallmenge für den gewählten Bereich.",
        sourceIds: ["accidents.de.unfallatlas"],
        outputFields: ["features", "counts"],
      },
    ],
    ...overrides,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("artifact provenance format adapters", () => {
  test("publishes one browser and Node API backed by SourceManifest", () => {
    expect(window.UA.sourceManifest).toBe(sourceManifest);
    expect(window.UA.artifactProvenance).toBe(provenance);
    expect(provenance.SOURCE_IDS_PROPERTY).toBe("unfallatlas:sourceIds");
  });

  test("hashes canonical normalized manifest JSON deterministically", async () => {
    const first = await provenance.normalizeAndHash(manifest());
    const second = await provenance.normalizeAndHash(
      manifest({
        sources: [accidentSource(), osmSource()],
      }),
    );

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.sha256).toBe(second.sha256);
    expect(first.sha256).toBe(sha256(first.canonicalJson));
    expect(JSON.parse(first.prettyJson)).toEqual(first.manifest);
    expect(Object.isFrozen(first.manifest)).toBe(true);
  });

  test("creates CSV ZIP entries with CSV, full sources JSON and linked README", async () => {
    const result = await provenance.buildCsvPackageEntries({
      baseName: "Bonn Hbf / Rad + Pkw",
      csv: "id;year;severity\n1;2024;2\n",
      manifest: manifest(),
      title: "Unfallwerkbank-Datenexport Bonn Hbf",
    });

    expect(result.packageMediaType).toBe("application/zip");
    expect(result.baseName).toBe("Bonn-Hbf-Rad-Pkw");
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "Bonn-Hbf-Rad-Pkw.csv",
      "sources.json",
      "README.txt",
    ]);
    expect(result.entries[0].content).toContain("1;2024;2");
    const sources = JSON.parse(result.entries[1].content);
    expect(sources.sources.map((source) => source.sourceId)).toEqual([
      "accidents.de.unfallatlas",
      "roads.openstreetmap",
    ]);
    expect(result.entries[2].content).toContain(
      `SourceManifest SHA-256: ${result.sourceManifestSha256}`,
    );
    expect(result.entries[2].content).toContain(
      "https://unfallatlas.statistikportal.de/",
    );
    expect(result.entries[2].content).toContain(
      "https://www.govdata.de/dl-de/by-2-0",
    );
    expect(result.entries[2].content).toContain("sources.json");
    expect(result.entries[2].content).not.toContain("undefined");
  });

  test("rejects empty CSV content and unsafe/empty package names", async () => {
    await expect(
      provenance.buildCsvPackageEntries({
        baseName: "valid",
        csv: "",
        manifest: manifest(),
      }),
    ).rejects.toThrow(/csv must be a non-empty string/);
    await expect(
      provenance.buildCsvPackageEntries({
        baseName: "..",
        csv: "x\n",
        manifest: manifest(),
      }),
    ).rejects.toThrow(/invalid_filename/);
  });

  test("embeds the complete manifest and source IDs in GeoJSON", async () => {
    const input = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {
            id: 1,
            "unfallatlas:sourceIds": ["accidents.de.unfallatlas"],
          },
          geometry: { type: "Point", coordinates: [7.095, 50.735] },
        },
        {
          type: "Feature",
          properties: { id: 2 },
          geometry: { type: "Point", coordinates: [7.096, 50.736] },
        },
      ],
    };
    const result = await provenance.attachGeoJsonProvenance(input, manifest());

    expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.geojson.metadata.sourceManifest.sources).toHaveLength(2);
    expect(result.geojson.metadata["unfallatlas:sourceManifestSha256"]).toBe(
      result.sourceManifestSha256,
    );
    expect(
      result.geojson.features[0].properties["unfallatlas:sourceIds"],
    ).toEqual(["accidents.de.unfallatlas"]);
    expect(
      result.geojson.features[1].properties["unfallatlas:sourceIds"],
    ).toEqual(["accidents.de.unfallatlas", "roads.openstreetmap"]);
    expect(input).not.toHaveProperty("metadata");
    expect(input.features[1].properties).not.toHaveProperty(
      "unfallatlas:sourceIds",
    );
  });

  test("fails closed on unknown feature Source-IDs or duplicate metadata", async () => {
    const unknown = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { "unfallatlas:sourceIds": ["invented.source"] },
          geometry: null,
        },
      ],
    };
    await expect(
      provenance.attachGeoJsonProvenance(unknown, manifest()),
    ).rejects.toThrow(/unknown_source_id/);

    const duplicate = {
      type: "FeatureCollection",
      metadata: { sourceManifest: {} },
      features: [],
    };
    await expect(
      provenance.attachGeoJsonProvenance(duplicate, manifest()),
    ).rejects.toThrow(/existing_provenance/);
  });

  test("rejects non-FeatureCollection or malformed Feature entries", async () => {
    await expect(
      provenance.attachGeoJsonProvenance({ type: "Feature" }, manifest()),
    ).rejects.toThrow(/invalid_geojson/);
    await expect(
      provenance.attachGeoJsonProvenance(
        {
          type: "FeatureCollection",
          features: [{}],
        },
        manifest(),
      ),
    ).rejects.toThrow(/invalid_geojson/);
  });

  test("builds deterministic KML ExtendedData with full linked provenance", async () => {
    const result = await provenance.buildKmlExtendedData(manifest());
    expect(result.xml).toMatch(/^<ExtendedData>/);
    expect(result.xml).toContain("unfallatlas:sourceManifestSha256");
    expect(result.xml).toContain(
      "accidents.de.unfallatlas,roads.openstreetmap",
    );
    expect(result.xml).toContain("https://unfallatlas.statistikportal.de/");
    expect(result.xml).toContain(
      "https://opendatacommons.org/licenses/odbl/1-0/",
    );
    expect(result.xml).toContain("&quot;applicationVersion&quot;");
    expect(result.xml).not.toContain("undefined");
    expect(result.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("injects KML provenance exactly once into Document", async () => {
    const original =
      '<?xml version="1.0"?><kml><Document><name>Bonn &amp; Hbf</name></Document></kml>';
    const first = await provenance.injectKmlProvenance(original, manifest());
    expect(first.kml).toMatch(/<Document><ExtendedData>/);
    expect(first.kml).toContain("<name>Bonn &amp; Hbf</name>");
    await expect(
      provenance.injectKmlProvenance(first.kml, manifest()),
    ).rejects.toThrow(/existing_provenance/);
    await expect(
      provenance.injectKmlProvenance("<kml/>", manifest()),
    ).rejects.toThrow(/invalid_kml/);
  });

  test("creates a complete artifact-bound sidecar with artifact and manifest hashes", async () => {
    const artifact = Buffer.from("binary artifact fixture");
    const result = await provenance.buildSidecar({
      artifactName: "map.png",
      artifactMediaType: "image/png",
      artifactBytes: artifact,
      manifest: manifest(),
    });

    expect(result.sidecar.schemaVersion).toBe(1);
    expect(result.sidecar.artifact).toEqual({
      name: "map.png",
      mediaType: "image/png",
      bytes: artifact.length,
      sha256: sha256(artifact),
    });
    expect(result.sidecar.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sidecar.sourceManifest.sources).toHaveLength(2);
    expect(result.sidecar.visibleSourceNotice).toContain("Unfallatlas");
    expect(result.sidecar.visibleSourceNotice).toContain("DL-DE-BY-2.0");
    expect(result.sidecar.visibleSourceNotice).not.toContain("undefined");
    expect(result.sha256).toBe(sha256(result.json));
  });

  test("accepts a precomputed artifact hash but rejects malformed hashes", async () => {
    const result = await provenance.buildSidecar({
      artifactName: "data.geojson",
      artifactMediaType: "application/geo+json",
      artifactSha256: HASH_A,
      manifest: manifest(),
    });
    expect(result.sidecar.artifact.sha256).toBe(HASH_A);
    expect(result.sidecar.artifact).not.toHaveProperty("bytes");

    await expect(
      provenance.buildSidecar({
        artifactName: "data.geojson",
        artifactMediaType: "application/geo+json",
        artifactSha256: "abc",
        manifest: manifest(),
      }),
    ).rejects.toThrow(/invalid_artifact_hash/);
  });

  test("creates media sidecar naming and a visible compact source notice", async () => {
    const result = await provenance.buildMediaProvenance({
      artifactName: "analysis.webp",
      artifactMediaType: "image/webp",
      artifactBytes: Buffer.from("webp fixture"),
      manifest: manifest(),
      noticeOptions: { maxCharacters: 180 },
    });

    expect(result.sidecarFileName).toBe("analysis.webp.sources.json");
    expect(result.visibleNotice.length).toBeLessThanOrEqual(180);
    expect(result.visibleNotice).toMatch(/^Quellen:/);
    expect(result.visibleNotice).not.toContain("undefined");
    expect(JSON.parse(result.sidecarJson).artifact.name).toBe("analysis.webp");
    expect(result.sidecarSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("shortens visible notices without dropping the full sidecar", () => {
    const notice = provenance.compactSourceNotice(manifest(), {
      maxCharacters: 100,
    });
    expect(notice.length).toBeLessThanOrEqual(100);
    expect(notice).toContain("Sidecar");
    expect(notice).not.toContain("undefined");
    const lines = provenance.visibleSourceLines(manifest(), { maxSources: 1 });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/Weitere 1 Quelle/);
  });

  test("escapes hostile XML content in KML provenance", async () => {
    const hostile = manifest({
      sources: [
        {
          ...accidentSource(),
          publisher: 'A < B & "C"',
          requiredAttribution: "O'Reilly & Partner",
        },
      ],
      transformations: [],
    });
    const result = await provenance.buildKmlExtendedData(hostile);
    expect(result.xml).toContain("A &lt; B &amp; &quot;C&quot;");
    expect(result.xml).toContain("O&apos;Reilly &amp; Partner");
    expect(result.xml).not.toContain("A < B");
  });

  test("does not accept format-specific source IDs that are absent from SourceManifest", async () => {
    await expect(
      provenance.attachGeoJsonProvenance(
        {
          type: "FeatureCollection",
          features: [],
        },
        manifest(),
        { defaultSourceIds: ["format.local.source"] },
      ),
    ).rejects.toThrow(/unknown_source_id/);
  });

  test.each([".geojson", "trailing."])(
    "rejects unsafe package base name %s",
    async (baseName) => {
      await expect(
        provenance.buildCsvPackageEntries({
          baseName,
          csv: "x\n",
          manifest: manifest(),
        }),
      ).rejects.toThrow(/invalid_filename/);
    },
  );

  test("exposes licence policies by the canonical IDs emitted in manifests", () => {
    const normalized = sourceManifest.normalizeManifest(manifest());
    for (const source of normalized.sources) {
      expect(sourceManifest.LICENSE_POLICIES_BY_ID[source.licenseId]).toEqual(
        expect.objectContaining({ id: source.licenseId }),
      );
    }
  });

  test.each([
    [
      "array properties",
      {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: [], geometry: null }],
      },
    ],
    [
      "scalar properties",
      {
        type: "FeatureCollection",
        features: [{ type: "Feature", properties: "invalid", geometry: null }],
      },
    ],
    [
      "array metadata",
      {
        type: "FeatureCollection",
        metadata: [],
        features: [],
      },
    ],
    [
      "scalar metadata",
      {
        type: "FeatureCollection",
        metadata: "invalid",
        features: [],
      },
    ],
  ])("rejects non-object GeoJSON %s", async (_label, input) => {
    await expect(
      provenance.attachGeoJsonProvenance(input, manifest()),
    ).rejects.toThrow(/invalid_geojson/);
  });

  test("accepts null GeoJSON properties and metadata as empty objects", async () => {
    const result = await provenance.attachGeoJsonProvenance(
      {
        type: "FeatureCollection",
        metadata: null,
        features: [{ type: "Feature", properties: null, geometry: null }],
      },
      manifest(),
    );
    expect(result.geojson.metadata.sourceManifest).toBeDefined();
    expect(
      result.geojson.features[0].properties["unfallatlas:sourceIds"],
    ).toHaveLength(2);
  });
});
