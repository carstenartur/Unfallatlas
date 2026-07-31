#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const elevation = require('../../js/ua.elevation_provider');
const dgm1 = require('../providers/hannover_dgm1_xyz_provider');
const contextProducer = require('./osm_elevation_context_producer');
const riskProducer = require('./osm_elevation_risk_producer');

const SCHEMA_VERSION = 1;
const ARTIFACT_TYPE = 'hannover-dgm1-road-profiles';
const PRODUCER_VERSION = '1.0.0';
const WINDOWS_METERS = Object.freeze([20, 50]);
const UNAVAILABLE_CODES = Object.freeze(new Set([
  'insufficient_geometry',
  'insufficient_samples',
]));
const METERS_PER_DEGREE_LAT = 110540;

class HannoverDgm1RoadProfileError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'HannoverDgm1RoadProfileError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new HannoverDgm1RoadProfileError(code, message, details);
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
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

function isoTimestamp(value, label) {
  const text = requiredString(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    fail('invalid_timestamp', `${label} must be an ISO timestamp`, { value });
  }
  return new Date(milliseconds).toISOString();
}

function resolveOutputFile(value) {
  const requested = path.resolve(requiredString(value, 'outputFile'));
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const parent = fs.realpathSync(path.dirname(requested));
  const target = path.join(parent, path.basename(requested));
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('unsafe_output', 'outputFile must be a regular non-symlink file', { target });
    }
  }
  return target;
}

function writeAtomic(file, value) {
  const target = resolveOutputFile(file);
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function normalizeCoordinate(value, label) {
  const point = plainObject(value, label);
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    fail('invalid_geometry', `${label} must contain finite lat/lon coordinates`);
  }
  return Object.freeze({ lat, lon });
}

function validateWayGeometries(osm, wayIds) {
  const geometries = plainObject(osm.wayGeometries, 'OSM dataset.wayGeometries');
  const actualIds = Object.keys(geometries).sort((left, right) => Number(left) - Number(right));
  if (JSON.stringify(actualIds) !== JSON.stringify([...wayIds])) {
    fail('geometry_coverage_mismatch', 'wayGeometries must cover exactly every validated OSM way', {
      expected: [...wayIds],
      actual: actualIds,
    });
  }
  const normalized = {};
  for (const id of wayIds) {
    const geometry = geometries[id];
    if (!Array.isArray(geometry) || geometry.length < 2) {
      fail('invalid_geometry', `way ${id} requires at least two geometry points`);
    }
    normalized[id] = Object.freeze(geometry.map((point, index) =>
      normalizeCoordinate(point, `wayGeometries.${id}[${index}]`)));
  }
  return Object.freeze(normalized);
}

function segmentLengthMeters(left, right) {
  const meanLatitudeRadians = ((left.lat + right.lat) / 2) * Math.PI / 180;
  const metersPerDegreeLon = 111320 * Math.max(0.01, Math.abs(Math.cos(meanLatitudeRadians)));
  const dx = (right.lon - left.lon) * metersPerDegreeLon;
  const dy = (right.lat - left.lat) * METERS_PER_DEGREE_LAT;
  return Math.hypot(dx, dy);
}

function profileAnchor(geometry) {
  if (!Array.isArray(geometry) || geometry.length < 2) {
    fail('invalid_geometry', 'profile geometry requires at least two points');
  }
  const lengths = [];
  let total = 0;
  for (let index = 0; index < geometry.length - 1; index += 1) {
    const length = segmentLengthMeters(geometry[index], geometry[index + 1]);
    lengths.push(length);
    total += length;
  }
  if (!Number.isFinite(total) || total <= 0) {
    fail('invalid_geometry', 'profile geometry has no positive-length segment');
  }
  const half = total / 2;
  let traversed = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (traversed + length >= half) {
      const ratio = length ? (half - traversed) / length : 0;
      const left = geometry[index];
      const right = geometry[index + 1];
      return Object.freeze({
        lat: left.lat + (right.lat - left.lat) * ratio,
        lon: left.lon + (right.lon - left.lon) * ratio,
      });
    }
    traversed += length;
  }
  return Object.freeze({ ...geometry[geometry.length - 1] });
}

function unavailableWindow(windowMeters, error) {
  return Object.freeze({
    status: 'unavailable',
    windowMeters,
    reasonCode: error.code,
    reason: error.message,
  });
}

async function computeWindow(compute, provider, geometry, anchor, riskTags, windowMeters) {
  try {
    const result = await compute(provider, geometry, anchor, {
      windowMeters,
      spacingMeters: provider.descriptor.resolutionMeters,
      matchQuality: 'high',
      osmTags: riskTags,
      context: { city: 'Hannover', purpose: 'road-profile-production' },
    });
    if (!result || result.source.id !== dgm1.SOURCE_ID || result.windowMeters !== windowMeters) {
      fail('invalid_gradient_result', 'gradient result is not bound to Hannover DGM1 and requested window', {
        windowMeters,
      });
    }
    return Object.freeze({ status: 'computed', windowMeters, result });
  } catch (error) {
    if (error instanceof elevation.ElevationProviderError && UNAVAILABLE_CODES.has(error.code)) {
      return unavailableWindow(windowMeters, error);
    }
    throw error;
  }
}

