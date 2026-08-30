'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ContextDataGitDeltaError,
  loadPolicy,
  reviewContextDataGitDelta,
} = require('../../scripts/review-context-data-git-delta');

const ROOT = path.resolve(__dirname, '../..');
const created = [];

function git(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallwerkbank-git-delta-'));
  created.push(root);
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  write(root, '.gitignore', 'out/qa/\n');
  write(root, 'out/base.txt', 'base\n');
  write(root, 'out/delete-me.txt', 'delete\n');
  write(root, 'data/accident-data-release.json', '{}\n');
  fs.copyFileSync(
    path.join(ROOT, 'config', 'context-data-git-budget.json'),
    path.join(root, 'config', 'context-data-git-budget.json'),
  );
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'test@example.invalid']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'baseline']);
  return root;
}

function policy(root, limitOverrides = {}) {
  const loaded = loadPolicy(root);
  return {
    ...loaded,
    limits: Object.freeze({ ...loaded.limits, ...limitOverrides }),
  };
}

function review(root, options = {}) {
  return reviewContextDataGitDelta({
    root,
    policy: options.policy || policy(root),
    print: false,
  });
}

function capturedReviewError(root, options = {}) {
  try {
    review(root, options);
    throw new Error('expected context-data Git delta review to fail');
  } catch (error) {
    if (error.message === 'expected context-data Git delta review to fail') throw error;
    return error;
  }
}

afterEach(() => {
  while (created.length > 0) fs.rmSync(created.pop(), { recursive: true, force: true });
});

describe('context-data Git delta review', () => {
  test('leaves the index clean and emits durable evidence when public data is unchanged', () => {
    const root = repository();
    const report = review(root);

    expect(report.valid).toBe(true);
    expect(report.files).toEqual([]);
    expect(report.totals).toEqual(expect.objectContaining({
      changedFiles: 0,
      rewrittenBytes: 0,
      netGrowthBytes: 0,
    }));
    expect(git(root, ['diff', '--cached', '--quiet'], { allowFailure: true }).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(
      path.join(root, 'out/qa/context-data-git-delta.json'), 'utf8',
    )).valid).toBe(true);
    expect(fs.readFileSync(
      path.join(root, 'out/qa/context-data-git-delta.txt'), 'utf8',
    )).toContain('valid=true');
  });

  test('accounts for allowed additions, modifications and deletions from the exact staged index', () => {
    const root = repository();
    write(root, 'out/base.txt', 'changed\n');
    write(root, 'out/new.json.gz', 'new\n');
    fs.rmSync(path.join(root, 'out/delete-me.txt'));

    const report = review(root);

    expect(report.valid).toBe(true);
    expect(report.totals).toEqual(expect.objectContaining({
      changedFiles: 3,
      addedFiles: 1,
      deletedFiles: 1,
    }));
    expect(report.files.map(row => [row.status, row.path])).toEqual(expect.arrayContaining([
      ['modified', 'out/base.txt'],
      ['added', 'out/new.json.gz'],
      ['deleted', 'out/delete-me.txt'],
    ]));
    expect(report.files.every(row => row.allowed)).toBe(true);
  });

  test('blocks and reports an unrelated path that was already staged before the review', () => {
    const root = repository();
    write(root, 'README.md', 'unexpected\n');
    git(root, ['add', 'README.md']);
    write(root, 'out/base.txt', 'changed\n');

    const error = capturedReviewError(root);

    expect(error).toBeInstanceOf(ContextDataGitDeltaError);
    expect(error.report.valid).toBe(false);
    expect(error.report.errors).toContain('unexpected staged path: "README.md"');
    expect(error.report.files.find(row => row.path === 'README.md')).toEqual(
      expect.objectContaining({ allowed: false, currentBytes: 11 }),
    );
    expect(fs.readFileSync(
      path.join(root, 'out/qa/context-data-git-delta.txt'), 'utf8',
    )).toContain('unexpected staged path: "README.md"');
  });

  test('retains git diff --check diagnostics before failing', () => {
    const root = repository();
    write(root, 'out/base.txt', 'trailing whitespace   \n');

    const error = capturedReviewError(root);

    expect(error).toBeInstanceOf(ContextDataGitDeltaError);
    expect(error.report.diffCheck).toContain('trailing whitespace');
    expect(error.report.errors).toContain('git diff --cached --check failed with status 2');
    const text = fs.readFileSync(path.join(root, 'out/qa/context-data-git-delta.txt'), 'utf8');
    expect(text).toContain('GIT DIFF CHECK');
    expect(text).toContain('trailing whitespace');
  });

  test('blocks a single oversized staged blob using the reviewed policy', () => {
    const root = repository();
    write(root, 'out/large.bin', Buffer.alloc(17, 1));

    const error = capturedReviewError(root, {
      policy: policy(root, { maxSingleFileBytes: 16 }),
    });

    expect(error).toBeInstanceOf(ContextDataGitDeltaError);
    expect(error.report.largest).toEqual({ path: 'out/large.bin', bytes: 17 });
    expect(error.report.errors).toContain(
      'single file exceeds 16 bytes: "out/large.bin" (17 bytes)',
    );
  });

  test('blocks aggregate file-count and growth budgets independently', () => {
    const root = repository();
    write(root, 'out/one.txt', '1111');
    write(root, 'out/two.txt', '2222');

    const error = capturedReviewError(root, {
      policy: policy(root, {
        maxChangedFiles: 1,
        maxAddedFiles: 1,
        maxPositiveGrowthBytes: 7,
        maxNetGrowthBytes: 7,
      }),
    });

    expect(error.report.errors).toEqual(expect.arrayContaining([
      'changed file count 2 exceeds 1',
      'added file count 2 exceeds 1',
      'positive growth 8 exceeds 7',
      'net growth 8 exceeds 7',
    ]));
  });

  (process.platform === 'win32' ? test.skip : test)(
    'blocks symlinks and other non-regular index modes',
    () => {
      const root = repository();
      fs.symlinkSync('base.txt', path.join(root, 'out/link.txt'));

      const error = capturedReviewError(root);

      expect(error.report.errors).toContain('unsupported staged file mode 120000: "out/link.txt"');
    },
  );
});

