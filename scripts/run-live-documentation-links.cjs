'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  LIVE_ORIGIN,
  LIVE_PATH,
  validateDocumentationLinks,
} = require('./documentation-deeplink-contract.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'documentation-live-links');
const LIVE_BASE_URL = new URL('.', `${LIVE_ORIGIN}${LIVE_PATH}`).href.replace(/\/$/, '');

function writeJson(filename, value) {
  fs.writeFileSync(path.join(OUTPUT, filename), `${JSON.stringify(value, null, 2)}\n`);
}

function run(options = {}) {
  const spawn = options.spawnSync || spawnSync;
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT, { recursive: true });

  let contract;
  try {
    contract = validateDocumentationLinks(ROOT);
    writeJson('resolved-contract.json', {
      liveBaseUrl: LIVE_BASE_URL,
      scenarios: contract.liveScenarios.map((scenario) => ({
        id: scenario.id,
        imagePath: scenario.imagePath,
        description: scenario.description,
        url: scenario.url,
        expected: scenario.expected,
        references: scenario.references,
      })),
    });
  } catch (error) {
    writeJson('contract-error.json', {
      name: error?.name || 'Error',
      code: error?.code || null,
      message: error?.message || String(error),
      stack: error?.stack || null,
      details: error?.details || null,
    });
    throw error;
  }

  const packageEntry = require.resolve('@playwright/test');
  const cli = path.join(path.dirname(packageEntry), 'cli.js');
  const args = [
    cli,
    'test',
    'tests/e2e/documentation-deeplinks.live.spec.js',
    '--project=documentation-deeplinks-live',
  ];
  const result = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      BASE_URL: LIVE_BASE_URL,
    },
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  fs.writeFileSync(
    path.join(OUTPUT, 'command.log'),
    [
      `$ ${process.execPath} ${args.join(' ')}`,
      '',
      '--- stdout ---',
      stdout,
      '--- stderr ---',
      stderr,
      '',
      `signal=${result.signal || ''}`,
      `status=${result.status == null ? '' : result.status}`,
    ].join('\n'),
  );

  if (result.error) {
    writeJson('spawn-error.json', {
      name: result.error.name || 'Error',
      message: result.error.message || String(result.error),
      stack: result.error.stack || null,
    });
    throw result.error;
  }
  const status = result.status == null ? 1 : result.status;
  writeJson('command-result.json', {
    status,
    signal: result.signal || null,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
  });
  if (status !== 0) process.exitCode = status;
  return status;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = Object.freeze({ ROOT, OUTPUT, LIVE_BASE_URL, run });
