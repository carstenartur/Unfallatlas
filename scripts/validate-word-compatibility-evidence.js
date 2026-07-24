#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const INPUT_SCHEMA = 'unfallwerkbank.word-compatibility-inputs/v1';
const EVIDENCE_SCHEMA = 'unfallwerkbank.word-compatibility-evidence/v1';
const REPORT_SCHEMA = 'unfallwerkbank.word-compatibility-report/v1';
const DEFAULT_CONFIG = 'config/word-compatibility-inputs.json';
const DEFAULT_MAX_AGE_DAYS = 30;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const REQUIRED_CHECKS = Object.freeze([
  'openedWithoutRepairWarning',
  'savedAndReopenedWithoutRepairWarning',
  'pageCountMatchesGolden',
  'mapsUndistorted',
  'tablesReadableAndNotClipped',
  'topDeviationsHeadingKeptWithTable',
  'hyperlinksClickable',
  'noMissingGlyphs',
]);

class WordCompatibilityEvidenceError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'WordCompatibilityEvidenceError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new WordCompatibilityEvidenceError(code, message, details);
}

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '..'),
    config: DEFAULT_CONFIG,
    evidence: null,
    report: null,
    writeTemplate: null,
    printFingerprint: false,
    maxAgeDays: DEFAULT_MAX_AGE_DAYS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] || '');
    else if (arg === '--config') options.config = argv[++index];
    else if (arg === '--evidence') options.evidence = argv[++index];
    else if (arg === '--report') options.report = argv[++index];
    else if (arg === '--write-template') options.writeTemplate = argv[++index];
    else if (arg === '--print-fingerprint') options.printFingerprint = true;
    else if (arg === '--max-age-days') options.maxAgeDays = Number(argv[++index]);
    else fail('unknown_argument', `Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(options.maxAgeDays) || options.maxAgeDays <= 0) {
    fail('invalid_max_age', '--max-age-days must be a positive number', {
      value: options.maxAgeDays,
    });
  }
  return options;
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_string', `${label} must be a non-empty string`, { value });
  }
  return value.trim();
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(plainObject(value, label)).sort();
  const required = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required)) {
    fail('unexpected_fields', `${label} must contain exactly the declared fields`, {
      expected: required,
      actual,
    });
  }
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`));
}

function nearestExistingAncestor(candidate) {
  let current = candidate;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return current;
}

function resolveInsideRoot(root, candidate, label) {
  const absoluteRoot = path.resolve(nonEmptyString(String(root || ''), 'repository root'));
  const raw = nonEmptyString(candidate, label);
  if (raw.includes('\0')) {
    fail('unsafe_path', `${label} must stay inside the repository`, { value: candidate });
  }
  const normalized = raw.replace(/\\/g, '/');
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(raw) ||
      /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    fail('unsafe_path', `${label} must stay inside the repository`, { value: candidate });
  }
  const absolute = path.resolve(absoluteRoot, raw);
  if (!isInsideRoot(absoluteRoot, absolute)) {
    fail('unsafe_path', `${label} must stay inside the repository`, { value: candidate });
  }

  const rootAncestor = nearestExistingAncestor(absoluteRoot);
  const targetAncestor = nearestExistingAncestor(absolute);
  if (rootAncestor && targetAncestor) {
    const realRoot = fs.realpathSync(rootAncestor);
    const realTargetAncestor = fs.realpathSync(targetAncestor);
    if (!isInsideRoot(realRoot, realTargetAncestor)) {
      fail('unsafe_path', `${label} resolves outside the repository`, { value: candidate });
    }
  }
  return absolute;
}

function readJson(filePath, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail('invalid_json', `Cannot read ${label}: ${filePath}`, { cause: error.message });
  }
  return value;
}

function safeRelativePath(value, label) {
  const relative = nonEmptyString(value, label).replace(/\\/g, '/');
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(value) ||
      /^[A-Za-z]:\//.test(relative) || relative.startsWith('//') ||
      relative.startsWith('../') || relative.includes('/../') ||
      relative === '..' || relative.includes('\0')) {
    fail('unsafe_path', `${label} must stay inside the repository`, { value });
  }
  return relative;
}

