#!/usr/bin/env node
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');

const { buildSite } = require('./build-site');
const { resolveLexicalPath, resolveStaticFile } = require('../server/lib/safeStaticPath');

const ROOT = path.resolve(__dirname, '..');
const SITE_ROOT = path.join(ROOT, '_site');
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

function resolveRequestPath(urlPath, siteRoot = SITE_ROOT) {
  return resolveLexicalPath(siteRoot, urlPath);
}

function startServer() {
  buildSite({ root: ROOT, outputDir: '_site', inputDir: 'out', poiDir: 'out' });

  const server = http.createServer((request, response) => {
    const file = resolveStaticFile(SITE_ROOT, request.url, { index: 'index.html' });
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
    process.stdout.write(`[serve-site] http://${HOST}:${PORT} -> ${SITE_ROOT}\n`);
  });
  return server;
}

if (require.main === module) startServer();

module.exports = { resolveRequestPath, resolveStaticFile, startServer };
