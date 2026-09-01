'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseJUnitSummary,
  validateBrowserRun,
  validatePlaywrightEvidence,
} = require('../../scripts/run-pages-quality-gate.cjs');

function writeEvidence(directory, {
  status = 'passed',
  failedTests = [],
  tests = 11,
  failures = 0,
  errors = 0,
} = {}) {
  const lastRunFile = path.join(directory, 'last-run.json');
  const junitFile = path.join(directory, 'junit.xml');
  fs.writeFileSync(lastRunFile, `${JSON.stringify({ status, failedTests }, null, 2)}\n`);
  fs.writeFileSync(
    junitFile,
    `<testsuites tests="${tests}" failures="${failures}" errors="${errors}"></testsuites>\n`
  );
  return { lastRunFile, junitFile };
}

describe('Pages Playwright result evidence', () => {
  let directory;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-pages-playwright-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test('accepts a fresh passed last-run record and green JUnit totals', () => {
    const files = writeEvidence(directory);
    const result = validatePlaywrightEvidence({
      ...files,
      startedAtMs: Date.now() - 1000,
    });

    expect(result).toEqual({
      status: 'passed',
      failedTests: 0,
      tests: 11,
      failures: 0,
      errors: 0,
    });
  });

  test('fails closed when Playwright reports a failed run', () => {
    const files = writeEvidence(directory, {
      status: 'failed',
      failedTests: ['pages-critical-path-spec-id'],
    });

    expect(() => validatePlaywrightEvidence({
      ...files,
      startedAtMs: Date.now() - 1000,
    })).toThrow(/reported status "failed"/);
  });

  test('fails closed on red JUnit evidence even when the process reports success', () => {
    const files = writeEvidence(directory, { failures: 1 });

    expect(() => validatePlaywrightEvidence({
      ...files,
      startedAtMs: Date.now() - 1000,
    })).toThrow(/JUnit evidence is red: 1 failure/);
  });

  test('validates red evidence even when the Playwright process exits non-zero', () => {
    const files = writeEvidence(directory, { failures: 1 });
    let thrown;

    try {
      validateBrowserRun(
        'node',
        ['playwright', 'test'],
        {},
        { status: 1, error: null },
        { ...files, startedAtMs: Date.now() - 1000 }
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown.errors.map(error => error.message)).toEqual(expect.arrayContaining([
      expect.stringMatching(/Command failed with exit code 1/),
      expect.stringMatching(/JUnit evidence is red: 1 failure/),
    ]));
  });

  test('does not let green evidence hide a non-zero Playwright exit code', () => {
    const files = writeEvidence(directory);

    expect(() => validateBrowserRun(
      'node',
      ['playwright', 'test'],
      {},
      { status: 2, error: null },
      { ...files, startedAtMs: Date.now() - 1000 }
    )).toThrow(/Command failed with exit code 2/);
  });

  test('rejects missing, stale and empty evidence instead of reusing an old result', () => {
    const missingLastRun = path.join(directory, 'missing-last-run.json');
    const missingJunit = path.join(directory, 'missing-junit.xml');
    expect(() => validatePlaywrightEvidence({
      lastRunFile: missingLastRun,
      junitFile: missingJunit,
      startedAtMs: Date.now(),
    })).toThrow(/Missing Playwright last-run evidence/);

    const files = writeEvidence(directory);
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(files.lastRunFile, old, old);
    fs.utimesSync(files.junitFile, old, old);
    expect(() => validatePlaywrightEvidence({
      ...files,
      startedAtMs: Date.now(),
    })).toThrow(/Stale Playwright last-run evidence/);

    const emptyFiles = writeEvidence(directory, { tests: 0 });
    expect(() => validatePlaywrightEvidence({
      ...emptyFiles,
      startedAtMs: Date.now() - 1000,
    })).toThrow(/contains no executed tests/);
  });

  test('requires aggregate JUnit totals', () => {
    expect(() => parseJUnitSummary('<testsuites failures="0" errors="0"></testsuites>'))
      .toThrow(/does not declare tests/);
    expect(() => parseJUnitSummary('<not-junit/>'))
      .toThrow(/has no testsuite root/);
  });
});
