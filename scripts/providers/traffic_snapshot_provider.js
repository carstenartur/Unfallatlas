#!/usr/bin/env node
"use strict";

/**
 * Fail-closed adapter for licensed traffic-count snapshots.
 *
 * The adapter deliberately does not fetch arbitrary live URLs. A source must be
 * present in the reviewed catalog, the downloaded distribution and the local
 * normalized snapshot must both be SHA-256 pinned, and every observation is
 * revalidated by the shared traffic-provider contract before it can enter the
 * enrichment pipeline.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const traffic = require("../../js/ua.traffic_provider");

const SNAPSHOT_SCHEMA_VERSION = 1;
const REGISTRY_SCHEMA_VERSION = 1;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const RETIRED_SOURCE_CATALOG = Object.freeze({
  "traffic.count.koeln-kfz-2010-2019": Object.freeze({
    reasonCode: "coordinate_only_distribution",
    publisher: "Stadt Köln",
    datasetTitle: "KFZ Zählstellen und Werte Köln",
    retiredDistributionUrl:
      "https://offenedaten-koeln.de/sites/default/files/KFZ_Zaheldaten_2016-2019_node.csv",
    replacementSourceId: "traffic.count.koeln-kfz-links-2016-2019",
    replacementDistributionUrl:
      "https://offenedaten-koeln.de/sites/default/files/KFZ_Zaehldaten_2016-2019_link.csv",
    explanation:
      "Die bisher katalogisierte Knotendatei enthält Kennungen und Koordinaten, aber keine richtungsbezogenen Kfz-Zählwerte. Numerische Beobachtungen müssen mit dem geprüften Link-CSV-Parser erzeugt werden.",
  }),
});

const OPEN_DATA_SOURCE_CATALOG = Object.freeze({
  "traffic.model.berlin-dtvw-2023": Object.freeze({
    descriptor: Object.freeze({
      id: "traffic.model.berlin-dtvw-2023",
      publisher:
        "Senatsverwaltung für Mobilität, Verkehr, Klimaschutz und Umwelt Berlin",
      datasetTitle: "Verkehrsmengen DTVw 2023 - WFS",
      datasetUrl:
        "https://daten.berlin.de/datensaetze/verkehrsmengen-dtvw-2023-wfs-9fc4ea36",
      distributionUrl: "https://gdi.berlin.de/services/wfs/verkehrsmengen_2023",
      licenseId: "DL-DE-Zero-2.0",
      licenseName: "Datenlizenz Deutschland – Zero – Version 2.0",
      licenseUrl: "https://www.govdata.de/dl-de/zero-2-0",
      temporalCoverage: "2023",
      spatialCoverage: "Berlin",
      versionOrPublicationDate: "2024-12-06",
      changedOrDerived: true,
      changeNotice:
        "WFS-Features werden auf das typisierte Verkehrsmodell-Schema abgebildet; Originalwerte, Einheit und Segmentgeometrie bleiben erhalten.",
      permissions: Object.freeze({
        permitsRedistribution: true,
        permitsDerivatives: true,
        commercialUseAllowed: true,
      }),
      qualityNotes: Object.freeze([
        "Ausgeglichene durchschnittliche werktägliche Verkehrsstärke; als Modellwert und nicht als Einzelmessung gekennzeichnet.",
      ]),
      measurementType: "model",
      modes: Object.freeze(["motor_vehicle"]),
      unit: "Kfz/24 h",
      priority: 2,
    }),
    coverage: Object.freeze({
      city: "Berlin",
      aliases: Object.freeze(["Berlin"]),
      fromYear: 2023,
      toYear: 2023,
      modes: Object.freeze(["motor_vehicle"]),
    }),
  }),
  "traffic.count.berlin-bicycle-hourly-2012-2025": Object.freeze({
    descriptor: Object.freeze({
      id: "traffic.count.berlin-bicycle-hourly-2012-2025",
      publisher:
        "Senatsverwaltung für Mobilität, Verkehr, Klimaschutz und Umwelt Berlin",
      datasetTitle: "Radzähldaten in Berlin",
      datasetUrl: "https://daten.berlin.de/datensaetze/radzahldaten-in-berlin",
      distributionUrl:
        "https://www.berlin.de/sen/uvk/_assets/verkehr/verkehrsplanung/radverkehr/weitere-radinfrastruktur/zaehlstellen-und-fahrradbarometer/gesamtdatei-stundenwerte.xlsx?ts=1737968619",
      licenseId: "DL-DE-Zero-2.0",
      licenseName: "Datenlizenz Deutschland – Zero – Version 2.0",
      licenseUrl: "https://www.govdata.de/dl-de/zero-2-0",
      requiredAttribution: "Radzähldaten in Berlin",
      temporalCoverage: "2012–2025",
      spatialCoverage: "Berlin",
      versionOrPublicationDate: "2026-03-26",
      changedOrDerived: true,
      changeNotice:
        "Geprüfte Stundenwerte werden in einzelne typisierte Zählbeobachtungen mit unverändertem Zeitraum überführt.",
      permissions: Object.freeze({
        permitsRedistribution: true,
        permitsDerivatives: true,
        commercialUseAllowed: true,
      }),
      qualityNotes: Object.freeze([
        "Automatische Dauerzählstellen; Stundenintervall und Zählstellenrichtung bleiben je Beobachtung erhalten.",
      ]),
      measurementType: "count",
      modes: Object.freeze(["bicycle"]),
      unit: "Fahrräder/Stunde",
      priority: 1,
    }),
    coverage: Object.freeze({
      city: "Berlin",
      aliases: Object.freeze(["Berlin"]),
      fromYear: 2012,
      toYear: 2025,
      modes: Object.freeze(["bicycle"]),
    }),
  }),
});

class TrafficSnapshotError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = "TrafficSnapshotError";
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new TrafficSnapshotError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, required, optional, label) {
  if (!isPlainObject(value)) fail("invalid_object", `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional].sort();
  const unknown = actual.filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !actual.includes(key));
  if (unknown.length || missing.length) {
    fail("invalid_fields", `${label} has invalid fields`, { unknown, missing });
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail("invalid_value", `${label} must be a non-empty string`);
  }
  return value.trim();
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function assertHash(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    fail("invalid_hash", `${label} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function normalizeUrl(value, label) {
  const text = requiredString(value, label);
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    fail("invalid_url", `${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") fail("unsafe_url", `${label} must use https`);
  parsed.hash = "";
  return parsed.toString();
}

function normalizeCity(value) {
  return requiredString(value, "city")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function resolveConfinedFile(allowedRoot, candidate) {
  const root = fs.realpathSync(requiredString(allowedRoot, "allowedRoot"));
  const target = fs.realpathSync(
    path.resolve(root, requiredString(candidate, "snapshotPath")),
  );
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    fail("unsafe_snapshot_path", "snapshot path escapes the allowed root", {
      root,
      target,
    });
  }
  if (!fs.statSync(target).isFile()) {
    fail("invalid_snapshot_path", "snapshot path is not a file");
  }
  return target;
}

function sourceEntry(sourceId) {
  const id = requiredString(sourceId, "sourceId");
  const retired = RETIRED_SOURCE_CATALOG[id];
  if (retired) {
    fail(
      "retired_source",
      `source ${id} was retired because its distribution contains no numeric traffic counts`,
      retired,
    );
  }
  const entry = OPEN_DATA_SOURCE_CATALOG[id];
  if (!entry) fail("unknown_source", `source ${id} is not in the reviewed catalog`);
  return entry;
}

function normalizeCoverage(value, catalogCoverage) {
  assertExactKeys(
    value,
    ["city", "fromYear", "toYear", "modes"],
    [],
    "snapshot.coverage",
  );
  const city = requiredString(value.city, "snapshot.coverage.city");
  if (normalizeCity(city) !== normalizeCity(catalogCoverage.city)) {
    fail("coverage_mismatch", "snapshot city does not match the catalog source");
  }
  const fromYear = Number(value.fromYear);
  const toYear = Number(value.toYear);
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) {
    fail("invalid_coverage", "snapshot coverage years are invalid");
  }
  if (fromYear < catalogCoverage.fromYear || toYear > catalogCoverage.toYear) {
    fail("coverage_expansion", "snapshot coverage exceeds reviewed source coverage");
  }
  if (!Array.isArray(value.modes) || value.modes.length === 0) {
    fail("invalid_coverage", "snapshot coverage modes must be non-empty");
  }
  const modes = [
    ...new Set(
      value.modes.map((mode) =>
        requiredString(mode, "snapshot.coverage.modes"),
      ),
    ),
  ].sort();
  const invalidModes = modes.filter(
    (mode) => !catalogCoverage.modes.includes(mode),
  );
  if (invalidModes.length) {
    fail(
      "coverage_expansion",
      "snapshot declares modes outside reviewed source coverage",
      invalidModes,
    );
  }
  return Object.freeze({
    city,
    fromYear,
    toYear,
    modes: Object.freeze(modes),
  });
}

function normalizeDistribution(value, entry) {
  assertExactKeys(
    value,
    ["url", "sha256", "bytes", "mediaType"],
    ["versionOrPublicationDate"],
    "snapshot.distribution",
  );
  const url = normalizeUrl(value.url, "snapshot.distribution.url");
  const expectedUrl = normalizeUrl(
    entry.descriptor.distributionUrl,
    "catalog.distributionUrl",
  );
  if (url !== expectedUrl) {
    fail(
      "distribution_mismatch",
      "snapshot distribution URL does not match the reviewed catalog",
      { expected: expectedUrl, actual: url },
    );
  }
  const bytes = Number(value.bytes);
  if (!Number.isInteger(bytes) || bytes <= 0) {
    fail(
      "invalid_distribution",
      "snapshot.distribution.bytes must be a positive integer",
    );
  }
  const versionOrPublicationDate =
    value.versionOrPublicationDate == null
      ? entry.descriptor.versionOrPublicationDate
      : requiredString(
          value.versionOrPublicationDate,
          "snapshot.distribution.versionOrPublicationDate",
        );
  return Object.freeze({
    url,
    sha256: assertHash(value.sha256, "snapshot.distribution.sha256"),
    bytes,
    mediaType: requiredString(
      value.mediaType,
      "snapshot.distribution.mediaType",
    ),
    ...(versionOrPublicationDate ? { versionOrPublicationDate } : {}),
  });
}

function validateObservationCoverage(observations, coverage) {
  if (!Array.isArray(observations) || observations.length === 0) {
    fail("empty_snapshot", "snapshot.observations must be a non-empty array");
  }
  observations.forEach((observation, index) => {
    if (!isPlainObject(observation)) {
      fail(
        "invalid_observation",
        `snapshot.observations[${index}] must be an object`,
      );
    }
    const year = Number(observation.year);
    if (
      !Number.isInteger(year) ||
      year < coverage.fromYear ||
      year > coverage.toYear
    ) {
      fail(
        "observation_outside_coverage",
        `observation ${index} year is outside snapshot coverage`,
      );
    }
    if (!coverage.modes.includes(observation.mode)) {
      fail(
        "observation_outside_coverage",
        `observation ${index} mode is outside snapshot coverage`,
      );
    }
  });
}

function parseSnapshot(buffer, entry, expectedSourceId) {
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    fail("invalid_json", "snapshot is not valid UTF-8 JSON", {
      message: error.message,
    });
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "snapshotId",
      "sourceId",
      "retrievedAt",
      "distribution",
      "coverage",
      "observations",
    ],
    [],
    "snapshot",
  );
  if (Number(value.schemaVersion) !== SNAPSHOT_SCHEMA_VERSION) {
    fail(
      "unsupported_schema",
      `snapshot.schemaVersion must be ${SNAPSHOT_SCHEMA_VERSION}`,
    );
  }
  const sourceId = requiredString(value.sourceId, "snapshot.sourceId");
  if (sourceId !== expectedSourceId) {
    fail("source_mismatch", "snapshot source does not match registration", {
      expected: expectedSourceId,
      actual: sourceId,
    });
  }
  const coverage = normalizeCoverage(value.coverage, entry.coverage);
  const distribution = normalizeDistribution(value.distribution, entry);
  validateObservationCoverage(value.observations, coverage);
  return Object.freeze({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    snapshotId: requiredString(value.snapshotId, "snapshot.snapshotId"),
    sourceId,
    retrievedAt: requiredString(value.retrievedAt, "snapshot.retrievedAt"),
    distribution,
    coverage,
    observations: Object.freeze(
      value.observations.map((observation) =>
        Object.freeze({ ...observation }),
      ),
    ),
  });
}

function loadVerifiedSnapshot(options) {
  const opts = options || {};
  const entry = sourceEntry(opts.sourceId);
  const file = resolveConfinedFile(opts.allowedRoot, opts.snapshotPath);
  const buffer = fs.readFileSync(file);
  const actualSnapshotSha256 = sha256Buffer(buffer);
  const expectedSnapshotSha256 = assertHash(
    opts.expectedSnapshotSha256,
    "expectedSnapshotSha256",
  );
  if (actualSnapshotSha256 !== expectedSnapshotSha256) {
    fail(
      "snapshot_hash_mismatch",
      "normalized snapshot SHA-256 does not match its registry pin",
      { expected: expectedSnapshotSha256, actual: actualSnapshotSha256 },
    );
  }
  return Object.freeze({
    file,
    snapshotSha256: actualSnapshotSha256,
    value: parseSnapshot(buffer, entry, opts.sourceId),
  });
}

function createSnapshotProvider(options) {
  const opts = options || {};
  const entry = sourceEntry(opts.sourceId);
  const loaded = loadVerifiedSnapshot(opts);
  const snapshot = loaded.value;
  const descriptor = {
    ...entry.descriptor,
    retrievedAt: snapshot.retrievedAt,
    contentHash: snapshot.distribution.sha256,
    ...(snapshot.distribution.versionOrPublicationDate
      ? {
          versionOrPublicationDate:
            snapshot.distribution.versionOrPublicationDate,
        }
      : {}),
  };
  const aliases = new Set(entry.coverage.aliases.map(normalizeCity));
  const provider = traffic.createProvider({
    descriptor,
    canProvide(context) {
      return Boolean(
        context && context.city && aliases.has(normalizeCity(context.city)),
      );
    },
    async loadObservations() {
      return snapshot.observations;
    },
  });
  return Object.freeze({
    ...provider,
    snapshot: Object.freeze({
      snapshotId: snapshot.snapshotId,
      snapshotSha256: loaded.snapshotSha256,
      distributionSha256: snapshot.distribution.sha256,
      distributionBytes: snapshot.distribution.bytes,
      coverage: snapshot.coverage,
      file: loaded.file,
    }),
  });
}

function normalizeRegistryManifest(value) {
  assertExactKeys(value, ["schemaVersion", "snapshots"], [], "registry");
  if (Number(value.schemaVersion) !== REGISTRY_SCHEMA_VERSION) {
    fail(
      "unsupported_registry_schema",
      `registry.schemaVersion must be ${REGISTRY_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(value.snapshots) || value.snapshots.length === 0) {
    fail("empty_registry", "registry.snapshots must be a non-empty array");
  }
  const sourceIds = new Set();
  return Object.freeze({
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    snapshots: Object.freeze(
      value.snapshots.map((registration, index) => {
        assertExactKeys(
          registration,
          ["sourceId", "path", "sha256"],
          [],
          `registry.snapshots[${index}]`,
        );
        const sourceId = requiredString(
          registration.sourceId,
          `registry.snapshots[${index}].sourceId`,
        );
        sourceEntry(sourceId);
        if (sourceIds.has(sourceId)) {
          fail("duplicate_source", `registry contains ${sourceId} more than once`);
        }
        sourceIds.add(sourceId);
        return Object.freeze({
          sourceId,
          path: requiredString(
            registration.path,
            `registry.snapshots[${index}].path`,
          ),
          sha256: assertHash(
            registration.sha256,
            `registry.snapshots[${index}].sha256`,
          ),
        });
      }),
    ),
  });
}

function loadRegistryManifest(options) {
  const opts = options || {};
  const file = resolveConfinedFile(opts.allowedRoot, opts.registryPath);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail("invalid_registry_json", "registry is not valid UTF-8 JSON", {
      message: error.message,
    });
  }
  return Object.freeze({ file, value: normalizeRegistryManifest(value) });
}

function registerSnapshotManifest(registry, options) {
  if (!registry || typeof registry.register !== "function") {
    fail("invalid_registry", "traffic provider registry is required");
  }
  const opts = options || {};
  const manifest = loadRegistryManifest(opts);
  const providers = manifest.value.snapshots.map((registration) => {
    const provider = createSnapshotProvider({
      sourceId: registration.sourceId,
      allowedRoot: opts.allowedRoot,
      snapshotPath: registration.path,
      expectedSnapshotSha256: registration.sha256,
    });
    registry.register(provider);
    return provider;
  });
  return Object.freeze(providers);
}

module.exports = Object.freeze({
  SNAPSHOT_SCHEMA_VERSION,
  REGISTRY_SCHEMA_VERSION,
  RETIRED_SOURCE_CATALOG,
  OPEN_DATA_SOURCE_CATALOG,
  TrafficSnapshotError,
  sha256Buffer,
  normalizeCity,
  normalizeRegistryManifest,
  loadVerifiedSnapshot,
  createSnapshotProvider,
  loadRegistryManifest,
  registerSnapshotManifest,
});
