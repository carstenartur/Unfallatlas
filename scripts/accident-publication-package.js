#!/usr/bin/env node
'use strict';

/**
 * Build and later re-verify the exact allowlisted payload that may be published
 * by the accident-data refresh workflow. The publishing job never stages the
 * worktree wholesale; it copies only this immutable payload into a fresh
 * checkout and stages exactly the recorded paths.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CONTRACT = 'unfallwerkbank-accident-publication-package/v1';
const DEFAULT_PACKAGE_DIR = '.build/accident-publication';

class PublicationPackageError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'PublicationPackageError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new PublicationPackageError(code, message, details);
}

function parseArgs(argv) {
  const args = {
    command: null,
    root: path.resolve(__dirname, '..'),
    releaseManifest: 'data/accident-data-release.json',
    packageDir: DEFAULT_PACKAGE_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!args.command && (argument === 'prepare' || argument === 'verify')) {
      args.command = argument;
    } else if (argument === '--root') args.root = path.resolve(argv[++index] || args.root);
    else if (argument === '--release-manifest') {
      args.releaseManifest = argv[++index] || args.releaseManifest;
    } else if (argument === '--package-dir') args.packageDir = argv[++index] || args.packageDir;
    else if (argument === '--help' || argument === '-h') args.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  args.releaseManifest = path.resolve(args.root, args.releaseManifest);
  args.packageDir = path.resolve(args.root, args.packageDir);
  if (!args.help && !args.command) fail('missing_command', 'Expected prepare or verify');
  return args;
}

function git(root, args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: options.encoding || 'utf8',
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    fail('git_command_failed', `git ${args.join(' ')} failed`, {
      stdout: error.stdout && String(error.stdout),
      stderr: error.stderr && String(error.stderr),
      status: error.status,
    });
  }
}

function normalizePath(value) {
  const normalized = String(value || '').split(path.sep).join('/').replace(/^\.\//, '');
  if (!normalized || normalized === '.' || normalized.startsWith('../') || path.isAbsolute(normalized)) {
    fail('invalid_repository_path', `Invalid repository-relative path: ${value}`);
  }
  return normalized;
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('json_read_failed', `Cannot read ${label || file}`, { file, cause: error.message });
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileDescriptor(root, repositoryPath, status) {
  const normalized = normalizePath(repositoryPath);
  const absolute = path.join(root, ...normalized.split('/'));
  if (!fs.existsSync(absolute)) {
    return Object.freeze({ path: normalized, status, deleted: true, bytes: 0, sha256: null });
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('invalid_payload_entry', `${normalized} must be a regular, non-symlink file`);
  }
  const bytes = fs.readFileSync(absolute);
  return Object.freeze({
    path: normalized,
    status,
    deleted: false,
    bytes: bytes.length,
    sha256: sha256(bytes),
  });
}

function parsePorcelainZ(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    if (field.length < 4 || field[2] !== ' ') {
      fail('invalid_git_status', 'Unexpected git status --porcelain=v1 -z entry', { field });
    }
    const status = field.slice(0, 2);
    const repositoryPath = normalizePath(field.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const destination = fields[++index];
      if (!destination) fail('invalid_git_status', 'Rename/copy status lacks destination', { field });
      entries.push({
        status,
        path: normalizePath(destination),
        sourcePath: repositoryPath,
      });
    } else {
      entries.push({ status, path: repositoryPath });
    }
  }
  return entries;
}

function worktreeEntries(root) {
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: root,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
  });
  return parsePorcelainZ(output);
}

function allowedPaths(root, releaseManifestFile) {
  const manifest = readJson(releaseManifestFile, 'accident release manifest');
  if (manifest.contract !== 'unfallwerkbank-accident-data-release/v1') {
    fail('invalid_release_manifest', 'Unsupported accident release manifest contract', {
      actual: manifest.contract,
    });
  }
  if (!Array.isArray(manifest.cities) || manifest.cities.length === 0) {
    fail('invalid_release_manifest', 'Release manifest contains no cities');
  }
  const allowed = new Set([
    normalizePath(path.relative(root, releaseManifestFile)),
    'server/cities/cityCatalogData.json',
  ]);
  for (const city of manifest.cities) {
    for (const kind of ['csv', 'geojson']) {
      const artifact = city.artifacts && city.artifacts[kind];
      if (!artifact || !artifact.path) {
        fail('invalid_release_manifest', `${city.slug || city.city} lacks ${kind} artifact`);
      }
      allowed.add(normalizePath(artifact.path));
    }
  }
  return allowed;
}

const EPHEMERAL_PREFIXES = Object.freeze([
  '.build/',
  '_site/',
  'coverage/',
  'node_modules/',
  'playwright-report/',
  'test-results/',
  'out/qa/',
  'target/',
  'qa-system-tests/target/',
  'analysis-service/target/',
]);

function isEphemeral(repositoryPath) {
  const normalized = normalizePath(repositoryPath);
  return EPHEMERAL_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) ||
    normalized.startsWith(prefix));
}

function cleanPackageDirectory(packageDir) {
  fs.rmSync(packageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(packageDir, 'payload'), { recursive: true });
}

function copyDescriptor(root, packageDir, descriptor) {
  if (descriptor.deleted) return;
  const source = path.join(root, ...descriptor.path.split('/'));
  const destination = path.join(packageDir, 'payload', ...descriptor.path.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const copied = fs.readFileSync(destination);
  if (copied.length !== descriptor.bytes || sha256(copied) !== descriptor.sha256) {
    fail('payload_copy_mismatch', `Copied payload differs for ${descriptor.path}`);
  }
}

function packageFingerprint(baseSha, entries) {
  const canonical = JSON.stringify({
    baseSha,
    entries: entries.map(({ path: repositoryPath, status, deleted, bytes, sha256: digest }) => ({
      path: repositoryPath,
      status,
      deleted,
      bytes,
      sha256: digest,
    })),
  });
  return sha256(Buffer.from(canonical));
}

function prepare(options) {
  const allowed = allowedPaths(options.root, options.releaseManifest);
  const statusEntries = worktreeEntries(options.root);
  const productEntries = statusEntries.filter((entry) => !isEphemeral(entry.path));
  const forbidden = productEntries.filter((entry) =>
    !allowed.has(entry.path) || (entry.sourcePath && !allowed.has(entry.sourcePath))
  );
  if (forbidden.length) {
    fail('unexpected_publication_paths', 'Data refresh changed paths outside the publication allowlist', {
      allowed: [...allowed].sort(),
      forbidden,
    });
  }
  const duplicatePaths = productEntries
    .map((entry) => entry.path)
    .filter((repositoryPath, index, all) => all.indexOf(repositoryPath) !== index);
  if (duplicatePaths.length) fail('duplicate_publication_path', 'Duplicate publication paths', { duplicatePaths });

  const descriptors = productEntries
    .map((entry) => fileDescriptor(options.root, entry.path, entry.status))
    .sort((left, right) => left.path.localeCompare(right.path));

  const deleted = descriptors.filter((entry) => entry.deleted);
  if (deleted.length) {
    fail('publication_deletion_forbidden', 'Accident refresh may not delete allowlisted product files', {
      deleted: deleted.map((entry) => entry.path),
    });
  }

  cleanPackageDirectory(options.packageDir);
  for (const descriptor of descriptors) copyDescriptor(options.root, options.packageDir, descriptor);

  const baseSha = git(options.root, ['rev-parse', 'HEAD']).trim();
  const branch = process.env.GITHUB_REF_NAME ||
    git(options.root, ['branch', '--show-current']).trim() ||
    null;
  const publication = {
    schemaVersion: 1,
    contract: CONTRACT,
    baseSha,
    sourceBranch: branch,
    releaseManifestPath: normalizePath(path.relative(options.root, options.releaseManifest)),
    changedFiles: descriptors,
    noChanges: descriptors.length === 0,
    fingerprint: packageFingerprint(baseSha, descriptors),
  };
  writeJson(path.join(options.packageDir, 'publication.json'), publication);

  const changedPaths = descriptors.map((entry) => entry.path);
  const diff = changedPaths.length
    ? git(options.root, ['diff', '--no-ext-diff', '--binary', '--', ...changedPaths])
    : '';
  fs.writeFileSync(path.join(options.packageDir, 'publication.diff'), diff);
  process.stdout.write(
    `[accident-publication-package] PREPARED ${descriptors.length} allowlisted file(s), ` +
      `fingerprint ${publication.fingerprint}.\n`
  );
  return publication;
}

function verifyPayload(packageDir, publication) {
  for (const descriptor of publication.changedFiles) {
    if (descriptor.deleted) continue;
    const file = path.join(packageDir, 'payload', ...descriptor.path.split('/'));
    if (!fs.existsSync(file)) fail('payload_file_missing', `Package payload lacks ${descriptor.path}`);
    const bytes = fs.readFileSync(file);
    if (bytes.length !== descriptor.bytes || sha256(bytes) !== descriptor.sha256) {
      fail('payload_file_changed', `Package payload changed after preparation: ${descriptor.path}`);
    }
  }
}

function verify(options) {
  const publicationFile = path.join(options.packageDir, 'publication.json');
  const publication = readJson(publicationFile, 'publication package manifest');
  if (publication.contract !== CONTRACT) {
    fail('invalid_package_contract', 'Unsupported publication package contract', {
      actual: publication.contract,
    });
  }
  if (publication.fingerprint !== packageFingerprint(publication.baseSha, publication.changedFiles)) {
    fail('invalid_package_fingerprint', 'Publication package fingerprint is invalid');
  }
  const currentBase = git(options.root, ['rev-parse', 'HEAD']).trim();
  if (currentBase !== publication.baseSha) {
    fail('base_commit_changed', 'Repository HEAD changed between package preparation and QA', {
      prepared: publication.baseSha,
      current: currentBase,
    });
  }
  verifyPayload(options.packageDir, publication);

  const currentEntries = worktreeEntries(options.root)
    .filter((entry) => !isEphemeral(entry.path))
    .map((entry) => fileDescriptor(options.root, entry.path, entry.status))
    .sort((left, right) => left.path.localeCompare(right.path));
  const expected = publication.changedFiles;
  if (JSON.stringify(currentEntries) !== JSON.stringify(expected)) {
    fail('post_gate_mutation', 'Product worktree changed after the publication package was prepared', {
      prepared: expected,
      current: currentEntries,
    });
  }
  process.stdout.write(
    `[accident-publication-package] VERIFIED unchanged payload ${publication.fingerprint}.\n`
  );
  return publication;
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/accident-publication-package.js prepare|verify ' +
      '[--release-manifest file] [--package-dir directory]\n'
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  try {
    if (args.command === 'prepare') prepare(args);
    else verify(args);
    return 0;
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    if (error && error.details) process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = Object.freeze({
  CONTRACT,
  DEFAULT_PACKAGE_DIR,
  EPHEMERAL_PREFIXES,
  PublicationPackageError,
  parseArgs,
  normalizePath,
  parsePorcelainZ,
  worktreeEntries,
  allowedPaths,
  isEphemeral,
  fileDescriptor,
  packageFingerprint,
  prepare,
  verify,
  main,
});
