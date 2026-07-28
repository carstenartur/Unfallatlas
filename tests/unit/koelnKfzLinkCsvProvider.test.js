"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const traffic = require("../../js/ua.traffic_provider");
const koeln = require("../../scripts/providers/koeln_kfz_link_csv_provider");

const HEADER = [
  "NO",
  "FROMNODENO",
  "TONODENO",
  "LENGTH",
  "K_2016_24H",
  "K_2017_24H",
  "K_2018_24H",
  "K_2019_24H",
  "STR_NAME",
  "R_NO",
  "R_FROMNO~1",
  "R_TONODENO",
  "R_LENGTH",
  "R_K_2016~2",
  "R_K_2017~3",
  "R_K_2018~4",
  "R_K_2019~5",
  "R_STR_NAME",
].join(";");

function csv(...rows) {
  return `${HEADER}\r\n${rows.join("\r\n")}\r\n`;
}

function descriptor(contentHash = "a".repeat(64)) {
  return {
    id: koeln.SOURCE_ID,
    publisher: "Stadt Köln",
    datasetTitle: "Kfz-Zählwerte Köln – richtungsbezogene Strecken 2016–2019",
    datasetUrl: koeln.DATASET_URL,
    distributionUrl: koeln.DISTRIBUTION_URL,
    licenseId: "DL-DE-Zero-2.0",
    licenseName: "Datenlizenz Deutschland – Zero – Version 2.0",
    licenseUrl: "https://www.govdata.de/dl-de/zero-2-0",
    requiredAttribution: "Stadt Köln",
    temporalCoverage: "2016–2019",
    spatialCoverage: "Köln",
    versionOrPublicationDate: "2019",
    retrievedAt: "2026-07-28T20:00:00.000Z",
    contentHash,
    changedOrDerived: true,
    changeNotice:
      "Richtungsbezogene Streckenwerte werden zeilengetreu in typisierte DTVw-Beobachtungen überführt.",
    permissions: {
      permitsRedistribution: true,
      permitsDerivatives: true,
      commercialUseAllowed: true,
    },
    qualityNotes: [
      "Kommunale Knotenstromzählungen an repräsentativen Werktagen.",
    ],
    measurementType: "count",
    modes: ["motor_vehicle"],
    unit: koeln.UNIT,
    priority: 1,
  };
}

