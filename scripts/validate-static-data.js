#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = {
    dir: 'out',
    gzipOnly: false,
    requireCities: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] || args.dir;
    else if (a === '--gzip-only') args.gzipOnly = true;
    else if (a === '--require-city') args.requireCities.push(String(argv[++i] || '').toLowerCase());
  }

  return args;
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function main(argv) {
  const args = parseArgs(argv);
  const repoRoot = path.resolve(__dirname, '..');
  const dir = path.resolve(repoRoot, args.dir);
  const artifactRoot = path.dirname(dir);

  const manifestPath = path.join(dir, 'data-manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`[validate-static-data] Missing manifest: ${manifestPath}`);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.dataMode !== 'gzip-only') fail('[validate-static-data] data-manifest.json must declare dataMode="gzip-only"');

  const cities = manifest.cities || {};
  for (const city of args.requireCities) {
    const entry = cities[city];
    if (!entry || !entry.accidents || !entry.accidents.gzipPath) {
      fail(`[validate-static-data] Missing accidents gzip entry for required city: ${city}`);
    }

    const abs = path.join(artifactRoot, entry.accidents.gzipPath);
    if (!fs.existsSync(abs)) fail(`[validate-static-data] Missing required accidents gzip file: ${entry.accidents.gzipPath}`);

    if (args.gzipOnly) {
      const rawAbs = abs.replace(/\.gz$/i, '');
      if (fs.existsSync(rawAbs)) {
        fail(`[validate-static-data] Raw file exists in gzip-only mode: ${path.relative(repoRoot, rawAbs)}`);
      }
    }
  }

  process.stdout.write(`[validate-static-data] OK (${Object.keys(cities).length} city entries)\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { parseArgs, main };
