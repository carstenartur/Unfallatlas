/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { evaluateStorage, loadPolicy, prepareHistory } = require('../../scripts/check-repository-storage');

const temporary = [];
function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
function write(root, name, text) {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), text);
}
function commit(root) {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
}
function fixture(files = { 'README.md': 'small baseline\n' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-storage-'));
  temporary.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  for (const [name, value] of Object.entries(files)) write(root, name, value);
  return { root, base: commit(root) };
}
function policy(overrides = {}) {
  const original = loadPolicy(path.resolve(__dirname, '../..'));
  return { ...original, ...overrides, limits: { ...original.limits, ...overrides.limits } };
}
afterEach(() => { while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true }); });

test('rejects a new oversized blob with spaces in its path while preserving baseline bytes', () => {
  const { root, base } = fixture();
  write(root, 'test data/new binary.bin', Buffer.alloc(65));
  const head = commit(root);
  const report = evaluateStorage({ root, base, head, policy: policy({ limits: { maxSingleFileBytes: 64 } }) });
  expect(report.valid).toBe(false);
  expect(report.errors.join('\n')).toMatch(/test data\/new binary.bin.*65.*64/);
  expect(report.delta.addedFiles).toBe(1);
  expect(report.base).toBe(base);
  expect(report.head).toBe(head);
});

test('deletions cannot conceal excessive positive growth', () => {
  const { root, base } = fixture({ 'old.bin': Buffer.alloc(100) });
  fs.unlinkSync(path.join(root, 'old.bin'));
  write(root, 'new.bin', Buffer.alloc(90, 1));
  const report = evaluateStorage({ root, base, head: commit(root), policy: policy({ limits: { maxPositiveGrowthBytes: 80 } }) });
  expect(report.delta.netGrowthBytes).toBe(-10);
  expect(report.delta.positiveGrowthBytes).toBe(90);
  expect(report.valid).toBe(false);
});

test('rejects an oversized blob added and deleted in intermediate commits', () => {
  const { root, base } = fixture();
  write(root, 'temporary.bin', Buffer.alloc(65));
  commit(root);
  fs.unlinkSync(path.join(root, 'temporary.bin'));
  const report = evaluateStorage({ root, base, head: commit(root), policy: policy({ limits: { maxSingleFileBytes: 64 } }) });
  expect(report.delta.changedFiles).toBe(0);
  expect(report.valid).toBe(false);
  expect(report.errors.join('\n')).toMatch(/new history blob.*65.*64/);
});

test('counts each new intermediate blob once in the rewritten history budget', () => {
  const { root, base } = fixture();
  for (const value of [1, 2, 3]) { write(root, 'changing.bin', Buffer.alloc(20, value)); commit(root); }
  const report = evaluateStorage({ root, base, head: 'HEAD', policy: policy({ limits: { maxRewrittenBytes: 50 } }) });
  expect(report.delta.rewrittenBytes).toBe(20);
  expect(report.history.newBlobBytes).toBe(60);
  expect(report.valid).toBe(false);
});

test('requires the PR second-parent history before accepting a shallow merge checkout', () => {
  const { root, base } = fixture();
  const branch = git(root, 'branch', '--show-current');
  git(root, 'checkout', '-qb', 'feature');
  write(root, 'temporary.bin', Buffer.alloc(65)); commit(root);
  fs.unlinkSync(path.join(root, 'temporary.bin')); commit(root);
  git(root, 'checkout', branch);
  git(root, 'merge', '--no-ff', '-m', 'merge fixture', 'feature');
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'uw-storage-shallow-'));
  temporary.push(clone);
  git(root, 'clone', '-q', '--depth=2', `file://${root}`, clone);
  const options = { root: clone, base, head: 'HEAD', policy: policy({ limits: { maxSingleFileBytes: 64 } }) };
  expect(() => evaluateStorage(options)).toThrow(/Incomplete storage history range/);
  expect(prepareHistory(clone, base)).toEqual({ base, head: git(clone, 'rev-parse', 'HEAD') });
  const report = evaluateStorage(options);
  expect(report.valid).toBe(false);
  expect(report.errors.join('\n')).toMatch(/new history blob/);
});

