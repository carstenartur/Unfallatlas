'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY = path.join(ROOT, 'config', 'context-data-git-budget.json');
const DEFAULT_JSON_REPORT = path.join(ROOT, 'out', 'qa', 'context-data-git-delta.json');
const DEFAULT_TEXT_REPORT = path.join(ROOT, 'out', 'qa', 'context-data-git-delta.txt');
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const LIMIT_KEYS = Object.freeze([
  'maxChangedFiles',
  'maxAddedFiles',
  'maxDeletedFiles',
  'maxSingleFileBytes',
  'maxRewrittenBytes',
  'maxPositiveGrowthBytes',
  'maxNetGrowthBytes',
]);

class ContextDataGitDeltaError extends Error {
  constructor(message, report) {
    super(message);
    this.name = 'ContextDataGitDeltaError';
    this.report = report;
    this.contextDataGitDelta = report;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function repositoryPath(value, label) {
  const normalized = String(value || '').replace(/\\/g, '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`${label} must be a non-empty repository-relative path`);
  }
  const parts = normalized.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    throw new Error(`${label} contains an unsafe path segment: ${normalized}`);
  }
  return normalized;
}

function loadPolicy(root = ROOT, policyPath = DEFAULT_POLICY) {
  const absolute = path.resolve(root, path.relative(ROOT, policyPath));
  const source = fs.readFileSync(absolute, 'utf8');
  const policy = JSON.parse(source);
  if (policy.schemaVersion !== 1 ||
      policy.contract !== 'unfallwerkbank-context-data-git-budget/v1') {
    throw new Error('Unsupported context-data Git budget policy');
  }
  if (!Array.isArray(policy.allowedPathPrefixes) ||
      !Array.isArray(policy.allowedExactPaths) ||
      !policy.limits || typeof policy.limits !== 'object') {
    throw new Error('Context-data Git budget policy is incomplete');
  }
  const allowedPathPrefixes = policy.allowedPathPrefixes.map((entry, index) => {
    const raw = String(entry || '').replace(/\\/g, '/');
    if (!raw.endsWith('/')) {
      throw new Error(`allowedPathPrefixes[${index}] must end with /`);
    }
    return `${repositoryPath(raw.slice(0, -1), `allowedPathPrefixes[${index}]`)}/`;
  });
  const allowedExactPaths = policy.allowedExactPaths.map((entry, index) =>
    repositoryPath(entry, `allowedExactPaths[${index}]`));
  const limits = {};
  for (const key of LIMIT_KEYS) {
    const value = Number(policy.limits[key]);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Policy limit ${key} must be a non-negative safe integer`);
    }
    limits[key] = value;
  }
  if (allowedPathPrefixes.length === 0 && allowedExactPaths.length === 0) {
    throw new Error('Context-data Git budget policy has no allowed paths');
  }
  return Object.freeze({
    ...policy,
    allowedPathPrefixes: Object.freeze(allowedPathPrefixes),
    allowedExactPaths: Object.freeze(allowedExactPaths),
    limits: Object.freeze(limits),
    absolutePath: absolute,
    repositoryPath: path.relative(root, absolute).split(path.sep).join('/'),
    sha256: sha256(source),
  });
}

function runGit(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`git ${args.join(' ')} failed with status ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

function splitNul(value) {
  return String(value || '').split('\0').filter(Boolean);
}

function objectSize(root, revisionPath) {
  const result = runGit(root, ['cat-file', '-s', revisionPath], { allowFailure: true });
  if (result.status !== 0) return null;
  const value = Number(String(result.stdout || '').trim());
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Git returned an invalid object size for ${revisionPath}`);
  }
  return value;
}

function indexMode(root, repositoryFile) {
  const result = runGit(root, ['ls-files', '-s', '-z', '--', repositoryFile]);
  const records = splitNul(result.stdout);
  if (records.length !== 1) {
    throw new Error(`Expected exactly one staged index entry for ${repositoryFile}`);
  }
  const match = /^(\d{6}) [0-9a-f]+ \d\t/.exec(records[0]);
  if (!match) throw new Error(`Could not parse staged index mode for ${repositoryFile}`);
  return match[1];
}

function isAllowedPath(repositoryFile, policy) {
  return policy.allowedExactPaths.includes(repositoryFile) ||
    policy.allowedPathPrefixes.some(prefix => repositoryFile.startsWith(prefix));
}

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

function ensureReportIsDiagnosticOnly(root, reportFile) {
  const relative = path.relative(root, reportFile).split(path.sep).join('/');
  if (relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`Context-data Git delta report escapes the repository: ${reportFile}`);
  }
  const tracked = runGit(root, ['ls-files', '--error-unmatch', '--', relative], {
    allowFailure: true,
  });
  if (tracked.status === 0) {
    throw new Error(`Context-data Git delta report must not be tracked: ${relative}`);
  }
  const ignored = runGit(root, ['check-ignore', '-q', '--', relative], { allowFailure: true });
  if (ignored.status !== 0) {
    throw new Error(`Context-data Git delta report must be ignored: ${relative}`);
  }
  return relative;
}

function formatTextReport(report) {
  const lines = [
    'Context data Git delta review',
    `valid=${report.valid}`,
    `head=${report.head || ''}`,
    `policy_path=${report.policy.path}`,
    `policy_sha256=${report.policy.sha256}`,
    `changed_files=${report.totals.changedFiles}`,
    `added_files=${report.totals.addedFiles}`,
    `deleted_files=${report.totals.deletedFiles}`,
    `rewritten_bytes=${report.totals.rewrittenBytes}`,
    `positive_growth_bytes=${report.totals.positiveGrowthBytes}`,
    `net_growth_bytes=${report.totals.netGrowthBytes}`,
    `largest_file_bytes=${report.largest.bytes}`,
    `largest_file_path=${JSON.stringify(report.largest.path)}`,
  ];
  for (const key of LIMIT_KEYS) lines.push(`${key}=${report.policy.limits[key]}`);
  lines.push('', 'status\tallowed\tmode\told_bytes\tcurrent_bytes\tdelta_bytes\tpath_json');
  for (const row of report.files) {
    lines.push([
      row.status,
      row.allowed,
      row.mode || '',
      row.oldBytes,
      row.currentBytes,
      row.deltaBytes,
      JSON.stringify(row.path),
    ].join('\t'));
  }
  if (report.diffCheck) {
    lines.push('', 'GIT DIFF CHECK', report.diffCheck.trimEnd());
  }
  if (report.errors.length > 0) {
    lines.push('', 'BLOCKERS', ...report.errors);
  }
  return `${lines.join('\n')}\n`;
}

function writeReports(report, jsonReport, textReport) {
  const text = formatTextReport(report);
  atomicWrite(jsonReport, `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(textReport, text);
  return text;
}

function createBaseReport(policy, head) {
  return {
    schemaVersion: 1,
    contract: 'unfallwerkbank-context-data-git-delta/v1',
    generatedAt: new Date().toISOString(),
    valid: false,
    head,
    policy: {
      path: policy.repositoryPath,
      sha256: policy.sha256,
      limits: policy.limits,
      allowedPathPrefixes: policy.allowedPathPrefixes,
      allowedExactPaths: policy.allowedExactPaths,
    },
    totals: {
      changedFiles: 0,
      addedFiles: 0,
      deletedFiles: 0,
      rewrittenBytes: 0,
      positiveGrowthBytes: 0,
      netGrowthBytes: 0,
    },
    largest: { path: null, bytes: 0 },
    files: [],
    diffCheck: '',
    errors: [],
  };
}

function evaluateContextDataGitDelta(options = {}) {
  const root = path.resolve(options.root || ROOT);
  const policy = options.policy || loadPolicy(root, options.policyPath || DEFAULT_POLICY);
  const jsonReport = path.resolve(options.jsonReport || path.join(root, 'out', 'qa', 'context-data-git-delta.json'));
  const textReport = path.resolve(options.textReport || path.join(root, 'out', 'qa', 'context-data-git-delta.txt'));
  ensureReportIsDiagnosticOnly(root, jsonReport);
  ensureReportIsDiagnosticOnly(root, textReport);

  const stageTargets = [
    ...policy.allowedPathPrefixes.map(prefix => prefix.slice(0, -1)),
    ...policy.allowedExactPaths,
  ];
  runGit(root, ['add', '-A', '--', ...new Set(stageTargets)]);
  const head = String(runGit(root, ['rev-parse', 'HEAD']).stdout || '').trim();
  const report = createBaseReport(policy, head);

  const quiet = runGit(root, ['diff', '--cached', '--quiet'], { allowFailure: true });
  if (quiet.status === 0) {
    report.valid = true;
    return { report, jsonReport, textReport };
  }
  if (quiet.status !== 1) {
    throw new Error(`git diff --cached --quiet failed with status ${quiet.status}`);
  }

  const changedPaths = splitNul(runGit(root, [
    'diff', '--cached', '--no-renames', '--name-only', '-z',
  ]).stdout);
  const addedPaths = new Set(splitNul(runGit(root, [
    'diff', '--cached', '--no-renames', '--diff-filter=A', '--name-only', '-z',
  ]).stdout));
  const deletedPaths = new Set(splitNul(runGit(root, [
    'diff', '--cached', '--no-renames', '--diff-filter=D', '--name-only', '-z',
  ]).stdout));
  const diffCheck = runGit(root, ['diff', '--cached', '--check'], { allowFailure: true });
  report.diffCheck = String(diffCheck.stdout || '') + String(diffCheck.stderr || '');
  if (diffCheck.status !== 0) {
    report.errors.push(`git diff --cached --check failed with status ${diffCheck.status}`);
  }

  for (const repositoryFile of changedPaths) {
    const allowed = isAllowedPath(repositoryFile, policy);
    if (!allowed) report.errors.push(`unexpected staged path: ${JSON.stringify(repositoryFile)}`);
    if (/[\r\n\t]/.test(repositoryFile)) {
      report.errors.push(`staged path contains report-breaking control characters: ${JSON.stringify(repositoryFile)}`);
    }

    const oldBytes = objectSize(root, `HEAD:${repositoryFile}`) || 0;
    const stagedBytes = objectSize(root, `:${repositoryFile}`);
    const currentBytes = stagedBytes == null ? 0 : stagedBytes;
    const mode = stagedBytes == null ? null : indexMode(root, repositoryFile);
    if (mode != null && mode !== '100644') {
      report.errors.push(`unsupported staged file mode ${mode}: ${JSON.stringify(repositoryFile)}`);
    }
    const status = deletedPaths.has(repositoryFile)
      ? 'deleted'
      : addedPaths.has(repositoryFile) ? 'added' : 'modified';
    const deltaBytes = currentBytes - oldBytes;
    const row = {
      path: repositoryFile,
      status,
      allowed,
      mode,
      oldBytes,
      currentBytes,
      deltaBytes,
    };
    report.files.push(row);
    if (stagedBytes != null) report.totals.rewrittenBytes += currentBytes;
    if (deltaBytes > 0) report.totals.positiveGrowthBytes += deltaBytes;
    report.totals.netGrowthBytes += deltaBytes;
    if (currentBytes > report.largest.bytes) {
      report.largest = { path: repositoryFile, bytes: currentBytes };
    }
    if (currentBytes > policy.limits.maxSingleFileBytes) {
      report.errors.push(
        `single file exceeds ${policy.limits.maxSingleFileBytes} bytes: ` +
        `${JSON.stringify(repositoryFile)} (${currentBytes} bytes)`,
      );
    }
  }

  report.totals.changedFiles = changedPaths.length;
  report.totals.addedFiles = addedPaths.size;
  report.totals.deletedFiles = deletedPaths.size;
  const checks = [
    ['changed file count', report.totals.changedFiles, policy.limits.maxChangedFiles],
    ['added file count', report.totals.addedFiles, policy.limits.maxAddedFiles],
    ['deleted file count', report.totals.deletedFiles, policy.limits.maxDeletedFiles],
    ['rewritten bytes', report.totals.rewrittenBytes, policy.limits.maxRewrittenBytes],
    ['positive growth', report.totals.positiveGrowthBytes, policy.limits.maxPositiveGrowthBytes],
    ['net growth', report.totals.netGrowthBytes, policy.limits.maxNetGrowthBytes],
  ];
  for (const [label, actual, maximum] of checks) {
    if (actual > maximum) report.errors.push(`${label} ${actual} exceeds ${maximum}`);
  }
  report.valid = report.errors.length === 0;
  return { report, jsonReport, textReport };
}

function reviewContextDataGitDelta(options = {}) {
  const root = path.resolve(options.root || ROOT);
  let result;
  try {
    result = evaluateContextDataGitDelta({ ...options, root });
  } catch (error) {
    const policy = options.policy || loadPolicy(root, options.policyPath || DEFAULT_POLICY);
    const jsonReport = path.resolve(options.jsonReport || path.join(root, 'out', 'qa', 'context-data-git-delta.json'));
    const textReport = path.resolve(options.textReport || path.join(root, 'out', 'qa', 'context-data-git-delta.txt'));
    const headResult = runGit(root, ['rev-parse', 'HEAD'], { allowFailure: true });
    const report = createBaseReport(policy, String(headResult.stdout || '').trim() || null);
    report.errors.push(`internal delta-review failure: ${error.message}`);
    const text = writeReports(report, jsonReport, textReport);
    if (options.print !== false) process.stdout.write(text);
    error.contextDataGitDelta = report;
    throw error;
  }

  const text = writeReports(result.report, result.jsonReport, result.textReport);
  if (options.print !== false) process.stdout.write(text);
  if (!result.report.valid) {
    throw new ContextDataGitDeltaError(
      'Context data delta exceeds the automatic-commit budget; use a reviewed pull request.',
      result.report,
    );
  }
  return result.report;
}

if (require.main === module) {
  try {
    reviewContextDataGitDelta();
  } catch (error) {
    console.error('[context-data-git-delta] FAILED:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({
  ROOT,
  DEFAULT_POLICY,
  DEFAULT_JSON_REPORT,
  DEFAULT_TEXT_REPORT,
  LIMIT_KEYS,
  ContextDataGitDeltaError,
  repositoryPath,
  loadPolicy,
  runGit,
  splitNul,
  objectSize,
  indexMode,
  isAllowedPath,
  ensureReportIsDiagnosticOnly,
  formatTextReport,
  evaluateContextDataGitDelta,
  reviewContextDataGitDelta,
});