describe("Cologne directional Kfz link CSV provider", () => {
  test("turns the published segment 2071 example into two directional 2016 observations", async () => {
    const parsed = koeln.parseObservationsFromCsv(
      csv(
        [
          "2071",
          "16545002",
          "16545007",
          "173",
          "18.504",
          "",
          "",
          "",
          "Aachener Straße",
          "2071",
          "16545007",
          "16545002",
          "173",
          "22.153",
          "",
          "",
          "",
          "Aachener Straße",
        ].join(";"),
      ),
    );

    expect(parsed.delimiter).toBe(";");
    expect(parsed.rowCount).toBe(1);
    expect(parsed.observations).toHaveLength(2);
    expect(parsed.observations.map((item) => item.value)).toEqual([18504, 22153]);
    expect(parsed.observations.map((item) => item.observationId)).toEqual([
      `${koeln.SOURCE_ID}:2071:forward:2016`,
      `${koeln.SOURCE_ID}:2071:reverse:2016`,
    ]);
    expect(parsed.observations[0]).toEqual(
      expect.objectContaining({
        mode: "motor_vehicle",
        measurementType: "count",
        year: 2016,
        unit: "Kfz/24 h",
        wayId: "koeln-segment:2071:forward:16545002->16545007",
      }),
    );
    expect(parsed.observations[1].direction).toContain(
      "16545007 → 16545002; Aachener Straße",
    );

    const provider = traffic.createProvider({
      descriptor: descriptor(),
      canProvide: ({ city }) => city === "Köln",
      loadObservations: () => parsed.observations,
    });
    const normalized = await provider.loadObservations({ city: "Köln" });
    expect(normalized).toHaveLength(2);
    expect(normalized.every((item) => item.sourceId === koeln.SOURCE_ID)).toBe(true);
    expect(normalized.every((item) => item.coordinate === null)).toBe(true);
  });

  test("preserves all available years and quoted delimiters without inventing missing values", () => {
    const parsed = koeln.parseObservationsFromCsv(
      csv(
        [
          "3100",
          "100",
          "101",
          "250",
          "1.000",
          "1.100",
          "",
          "1.300",
          '"Innere Kanalstraße; Nord"',
          "3100",
          "101",
          "100",
          "250",
          "900",
          "",
          "1.050",
          "1.150",
          '"Innere Kanalstraße; Süd"',
        ].join(";"),
      ),
    );

    expect(parsed.observations.map((item) => [item.direction.includes("hin:"), item.year, item.value]))
      .toEqual([
        [true, 2016, 1000],
        [true, 2017, 1100],
        [true, 2019, 1300],
        [false, 2016, 900],
        [false, 2018, 1050],
        [false, 2019, 1150],
      ]);
    expect(parsed.observations.some((item) => item.year === 2017 && item.value === 0))
      .toBe(false);
    expect(parsed.observations[0].direction).toContain("Innere Kanalstraße; Nord");
  });

  test.each([
    ["18.504", 18504],
    ["18,504", 18504],
    ["18504", 18504],
    ["0", 0],
    ["", null],
    ["-", null],
  ])("parses reviewed integer count form %p", (value, expected) => {
    expect(koeln.parseCount(value, "fixture")).toBe(expected);
  });

  test("rejects decimal, negative, malformed and overflowing traffic values", () => {
    for (const value of ["12.5", "-1", "12x", "9".repeat(30)]) {
      expect(() => koeln.parseCount(value, "fixture")).toThrow(/invalid_count/);
    }
  });

  test("fails closed on missing, ambiguous or unknown headers", () => {
    const missing = HEADER.replace("K_2019_24H;", "");
    expect(() => koeln.parseObservationsFromCsv(`${missing}\n${"x;".repeat(17)}x\n`))
      .toThrow(/missing_header/);

    const ambiguous = HEADER.replace("R_FROMNO~1", "R_FROMNO~1;R_FROMNO_1");
    expect(() => koeln.parseObservationsFromCsv(`${ambiguous}\n${"x;".repeat(18)}x\n`))
      .toThrow(/ambiguous_header/);

    expect(() => koeln.parseObservationsFromCsv(`${HEADER};UNREVIEWED\n${"x;".repeat(18)}x\n`))
      .toThrow(/unknown_header/);
  });

  test("rejects duplicate source rows that would overwrite stable evidence identities", () => {
    const row = [
      "2071", "16545002", "16545007", "173", "18.504", "", "", "",
      "Aachener Straße", "2071", "16545007", "16545002", "173", "", "", "", "",
      "Aachener Straße",
    ].join(";");
    expect(() => koeln.parseObservationsFromCsv(csv(row, row)))
      .toThrow(/duplicate_observation/);
  });

  test("requires the reviewed link distribution hash and a confined regular file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-koeln-kfz-"));
    try {
      fs.writeFileSync(
        path.join(root, "fixture.csv"),
        csv(
          [
            "2071", "16545002", "16545007", "173", "18.504", "", "", "",
            "Aachener Straße", "2071", "16545007", "16545002", "173", "", "", "", "",
            "Aachener Straße",
          ].join(";"),
        ),
      );
      const bytes = fs.statSync(path.join(root, "fixture.csv")).size;

      expect(() =>
        koeln.loadVerifiedDistribution({
          allowedRoot: root,
          csvPath: "fixture.csv",
          expectedDistributionSha256: koeln.sha256Buffer(
            fs.readFileSync(path.join(root, "fixture.csv")),
          ),
          expectedBytes: bytes,
        }),
      ).toThrow(/unreviewed_distribution/);

      expect(() =>
        koeln.loadVerifiedDistribution({
          allowedRoot: root,
          csvPath: "../fixture.csv",
          expectedDistributionSha256: koeln.REVIEWED_DISTRIBUTION_SHA256,
          expectedBytes: bytes,
        }),
      ).toThrow(/unsafe_path/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("declares the correct link distribution rather than the coordinate-only node CSV", () => {
    expect(koeln.DISTRIBUTION_URL).toMatch(/KFZ_Zaehldaten_2016-2019_link\.csv$/);
    expect(koeln.DISTRIBUTION_URL).not.toMatch(/_node\.csv$/);
    expect(koeln.REVIEWED_DISTRIBUTION_SHA256).toBe(
      "477da6900ee791b7b3db433e27d6bde778c2f138869198b448fb26827de65488",
    );
  });
});