describe('Maven-owned automatic context-data pull-request contract', () => {
  test('keeps generation and Git-delta review inside one Maven-owned npm execution', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/enrich.yml'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    expect(packageJson.scripts['qa:context-enrichment']).toBe(
      'node scripts/run-context-enrichment.js && node scripts/run-context-data-git-delta-if-enabled.js',
    );
    expect(workflow).toContain("CONTEXT_REVIEW_GIT_DELTA: 'true'");
    expect(workflow).toContain('mvn -B -ntp verify -Pcontext-data-e2e');
    expect(workflow.match(/^\s*run:\s*>-\s*$/gm) || []).toHaveLength(1);
    expect(workflow).not.toContain('Review staged public-data delta before any commit');
    expect(workflow).not.toMatch(/\bnode\s+scripts\//);
  });

  test('commits only the reviewed index and publishes through a guarded pull-request branch', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/enrich.yml'), 'utf8');
    const start = workflow.indexOf(
      '      - name: Commit reviewed data and open or update pull request',
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const publish = workflow.slice(start);

    expect(workflow).toContain('pull-requests: write');
    expect(publish).not.toContain('git add');
    expect(publish).toContain('source_head="$(git rev-parse HEAD)"');
    expect(publish).toContain('TARGET_BRANCH: ${{ github.event.repository.default_branch }}');
    expect(publish).toContain('REFRESH_BRANCH: automation/context-data-refresh');
    expect(publish).toContain('git fetch --no-tags origin "refs/heads/${TARGET_BRANCH}"');
    expect(publish).toContain('remote_head="$(git rev-parse FETCH_HEAD)"');
    expect(publish).toContain('Refusing stale context-data publication');
    expect(publish).toContain('--force-with-lease="refs/heads/${REFRESH_BRANCH}:${expected_refresh_head}"');
    expect(publish).toContain('origin "HEAD:refs/heads/${REFRESH_BRANCH}"');
    expect(publish).toContain('gh api --method POST "repos/${REPOSITORY}/pulls"');
    expect(publish).not.toContain('origin "HEAD:refs/heads/${TARGET_BRANCH}"');
    expect(publish).not.toContain('origin "HEAD:${TARGET_BRANCH}"');
  });

  test('uses an optional bot token without making publication failure destructive', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/enrich.yml'), 'utf8');

    expect(workflow).toContain(
      'GH_TOKEN: ${{ secrets.CONTEXT_DATA_PR_TOKEN || github.token }}',
    );
    expect(workflow).toContain('The reviewed data commit was pushed to ${REFRESH_BRANCH}');
    expect(workflow).toContain('CONTEXT_DATA_PR_TOKEN');
    expect(workflow).toContain('>>"$GITHUB_STEP_SUMMARY"');
  });

  test('versioned policy and implementation changes retrigger the guarded workflow', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/enrich.yml'), 'utf8');
    for (const repositoryPath of [
      "config/context-data-git-budget.json",
      "scripts/review-context-data-git-delta.js",
      "scripts/run-context-data-git-delta-if-enabled.js",
    ]) {
      expect(workflow).toContain(`- '${repositoryPath}'`);
    }
  });
});
