#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const profileProducer = require('./producers/hannover_dgm1_road_profile_producer');
const { slugify } = require('./lib/static-data-validation');

const SOURCE_ID = 'hannover.dgm1';
const CITY = 'Hannover';
const PRIMARY_WINDOWS = Object.freeze([50, 20]);
const SLOPE_FIELDS = Object.freeze([
  'road_slope_percent',
  'road_slope_class',
  'road_slope_method',
  'road_slope_sample_count',
  'road_slope_confidence',
  'road_slope_max_abs_percent',
  'road_slope_missing_reason',
  'road_slope_source_id',
  'road_slope_source',
  'road_slope_resolution_m',
  'road_slope_profile_window_m',
  'road_slope_direction',
  'road_slope_quality',
  'road_slope_reliable_for_road',
  'road_slope_residual_mad_m',
  'road_slope_uncertainty_percent',
  'road_slope_uncertainty_reasons',
]);

function fail(message) {
  throw new Error(`[hannover-dgm1-apply] ${message}`);
}

function readJsonArtifact(logicalPath) {
  const raw = logicalPath;
  const gz = `${logicalPath}.gz`;
  if (fs.existsSync(raw)) {
    return { file: raw, gzip: false, value: JSON.parse(fs.readFileSync(raw, 'utf8')) };
  }
  if (fs.existsSync(gz)) {
    return {
      file: gz,
      gzip: true,
      value: JSON.parse(zlib.gunzipSync(fs.readFileSync(gz)).toString('utf8')),
    };
  }
  fail(`missing JSON artifact ${logicalPath}[.gz]`);
}

function encodeArtifact(artifact) {
  const bytes = Buffer.from(JSON.stringify(artifact.value));
  return artifact.gzip ? zlib.gzipSync(bytes, { level: 9, mtime: 0 }) : bytes;
}

function writeArtifactsAtomically(artifacts, options = {}) {
  const unique = [];
  const seen = new Set();
  for (const artifact of artifacts) {
    if (!artifact || !artifact.file || seen.has(artifact.file)) continue;
    seen.add(artifact.file);
    unique.push(artifact);
  }
  const transaction = `ua-dgm1-${Date.now()}-${process.pid}`;
  const entries = unique.map(artifact => ({
    artifact,
    temporary: `${artifact.file}.${transaction}.tmp`,
    backup: `${artifact.file}.${transaction}.bak`,
    backedUp: false,
    installed: false,
  }));

  for (const entry of entries) {
    fs.writeFileSync(entry.temporary, encodeArtifact(entry.artifact));
  }

  try {
    for (const entry of entries) {
      fs.renameSync(entry.artifact.file, entry.backup);
      entry.backedUp = true;
    }
    let step = 0;
    for (const entry of entries) {
      fs.renameSync(entry.temporary, entry.artifact.file);
      entry.installed = true;
      step += 1;
      if (typeof options.onCommitStep === 'function') options.onCommitStep({ step, entry });
    }
    for (const entry of entries) fs.rmSync(entry.backup, { force: true });
  } catch (error) {
    for (const entry of entries.slice().reverse()) {
      if (entry.installed && fs.existsSync(entry.artifact.file)) {
        fs.rmSync(entry.artifact.file, { force: true });
      }
      if (entry.backedUp && fs.existsSync(entry.backup)) {
        fs.renameSync(entry.backup, entry.artifact.file);
      }
    }
    throw error;
  } finally {
    for (const entry of entries) {
      fs.rmSync(entry.temporary, { force: true });
      fs.rmSync(entry.backup, { force: true });
    }
  }
}

function classifySlope(percent) {
  if (!Number.isFinite(percent)) return null;
  const value = Math.abs(percent);
  if (value <= 2) return 'flat';
  if (value <= 4) return 'gentle';
  if (value <= 6) return 'moderate';
  if (value <= 10) return 'steep';
  return 'very_steep';
}

function clearSlopeFields(row) {
  for (const field of SLOPE_FIELDS) delete row[field];
}

function normalizedReason(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.status === 'unavailable') return record.reasonCode || record.reason || 'unavailable';
  const result = record.result;
  if (!result || result.usable !== false) return null;
  const reasons = Array.isArray(result.uncertaintyReasons)
    ? result.uncertaintyReasons.filter(Boolean)
    : [];
  return reasons.length ? reasons.join(',') : 'unusable';
}

function selectPrimaryProfile(profile) {
  const windows = profile && profile.windows;
  if (!windows || typeof windows !== 'object') fail(`profile ${profile && profile.wayId} lacks windows`);
  for (const windowMeters of PRIMARY_WINDOWS) {
    const record = windows[String(windowMeters)];
    const result = record && record.result;
    if (record && record.status === 'computed'
        && result && result.usable === true
        && result.semanticType === 'road_longitudinal_gradient'
        && Number.isFinite(result.gradientPercent)
        && result.source && result.source.id === SOURCE_ID) {
      return { windowMeters, record, result };
    }
  }
  return null;
}

