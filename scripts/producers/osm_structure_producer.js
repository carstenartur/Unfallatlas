#!/usr/bin/env node
'use strict';

/**
 * Completes an existing osm_<city>.json artifact with structure-relevant OSM
 * way tags needed before a terrain model may be interpreted as road surface.
 *
 * The geometry producer intentionally stays unchanged. This postprocessor
 * queries only the already selected way IDs and requests tags without node or
 * geometry payloads. Publication is atomic and exact coverage is mandatory:
 * absence of a tag is meaningful only after every requested way was returned.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const osmProducer = require('./osm_producer');

const PRODUCER_VERSION = '1.0.0';
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_INTER_BATCH_DELAY_MS = 250;
const STRUCTURE_FIELDS = Object.freeze([
  'bridge',
  'tunnel',
  'layer',
  'embankment',
  'cutting',
]);

class OsmStructureProducerError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'OsmStructureProducerError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new OsmStructureProducerError(code, message, details);
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`);
  }
  return value;
}

function safePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail('invalid_integer', `${label} must be a positive safe integer`, { value });
  }
  return number;
}

function isoTimestamp(value, label) {
  const text = String(value || '').trim();
  const milliseconds = Date.parse(text);
  if (!text || !Number.isFinite(milliseconds)) {
    fail('invalid_timestamp', `${label} must be an ISO timestamp`, { value });
  }
  return new Date(milliseconds).toISOString();
}

function normalizeWayId(value, label) {
  const text = String(value == null ? '' : value).trim();
  if (!/^[1-9]\d*$/.test(text)) {
    fail('invalid_way_id', `${label} must be a positive decimal OSM way ID`, { value });
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number)) {
    fail('invalid_way_id', `${label} exceeds JavaScript's safe integer range`, { value });
  }
  return text;
}

function normalizeWayIds(osm) {
  const ways = plainObject(plainObject(osm, 'OSM dataset').ways, 'OSM dataset.ways');
  const ids = Object.keys(ways).map((id, index) => normalizeWayId(id, `way ID ${index}`));
  if (ids.length === 0) fail('empty_way_set', 'OSM dataset contains no ways');
  ids.sort((left, right) => Number(left) - Number(right));
  return Object.freeze(ids);
}

function batches(values, sizeValue) {
  const size = safePositiveInteger(sizeValue, 'batch size');
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(Object.freeze(values.slice(index, index + size)));
  }
  return Object.freeze(result);
}

function buildOverpassQuery(wayIds, options = {}) {
  if (!Array.isArray(wayIds) || wayIds.length === 0) {
    fail('empty_way_set', 'Overpass query requires at least one way ID');
  }
  const normalized = wayIds.map((id, index) => normalizeWayId(id, `wayIds[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail('duplicate_way_id', 'Overpass query way IDs must be unique');
  }
  const timeoutSeconds = Math.max(30, Math.floor(
    Number.isFinite(options.timeoutMs) ? options.timeoutMs / 1000 : 180,
  ));
  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    `way(id:${normalized.join(',')});`,
    'out tags;',
  ].join('\n');
}

function normalizeTagValue(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function parseStructureResponse(response, requestedIds) {
  const requested = new Set(
    requestedIds.map((id, index) => normalizeWayId(id, `requestedIds[${index}]`)),
  );
  const elements = response && Array.isArray(response.elements) ? response.elements : null;
  if (!elements) fail('invalid_overpass_response', 'Overpass response lacks elements');
  const records = new Map();
  for (const element of elements) {
    if (!element || element.type !== 'way') {
      fail('unexpected_overpass_element', 'Structure query returned a non-way element', {
        type: element && element.type,
        id: element && element.id,
      });
    }
    const id = normalizeWayId(element.id, 'Overpass way ID');
    if (!requested.has(id)) {
      fail('unexpected_way_id', 'Structure query returned an unrequested way', { id });
    }
    if (records.has(id)) {
      fail('duplicate_way_id', 'Structure query returned a way more than once', { id });
    }
    const tags = element.tags == null ? {} : plainObject(element.tags, `way ${id} tags`);
    const record = {};
    for (const field of STRUCTURE_FIELDS) {
      const value = normalizeTagValue(tags[field]);
      if (value != null) record[field] = value;
    }
    records.set(id, Object.freeze(record));
  }
  const missing = [...requested].filter((id) => !records.has(id));
  if (missing.length) {
    fail('incomplete_way_coverage', 'Structure query did not return every requested way', {
      missing: missing.slice(0, 50),
      missingCount: missing.length,
      requestedCount: requested.size,
    });
  }
  return records;
}

function mergeRecordMaps(target, source) {
  for (const [id, record] of source) {
    if (target.has(id)) fail('duplicate_way_id', 'Way occurred in multiple response batches', { id });
    target.set(id, record);
  }
  return target;
}

function applyStructureTags(osmValue, recordMap, options = {}) {
  const osm = plainObject(osmValue, 'OSM dataset');
  const wayIds = normalizeWayIds(osm);
  if (!(recordMap instanceof Map)) fail('invalid_records', 'recordMap must be a Map');
  const recordIds = [...recordMap.keys()].sort((left, right) => Number(left) - Number(right));
  if (JSON.stringify(recordIds) !== JSON.stringify([...wayIds])) {
    fail('coverage_mismatch', 'Structure records do not exactly cover OSM dataset ways', {
      expectedCount: wayIds.length,
      actualCount: recordIds.length,
    });
  }
  const retrievedAt = isoTimestamp(
    options.retrievedAt || new Date().toISOString(),
    'retrievedAt',
  );
  const cloned = JSON.parse(JSON.stringify(osm));
  for (const id of wayIds) {
    const way = plainObject(cloned.ways[id], `OSM dataset.ways.${id}`);
    for (const field of STRUCTURE_FIELDS) delete way[field];
    const record = recordMap.get(id);
    for (const field of STRUCTURE_FIELDS) {
      if (record[field] != null) way[field] = record[field];
    }
  }
  const queryFingerprint = sha256Buffer(Buffer.from(JSON.stringify({
    wayIds,
    fields: STRUCTURE_FIELDS,
  })));
  cloned.structureTags = {
    schemaVersion: 1,
    producerVersion: PRODUCER_VERSION,
    source: 'OpenStreetMap (Overpass)',
    datasetUrl: 'https://www.openstreetmap.org/copyright',
    licenseId: 'ODbL-1.0',
    retrievedAt,
    coverage: 'full',
    wayCount: wayIds.length,
    fields: [...STRUCTURE_FIELDS],
    queryFingerprint,
  };
  return cloned;
}

function resolveRegularInput(fileValue) {
  const requested = path.resolve(String(fileValue || ''));
  if (!fs.existsSync(requested)) {
    fail('missing_input', 'OSM input file does not exist', { requested });
  }
  const stat = fs.lstatSync(requested);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('unsafe_input', 'OSM input must be a non-symlink regular file', { requested });
  }
  return fs.realpathSync(requested);
}

function resolveOutputFile(fileValue) {
  const requested = path.resolve(String(fileValue || ''));
  const parent = path.dirname(requested);
  fs.mkdirSync(parent, { recursive: true });
  const realParent = fs.realpathSync(parent);
  const target = path.join(realParent, path.basename(requested));
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    fail('unsafe_output', 'OSM output must not be a symbolic link', { target });
  }
  return target;
}

function writeJsonAtomic(file, value) {
  const output = resolveOutputFile(file);
  const temporary = `${output}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, output);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return output;
}

async function enrichOsmStructureFile(options = {}) {
  const inputFile = resolveRegularInput(options.inputFile);
  const outputFile = resolveOutputFile(options.outputFile || inputFile);
  const osm = plainObject(JSON.parse(fs.readFileSync(inputFile, 'utf8')), 'OSM dataset');
  if (!options.force && outputFile === inputFile &&
      osm.structureTags?.producerVersion === PRODUCER_VERSION &&
      osm.structureTags?.coverage === 'full') {
    return Object.freeze({
      skipped: true,
      reason: 'already complete',
      inputFile,
      outputFile,
      wayCount: normalizeWayIds(osm).length,
    });
  }
  const wayIds = normalizeWayIds(osm);
  const groups = batches(wayIds, options.batchSize || DEFAULT_BATCH_SIZE);
  const fetchFn = options.fetchOverpass || ((query) => osmProducer.fetchOverpass(query, {
    endpoint: options.endpoint,
    retries: options.retries,
    backoffMs: options.backoffMs,
    timeoutMs: options.timeoutMs,
  }));
  if (typeof fetchFn !== 'function') fail('invalid_fetch', 'fetchOverpass must be a function');
  const records = new Map();
  const delayMs = Number.isFinite(options.interBatchDelayMs)
    ? Math.max(0, options.interBatchDelayMs)
    : DEFAULT_INTER_BATCH_DELAY_MS;
  const sleepFn = options.sleep || sleep;
  for (let index = 0; index < groups.length; index += 1) {
    if (index > 0 && delayMs > 0) await sleepFn(delayMs);
    const query = buildOverpassQuery(groups[index], { timeoutMs: options.timeoutMs });
    const response = await fetchFn(query);
    mergeRecordMaps(records, parseStructureResponse(response, groups[index]));
  }
  const enriched = applyStructureTags(osm, records, {
    retrievedAt: options.retrievedAt,
  });
  const written = writeJsonAtomic(outputFile, enriched);
  return Object.freeze({
    skipped: false,
    inputFile,
    outputFile: written,
    inputSha256: sha256File(inputFile),
    outputSha256: sha256File(written),
    wayCount: wayIds.length,
    batchCount: groups.length,
    queryFingerprint: enriched.structureTags.queryFingerprint,
  });
}

function parseArgs(argv) {
  const options = {
    inputFile: null,
    outputFile: null,
    batchSize: DEFAULT_BATCH_SIZE,
    interBatchDelayMs: DEFAULT_INTER_BATCH_DELAY_MS,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.inputFile = argv[++index];
    else if (argument === '--output') options.outputFile = argv[++index];
    else if (argument === '--batch-size') options.batchSize = Number(argv[++index]);
    else if (argument === '--delay') options.interBatchDelayMs = Number(argv[++index]);
    else if (argument === '--endpoint') options.endpoint = argv[++index];
    else if (argument === '--retries') options.retries = Number(argv[++index]);
    else if (argument === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (argument === '--force') options.force = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/producers/osm_structure_producer.js --input <osm_city.json> ' +
      '[--output <file>] [--batch-size <n>] [--delay <ms>] [--force] [--json]\n',
  );
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.inputFile) fail('missing_argument', '--input is required');
  const result = await enrichOsmStructureFile(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.skipped) {
    process.stdout.write(`[osm-structure] SKIP: ${result.reason} (${result.outputFile})\n`);
  } else {
    process.stdout.write(
      `[osm-structure] enriched ${result.wayCount} ways in ${result.batchCount} batches ` +
        `→ ${result.outputFile}\n`,
    );
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  PRODUCER_VERSION,
  DEFAULT_BATCH_SIZE,
  DEFAULT_INTER_BATCH_DELAY_MS,
  STRUCTURE_FIELDS,
  OsmStructureProducerError,
  sha256Buffer,
  sha256File,
  plainObject,
  normalizeWayId,
  normalizeWayIds,
  batches,
  buildOverpassQuery,
  normalizeTagValue,
  parseStructureResponse,
  mergeRecordMaps,
  applyStructureTags,
  resolveRegularInput,
  resolveOutputFile,
  writeJsonAtomic,
  enrichOsmStructureFile,
  parseArgs,
  main,
});
