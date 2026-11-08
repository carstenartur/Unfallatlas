/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');
const source = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/deploy-pages-current-data.yml'), 'utf8');
const workflow = yaml.safeLoad(source);
const KEY = 'ris-sources-v1-Linux-42502618892-1';

test('manual checkpoint recovery restores exactly the requested cache and uses the canonical Maven publication path', () => {
  const inputs = workflow.on.workflow_dispatch.inputs;
  expect(inputs.hannover_checkpoint_retry).toMatchObject({ type: 'boolean', default: false });
  expect(inputs.ris_source_cache_key.type).toBe('string');
  expect(inputs.ris_min_records).toMatchObject({ type: 'number', default: 674 });
  const steps = workflow.jobs.build.steps;
  const exact = steps.find(step => step.id === 'ris-checkpoint-source-cache');
  expect(exact.with.key).toBe('${{ steps.ris-checkpoint-retry.outputs.cache-key }}');
  expect(exact.with['restore-keys']).toBeUndefined();
  expect(exact.with['fail-on-cache-miss']).toBe(true);
  const maven = steps.find(step => /mvn .*verify -Ppages/.test(step.run || ''));
  expect(maven.env).toMatchObject({ PAGES_REFRESH_RIS: '1',
    PAGES_RIS_CHECKPOINT_RETRY: '${{ steps.ris-checkpoint-retry.outputs.enabled }}',
    PAGES_RIS_SOURCE_CACHE_KEY: '${{ steps.ris-checkpoint-retry.outputs.cache-key }}',
    PAGES_RIS_MIN_RECORDS: '${{ steps.ris-checkpoint-retry.outputs.min-records }}',
    PAGES_RIS_CACHE_HIT: '${{ steps.ris-checkpoint-source-cache.outputs.cache-hit }}' });
  expect(steps.filter(step => /mvn .*verify/.test(step.run || ''))).toHaveLength(1);
});

test('workflow validates untrusted inputs through environment variables before restoring any recovery cache', () => {
  const steps = workflow.jobs.build.steps;
  const validation = steps.find(step => step.id === 'ris-checkpoint-retry');
  expect(steps.indexOf(validation)).toBeLessThan(steps.findIndex(step => step.id === 'ris-checkpoint-source-cache'));
  expect(validation.run).not.toContain('${{');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ris-retry-input-'));
  try {
    const output = path.join(folder, 'outputs');
    const run = overrides => spawnSync('bash', ['-e', '-c', validation.run], { encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: output, RIS_RETRY_ENABLED: 'true', RIS_RETRY_EVENT: 'workflow_dispatch',
        RIS_RETRY_CACHE_KEY: KEY, RIS_RETRY_MIN_RECORDS: '674', ...overrides } });
    expect(run({}).status).toBe(0);
    expect(fs.readFileSync(output, 'utf8')).toContain(`cache-key=${KEY}\n`);
    for (const value of [KEY + '\n', '$(touch ' + path.join(folder, 'injected') + ')', '../cache']) {
      expect(run({ RIS_RETRY_CACHE_KEY: value }).status).not.toBe(0);
    }
    expect(fs.existsSync(path.join(folder, 'injected'))).toBe(false);
    expect(run({ RIS_RETRY_EVENT: 'push' }).status).not.toBe(0);
    for (const value of ['0', '1.5', '9007199254740992', '674\n']) {
      expect(run({ RIS_RETRY_MIN_RECORDS: value }).status).not.toBe(0);
    }
    expect(run({ RIS_RETRY_ENABLED: 'false', RIS_RETRY_CACHE_KEY: '' }).status).toBe(0);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
