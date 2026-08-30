'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CANONICAL_DIRECTORY = path.join(ROOT, 'docs', 'screenshots');
const DEFAULT_CANDIDATE_DIRECTORY = path.join(ROOT, 'out', 'qa', 'candidate-screenshots');
const GENERATED_MEDIA_EXTENSION = /\.(?:apng|gif|jpe?g|png|webp)$/i;

function assertDirectory(directory, label) {
  const stat = lstatOrNull(directory);
  if (!stat) {
    throw new Error(`${label} does not exist: ${directory}`);
  }
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

function sortedDirectoryEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
}

function copySupportFiles(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const child of sortedDirectoryEntries(source)) {
    const sourcePath = path.join(source, child.name);
    const targetPath = path.join(target, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(`Canonical screenshot support tree must not contain links: ${sourcePath}`);
    }
    if (child.isDirectory()) {
      copySupportFiles(sourcePath, targetPath);
    } else if (child.isFile()) {
      if (!GENERATED_MEDIA_EXTENSION.test(child.name)) {
        fs.copyFileSync(sourcePath, targetPath);
        fs.chmodSync(targetPath, fs.statSync(sourcePath).mode & 0o777);
      }
    } else {
      throw new Error(`Unsupported canonical screenshot support entry: ${sourcePath}`);
    }
  }
}

function prepareCandidateDirectory(canonicalDirectory, candidateDirectory) {
  assertDirectory(canonicalDirectory, 'Canonical screenshot directory');
  const existingCandidate = lstatOrNull(candidateDirectory);
  if (existingCandidate && (existingCandidate.isSymbolicLink() || !existingCandidate.isDirectory())) {
    throw new Error(
      `Candidate screenshot path must be missing or a real directory: ${candidateDirectory}`
    );
  }
  fs.rmSync(candidateDirectory, { recursive: true, force: true });
  copySupportFiles(canonicalDirectory, candidateDirectory);
}

function listGeneratedMedia(directory) {
  const directoryStats = lstatOrNull(directory);
  if (!directoryStats) return [];
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`Candidate screenshot directory must be a real directory: ${directory}`);
  }
  const files = [];

  function visit(current) {
    for (const child of sortedDirectoryEntries(current)) {
      const absolute = path.join(current, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`Candidate screenshot tree must not contain links: ${absolute}`);
      }
      if (child.isDirectory()) {
        visit(absolute);
      } else if (child.isFile()) {
        if (GENERATED_MEDIA_EXTENSION.test(child.name)) files.push(absolute);
      } else {
        throw new Error(`Unsupported candidate screenshot entry: ${absolute}`);
      }
    }
  }

  visit(directory);
  return files;
}

function recoveryPath(base, label) {
  return `${base}.${label}-${process.pid}-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
}

function preserveUnexpected(source, base, label) {
  const recovery = recoveryPath(base, label);
  fs.mkdirSync(path.dirname(recovery), { recursive: true });
  fs.renameSync(source, recovery);
  return recovery;
}

function aggregateRestoreErrors(errors) {
  if (errors.length === 0) return null;
  if (errors.length === 1) return errors[0];
  return new AggregateError(errors, 'Canonical screenshots could not be restored safely');
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
    options.backupDirectory || recoveryPath(canonicalDirectory, 'backup')
  );

  assertDisjointDirectories(canonicalDirectory, candidateDirectory);
  assertDirectory(canonicalDirectory, 'Canonical screenshot directory');
  if (options.prepareCandidate === false) {
    assertDirectory(candidateDirectory, 'Candidate screenshot directory');
  } else {
    prepareCandidateDirectory(canonicalDirectory, candidateDirectory);
  }
  if (lstatOrNull(backupDirectory)) {
    throw new Error(`Refusing to overwrite screenshot backup: ${backupDirectory}`);
  }

  const canonicalSnapshot = snapshotDirectory(canonicalDirectory);
  fs.mkdirSync(path.dirname(backupDirectory), { recursive: true });
  fs.renameSync(canonicalDirectory, backupDirectory);

  let candidateMounted = false;
  let callbackResult;
  let callbackError;
  try {
    fs.renameSync(candidateDirectory, canonicalDirectory);
    candidateMounted = true;
    callbackResult = callback({
      canonicalDirectory,
      candidateDirectory,
      mountedCandidateDirectory: canonicalDirectory,
    });
    if (callbackResult && typeof callbackResult.then === 'function') {
      throw new TypeError('Candidate screenshot callback must be synchronous');
    }
  } catch (error) {
    callbackError = error;
  }

  const restoreErrors = [];
  if (candidateMounted) {
    try {
      if (lstatOrNull(candidateDirectory)) {
        const recovery = preserveUnexpected(candidateDirectory, candidateDirectory, 'unexpected');
        restoreErrors.push(new Error(
          `Candidate screenshot path was recreated while mounted; preserved unexpected content at ${recovery}`
        ));
      }
    } catch (error) {
      restoreErrors.push(error);
    }

    try {
      const mountedCandidate = lstatOrNull(canonicalDirectory);
      if (!mountedCandidate) {
        restoreErrors.push(new Error(
          `Mounted candidate screenshot directory disappeared: ${canonicalDirectory}`
        ));
      } else if (mountedCandidate.isSymbolicLink() || !mountedCandidate.isDirectory()) {
        const recovery = preserveUnexpected(
          canonicalDirectory,
          candidateDirectory,
          'invalid-mounted'
        );
        restoreErrors.push(new Error(
          `Mounted candidate path was no longer a real directory; preserved it at ${recovery}`
        ));
      } else {
        // The child process may legitimately recreate or remove generated output
        // directories. Keep the reviewed backup outside that transient tree and
        // recreate only the candidate parent before moving generated media back.
        fs.mkdirSync(path.dirname(candidateDirectory), { recursive: true });
        fs.renameSync(canonicalDirectory, candidateDirectory);
      }
    } catch (error) {
      restoreErrors.push(error);
    }
  }

  try {
    if (lstatOrNull(canonicalDirectory)) {
      const recovery = preserveUnexpected(canonicalDirectory, canonicalDirectory, 'restore-blocker');
      restoreErrors.push(new Error(
        `Canonical screenshot path was occupied during restoration; preserved blocker at ${recovery}`
      ));
    }
    fs.renameSync(backupDirectory, canonicalDirectory);
  } catch (error) {
    restoreErrors.push(error);
  }

  try {
    const restoredSnapshot = snapshotDirectory(canonicalDirectory);
    if (restoredSnapshot !== canonicalSnapshot) {
      throw new Error('Canonical screenshot directory changed while candidate screenshots were generated');
    }
  } catch (error) {
    restoreErrors.push(error);
  }

  const restoreError = aggregateRestoreErrors(restoreErrors);
  if (callbackError && restoreError) {
    const error = new AggregateError(
      [callbackError, restoreError],
      'Candidate screenshot command failed and canonical screenshots could not be restored'
    );
    error.exitCode = callbackError.exitCode || 1;
    throw error;
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