function validateArtifact(artifact, wayIds) {
  const value = plainObject(artifact, 'road-profile artifact');
  if (value.schemaVersion !== SCHEMA_VERSION || value.type !== ARTIFACT_TYPE || value.city !== 'Hannover') {
    fail('invalid_artifact', 'road-profile artifact identity is invalid');
  }
  if (JSON.stringify(value.windowsMeters) !== JSON.stringify(WINDOWS_METERS)) {
    fail('invalid_artifact', 'road-profile windows differ from the supported contract');
  }
  const profiles = plainObject(value.profiles, 'road-profile artifact.profiles');
  const ids = Object.keys(profiles).sort((left, right) => Number(left) - Number(right));
  if (JSON.stringify(ids) !== JSON.stringify([...wayIds])) {
    fail('invalid_artifact', 'road-profile coverage differs from validated OSM ways');
  }
  for (const id of wayIds) {
    const profile = plainObject(profiles[id], `profiles.${id}`);
    const windows = plainObject(profile.windows, `profiles.${id}.windows`);
    for (const windowMeters of WINDOWS_METERS) {
      const record = plainObject(windows[String(windowMeters)], `profiles.${id}.windows.${windowMeters}`);
      if (!['computed', 'unavailable'].includes(record.status) || record.windowMeters !== windowMeters) {
        fail('invalid_artifact', `profiles.${id} has an invalid ${windowMeters} m record`);
      }
    }
  }
  return value;
}

async function prepareHannoverDgm1RoadProfiles(options = {}, runtime = {}) {
  const inputFile = riskProducer.resolveRegularFile(options.osmFile, 'osmFile');
  const outputFile = resolveOutputFile(options.outputFile);
  const prepareContext = runtime.prepareOsmElevationContext || contextProducer.prepareOsmElevationContext;
  const createProvider = runtime.createHannoverDgm1XyzProvider || dgm1.createHannoverDgm1XyzProvider;
  const compute = runtime.computeRoadGradient || elevation.computeRoadGradient;
  const calls = [];

  const context = await prepareContext({
    inputFile,
    force: Boolean(options.forceContext),
    batchSize: options.batchSize,
    interBatchDelayMs: options.interBatchDelayMs,
    endpoint: options.endpoint,
    retries: options.retries,
    backoffMs: options.backoffMs,
    timeoutMs: options.timeoutMs,
    retrievedAt: options.structureRetrievedAt,
    derivedAt: options.riskDerivedAt,
    fetchOverpass: options.fetchOverpass,
    sleep: options.sleep,
  });
  calls.push('osm-context');

  let osm;
  try {
    osm = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (error) {
    fail('invalid_json', 'prepared OSM context is not valid UTF-8 JSON', { cause: error.message });
  }
  const validated = riskProducer.validateElevationRiskContract(osm);
  const geometries = validateWayGeometries(validated.osm, validated.wayIds);

  const provider = createProvider({
    allowedRoot: options.dgmRoot,
    manifestPath: options.dgmManifest,
    expectedManifestSha256: options.dgmManifestSha256,
  });
  if (!provider || provider.id !== dgm1.SOURCE_ID || typeof provider.preload !== 'function') {
    fail('invalid_provider', 'Hannover DGM1 provider contract is required');
  }
  const preload = await provider.preload();
  calls.push('dgm1-preload');

  const profiles = {};
  const coverage = {
    totalWays: validated.wayIds.length,
    computed20m: 0,
    computed50m: 0,
    usable20m: 0,
    usable50m: 0,
    unavailable20m: 0,
    unavailable50m: 0,
    unusableByRisk20m: 0,
    unusableByRisk50m: 0,
  };
  for (const id of validated.wayIds) {
    const geometry = geometries[id];
    const anchor = profileAnchor(geometry);
    const riskTags = Object.freeze({ ...validated.osm.ways[id].elevationRiskTags });
    const windows = {};
    for (const windowMeters of WINDOWS_METERS) {
      const record = await computeWindow(
        compute,
        provider,
        geometry,
        anchor,
        riskTags,
        windowMeters,
      );
      windows[String(windowMeters)] = record;
      const suffix = windowMeters === 20 ? '20m' : '50m';
      if (record.status === 'unavailable') coverage[`unavailable${suffix}`] += 1;
      else {
        coverage[`computed${suffix}`] += 1;
        if (record.result.usable) coverage[`usable${suffix}`] += 1;
        else coverage[`unusableByRisk${suffix}`] += 1;
      }
    }
    profiles[id] = Object.freeze({
      wayId: id,
      highway: validated.osm.ways[id].highway == null ? null : String(validated.osm.ways[id].highway),
      geometryPointCount: geometry.length,
      anchor,
      elevationRiskTags: riskTags,
      windows: Object.freeze(windows),
    });
  }
  calls.push('profiles');

  const generatedAt = isoTimestamp(options.generatedAt || new Date().toISOString(), 'generatedAt');
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    type: ARTIFACT_TYPE,
    producerVersion: PRODUCER_VERSION,
    city: 'Hannover',
    generatedAt,
    windowsMeters: [...WINDOWS_METERS],
    method: 'theil-sen-linear-profile-v1',
    source: {
      descriptor: provider.descriptor,
      manifestSha256: provider.manifest.sha256,
      distributionSha256: provider.manifest.dataSha256,
      grid: provider.manifest.grid,
      preloadedPointCount: preload.pointCount,
    },
    osm: {
      fileName: path.basename(inputFile),
      sha256: sha256File(inputFile),
      wayCount: validated.wayIds.length,
      structureQueryFingerprint: validated.metadata.queryFingerprint,
      sourceStructureFingerprint: validated.sourceStructureFingerprint,
      contextPreparation: {
        skipped: Boolean(context.skipped),
        inputSha256: context.inputSha256,
        outputSha256: context.outputSha256,
      },
    },
    coverage,
    profiles,
    truthBoundary: {
      officialDgm1BytesVerified: true,
      osmStructureAndRiskValidated: true,
      roadProfilesComputed: true,
      bridgeAndTunnelSurfaceClaimed: false,
      crossSlopeClaimed: false,
      accidentToWayMatchingPerformed: false,
    },
  };
  validateArtifact(artifact, validated.wayIds);
  const written = writeAtomic(outputFile, artifact);
  return Object.freeze({
    outputFile: written,
    outputSha256: sha256File(written),
    wayCount: validated.wayIds.length,
    coverage: Object.freeze({ ...coverage }),
    calls: Object.freeze(calls),
    context,
  });
}

