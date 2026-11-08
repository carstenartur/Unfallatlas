'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const POLICY_PATH = 'config/repository-storage-budget.json';
const LIMITS = ['maxSingleFileBytes', 'maxTrackedBytes', 'maxChangedFiles', 'maxAddedFiles',
  'maxDeletedFiles', 'maxRewrittenBytes', 'maxPositiveGrowthBytes', 'maxNetGrowthBytes',
  'maxEvidenceBytes', 'maxEvidenceFileBytes', 'maxPublishedDataBytes'];

function git(root, args, allowFailure = false, input) {
  const result = spawnSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error(`git ${args[0]} failed: ${String(result.stderr).trim()}`);
  return result;
}

function validatePolicy(policy) {
  if (!policy || policy.schemaVersion !== 1 || policy.contract !== 'unfallwerkbank-repository-storage/v1') {
    throw new Error('Unsupported repository storage policy');
  }
  for (const key of LIMITS) {
    if (!Number.isSafeInteger(policy.limits?.[key]) || policy.limits[key] < 0) throw new Error(`Invalid storage limit ${key}`);
  }
  for (const key of ['evidencePrefixes', 'diagnosticPrefixes', 'rawDataPrefixes']) {
    if (!Array.isArray(policy[key]) || policy[key].some(p => typeof p !== 'string' ||
        !/^(?!\/)(?!.*(?:^|\/)\.\.?\/)[^\\\0]+\/$/.test(p))) throw new Error(`Invalid storage prefixes ${key}`);
  }
  if (!policy.legacyReleaseAssets || typeof policy.legacyReleaseAssets !== 'object') throw new Error('Missing legacy release asset pins');
  for (const [name, hash] of Object.entries(policy.legacyReleaseAssets)) {
    if (!/^unfallatlas-website-[\w.-]+\.zip$/.test(name) || !/^[a-f0-9]{40}$/.test(hash)) throw new Error('Invalid legacy release asset pin');
  }
  return policy;
}

function loadPolicy(root, revision) {
  const raw = revision
    ? git(root, ['show', `${revision}:${POLICY_PATH}`]).stdout
    : fs.readFileSync(path.join(root, POLICY_PATH), 'utf8');
  return { ...validatePolicy(JSON.parse(raw)), sourceRevision: revision || null,
    sha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

function revision(root, value, label) {
  if (typeof value !== 'string' || !value.trim() || /^0+$/.test(value) || value.startsWith('-')) {
    throw new Error(`A valid explicit ${label} commit is required`);
  }
  const result = git(root, ['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`], true);
  if (result.status !== 0) throw new Error(`Cannot resolve ${label} commit ${value}; fetch the baseline before checking storage`);
  return result.stdout.trim();
}

function tree(root, ref) {
  const result = new Map();
  for (const row of git(root, ['ls-tree', '-rlz', ref]).stdout.split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\s+(\d+|-)\t([\s\S]+)$/.exec(row);
    if (!match) throw new Error('Cannot parse Git tree size metadata');
    result.set(match[5], { mode: match[1], type: match[2], oid: match[3], bytes: match[4] === '-' ? 0 : Number(match[4]) });
  }
  return result;
}

function requireCompleteRange(root, base, head) {
  const commits = git(root, ['rev-list', `${base}..${head}`]).stdout.trim().split('\n').filter(Boolean);
  const shallowPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'shallow']).stdout.trim());
  const shallow = fs.existsSync(shallowPath) ? new Set(fs.readFileSync(shallowPath, 'utf8').trim().split('\n')) : new Set();
  if (commits.some(commit => shallow.has(commit))) throw new Error('Incomplete storage history range; fetch all commits introduced since the baseline');
  return commits;
}

function prepareHistory(root, baseValue, headValue = 'HEAD') {
  if (typeof baseValue !== 'string' || !/^[a-f0-9]{40}$/.test(baseValue) || /^0+$/.test(baseValue)) {
    throw new Error('A nonzero full baseline SHA is required before fetching storage history');
  }
  const head = revision(root, headValue, 'head');
  if (git(root, ['cat-file', '-e', `${baseValue}^{commit}`], true).status !== 0) {
    git(root, ['fetch', '--no-tags', '--depth=1', 'origin', baseValue]);
  }
  const base = revision(root, baseValue, 'baseline');
  // Bound network work to the exact two reviewed commits. Never fetch all refs.
  for (let attempt = 0; attempt <= 5; attempt++) {
    try { requireCompleteRange(root, base, head); return { base, head }; }
    catch (error) {
      if (attempt === 5 || !/Incomplete storage history range/.test(error.message)) throw error;
      git(root, ['fetch', '--no-tags', '--deepen=100', 'origin', head, base]);
    }
  }
}

function newHistoryBlobs(root, base, head) {
  const commits = requireCompleteRange(root, base, head);
  const objects = git(root, ['rev-list', '--objects', '--missing=print', `${base}..${head}`]).stdout;
  if (objects.split('\n').some(row => row.startsWith('?'))) throw new Error('Missing storage history objects; fetch introduced blobs before checking');
  if (!objects.trim()) return { commits: commits.length, newBlobCount: 0, newBlobBytes: 0, blobs: [] };
  const metadata = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)'], false, objects).stdout;
  const blobs = [];
  for (const row of metadata.split('\n').filter(Boolean)) {
    const match = /^([a-f0-9]+) (\w+) (\d+)(?: ([\s\S]*))?$/.exec(row);
    if (!match) throw new Error('Invalid storage history object metadata');
    if (match[2] === 'blob') blobs.push({ blob: match[1], bytes: Number(match[3]), path: match[4] || '(no path)' });
  }
  return { commits: commits.length, newBlobCount: blobs.length, newBlobBytes: blobs.reduce((sum, item) => sum + item.bytes, 0), blobs };
}

