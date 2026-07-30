#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const strictZip = require('../lib/strict-zip');
const archiveProvider = require('./koeln_kfz_geometry_archive_provider');
const linkProvider = require('./koeln_kfz_link_csv_provider');

const SCHEMA_VERSION = 1;
const SCHEMA_TYPE = 'koeln-kfz-geometry-record-schema';
const OUTPUT_SCHEMA_VERSION = 1;
const OUTPUT_TYPE = 'koeln-kfz-official-geometry-join';
const PRODUCER_VERSION = '1.0.0';
const SUPPORTED_ENCODINGS = Object.freeze(new Set(['ascii', 'utf-8', 'windows-1252', 'latin1']));
const SUPPORTED_CRS = Object.freeze(new Set(['EPSG:25832', 'EPSG:32632']));

class KoelnKfzGeometryJoinError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'KoelnKfzGeometryJoinError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new KoelnKfzGeometryJoinError(code, message, details);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_value', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredHash(value, label) {
  const text = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    fail('invalid_hash', `${label} must be a lowercase SHA-256 digest`);
  }
  return text;
}

function requiredPositiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    fail('invalid_number', `${label} must be positive`);
  }
  return number;
}

function normalizeTimestamp(value, label) {
  const text = requiredString(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    fail('invalid_timestamp', `${label} must be an ISO timestamp`, { value });
  }
  return new Date(milliseconds).toISOString();
}

function exactKeys(value, expected, label) {
  const object = plainObject(value, label);
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail('invalid_schema', `${label} has unexpected or missing fields`, { expected: wanted, actual });
  }
  return object;
}

function resolveConfinedRegularFile(rootValue, relativeValue, label) {
  const root = fs.realpathSync(path.resolve(requiredString(rootValue, `${label} root`)));
  const relative = requiredString(relativeValue, `${label} path`).replace(/\\/g, '/');
  if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('unsafe_path', `${label} path must be a normalized relative path`, { relative });
  }
  const candidate = path.resolve(root, relative);
  const rel = path.relative(root, candidate);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('unsafe_path', `${label} escapes its root`, { relative });
  }
  let current = root;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail('unsafe_file', `${label} path contains a symbolic link`, { current });
  }
  const stat = fs.statSync(candidate);
  if (!stat.isFile()) fail('unsafe_file', `${label} must be a regular file`, { candidate });
  return Object.freeze({ root, file: fs.realpathSync(candidate), relative: rel.replace(/\\/g, '/') });
}

