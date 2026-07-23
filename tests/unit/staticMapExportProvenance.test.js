"use strict";

const crypto = require("crypto");
const sourceManifest = require("../../js/ua.source_manifest");
const artifactProvenance = require("../../js/ua.artifact_provenance");
const staticMap = require("../../js/ua.static_map_export_provenance");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n+0AAAAASUVORK5CYII=";
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function manifest(overrides = {}) {
  return {
    schemaVersion: sourceManifest.SCHEMA_VERSION,
    artifactId: "bonn-rad-pkw-karte",
    generatedAt: "2026-07-23T06:00:00Z",
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
    sources: [
      {
        sourceId: "accidents.de.unfallatlas",
        role: "accidents",
        publisher: "Statistische Ämter des Bundes und der Länder",
        datasetTitle: "Unfallatlas – Straßenverkehrsunfälle mit Personenschaden",
        datasetUrl: "https://www.statistikportal.de/de/karten/unfallatlas",
        distributionUrl: "https://unfallatlas.statistikportal.de/",
        licenseId: "DL-DE-BY-2.0",
        licenseName: "Datenlizenz Deutschland – Namensnennung – Version 2.0",
        licenseUrl: "https://www.govdata.de/dl-de/by-2-0",
        requiredAttribution:
          "© Statistische Ämter des Bundes und der Länder, Unfallatlas",
        temporalCoverage: "2022–2024",
        spatialCoverage: "Bonn",
        retrievedAt: "2026-07-23T05:55:00Z",
        changedOrDerived: true,
        changeNotice: "Räumlich und nach den gewählten Filtern ausgewählt.",
      },
    ],
    transformations: [
      {
        transformationId: "filter-export-selection",
        label: "Gefilterte Kartenauswahl",
        description: "Filtert die Unfallmenge für den gewählten Kartenbereich.",
        sourceIds: ["accidents.de.unfallatlas"],
        outputFields: ["map", "accidentPoints"],
      },
    ],
    ...overrides,
  };
}

function fakeRenderedPng({ visibleNotice, sourceManifestSha256 }) {
  return Promise.resolve({
    bytes: PNG_BYTES,
    visibleNotice,
    sourceManifestSha256,
    width: 640,
    height: 420,
    sourceHeight: 360,
    stripHeight: 60,
  });
}

