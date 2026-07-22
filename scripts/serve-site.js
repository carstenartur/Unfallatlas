#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const { buildSite } = require('./build-site');
const { resolveLexicalPath, resolveStaticFile } = require('../server/lib/safeStaticPath');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SITE_ROOT = path.join(ROOT, '_site');
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';

const CONTENT_TYPES = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webp': 'image/webp',
  '.gz': 'application/gzip',
});

function parseArgs(argv) {
  const args = { build: true, site: '_site' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--no-build') args.build = false;
    else if (arg === '--site') args.site = argv[++index] || args.site;
    else throw new Error(`[serve-site] Unknown argument: ${arg}`);
  }
  return args;
}

function resolveSiteRoot(value = '_site') {
  const siteRoot = path.resolve(ROOT, value);
  const relative = path.relative(ROOT, siteRoot);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[serve-site] Refusing site directory outside the repository: ${siteRoot}`);
  }
  return siteRoot;
}

function assertPrebuiltSite(siteRoot) {
  if (!fs.existsSync(siteRoot) || !fs.statSync(siteRoot).isDirectory()) {
    throw new Error(`[serve-site] Prebuilt site directory does not exist: ${siteRoot}`);
  }
  for (const required of ['build-manifest.json', 'werkbank_v2.html']) {
    const file = path.join(siteRoot, required);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`[serve-site] Prebuilt site is incomplete; missing ${required}`);
    }
  }
}

function resolveRequestPath(urlPath, siteRoot = DEFAULT_SITE_ROOT) {
  return resolveLexicalPath(siteRoot, urlPath);
}

function startServer(options = {}) {
  const siteRoot = resolveSiteRoot(options.site || '_site');
  const shouldBuild = options.build !== false;
  if (shouldBuild) {
    if (siteRoot !== DEFAULT_SITE_ROOT) {
      throw new Error('[serve-site] Rebuilding is only supported for the canonical _site directory');
    }
    buildSite({ root: ROOT, outputDir: '_site', inputDir: 'out', poiDir: 'out' });
  } else {
    assertPrebuiltSite(siteRoot);
  }

  const server = http.createServer((request, response) => {
    const file = resolveStaticFile(siteRoot, request.url, { index: 'index.html' });
    if (!file) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
    if (request.method === 'HEAD') response.end();
    else fs.createReadStream(file).pipe(response);
  });
  server.listen(PORT, HOST, () => {
    const mode = shouldBuild ? 'rebuilt' : 'prebuilt';
    process.stdout.write(`[serve-site] ${mode} http://${HOST}:${PORT} -> ${siteRoot}\n`);
  });
  return server;
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  startServer(args);
}

module.exports = {
  assertPrebuiltSite,
  parseArgs,
  resolveRequestPath,
  resolveSiteRoot,
  resolveStaticFile,
  startServer,
};
