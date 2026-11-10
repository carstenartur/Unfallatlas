'use strict';

const { spawnSync } = require('child_process');

const playwrightCli = require.resolve('@playwright/test/cli');
const environment = {
  ...process.env,
  PLAYWRIGHT_SERVE_EXISTING_SITE: '1',
};

const stages = [
  [require.resolve('./qa-bonn-hbf-ai-golden'), '--skip-build'],
  [playwrightCli, 'test', '--project=chromium'],
  [playwrightCli, 'test', '--project=firefox-smoke'],
  [playwrightCli, 'test', '--project=webkit-smoke'],
];

for (const args of stages) {
  const result = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