describe("provenance-bound static PNG export", () => {
  test("publishes the same API in Node and the browser namespace", () => {
    expect(window.UA.staticMapExportProvenance).toBe(staticMap);
    expect(staticMap.PNG_MEDIA_TYPE).toBe("image/png");
    expect(staticMap.PACKAGE_MEDIA_TYPE).toBe("application/zip");
  });

  test("packages only the final PNG, its exact sidecar and a linked README", async () => {
    const result = await staticMap.buildPngPackage({
      manifest: manifest(),
      sourceDataUrl: PNG_DATA_URL,
      artifactName: "Bonn Hbf – Rad + Pkw.png",
      renderPng: fakeRenderedPng,
    });

    expect(result.packageFileName).toBe("Bonn-Hbf-Rad-Pkw.zip");
    expect(result.packageMediaType).toBe("application/zip");
    expect(Array.from(result.archive.slice(0, 2))).toEqual([0x50, 0x4b]);
    expect(result.entries.map((entry) => entry.name)).toEqual([
      "Bonn-Hbf-Rad-Pkw.png",
      "Bonn-Hbf-Rad-Pkw.png.sources.json",
      "README.txt",
    ]);

    const sidecar = JSON.parse(result.entries[1].content);
    expect(sidecar.artifact).toEqual({
      name: "Bonn-Hbf-Rad-Pkw.png",
      mediaType: "image/png",
      bytes: PNG_BYTES.length,
      sha256: sha256(PNG_BYTES),
    });
    expect(sidecar.sourceManifestSha256).toBe(result.sourceManifestSha256);
    expect(sidecar.sourceManifest.sources[0].datasetUrl).toBe(
      "https://www.statistikportal.de/de/karten/unfallatlas",
    );
    expect(sidecar.visibleSourceNotice).toBe(result.visibleNotice);
    expect(result.entries[2].content).toContain(`PNG SHA-256: ${sha256(PNG_BYTES)}`);
    expect(result.entries[2].content).toContain(
      `SourceManifest SHA-256: ${result.sourceManifestSha256}`,
    );
    expect(result.entries[2].content).toContain(`Sidecar SHA-256: ${result.sidecarSha256}`);
    expect(result.entries[2].content).toContain(
      "https://www.govdata.de/dl-de/by-2-0",
    );
    expect(result.archiveSha256).toBe(await artifactProvenance.sha256(result.archive));
  });

  test("rejects a renderer that does not return a real PNG", async () => {
    await expect(
      staticMap.buildPngPackage({
        manifest: manifest(),
        sourceDataUrl: PNG_DATA_URL,
        renderPng: async () => ({ bytes: Buffer.from("not a png") }),
      }),
    ).rejects.toMatchObject({ code: "invalid_png" });
  });

  test("rejects a renderer whose visible notice differs from the sidecar", async () => {
    await expect(
      staticMap.buildPngPackage({
        manifest: manifest(),
        sourceDataUrl: PNG_DATA_URL,
        renderPng: async ({ sourceManifestSha256 }) => ({
          bytes: PNG_BYTES,
          visibleNotice: "invented notice",
          sourceManifestSha256,
        }),
      }),
    ).rejects.toMatchObject({ code: "notice_mismatch" });
  });

  test("renders a source strip below the map and verifies its witness pixels", async () => {
    const calls = [];
    const context = {
      font: "",
      fillStyle: "",
      textBaseline: "",
      measureText: (text) => ({ width: String(text).length * 7 }),
      drawImage: (...args) => calls.push(["drawImage", ...args]),
      fillRect: (...args) => calls.push(["fillRect", ...args]),
      fillText: (...args) => calls.push(["fillText", ...args]),
      getImageData: (_x, y) => ({
        data: y === 360
          ? new Uint8ClampedArray([31, 41, 55, 255])
          : new Uint8ClampedArray([255, 255, 255, 255]),
      }),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => PNG_DATA_URL,
    };
    const root = {
      atob: (value) => Buffer.from(value, "base64").toString("binary"),
    };

    const result = await staticMap.renderPngWithSourceStrip({
      sourceDataUrl: PNG_DATA_URL,
      visibleNotice: "Quellen: Unfallatlas – DL-DE-BY-2.0",
      sourceManifestSha256: HASH_A,
      root,
      loadImage: async () => ({ naturalWidth: 640, naturalHeight: 360 }),
      canvasFactory: () => canvas,
    });

    expect(result.width).toBe(640);
    expect(result.sourceHeight).toBe(360);
    expect(result.height).toBeGreaterThan(360);
    expect(canvas.height).toBe(result.height);
    expect(calls.some((call) => call[0] === "drawImage")).toBe(true);
    expect(
      calls.some(
        (call) => call[0] === "fillText" && String(call[1]).includes("SourceManifest"),
      ),
    ).toBe(true);
    expect(Buffer.from(result.bytes)).toEqual(PNG_BYTES);
  });

  test("captures one stable manifest snapshot before packaging", async () => {
    const currentManifest = manifest();
    const createManifest = jest.fn(async () => currentManifest);
    const captureExportMapImage = jest.fn(async () => PNG_DATA_URL);
    const ctx = { CITY_RAW: "Bonn" };
    const UA = {
      captureExportMapImage,
      exportProvenanceRuntime: { createManifest },
      getRuntimeContext: () => ctx,
    };
    const root = { document: { getElementById: () => null } };

    const result = await staticMap.exportCurrentMap(UA, root, null, {
      download: false,
      renderPng: fakeRenderedPng,
    });

    expect(createManifest).toHaveBeenCalledTimes(2);
    expect(captureExportMapImage).toHaveBeenCalledWith(ctx, {
      heatmapExportOpacity: 0.4,
    });
    expect(result.manifest).toEqual(sourceManifest.normalizeManifest(currentManifest));
    expect(result.artifactName).toBe("bonn-rad-pkw-karte-karte.png");
  });

  test("fails closed when map state changes during capture", async () => {
    const first = manifest();
    const second = manifest({
      scenario: {
        ...manifest().scenario,
        filters: { involvementMode: "or", includeCyclist: true },
      },
    });
    const createManifest = jest
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    const UA = {
      captureExportMapImage: jest.fn(async () => PNG_DATA_URL),
      exportProvenanceRuntime: { createManifest },
    };

    await expect(
      staticMap.exportCurrentMap(
        UA,
        { document: { getElementById: () => null } },
        { CITY_RAW: "Bonn" },
        { download: false, renderPng: fakeRenderedPng },
      ),
    ).rejects.toMatchObject({ code: "state_changed_during_capture" });
  });

  test("validates data URLs, PNG signatures and safe filenames", () => {
    expect(staticMap.pngBytesFromDataUrl(PNG_DATA_URL)).toEqual(
      new Uint8Array(PNG_BYTES),
    );
    expect(staticMap.safeArtifactName("Bonn / Zentrum.png")).toBe(
      "Bonn-Zentrum.png",
    );
    expect(() => staticMap.pngBytesFromDataUrl("data:image/jpeg;base64,abc"))
      .toThrow(/invalid_data_url/);
    expect(() => staticMap.validatePngBytes(Buffer.from("invalid")))
      .toThrow(/invalid_png/);
    expect(() => staticMap.safeArtifactName(".."))
      .toThrow(/invalid_filename/);
  });
});
