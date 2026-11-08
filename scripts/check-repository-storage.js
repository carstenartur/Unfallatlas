'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const POLICY_PATH = 'config/repository-storage-budget.json';
const LIMITS = ['maxSingleFileBytes', 'maxTrackedBytes', 'maxChangedFiles', 'maxAddedFiles',
  'maxDeletedFiles', 'maxRewrittenBytes', 'maxPositiveGrowthBytes', 'maxNetGrowthBytes',
  'maxEvidenceBytes', 'maxEvidenceFileBytes', 'maxPublishedDataBytes'];

function git(root, args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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

function evaluateStorage(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const base = revision(root, options.base, 'baseline');
  const head = revision(root, options.head || 'HEAD', 'head');
  if (git(root, ['merge-base', '--is-ancestor', base, head], true).status !== 0) {
    throw new Error('Storage baseline must be an ancestor of the checked head; unrelated histories cannot establish a delta');
  }
  const hasBaselinePolicy = git(root, ['cat-file', '-e', `${base}:${POLICY_PATH}`], true).status === 0;
  const policy = validatePolicy(options.policy || loadPolicy(root, hasBaselinePolicy ? base : head));
  const before = tree(root, base);
  const after = tree(root, head);
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
    totals, delta, changed, largest: [...after].map(([name, item]) => ({ path: name, bytes: item.bytes, blob: item.oid })).sort((a, b) => b.bytes - a.bytes).slice(0, 25), errors };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2); const options = {};
    for (let i = 0; i < args.length; i += 2) {
      if (!['--base', '--head', '--report'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: check-repository-storage.js --base SHA [--head SHA] [--report PATH]');
      options[args[i].slice(2)] = args[i + 1];
    }
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

module.exports = { evaluateStorage, loadPolicy, validatePolicy };
