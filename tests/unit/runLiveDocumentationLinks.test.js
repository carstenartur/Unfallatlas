'use strict';

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
  test('runs only the dedicated live project with the canonical published base URL', () => {
    const calls = [];
    const status = runner.run({
      spawnSync(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0 };
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
  });

  test('propagates a non-zero Playwright result without converting it to success', () => {
    withCleanExitCode(() => {
      expect(runner.run({ spawnSync: () => ({ status: 7 }) })).toBe(7);
      expect(process.exitCode).toBe(7);
    });
  });

  test('maps a signal-terminated child with null status to deterministic failure code 1', () => {
    withCleanExitCode(() => {
      expect(runner.run({ spawnSync: () => ({ status: null, signal: 'SIGTERM' }) })).toBe(1);
      expect(process.exitCode).toBe(1);
    });
  });
});
