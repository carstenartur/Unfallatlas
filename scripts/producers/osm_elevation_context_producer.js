#!/usr/bin/env node
'use strict';

/**
 * Atomic orchestration for the two OSM elevation-safety stages:
 *
 *   1. fetch complete structure tags for every existing OSM way;
 *   2. derive and validate the normalized computeRoadGradient risk contract.
 *
 * Both stages run on a sibling staging file. The original city cache is
 * replaced only after the final per-way contract validates completely.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const structureProducer = require('./osm_structure_producer');
const riskProducer = require('./osm_elevation_risk_producer');

const PRODUCER_VERSION = '1.0.0';

class OsmElevationContextError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'OsmElevationContextError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new OsmElevationContextError(code, message, details);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJsonFile(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('invalid_json', `${label} is not valid UTF-8 JSON`, {
      file,
      cause: error.message,
    });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_json', `${label} must contain an object`, { file });
  }
  return value;
}

function currentContract(file) {
  const value = readJsonFile(file, 'OSM elevation context input');
  try {
    return riskProducer.validateElevationRiskContract(value);
  } catch (error) {
    if (error instanceof riskProducer.OsmElevationRiskError) return null;
    throw error;
  }
}

function siblingPath(file, kind) {
  return `${file}.${kind}-${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
}

function publishStage(stageFile, targetFile, hooks = {}) {
  const renameSync = hooks.renameSync || fs.renameSync;
  const rmSync = hooks.rmSync || fs.rmSync;
  const existsSync = hooks.existsSync || fs.existsSync;
  const lstatSync = hooks.lstatSync || fs.lstatSync;
  const backupFile = siblingPath(targetFile, 'backup');
  let movedOriginal = false;
  let installed = false;
  let preserveBackup = false;

  if (existsSync(backupFile)) {
    fail('occupied_backup', 'refusing occupied publication backup path', { backupFile });
  }
  if (existsSync(targetFile)) {
    const targetStat = lstatSync(targetFile);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      fail('unsafe_target', 'OSM elevation context target must be a non-symlink regular file', {
        targetFile,
      });
    }
  }

  try {
    if (existsSync(targetFile)) {
      renameSync(targetFile, backupFile);
      movedOriginal = true;
    }
    renameSync(stageFile, targetFile);
    installed = true;
    if (movedOriginal) rmSync(backupFile, { force: true });
  } catch (error) {
    try {
      if (installed && existsSync(targetFile)) rmSync(targetFile, { force: true });
      if (movedOriginal && existsSync(backupFile)) renameSync(backupFile, targetFile);
    } catch (rollbackError) {
      preserveBackup = movedOriginal && existsSync(backupFile);
      fail('rollback_failed', 'cannot restore previous OSM elevation context after publish failure', {
        targetFile,
        stageFile,
        backupFile,
        backupPreserved: preserveBackup,
        publishCause: error.message,
        rollbackCause: rollbackError.message,
      });
    }
    fail('publish_failed', 'cannot atomically install OSM elevation context', {
      targetFile,
      stageFile,
      cause: error.message,
    });
  } finally {
    if (!preserveBackup && existsSync(backupFile)) rmSync(backupFile, { force: true });
  }
  return targetFile;
}

async function prepareOsmElevationContext(options = {}) {
  const inputFile = riskProducer.resolveRegularFile(options.inputFile, 'input file');
  const inputSha256 = sha256File(inputFile);
  if (!options.force) {
    const current = currentContract(inputFile);
    if (current) {
      return Object.freeze({
        producerVersion: PRODUCER_VERSION,
        skipped: true,
        reason: 'already current',
        inputFile,
        outputFile: inputFile,
        inputSha256,
        outputSha256: inputSha256,
        wayCount: current.wayIds.length,
        structureQueryFingerprint: current.metadata.queryFingerprint,
        sourceStructureFingerprint: current.sourceStructureFingerprint,
      });
    }
  }

  const stageFile = siblingPath(inputFile, 'elevation-context-tmp');
  if (fs.existsSync(stageFile)) {
    fail('occupied_stage', 'refusing occupied staging path', { stageFile });
  }
  fs.copyFileSync(inputFile, stageFile, fs.constants.COPYFILE_EXCL);

  try {
    const structureResult = await structureProducer.enrichOsmStructureFile({
      inputFile: stageFile,
      outputFile: stageFile,
      batchSize: options.batchSize,
      interBatchDelayMs: options.interBatchDelayMs,
      endpoint: options.endpoint,
      retries: options.retries,
      backoffMs: options.backoffMs,
      timeoutMs: options.timeoutMs,
      retrievedAt: options.retrievedAt,
      force: Boolean(options.force),
      fetchOverpass: options.fetchOverpass,
      sleep: options.sleep,
    });
    const riskResult = riskProducer.processFile({
      inputFile: stageFile,
      outputFile: stageFile,
      derivedAt: options.derivedAt,
      force: Boolean(options.force),
    });
    const stagedValue = readJsonFile(stageFile, 'staged OSM elevation context');
    const validated = riskProducer.validateElevationRiskContract(stagedValue);
    const stagedSha256 = sha256File(stageFile);

    publishStage(stageFile, inputFile, options.publishHooks);
    const outputSha256 = sha256File(inputFile);
    if (outputSha256 !== stagedSha256) {
      fail('published_hash_mismatch', 'published OSM elevation context differs from validated staging bytes', {
        expected: stagedSha256,
        actual: outputSha256,
      });
    }

    return Object.freeze({
      producerVersion: PRODUCER_VERSION,
      skipped: false,
      inputFile,
      outputFile: inputFile,
      inputSha256,
      outputSha256,
      wayCount: validated.wayIds.length,
      structureQueryFingerprint: validated.metadata.queryFingerprint,
      sourceStructureFingerprint: validated.sourceStructureFingerprint,
      structure: Object.freeze({
        skipped: Boolean(structureResult.skipped),
        batchCount: structureResult.batchCount || 0,
        queryFingerprint:
          structureResult.queryFingerprint || validated.metadata.queryFingerprint,
      }),
      risk: Object.freeze({
        skipped: Boolean(riskResult.skipped),
        sourceStructureFingerprint:
          riskResult.sourceStructureFingerprint || validated.sourceStructureFingerprint,
      }),
    });
  } finally {
    fs.rmSync(stageFile, { force: true });
  }
}

function parseArgs(argv) {
  const options = {
    inputFile: null,
    batchSize: structureProducer.DEFAULT_BATCH_SIZE,
    interBatchDelayMs: structureProducer.DEFAULT_INTER_BATCH_DELAY_MS,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.inputFile = argv[++index];
    else if (argument === '--batch-size') options.batchSize = Number(argv[++index]);
    else if (argument === '--delay') options.interBatchDelayMs = Number(argv[++index]);
    else if (argument === '--endpoint') options.endpoint = argv[++index];
    else if (argument === '--retries') options.retries = Number(argv[++index]);
    else if (argument === '--backoff') options.backoffMs = Number(argv[++index]);
    else if (argument === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (argument === '--retrieved-at') options.retrievedAt = argv[++index];
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
    'Usage: node scripts/producers/osm_elevation_context_producer.js --input <osm_city.json> ' +
      '[--batch-size <n>] [--delay <ms>] [--force] [--json]\n',
  );
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return 0;
  }
  if (!options.inputFile) fail('missing_argument', '--input is required');
  const result = await prepareOsmElevationContext(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result.skipped) {
    process.stdout.write(`[osm-elevation-context] SKIP: ${result.reason} (${result.outputFile})\n`);
  } else {
    process.stdout.write(
      `[osm-elevation-context] prepared ${result.wayCount} ways → ${result.outputFile}\n`,
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
  OsmElevationContextError,
  sha256File,
  readJsonFile,
  currentContract,
  siblingPath,
  publishStage,
  prepareOsmElevationContext,
  parseArgs,
  main,
});
