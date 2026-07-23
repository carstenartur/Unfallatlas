'use strict';

const fs = require('fs');
const path = require('path');
const contract = require('../../scripts/documentation-deeplink-contract.cjs');
const runner = require('../../scripts/run-live-documentation-links.cjs');

function withCleanExitCode(callback) {
  const previous = process.exitCode;
  process.exitCode = undefined;
  try {
    return callback();
  } finally {
    process.exitCode = previous;
  }
}

describe('published documentation deep-link runner', () => {
  test('runs only the dedicated live project and persists the resolved contract', () => {
    const calls = [];
    const status = runner.run({
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: 'five scenarios passed\n', stderr: '' };
      },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual(expect.arrayContaining([
      'test',
      'tests/e2e/documentation-deeplinks.live.spec.js',
      '--project=documentation-deeplinks-live',
    ]));
    const expectedBase = new URL('.', `${contract.LIVE_ORIGIN}${contract.LIVE_PATH}`)
      .href.replace(/\/$/, '');
    expect(runner.LIVE_BASE_URL).toBe(expectedBase);
    expect(calls[0].options.env.BASE_URL).toBe(expectedBase);
    expect(calls[0].options.cwd).toBe(runner.ROOT);
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);

    const resolved = JSON.parse(fs.readFileSync(
      path.join(runner.OUTPUT, 'resolved-contract.json'),
      'utf8',
    ));
    expect(resolved.liveBaseUrl).toBe(expectedBase);
    expect(resolved.scenarios).toHaveLength(Object.keys(contract.SCENARIOS).length);
    expect(fs.readFileSync(path.join(runner.OUTPUT, 'command.log'), 'utf8'))
      .toContain('five scenarios passed');
    expect(JSON.parse(fs.readFileSync(path.join(runner.OUTPUT, 'command-result.json'), 'utf8')))
      .toMatchObject({ status: 0, signal: null });
  });

  test('propagates a non-zero Playwright result and records it', () => {
    withCleanExitCode(() => {
      expect(runner.run({
        spawnSync: () => ({ status: 7, stdout: '', stderr: 'failed\n' }),
      })).toBe(7);
      expect(process.exitCode).toBe(7);
      expect(JSON.parse(fs.readFileSync(path.join(runner.OUTPUT, 'command-result.json'), 'utf8')))
        .toMatchObject({ status: 7 });
    });
  });

  test('maps a signal-terminated child with null status to deterministic failure code 1', () => {
    withCleanExitCode(() => {
      expect(runner.run({
        spawnSync: () => ({ status: null, signal: 'SIGTERM', stdout: '', stderr: '' }),
      })).toBe(1);
      expect(process.exitCode).toBe(1);
      expect(JSON.parse(fs.readFileSync(path.join(runner.OUTPUT, 'command-result.json'), 'utf8')))
        .toMatchObject({ status: 1, signal: 'SIGTERM' });
    });
  });
});
