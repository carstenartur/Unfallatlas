#!/usr/bin/env node
'use strict';

/**
 * Generate one real city context dataset and verify the rendered web page.
 *
 * The command is intentionally usable without GitHub Actions:
 *
 *   npm run test:context-data-e2e
 *
 * It creates an isolated static site under .build/context-e2e/site, runs the
 * canonical OSM -> SRTM slope -> traffic proxy -> enrichment pipeline into
 * that site, starts a plain static HTTP server and executes the non-skipping
 * Playwright browser contract in tests/e2e/context-data-render.spec.js.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD_ROOT = path.resolve(ROOT, process.env.CONTEXT_E2E_BUILD_DIR || '.build/context-e2e');
const SITE_ROOT = path.join(BUILD_ROOT, 'site');
const CACHE_ROOT = path.resolve(ROOT, process.env.CONTEXT_E2E_CACHE_DIR || '.build/context-e2e/cache');
const WORK_ROOT = path.join(BUILD_ROOT, 'work');
const CITY = String(process.env.CONTEXT_E2E_CITY || 'Bonn').trim();

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...(options && options.env) },
      stdio: (options && options.stdio) || 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function copyStaticApplication() {
  fs.rmSync(SITE_ROOT, { recursive: true, force: true });
  fs.mkdirSync(SITE_ROOT, { recursive: true });
  const excludedTopLevel = new Set([
    '.git',
    '.build',
    'node_modules',
    'out',
    'analysis-service',
    'coverage',
    'playwright-report',
    'test-results',
  ]);
  fs.cpSync(ROOT, SITE_ROOT, {
    recursive: true,
    filter(source) {
      const rel = path.relative(ROOT, source);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      return !excludedTopLevel.has(top);
    },
  });
  fs.mkdirSync(path.join(SITE_ROOT, 'out'), { recursive: true });
}

function copyOptionalCityArtifact(logicalName) {
  const sourceRaw = path.join(ROOT, 'out', logicalName);
  const sourceGz = `${sourceRaw}.gz`;
  const targetDir = path.join(SITE_ROOT, 'out');
  if (fs.existsSync(sourceGz)) fs.copyFileSync(sourceGz, path.join(targetDir, `${logicalName}.gz`));
  else if (fs.existsSync(sourceRaw)) fs.copyFileSync(sourceRaw, path.join(targetDir, logicalName));
}

async function choosePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`static server exited with code ${child.exitCode}`);
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) return;
    } catch (_) { /* retry */ }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`static server did not become ready: ${url}`);
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
}

async function main() {
  if (!CITY) throw new Error('CONTEXT_E2E_CITY must not be empty');
  copyStaticApplication();

  console.log(`[context-e2e] Generating real context data for ${CITY}`);
  await run(process.execPath, [
    path.join(ROOT, 'scripts', 'generate-context-city.js'),
    '--city', CITY,
    '--input-dir', path.join(ROOT, 'out'),
    '--output-dir', path.join(SITE_ROOT, 'out'),
    '--cache-dir', CACHE_ROOT,
    '--work-dir', WORK_ROOT,
    '--force',
  ]);

  // POIs are not part of the context contract but copying them when available
  // keeps the browser console quiet and makes the test site closer to production.
  const slug = CITY.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  copyOptionalCityArtifact(`poi_${slug}.geojson`);

  const port = await choosePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`[context-e2e] Serving isolated site at ${baseUrl}`);
  const server = spawn('python3', [
    '-m', 'http.server', String(port),
    '--bind', '127.0.0.1',
    '--directory', SITE_ROOT,
  ], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  server.stdout.on('data', chunk => process.stdout.write(`[context-e2e:http] ${chunk}`));
  server.stderr.on('data', chunk => process.stderr.write(`[context-e2e:http] ${chunk}`));

  const cleanup = () => stopChild(server);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
  try {
    await waitForServer(`${baseUrl}/werkbank_v2.html`, server);
    const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    await run(npx, [
      'playwright', 'test',
      'tests/e2e/context-data-render.spec.js',
      '--project=context-data-e2e',
    ], {
      env: {
        BASE_URL: baseUrl,
        CONTEXT_E2E_CITY: CITY,
      },
    });
  } finally {
    cleanup();
  }

  console.log(`[context-e2e] PASS: ${CITY} generated and rendered slope + traffic context.`);
}

main().catch(error => {
  console.error('[context-e2e] FAILED:', error && error.stack ? error.stack : error);
  process.exit(1);
});
