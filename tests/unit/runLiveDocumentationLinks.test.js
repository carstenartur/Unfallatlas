'use strict';

const runner = require('../../scripts/run-live-documentation-links.cjs');

describe('published documentation deep-link runner', () => {
  test('runs only the dedicated live project with the published base URL', () => {
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
    expect(calls[0].options.env.BASE_URL).toBe(runner.LIVE_BASE_URL);
    expect(calls[0].options.cwd).toBe(runner.ROOT);
  });

  test('propagates a non-zero Playwright result without converting it to success', () => {
    const previous = process.exitCode;
    process.exitCode = undefined;
    try {
      expect(runner.run({ spawnSync: () => ({ status: 7 }) })).toBe(7);
      expect(process.exitCode).toBe(7);
    } finally {
      process.exitCode = previous;
    }
  });
});
