'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const {
  PLAYWRIGHT_INSTALL_TIMEOUT_MS,
  installBrowsers,
  playwrightCli,
} = require('./install-playwright-browsers.cjs');

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = process.env.PAGES_INPUT_DIR || 'out';
const POI_DIR = process.env.PAGES_POI_DIR || 'out';
const SITE_DIR = process.env.PAGES_OUTPUT_DIR || '_site';
const SITE_ROOT = path.resolve(ROOT, SITE_DIR);
const QA_DIR = path.resolve(ROOT, 'out', 'qa');
const SERVER_LOG = path.join(QA_DIR, 'pages-maven-server.log');
const FINGERPRINT = path.join(QA_DIR, 'pages-maven-profile.sha256');
const PLAYWRIGHT_RESULT_DIR = path.resolve(ROOT, 'test-results');
const PLAYWRIGHT_REPORT_DIR = path.resolve(ROOT, 'playwright-report');
const PLAYWRIGHT_JUNIT = path.join(PLAYWRIGHT_RESULT_DIR, 'junit.xml');
const PLAYWRIGHT_LAST_RUN = path.join(QA_DIR, 'pages-playwright-last-run.json');
const EVIDENCE_CLOCK_TOLERANCE_MS = 2000;
const BASE_URL = 'http://127.0.0.1:8000';

function display(command, args) {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

function spawnCommand(command, args, options = {}) {
  process.stdout.write(`\n[pages-qa] $ ${display(command, args)}\n`);
  const spawnOptions = {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...(options.env || {}) },
    shell: false,
  };
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    spawnOptions.timeout = options.timeoutMs;
    spawnOptions.killSignal = 'SIGTERM';
  }
  return spawnSync(command, args, spawnOptions);
}

function commandFailure(command, args, options, result) {
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      return new Error(
        `[pages-qa] Command exceeded ${options.timeoutMs} ms and was terminated: ${display(command, args)}`,
        { cause: result.error }
      );
    }
    return result.error;
  }
  if (result.status !== 0) {
    return new Error(
      `[pages-qa] Command failed with exit code ${result.status}: ${display(command, args)}`
    );
  }
  return null;
}

function run(command, args, options = {}) {
  const result = spawnCommand(command, args, options);
  const failure = commandFailure(command, args, options, result);
  if (failure) throw failure;
  return result;
}

function runNode(relativeScript, args = [], options = {}) {
  run(process.execPath, [path.resolve(ROOT, relativeScript), ...args], options);
}

function requestReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 400);
    });
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
  });
}

async function waitForServer(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await requestReady(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`[pages-qa] Site server did not become ready at ${url}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function withSiteServer(callback) {
  fs.mkdirSync(QA_DIR, { recursive: true });
  const log = fs.openSync(SERVER_LOG, 'w');
  const child = spawn(process.execPath, [
    path.resolve(ROOT, 'scripts/serve-site.js'),
    '--no-build',
    '--site',
    SITE_DIR,
  ], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', log, log],
    detached: false,
  });

  try {
    await waitForServer(`${BASE_URL}/werkbank_v2.html`);
    await callback();
  } finally {
    await stopChild(child);
    fs.closeSync(log);
  }
}

function buildAndValidateSite() {
  fs.rmSync(SITE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(QA_DIR, { recursive: true });

  runNode('scripts/build-site.js', [
    '--input-dir', INPUT_DIR,
    '--poi-dir', POI_DIR,
    '--output-dir', SITE_DIR,
  ]);
  runNode('scripts/generate-data-status.js', [
    '--site', SITE_DIR,
    '--cities', 'cities.txt',
  ]);
  runNode('scripts/build-public-pages-profile.js', ['--site', SITE_DIR]);
  runNode('scripts/validate-static-data.js', [
    '--dir', `${SITE_DIR}/out`,
    '--gzip-only',
    '--require-cities-file', 'cities.txt',
    '--min-features', '10',
  ]);
  runNode('scripts/check-context-datasets.js', [SITE_DIR]);
  runNode('scripts/validate-doc-media.js', [
    '--report', 'out/qa/pages-maven-documentation-media.json',
  ]);
  runNode('scripts/validate-public-pages-profile.js', ['--site', SITE_DIR]);
  runNode('scripts/fingerprint-static-tree.js', [
    '--site', SITE_DIR,
    '--write', path.relative(ROOT, FINGERPRINT),
  ]);
}

function installChromium() {
  return installBrowsers(['chromium']);
}

function readFreshEvidenceFile(file, startedAtMs, label) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      throw new Error(`[pages-qa] Missing ${label}: ${path.relative(ROOT, file)}`);
    }
    throw error;
  }
  if (!stat.isFile()) {
    throw new Error(`[pages-qa] ${label} is not a file: ${path.relative(ROOT, file)}`);
  }
  if (Number.isFinite(startedAtMs)
      && stat.mtimeMs + EVIDENCE_CLOCK_TOLERANCE_MS < startedAtMs) {
    throw new Error(`[pages-qa] Stale ${label}: ${path.relative(ROOT, file)}`);
  }
  return fs.readFileSync(file, 'utf8');
}

function parseNonNegativeIntegerAttribute(attributes, name, label) {
  const match = String(attributes || '').match(new RegExp(`\\b${name}=["'](\\d+)["']`, 'i'));
  if (!match) {
    throw new Error(`[pages-qa] ${label} does not declare ${name}`);
  }
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`[pages-qa] ${label} declares an invalid ${name} value`);
  }
  return value;
}