function historyPathEntries(root, base, head) {
  // rev-list emits only one representative name per object. Raw NUL-delimited
  // diffs retain every alias, including paths removed by a later commit and
  // names containing tabs/newlines. Merge diffs cover each parent separately.
  const tokens = git(root, ['log', '--format=', '--raw', '-z', '--no-abbrev', '--no-renames',
    '--diff-merges=separate', `${base}..${head}`]).stdout.split('\0');
  const entries = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const header = tokens[i].trim();
    if (!header) continue;
    const match = /^:(\d+) (\d+) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMDTUX])$/.exec(header);
    if (!match || tokens[i + 1] === undefined) throw new Error('Invalid storage history path metadata');
    const name = tokens[++i];
    if (match[5] === 'D') continue;
    entries.set(`${match[4]}\0${match[2]}\0${name}`, { path: name, blob: match[4], mode: match[2] });
  }
  if (!entries.size) return [];
  const hashes = [...new Set([...entries.values()].map(item => item.blob))];
  const sizes = new Map();
  const metadata = git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], false, hashes.join('\n') + '\n').stdout;
  for (const row of metadata.trim().split('\n')) {
    const match = /^([a-f0-9]{40}) (\w+) (\d+)$/.exec(row);
    if (!match) throw new Error('Missing storage history path object');
    sizes.set(match[1], { type: match[2], bytes: Number(match[3]) });
  }
  return [...entries.values()].map(item => ({ ...item, ...sizes.get(item.blob) }));
}