function loadPinnedSchema(options = {}) {
  const resolved = resolveConfinedRegularFile(options.schemaRoot, options.schemaPath, 'schema');
  const bytes = fs.readFileSync(resolved.file);
  const expected = requiredHash(options.expectedSchemaSha256, 'expectedSchemaSha256');
  const actual = sha256(bytes);
  if (actual !== expected) {
    fail('schema_hash_mismatch', 'geometry schema differs from its external pin', { expected, actual });
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    fail('invalid_schema', 'geometry schema is not valid UTF-8 JSON', { cause: error.message });
  }
  const schema = exactKeys(parsed, [
    'schemaVersion',
    'type',
    'archiveSourceId',
    'archiveSha256',
    'pointSet',
    'lineSet',
    'encoding',
    'crs',
    'maxEndpointDistanceMeters',
  ], 'geometry schema');
  if (schema.schemaVersion !== SCHEMA_VERSION || schema.type !== SCHEMA_TYPE) {
    fail('invalid_schema', 'unsupported geometry schema identity');
  }
  if (schema.archiveSourceId !== archiveProvider.SOURCE_ID ||
      schema.archiveSha256 !== archiveProvider.REVIEWED_DISTRIBUTION_SHA256) {
    fail('invalid_schema', 'geometry schema is bound to another archive', {
      sourceId: schema.archiveSourceId,
      archiveSha256: schema.archiveSha256,
    });
  }
  const pointSet = exactKeys(schema.pointSet, ['id', 'nodeIdField'], 'geometry schema.pointSet');
  const lineSet = exactKeys(
    schema.lineSet,
    ['id', 'segmentIdField', 'fromNodeIdField', 'toNodeIdField'],
    'geometry schema.lineSet',
  );
  const encoding = requiredString(schema.encoding, 'geometry schema.encoding').toLowerCase();
  if (!SUPPORTED_ENCODINGS.has(encoding)) fail('invalid_schema', 'unsupported DBF encoding', { encoding });
  const crs = requiredString(schema.crs, 'geometry schema.crs').toUpperCase();
  if (!SUPPORTED_CRS.has(crs)) fail('invalid_schema', 'unsupported geometry CRS', { crs });
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    type: SCHEMA_TYPE,
    archiveSourceId: schema.archiveSourceId,
    archiveSha256: schema.archiveSha256,
    pointSet: Object.freeze({
      id: requiredString(pointSet.id, 'pointSet.id'),
      nodeIdField: requiredString(pointSet.nodeIdField, 'pointSet.nodeIdField'),
    }),
    lineSet: Object.freeze({
      id: requiredString(lineSet.id, 'lineSet.id'),
      segmentIdField: requiredString(lineSet.segmentIdField, 'lineSet.segmentIdField'),
      fromNodeIdField: requiredString(lineSet.fromNodeIdField, 'lineSet.fromNodeIdField'),
      toNodeIdField: requiredString(lineSet.toNodeIdField, 'lineSet.toNodeIdField'),
    }),
    encoding,
    crs,
    maxEndpointDistanceMeters: requiredPositiveNumber(
      schema.maxEndpointDistanceMeters,
      'geometry schema.maxEndpointDistanceMeters',
    ),
    path: resolved.relative,
    sha256: actual,
  });
}

function zipFiles(buffer) {
  let archive;
  try {
    archive = strictZip.readStrictZip(buffer);
  } catch (error) {
    if (error instanceof strictZip.StrictZipError) {
      fail('invalid_geometry_archive', error.message, { zipCode: error.code, zipDetails: error.details });
    }
    throw error;
  }
  const files = new Map();
  for (const file of archive.files) {
    if (files.has(file.name)) fail('duplicate_archive_file', 'archive contains duplicate path', { path: file.name });
    files.set(file.name, file.data);
  }
  return Object.freeze({ archive, files });
}

function shapeSetById(inspected, schema, role) {
  const id = schema[role].id;
  const matches = inspected.shapeSets.filter(set => set.id === id);
  if (matches.length !== 1) fail('missing_shape_set', `${role} shape set is not uniquely present`, { id });
  const set = matches[0];
  const expectedType = role === 'pointSet' ? 1 : 3;
  if (set.shapeType !== expectedType || set.crs.epsg !== schema.crs) {
    fail('shape_set_contract_mismatch', `${role} differs from schema pin`, {
      id,
      expectedType,
      actualType: set.shapeType,
      expectedCrs: schema.crs,
      actualCrs: set.crs.epsg,
    });
  }
  return set;
}

function componentBytes(files, set, extension) {
  const entry = set.entries.find(value => value.extension === extension);
  if (!entry) fail('missing_shape_component', `${set.id} lacks ${extension}`);
  const bytes = files.get(entry.path);
  if (!bytes || sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) {
    fail('shape_component_drift', `${entry.path} differs from inspected inventory`);
  }
  return bytes;
}

function parseShx(buffer, expectedShapeType, label) {
  const header = archiveProvider.parseShapefileHeader(buffer, label);
  if (header.shapeType !== expectedShapeType) {
    fail('invalid_shx', `${label} declares another shape type`, {
      expectedShapeType,
      actualShapeType: header.shapeType,
    });
  }
  const bodyBytes = buffer.length - 100;
  if (bodyBytes < 8 || bodyBytes % 8 !== 0) {
    fail('invalid_shx', `${label} has invalid record index length`);
  }
  const records = [];
  let previousEnd = 100;
  for (let offset = 100, index = 0; offset < buffer.length; offset += 8, index += 1) {
    const recordOffset = buffer.readInt32BE(offset) * 2;
    const contentBytes = buffer.readInt32BE(offset + 4) * 2;
    if (!Number.isSafeInteger(recordOffset) || !Number.isSafeInteger(contentBytes) ||
        recordOffset < 100 || contentBytes < 4 || recordOffset < previousEnd) {
      fail('invalid_shx', `${label} contains an invalid or overlapping index record`, {
        index,
        recordOffset,
        contentBytes,
        previousEnd,
      });
    }
    records.push(Object.freeze({ recordOffset, contentBytes }));
    previousEnd = recordOffset + 8 + contentBytes;
  }
  return Object.freeze(records);
}

