#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const { buildSite } = require('./build-site');
const { applyPublicPagesProfile } = require('./build-public-pages-profile');
const { assertPrebuiltSite, startServer } = require('./serve-site');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SITE = '_site';
const TEST_FILES = Object.freeze([
  'tests/e2e/smoke.spec.js',
  'tests/e2e/pages-critical-path.spec.js',
]);

function parseArgs(argv) {
  const options = { existingSite: false, site: DEFAULT_SITE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--existing-site') options.existingSite = true;
    else if (arg === '--site') options.site = argv[++index] || options.site;
    else throw new Error(`[pages-smoke] Unknown argument: ${arg}`);
  }
  return options;
}

function resolveInsideRoot(relativePath) {
  const absolute = path.resolve(ROOT, relativePath);
  const relative = path.relative(ROOT, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[pages-smoke] Refusing path outside repository: ${absolute}`);
  }
  return absolute;
}

function writeServerLog(message) {
  const configured = process.env.PAGES_SMOKE_SERVER_LOG;
  if (!configured) return;
  const target = resolveInsideRoot(configured);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${message}\n`);
}

function playwrightCli() {
  const packageEntry = require.resolve('@playwright/test');
  return path.join(path.dirname(packageEntry), 'cli.js');
}

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`[pages-smoke] Playwright terminated by ${signal}`));
        return;
      }
      resolve(code == null ? 1 : code);
    });
  });
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function prepareLocalSite(options) {
  const siteRoot = resolveInsideRoot(options.site);
  if (options.existingSite) {
    assertPrebuiltSite(siteRoot);
    return;
  }

  if (options.site !== DEFAULT_SITE) {
    throw new Error('[pages-smoke] Building is only supported for the canonical _site directory');
  }
  buildSite({ root: ROOT, outputDir: DEFAULT_SITE, inputDir: 'out', poiDir: 'out' });
  applyPublicPagesProfile({ root: ROOT, site: DEFAULT_SITE });
}

async function run(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const externalBaseUrl = String(process.env.BASE_URL || '').trim();
  let server = null;
  let baseUrl = externalBaseUrl;

  try {
    if (baseUrl) {
      writeServerLog(`[pages-smoke] External target: ${baseUrl}`);
    } else {
      await prepareLocalSite(options);
      server = startServer({ build: false, site: options.site });
      await waitForListening(server);
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('[pages-smoke] Static server did not expose a TCP address');
      }
      const host = address.address === '::' ? '127.0.0.1' : address.address;
      baseUrl = `http://${host}:${address.port}`;
      writeServerLog(`[pages-smoke] Local target: ${baseUrl} -> ${options.site}`);
    }

    const args = [
      playwrightCli(),
      'test',
      ...TEST_FILES,
      '--project=chromium',
    ];
    return await runNode(args, {
      ...process.env,
      BASE_URL: baseUrl,
      PLAYWRIGHT_HTML_OPEN: process.env.PLAYWRIGHT_HTML_OPEN || 'never',
    });
  } finally {
    await closeServer(server);
  }
}

if (require.main === module) {
  run()
    .then((status) => { process.exitCode = status; })
    .catch((error) => {
      process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    });
}

module.exports = Object.freeze({
  DEFAULT_SITE,
  TEST_FILES,
  closeServer,
  parseArgs,
  prepareLocalSite,
  run,
  writeServerLog,
});
