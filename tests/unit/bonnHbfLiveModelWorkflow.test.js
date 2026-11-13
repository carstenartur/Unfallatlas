/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const yaml = require('js-yaml');

const workflow = yaml.safeLoad(fs.readFileSync(path.join(__dirname,
  '../../.github/workflows/bonn-hbf-live-model.yml'), 'utf8'));

test('the API exposes the model run as a separate job conditioned on the project provider', () => {
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  const { provider, capture } = workflow.jobs;
  expect(provider).toBeDefined();
  expect(provider.if).toBe("github.ref == 'refs/heads/main'");
  expect(provider.outputs.configured).toBe('${{ steps.availability.outputs.configured }}');
  expect(capture.needs).toBe('provider');
  expect(capture.if).toBe("needs.provider.outputs.configured == 'true'");
  const model = capture.steps.find(step => step.id === 'review');
  expect(model.run).toContain('-Pbonn-hbf-live-model');
  expect(model.env.GEMINI_API_KEY).toBe('${{ secrets.GEMINI_API_KEY }}');
  expect(capture.steps.find(step => step.uses?.startsWith('actions/upload-artifact@')).if).toContain('!cancelled()');
});

test.each([
  ['false', 1], ['true', 0],
])('reports optional live access with provider configured=%s', (configured, exitCode) => {
  const step = workflow.jobs.provider?.steps.find(item => item.id === 'availability');
  expect(step).toBeDefined();
  expect(step.env.PROVIDER_CONFIGURED).toBe("${{ secrets.GEMINI_API_KEY != '' }}");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bonn-provider-status-'));
  const output = path.join(folder, 'output');
  const summary = path.join(folder, 'summary');
  try {
    const probe = spawnSync('bash', ['-e', '-c', step.run], { encoding: 'utf8', env: {
      PROVIDER_CONFIGURED: configured, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary,
    } });
    expect(probe.status).toBe(exitCode);
    expect(fs.readFileSync(output, 'utf8').trim()).toBe('configured=' + configured);
    if (configured === 'false') {
      expect(fs.readFileSync(summary, 'utf8')).toContain('Modellprüfung übersprungen: kein Zugang');
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test.each(['success', 'failure', 'skipped'])('the summary reports the actual Maven outcome %s', outcome => {
  const summaryStep = workflow.jobs.capture.steps.find(step => step.env?.REVIEW_OUTCOME);
  expect(summaryStep.env.REVIEW_OUTCOME).toBe('${{ steps.review.outcome }}');
  expect(summaryStep.if).toBe('${{ !cancelled() }}');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bonn-model-outcome-'));
  const file = path.join(folder, 'summary');
  try {
    const result = spawnSync('bash', ['-e', '-c', summaryStep.run], {
      env: { REVIEW_OUTCOME: outcome, GITHUB_STEP_SUMMARY: file },
    });
    expect(result.status).toBe(0);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.includes('Gemini hat geantwortet.')).toBe(outcome === 'success');
    expect(text).toContain('unabhängige Fachfreigabe steht aus');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