function readShapeRecord(shp, indexEntry, expectedNumber, expectedShapeType, label) {
  const { recordOffset, contentBytes } = indexEntry;
  if (recordOffset + 8 + contentBytes > shp.length) {
    fail('truncated_shp', `${label} record exceeds SHP bytes`);
  }
  const recordNumber = shp.readInt32BE(recordOffset);
  const headerContentBytes = shp.readInt32BE(recordOffset + 4) * 2;
  if (recordNumber !== expectedNumber || headerContentBytes !== contentBytes) {
    fail('shp_shx_mismatch', `${label} SHP record header differs from SHX`, {
      expectedNumber,
      recordNumber,
      expectedBytes: contentBytes,
      actualBytes: headerContentBytes,
    });
  }
  const content = shp.subarray(recordOffset + 8, recordOffset + 8 + contentBytes);
  const shapeType = content.readInt32LE(0);
  if (shapeType !== expectedShapeType) {
    fail('record_shape_type_mismatch', `${label} contains an unexpected record shape type`, {
      expectedShapeType,
      actualShapeType: shapeType,
    });
  }
  return content;
}

function parsePointRecord(content, label) {
  if (content.length !== 20) {
    fail('invalid_point_record', `${label} point record must contain exactly one XY point`);
  }
  const x = content.readDoubleLE(4);
  const y = content.readDoubleLE(12);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    fail('invalid_point_record', `${label} contains non-finite XY`);
  }
  return Object.freeze({ x, y });
}

function parsePolylineRecord(content, label) {
  if (content.length < 48) fail('invalid_polyline_record', `${label} is too short`);
  const partCount = content.readInt32LE(36);
  const pointCount = content.readInt32LE(40);
  if (!Number.isSafeInteger(partCount) || !Number.isSafeInteger(pointCount) ||
      partCount < 1 || pointCount < 2) {
    fail('invalid_polyline_record', `${label} contains invalid part/point counts`, {
      partCount,
      pointCount,
    });
  }
  const expected = 44 + partCount * 4 + pointCount * 16;
  if (content.length !== expected) {
    fail('invalid_polyline_record', `${label} byte length differs from part/point counts`, {
      expected,
      actual: content.length,
    });
  }
  const starts = [];
  for (let index = 0; index < partCount; index += 1) {
    starts.push(content.readInt32LE(44 + index * 4));
  }
  if (starts[0] !== 0 || starts.some((value, index) => value < 0 || value >= pointCount ||
      (index > 0 && value <= starts[index - 1]))) {
    fail('invalid_polyline_record', `${label} contains invalid part offsets`, { starts, pointCount });
  }
  const pointOffset = 44 + partCount * 4;
  const points = [];
  for (let index = 0; index < pointCount; index += 1) {
    const x = content.readDoubleLE(pointOffset + index * 16);
    const y = content.readDoubleLE(pointOffset + index * 16 + 8);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      fail('invalid_polyline_record', `${label} contains non-finite XY`);
    }
    points.push(Object.freeze({ x, y }));
  }
  const parts = starts.map((start, index) =>
    Object.freeze(points.slice(start, starts[index + 1] ?? pointCount)));
  if (parts.some(part => part.length < 2)) {
    fail('invalid_polyline_record', `${label} contains a part with fewer than two points`);
  }
  return Object.freeze(parts);
}

