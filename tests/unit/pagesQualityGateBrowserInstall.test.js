'use strict';

const fs = require('node:fs');
const path = require('node:path');

jest.mock('node:child_process', () => ({
  spawnSync: jest.fn(),
}));

const childProcess = require('node:child_process');
const installer = require('../../scripts/install-playwright-browsers.cjs');

const ROOT = path.resolve(__dirname, '../..');

describe('Shared Playwright browser installation contract', () => {
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
    const result = installer.installBrowsers(['chromium']);

    expect(result).toMatchObject({
      skipped: false,
      browsers: ['chromium'],
      withSystemDependencies: false,
    });
    expect(childProcess.spawnSync).toHaveBeenCalledTimes(1);
    const [command, args, options] = childProcess.spawnSync.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args.slice(-2)).toEqual(['install', 'chromium']);
    expect(args).not.toContain('--with-deps');
    expect(options.timeout).toBe(installer.PLAYWRIGHT_INSTALL_TIMEOUT_MS);
    expect(options.killSignal).toBe('SIGTERM');
    expect(options.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT)
      .toBe(installer.DEFAULT_DOWNLOAD_CONNECTION_TIMEOUT_MS);
  });

  test('installs the complete extended browser matrix through the same bounded path', () => {
    installer.installBrowsers(['chromium', 'firefox', 'webkit', 'chromium']);

    const args = childProcess.spawnSync.mock.calls[0][1];
    expect(args.slice(-4)).toEqual(['install', 'chromium', 'firefox', 'webkit']);
    expect(args).not.toContain('--with-deps');
  });

  test('allows system dependency installation only through an explicit opt-in', () => {
    process.env.PLAYWRIGHT_INSTALL_SYSTEM_DEPS = 'true';

    installer.installBrowsers(['chromium']);

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

    const result = installer.installBrowsers(['chromium', 'firefox']);

    expect(result).toMatchObject({
      skipped: true,
      browsers: ['chromium', 'firefox'],
    });
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  test('fails closed after the bounded browser-install timeout', () => {
    const timeoutError = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    childProcess.spawnSync.mockReturnValue({ status: null, error: timeoutError });

    expect(() => installer.installBrowsers(['chromium'])).toThrow(
      `Browser installation exceeded ${installer.PLAYWRIGHT_INSTALL_TIMEOUT_MS} ms`
    );
  });

  test('rejects unrecognised browser names before starting a process', () => {
    expect(() => installer.installBrowsers(['chromium', 'unknown-browser']))
      .toThrow(/Unsupported Playwright browser/);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  test('Pages and extended E2E use the shared installer without implicit system dependencies', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const pagesGate = fs.readFileSync(
      path.join(ROOT, 'scripts/run-pages-quality-gate.cjs'),
      'utf8'
    );

    expect(packageJson.scripts['qa:e2e:prepare'])
      .toContain('node scripts/install-playwright-browsers.cjs chromium firefox webkit');
    expect(packageJson.scripts['qa:e2e:prepare']).not.toContain('--with-deps');
    expect(pagesGate).toContain("installBrowsers(['chromium'])");
    expect(pagesGate).not.toContain("args.push('--with-deps')");
  });
});
