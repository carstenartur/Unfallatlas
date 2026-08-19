'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PLAYWRIGHT_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DOWNLOAD_CONNECTION_TIMEOUT_MS = '120000';
const SUPPORTED_BROWSERS = new Set(['chromium', 'firefox', 'webkit']);

function cleanBrowsers(values) {
  const browsers = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
  if (!browsers.length) return ['chromium'];

  const unsupported = browsers.filter((browser) => !SUPPORTED_BROWSERS.has(browser));
  if (unsupported.length) {
    throw new Error(`Unsupported Playwright browser(s): ${unsupported.join(', ')}`);
  }
  return browsers;
}

function playwrightCli() {
  const packageEntry = require.resolve('@playwright/test');
  return path.join(path.dirname(packageEntry), 'cli.js');
}

function display(command, args) {
  return [command, ...args]
    .map((value) => /\s/.test(value) ? JSON.stringify(value) : value)
    .join(' ');
}

function installBrowsers(requestedBrowsers = ['chromium']) {
  const browsers = cleanBrowsers(requestedBrowsers);
  if (/^(1|true)$/i.test(process.env.SKIP_PLAYWRIGHT_INSTALL || '')) {
    process.stdout.write(
      `[playwright-install] Skipped ${browsers.join(', ')} by SKIP_PLAYWRIGHT_INSTALL.\n`
    );
    return { skipped: true, browsers, withSystemDependencies: false };
  }

  const withSystemDependencies = process.platform === 'linux'
    && /^(1|true)$/i.test(process.env.PLAYWRIGHT_INSTALL_SYSTEM_DEPS || '');
  const args = [playwrightCli(), 'install'];
  if (withSystemDependencies) args.push('--with-deps');
  args.push(...browsers);

  if (process.platform === 'linux' && !withSystemDependencies) {
    process.stdout.write(
      '[playwright-install] Installing pinned browsers without mutating APT sources. '
        + 'Set PLAYWRIGHT_INSTALL_SYSTEM_DEPS=1 only on a deliberately provisioned Linux host.\n'
    );
  }
  process.stdout.write(`[playwright-install] $ ${display(process.execPath, args)}\n`);

  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    timeout: PLAYWRIGHT_INSTALL_TIMEOUT_MS,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT:
        process.env.PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT
        || DEFAULT_DOWNLOAD_CONNECTION_TIMEOUT_MS,
    },
  });

  if (result.error) {
    if (result.error.code === 'ETIMEDOUT') {
      throw new Error(
        `[playwright-install] Browser installation exceeded ${PLAYWRIGHT_INSTALL_TIMEOUT_MS} ms and was terminated.`,
        { cause: result.error }
      );
    }
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `[playwright-install] Browser installation failed with exit code ${result.status}: `
        + display(process.execPath, args)
    );
  }

  return { skipped: false, browsers, withSystemDependencies };
}

if (require.main === module) {
  try {
    installBrowsers(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_DOWNLOAD_CONNECTION_TIMEOUT_MS,
  PLAYWRIGHT_INSTALL_TIMEOUT_MS,
  cleanBrowsers,
  installBrowsers,
  playwrightCli,
};