function decodeDbfField(bytes, encoding, label) {
  if (encoding === 'ascii') {
    if ([...bytes].some(byte => byte !== 0 && (byte < 0x20 || byte > 0x7e))) {
      fail('invalid_dbf_text', `${label} contains non-ASCII bytes`);
    }
    return bytes.toString('ascii').trim();
  }
  const decoderName = encoding === 'latin1' ? 'windows-1252' : encoding;
  try {
    return new TextDecoder(decoderName, { fatal: encoding === 'utf-8' }).decode(bytes).trim();
  } catch (error) {
    fail('invalid_dbf_text', `${label} cannot be decoded`, { cause: error.message });
  }
}

function decodeDbfRows(buffer, schemaFields, encoding, label) {
  const header = archiveProvider.parseDbfHeader(buffer, label);
  const offsets = new Map();
  let cursor = 1;
  for (const field of header.fields) {
    offsets.set(field.name, Object.freeze({ ...field, offset: cursor }));
    cursor += field.length;
  }
  if (cursor !== header.recordBytes) {
    fail('dbf_record_layout_mismatch', `${label} field lengths differ from recordBytes`, {
      fieldsBytes: cursor,
      recordBytes: header.recordBytes,
    });
  }
  for (const fieldName of schemaFields) {
    if (!offsets.has(fieldName)) {
      fail('missing_dbf_field', `${label} lacks schema field ${fieldName}`);
    }
  }
  const rows = [];
  for (let index = 0; index < header.recordCount; index += 1) {
    const start = header.headerBytes + index * header.recordBytes;
    const record = buffer.subarray(start, start + header.recordBytes);
    if (record[0] !== 0x20) {
      fail('unsupported_dbf_record_state', `${label} record ${index + 1} is deleted or invalid`, {
        flag: record[0],
      });
    }
    const row = {};
    for (const fieldName of schemaFields) {
      const field = offsets.get(fieldName);
      const value = decodeDbfField(
        record.subarray(field.offset, field.offset + field.length),
        encoding,
        `${label} record ${index + 1} field ${fieldName}`,
      );
      if (!value) {
        fail('empty_dbf_value', `${label} record ${index + 1} field ${fieldName} is empty`);
      }
      row[fieldName] = value;
    }
    rows.push(Object.freeze(row));
  }
  return Object.freeze({ header, rows: Object.freeze(rows) });
}

function readPointRecords(shp, shx, dbf, schema, set) {
  const index = parseShx(shx, 1, `${set.id}.shx`);
  const decoded = decodeDbfRows(
    dbf,
    [schema.pointSet.nodeIdField],
    schema.encoding,
    `${set.id}.dbf`,
  );
  if (index.length !== decoded.rows.length || index.length !== set.recordCount) {
    fail('record_count_mismatch', 'point SHX/SHP/DBF record counts differ', {
      shx: index.length,
      dbf: decoded.rows.length,
      inspected: set.recordCount,
    });
  }
  return Object.freeze(index.map((entry, offset) => Object.freeze({
    row: decoded.rows[offset],
    point: parsePointRecord(
      readShapeRecord(shp, entry, offset + 1, 1, set.id),
      `${set.id} record ${offset + 1}`,
    ),
  })));
}

function readLineRecords(shp, shx, dbf, schema, set) {
  const index = parseShx(shx, 3, `${set.id}.shx`);
  const fields = [
    schema.lineSet.segmentIdField,
    schema.lineSet.fromNodeIdField,
    schema.lineSet.toNodeIdField,
  ];
  const decoded = decodeDbfRows(dbf, fields, schema.encoding, `${set.id}.dbf`);
  if (index.length !== decoded.rows.length || index.length !== set.recordCount) {
    fail('record_count_mismatch', 'line SHX/SHP/DBF record counts differ', {
      shx: index.length,
      dbf: decoded.rows.length,
      inspected: set.recordCount,
    });
  }
  return Object.freeze(index.map((entry, offset) => Object.freeze({
    row: decoded.rows[offset],
    parts: parsePolylineRecord(
      readShapeRecord(shp, entry, offset + 1, 3, set.id),
      `${set.id} record ${offset + 1}`,
    ),
  })));
}

function distanceMeters(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y);
}

