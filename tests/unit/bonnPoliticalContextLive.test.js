'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'bonn-political-context-live.json');
const liveTest = process.env.BONN_OPARL_LIVE === '1' ? test : test.skip;

// A complete Bonn catalogue traversal currently covers about 243 pages. Keep
// the process bounded, but allow one retry without a false Jest timeout.
jest.setTimeout(780_000);

describe('official Bonn political-context live evidence', () => {
  liveTest('traverses OParl first and returns direct official references', () => {
    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'qa-bonn-political-context-live.js'),
      '--terms', 'Adenauerallee,Radverkehr',
      '--attempts', '2',
      '--retry-delay-ms', '3000',
      '--require-results',
      '--output', OUTPUT,
    ], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      timeout: 720_000,
    });

    const diagnostics = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (result.error || result.status !== 0) {
      throw new Error(
        `Bonn live QA process failed (status=${result.status}): `
        + `${result.error?.message || ''}\n${diagnostics}`
      );
    }
    expect(fs.existsSync(OUTPUT)).toBe(true);
    const evidence = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    expect(evidence.passed).toBe(true);
    expect(evidence.attempts.length).toBeGreaterThan(0);
    const finalAttempt = evidence.attempts[evidence.attempts.length - 1];
    expect(finalAttempt.validationErrors).toEqual([]);
    expect(finalAttempt.result.references.length).toBeGreaterThan(0);
    expect(diagnostics).toContain('[bonn-political-context-live] PASS');
  });
});
