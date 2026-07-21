#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const EVIDENCE_RELATIVE_PATH = 'vendor/license-evidence.json';
const POLICY_RELATIVE_PATH = 'vendor/provenance-policy.json';
const ALLOWED_RELEASE_BINDINGS = new Set([
  'exact-release-file',
  'project-license-with-package-metadata',
]);
const HASH = /^[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`[vendor-license-evidence] Missing ${label}: ${file}`);
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`[vendor-license-evidence] Invalid ${label}: ${error.message}`); }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[vendor-license-evidence] Missing ${label}`);
  }
  return value.trim();
}

function assertHttps(value, label) {
  const text = requiredString(value, label);
  let parsed;
  try { parsed = new URL(text); } catch (_) {
    throw new Error(`[vendor-license-evidence] Invalid ${label}: ${text}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`[vendor-license-evidence] ${label} must use https: ${text}`);
  }
}

function resolveInside(repoRoot, relative, label) {
  const text = requiredString(relative, label).replace(/\\/g, '/');
  if (!text.startsWith('vendor/') || text.includes('\0')) {
    throw new Error(`[vendor-license-evidence] ${label} must be under vendor/: ${text}`);
  }
  const absolute = path.resolve(repoRoot, text);
  const relation = path.relative(repoRoot, absolute);
  if (!relation || relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error(`[vendor-license-evidence] ${label} escapes the repository: ${text}`);
  }
  return absolute;
}

function assertCompleteLicenseText(text, spdx, label) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  if (normalized.length < 500 || !/Copyright/i.test(normalized)) {
    throw new Error(`[vendor-license-evidence] ${label} lacks a complete copyright-bearing text`);
  }
  if (spdx === 'MIT') {
    for (const phrase of [
      'Permission is hereby granted',
      'included in all copies or substantial portions',
      'THE SOFTWARE IS PROVIDED "AS IS"',
    ]) {
      if (!normalized.includes(phrase)) {
        throw new Error(`[vendor-license-evidence] ${label} is not a complete MIT text (${phrase})`);
      }
    }
    return;
  }
  if (spdx === 'BSD-2-Clause' || spdx === 'BSD-3-Clause') {
    for (const phrase of [
      'Redistribution and use in source and binary forms',
      'Redistributions of source code must retain',
      'Redistributions in binary form must reproduce',
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS',
    ]) {
      if (!normalized.includes(phrase)) {
        throw new Error(`[vendor-license-evidence] ${label} is not a complete ${spdx} text (${phrase})`);
      }
    }
    if (spdx === 'BSD-3-Clause' && !/may not be used to endorse or promote/i.test(normalized)) {
      throw new Error(`[vendor-license-evidence] ${label} lacks the BSD-3 non-endorsement clause`);
    }
    return;
  }
  throw new Error(`[vendor-license-evidence] Unsupported SPDX expression: ${spdx}`);
}