function parseArgs(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--osm') options.osmFile = argv[++index];
    else if (argument === '--dgm-root') options.dgmRoot = argv[++index];
    else if (argument === '--dgm-manifest') options.dgmManifest = argv[++index];
    else if (argument === '--dgm-manifest-sha256') options.dgmManifestSha256 = argv[++index];
    else if (argument === '--output') options.outputFile = argv[++index];
    else if (argument === '--generated-at') options.generatedAt = argv[++index];
    else if (argument === '--structure-retrieved-at') options.structureRetrievedAt = argv[++index];
    else if (argument === '--risk-derived-at') options.riskDerivedAt = argv[++index];
    else if (argument === '--batch-size') options.batchSize = Number(argv[++index]);
    else if (argument === '--delay') options.interBatchDelayMs = Number(argv[++index]);
    else if (argument === '--endpoint') options.endpoint = argv[++index];
    else if (argument === '--retries') options.retries = Number(argv[++index]);
    else if (argument === '--backoff') options.backoffMs = Number(argv[++index]);
    else if (argument === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (argument === '--force-context') options.forceContext = true;
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail('unknown_argument', `unknown argument ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/producers/hannover_dgm1_road_profile_producer.js ' +
    '--osm <osm_hannover.json> --dgm-root <root> --dgm-manifest <relative.json> ' +
    '--dgm-manifest-sha256 <sha256> --output <profiles.json>\n' +
    'Options:\n' +
    '  --generated-at <ISO>             deterministic artifact timestamp\n' +
    '  --structure-retrieved-at <ISO>   deterministic OSM structure timestamp\n' +
    '  --risk-derived-at <ISO>          deterministic risk derivation timestamp\n' +
    '  --batch-size <n>                 Overpass way-ID batch size\n' +
    '  --delay <ms>                     delay between Overpass batches\n' +
    '  --endpoint <URL>                 Overpass endpoint\n' +
    '  --retries <n>                    Overpass retry count\n' +
    '  --backoff <ms>                   initial retry backoff\n' +
    '  --timeout <ms>                   Overpass request timeout\n' +
    '  --force-context                  rebuild OSM structure/risk context\n' +
    '  --json                           print machine-readable result\n' +
    '  --help, -h                       show this help\n',
  );
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  for (const field of ['osmFile', 'dgmRoot', 'dgmManifest', 'dgmManifestSha256', 'outputFile']) {
    if (!options[field]) fail('missing_argument', `${field} is required`);
  }
  const result = await prepareHannoverDgm1RoadProfiles(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`[hannover-dgm1-profiles] ${result.wayCount} ways → ${result.outputFile}\n`);
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
  ARTIFACT_TYPE,
  PRODUCER_VERSION,
  WINDOWS_METERS,
  UNAVAILABLE_CODES,
  METERS_PER_DEGREE_LAT,
  HannoverDgm1RoadProfileError,
  sha256Buffer,
  sha256File,
  plainObject,
  requiredString,
  isoTimestamp,
  resolveOutputFile,
  writeAtomic,
  normalizeCoordinate,
  validateWayGeometries,
  segmentLengthMeters,
  profileAnchor,
  unavailableWindow,
  computeWindow,
  validateArtifact,
  prepareHannoverDgm1RoadProfiles,
  parseArgs,
  main,
});