function connectParts(parts, tolerance, label) {
  const output = [...parts[0]];
  for (let index = 1; index < parts.length; index += 1) {
    const part = parts[index];
    const end = output[output.length - 1];
    const direct = distanceMeters(end, part[0]);
    const reverse = distanceMeters(end, part[part.length - 1]);
    if (Math.min(direct, reverse) > tolerance) {
      fail('disconnected_multipart', `${label} contains disconnected multipart geometry`, {
        part: index + 1,
        direct,
        reverse,
        tolerance,
      });
    }
    const oriented = direct <= reverse ? part : [...part].reverse();
    output.push(...oriented.slice(distanceMeters(end, oriented[0]) <= 0.001 ? 1 : 0));
  }
  return Object.freeze(output);
}

function stableSegment(value) {
  return requiredString(value, 'segment ID').replace(/[^A-Za-z0-9._-]+/g, '_');
}

function validateNodeId(value, label) {
  const text = requiredString(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    fail('invalid_node_id', `${label} contains unsupported characters`, { value });
  }
  return text;
}

function directedGeometryKey(segment, fromNode, toNode) {
  return `${stableSegment(segment)}:${validateNodeId(fromNode, 'from-node ID')}->${validateNodeId(toNode, 'to-node ID')}`;
}

function buildOfficialGeometryIndex(pointRecords, lineRecords, schema) {
  const nodes = new Map();
  for (const record of pointRecords) {
    const id = validateNodeId(record.row[schema.pointSet.nodeIdField], 'node ID');
    if (nodes.has(id)) fail('duplicate_node', 'point set contains a duplicate node ID', { id });
    nodes.set(id, record.point);
  }
  const lines = new Map();
  for (let index = 0; index < lineRecords.length; index += 1) {
    const record = lineRecords[index];
    const segment = stableSegment(record.row[schema.lineSet.segmentIdField]);
    const fromNode = validateNodeId(record.row[schema.lineSet.fromNodeIdField], 'line from-node ID');
    const toNode = validateNodeId(record.row[schema.lineSet.toNodeIdField], 'line to-node ID');
    if (fromNode === toNode) {
      fail('invalid_line_nodes', 'line from/to node IDs must differ', { segment, fromNode });
    }
    const fromPoint = nodes.get(fromNode);
    const toPoint = nodes.get(toNode);
    if (!fromPoint || !toPoint) {
      fail('missing_line_node', 'line references a node absent from point set', {
        segment,
        fromNode,
        toNode,
      });
    }
    const connected = connectParts(record.parts, schema.maxEndpointDistanceMeters, `segment ${segment}`);
    const first = connected[0];
    const last = connected[connected.length - 1];
    const directStart = distanceMeters(first, fromPoint);
    const directEnd = distanceMeters(last, toPoint);
    const reverseStart = distanceMeters(last, fromPoint);
    const reverseEnd = distanceMeters(first, toPoint);
    const sourceOrientationReversed = reverseStart + reverseEnd < directStart + directEnd;
    const oriented = sourceOrientationReversed
      ? Object.freeze([...connected].reverse())
      : connected;
    const startDistance = sourceOrientationReversed ? reverseStart : directStart;
    const endDistance = sourceOrientationReversed ? reverseEnd : directEnd;
    if (startDistance > schema.maxEndpointDistanceMeters ||
        endDistance > schema.maxEndpointDistanceMeters) {
      fail('line_endpoint_mismatch', 'line endpoints do not match referenced official nodes', {
        segment,
        fromNode,
        toNode,
        startDistance,
        endDistance,
        tolerance: schema.maxEndpointDistanceMeters,
      });
    }
    const directKey = directedGeometryKey(segment, fromNode, toNode);
    const reverseKey = directedGeometryKey(segment, toNode, fromNode);
    for (const key of [directKey, reverseKey]) {
      if (lines.has(key)) {
        fail('duplicate_direction_geometry', 'official geometry produces a duplicate directed key', { key });
      }
    }
    const common = Object.freeze({
      segment,
      recordNumber: index + 1,
      sourceOrientationReversed,
    });
    lines.set(directKey, Object.freeze({
      ...common,
      fromNode,
      toNode,
      points: oriented,
      endpointDistanceMeters: Object.freeze({ start: startDistance, end: endDistance }),
    }));
    lines.set(reverseKey, Object.freeze({
      ...common,
      fromNode: toNode,
      toNode: fromNode,
      points: Object.freeze([...oriented].reverse()),
      endpointDistanceMeters: Object.freeze({ start: endDistance, end: startDistance }),
    }));
  }
  return Object.freeze({ nodes, lines });
}

