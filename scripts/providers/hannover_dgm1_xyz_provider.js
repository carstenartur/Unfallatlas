#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const elevation = require("../../js/ua.elevation_provider");

const MANIFEST_SCHEMA_VERSION = 1;
const SOURCE_ID = "hannover.dgm1";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_MAX_CELLS = 250_000_000;

class Dgm1XyzError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = "Dgm1XyzError";
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new Dgm1XyzError(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, required, optional, label) {
  if (!isPlainObject(value)) fail("invalid_object", `${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
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

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    fail("invalid_value", `${label} must be a positive integer`);
  }
  return number;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail("invalid_value", `${label} must be finite`);
  return number;
}

function assertHash(value, label) {
  const normalized = requiredString(value, label).toLowerCase();
  if (!HASH_PATTERN.test(normalized)) {
    fail("invalid_hash", `${label} must be a SHA-256 hex digest`);
  }
  return normalized;
}

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function normalizeRelativePath(value, label) {
  const text = requiredString(value, label).replace(/\\/g, "/");
  if (
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("unsafe_path", `${label} must be a normalized relative path`);
  }
  return text;
}

function resolveConfinedFile(rootValue, relativeValue, label) {
  const root = fs.realpathSync(requiredString(rootValue, "allowedRoot"));
  const relative = normalizeRelativePath(relativeValue, label);
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    fail("unsafe_path", `${label} escapes or equals the import root`);
  }
  let cursor = root;
  for (const segment of rel.split(path.sep)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      fail("unsafe_path", `${label} traverses a symbolic link`, { path: cursor });
    }
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    fail("missing_file", `${label} does not point to a regular file`);
  }
  return candidate;
}

function httpsUrl(value, label) {
  const text = requiredString(value, label);
  let parsed;
  try {
    parsed = new URL(text);
  } catch (_) {
    fail("invalid_url", `${label} must be an absolute URL`);
  }
  if (parsed.protocol !== "https:") fail("invalid_url", `${label} must use https`);
  parsed.hash = "";
  return parsed.toString();
}

function normalizeManifest(value) {
  assertExactKeys(
    value,
    ["schemaVersion", "sourceId", "retrievedAt", "distribution", "grid"],
    [],
    "manifest",
  );
  if (Number(value.schemaVersion) !== MANIFEST_SCHEMA_VERSION) {
    fail("unsupported_schema", `manifest.schemaVersion must be ${MANIFEST_SCHEMA_VERSION}`);
  }
  if (requiredString(value.sourceId, "manifest.sourceId") !== SOURCE_ID) {
    fail("source_mismatch", `manifest.sourceId must be ${SOURCE_ID}`);
  }
  assertExactKeys(
    value.distribution,
    ["url", "path", "sha256", "bytes"],
    ["publicationDate"],
    "manifest.distribution",
  );
  assertExactKeys(
    value.grid,
    [
      "crs",
      "resolutionMeters",
      "minEasting",
      "maxEasting",
      "minNorthing",
      "maxNorthing",
    ],
    ["noDataValue", "maxCells"],
    "manifest.grid",
  );
  if (requiredString(value.grid.crs, "manifest.grid.crs") !== "EPSG:25832") {
    fail("unsupported_crs", "Hannover DGM1 XYZ must use EPSG:25832");
  }
  const resolutionMeters = finiteNumber(
    value.grid.resolutionMeters,
    "manifest.grid.resolutionMeters",
  );
  if (resolutionMeters !== 1) {
    fail("unsupported_resolution", "Hannover DGM1 must use the published 1 m grid");
  }
  const minEasting = finiteNumber(value.grid.minEasting, "manifest.grid.minEasting");
  const maxEasting = finiteNumber(value.grid.maxEasting, "manifest.grid.maxEasting");
  const minNorthing = finiteNumber(value.grid.minNorthing, "manifest.grid.minNorthing");
  const maxNorthing = finiteNumber(value.grid.maxNorthing, "manifest.grid.maxNorthing");
  if (minEasting >= maxEasting || minNorthing >= maxNorthing) {
    fail("invalid_bounds", "manifest grid bounds are not ordered");
  }
  const widthSpan = (maxEasting - minEasting) / resolutionMeters;
  const heightSpan = (maxNorthing - minNorthing) / resolutionMeters;
  if (
    Math.abs(widthSpan - Math.round(widthSpan)) > 1e-6 ||
    Math.abs(heightSpan - Math.round(heightSpan)) > 1e-6
  ) {
    fail("misaligned_bounds", "manifest bounds must align to the declared grid resolution");
  }
  const width = Math.round(widthSpan) + 1;
  const height = Math.round(heightSpan) + 1;
  const cells = width * height;
  const maxCells = value.grid.maxCells == null
    ? DEFAULT_MAX_CELLS
    : positiveInteger(value.grid.maxCells, "manifest.grid.maxCells");
  if (!Number.isSafeInteger(cells) || cells > maxCells) {
    fail("grid_too_large", `declared grid contains ${cells} cells, limit is ${maxCells}`);
  }
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    sourceId: SOURCE_ID,
    retrievedAt: requiredString(value.retrievedAt, "manifest.retrievedAt"),
    distribution: Object.freeze({
      url: httpsUrl(value.distribution.url, "manifest.distribution.url"),
      path: normalizeRelativePath(value.distribution.path, "manifest.distribution.path"),
      sha256: assertHash(value.distribution.sha256, "manifest.distribution.sha256"),
      bytes: positiveInteger(value.distribution.bytes, "manifest.distribution.bytes"),
      ...(value.distribution.publicationDate
        ? {
            publicationDate: requiredString(
              value.distribution.publicationDate,
              "manifest.distribution.publicationDate",
            ),
          }
        : {}),
    }),
    grid: Object.freeze({
      crs: "EPSG:25832",
      resolutionMeters,
      minEasting,
      maxEasting,
      minNorthing,
      maxNorthing,
      width,
      height,
      cells,
      maxCells,
      ...(value.grid.noDataValue == null
        ? {}
        : {
            noDataValue: finiteNumber(
              value.grid.noDataValue,
              "manifest.grid.noDataValue",
            ),
          }),
    }),
  });
}

function wgs84ToUtm32(coordinate) {
  const lat = finiteNumber(coordinate && coordinate.lat, "coordinate.lat");
  const lon = finiteNumber(coordinate && coordinate.lon, "coordinate.lon");
  if (lat < 0 || lat > 84 || lon < 6 || lon > 12) {
    fail("coordinate_outside_utm32", "coordinate is outside UTM zone 32N coverage");
  }
  const a = 6378137;
  const inverseFlattening = 298.257223563;
  const flattening = 1 / inverseFlattening;
  const eccentricitySquared = flattening * (2 - flattening);
  const secondEccentricitySquared = eccentricitySquared / (1 - eccentricitySquared);
  const k0 = 0.9996;
  const latitude = (lat * Math.PI) / 180;
  const longitude = (lon * Math.PI) / 180;
  const centralMeridian = (9 * Math.PI) / 180;
  const sinLatitude = Math.sin(latitude);
  const cosLatitude = Math.cos(latitude);
  const tanLatitude = Math.tan(latitude);
  const n = a / Math.sqrt(1 - eccentricitySquared * sinLatitude * sinLatitude);
  const t = tanLatitude * tanLatitude;
  const c = secondEccentricitySquared * cosLatitude * cosLatitude;
  const A = cosLatitude * (longitude - centralMeridian);
  const e4 = eccentricitySquared * eccentricitySquared;
  const e6 = e4 * eccentricitySquared;
  const meridionalArc =
    a *
    ((1 - eccentricitySquared / 4 - (3 * e4) / 64 - (5 * e6) / 256) * latitude -
      ((3 * eccentricitySquared) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) *
        Math.sin(2 * latitude) +
      ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * latitude) -
      ((35 * e6) / 3072) * Math.sin(6 * latitude));
  const easting =
    500000 +
    k0 *
      n *
      (A +
        ((1 - t + c) * A ** 3) / 6 +
        ((5 - 18 * t + t * t + 72 * c - 58 * secondEccentricitySquared) *
          A ** 5) /
          120);
  const northing =
    k0 *
    (meridionalArc +
      n *
        tanLatitude *
        (A ** 2 / 2 +
          ((5 - t + 9 * c + 4 * c * c) * A ** 4) / 24 +
          ((61 - 58 * t + t * t + 600 * c - 330 * secondEccentricitySquared) *
            A ** 6) /
            720));
  return Object.freeze({ easting, northing });
}

async function loadGrid(file, manifest) {
  const stat = fs.statSync(file);
  if (stat.size !== manifest.distribution.bytes) {
    fail("distribution_size_mismatch", "DGM1 XYZ byte size does not match manifest", {
      expected: manifest.distribution.bytes,
      actual: stat.size,
    });
  }
  const actualHash = sha256File(file);
  if (actualHash !== manifest.distribution.sha256) {
    fail("distribution_hash_mismatch", "DGM1 XYZ SHA-256 does not match manifest", {
      expected: manifest.distribution.sha256,
      actual: actualHash,
    });
  }
  const { grid } = manifest;
  const values = new Float32Array(grid.cells);
  const seen = new Uint8Array(grid.cells);
  values.fill(Number.NaN);
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  let pointCount = 0;
  for await (const rawLine of lines) {
    lineNumber += 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/[\s;,]+/);
    if (fields.length !== 3) {
      fail("invalid_xyz", `line ${lineNumber} must contain exactly x y z`);
    }
    const x = Number(fields[0]);
    const y = Number(fields[1]);
    const z = Number(fields[2]);
    if (![x, y, z].every(Number.isFinite)) {
      fail("invalid_xyz", `line ${lineNumber} contains a non-finite coordinate`);
    }
    const columnFloat = (x - grid.minEasting) / grid.resolutionMeters;
    const rowFloat = (y - grid.minNorthing) / grid.resolutionMeters;
    const column = Math.round(columnFloat);
    const row = Math.round(rowFloat);
    if (
      Math.abs(columnFloat - column) > 1e-6 ||
      Math.abs(rowFloat - row) > 1e-6 ||
      column < 0 ||
      column >= grid.width ||
      row < 0 ||
      row >= grid.height
    ) {
      fail("xyz_outside_grid", `line ${lineNumber} is outside or misaligned with the declared grid`);
    }
    const index = row * grid.width + column;
    if (seen[index]) {
      fail("duplicate_xyz", `line ${lineNumber} duplicates grid cell ${column},${row}`);
    }
    seen[index] = 1;
    if (manifest.grid.noDataValue != null && z === manifest.grid.noDataValue) {
      continue;
    }
    values[index] = z;
    pointCount += 1;
  }
  if (pointCount === 0) fail("empty_grid", "DGM1 XYZ contains no usable elevations");
  return Object.freeze({
    values,
    pointCount,
    sha256: actualHash,
    sampleProjected(easting, northing) {
      const x = (easting - grid.minEasting) / grid.resolutionMeters;
      const y = (northing - grid.minNorthing) / grid.resolutionMeters;
      if (x < 0 || y < 0 || x > grid.width - 1 || y > grid.height - 1) return null;
      const x0 = Math.floor(x);
      const y0 = Math.floor(y);
      const x1 = Math.min(x0 + 1, grid.width - 1);
      const y1 = Math.min(y0 + 1, grid.height - 1);
      const q00 = values[y0 * grid.width + x0];
      const q10 = values[y0 * grid.width + x1];
      const q01 = values[y1 * grid.width + x0];
      const q11 = values[y1 * grid.width + x1];
      if (![q00, q10, q01, q11].every(Number.isFinite)) return null;
      const tx = x - x0;
      const ty = y - y0;
      return (
        q00 * (1 - tx) * (1 - ty) +
        q10 * tx * (1 - ty) +
        q01 * (1 - tx) * ty +
        q11 * tx * ty
      );
    },
  });
}

function loadManifest(options) {
  const opts = options || {};
  const manifestFile = resolveConfinedFile(opts.allowedRoot, opts.manifestPath, "manifestPath");
  const buffer = fs.readFileSync(manifestFile);
  const expectedHash = assertHash(opts.expectedManifestSha256, "expectedManifestSha256");
  const actualHash = sha256Buffer(buffer);
  if (actualHash !== expectedHash) {
    fail("manifest_hash_mismatch", "DGM1 manifest SHA-256 does not match external pin", {
      expected: expectedHash,
      actual: actualHash,
    });
  }
  let value;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    fail("invalid_json", "DGM1 manifest is not valid UTF-8 JSON", { message: error.message });
  }
  const manifest = normalizeManifest(value);
  const dataFile = resolveConfinedFile(
    opts.allowedRoot,
    manifest.distribution.path,
    "manifest.distribution.path",
  );
  return Object.freeze({ manifestFile, manifestHash: actualHash, manifest, dataFile });
}

function createHannoverDgm1XyzProvider(options) {
  const loaded = loadManifest(options);
  let gridPromise = null;
  const getGrid = () => {
    if (!gridPromise) gridPromise = loadGrid(loaded.dataFile, loaded.manifest);
    return gridPromise;
  };
  const descriptor = {
    ...elevation.createHannoverDgm1Descriptor(loaded.manifest.retrievedAt),
    distributionUrl: loaded.manifest.distribution.url,
    ...(loaded.manifest.distribution.publicationDate
      ? { publicationDate: loaded.manifest.distribution.publicationDate }
      : {}),
  };
  const provider = elevation.createProvider({
    descriptor,
    canProvide(context) {
      return Boolean(
        context &&
          typeof context.city === "string" &&
          ["hannover", "hanover"].includes(context.city.trim().toLowerCase()),
      );
    },
    async sampleElevations(coordinates) {
      const grid = await getGrid();
      return coordinates.map((coordinate) => {
        const projected = wgs84ToUtm32(coordinate);
        return grid.sampleProjected(projected.easting, projected.northing);
      });
    },
  });
  return Object.freeze({
    ...provider,
    manifest: Object.freeze({
      path: loaded.manifestFile,
      sha256: loaded.manifestHash,
      dataPath: loaded.dataFile,
      dataSha256: loaded.manifest.distribution.sha256,
      grid: loaded.manifest.grid,
    }),
    async preload() {
      const grid = await getGrid();
      return Object.freeze({ pointCount: grid.pointCount, sha256: grid.sha256 });
    },
  });
}

module.exports = Object.freeze({
  MANIFEST_SCHEMA_VERSION,
  SOURCE_ID,
  DEFAULT_MAX_CELLS,
  Dgm1XyzError,
  sha256Buffer,
  sha256File,
  normalizeManifest,
  wgs84ToUtm32,
  loadGrid,
  loadManifest,
  createHannoverDgm1XyzProvider,
});
