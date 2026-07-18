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
 * that site, validates every generated gzip tile on disk and through the
 * static HTTP server, and finally executes the non-skipping Playwright browser
 * contract in tests/e2e/context-data-render.spec.js.
 */

const fs = require('fs');
const net = require('net');
const path = require('path');
const zlib = require('zlib');
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

  // Copy top-level entries individually. Node correctly rejects `cpSync(ROOT,
  // ROOT/.build/...)` as copying a directory into its own descendant before a
  // filter callback can exclude `.build`.
  for (const entry of fs.readdirSync(ROOT, { withFileTypes: true })) {
    if (excludedTopLevel.has(entry.name)) continue;
    const source = path.join(ROOT, entry.name);
    const destination = path.join(SITE_ROOT, entry.name);
    if (entry.isDirectory()) fs.cpSync(source, destination, { recursive: true });
    else if (entry.isFile()) fs.copyFileSync(source, destination);
  }
  fs.mkdirSync(path.join(SITE_ROOT, 'out'), { recursive: true });
}

function copyOptionalCityArtifact(logicalName) {
  const sourceRaw = path.join(ROOT, 'out', logicalName);
  const sourceGz = `${sourceRaw}.gz`;
  const targetDir = path.join(SITE_ROOT, 'out');
  if (fs.existsSync(sourceGz)) fs.copyFileSync(sourceGz, path.join(targetDir, `${logicalName}.gz`));
  else if (fs.existsSync(sourceRaw)) fs.copyFileSync(sourceRaw, path.join(targetDir, logicalName));
}

function readGzipJson(file) {
  const compressed = fs.readFileSync(file);
  return JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
}

function validateGeneratedContextTiles(slug) {
  const tileRoot = path.join(SITE_ROOT, 'out', 'ctxtiles', slug);
  const indexFile = path.join(tileRoot, 'index.json.gz');
  if (!fs.existsSync(indexFile)) throw new Error(`Generated tile index missing: ${indexFile}`);
  const manifest = readGzipJson(indexFile);
  if (!manifest || !Array.isArray(manifest.tiles) || manifest.tiles.length === 0) {
    throw new Error(`Generated tile index is empty or invalid: ${indexFile}`);
  }
  let ways = 0;
  const files = [];
  for (const tile of manifest.tiles) {
    const x = Number(tile && tile.x);
    const y = Number(tile && tile.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      throw new Error(`Invalid tile coordinate in manifest: ${JSON.stringify(tile)}`);
    }
    const file = path.join(tileRoot, String(x), `${y}.json.gz`);
    if (!fs.existsSync(file)) throw new Error(`Manifest references missing gzip tile: ${file}`);
    const payload = readGzipJson(file);
    const count = payload && payload.ways && typeof payload.ways === 'object'
      ? Object.keys(payload.ways).length
      : 0;
    if (count === 0) throw new Error(`Generated gzip tile contains no ways: ${file}`);
    ways += count;
    files.push({ x, y, file, count });
  }
  console.log(`[context-e2e] Disk validation: ${files.length} gzip tiles, ${ways} tile-way entries`);
  return { manifest, files, ways };
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

async function validateContextTilesOverHttp(baseUrl, slug, tileData) {
  let ways = 0;
  for (const tile of tileData.files) {
    const url = `${baseUrl}/out/ctxtiles/${encodeURIComponent(slug)}/${tile.x}/${tile.y}.json.gz`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Static HTTP server returned ${response.status} for ${url}`);
    const compressed = Buffer.from(await response.arrayBuffer());
    let payload;
    try {
      payload = JSON.parse(zlib.gunzipSync(compressed).toString('utf8'));
    } catch (error) {
      throw new Error(`Static HTTP gzip tile cannot be decompressed/parsed (${url}): ${error.message}`);
    }
    const count = payload && payload.ways && typeof payload.ways === 'object'
      ? Object.keys(payload.ways).length
      : 0;
    if (count === 0) throw new Error(`Static HTTP gzip tile contains no ways: ${url}`);
    ways += count;
  }
  console.log(`[context-e2e] HTTP validation: ${tileData.files.length} gzip tiles, ${ways} tile-way entries`);
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
  const tileData = validateGeneratedContextTiles(slug);

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
    await validateContextTilesOverHttp(baseUrl, slug, tileData);
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

module.exports = {
  readGzipJson,
  validateGeneratedContextTiles,
  validateContextTilesOverHttp,
};