function parseJUnitSummary(xml) {
  const document = String(xml || '');
  const root = document.match(/<testsuites\b([^>]*)>/i)
    || document.match(/<testsuite\b([^>]*)>/i);
  if (!root) {
    throw new Error('[pages-qa] Playwright JUnit evidence has no testsuite root');
  }
  const label = 'Playwright JUnit evidence';
  return {
    tests: parseNonNegativeIntegerAttribute(root[1], 'tests', label),
    failures: parseNonNegativeIntegerAttribute(root[1], 'failures', label),
    errors: parseNonNegativeIntegerAttribute(root[1], 'errors', label),
  };
}

function validatePlaywrightEvidence({
  lastRunFile = PLAYWRIGHT_LAST_RUN,
  junitFile = PLAYWRIGHT_JUNIT,
  startedAtMs,
} = {}) {
  const lastRunText = readFreshEvidenceFile(
    lastRunFile,
    startedAtMs,
    'Playwright last-run evidence'
  );
  let lastRun;
  try {
    lastRun = JSON.parse(lastRunText);
  } catch (error) {
    throw new Error('[pages-qa] Playwright last-run evidence is not valid JSON', { cause: error });
  }
  if (!lastRun || lastRun.status !== 'passed') {
    throw new Error(
      `[pages-qa] Playwright reported status ${JSON.stringify(lastRun?.status || null)}`
    );
  }
  if (!Array.isArray(lastRun.failedTests)) {
    throw new Error('[pages-qa] Playwright last-run evidence has no failedTests array');
  }
  if (lastRun.failedTests.length > 0) {
    throw new Error(
      `[pages-qa] Playwright last-run evidence contains ${lastRun.failedTests.length} failed test(s)`
    );
  }

  const junit = parseJUnitSummary(readFreshEvidenceFile(
    junitFile,
    startedAtMs,
    'Playwright JUnit evidence'
  ));
  if (junit.tests < 1) {
    throw new Error('[pages-qa] Playwright JUnit evidence contains no executed tests');
  }
  if (junit.failures > 0 || junit.errors > 0) {
    throw new Error(
      `[pages-qa] Playwright JUnit evidence is red: ${junit.failures} failure(s), ${junit.errors} error(s)`
    );
  }

  return {
    status: lastRun.status,
    failedTests: lastRun.failedTests.length,
    ...junit,
  };
}

function prepareBrowserEvidence() {
  fs.rmSync(PLAYWRIGHT_RESULT_DIR, { recursive: true, force: true });
  fs.rmSync(PLAYWRIGHT_REPORT_DIR, { recursive: true, force: true });
  fs.rmSync(PLAYWRIGHT_LAST_RUN, { force: true });
  fs.mkdirSync(QA_DIR, { recursive: true });
}

function validateBrowserRun(command, args, options, processResult, evidenceOptions) {
  const processFailure = commandFailure(command, args, options, processResult);
  let evidenceResult;
  let evidenceFailure;
  try {
    evidenceResult = validatePlaywrightEvidence(evidenceOptions);
  } catch (error) {
    evidenceFailure = error;
  }

  if (processFailure && evidenceFailure) {
    throw new AggregateError(
      [processFailure, evidenceFailure],
      '[pages-qa] Playwright process and evidence validation both failed'
    );
  }
  if (evidenceFailure) throw evidenceFailure;
  if (processFailure) throw processFailure;
  return evidenceResult;
}

async function runBrowserGate() {
  await withSiteServer(async () => {
    prepareBrowserEvidence();
    const startedAtMs = Date.now();
    const command = process.execPath;
    const args = [
      playwrightCli(),
      'test',
      'tests/e2e/smoke.spec.js',
      'tests/e2e/pages-critical-path.spec.js',
      '--project=chromium',
    ];
    const options = {
      env: {
        BASE_URL,
        PLAYWRIGHT_HTML_OPEN: 'never',
        PLAYWRIGHT_LAST_RUN_OUTPUT_FILE: path.relative(ROOT, PLAYWRIGHT_LAST_RUN),
      },
    };
    const processResult = spawnCommand(command, args, options);
    const result = validateBrowserRun(
      command,
      args,
      options,
      processResult,
      { startedAtMs }
    );
    process.stdout.write(
      `[pages-qa] Playwright evidence passed: ${result.tests} test(s), 0 failures, 0 errors.\n`
    );
  });
}

function verifyArtifactUnchanged() {
  runNode('scripts/fingerprint-static-tree.js', [
    '--site', SITE_DIR,
    '--verify', path.relative(ROOT, FINGERPRINT),
  ]);
  runNode('scripts/validate-public-pages-profile.js', ['--site', SITE_DIR]);
}

async function main() {
  buildAndValidateSite();
  installChromium();
  await runBrowserGate();
  verifyArtifactUnchanged();
  process.stdout.write('\n[pages-qa] Maven-reproducible Pages quality gate passed.\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  PLAYWRIGHT_INSTALL_TIMEOUT_MS,
  installChromium,
  parseJUnitSummary,
  prepareBrowserEvidence,
  run,
  validateBrowserRun,
  validatePlaywrightEvidence,
};
