#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT_DIRECTORY = 'docs/screenshots';
const EVIDENCE_DIRECTORY = 'out/qa/screenshot-readiness';
const BUILD_MANIFEST = '_site/build-manifest.json';
const MEDIA_MANIFEST = 'docs/media-manifest.json';

function parseArgs(argv) {
  const args = { report: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--report') args.report = argv[++index] || null;
    else throw new Error(`[validate-screenshot-evidence] Unknown argument: ${argv[index]}`);
  }
  return args;
}

function relativeInside(repoRoot, target, label) {
  const nativeRelative = path.relative(repoRoot, target);
  const relative = nativeRelative.replace(/\\/g, '/');
  if (!relative || nativeRelative === '..' || nativeRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(nativeRelative)) {
    throw new Error(`${label} escapes repository root`);
  }
  return relative;
}

function resolveInside(repoRoot, relative, label) {
  const absoluteRoot = path.resolve(repoRoot);
  const absolute = path.resolve(absoluteRoot, relative);
  relativeInside(absoluteRoot, absolute, label);

  let realRoot;
  try {
    if (!fs.statSync(absoluteRoot).isDirectory()) throw new Error('not a directory');
    realRoot = fs.realpathSync(absoluteRoot);
  } catch (error) {
    throw new Error(`repository root cannot be resolved: ${error.message}`);
  }

  // Walk one path component at a time with lstat. This detects a symlink before
  // probing a child through it, so a malicious symlink parent cannot turn the
  // validator into an external filesystem oracle (or redirect a QA report).
  let current = absoluteRoot;
  const components = path.relative(absoluteRoot, absolute).split(path.sep).filter(Boolean);
  for (const component of components) {
    current = path.join(current, component);
    let stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') break;
      throw new Error(`${label} cannot be inspected safely: ${error.message}`);
    }
    if (stats.isSymbolicLink()) throw new Error(`${label} must not contain symbolic links`);
    const realCurrent = fs.realpathSync(current);
    const realRelative = path.relative(realRoot, realCurrent);
    if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
      throw new Error(`${label} real path escapes repository root`);
    }
  }
  return absolute;
}

