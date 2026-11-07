'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const { promisify, TextDecoder } = require('node:util');
const zlib = require('node:zlib');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const SCHEMA_VERSION = 1;
const MAX_RECORDS = 50_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const MAX_GZIP_BYTES = 5 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_FIELD_LENGTH = 4096;
const RIS_FALLBACK_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_REFRESH_FAILURE_REASON_LENGTH = 240;
// Pin the production adapters; new cities use the hosts declared by their collector.
const OFFICIAL_HOSTS = new Map([
  ['bonn', new Set(['www.bonn.sitzung-online.de', 'bonn.sitzung-online.de', 'www2.bonn.de'])],
  ['hannover', new Set(['e-government.hannover-stadt.de'])],
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertCity(city) {
  if (typeof city !== 'string' || city.length > 80 || !/^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(city)) {
    throw new Error('Invalid RIS city slug');
  }
}

function safeUrlHost(value) {
  if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)) {
    return null;
  }
  const authority = /^https:\/\/([^/?#]+)/i.exec(value);
  if (!authority || authority[1].includes('@')) return null;
  try {
    const url = new URL(value);
    const domain = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;
    return !url.port && domain.test(url.hostname) ? url.hostname : null;
  } catch {
    return null;
  }
}

function normalizeSources(values, city) {
  if (!Array.isArray(values) || !values.length) throw new Error('RIS sources are required');
  const official = OFFICIAL_HOSTS.get(city);
  const hosts = new Set();
  const sources = [...new Set(values)];
  for (const source of sources) {
    const host = safeUrlHost(source);
    if (!host || (official && !official.has(host))) throw new Error('Invalid official HTTPS URL in RIS sources');
    hosts.add(host);
  }
  return { sources, hosts };
}

function normalizedText(value) {
  if (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH) return '';
  return value.replace(/[\s\u0000-\u001f\u007f-\u009f]+/gu, ' ').trim();
}

function requiredText(value, field) {
  const text = normalizedText(value);
  if (!text) throw new Error(`Invalid RIS ${field}`);
  return text;
}

function nullableText(value, field) {
  return value == null || value === '' ? null : requiredText(value, field);
}

function sourceId(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_FIELD_LENGTH || value.trim() !== value || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) {
    throw new Error('Invalid RIS source ID');
  }
  return value;
}

function dateOnly(value, field) {
  if (value === null) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value) return value;
  }
  throw new Error(`Invalid RIS ${field}; expected YYYY-MM-DD or null`);
}

function timestamp(value, field = 'generation timestamp', canonical = false) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      const normalized = date.toISOString();
      if (value === normalized || (!canonical && value === normalized.replace('.000Z', 'Z'))) return value;
    }
  }
  throw new Error(`Invalid RIS ${field}`);
}

function normalizeRefreshFailure(value, generatedAt) {
  if (!isObject(value)) throw new Error('Invalid RIS refresh failure metadata');
  const { reason } = value;
  if (typeof reason !== 'string' || !reason || reason.length > MAX_REFRESH_FAILURE_REASON_LENGTH ||
      reason !== normalizedText(reason) || /[<>\p{Cf}\p{Cs}]/u.test(reason)) {
    throw new Error('Invalid RIS refresh failure reason');
  }
  const attemptedAt = timestamp(value.attemptedAt, 'refresh failure attempt timestamp', true);
  const expiresAt = timestamp(value.expiresAt, 'refresh failure expiry timestamp', true);
  const generated = Date.parse(generatedAt);
  const attempted = Date.parse(attemptedAt);
  const expiry = Date.parse(expiresAt);
  if (attempted < generated || attempted >= expiry || expiry !== generated + RIS_FALLBACK_MAX_AGE_MS) {
    throw new Error('Invalid RIS refresh failure time range');
  }
  return { attemptedAt, reason, expiresAt };
}

function normalizeCoverage(value) {
  if (!isObject(value) || typeof value.complete !== 'boolean' || !Array.isArray(value.bodies) || !Array.isArray(value.warnings)) {
    throw new Error('Invalid RIS coverage');
  }
  const from = dateOnly(value.from, 'coverage start');
  const to = dateOnly(value.to, 'coverage end');
  if (from && to && from > to) throw new Error('RIS coverage start is after its end');
  return {
    from,
    to,
    bodies: Array.from(value.bodies, body => requiredText(body, 'coverage body')),
    complete: value.complete,
    warnings: Array.from(value.warnings, warning => requiredText(warning, 'coverage warning')),
  };
}

