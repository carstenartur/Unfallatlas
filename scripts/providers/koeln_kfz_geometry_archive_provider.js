#!/usr/bin/env node
'use strict';

/**
 * Trust boundary for the official Cologne 2016–2019 traffic-count geometry ZIP.
 *
 * This slice intentionally inventories and validates the contained Shapefile
 * datasets; it does not yet interpret DBF rows or transform coordinates. A
 * later parser may consume only shape sets that passed this archive contract.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const strictZip = require('../lib/strict-zip');

const SOURCE_ID = 'traffic.geometry.koeln-kfz-2016-2019';
const DATASET_URL = 'https://open.nrw/dataset/kfz-zaehlstellen-und-werte-koeln-k';
const DISTRIBUTION_URL =
  'https://offenedaten-koeln.de/sites/default/files/KFZ%20Zaehldaten%202016-2019_0.zip';
const REVIEWED_DISTRIBUTION_SHA256 =
  '5672f1b61777ccbd5a1db6555dddf7c61a009eb161b13d4c7cbe530de9299238';
const MANIFEST_SCHEMA = 'unfallwerkbank.koeln-kfz-geometry-archive/v1';
const ALLOWED_EXTENSIONS = Object.freeze(new Set([
  '.shp', '.shx', '.dbf', '.prj', '.cpg', '.sbn', '.sbx', '.xml', '.txt', '.qpj',
]));
const REQUIRED_SET_EXTENSIONS = Object.freeze(['.shp', '.shx', '.dbf', '.prj']);
const SHAPE_TYPES = Object.freeze({
  1: 'point',
  3: 'polyline',
  5: 'polygon',
  8: 'multipoint',
  11: 'point-z',
  13: 'polyline-z',
  15: 'polygon-z',
  18: 'multipoint-z',
  21: 'point-m',
  23: 'polyline-m',
  25: 'polygon-m',
  28: 'multipoint-m',
});

class KoelnGeometryArchiveError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'KoelnGeometryArchiveError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new KoelnGeometryArchiveError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_value', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredLowerHash(value, label) {
  const hash = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    fail('invalid_hash', `${label} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function requiredPositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail('invalid_integer', `${label} must be a positive safe integer`, { value });
  }
  return number;
}

function normalizeRetrievedAt(value) {
  const text = requiredString(value, 'retrievedAt');
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail('invalid_timestamp', 'retrievedAt must be ISO-8601');
  return new Date(milliseconds).toISOString();
}

function resolveConfinedRegularFile(rootValue, relativeValue) {
  const requestedRoot = path.resolve(requiredString(rootValue, 'allowedRoot'));
  let root;
  try {
    root = fs.realpathSync(requestedRoot);
  } catch (error) {
    fail('missing_root', 'allowedRoot does not exist', { requestedRoot, cause: error.code || error.message });
  }
  if (!fs.statSync(root).isDirectory()) fail('invalid_root', 'allowedRoot must be a directory', { root });
  const relative = requiredString(relativeValue, 'archivePath').replace(/\\/g, '/');
  if (relative.startsWith('/') || /^[A-Za-z]:\//.test(relative) ||
      relative.split('/').some((part) => !part || part === '.' || part === '..')) {
    fail('unsafe_archive_path', 'archivePath must be a normalized relative path', { relative });
  }
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('unsafe_archive_path', 'archivePath escapes allowedRoot', { candidate });
  }
  let cursor = root;
  for (const part of rel.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      fail('unsafe_archive_path', 'archivePath traverses a symbolic link', { path: cursor });
    }
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    fail('missing_archive', 'archivePath is missing or not a regular file', { candidate });
  }
  return Object.freeze({ root, relative, file: fs.realpathSync(candidate) });
}

function parseShapefileHeader(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
    fail('invalid_shapefile', `${label} is shorter than the 100-byte Shapefile header`);
  }
  if (buffer.readInt32BE(0) !== 9994) fail('invalid_shapefile', `${label} has an invalid file code`);
  for (let offset = 4; offset < 24; offset += 4) {
    if (buffer.readInt32BE(offset) !== 0) {
      fail('invalid_shapefile', `${label} has non-zero reserved header words`, { offset });
    }
  }
  const declaredBytes = buffer.readInt32BE(24) * 2;
  if (declaredBytes !== buffer.length) {
    fail('shapefile_length_mismatch', `${label} declared length differs from entry bytes`, {
      declaredBytes,
      actualBytes: buffer.length,
    });
  }
  const version = buffer.readInt32LE(28);
  if (version !== 1000) fail('invalid_shapefile', `${label} has unsupported version ${version}`);
  const shapeType = buffer.readInt32LE(32);
  const shapeTypeName = SHAPE_TYPES[shapeType];
  if (!shapeTypeName) fail('unsupported_shape_type', `${label} has unsupported shape type ${shapeType}`);
  const bbox = {
    minX: buffer.readDoubleLE(36),
    minY: buffer.readDoubleLE(44),
    maxX: buffer.readDoubleLE(52),
    maxY: buffer.readDoubleLE(60),
  };
  if (Object.values(bbox).some((value) => !Number.isFinite(value)) ||
      bbox.minX > bbox.maxX || bbox.minY > bbox.maxY) {
    fail('invalid_shapefile_bbox', `${label} contains an invalid XY bounding box`, bbox);
  }
  return Object.freeze({ version, shapeType, shapeTypeName, bbox: Object.freeze(bbox) });
}

function parseDbfHeader(buffer, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 33) fail('invalid_dbf', `${label} is too short`);
  const recordCount = buffer.readUInt32LE(4);
  const headerBytes = buffer.readUInt16LE(8);
  const recordBytes = buffer.readUInt16LE(10);
  if (headerBytes < 33 || headerBytes > buffer.length || recordBytes < 1) {
    fail('invalid_dbf', `${label} has invalid header or record length`, {
      headerBytes,
      recordBytes,
      bytes: buffer.length,
    });
  }
  const minimumBytes = headerBytes + recordCount * recordBytes;
  if (!Number.isSafeInteger(minimumBytes) || minimumBytes > buffer.length) {
    fail('dbf_length_mismatch', `${label} does not contain all declared records`, {
      recordCount,
      recordBytes,
      minimumBytes,
      bytes: buffer.length,
    });
  }
  const fields = [];
  const names = new Set();
  let offset = 32;
  while (offset < headerBytes) {
    if (buffer[offset] === 0x0d) break;
    if (offset + 32 > headerBytes) fail('invalid_dbf', `${label} has a truncated field descriptor`);
    const rawName = buffer.subarray(offset, offset + 11);
    if ([...rawName].some((byte) => byte !== 0 && (byte < 0x20 || byte > 0x7e))) {
      fail('invalid_dbf', `${label} contains a non-ASCII field name`);
    }
    const name = rawName.toString('ascii').replace(/\0.*$/, '').trim();
    const type = String.fromCharCode(buffer[offset + 11]);
    const length = buffer[offset + 16];
    const decimals = buffer[offset + 17];
    if (!name || !/^[A-Za-z0-9_~]+$/.test(name) || length === 0) {
      fail('invalid_dbf', `${label} contains an invalid field descriptor`, { name, type, length });
    }
    const folded = name.toUpperCase();
    if (names.has(folded)) fail('duplicate_dbf_field', `${label} contains duplicate field ${name}`);
    names.add(folded);
    fields.push(Object.freeze({ name, type, length, decimals }));
    offset += 32;
  }
  if (offset >= headerBytes || buffer[offset] !== 0x0d || offset !== headerBytes - 1) {
    fail('invalid_dbf', `${label} field descriptor terminator does not match header length`, {
      offset,
      headerBytes,
    });
  }
  if (fields.length === 0) fail('invalid_dbf', `${label} contains no fields`);
  return Object.freeze({
    version: buffer[0],
    recordCount,
    headerBytes,
    recordBytes,
    fields: Object.freeze(fields),
  });
}

function decodeUtf8(buffer, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^\uFEFF/, '').trim();
  } catch (error) {
    fail('invalid_text', `${label} is not valid UTF-8`, { cause: error.message });
  }
}

function classifyUtm32(prjText, label) {
  const normalized = prjText.toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
  const utm32 = /\bUTM\b/.test(normalized) && /\b32N?\b/.test(normalized);
  const epsg25832 = /\b25832\b/.test(normalized);
  const epsg32632 = /\b32632\b/.test(normalized);
  if (!utm32 && !epsg25832 && !epsg32632) {
    fail('unsupported_crs', `${label} does not declare UTM zone 32`, { prjText });
  }
  const epsg = epsg25832 ? 'EPSG:25832' : epsg32632 ? 'EPSG:32632' : null;
  return Object.freeze({
    family: 'UTM',
    zone: 32,
    hemisphere: 'N',
    epsg,
    datum: /\bETRS\b/.test(normalized)
      ? 'ETRS89'
      : /\bWGS\b/.test(normalized)
        ? 'WGS84'
        : 'unspecified',
  });
}

function extensionOf(name) {
  return path.posix.extname(name).toLowerCase();
}

function baseOf(name) {
  return name.slice(0, name.length - path.posix.extname(name).length);
}

function inspectGeometryArchiveBuffer(buffer, options = {}) {
  let archive;
  try {
    archive = strictZip.readStrictZip(buffer, { limits: options.limits });
  } catch (error) {
    if (error instanceof strictZip.StrictZipError) {
      fail('invalid_geometry_archive', error.message, { zipCode: error.code, zipDetails: error.details });
    }
    throw error;
  }
  const fileMap = new Map();
  for (const file of archive.files) {
    const extension = extensionOf(file.name);
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      fail('unexpected_archive_entry', 'geometry archive contains an unreviewed file type', {
        name: file.name,
        extension,
      });
    }
    fileMap.set(file.name, file);
  }
  const groups = new Map();
  for (const file of archive.files) {
    const extension = extensionOf(file.name);
    if (!REQUIRED_SET_EXTENSIONS.includes(extension) && !['.cpg', '.qpj', '.sbn', '.sbx'].includes(extension)) continue;
    const base = baseOf(file.name);
    if (!groups.has(base)) groups.set(base, new Map());
    const group = groups.get(base);
    if (group.has(extension)) fail('duplicate_shape_component', 'shape set contains duplicate extension', { base, extension });
    group.set(extension, file);
  }
  const shapeSets = [];
  for (const [base, components] of groups) {
    const presentCore = REQUIRED_SET_EXTENSIONS.filter((extension) => components.has(extension));
    if (presentCore.length === 0) continue;
    if (presentCore.length !== REQUIRED_SET_EXTENSIONS.length) {
      fail('incomplete_shape_set', 'shape set lacks a required component', {
        base,
        required: REQUIRED_SET_EXTENSIONS,
        present: [...components.keys()].sort(),
      });
    }
    const shp = parseShapefileHeader(components.get('.shp').data, `${base}.shp`);
    const shx = parseShapefileHeader(components.get('.shx').data, `${base}.shx`);
    if (shp.shapeType !== shx.shapeType || JSON.stringify(shp.bbox) !== JSON.stringify(shx.bbox)) {
      fail('shape_index_mismatch', 'SHP and SHX headers disagree', {
        base,
        shp,
        shx,
      });
    }
    const dbf = parseDbfHeader(components.get('.dbf').data, `${base}.dbf`);
    const prjText = decodeUtf8(components.get('.prj').data, `${base}.prj`);
    const crs = classifyUtm32(prjText, `${base}.prj`);
    const entries = [...components.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([extension, file]) => Object.freeze({
        extension,
        path: file.name,
        bytes: file.data.length,
        sha256: sha256(file.data),
      }));
    shapeSets.push(Object.freeze({
      id: base,
      shapeType: shp.shapeType,
      shapeTypeName: shp.shapeTypeName,
      bbox: shp.bbox,
      crs,
      recordCount: dbf.recordCount,
      dbfFields: dbf.fields,
      entries: Object.freeze(entries),
    }));
  }
  shapeSets.sort((left, right) => left.id.localeCompare(right.id));
  if (shapeSets.length === 0) fail('missing_shape_sets', 'archive contains no complete Shapefile sets');
  const pointSets = shapeSets.filter((set) => /^point/.test(set.shapeTypeName));
  const lineSets = shapeSets.filter((set) => /^polyline/.test(set.shapeTypeName));
  if (pointSets.length === 0 || lineSets.length === 0) {
    fail('missing_geometry_roles', 'archive must contain at least one point and one polyline shape set', {
      pointSets: pointSets.map((set) => set.id),
      lineSets: lineSets.map((set) => set.id),
    });
  }
  const inventory = archive.files.map((file) => Object.freeze({
    path: file.name,
    extension: extensionOf(file.name),
    compressionMethod: file.method,
    compressedBytes: file.compressedSize,
    bytes: file.data.length,
    crc32: file.crc32.toString(16).padStart(8, '0'),
    sha256: sha256(file.data),
  })).sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze({
    entryCount: archive.entryCount,
    fileCount: archive.fileCount,
    totalUncompressedBytes: archive.totalUncompressedBytes,
    inventory: Object.freeze(inventory),
    shapeSets: Object.freeze(shapeSets),
    roles: Object.freeze({
      pointShapeSetIds: Object.freeze(pointSets.map((set) => set.id)),
      polylineShapeSetIds: Object.freeze(lineSets.map((set) => set.id)),
    }),
  });
}

function verifyArchiveBytes(buffer, expectedSha256, expectedBytes, options = {}) {
  if (!Buffer.isBuffer(buffer)) fail('invalid_archive', 'archive bytes must be a Buffer');
  const expectedHash = requiredLowerHash(expectedSha256, 'expectedSha256');
  const bytes = requiredPositiveInteger(expectedBytes, 'expectedBytes');
  if (buffer.length !== bytes) {
    fail('archive_size_mismatch', 'geometry archive byte size differs from its pin', {
      expected: bytes,
      actual: buffer.length,
    });
  }
  const actualHash = sha256(buffer);
  if (actualHash !== expectedHash) {
    fail('archive_hash_mismatch', 'geometry archive SHA-256 differs from its pin', {
      expected: expectedHash,
      actual: actualHash,
    });
  }
  const inspected = inspectGeometryArchiveBuffer(buffer, options);
  return Object.freeze({ sha256: actualHash, bytes, inspected });
}

function loadVerifiedGeometryArchive(options = {}) {
  const resolved = resolveConfinedRegularFile(options.allowedRoot, options.archivePath);
  const expectedHash = requiredLowerHash(options.expectedDistributionSha256, 'expectedDistributionSha256');
  if (expectedHash !== REVIEWED_DISTRIBUTION_SHA256) {
    fail('unreviewed_distribution', 'expectedDistributionSha256 differs from the reviewed Cologne geometry ZIP', {
      reviewed: REVIEWED_DISTRIBUTION_SHA256,
      provided: expectedHash,
    });
  }
  const buffer = fs.readFileSync(resolved.file);
  const verified = verifyArchiveBytes(buffer, expectedHash, options.expectedBytes, options);
  return Object.freeze({
    sourceId: SOURCE_ID,
    datasetUrl: DATASET_URL,
    distributionUrl: DISTRIBUTION_URL,
    licenseId: 'DL-DE-Zero-2.0',
    licenseName: 'Datenlizenz Deutschland – Zero – Version 2.0',
    retrievedAt: normalizeRetrievedAt(options.retrievedAt),
    file: resolved.file,
    relativePath: resolved.relative,
    sha256: verified.sha256,
    bytes: verified.bytes,
    inspected: verified.inspected,
  });
}

function buildManifest(loaded) {
  return Object.freeze({
    schemaVersion: MANIFEST_SCHEMA,
    source: Object.freeze({
      id: loaded.sourceId,
      publisher: 'Stadt Köln',
      datasetTitle: 'Kfz-Zählstellen und Werte Köln – Knotenpunkte und Linien 2016–2019',
      datasetUrl: loaded.datasetUrl,
      distributionUrl: loaded.distributionUrl,
      licenseId: loaded.licenseId,
      licenseName: loaded.licenseName,
      temporalCoverage: '2016–2019',
      spatialCoverage: 'Köln',
      retrievedAt: loaded.retrievedAt,
    }),
    archive: Object.freeze({
      path: loaded.relativePath,
      sha256: loaded.sha256,
      bytes: loaded.bytes,
      mediaType: 'application/zip',
    }),
    inventory: loaded.inspected.inventory,
    shapeSets: loaded.inspected.shapeSets,
    roles: loaded.inspected.roles,
    truthBoundary: Object.freeze({
      archiveBytesVerified: true,
      zipEntriesVerified: true,
      shapefileContainersVerified: true,
      dbfRowsInterpreted: false,
      coordinatesTransformed: false,
      linkValuesJoined: false,
      osmMatched: false,
    }),
  });
}

function writeManifestAtomic(fileValue, manifest) {
  const target = path.resolve(requiredString(fileValue, 'manifestPath'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const realParent = fs.realpathSync(path.dirname(target));
  const output = path.join(realParent, path.basename(target));
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) {
    fail('unsafe_manifest_path', 'manifestPath must not be a symbolic link', { output });
  }
  const temporary = `${output}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return output;
}

function parseArgs(argv) {
  const options = { allowedRoot: null, archivePath: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.allowedRoot = argv[++index];
    else if (argument === '--archive') options.archivePath = argv[++index];
    else if (argument === '--sha256') options.expectedDistributionSha256 = argv[++index];
    else if (argument === '--bytes') options.expectedBytes = Number(argv[++index]);
    else if (argument === '--retrieved-at') options.retrievedAt = argv[++index];
    else if (argument === '--manifest') options.manifestPath = argv[++index];
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/providers/koeln_kfz_geometry_archive_provider.js ' +
      '--root <dir> --archive <relative.zip> --sha256 <digest> --bytes <n> ' +
      '--retrieved-at <ISO> [--manifest <file>] [--json]\n',
  );
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const loaded = loadVerifiedGeometryArchive(options);
  const manifest = buildManifest(loaded);
  const manifestPath = options.manifestPath
    ? writeManifestAtomic(options.manifestPath, manifest)
    : null;
  const summary = Object.freeze({
    sourceId: loaded.sourceId,
    archiveSha256: loaded.sha256,
    archiveBytes: loaded.bytes,
    shapeSetCount: manifest.shapeSets.length,
    pointShapeSetIds: manifest.roles.pointShapeSetIds,
    polylineShapeSetIds: manifest.roles.polylineShapeSetIds,
    manifestPath,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  else process.stdout.write(
    `[koeln-kfz-geometry] verified ${summary.shapeSetCount} shape sets ` +
      `(${summary.pointShapeSetIds.length} point, ${summary.polylineShapeSetIds.length} polyline).\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SOURCE_ID,
  DATASET_URL,
  DISTRIBUTION_URL,
  REVIEWED_DISTRIBUTION_SHA256,
  MANIFEST_SCHEMA,
  ALLOWED_EXTENSIONS,
  REQUIRED_SET_EXTENSIONS,
  SHAPE_TYPES,
  KoelnGeometryArchiveError,
  sha256,
  resolveConfinedRegularFile,
  parseShapefileHeader,
  parseDbfHeader,
  decodeUtf8,
  classifyUtm32,
  inspectGeometryArchiveBuffer,
  verifyArchiveBytes,
  loadVerifiedGeometryArchive,
  buildManifest,
  writeManifestAtomic,
  parseArgs,
  main,
});
