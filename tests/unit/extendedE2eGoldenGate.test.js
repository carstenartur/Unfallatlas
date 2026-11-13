/** @jest-environment node */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '../..');
const runner = path.join(root, 'scripts/run-extended-e2e.js');
const golden = path.join(root, 'scripts/qa-bonn-hbf-ai-golden.js');
const realRequire = createRequire(runner);

function execute(goldenStatus = 0) {
  const spawnSync = jest.fn((_node, args) => ({ status: args[0] === golden ? goldenStatus : 0 }));
  const requireStub = name => name === 'child_process' ? { spawnSync } : realRequire(name);
  requireStub.resolve = realRequire.resolve;
  const exit = jest.fn(status => { throw Object.assign(new Error('runner exit'), { exitStatus: status }); });
  let failure;
  try {
    vm.runInNewContext(fs.readFileSync(runner, 'utf8'), {
      require: requireStub, __dirname: path.dirname(runner),
      process: { execPath: process.execPath, cwd: () => root, env: { CI: '1', TEST_MARKER: 'same-environment' }, exit }
    }, { filename: runner });
  } catch (error) {
    failure = error;
  }
  return { spawnSync, exit, failure };
}

test('checks the Bonn Golden and replays the model responses before all browser suites', () => {
  const result = execute();
  expect(result.failure).toBeUndefined();
  expect(result.spawnSync.mock.calls.map(call => call[1])).toEqual([
    [golden, '--skip-build', '--replay-model'],
    [realRequire.resolve('@playwright/test/cli'), 'test', '--project=chromium'],
    [realRequire.resolve('@playwright/test/cli'), 'test', '--project=firefox-smoke'],
    [realRequire.resolve('@playwright/test/cli'), 'test', '--project=webkit-smoke']
  ]);
  expect(result.spawnSync.mock.calls.every(call => call[0] === process.execPath)).toBe(true);
  expect(result.spawnSync.mock.calls[0][2]).toEqual({
    cwd: root, stdio: 'inherit',
    env: { CI: '1', TEST_MARKER: 'same-environment', PLAYWRIGHT_SERVE_EXISTING_SITE: '1' }
  });
});

test('a failing Bonn check stops the browser suites and preserves its exit status', () => {
  const result = execute(31);
  expect(result.spawnSync).toHaveBeenCalledTimes(1);
  expect(result.spawnSync.mock.calls[0][1]).toEqual([golden, '--skip-build', '--replay-model']);
  expect(result.exit).toHaveBeenCalledWith(31);
  expect(result.failure?.exitStatus).toBe(31);
});
