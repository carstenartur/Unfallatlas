'use strict';

const { spawnSync } = require('child_process');

const playwrightCli = require.resolve('@playwright/test/cli');
const environment = {
  ...process.env,
  PLAYWRIGHT_SERVE_EXISTING_SITE: '1',
};

const suites = [
  ['test', '--project=chromium'],
  ['test', '--project=firefox-smoke'],
  ['test', '--project=webkit-smoke'],
];

for (const args of suites) {
  const result = spawnSync(process.execPath, [playwrightCli, ...args], {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