function validateRecord(record, index, context) {
  const label = `record[${index}]`;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`[vendor-license-evidence] Invalid ${label}`);
  }
  const packageName = requiredString(record.package, `${label}.package`);
  const version = requiredString(record.version, `${label}.version`);
  const key = `${packageName}@${version}`;
  if (context.keys.has(key)) throw new Error(`[vendor-license-evidence] Duplicate package evidence: ${key}`);
  context.keys.add(key);

  const spdx = requiredString(record.spdx, `${label}.spdx`);
  const evidencePath = requiredString(record.licenseTextPath, `${label}.licenseTextPath`);
  if (context.paths.has(evidencePath)) {
    throw new Error(`[vendor-license-evidence] Duplicate license text path: ${evidencePath}`);
  }
  context.paths.add(evidencePath);
  const absolute = resolveInside(context.repoRoot, evidencePath, `${label}.licenseTextPath`);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`[vendor-license-evidence] Missing license text for ${key}: ${evidencePath}`);
  }
  const bytes = fs.readFileSync(absolute);
  const expectedHash = requiredString(record.licenseTextSha256, `${label}.licenseTextSha256`);
  if (!HASH.test(expectedHash) || sha256(bytes) !== expectedHash) {
    throw new Error(`[vendor-license-evidence] License hash drift for ${key}`);
  }
  assertCompleteLicenseText(bytes.toString('utf8'), spdx, key);

  assertHttps(record.sourceRepository, `${label}.sourceRepository`);
  requiredString(record.sourceRef, `${label}.sourceRef`);
  requiredString(record.sourceFile, `${label}.sourceFile`);
  const sourceBlobSha = requiredString(record.sourceBlobSha, `${label}.sourceBlobSha`);
  if (!/^[a-f0-9]{40}$/.test(sourceBlobSha)) {
    throw new Error(`[vendor-license-evidence] Invalid upstream blob SHA for ${key}`);
  }
  if (!ALLOWED_RELEASE_BINDINGS.has(record.releaseBinding)) {
    throw new Error(`[vendor-license-evidence] Unsupported release binding for ${key}: ${record.releaseBinding}`);
  }
  if (!Array.isArray(record.coversAssets) || record.coversAssets.length === 0) {
    throw new Error(`[vendor-license-evidence] ${key} covers no delivered assets`);
  }
  const uniqueAssets = new Set();
  for (const asset of record.coversAssets) {
    const assetPath = requiredString(asset, `${label}.coversAssets`);
    if (!assetPath.startsWith('vendor/') || assetPath.includes('..') || uniqueAssets.has(assetPath)) {
      throw new Error(`[vendor-license-evidence] Invalid covered asset for ${key}: ${assetPath}`);
    }
    uniqueAssets.add(assetPath);
  }

  if (record.lockRequired === true) {
    const locked = context.lock.packages && context.lock.packages[`node_modules/${packageName}`];
    if (!locked || locked.version !== version || typeof locked.integrity !== 'string' || !locked.integrity.startsWith('sha512-')) {
      throw new Error(`[vendor-license-evidence] Lock binding missing for ${key}`);
    }
  } else if (record.lockRequired === false) {
    const gapId = requiredString(record.unresolvedGapId, `${label}.unresolvedGapId`);
    if (!context.unresolvedGapIds.has(gapId)) {
      throw new Error(`[vendor-license-evidence] Unlocked ${key} is not bound to an unresolved policy gap: ${gapId}`);
    }
  } else {
    throw new Error(`[vendor-license-evidence] ${key} must declare lockRequired`);
  }

  return {
    package: packageName,
    version,
    spdx,
    licenseTextPath: evidencePath,
    licenseTextSha256: expectedHash,
    releaseBinding: record.releaseBinding,
    lockRequired: record.lockRequired,
    coveredAssetCount: uniqueAssets.size,
  };
}

function validateVendorLicenseEvidence(options = {}) {
  const repoRoot = path.resolve(options.root || path.join(__dirname, '..'));
  const evidencePath = path.resolve(repoRoot, options.evidence || EVIDENCE_RELATIVE_PATH);
  const policyPath = path.resolve(repoRoot, options.policy || POLICY_RELATIVE_PATH);
  const lockPath = path.resolve(repoRoot, options.lock || 'package-lock.json');
  const evidence = readJson(evidencePath, 'license evidence manifest');
  const policy = readJson(policyPath, 'vendor provenance policy');
  const lock = readJson(lockPath, 'package lock');

  if (evidence.schemaVersion !== 1 || !evidence.evidenceId ||
      !Array.isArray(evidence.records) || evidence.records.length === 0) {
    throw new Error('[vendor-license-evidence] Unsupported or empty evidence manifest');
  }
  if (evidence.trackingIssue !== policy.trackingIssue) {
    throw new Error('[vendor-license-evidence] Evidence and provenance policy track different issues');
  }
  const unresolvedGapIds = new Set((policy.unresolvedAssets || []).map(item => item && item.id));
  const context = { repoRoot, policy, lock, unresolvedGapIds, keys: new Set(), paths: new Set() };
  const records = evidence.records.map((record, index) => validateRecord(record, index, context));
  return Object.freeze({
    schemaVersion: 1,
    evidenceId: evidence.evidenceId,
    manifestPath: path.relative(repoRoot, evidencePath).replace(/\\/g, '/'),
    manifestSha256: sha256(fs.readFileSync(evidencePath)),
    recordCount: records.length,
    exactReleaseRecordCount: records.filter(item => item.releaseBinding === 'exact-release-file').length,
    projectLicenseRecordCount: records.filter(item => item.releaseBinding === 'project-license-with-package-metadata').length,
    lockedRecordCount: records.filter(item => item.lockRequired).length,
    unresolvedRecordCount: records.filter(item => !item.lockRequired).length,
    records: Object.freeze(records),
  });
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = argv[++index];
    else if (arg === '--evidence') options.evidence = argv[++index];
    else if (arg === '--policy') options.policy = argv[++index];
    else if (arg === '--lock') options.lock = argv[++index];
    else throw new Error(`[vendor-license-evidence] Unknown argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  try {
    const result = validateVendorLicenseEvidence(parseArgs(process.argv.slice(2)));
    process.stdout.write(
      `[vendor-license-evidence] ${result.recordCount} records validated ` +
      `(${result.exactReleaseRecordCount} exact-release, ${result.unresolvedRecordCount} still policy-gapped).\n`
    );
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_RELEASE_BINDINGS,
  EVIDENCE_RELATIVE_PATH,
  POLICY_RELATIVE_PATH,
  assertCompleteLicenseText,
  validateVendorLicenseEvidence,
};