function uniqueSortedStrings(value, label, pathValues = false) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('invalid_array', `${label} must be a non-empty array`);
  }
  const normalized = value.map((item, index) => pathValues
    ? safeRelativePath(item, `${label}[${index}]`)
    : nonEmptyString(item, `${label}[${index}]`));
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    fail('duplicate_value', `${label} must not contain duplicates`, { values: normalized });
  }
  return [...unique].sort((left, right) => left.localeCompare(right, 'en'));
}

function normalizeInputConfig(value) {
  const config = plainObject(value, 'input config');
  exactKeys(config, ['schemaVersion', 'files', 'lockedPackages'], 'input config');
  if (config.schemaVersion !== INPUT_SCHEMA) {
    fail('unsupported_input_schema', `Expected ${INPUT_SCHEMA}`, { value: config.schemaVersion });
  }
  return Object.freeze({
    schemaVersion: INPUT_SCHEMA,
    files: Object.freeze(uniqueSortedStrings(config.files, 'input config.files', true)),
    lockedPackages: Object.freeze(uniqueSortedStrings(
      config.lockedPackages,
      'input config.lockedPackages',
      false,
    )),
  });
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function lockedPackageEvidence(lock, packageName) {
  const record = lock?.packages?.[`node_modules/${packageName}`];
  if (!record || typeof record !== 'object') {
    fail('locked_package_missing', `package-lock.json does not contain ${packageName}`);
  }
  const evidence = {
    name: packageName,
    version: nonEmptyString(record.version, `${packageName}.version`),
    resolved: nonEmptyString(record.resolved, `${packageName}.resolved`),
    integrity: nonEmptyString(record.integrity, `${packageName}.integrity`),
  };
  return Object.freeze(evidence);
}

function computeInputEvidence(root, configPath = DEFAULT_CONFIG) {
  const absoluteRoot = path.resolve(root);
  const absoluteConfig = resolveInsideRoot(
    absoluteRoot,
    configPath,
    'Word compatibility input config path',
  );
  const config = normalizeInputConfig(readJson(absoluteConfig, 'Word compatibility input config'));
  const digest = crypto.createHash('sha256');
  digest.update(canonicalJson(config));
  digest.update('\n');

  const files = config.files.map((relative) => {
    const absolute = resolveInsideRoot(absoluteRoot, relative, `compatibility input ${relative}`);
    let bytes;
    try {
      bytes = fs.readFileSync(absolute);
    } catch (error) {
      fail('input_file_missing', `Cannot read compatibility input ${relative}`, {
        cause: error.message,
      });
    }
    const fileHash = sha256(bytes);
    digest.update(`file\0${relative}\0${fileHash}\n`);
    return Object.freeze({ path: relative, bytes: bytes.length, sha256: fileHash });
  });

  const lockPath = resolveInsideRoot(absoluteRoot, 'package-lock.json', 'package-lock.json path');
  const lock = readJson(lockPath, 'package-lock.json');
  const packages = config.lockedPackages.map((name) => lockedPackageEvidence(lock, name));
  for (const item of packages) digest.update(`package\0${canonicalJson(item)}\n`);

  return Object.freeze({
    schemaVersion: INPUT_SCHEMA,
    configPath: path.relative(absoluteRoot, absoluteConfig).replace(/\\/g, '/'),
    fingerprint: digest.digest('hex'),
    files: Object.freeze(files),
    packages: Object.freeze(packages),
  });
}

function isoDate(value, label) {
  const text = nonEmptyString(value, label);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) fail('invalid_date', `${label} must be an ISO timestamp`, { value });
  return { text, milliseconds, iso: new Date(milliseconds).toISOString() };
}

function sha256String(value, label) {
  const normalized = nonEmptyString(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    fail('invalid_sha256', `${label} must be a lowercase SHA-256`, { value });
  }
  return normalized;
}

