'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CANONICAL_DIRECTORY = path.join(ROOT, 'docs', 'screenshots');
const DEFAULT_CANDIDATE_DIRECTORY = path.join(ROOT, 'out', 'qa', 'candidate-screenshots');
const GENERATED_MEDIA_EXTENSION = /\.(?:apng|gif|jpe?g|png|webp)$/i;

function assertDirectory(directory, label) {
  if (!fs.existsSync(directory)) {
    throw new Error(`${label} does not exist: ${directory}`);
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a link: ${directory}`);
  }
}

function assertDisjointDirectories(first, second) {
  const relativeFirstToSecond = path.relative(first, second);
  const relativeSecondToFirst = path.relative(second, first);
  const nested = (relative) => relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  if (nested(relativeFirstToSecond) || nested(relativeSecondToFirst)) {
    throw new Error(`Canonical and candidate screenshot directories must be disjoint: ${first} / ${second}`);
  }
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function snapshotDirectory(directory) {
  assertDirectory(directory, 'Screenshot directory');
  const entries = [];

  function visit(current, relativeDirectory = '') {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const absolute = path.join(current, child.name);
      const relative = path.join(relativeDirectory, child.name).split(path.sep).join('/');
      if (child.isSymbolicLink()) {
        throw new Error(`Screenshot directory must not contain symbolic links: ${absolute}`);
      }
      if (child.isDirectory()) {
        visit(absolute, relative);
      } else if (child.isFile()) {
        const stat = fs.statSync(absolute);
        entries.push({
          path: relative,
          size: stat.size,
          mode: stat.mode & 0o777,
          sha256: sha256(absolute),
        });
      } else {
        throw new Error(`Unsupported screenshot directory entry: ${absolute}`);
      }
    }
  }

  visit(directory);
  return JSON.stringify(entries);
}

function copySupportFiles(source, target) {
  fs.mkdirSync(target, { recursive: true });
  const children = fs.readdirSync(source, { withFileTypes: true });
  for (const child of children) {
    const sourcePath = path.join(source, child.name);
    const targetPath = path.join(target, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(`Canonical screenshot support tree must not contain links: ${sourcePath}`);
    }
    if (child.isDirectory()) {
      copySupportFiles(sourcePath, targetPath);
    } else if (child.isFile() && !GENERATED_MEDIA_EXTENSION.test(child.name)) {
      fs.copyFileSync(sourcePath, targetPath);
      fs.chmodSync(targetPath, fs.statSync(sourcePath).mode & 0o777);
    }
  }
}

function prepareCandidateDirectory(canonicalDirectory, candidateDirectory) {
  fs.rmSync(candidateDirectory, { recursive: true, force: true });
  copySupportFiles(canonicalDirectory, candidateDirectory);
}

function listGeneratedMedia(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];

  function visit(current) {
    for (const child of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, child.name);
      if (child.isDirectory()) visit(absolute);
      else if (child.isFile() && GENERATED_MEDIA_EXTENSION.test(child.name)) files.push(absolute);
    }
  }

  visit(directory);
  return files.sort();
}

function withCandidateScreenshotWorkspace(callback, options = {}) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function');

  const canonicalDirectory = path.resolve(
    options.canonicalDirectory || DEFAULT_CANONICAL_DIRECTORY
  );
  const candidateDirectory = path.resolve(
    options.candidateDirectory || DEFAULT_CANDIDATE_DIRECTORY
  );
  const backupDirectory = path.resolve(
    options.backupDirectory || path.join(
      path.dirname(candidateDirectory),
      `.canonical-screenshots-backup-${process.pid}-${Date.now()}`
    )
  );

  assertDisjointDirectories(canonicalDirectory, candidateDirectory);
  assertDirectory(canonicalDirectory, 'Canonical screenshot directory');
  if (options.prepareCandidate === false) {
    assertDirectory(candidateDirectory, 'Candidate screenshot directory');
  } else {
    prepareCandidateDirectory(canonicalDirectory, candidateDirectory);
  }
  if (fs.existsSync(backupDirectory)) {
    throw new Error(`Refusing to overwrite screenshot backup: ${backupDirectory}`);
  }

  const canonicalSnapshot = snapshotDirectory(canonicalDirectory);
  fs.mkdirSync(path.dirname(backupDirectory), { recursive: true });
  fs.renameSync(canonicalDirectory, backupDirectory);

  let linked = false;
  let callbackResult;
  let callbackError;
  try {
    fs.symlinkSync(
      candidateDirectory,
      canonicalDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    linked = true;
    callbackResult = callback({ canonicalDirectory, candidateDirectory });
    if (callbackResult && typeof callbackResult.then === 'function') {
      throw new TypeError('Candidate screenshot callback must be synchronous');
    }
  } catch (error) {
    callbackError = error;
  }

  let restoreError;
  try {
    if (linked) {
      const redirected = lstatOrNull(canonicalDirectory);
      if (redirected && !redirected.isSymbolicLink()) {
        throw new Error(
          `Refusing unsafe restoration because redirected path is no longer a link: ${canonicalDirectory}`
        );
      }
      if (redirected) fs.unlinkSync(canonicalDirectory);
    }
    const unexpectedCanonical = lstatOrNull(canonicalDirectory);
    if (unexpectedCanonical) {
      throw new Error(`Canonical screenshot path unexpectedly exists during restoration: ${canonicalDirectory}`);
    }
    fs.renameSync(backupDirectory, canonicalDirectory);
    const restoredSnapshot = snapshotDirectory(canonicalDirectory);
    if (restoredSnapshot !== canonicalSnapshot) {
      throw new Error('Canonical screenshot directory changed while candidate screenshots were generated');
    }
  } catch (error) {
    restoreError = error;
  }

  if (callbackError && restoreError) {
    throw new AggregateError(
      [callbackError, restoreError],
      'Candidate screenshot command failed and canonical screenshots could not be restored'
    );
  }
  if (restoreError) throw restoreError;
  if (callbackError) throw callbackError;
  return callbackResult;
}

module.exports = {
  DEFAULT_CANDIDATE_DIRECTORY,
  DEFAULT_CANONICAL_DIRECTORY,
  listGeneratedMedia,
  prepareCandidateDirectory,
  snapshotDirectory,
  withCandidateScreenshotWorkspace,
};
