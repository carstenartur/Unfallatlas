'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { LIVE_ORIGIN, LIVE_PATH } = require('./documentation-deeplink-contract.cjs');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'out', 'qa', 'documentation-live-links');
const LIVE_BASE_URL = new URL('.', `${LIVE_ORIGIN}${LIVE_PATH}`).href.replace(/\/$/, '');

function run(options = {}) {
  const spawn = options.spawnSync || spawnSync;
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
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
    stdio: 'inherit',
    env: {
      ...process.env,
      // Disables Playwright's local webServer and documents the intended live target.
      BASE_URL: LIVE_BASE_URL,
    },
  });
  if (result.error) throw result.error;
  const status = result.status == null ? 1 : result.status;
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
