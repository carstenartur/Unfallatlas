'use strict';

jest.mock('node:child_process', () => ({
  spawn: jest.fn(),
  spawnSync: jest.fn(),
}));

const childProcess = require('node:child_process');
const gate = require('../../scripts/run-pages-quality-gate.cjs');

describe('Pages quality-gate browser installation', () => {
  const managedEnvironmentKeys = [
    'SKIP_PLAYWRIGHT_INSTALL',
    'PLAYWRIGHT_INSTALL_SYSTEM_DEPS',
    'PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT',
  ];
  const originalEnvironment = Object.fromEntries(
    managedEnvironmentKeys.map((key) => [key, process.env[key]])
  );

  beforeEach(() => {
    childProcess.spawnSync.mockReset();
    childProcess.spawnSync.mockReturnValue({ status: 0, error: null });
    managedEnvironmentKeys.forEach((key) => delete process.env[key]);
  });

  afterAll(() => {
    for (const key of managedEnvironmentKeys) {
      const value = originalEnvironment[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('installs pinned Chromium without invoking APT by default', () => {
    gate.installChromium();

    expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = childProcess.spawnSync.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args.slice(-2)).toEqual(['install', 'chromium']);
    expect(args).not.toContain('--with-deps');
    expect(options.timeout).toBe(gate.PLAYWRIGHT_INSTALL_TIMEOUT_MS);
    expect(options.killSignal).toBe('SIGTERM');
    expect(options.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT).toBe('120000');
  });

  test('allows system dependency installation only through an explicit opt-in', () => {
    process.env.PLAYWRIGHT_INSTALL_SYSTEM_DEPS = 'true';

    gate.installChromium();

    const args = childProcess.spawnSync.mock.calls[0][1];
    if (process.platform === 'linux') {
      expect(args.slice(-3)).toEqual(['install', '--with-deps', 'chromium']);
    } else {
      expect(args.slice(-2)).toEqual(['install', 'chromium']);
      expect(args).not.toContain('--with-deps');
    }
  });

  test('retains the explicit skip contract for pre-provisioned environments', () => {
    process.env.SKIP_PLAYWRIGHT_INSTALL = '1';

    gate.installChromium();

    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  test('fails closed after the bounded browser-install timeout', () => {
    const timeoutError = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    childProcess.spawnSync.mockReturnValue({ status: null, error: timeoutError });

    expect(() => gate.installChromium()).toThrow(
      `Command exceeded ${gate.PLAYWRIGHT_INSTALL_TIMEOUT_MS} ms`
    );
  });
});
