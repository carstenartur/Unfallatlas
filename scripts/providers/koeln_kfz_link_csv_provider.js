#!/usr/bin/env node
"use strict";

/**
 * Deterministic parser/provider for the City of Cologne directional link CSV.
 *
 * The source publishes direction-specific DTVw-like motor-vehicle volumes for
 * 2016–2019. This adapter consumes only a locally controlled, byte-pinned copy
 * of the reviewed link distribution. It deliberately does not download live
 * data and does not pretend that Cologne's segment number is an OSM way ID.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { TextDecoder } = require("util");
const traffic = require("../../js/ua.traffic_provider");

const SOURCE_ID = "traffic.count.koeln-kfz-links-2016-2019";
const DISTRIBUTION_URL =
  "https://offenedaten-koeln.de/sites/default/files/KFZ_Zaehldaten_2016-2019_link.csv";
const DATASET_URL = "https://open.nrw/dataset/kfz-zaehlstellen-und-werte-koeln-k";
const REVIEWED_DISTRIBUTION_SHA256 =
  "477da6900ee791b7b3db433e27d6bde778c2f138869198b448fb26827de65488";
const UNIT = "Kfz/24 h";
const YEARS = Object.freeze([2016, 2017, 2018, 2019]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const FIELD_ALIASES = Object.freeze({
  segment: Object.freeze(["NO"]),
  fromNode: Object.freeze(["FROMNODENO"]),
  toNode: Object.freeze(["TONODENO"]),
  street: Object.freeze(["STR_NAME"]),
  reverseSegment: Object.freeze(["R_NO"]),
  reverseFromNode: Object.freeze(["R_FROMNO~1", "R_FROMNO_1", "R_FROMNODENO"]),
  reverseToNode: Object.freeze(["R_TONODENO"]),
  reverseStreet: Object.freeze(["R_STR_NAME"]),
  forward2016: Object.freeze(["K_2016_24H"]),
  forward2017: Object.freeze(["K_2017_24H"]),
  forward2018: Object.freeze(["K_2018_24H"]),
  forward2019: Object.freeze(["K_2019_24H"]),
  reverse2016: Object.freeze(["R_K_2016~2", "R_K_2016_24H"]),
  reverse2017: Object.freeze(["R_K_2017~3", "R_K_2017_24H"]),
  reverse2018: Object.freeze(["R_K_2018~4", "R_K_2018_24H"]),
  reverse2019: Object.freeze(["R_K_2019~5", "R_K_2019_24H"]),
});

const OPTIONAL_HEADERS = Object.freeze([
  "LENGTH",
  "R_LENGTH",
  "_ID",
  "FID",
  "OBJECTID",
  "SHAPE",
  "SHAPE_LENGTH",
  "THE_GEOM",
  "WKT",
  "GEOMETRY",
]);

class KoelnTrafficCsvError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = "KoelnTrafficCsvError";
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new KoelnTrafficCsvError(code, message, details);
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

function normalizeHash(value, label) {
  const hash = requiredString(value, label);
  if (!HASH_PATTERN.test(hash)) {
    fail("invalid_hash", `${label} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function normalizeRelativePath(value, label) {
  const relative = requiredString(value, label).replace(/\\/g, "/");
  if (
    relative.startsWith("/") ||
    /^[A-Za-z]:\//.test(relative) ||
    relative.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("unsafe_path", `${label} must be a normalized relative path`);
  }
  return relative;
}

function resolveExistingDirectory(value, label) {
  const requested = path.resolve(requiredString(value, label));
  let resolved;
  try {
    resolved = fs.realpathSync(requested);
  } catch (error) {
    fail("missing_root", `${label} does not exist`, {
      requested,
      systemCode: error && error.code ? error.code : null,
    });
  }
  if (!fs.statSync(resolved).isDirectory()) {
    fail("invalid_root", `${label} must be a directory`, { resolved });
  }
  return resolved;
}

function resolveConfinedFile(rootValue, relativeValue) {
  const root = resolveExistingDirectory(rootValue, "allowedRoot");
  const relative = normalizeRelativePath(relativeValue, "csvPath");
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("unsafe_path", "csvPath escapes or equals allowedRoot", { root, candidate });
  }
  let cursor = root;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      fail("unsafe_path", "csvPath traverses a symbolic link", { path: cursor });
    }
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    fail("missing_distribution", "csvPath is missing or not a regular file", {
      candidate,
    });
  }
  return Object.freeze({ root, relative, file: candidate });
}

function detectDelimiter(headerLine) {
  const candidates = [";", ",", "\t"];
  let quoted = false;
  const counts = new Map(candidates.map((candidate) => [candidate, 0]));
  for (let index = 0; index < headerLine.length; index += 1) {
    const char = headerLine[index];
    if (char === '"') {
      if (quoted && headerLine[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && counts.has(char)) {
      counts.set(char, counts.get(char) + 1);
    }
  }
  const sorted = [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || candidates.indexOf(left[0]) - candidates.indexOf(right[0]),
  );
  if (!sorted.length || sorted[0][1] === 0) {
    fail("delimiter_not_found", "CSV header has no supported delimiter");
  }
  return sorted[0][0];
}

function parseCsv(textValue) {
  const text = String(textValue || "");
  if (!text.trim()) fail("empty_distribution", "CSV distribution is empty");
  const firstLineEnd = (() => {
    const rn = text.indexOf("\r\n");
    const n = text.indexOf("\n");
    const r = text.indexOf("\r");
    return [rn, n, r].filter((value) => value >= 0).sort((a, b) => a - b)[0] ?? text.length;
  })();
  const delimiter = detectDelimiter(text.slice(0, firstLineEnd));
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      if (field.length !== 0) {
        fail("invalid_csv", "quote starts inside an unquoted field", {
          row: rows.length + 1,
          column: row.length + 1,
        });
      }
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field);
      field = "";
      if (row.some((item) => String(item).trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  if (quoted) fail("invalid_csv", "CSV ends inside a quoted field");
  if (field.length || row.length) {
    row.push(field);
    if (row.some((item) => String(item).trim() !== "")) rows.push(row);
  }
  if (rows.length < 2) {
    fail("empty_distribution", "CSV must contain a header and at least one data row");
  }
  return Object.freeze({ delimiter, rows: Object.freeze(rows.map(Object.freeze)) });
}

function canonicalHeader(value) {
  return String(value == null ? "" : value)
    .replace(/^\uFEFF/, "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function buildHeaderBinding(headerRow) {
  const headers = headerRow.map(canonicalHeader);
  const indexByHeader = new Map();
  headers.forEach((header, index) => {
    if (!header) fail("invalid_header", `CSV header ${index + 1} is empty`);
    if (indexByHeader.has(header)) {
      fail("duplicate_header", `CSV header ${header} occurs more than once`);
    }
    indexByHeader.set(header, index);
  });

  const binding = {};
  const known = new Set(OPTIONAL_HEADERS);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    aliases.forEach((alias) => known.add(alias));
    const matches = aliases.filter((alias) => indexByHeader.has(alias));
    if (matches.length === 0) {
      fail("missing_header", `CSV lacks required field ${field}`, { aliases });
    }
    if (matches.length > 1) {
      fail("ambiguous_header", `CSV provides multiple aliases for ${field}`, {
        matches,
      });
    }
    binding[field] = indexByHeader.get(matches[0]);
  }
  const unknown = headers.filter((header) => !known.has(header));
  if (unknown.length) {
    fail("unknown_header", "CSV contains unreviewed columns", { unknown });
  }
  return Object.freeze({ headers: Object.freeze(headers), binding: Object.freeze(binding) });
}

function parseCount(value, label) {
  const text = String(value == null ? "" : value)
    .replace(/[\u00A0\u202F\s]/g, "")
    .trim();
  if (!text || text === "-") return null;
  let normalized = text;
  if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  } else if (/^\d{1,3}(?:,\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/,/g, "");
  }
  if (!/^\d+$/.test(normalized)) {
    fail("invalid_count", `${label} is not an integer vehicle count`, { value });
  }
  const number = Number(normalized);
  if (!Number.isSafeInteger(number) || number < 0) {
    fail("invalid_count", `${label} is outside the supported integer range`, {
      value,
    });
  }
  return number;
}

function rowValue(row, index) {
  return String(row[index] == null ? "" : row[index]).trim();
}

function directionRecord(row, binding, rowNumber, reverse) {
  const prefix = reverse ? "reverse" : "";
  const segmentField = reverse ? "reverseSegment" : "segment";
  const fromField = reverse ? "reverseFromNode" : "fromNode";
  const toField = reverse ? "reverseToNode" : "toNode";
  const streetField = reverse ? "reverseStreet" : "street";
  const counts = YEARS.map((year) => {
    const fieldName = `${prefix || "forward"}${year}`;
    return Object.freeze({
      year,
      value: parseCount(rowValue(row, binding[fieldName]), `row ${rowNumber} ${fieldName}`),
    });
  });
  if (!counts.some((item) => item.value != null)) return null;

  const segment = requiredString(
    rowValue(row, binding[segmentField]),
    `row ${rowNumber} ${segmentField}`,
  );
  const fromNode = requiredString(
    rowValue(row, binding[fromField]),
    `row ${rowNumber} ${fromField}`,
  );
  const toNode = requiredString(
    rowValue(row, binding[toField]),
    `row ${rowNumber} ${toField}`,
  );
  const street = rowValue(row, binding[streetField]);
  return Object.freeze({
    segment,
    fromNode,
    toNode,
    street,
    directionCode: reverse ? "reverse" : "forward",
    counts: Object.freeze(counts),
  });
}

function observationFromDirection(direction, item, rowNumber) {
  const stableSegment = direction.segment.replace(/[^A-Za-z0-9._-]+/g, "_");
  const wayId =
    `koeln-segment:${stableSegment}:${direction.directionCode}:` +
    `${direction.fromNode}->${direction.toNode}`;
  const streetLabel = direction.street || "Straßenname nicht angegeben";
  return Object.freeze({
    observationId: `${SOURCE_ID}:${stableSegment}:${direction.directionCode}:${item.year}`,
    measurementType: "count",
    mode: "motor_vehicle",
    year: item.year,
    period: `DTVw-Hochrechnung ${item.year}`,
    value: item.value,
    unit: UNIT,
    wayId,
    direction:
      `${direction.directionCode === "forward" ? "hin" : "gegen"}: ` +
      `${direction.fromNode} → ${direction.toNode}; ${streetLabel}`,
    qualityNotes: Object.freeze([
      `Kölner Quellzeile ${rowNumber}; Segment ${direction.segment}.`,
      "Knotenstromzählung an einem repräsentativen Werktag; Tagesverkehr aus drei Zeitblöcken hochgerechnet.",
      "Kölner Segmentkennung ist noch nicht auf eine OpenStreetMap-Way-ID gematcht.",
    ]),
  });
}

function parseObservationsFromCsv(textValue) {
  const parsed = parseCsv(textValue);
  const header = buildHeaderBinding(parsed.rows[0]);
  const observations = [];
  const ids = new Set();
  for (let rowIndex = 1; rowIndex < parsed.rows.length; rowIndex += 1) {
    const row = parsed.rows[rowIndex];
    const rowNumber = rowIndex + 1;
    if (row.length !== header.headers.length) {
      fail("row_width_mismatch", `row ${rowNumber} has unexpected field count`, {
        expected: header.headers.length,
        actual: row.length,
      });
    }
    for (const reverse of [false, true]) {
      const direction = directionRecord(row, header.binding, rowNumber, reverse);
      if (!direction) continue;
      for (const item of direction.counts) {
        if (item.value == null) continue;
        const observation = observationFromDirection(direction, item, rowNumber);
        if (ids.has(observation.observationId)) {
          fail("duplicate_observation", "CSV produces a duplicate observation ID", {
            observationId: observation.observationId,
            rowNumber,
          });
        }
        ids.add(observation.observationId);
        observations.push(observation);
      }
    }
  }
  if (!observations.length) {
    fail("empty_distribution", "CSV contains no usable 2016–2019 traffic values");
  }
  return Object.freeze({
    delimiter: parsed.delimiter,
    rowCount: parsed.rows.length - 1,
    observations: Object.freeze(observations),
  });
}

function normalizeRetrievedAt(value) {
  const text = requiredString(value, "retrievedAt");
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    fail("invalid_date", "retrievedAt must be an ISO timestamp");
  }
  return new Date(milliseconds).toISOString();
}

function loadVerifiedDistribution(options) {
  const opts = options || {};
  const resolved = resolveConfinedFile(opts.allowedRoot, opts.csvPath);
  const expected = normalizeHash(
    opts.expectedDistributionSha256,
    "expectedDistributionSha256",
  );
  if (expected !== REVIEWED_DISTRIBUTION_SHA256) {
    fail(
      "unreviewed_distribution",
      "expectedDistributionSha256 differs from the reviewed Cologne link CSV",
      { reviewed: REVIEWED_DISTRIBUTION_SHA256, provided: expected },
    );
  }
  const bytes = fs.readFileSync(resolved.file);
  const actualHash = sha256Buffer(bytes);
  if (actualHash !== expected) {
    fail("distribution_hash_mismatch", "Cologne link CSV SHA-256 does not match", {
      expected,
      actual: actualHash,
    });
  }
  const expectedBytes = Number(opts.expectedBytes);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) {
    fail("invalid_bytes", "expectedBytes must be a positive safe integer");
  }
  if (bytes.length !== expectedBytes) {
    fail("distribution_size_mismatch", "Cologne link CSV byte size does not match", {
      expected: expectedBytes,
      actual: bytes.length,
    });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    fail("invalid_utf8", "Cologne link CSV is not valid UTF-8", {
      message: error && error.message ? error.message : String(error),
    });
  }
  const parsed = parseObservationsFromCsv(text);
  return Object.freeze({
    file: resolved.file,
    relativePath: resolved.relative,
    sha256: actualHash,
    bytes: bytes.length,
    rowCount: parsed.rowCount,
    delimiter: parsed.delimiter,
    observations: parsed.observations,
  });
}

function createKoelnKfzLinkCsvProvider(options) {
  const opts = options || {};
  const retrievedAt = normalizeRetrievedAt(opts.retrievedAt);
  const loaded = loadVerifiedDistribution(opts);
  const descriptor = {
    id: SOURCE_ID,
    publisher: "Stadt Köln",
    datasetTitle: "Kfz-Zählwerte Köln – richtungsbezogene Strecken 2016–2019",
    datasetUrl: DATASET_URL,
    distributionUrl: DISTRIBUTION_URL,
    licenseId: "DL-DE-Zero-2.0",
    licenseName: "Datenlizenz Deutschland – Zero – Version 2.0",
    licenseUrl: "https://www.govdata.de/dl-de/zero-2-0",
    requiredAttribution: "Stadt Köln",
    temporalCoverage: "2016–2019",
    spatialCoverage: "Köln",
    versionOrPublicationDate: "2019-12-31",
    retrievedAt,
    contentHash: loaded.sha256,
    changedOrDerived: true,
    changeNotice:
      "Richtungsbezogene Streckenwerte werden zeilengetreu in typisierte DTVw-Beobachtungen überführt; die Kölner Segmentkennung bleibt bis zum gesonderten OSM-Matching ausdrücklich synthetisch.",
    permissions: {
      permitsRedistribution: true,
      permitsDerivatives: true,
      commercialUseAllowed: true,
    },
    qualityNotes: [
      "Kommunale Knotenstromzählungen an repräsentativen Werktagen; Tagesverkehr aus drei Zeitblöcken hochgerechnet.",
      "Datenstand 2016–2019; nicht als aktuelle Verkehrsmenge interpretieren.",
      "Noch kein OSM-Segmentmatching in diesem Parser-Slice.",
    ],
    measurementType: "count",
    modes: ["motor_vehicle"],
    unit: UNIT,
    priority: 1,
  };
  const provider = traffic.createProvider({
    descriptor,
    canProvide(context) {
      const city = String((context && context.city) || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/ß/g, "ss")
        .replace(/[^a-z0-9]+/gi, "")
        .toLowerCase();
      return city === "koln" || city === "koeln";
    },
    async loadObservations() {
      return loaded.observations;
    },
  });
  return Object.freeze({
    ...provider,
    distribution: Object.freeze({
      path: loaded.relativePath,
      sha256: loaded.sha256,
      bytes: loaded.bytes,
      rowCount: loaded.rowCount,
      observationCount: loaded.observations.length,
      delimiter: loaded.delimiter,
    }),
  });
}

module.exports = Object.freeze({
  SOURCE_ID,
  DISTRIBUTION_URL,
  DATASET_URL,
  REVIEWED_DISTRIBUTION_SHA256,
  UNIT,
  YEARS,
  FIELD_ALIASES,
  OPTIONAL_HEADERS,
  KoelnTrafficCsvError,
  sha256Buffer,
  detectDelimiter,
  parseCsv,
  canonicalHeader,
  buildHeaderBinding,
  parseCount,
  parseObservationsFromCsv,
  loadVerifiedDistribution,
  createKoelnKfzLinkCsvProvider,
});