function validateReceipt(value, inputEvidence, options = {}) {
  const receipt = plainObject(value, 'Word compatibility evidence');
  exactKeys(receipt, [
    'schemaVersion', 'inputFingerprint', 'testedAt', 'sourceCommit', 'artifact',
    'environment', 'reviewer', 'observedPageCount', 'checks', 'notes',
  ], 'Word compatibility evidence');
  if (receipt.schemaVersion !== EVIDENCE_SCHEMA) {
    fail('unsupported_evidence_schema', `Expected ${EVIDENCE_SCHEMA}`, {
      value: receipt.schemaVersion,
    });
  }
  const inputFingerprint = sha256String(receipt.inputFingerprint, 'inputFingerprint');
  if (inputFingerprint !== inputEvidence.fingerprint) {
    fail('input_fingerprint_mismatch', 'Word evidence was produced for different renderer inputs', {
      expected: inputEvidence.fingerprint,
      actual: inputFingerprint,
    });
  }
  const testedAt = isoDate(receipt.testedAt, 'testedAt');
  const now = options.now == null ? Date.now() : Number(options.now);
  const maxAgeDays = options.maxAgeDays == null ? DEFAULT_MAX_AGE_DAYS : Number(options.maxAgeDays);
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    fail('invalid_validation_clock', 'Validation clock and maximum age must be finite');
  }
  if (testedAt.milliseconds > now + FUTURE_TOLERANCE_MS) {
    fail('evidence_from_future', 'testedAt is unreasonably far in the future', {
      testedAt: testedAt.iso,
      now: new Date(now).toISOString(),
    });
  }
  const ageMs = now - testedAt.milliseconds;
  if (ageMs > maxAgeDays * 24 * 60 * 60 * 1000) {
    fail('evidence_expired', `Word evidence is older than ${maxAgeDays} days`, {
      testedAt: testedAt.iso,
      ageDays: ageMs / (24 * 60 * 60 * 1000),
    });
  }

  const sourceCommit = nonEmptyString(receipt.sourceCommit, 'sourceCommit').toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) {
    fail('invalid_commit', 'sourceCommit must be a full Git commit SHA', { value: receipt.sourceCommit });
  }

  exactKeys(receipt.artifact, ['filename', 'bytes', 'sha256', 'documentId', 'generator'], 'artifact');
  const filename = nonEmptyString(receipt.artifact.filename, 'artifact.filename');
  if (!filename.toLowerCase().endsWith('.docx')) {
    fail('invalid_artifact', 'artifact.filename must be a DOCX file', { filename });
  }
  const artifactBytes = Number(receipt.artifact.bytes);
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes < 1024) {
    fail('invalid_artifact', 'artifact.bytes must be a safe integer of at least 1024 bytes', {
      value: receipt.artifact.bytes,
    });
  }
  const artifactSha256 = sha256String(receipt.artifact.sha256, 'artifact.sha256');
  const documentId = nonEmptyString(receipt.artifact.documentId, 'artifact.documentId');
  const generator = nonEmptyString(receipt.artifact.generator, 'artifact.generator');

  exactKeys(receipt.environment, ['product', 'version', 'platform'], 'environment');
  if (nonEmptyString(receipt.environment.product, 'environment.product') !== 'Microsoft Word') {
    fail('invalid_product', 'environment.product must be Microsoft Word', {
      value: receipt.environment.product,
    });
  }
  const version = nonEmptyString(receipt.environment.version, 'environment.version');
  const platform = nonEmptyString(receipt.environment.platform, 'environment.platform');

  exactKeys(receipt.reviewer, ['githubLogin'], 'reviewer');
  const githubLogin = nonEmptyString(receipt.reviewer.githubLogin, 'reviewer.githubLogin');
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(githubLogin)) {
    fail('invalid_reviewer', 'reviewer.githubLogin is not a valid GitHub login', { githubLogin });
  }

  const observedPageCount = Number(receipt.observedPageCount);
  if (!Number.isSafeInteger(observedPageCount) || observedPageCount < 1) {
    fail('invalid_page_count', 'observedPageCount must be a positive integer', {
      value: receipt.observedPageCount,
    });
  }

  exactKeys(receipt.checks, REQUIRED_CHECKS, 'checks');
  const failedChecks = REQUIRED_CHECKS.filter((key) => receipt.checks[key] !== true);
  if (failedChecks.length) {
    fail('word_checks_failed', 'Every Microsoft Word compatibility check must be true', {
      failedChecks,
    });
  }
  if (typeof receipt.notes !== 'string') {
    fail('invalid_notes', 'notes must be a string', { value: receipt.notes });
  }

  return Object.freeze({
    schemaVersion: EVIDENCE_SCHEMA,
    passed: true,
    inputFingerprint,
    testedAt: testedAt.iso,
    ageDays: Math.max(0, ageMs / (24 * 60 * 60 * 1000)),
    sourceCommit,
    artifact: Object.freeze({
      filename,
      bytes: artifactBytes,
      sha256: artifactSha256,
      documentId,
      generator,
    }),
    environment: Object.freeze({ product: 'Microsoft Word', version, platform }),
    reviewer: Object.freeze({ githubLogin }),
    observedPageCount,
    checks: Object.freeze(Object.fromEntries(REQUIRED_CHECKS.map((key) => [key, true]))),
    notes: receipt.notes,
  });
}

