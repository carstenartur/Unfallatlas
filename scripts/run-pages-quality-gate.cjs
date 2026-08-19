'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INPUT_DIR = process.env.PAGES_INPUT_DIR || 'out';
const POI_DIR = process.env.PAGES_POI_DIR || 'out';
const SITE_DIR = process.env.PAGES_OUTPUT_DIR || '_site';
const SITE_ROOT = path.resolve(ROOT, SITE_DIR);
const QA_DIR = path.resolve(ROOT, 'out', 'qa');
const SERVER_LOG = path.join(QA_DIR, 'pages-maven-server.log');
const FINGERPRINT = path.join(QA_DIR, 'pages-maven-profile.sha256');
const BASE_URL = 'http://127.0.0.1:8000';
const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

function display(command, args) {
  return [command, ...args].map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ');
}

function run(command, args, options = {}) {
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

  const result = spawnSync(command, args, spawnOptions);
  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        `[pages-qa] Command exceeded ${options.timeoutMs} ms and was terminated: ${display(command, args)}`,
        { cause: result.error }
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`[pages-qa] Command failed with exit code ${result.status}: ${display(command, args)}`);
  }
}

function runNode(relativeScript, args = [], options = {}) {
  run(process.execPath, [path.resolve(ROOT, relativeScript), ...args], options);
}

function playwrightCli() {
  const packageEntry = require.resolve('@playwright/test');
  return path.join(path.dirname(packageEntry), 'cli.js');
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
  const skip = /^(1|true)$/i.test(process.env.SKIP_PLAYWRIGHT_INSTALL || '');
  if (skip) {
    process.stdout.write('[pages-qa] Chromium installation skipped by SKIP_PLAYWRIGHT_INSTALL.\n');
    return;
  }

  const installSystemDeps = process.platform === 'linux'
    && /^(1|true)$/i.test(process.env.PLAYWRIGHT_INSTALL_SYSTEM_DEPS || '');
  const args = [playwrightCli(), 'install'];
  if (installSystemDeps) args.push('--with-deps');
  args.push('chromium');

  if (process.platform === 'linux' && !installSystemDeps) {
    process.stdout.write(
      '[pages-qa] Installing pinned Chromium without mutating APT sources. '
        + 'Set PLAYWRIGHT_INSTALL_SYSTEM_DEPS=1 only on a deliberately provisioned Linux host.\n'
    );
  }

  run(process.execPath, args, {
    timeoutMs: PLAYWRIGHT_INSTALL_TIMEOUT_MS,
    env: {
      PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:
        process.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT || '120000',
    },
  });
}

async function runBrowserGate() {
  await withSiteServer(async () => {
    run(process.execPath, [
      playwrightCli(),
      'test',
      'tests/e2e/smoke.spec.js',
      'tests/e2e/pages-critical-path.spec.js',
      '--project=chromium',
    ], {
      env: {
        BASE_URL,
        PLAYWRIGHT_HTML_OPEN: 'never',
      },
    });
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
  run,
};