test('history preparation rejects a missing or untrusted baseline before any fetch', () => {
  const { root } = fixture();
  for (const base of [undefined, '', '0'.repeat(40), '--all', 'HEAD^']) {
    expect(() => prepareHistory(root, base)).toThrow(/nonzero full baseline SHA/);
  }
});

test('budgets all durable evidence, including unchanged files', () => {
  const { root, base } = fixture({ 'qa/existing.json': 'x'.repeat(50) });
  write(root, 'qa/new.json', 'x'.repeat(51));
  const report = evaluateStorage({ root, base, head: commit(root), policy: policy({ limits: { maxEvidenceBytes: 100 } }) });
  expect(report.totals.evidenceBytes).toBe(101);
  expect(report.errors.join('\n')).toMatch(/evidence.*101.*100/);
});

test('keeps hash-pinned old releases but rejects replacing them or adding a release ZIP', () => {
  const name = 'unfallatlas-website-2.1.3.zip';
  const { root, base } = fixture({ [name]: Buffer.alloc(100) });
  const blob = git(root, 'rev-parse', `${base}:${name}`);
  const rules = policy({ legacyReleaseAssets: { [name]: blob }, limits: { maxSingleFileBytes: 64 } });
  expect(evaluateStorage({ root, base, head: base, policy: rules }).valid).toBe(true);
  write(root, name, Buffer.alloc(101));
  write(root, 'unfallatlas-website-2.1.4.zip', 'new');
  const report = evaluateStorage({ root, base, head: commit(root), policy: rules });
  expect(report.valid).toBe(false);
  expect(report.errors.join('\n')).toMatch(/immutable legacy release/);
  expect(report.errors.join('\n')).toMatch(/new release archive/);
});

test('rejects deleting a pinned existing release download', () => {
  const name = 'unfallatlas-website-2.1.3.zip';
  const { root, base } = fixture({ [name]: 'existing public download' });
  const blob = git(root, 'rev-parse', `${base}:${name}`);
  fs.unlinkSync(path.join(root, name));
  const report = evaluateStorage({ root, base, head: commit(root), policy: policy({ legacyReleaseAssets: { [name]: blob } }) });
  expect(report.valid).toBe(false);
  expect(report.errors.join('\n')).toMatch(/retain immutable legacy release/);
});

test('fails closed for missing, empty, all-zero and unrelated baselines', () => {
  const { root, base } = fixture();
  for (const bad of ['', undefined, '0'.repeat(40), 'f'.repeat(40)]) {
    expect(() => evaluateStorage({ root, base: bad, head: base, policy: policy() })).toThrow(/baseline|base/i);
  }
  git(root, 'checkout', '--orphan', 'unrelated');
  write(root, 'other.txt', 'unrelated');
  const head = commit(root);
  expect(() => evaluateStorage({ root, base, head, policy: policy() })).toThrow(/ancestor/);
});

test('rejects tracked diagnostic dumps and symlink escapes in evidence', () => {
  const { root, base } = fixture();
  write(root, 'out/qa/full-run.log', 'diagnostic');
  fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(root, 'qa/escape.json'));
  const report = evaluateStorage({ root, base, head: commit(root), policy: policy() });
  expect(report.valid).toBe(false);
  expect(report.errors.join('\n')).toMatch(/diagnostic.*out\/qa\/full-run.log/);
  expect(report.errors.join('\n')).toMatch(/regular file.*qa\/escape.json/);
});

test('a policy increase in the same PR cannot relax the baseline policy', () => {
  const oldPolicy = policy({ limits: { maxSingleFileBytes: 5000 } });
  const { root, base } = fixture({ 'config/repository-storage-budget.json': JSON.stringify(oldPolicy) });
  write(root, 'config/repository-storage-budget.json', JSON.stringify(policy({ limits: { maxSingleFileBytes: 10000 } })));
  write(root, 'large.bin', Buffer.alloc(5001));
  const report = evaluateStorage({ root, base, head: commit(root) });
  expect(report.policy.sourceRevision).toBe(base);
  expect(report.valid).toBe(false);
});