function normalizeRecords(values, hosts, count) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_RECORDS || (count !== undefined && values.length !== count)) {
    throw new Error('Invalid RIS record count');
  }
  const ids = new Set();
  const records = Array.from(values, value => {
    if (!isObject(value)) throw new Error('Invalid RIS record');
    const id = sourceId(value.id);
    if (ids.has(id)) throw new Error('Duplicate RIS record ID');
    ids.add(id);
    if (!hosts.has(safeUrlHost(value.url))) throw new Error('RIS citation must use a declared official HTTPS source host');
    const record = {
      id,
      title: requiredText(value.title, 'record title'),
      type: requiredText(value.type, 'record type'),
      number: nullableText(value.number, 'record number'),
      date: dateOnly(value.date, 'record date'),
      gremium: nullableText(value.gremium, 'record gremium'),
      url: value.url,
      source: requiredText(value.source, 'record source'),
    };
    if (value.relatedTo != null) record.relatedTo = sourceId(value.relatedTo);
    return record;
  });
  return { records, ids };
}

function listOf(values, minimum, validItem) {
  if (!Array.isArray(values) || values.length < minimum) return false;
  for (const value of values) if (!validItem(value)) return false;
  return true;
}

function position(value) {
  return Array.isArray(value) && (value.length === 2 || value.length === 3) &&
    listOf(value, 2, Number.isFinite) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

const line = value => listOf(value, 2, position);
function ring(value) {
  if (!listOf(value, 4, position)) return false;
  const first = value[0];
  const last = value[value.length - 1];
  return first.length === last.length && first.every((coordinate, i) => coordinate === last[i]);
}
const polygon = value => listOf(value, 1, ring);
const geometryValidators = new Map([
  ['Point', position],
  ['MultiPoint', value => listOf(value, 1, position)],
  ['LineString', line],
  ['MultiLineString', value => listOf(value, 1, line)],
  ['Polygon', polygon],
  ['MultiPolygon', value => listOf(value, 1, polygon)],
]);

function mapFeature(recordId, geometry, accuracy, label) {
  const valid = isObject(geometry) && !Object.hasOwn(geometry, 'crs') && geometryValidators.get(geometry.type);
  if (!valid || !valid(geometry.coordinates) || (accuracy !== 'official' && accuracy !== 'derived')) return null;
  const properties = { recordId, accuracy };
  const location = normalizedText(label);
  if (location) properties.label = location;
  return { type: 'Feature', geometry: { type: geometry.type, coordinates: geometry.coordinates }, properties };
}

function normalizeMap(value, recordIds, count) {
  if (!isObject(value) || value.type !== 'FeatureCollection' || Object.hasOwn(value, 'crs') ||
      !Array.isArray(value.features) || value.features.length !== count) {
    throw new Error('Invalid RIS map feature count or collection');
  }
  const seen = new Set();
  const features = value.features.map(feature => {
    if (!isObject(feature) || feature.type !== 'Feature' || Object.hasOwn(feature, 'crs') || !isObject(feature.properties)) {
      throw new Error('Invalid RIS map feature');
    }
    const { recordId, accuracy, label } = feature.properties;
    if (!recordIds.has(recordId) || seen.has(recordId)) throw new Error('RIS map feature must refer to a unique record');
    seen.add(recordId);
    const normalized = mapFeature(recordId, feature.geometry, accuracy, label);
    if (!normalized) throw new Error('Invalid RIS map geometry or accuracy');
    return normalized;
  });
  return { type: 'FeatureCollection', features };
}

function assetPath(city, kind, hash) {
  return `${city}.${hash}.${kind}.json.gz`;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeDescriptor(value, city, kind, minimum, maximum) {
  if (!isObject(value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      value.path !== assetPath(city, kind, value.sha256) ||
      !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > MAX_JSON_BYTES ||
      !Number.isSafeInteger(value.count) || value.count < minimum || value.count > maximum) {
    throw new Error(`Invalid RIS ${kind} asset descriptor`);
  }
  return { path: value.path, sha256: value.sha256, bytes: value.bytes, count: value.count };
}

async function encodeAsset(city, kind, rows) {
  const [prefix, suffix] = kind === 'records' ? ['[', ']'] : ['{"type":"FeatureCollection","features":[', ']}'];
  const entries = [];
  let length = prefix.length + suffix.length;
  for (const row of rows) {
    const json = JSON.stringify(row);
    length += Buffer.byteLength(json) + (entries.length ? 1 : 0);
    if (length > MAX_JSON_BYTES) throw new Error(`RIS ${kind} exceeds the decoded size limit`);
    entries.push(json);
  }
  const raw = Buffer.from(prefix + entries.join(',') + suffix);
  const bytes = await gzip(raw);
  if (bytes.length > MAX_GZIP_BYTES) throw new Error(`RIS ${kind} exceeds the compressed size limit`);
  const sha256 = digest(raw);
  const reference = { path: assetPath(city, kind, sha256), sha256, bytes: raw.length, count: rows.length };
  return { bytes, reference };
}

async function readBounded(filename, maximum, kind) {
  if (!constants.O_NOFOLLOW && (await fs.lstat(filename)).isSymbolicLink()) throw new Error(`Invalid RIS ${kind} symlink`);
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  const file = await fs.open(filename, flags);
  try {
    const stat = await file.stat();
    const { size } = stat;
    if (size <= 0 || size > maximum || !stat.isFile()) throw new Error(`Invalid RIS ${kind} file size or type`);
    const bytes = Buffer.allocUnsafe(size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== size) throw new Error(`RIS ${kind} file size changed while reading`);
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}

function decodeJson(bytes, kind) {
  try {
    return JSON.parse(utf8.decode(bytes));
  } catch (error) {
    throw new Error(`Invalid UTF-8 JSON in RIS ${kind}`, { cause: error });
  }
}

async function readAsset(directory, reference, kind) {
  let compressed;
  try {
    compressed = await readBounded(path.join(directory, reference.path), MAX_GZIP_BYTES, kind);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Missing RIS ${kind} asset: ${reference.path}`, { cause: error });
    throw error;
  }
  let raw;
  try {
    raw = await gunzip(compressed, { maxOutputLength: reference.bytes });
  } catch (error) {
    throw new Error(`Invalid RIS ${kind} gzip data or decoded size`, { cause: error });
  }
  if (raw.length !== reference.bytes || digest(raw) !== reference.sha256) {
    throw new Error(`RIS ${kind} asset integrity check failed (decoded size or hash)`);
  }
  return decodeJson(raw, kind);
}

async function withTemporaryFile(directory, filename, bytes, install) {
  const temporary = path.join(directory, `.${filename}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx' });
    await install(temporary, path.join(directory, filename));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function installAsset(directory, { bytes, reference }, kind) {
  await withTemporaryFile(directory, reference.path, bytes, async (temporary, destination) => {
    try {
      // An existing reader may still hold a manifest pointing to this file.
      await fs.link(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await readAsset(directory, reference, kind);
    }
  });
}

/** Write immutable assets first and publish their manifest in a single rename. */
async function writeRisSnapshot(directory, city, catalogue, { now = Date.now } = {}) {
  assertCity(city);
  if (!isObject(catalogue)) throw new Error('Invalid RIS catalogue');
  const { sources, hosts } = normalizeSources(catalogue.sources, city);
  const coverage = normalizeCoverage(catalogue.coverage);
  const { records } = normalizeRecords(catalogue.records, hosts);
  const features = records.flatMap(({ id }, index) => {
    const { geometry, locationSource, locationLabel } = catalogue.records[index];
    const feature = mapFeature(id, geometry, locationSource, locationLabel);
    return feature ? [feature] : [];
  });
  const date = new Date(typeof now === 'function' ? now() : now);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid RIS generation timestamp');
  const generatedAt = timestamp(date.toISOString());

  const [recordsAsset, mapAsset] = await Promise.all([
    encodeAsset(city, 'records', records),
    encodeAsset(city, 'map', features),
  ]);
  const manifest = {
    schemaVersion: SCHEMA_VERSION, city, generatedAt, sources, coverage,
    records: recordsAsset.reference, map: mapAsset.reference,
  };
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('RIS manifest exceeds its size limit');

  await fs.mkdir(directory, { recursive: true });
  await installAsset(directory, recordsAsset, 'records');
  await installAsset(directory, mapAsset, 'map');
  await withTemporaryFile(directory, `${city}.json`, bytes, fs.rename);
  return manifest;
}

/** Verify the manifest and its assets, including expired snapshots used as a coverage baseline. */
async function readRisSnapshot(directory, city) {
  assertCity(city);
  const bytes = await readBounded(path.join(directory, `${city}.json`), MAX_MANIFEST_BYTES, 'manifest');
  const value = decodeJson(bytes, 'manifest');
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported RIS snapshot schema version');
  if (value.city !== city) throw new Error('RIS snapshot city does not match the requested city');
  const generatedAt = timestamp(value.generatedAt);
  const refreshFailure = Object.hasOwn(value, 'refreshFailure') ? normalizeRefreshFailure(value.refreshFailure, generatedAt) : null;
  const { sources, hosts } = normalizeSources(value.sources, city);
  const coverage = normalizeCoverage(value.coverage);
  const recordsAsset = normalizeDescriptor(value.records, city, 'records', 1, MAX_RECORDS);
  const mapAsset = normalizeDescriptor(value.map, city, 'map', 0, recordsAsset.count);
  const [rows, map] = await Promise.all([
    readAsset(directory, recordsAsset, 'records'),
    readAsset(directory, mapAsset, 'map'),
  ]);
  const { records, ids } = normalizeRecords(rows, hosts, recordsAsset.count);
  const features = normalizeMap(map, ids, mapAsset.count);
  const manifest = {
    schemaVersion: SCHEMA_VERSION, city, generatedAt, sources, coverage,
    records: recordsAsset, map: mapAsset,
    ...(refreshFailure ? { refreshFailure } : {}),
  };
  return { manifest, records, features };
}

module.exports = { writeRisSnapshot, readRisSnapshot, RIS_FALLBACK_MAX_AGE_MS };
