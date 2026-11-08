/** @jest-environment node */
'use strict';

const fs = require('fs');
const { createRequire } = require('node:module');
const path = require('path');
const vm = require('node:vm');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '../..');
const PAGE_WORKFLOWS = [
  '.github/workflows/deploy-pages-current-data.yml',
  '.github/workflows/generate-data-deploy-pages.yml',
];
const CACHE_ACTION = '55cc8345863c7cc4c66a329aec7e433d2d1c52a9';
const CACHE_PATH = '.cache/ris-sources';
const CACHE_KEY = 'ris-sources-v1-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}';

function readWorkflow(workflowPath) {
  return yaml.safeLoad(fs.readFileSync(path.join(ROOT, workflowPath), 'utf8'));
}

function refreshInvocation(env = {}) {
  const filename = path.join(ROOT, 'scripts/run-pages-quality-gate.cjs');
  const localRequire = createRequire(filename);
  const calls = [];
  const mainModule = { exports: {} };
  const instrumentedRequire = id => id === 'node:child_process' ? {
    spawnSync(...args) {
      calls.push(args);
      // Stop at the external refresh boundary, before any site files change.
      return { status: 1 };
    },
  } : localRequire(id);
  instrumentedRequire.main = mainModule;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: instrumentedRequire,
    module: mainModule,
    __dirname: path.dirname(filename),
    process: {
      execPath: process.execPath,
      env: { PAGES_REFRESH_RIS: '1', ...env },
      stdout: { write() {} },
      stderr: { write() {} },
    },
  }, { filename });
  return calls;
}

describe('Pages deployment workflow safety', () => {
  test('scheduled source continuation covers every weekday through the shared publication path', () => {
    const runs = Array(7).fill(0);
    for (const workflowPath of PAGE_WORKFLOWS) {
      const workflow = readWorkflow(workflowPath);
      expect(workflow.concurrency).toMatchObject({ group: 'pages-data', 'cancel-in-progress': false });
      for (const { cron } of workflow.on.schedule || []) {
        const fields = cron.split(/\s+/);
        expect(fields).toHaveLength(5);
        expect(fields.slice(2, 4)).toEqual(['*', '*']);
        const days = fields[4] === '*' ? ['0-6'] : fields[4].split(',');
        for (const range of days) {
          const [first, last = first] = range.split('-').map(Number);
          expect(first).toBeGreaterThanOrEqual(0);
          expect(last).toBeLessThanOrEqual(6);
          for (let day = first; day <= last; day++) runs[day]++;
        }
      }
    }
    // One bounded run per day advances detail renewals within the fourteen-day
    // evidence lifetime. The weekly full data regeneration supplies Sunday.
    expect(runs).toEqual(Array(7).fill(1));
  });

  test.each(PAGE_WORKFLOWS)('%s publishes artifacts without mutating repository settings', workflowPath => {
    const workflow = fs.readFileSync(path.join(ROOT, workflowPath), 'utf8');

    expect(workflow).toMatch(/actions\/configure-pages@[0-9a-f]{40}\s+# v6/);
    expect(workflow).toMatch(/actions\/deploy-pages@[0-9a-f]{40}\s+# v5/);
    expect(workflow).not.toMatch(/actions\/configure-pages@v\d/);
    expect(workflow).not.toMatch(/actions\/deploy-pages@v\d/);
    expect(workflow).toContain('pages: write');
    expect(workflow).toContain('id-token: write');

    expect(workflow).not.toContain('gh api');
    expect(workflow).not.toContain('build_type=workflow');
    expect(workflow).not.toContain('GH_TOKEN:');
    expect(workflow).not.toContain('administration: write');
  });

  test.each(PAGE_WORKFLOWS)('%s resumes source downloads and saves progress after a failed import', workflowPath => {
    const { steps } = readWorkflow(workflowPath).jobs.build;
    const restoreIndex = steps.findIndex(step => step.uses?.startsWith('actions/cache/restore@')
      && step.with?.path === CACHE_PATH && step.id === 'ris-source-cache');
    const saveIndex = steps.findIndex(step => step.uses?.startsWith('actions/cache/save@')
      && step.with?.path === CACHE_PATH);
    const mavenIndex = steps.findIndex(step => step.env?.PAGES_REFRESH_RIS === '1'
      && /mvn .*verify/.test(step.run));
    const uploadIndex = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));

    expect(restoreIndex).toBeGreaterThanOrEqual(0);
    expect(saveIndex).toBeGreaterThan(mavenIndex);
    expect(restoreIndex).toBeLessThan(mavenIndex);
    expect(saveIndex).toBeLessThan(uploadIndex);
    const restore = steps[restoreIndex];
    const save = steps[saveIndex];
    expect(restore.uses).toBe(`actions/cache/restore@${CACHE_ACTION}`);
    expect(save.uses).toBe(`actions/cache/save@${CACHE_ACTION}`);
    expect(restore.with.key).toBe(CACHE_KEY);
    expect(save.with.key).toBe(restore.with.key);
    expect(restore.with['restore-keys'].trim()).toBe('ris-sources-v1-${{ runner.os }}-');

    // GitHub otherwise implicitly adds success() and skips this step on failure.
    expect(save.if).toMatch(/\balways\s*\(/);
    const condition = save.if.replace(`steps.${restore.id}.outputs.cache-hit`, 'cacheHit')
      .replace('steps.ris-checkpoint-retry.outputs.enabled', 'recoveryEnabled');
    for (const cacheHit of ['', 'false', 'true']) {
      const saveAfterFailure = vm.runInNewContext(condition, {
        always: () => true,
        success: () => false,
        failure: () => true,
        cacheHit,
        recoveryEnabled: 'false',
      });
      expect(saveAfterFailure).toBe(cacheHit !== 'true');
    }
  });

  test('manual recovery is passed through Maven as validated CLI arguments, never a shell command', () => {
    const calls = refreshInvocation({ PAGES_RIS_CHECKPOINT_RETRY: 'true',
      PAGES_RIS_SOURCE_CACHE_KEY: 'ris-sources-v1-Linux-42502618892-1',
      PAGES_RIS_MIN_RECORDS: '674', PAGES_RIS_CACHE_HIT: 'true' });
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual([path.join(ROOT, 'scripts/refresh-ris-catalogues.js'),
      '--checkpoint-retry', 'hannover', '--source-cache-key', 'ris-sources-v1-Linux-42502618892-1', '--min-records', '674']);
    expect(calls[0][2].shell).not.toBe(true);
  });

  test('allows the one-hour source crawl while retaining time for Pages verification and cache saving', () => {
    const calls = refreshInvocation();
    expect(calls).toHaveLength(1);
    const [command, args, options] = calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toEqual([path.join(ROOT, 'scripts/refresh-ris-catalogues.js')]);
    expect(options.timeout).toBeGreaterThan(60 * 60_000);
    expect(options.timeout).toBeLessThanOrEqual(65 * 60_000);
    expect(options.killSignal).toBe('SIGTERM');
    for (const workflowPath of PAGE_WORKFLOWS) {
      const buildMinutes = readWorkflow(workflowPath).jobs.build['timeout-minutes'];
      expect(buildMinutes * 60_000 - options.timeout).toBeGreaterThanOrEqual(55 * 60_000);
    }
  });
});