function templateFor(inputEvidence, now = Date.now()) {
  return {
    schemaVersion: EVIDENCE_SCHEMA,
    inputFingerprint: inputEvidence.fingerprint,
    testedAt: new Date(now).toISOString(),
    sourceCommit: '<40-character-git-commit-sha>',
    artifact: {
      filename: 'source.docx',
      bytes: 0,
      sha256: '<sha256-of-the-exact-docx-opened-in-word>',
      documentId: 'ci-docx-sample',
      generator: 'npm run generate:sample-docx',
    },
    environment: {
      product: 'Microsoft Word',
      version: '<Word version and build>',
      platform: '<Windows or macOS version>',
    },
    reviewer: {
      githubLogin: '<reviewer-github-login>',
    },
    observedPageCount: 0,
    checks: Object.fromEntries(REQUIRED_CHECKS.map((key) => [key, false])),
    notes: '',
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function displayPath(value) {
  return typeof value === 'string' ? value.replace(/\\/g, '/') : value;
}

function errorRecord(error) {
  return {
    name: error?.name || 'Error',
    code: error?.code || 'validation_failed',
    message: error?.message || String(error),
    details: error?.details || null,
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const absoluteRoot = path.resolve(options.root);
  const reportPath = options.report
    ? resolveInsideRoot(absoluteRoot, options.report, '--report')
    : null;
  const templatePath = options.writeTemplate
    ? resolveInsideRoot(absoluteRoot, options.writeTemplate, '--write-template')
    : null;
  const evidenceLabel = displayPath(options.evidence);
  let inputEvidence = null;

  try {
    inputEvidence = computeInputEvidence(absoluteRoot, options.config);
    if (options.printFingerprint) process.stdout.write(`${inputEvidence.fingerprint}\n`);
    if (templatePath) {
      writeJson(templatePath, templateFor(inputEvidence));
      process.stdout.write(`[word-compatibility] wrote template ${templatePath}\n`);
      return { inputEvidence, template: templatePath };
    }
    if (!options.evidence) {
      if (options.printFingerprint) return { inputEvidence };
      fail('missing_evidence', '--evidence is required unless --write-template or --print-fingerprint is used');
    }
    const evidencePath = resolveInsideRoot(absoluteRoot, options.evidence, '--evidence');
    const validated = validateReceipt(
      readJson(evidencePath, 'Microsoft Word compatibility evidence'),
      inputEvidence,
      { maxAgeDays: options.maxAgeDays },
    );
    const report = {
      schemaVersion: REPORT_SCHEMA,
      generatedAt: new Date().toISOString(),
      passed: true,
      inputEvidence,
      evidencePath: path.relative(absoluteRoot, evidencePath).replace(/\\/g, '/'),
      validation: validated,
      error: null,
    };
    if (reportPath) writeJson(reportPath, report);
    process.stdout.write(
      `[word-compatibility] passed for ${validated.environment.version} on ` +
      `${validated.environment.platform}; fingerprint ${inputEvidence.fingerprint}.\n`,
    );
    return report;
  } catch (error) {
    if (reportPath) {
      writeJson(reportPath, {
        schemaVersion: REPORT_SCHEMA,
        generatedAt: new Date().toISOString(),
        passed: false,
        inputEvidence,
        evidencePath: evidenceLabel,
        validation: null,
        error: errorRecord(error),
      });
    }
    throw error;
  }
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    if (error?.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  INPUT_SCHEMA,
  EVIDENCE_SCHEMA,
  REPORT_SCHEMA,
  DEFAULT_CONFIG,
  DEFAULT_MAX_AGE_DAYS,
  FUTURE_TOLERANCE_MS,
  REQUIRED_CHECKS,
  WordCompatibilityEvidenceError,
  parseArgs,
  resolveInsideRoot,
  normalizeInputConfig,
  canonicalJson,
  computeInputEvidence,
  validateReceipt,
  templateFor,
  main,
};