function sourceDescriptor(artifact) {
  const descriptor = artifact && artifact.source && artifact.source.descriptor;
  if (!descriptor || descriptor.id !== SOURCE_ID) fail('profile artifact is not bound to hannover.dgm1');
  if (descriptor.resolutionMeters !== 1 || descriptor.modelType !== 'DTM') {
    fail('profile artifact does not use the official 1 m DTM contract');
  }
  return descriptor;
}

function applyProfileToRow(row, profile, descriptor) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) fail(`way ${profile.wayId} row is invalid`);
  clearSlopeFields(row);

  row.road_slope_source_id = descriptor.id;
  row.road_slope_source = descriptor.datasetTitle;
  row.road_slope_resolution_m = descriptor.resolutionMeters;
  row.road_slope_reliable_for_road = false;

  const selected = selectPrimaryProfile(profile);
  if (!selected) {
    const reasons = PRIMARY_WINDOWS
      .map(windowMeters => normalizedReason(profile.windows[String(windowMeters)]))
      .filter(Boolean);
    row.road_slope_missing_reason = reasons.length
      ? [...new Set(reasons)].join(';')
      : 'no_usable_dgm1_profile';
    row.road_slope_uncertainty_reasons = [...new Set(reasons)];
    return { applied: false, reason: row.road_slope_missing_reason };
  }

  const { result, windowMeters } = selected;
  row.road_slope_percent = result.gradientPercent;
  row.road_slope_class = classifySlope(result.gradientPercent);
  row.road_slope_method = result.method;
  row.road_slope_sample_count = result.sampleCount;
  row.road_slope_confidence = ['high', 'medium', 'low'].includes(result.quality)
    ? result.quality
    : 'low';
  row.road_slope_max_abs_percent = Math.max(...PRIMARY_WINDOWS
    .map(value => profile.windows[String(value)])
    .filter(record => record && record.status === 'computed' && record.result
      && record.result.usable === true && Number.isFinite(record.result.gradientPercent))
    .map(record => Math.abs(record.result.gradientPercent)));
  row.road_slope_profile_window_m = windowMeters;
  row.road_slope_direction = result.direction;
  row.road_slope_quality = result.quality;
  row.road_slope_reliable_for_road = true;
  row.road_slope_residual_mad_m = result.residualMadMeters;
  row.road_slope_uncertainty_percent = result.uncertaintyPercent;
  row.road_slope_uncertainty_reasons = Array.isArray(result.uncertaintyReasons)
    ? result.uncertaintyReasons.slice()
    : [];
  return { applied: true, windowMeters };
}

function validateProfiles(value) {
  if (!value || typeof value !== 'object') fail('profile artifact is not an object');
  if (value.schemaVersion !== profileProducer.SCHEMA_VERSION
      || value.type !== profileProducer.ARTIFACT_TYPE
      || value.city !== CITY) {
    fail('profile artifact identity is invalid');
  }
  const profiles = value.profiles;
  if (!profiles || typeof profiles !== 'object' || Array.isArray(profiles)) {
    fail('profile artifact has no profiles map');
  }
  const ids = Object.keys(profiles).sort((left, right) => Number(left) - Number(right));
  if (!ids.length) fail('profile artifact is empty');
  profileProducer.validateArtifact(value, ids);
  sourceDescriptor(value);
  return { profiles, ids };
}

function applyProfilesToWaysPayload(payload, profiles, descriptor, observed) {
  const ways = payload && payload.ways;
  if (!ways || typeof ways !== 'object' || Array.isArray(ways)) return { rows: 0, applied: 0 };
  let rows = 0;
  let applied = 0;
  for (const [wayId, row] of Object.entries(ways)) {
    const profile = profiles[wayId];
    if (!profile) fail(`runtime context contains way ${wayId} without a DGM1 profile`);
    const result = applyProfileToRow(row, profile, descriptor);
    observed.add(wayId);
    rows += 1;
    if (result.applied) applied += 1;
  }
  return { rows, applied };
}

function loadRuntimeArtifacts(outputDir, slug) {
  const artifacts = [];
  const ways = readJsonArtifact(path.join(outputDir, `ways_${slug}.json`));
  artifacts.push(ways);

  const index = readJsonArtifact(path.join(outputDir, 'ctxtiles', slug, 'index.json'));
  const tiles = Array.isArray(index.value && index.value.tiles) ? index.value.tiles : null;
  if (!tiles || !tiles.length) fail(`context tile index for ${slug} is empty`);
  for (const tile of tiles) {
    if (!Number.isInteger(tile.x) || !Number.isInteger(tile.y)) fail('context tile index contains invalid coordinates');
    artifacts.push(readJsonArtifact(path.join(outputDir, 'ctxtiles', slug, String(tile.x), `${tile.y}.json`)));
  }

  const meta = readJsonArtifact(path.join(outputDir, `output_all_years_${slug}.enrichment.meta.json`));
  artifacts.push(meta);
  return { artifacts, ways, index, meta };
}