function utm32ToWgs84(point, crs) {
  const a = 6378137;
  const flattening = crs === 'EPSG:25832' ? 1 / 298.257222101 : 1 / 298.257223563;
  const e2 = flattening * (2 - flattening);
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const x = point.x - 500000;
  const y = point.y;
  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 = mu +
    (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu) +
    (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu) +
    (151 * e1 ** 3 / 96) * Math.sin(6 * mu) +
    (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
  const sinPhi = Math.sin(phi1);
  const cosPhi = Math.cos(phi1);
  const tanPhi = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sinPhi ** 2);
  const r1 = a * (1 - e2) / (1 - e2 * sinPhi ** 2) ** 1.5;
  const t1 = tanPhi ** 2;
  const c1 = ep2 * cosPhi ** 2;
  const d = x / (n1 * k0);
  const latitude = phi1 - (n1 * tanPhi / r1) * (
    d ** 2 / 2 -
    (5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4 / 24 +
    (61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6 / 720
  );
  const longitude = 9 * Math.PI / 180 + (
    d - (1 + 2 * t1 + c1) * d ** 3 / 6 +
    (5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5 / 120
  ) / cosPhi;
  const lat = latitude * 180 / Math.PI;
  const lon = longitude * 180 / Math.PI;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < 45 || lat > 60 || lon < 4 || lon > 16) {
    fail('coordinate_transform_out_of_range', 'UTM coordinate does not transform into the supported Germany extent', {
      point,
      crs,
      lat,
      lon,
    });
  }
  return Object.freeze({ lat, lon });
}

function parseSyntheticWayId(value) {
  const text = requiredString(value, 'observation wayId');
  const match = /^koeln-segment:([^:]+):(forward|reverse):([A-Za-z0-9._-]+)->([A-Za-z0-9._-]+)$/.exec(text);
  if (!match) {
    fail('invalid_observation_way_id', 'observation does not carry the reviewed Cologne synthetic segment identity', {
      value,
    });
  }
  const segment = stableSegment(match[1]);
  const fromNode = validateNodeId(match[3], 'observation from-node ID');
  const toNode = validateNodeId(match[4], 'observation to-node ID');
  return Object.freeze({
    segment,
    directionCode: match[2],
    fromNode,
    toNode,
    key: directedGeometryKey(segment, fromNode, toNode),
  });
}

function joinObservations(observations, geometryIndex, schema) {
  if (!Array.isArray(observations) || observations.length === 0) {
    fail('empty_observations', 'traffic observations are required');
  }
  const joined = [];
  const missing = [];
  for (const observation of observations) {
    const identity = parseSyntheticWayId(observation.wayId);
    const geometry = geometryIndex.lines.get(identity.key);
    if (!geometry) {
      missing.push(Object.freeze({ observationId: observation.observationId, key: identity.key }));
      continue;
    }
    const coordinates = geometry.points.map(point => {
      const transformed = utm32ToWgs84(point, schema.crs);
      return Object.freeze([transformed.lon, transformed.lat]);
    });
    joined.push(Object.freeze({
      ...observation,
      geometry: Object.freeze({ type: 'LineString', coordinates: Object.freeze(coordinates) }),
      officialGeometry: Object.freeze({
        sourceId: archiveProvider.SOURCE_ID,
        segment: geometry.segment,
        directionCode: identity.directionCode,
        fromNode: identity.fromNode,
        toNode: identity.toNode,
        recordNumber: geometry.recordNumber,
        sourceOrientationReversed: geometry.sourceOrientationReversed,
        endpointDistanceMeters: geometry.endpointDistanceMeters,
        schemaSha256: schema.sha256,
        crs: schema.crs,
        transform: 'utm-zone-32-to-wgs84-v1',
      }),
      qualityNotes: Object.freeze([
        ...(Array.isArray(observation.qualityNotes) ? observation.qualityNotes : []),
        'Amtliche Kölner Liniengeometrie über Segment- und Knotenkennungen positionsgleich verbunden.',
        'Noch keine OpenStreetMap-Zuordnung; wayId bleibt die synthetische Kölner Segmentkennung.',
      ]),
    }));
  }
  if (missing.length) {
    fail('observation_geometry_coverage_mismatch', 'not every traffic observation has official geometry', {
      missingCount: missing.length,
      sample: missing.slice(0, 20),
    });
  }
  return Object.freeze(joined);
}

async function buildJoinedArtifact(options = {}) {
  const schema = loadPinnedSchema(options);
  const loadedArchive = archiveProvider.loadVerifiedGeometryArchive({
    allowedRoot: options.archiveRoot,
    archivePath: options.archivePath,
    expectedDistributionSha256: options.expectedArchiveSha256,
    expectedBytes: options.expectedArchiveBytes,
    retrievedAt: options.archiveRetrievedAt,
  });
  if (loadedArchive.sha256 !== schema.archiveSha256) {
    fail('schema_archive_mismatch', 'verified archive differs from schema pin');
  }
  const archiveBytes = fs.readFileSync(loadedArchive.file);
  const zipped = zipFiles(archiveBytes);
  const pointSet = shapeSetById(loadedArchive.inspected, schema, 'pointSet');
  const lineSet = shapeSetById(loadedArchive.inspected, schema, 'lineSet');
  const points = readPointRecords(
    componentBytes(zipped.files, pointSet, '.shp'),
    componentBytes(zipped.files, pointSet, '.shx'),
    componentBytes(zipped.files, pointSet, '.dbf'),
    schema,
    pointSet,
  );
  const lines = readLineRecords(
    componentBytes(zipped.files, lineSet, '.shp'),
    componentBytes(zipped.files, lineSet, '.shx'),
    componentBytes(zipped.files, lineSet, '.dbf'),
    schema,
    lineSet,
  );
  const geometryIndex = buildOfficialGeometryIndex(points, lines, schema);
  const traffic = linkProvider.createKoelnKfzLinkCsvProvider({
    allowedRoot: options.csvRoot,
    csvPath: options.csvPath,
    expectedDistributionSha256: options.expectedCsvSha256,
    expectedBytes: options.expectedCsvBytes,
    retrievedAt: options.csvRetrievedAt,
  });
  const observations = await traffic.loadObservations({ city: 'Köln' });
  const joined = joinObservations(observations, geometryIndex, schema);
  return Object.freeze({
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    type: OUTPUT_TYPE,
    producerVersion: PRODUCER_VERSION,
    generatedAt: normalizeTimestamp(options.generatedAt, 'generatedAt'),
    source: Object.freeze({
      traffic: traffic.descriptor,
      trafficDistribution: traffic.distribution,
      geometry: Object.freeze({
        id: archiveProvider.SOURCE_ID,
        datasetUrl: loadedArchive.datasetUrl,
        distributionUrl: loadedArchive.distributionUrl,
        licenseId: loadedArchive.licenseId,
        licenseName: loadedArchive.licenseName,
        retrievedAt: loadedArchive.retrievedAt,
        archive: Object.freeze({
          path: loadedArchive.relativePath,
          sha256: loadedArchive.sha256,
          bytes: loadedArchive.bytes,
        }),
        schema: Object.freeze({ path: schema.path, sha256: schema.sha256 }),
      }),
    }),
    coverage: Object.freeze({
      pointRecords: points.length,
      lineRecords: lines.length,
      directionalGeometries: geometryIndex.lines.size,
      trafficObservations: observations.length,
      joinedObservations: joined.length,
      unmatchedObservations: 0,
    }),
    observations: joined,
    truthBoundary: Object.freeze({
      dbfRowsInterpreted: true,
      coordinatesTransformed: true,
      linkValuesJoined: true,
      officialDirectionValidated: true,
      osmMatched: false,
    }),
  });
}

function writeAtomic(fileValue, value) {
  const target = path.resolve(requiredString(fileValue, 'outputFile'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const parent = fs.realpathSync(path.dirname(target));
  const output = path.join(parent, path.basename(target));
  if (fs.existsSync(output)) {
    const stat = fs.lstatSync(output);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('unsafe_output', 'outputFile must be a regular non-symlink file');
    }
  }
  const temporary = `${output}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return output;
}

function parseArgs(argv) {
  const options = { json: false };
  const names = new Map([
    ['--schema-root', 'schemaRoot'],
    ['--schema', 'schemaPath'],
    ['--schema-sha256', 'expectedSchemaSha256'],
    ['--archive-root', 'archiveRoot'],
    ['--archive', 'archivePath'],
    ['--archive-sha256', 'expectedArchiveSha256'],
    ['--archive-bytes', 'expectedArchiveBytes'],
    ['--archive-retrieved-at', 'archiveRetrievedAt'],
    ['--csv-root', 'csvRoot'],
    ['--csv', 'csvPath'],
    ['--csv-sha256', 'expectedCsvSha256'],
    ['--csv-bytes', 'expectedCsvBytes'],
    ['--csv-retrieved-at', 'csvRetrievedAt'],
    ['--generated-at', 'generatedAt'],
    ['--output', 'outputFile'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (names.has(argument)) {
      const field = names.get(argument);
      const value = argv[++index];
      options[field] = /Bytes$/.test(field) ? Number(value) : value;
    } else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(
      'Usage: node scripts/providers/koeln_kfz_geometry_record_join_provider.js ' +
      '--schema-root <root> --schema <json> --schema-sha256 <sha> ' +
      '--archive-root <root> --archive <zip> --archive-sha256 <sha> --archive-bytes <n> ' +
      '--archive-retrieved-at <ISO> --csv-root <root> --csv <file> --csv-sha256 <sha> ' +
      '--csv-bytes <n> --csv-retrieved-at <ISO> --generated-at <ISO> --output <json> [--json]\n',
    );
    return 0;
  }
  const required = [
    'schemaRoot', 'schemaPath', 'expectedSchemaSha256', 'archiveRoot', 'archivePath',
    'expectedArchiveSha256', 'expectedArchiveBytes', 'archiveRetrievedAt', 'csvRoot',
    'csvPath', 'expectedCsvSha256', 'expectedCsvBytes', 'csvRetrievedAt', 'generatedAt',
    'outputFile',
  ];
  for (const field of required) {
    if (options[field] == null || options[field] === '') {
      fail('missing_argument', `${field} is required`);
    }
  }
  const artifact = await buildJoinedArtifact(options);
  const outputFile = writeAtomic(options.outputFile, artifact);
  const result = Object.freeze({
    outputFile,
    outputSha256: sha256(fs.readFileSync(outputFile)),
    joinedObservations: artifact.coverage.joinedObservations,
  });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`[koeln-kfz-geometry-join] ${result.joinedObservations} observations → ${outputFile}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  SCHEMA_TYPE,
  OUTPUT_SCHEMA_VERSION,
  OUTPUT_TYPE,
  PRODUCER_VERSION,
  SUPPORTED_ENCODINGS,
  SUPPORTED_CRS,
  KoelnKfzGeometryJoinError,
  sha256,
  plainObject,
  requiredString,
  requiredHash,
  requiredPositiveNumber,
  normalizeTimestamp,
  exactKeys,
  resolveConfinedRegularFile,
  loadPinnedSchema,
  zipFiles,
  shapeSetById,
  componentBytes,
  parseShx,
  readShapeRecord,
  parsePointRecord,
  parsePolylineRecord,
  decodeDbfField,
  decodeDbfRows,
  readPointRecords,
  readLineRecords,
  distanceMeters,
  connectParts,
  stableSegment,
  validateNodeId,
  directedGeometryKey,
  buildOfficialGeometryIndex,
  utm32ToWgs84,
  parseSyntheticWayId,
  joinObservations,
  buildJoinedArtifact,
  writeAtomic,
  parseArgs,
  main,
});