function evaluateStorage(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const base = revision(root, options.base, 'baseline');
  const head = revision(root, options.head || 'HEAD', 'head');
  requireCompleteRange(root, base, head);
  if (git(root, ['merge-base', '--is-ancestor', base, head], true).status !== 0) {
    throw new Error('Storage baseline must be an ancestor of the checked head; unrelated histories cannot establish a delta');
  }
  const hasBaselinePolicy = git(root, ['cat-file', '-e', `${base}:${POLICY_PATH}`], true).status === 0;
  const policy = validatePolicy(options.policy || loadPolicy(root, hasBaselinePolicy ? base : head));
  const before = tree(root, base);
  const after = tree(root, head);
  const history = newHistoryBlobs(root, base, head);
  history.paths = historyPathEntries(root, base, head);
  const errors = [];
  const totals = { trackedBytes: 0, trackedFiles: after.size, evidenceBytes: 0, publishedDataBytes: 0 };
  const delta = { changedFiles: 0, addedFiles: 0, deletedFiles: 0, rewrittenBytes: 0, positiveGrowthBytes: 0, netGrowthBytes: 0 };
  const changed = [];
  const exceeds = (label, value, limit) => { if (value > limit) errors.push(`${label}: ${value} bytes exceeds ${limit}`); };
  for (const [name, pinned] of Object.entries(policy.legacyReleaseAssets)) {
    if (before.has(name) && after.get(name)?.oid !== pinned) {
      errors.push(`Must retain immutable legacy release ${name}; validate replacement links and change the policy separately before removing it`);
    }
  }
  for (const item of history.blobs) {
    if (!Object.values(policy.legacyReleaseAssets).includes(item.blob)) {
      exceeds(`new history blob ${item.path} (${item.blob})`, item.bytes, policy.limits.maxSingleFileBytes);
    }
  }
  for (const item of history.paths) {
    if (item.type !== 'blob' || !['100644', '100755'].includes(item.mode)) errors.push(`Expected a regular file in Git history: ${item.path}`);
    if (policy.evidencePrefixes.some(prefix => item.path.startsWith(prefix))) {
      exceeds(`new history evidence ${item.path}`, item.bytes, policy.limits.maxEvidenceFileBytes);
    }
    if (policy.diagnosticPrefixes.some(prefix => item.path.startsWith(prefix)) || policy.rawDataPrefixes.some(prefix => item.path.startsWith(prefix))) {
      errors.push(`Keep diagnostic/raw blobs outside Git history: ${item.path}`);
    }
  }
  exceeds('new history blob bytes', history.newBlobBytes, policy.limits.maxRewrittenBytes);
  for (const [name, item] of after) {
    totals.trackedBytes += item.bytes;
    const evidence = policy.evidencePrefixes.some(prefix => name.startsWith(prefix));
    if (evidence) {
      totals.evidenceBytes += item.bytes;
      exceeds(`evidence file ${name}`, item.bytes, policy.limits.maxEvidenceFileBytes);
    }
    if (name.startsWith('out/')) totals.publishedDataBytes += item.bytes;
    if (item.type !== 'blob' || item.mode !== '100644' && item.mode !== '100755') errors.push(`Expected a regular file: ${name}`);
    if (policy.diagnosticPrefixes.some(prefix => name.startsWith(prefix))) errors.push(`Keep diagnostic output outside Git: ${name}`);
    if (policy.rawDataPrefixes.some(prefix => name.startsWith(prefix))) errors.push(`Store raw data in a versioned external store: ${name}`);
    const legacy = policy.legacyReleaseAssets[name];
    if (legacy && item.oid !== legacy) errors.push(`Do not replace immutable legacy release ${name}; publish a Release asset`);
    if (/^unfallatlas-website-.*\.zip$/.test(name) && !legacy) errors.push(`Publish new release archive as a Release asset: ${name}`);
    if (!legacy || item.oid !== legacy) exceeds(`file ${name}`, item.bytes, policy.limits.maxSingleFileBytes);
  }
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(name); const current = after.get(name);
    if (old?.oid === current?.oid && old?.mode === current?.mode) continue;
    const oldBytes = old?.bytes || 0; const bytes = current?.bytes || 0;
    delta.changedFiles++;
    if (!old) delta.addedFiles++;
    if (!current) delta.deletedFiles++;
    delta.rewrittenBytes += bytes;
    delta.positiveGrowthBytes += Math.max(0, bytes - oldBytes);
    delta.netGrowthBytes += bytes - oldBytes;
    changed.push({ path: name, status: !old ? 'A' : !current ? 'D' : 'M', oldBytes, bytes, blob: current?.oid || null });
  }
  exceeds('tracked tree', totals.trackedBytes, policy.limits.maxTrackedBytes);
  exceeds('durable evidence', totals.evidenceBytes, policy.limits.maxEvidenceBytes);
  exceeds('published data', totals.publishedDataBytes, policy.limits.maxPublishedDataBytes);
  for (const [key, value] of Object.entries(delta)) {
    const limit = policy.limits[`max${key[0].toUpperCase()}${key.slice(1)}`];
    if (value > limit) errors.push(`${key}: ${value} exceeds ${limit}`);
  }
  return { schemaVersion: 1, contract: 'unfallwerkbank-repository-storage-report/v1', valid: errors.length === 0,
    base, head, policy: { path: POLICY_PATH, sha256: policy.sha256 || null, sourceRevision: policy.sourceRevision || null, limits: policy.limits },
    totals, delta, history, changed, largest: [...after].map(([name, item]) => ({ path: name, bytes: item.bytes, blob: item.oid })).sort((a, b) => b.bytes - a.bytes).slice(0, 25), errors };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const options = {}; let fetchHistory = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--fetch-history') { fetchHistory = true; continue; }
      if (!['--base', '--head', '--report'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: check-repository-storage.js --base SHA [--head SHA] [--report PATH] [--fetch-history]');
      options[args[i].slice(2)] = args[++i];
    }
    const root = path.resolve(__dirname, '..');
    options.base ||= process.env.STORAGE_EVENT === 'workflow_dispatch'
      ? revision(root, 'HEAD^', 'manual baseline') : process.env.STORAGE_BASE;
    if (fetchHistory) Object.assign(options, prepareHistory(root, options.base, options.head));
    const report = evaluateStorage(options);
    if (options.report) {
      const file = path.resolve(options.report);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(`Repository storage: ${report.valid ? 'PASS' : 'FAIL'}; ${report.totals.trackedBytes} tracked bytes; ${report.delta.positiveGrowthBytes} added bytes; ${report.delta.changedFiles} changed files`);
    for (const error of report.errors) console.error(error);
    if (!report.valid) process.exitCode = 1;
  } catch (error) { console.error(`Repository storage check failed: ${error.message}`); process.exitCode = 1; }
}

module.exports = { evaluateStorage, loadPolicy, validatePolicy, requireCompleteRange, prepareHistory };