function updateMetadata(meta, artifact, stats) {
  const descriptor = sourceDescriptor(artifact);
  meta.sources = meta.sources || {};
  meta.sources.roadSlope = {
    sourceId: descriptor.id,
    source: descriptor.datasetTitle,
    publisher: descriptor.publisher,
    datasetUrl: descriptor.datasetUrl,
    distributionUrl: descriptor.distributionUrl || null,
    licenseId: descriptor.licenseId,
    licenseName: descriptor.licenseName,
    licenseUrl: descriptor.licenseUrl,
    requiredAttribution: descriptor.requiredAttribution,
    resolutionM: descriptor.resolutionMeters,
    modelType: descriptor.modelType,
    horizontalCrs: descriptor.horizontalCrs,
    acquisitionPeriod: descriptor.acquisitionPeriod || null,
    publicationDate: descriptor.publicationDate || null,
    retrievedAt: descriptor.retrievedAt,
    manifestSha256: artifact.source.manifestSha256,
    distributionSha256: artifact.source.distributionSha256,
    producerVersion: artifact.producerVersion,
    method: artifact.method,
    windowsMeters: artifact.windowsMeters,
  };
  meta.counts = meta.counts || {};
  meta.counts.withDgm1RoadSlope = stats.applied;
  meta.roadSlope = {
    sourceId: descriptor.id,
    method: artifact.method,
    windowsMeters: artifact.windowsMeters,
    primaryWindowOrder: PRIMARY_WINDOWS,
    runtimeWayRows: stats.rows,
    runtimeWayRowsWithUsableGradient: stats.applied,
    uniqueWaysObserved: stats.uniqueWaysObserved,
    coverage: artifact.coverage,
    failClosed: true,
  };
}

function applyHannoverDgm1RoadProfiles(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const city = String(options.city || CITY).trim();
  if (slugify(city) !== 'hannover') fail('this adapter is restricted to Hannover');
  const slug = 'hannover';
  const outputDir = path.resolve(root, options.outputDir || 'out');
  const profilesFile = path.resolve(root, options.profilesFile || '.build/context-provider/hannover-dgm1-road-profiles.json');
  const profileArtifact = readJsonArtifact(profilesFile).value;
  const validated = validateProfiles(profileArtifact);
  const descriptor = sourceDescriptor(profileArtifact);
  const runtime = loadRuntimeArtifacts(outputDir, slug);
  const observed = new Set();
  let rows = 0;
  let applied = 0;

  for (const artifact of runtime.artifacts) {
    if (artifact === runtime.meta) continue;
    const result = applyProfilesToWaysPayload(artifact.value, validated.profiles, descriptor, observed);
    rows += result.rows;
    applied += result.applied;
  }

  const missing = validated.ids.filter(wayId => !observed.has(wayId));
  if (missing.length) {
    fail(`${missing.length} validated DGM1 profile ways are absent from runtime context tiles; first=${missing[0]}`);
  }
  if (!rows || !applied) fail('DGM1 adapter produced no usable runtime road gradients');

  updateMetadata(runtime.meta.value, profileArtifact, {
    rows,
    applied,
    uniqueWaysObserved: observed.size,
  });
  writeArtifactsAtomically(runtime.artifacts, options);

  return {
    city: CITY,
    slug,
    profileWays: validated.ids.length,
    runtimeWayRows: rows,
    appliedWayRows: applied,
    uniqueWaysObserved: observed.size,
    sourceId: descriptor.id,
    resolutionMeters: descriptor.resolutionMeters,
  };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') options.root = argv[++index];
    else if (argument === '--city') options.city = argv[++index];
    else if (argument === '--output-dir') options.outputDir = argv[++index];
    else if (argument === '--profiles') options.profilesFile = argv[++index];
    else if (argument === '--json') options.json = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail(`unknown argument ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/apply-hannover-dgm1-road-profiles.js ' +
    '--profiles <artifact.json[.gz]> [--output-dir out] [--json]\n',
  );
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  const result = applyHannoverDgm1RoadProfiles(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(
    `[hannover-dgm1-apply] ${result.uniqueWaysObserved} ways, ` +
    `${result.appliedWayRows}/${result.runtimeWayRows} runtime rows with official 1 m gradients\n`,
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  SOURCE_ID,
  CITY,
  PRIMARY_WINDOWS,
  SLOPE_FIELDS,
  readJsonArtifact,
  encodeArtifact,
  writeArtifactsAtomically,
  classifySlope,
  clearSlopeFields,
  normalizedReason,
  selectPrimaryProfile,
  sourceDescriptor,
  applyProfileToRow,
  validateProfiles,
  applyProfilesToWaysPayload,
  loadRuntimeArtifacts,
  updateMetadata,
  applyHannoverDgm1RoadProfiles,
  parseArgs,
  main,
});