function readRegularFile(repoRoot, file, label) {
  const safeFile = resolveInside(repoRoot, file, label);
  let stats;
  try {
    stats = fs.lstatSync(safeFile);
  } catch (error) {
    throw new Error(`${label} is missing or cannot be inspected: ${error.message}`);
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`${label} is not a regular file`);
  return fs.readFileSync(safeFile);
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} cannot be read as JSON: ${error.message}`);
  }
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function listFlatFiles(directory, suffix, label, options = {}) {
  let directoryStats;
  try { directoryStats = fs.lstatSync(directory); }
  catch (_) { directoryStats = null; }
  if (!directoryStats || directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw new Error(`${label} is missing or not a directory`);
  }
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error(`${label} contains a non-regular entry: ${entry.name}`);
    if (entry.name.endsWith(suffix)) result.push(entry.name);
    else if (options.rejectOtherFiles === true) throw new Error(`${label} contains an unexpected file: ${entry.name}`);
  }
  return result.sort((a, b) => a.localeCompare(b));
}

function validateLifecycle(evidence, screenshotPath, errors) {
  const lifecycle = evidence && evidence.lifecycle;
  const criteria = evidence && evidence.criteria;
  if (!lifecycle || lifecycle.status !== 'ready') {
    errors.push(`${screenshotPath}: lifecycle status is not ready`);
    return;
  }
  if (!criteria || typeof criteria.city !== 'string' || !criteria.city || lifecycle.city !== criteria.city) {
    errors.push(`${screenshotPath}: lifecycle city does not match the evidence criteria`);
  }
  if (criteria && criteria.requireCompleteCoverage !== true) {
    errors.push(`${screenshotPath}: complete city-data coverage was not required`);
  }
  if (!criteria || !['fixture', 'live'].includes(criteria.mapSourceMode)) {
    errors.push(`${screenshotPath}: map source mode is not declared as fixture or live`);
  }
  if (!lifecycle.counts || !['loaded', 'filtered', 'viewport'].every(key => Number(lifecycle.counts[key]) > 0)) {
    errors.push(`${screenshotPath}: lifecycle does not prove non-empty accident data`);
  }
  if (!lifecycle.coverage || lifecycle.coverage.complete !== true) {
    errors.push(`${screenshotPath}: lifecycle does not prove complete city-data coverage`);
  }
  const render = lifecycle.render;
  if (!render || render.submitted !== true || !Number.isFinite(render.revision) || render.completedRevision !== render.revision) {
    errors.push(`${screenshotPath}: lifecycle does not prove a completed render revision`);
  }
  const layers = criteria && Array.isArray(criteria.layers) ? criteria.layers : null;
  if (!layers || layers.length === 0 || layers.some(layer => typeof layer !== 'string' || !layer)) {
    errors.push(`${screenshotPath}: evidence does not request a render layer`);
    return;
  }
  for (const layerName of layers) {
    const layer = render && render.layers && render.layers[layerName];
    if (!layer || layer.requested !== true || layer.complete !== true || !(Number(layer.visible) > 0) ||
        (layerName === 'heatmap' && layer.painted !== true)) {
      errors.push(`${screenshotPath}: lifecycle does not prove a visible completed ${layerName} layer`);
    }
  }
}

function validate(options = {}) {
  const repoRoot = path.resolve(options.root || ROOT);
  const errors = [];
  const rows = [];
  let build = null;

  try {
    const screenshotDirectory = resolveInside(repoRoot, SCREENSHOT_DIRECTORY, 'screenshot directory');
    const evidenceDirectory = resolveInside(repoRoot, EVIDENCE_DIRECTORY, 'evidence directory');
    const buildManifestPath = resolveInside(repoRoot, BUILD_MANIFEST, 'build manifest');
    const mediaManifestPath = resolveInside(repoRoot, MEDIA_MANIFEST, 'media manifest');
    const mediaManifest = parseJson(
      readRegularFile(repoRoot, mediaManifestPath, 'media manifest'),
      'media manifest'
    );
    const expectedScreenshots = (Array.isArray(mediaManifest.assets) ? mediaManifest.assets : [])
      .map(asset => asset && asset.path)
      .filter(assetPath => typeof assetPath === 'string' &&
        path.posix.dirname(assetPath.replace(/\\/g, '/')) === SCREENSHOT_DIRECTORY &&
        path.posix.extname(assetPath).toLowerCase() === '.png')
      .sort((a, b) => a.localeCompare(b));
    if (expectedScreenshots.length === 0 || new Set(expectedScreenshots).size !== expectedScreenshots.length) {
      throw new Error('media manifest contains no unique canonical PNG screenshot set');
    }

    const screenshotNames = listFlatFiles(screenshotDirectory, '.png', 'screenshot directory');
    const evidenceNames = listFlatFiles(evidenceDirectory, '.json', 'evidence directory', { rejectOtherFiles: true });
    const actualScreenshots = screenshotNames.map(name => `${SCREENSHOT_DIRECTORY}/${name}`);
    const expectedEvidence = screenshotNames.map(name => `${path.basename(name, '.png')}.json`).sort((a, b) => a.localeCompare(b));
    for (const expected of expectedScreenshots) {
      if (!actualScreenshots.includes(expected)) errors.push(`${expected}: canonical screenshot is missing`);
    }
    for (const actual of actualScreenshots) {
      if (!expectedScreenshots.includes(actual)) errors.push(`${actual}: generated screenshot is not declared in the media manifest`);
    }
    for (const expected of expectedEvidence) {
      if (!evidenceNames.includes(expected)) errors.push(`${EVIDENCE_DIRECTORY}/${expected}: evidence sidecar is missing`);
    }
    for (const actual of evidenceNames) {
      if (!expectedEvidence.includes(actual)) errors.push(`${EVIDENCE_DIRECTORY}/${actual}: evidence has no matching screenshot`);
    }

    const buildBytes = readRegularFile(repoRoot, buildManifestPath, 'canonical build manifest');
    const buildManifest = parseJson(buildBytes, 'build manifest');
    const buildSha256 = sha256Bytes(buildBytes);
    const fingerprint = buildManifest && buildManifest.fingerprint;
    const applicationFingerprint = buildManifest && buildManifest.application && buildManifest.application.fingerprint;
    const dataFingerprint = buildManifest && buildManifest.data && buildManifest.data.fingerprint;
    if (![fingerprint, applicationFingerprint, dataFingerprint].every(isSha256)) {
      throw new Error('canonical build manifest lacks valid build/application/data fingerprints');
    }
    build = { path: BUILD_MANIFEST, sha256: buildSha256, fingerprint, applicationFingerprint, dataFingerprint };

    for (const screenshotPath of actualScreenshots) {
      const screenshotName = path.posix.basename(screenshotPath);
      const screenshotFile = path.join(screenshotDirectory, screenshotName);
      const sidecarName = `${path.posix.basename(screenshotName, '.png')}.json`;
      const sidecarFile = path.join(evidenceDirectory, sidecarName);
      const rowErrors = [];
      const screenshotBytes = readRegularFile(repoRoot, screenshotFile, `${screenshotPath}: screenshot`);
      const screenshotSha256 = sha256Bytes(screenshotBytes);
      let evidence = null;
      let evidenceObject = false;
      if (evidenceNames.includes(sidecarName)) {
        try {
          evidence = parseJson(
            readRegularFile(repoRoot, sidecarFile, `${screenshotPath} evidence`),
            `${screenshotPath} evidence`
          );
          evidenceObject = evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence);
          if (!evidenceObject) rowErrors.push(`${screenshotPath}: evidence must be a non-array JSON object`);
        } catch (error) { rowErrors.push(error.message); }
      }
      if (evidenceObject) {
        if (evidence.schemaVersion !== 1) rowErrors.push(`${screenshotPath}: unsupported evidence schema`);
        if (!evidence.screenshot || evidence.screenshot.path !== screenshotPath) {
          rowErrors.push(`${screenshotPath}: evidence screenshot path does not match`);
        }
        if (!evidence.screenshot || evidence.screenshot.bytes !== screenshotBytes.length) {
          rowErrors.push(`${screenshotPath}: evidence screenshot byte count does not match`);
        }
        if (!evidence.screenshot || evidence.screenshot.sha256 !== screenshotSha256) {
          rowErrors.push(`${screenshotPath}: evidence screenshot SHA-256 does not match`);
        }
        if (!evidence.build || evidence.build.path !== BUILD_MANIFEST || evidence.build.sha256 !== buildSha256 ||
            evidence.build.fingerprint !== fingerprint || evidence.build.applicationFingerprint !== applicationFingerprint ||
            evidence.build.dataFingerprint !== dataFingerprint) {
          rowErrors.push(`${screenshotPath}: evidence build manifest SHA-256/fingerprints do not match`);
        }
        if (process.env.GITHUB_SHA && evidence.revision !== process.env.GITHUB_SHA) {
          rowErrors.push(`${screenshotPath}: evidence revision does not match GITHUB_SHA`);
        }
        validateLifecycle(evidence, screenshotPath, rowErrors);
      }
      errors.push(...rowErrors);
      rows.push({
        path: screenshotPath,
        bytes: screenshotBytes.length,
        sha256: screenshotSha256,
        evidence: `${EVIDENCE_DIRECTORY}/${sidecarName}`,
        status: evidenceObject && rowErrors.length === 0 ? 'valid' : 'error',
        errors: rowErrors,
      });
    }
  } catch (error) {
    errors.push(String(error && error.message ? error.message : error));
  }

  const validRows = rows.filter(row => row.status === 'valid').length;
  return {
    schemaVersion: 1,
    valid: errors.length === 0 && rows.length > 0 && validRows === rows.length,
    revision: process.env.GITHUB_SHA || null,
    build,
    screenshots: rows,
    totals: { screenshots: rows.length, evidence: validRows },
    errors,
  };
}

function writeReport(repoRoot, reportPath, report) {
  const absolute = resolveInside(repoRoot, reportPath, 'report path');
  const reportDirectory = path.dirname(absolute);
  fs.mkdirSync(reportDirectory, { recursive: true });
  // Re-check after mkdir so a symlink parent cannot redirect the write. The
  // temporary file is created exclusively and the destination is checked once
  // more immediately before the atomic rename.
  if (path.resolve(reportDirectory) !== path.resolve(repoRoot)) {
    resolveInside(repoRoot, reportDirectory, 'report directory');
  }
  const reportDirectoryStats = fs.lstatSync(reportDirectory);
  if (reportDirectoryStats.isSymbolicLink() || !reportDirectoryStats.isDirectory()) {
    throw new Error('report directory is not a regular directory');
  }
  const temporary = path.join(
    reportDirectory,
    `.${path.basename(absolute)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  try {
    resolveInside(repoRoot, temporary, 'temporary report path');
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    resolveInside(repoRoot, absolute, 'report path');
    fs.renameSync(temporary, absolute);
  } finally {
    try {
      resolveInside(repoRoot, temporary, 'temporary report path');
      const stats = fs.lstatSync(temporary);
      if (!stats.isSymbolicLink() && stats.isFile()) fs.unlinkSync(temporary);
    } catch (_) { /* no safe temporary file remains to remove */ }
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const report = validate({ root: ROOT });
  if (args.report) writeReport(ROOT, args.report, report);
  process.stdout.write(
    `[validate-screenshot-evidence] ${report.totals.evidence}/${report.totals.screenshots} screenshot sidecars valid\n`
  );
  if (!report.valid) {
    for (const error of report.errors) process.stderr.write(`ERROR\t${error}\n`);
    process.exitCode = 1;
  }
  return report;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, validate, writeReport };
