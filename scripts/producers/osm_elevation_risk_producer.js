#!/usr/bin/env node
'use strict';

/**
 * Derives the normalized structure-risk tag contract consumed by
 * computeRoadGradient from a fully covered OSM structure-tag artifact.
 *
 * Raw OSM values remain untouched. Values such as bridge=viaduct and
 * tunnel=culvert are mapped to the existing boolean-compatible risk interface
 * (`yes`/`no`), while layer is normalized as a strict integer string.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRODUCER_VERSION = '1.0.0';
const RISK_SCHEMA_VERSION = 1;
const REQUIRED_STRUCTURE_FIELDS = Object.freeze([
  'bridge',
  'tunnel',
  'layer',
  'embankment',
  'cutting',
]);
const REQUIRED_RISK_FIELDS = REQUIRED_STRUCTURE_FIELDS;
const NEGATIVE_VALUES = Object.freeze(new Set(['no', 'false', '0', 'none']));
const RISK_CONTRACT = Object.freeze({
  presenceValues: Object.freeze(['yes', 'no']),
  layer: 'canonical-integer-string',
  consumer: 'js/ua.elevation_provider.js#computeRoadGradient.osmTags',
});

class OsmElevationRiskError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'OsmElevationRiskError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new OsmElevationRiskError(code, message, details);
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

function assertExactKeys(value, required, label) {
  const object = plainObject(value, label);
  const actual = Object.keys(object).sort();
  const expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('invalid_risk_contract', `${label} has unexpected or missing fields`, {
      expected,
      actual,
    });
  }
  return object;
}

function normalizePresence(value) {
  const text = String(value == null ? '' : value).trim().toLowerCase();
  if (!text || NEGATIVE_VALUES.has(text)) return 'no';
  return 'yes';
}

function normalizeLayer(value, label = 'layer') {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '0';
  if (!/^[+-]?\d+$/.test(text)) {
    fail('invalid_layer', `${label} must be an integer OSM layer`, { value });
  }
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < -100 || number > 100) {
    fail('invalid_layer', `${label} is outside the supported range -100..100`, {
      value,
    });
  }
  return String(Object.is(number, -0) ? 0 : number);
}

function riskTagsForWay(wayValue, label = 'way') {
  const way = plainObject(wayValue, label);
  return Object.freeze({
    bridge: normalizePresence(way.bridge),
    tunnel: normalizePresence(way.tunnel),
    layer: normalizeLayer(way.layer, `${label}.layer`),
    embankment: normalizePresence(way.embankment),
    cutting: normalizePresence(way.cutting),
  });
}

function sortedWayIds(waysValue) {
  const ways = plainObject(waysValue, 'OSM dataset.ways');
  const ids = Object.keys(ways);
  if (!ids.length) fail('empty_way_set', 'OSM dataset contains no ways');
  for (const id of ids) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) {
      fail('invalid_way_id', 'OSM way IDs must be positive safe integers', { id });
    }
  }
  return Object.freeze(ids.sort((left, right) => Number(left) - Number(right)));
}

function validateStructureCoverage(osmValue) {
  const osm = plainObject(osmValue, 'OSM dataset');
  const wayIds = sortedWayIds(osm.ways);
  const metadata = plainObject(osm.structureTags, 'OSM dataset.structureTags');
  if (metadata.coverage !== 'full') {
    fail('incomplete_structure_coverage', 'structureTags.coverage must be full');
  }
  if (Number(metadata.wayCount) !== wayIds.length) {
    fail('structure_coverage_mismatch', 'structureTags.wayCount differs from ways', {
      expected: wayIds.length,
      actual: metadata.wayCount,
    });
  }
  if (!Array.isArray(metadata.fields)) {
    fail('invalid_structure_contract', 'structureTags.fields must be an array');
  }
  const fields = [...new Set(metadata.fields.map((field) => String(field)))].sort();
  const required = [...REQUIRED_STRUCTURE_FIELDS].sort();
  if (JSON.stringify(fields) !== JSON.stringify(required)) {
    fail('invalid_structure_contract', 'structureTags.fields is incomplete or unexpected', {
      expected: required,
      actual: fields,
    });
  }
  if (typeof metadata.queryFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(metadata.queryFingerprint)) {
    fail('invalid_structure_contract', 'structureTags.queryFingerprint must be SHA-256');
  }
  return Object.freeze({ osm, metadata, wayIds });
}

function sourceStructureFingerprint(osm, wayIds) {
  const rows = wayIds.map((id) => {
    const way = plainObject(osm.ways[id], `OSM dataset.ways.${id}`);
    return [id, ...REQUIRED_STRUCTURE_FIELDS.map((field) =>
      way[field] == null ? null : String(way[field]))];
  });
  return sha256(Buffer.from(JSON.stringify(rows)));
}

function validateElevationRiskContract(osmValue) {
  const validated = validateStructureCoverage(osmValue);
  const metadata = plainObject(
    validated.osm.elevationRiskTags,
    'OSM dataset.elevationRiskTags',
  );
  if (Number(metadata.schemaVersion) !== RISK_SCHEMA_VERSION) {
    fail('invalid_risk_contract', `elevationRiskTags.schemaVersion must be ${RISK_SCHEMA_VERSION}`);
  }
  if (metadata.producerVersion !== PRODUCER_VERSION) {
    fail('invalid_risk_contract', 'elevationRiskTags.producerVersion is stale', {
      expected: PRODUCER_VERSION,
      actual: metadata.producerVersion,
    });
  }
  if (metadata.coverage !== 'full') {
    fail('invalid_risk_contract', 'elevationRiskTags.coverage must be full');
  }
  if (Number(metadata.wayCount) !== validated.wayIds.length) {
    fail('invalid_risk_contract', 'elevationRiskTags.wayCount differs from ways', {
      expected: validated.wayIds.length,
      actual: metadata.wayCount,
    });
  }
  if (typeof metadata.derivedAt !== 'string' ||
      !metadata.derivedAt.trim() ||
      !Number.isFinite(Date.parse(metadata.derivedAt))) {
    fail('invalid_risk_contract', 'elevationRiskTags.derivedAt must be an ISO timestamp');
  }
  const currentFingerprint = sourceStructureFingerprint(
    validated.osm,
    validated.wayIds,
  );
  if (metadata.sourceStructureQueryFingerprint !== validated.metadata.queryFingerprint) {
    fail('invalid_risk_contract', 'risk contract is bound to another structure query', {
      expected: validated.metadata.queryFingerprint,
      actual: metadata.sourceStructureQueryFingerprint,
    });
  }
  if (metadata.sourceStructureFingerprint !== currentFingerprint) {
    fail('invalid_risk_contract', 'risk contract is stale for the current raw structure tags', {
      expected: currentFingerprint,
      actual: metadata.sourceStructureFingerprint,
    });
  }
  const contract = assertExactKeys(
    metadata.contract,
    ['presenceValues', 'layer', 'consumer'],
    'elevationRiskTags.contract',
  );
  if (!Array.isArray(contract.presenceValues) ||
      JSON.stringify(contract.presenceValues) !== JSON.stringify(RISK_CONTRACT.presenceValues) ||
      contract.layer !== RISK_CONTRACT.layer ||
      contract.consumer !== RISK_CONTRACT.consumer) {
    fail('invalid_risk_contract', 'elevationRiskTags.contract differs from the supported consumer contract');
  }

  for (const id of validated.wayIds) {
    const way = plainObject(validated.osm.ways[id], `OSM dataset.ways.${id}`);
    const actual = assertExactKeys(
      way.elevationRiskTags,
      REQUIRED_RISK_FIELDS,
      `OSM dataset.ways.${id}.elevationRiskTags`,
    );
    const expected = riskTagsForWay(way, `OSM dataset.ways.${id}`);
    for (const field of REQUIRED_RISK_FIELDS) {
      if (actual[field] !== expected[field]) {
        fail('invalid_risk_contract', `way ${id} has stale or tampered ${field} risk`, {
          expected: expected[field],
          actual: actual[field],
        });
      }
    }
  }

  return Object.freeze({
    ...validated,
    riskMetadata: metadata,
    sourceStructureFingerprint: currentFingerprint,
  });
}

function applyElevationRiskTags(osmValue, options = {}) {
  const validated = validateStructureCoverage(osmValue);
  const sourceFingerprint = sourceStructureFingerprint(
    validated.osm,
    validated.wayIds,
  );
  const cloned = JSON.parse(JSON.stringify(validated.osm));
  for (const id of validated.wayIds) {
    cloned.ways[id].elevationRiskTags = riskTagsForWay(
      cloned.ways[id],
      `OSM dataset.ways.${id}`,
    );
  }
  const retrievedAtValue = options.derivedAt || new Date().toISOString();
  const derivedMilliseconds = Date.parse(retrievedAtValue);
  if (!Number.isFinite(derivedMilliseconds)) {
    fail('invalid_timestamp', 'derivedAt must be an ISO timestamp', {
      value: retrievedAtValue,
    });
  }
  cloned.elevationRiskTags = {
    schemaVersion: RISK_SCHEMA_VERSION,
    producerVersion: PRODUCER_VERSION,
    derivedAt: new Date(derivedMilliseconds).toISOString(),
    coverage: 'full',
    wayCount: validated.wayIds.length,
    sourceStructureQueryFingerprint: validated.metadata.queryFingerprint,
    sourceStructureFingerprint: sourceFingerprint,
    contract: {
      presenceValues: [...RISK_CONTRACT.presenceValues],
      layer: RISK_CONTRACT.layer,
      consumer: RISK_CONTRACT.consumer,
    },
  };
  return cloned;
}

function resolveRegularFile(value, label) {
  const requested = path.resolve(String(value || ''));
  if (!fs.existsSync(requested)) fail('missing_file', `${label} does not exist`, { requested });
  const lstat = fs.lstatSync(requested);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    fail('unsafe_file', `${label} must be a non-symlink regular file`, { requested });
  }
  return fs.realpathSync(requested);
}

function resolveOutput(value) {
  const requested = path.resolve(String(value || ''));
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const parent = fs.realpathSync(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    fail('unsafe_file', 'output file must not be a symbolic link', { target });
  }
  return target;
}

function writeAtomic(file, value) {
  const target = resolveOutput(file);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function processFile(options = {}) {
  const inputFile = resolveRegularFile(options.inputFile, 'input file');
  const outputFile = resolveOutput(options.outputFile || inputFile);
  const inputBytes = fs.readFileSync(inputFile);
  let input;
  try {
    input = JSON.parse(inputBytes.toString('utf8'));
  } catch (error) {
    fail('invalid_json', 'input file is not valid UTF-8 JSON', {
      file: inputFile,
      cause: error.message,
    });
  }
  let currentContract = null;
  try {
    currentContract = validateElevationRiskContract(input);
  } catch (error) {
    if (!(error instanceof OsmElevationRiskError)) throw error;
  }
  if (!options.force && outputFile === inputFile && currentContract) {
    const inputSha256 = sha256(inputBytes);
    return Object.freeze({
      skipped: true,
      reason: 'already current',
      inputFile,
      outputFile,
      wayCount: currentContract.wayIds.length,
      inputSha256,
      outputSha256: inputSha256,
      sourceStructureFingerprint: currentContract.sourceStructureFingerprint,
    });
  }
  const output = applyElevationRiskTags(input, { derivedAt: options.derivedAt });
  const outputContract = validateElevationRiskContract(output);
  const written = writeAtomic(outputFile, output);
  return Object.freeze({
    skipped: false,
    inputFile,
    outputFile: written,
    wayCount: outputContract.wayIds.length,
    inputSha256: sha256(inputBytes),
    outputSha256: sha256(fs.readFileSync(written)),
    sourceStructureFingerprint: outputContract.sourceStructureFingerprint,
  });
}

function parseArgs(argv) {
  const options = { inputFile: null, outputFile: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.inputFile = argv[++index];
    else if (argument === '--output') options.outputFile = argv[++index];
    else if (argument === '--derived-at') options.derivedAt = argv[++index];
    else if (argument === '--force') options.force = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/producers/osm_elevation_risk_producer.js --input <osm_city.json> ' +
      '[--output <file>] [--derived-at <ISO>] [--force] [--json]\n',
  );
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.inputFile) fail('missing_argument', '--input is required');
  const result = processFile(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.skipped) {
    process.stdout.write(`[osm-elevation-risk] SKIP: ${result.reason} (${result.outputFile})\n`);
  } else {
    process.stdout.write(
      `[osm-elevation-risk] normalized ${result.wayCount} ways → ${result.outputFile}\n`,
    );
  }
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
  PRODUCER_VERSION,
  RISK_SCHEMA_VERSION,
  REQUIRED_STRUCTURE_FIELDS,
  REQUIRED_RISK_FIELDS,
  NEGATIVE_VALUES,
  RISK_CONTRACT,
  OsmElevationRiskError,
  sha256,
  plainObject,
  assertExactKeys,
  normalizePresence,
  normalizeLayer,
  riskTagsForWay,
  sortedWayIds,
  validateStructureCoverage,
  sourceStructureFingerprint,
  validateElevationRiskContract,
  applyElevationRiskTags,
  resolveRegularFile,
  resolveOutput,
  writeAtomic,
  processFile,
  parseArgs,
  main,
});
