#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const {
  readCitiesFile,
  slugify,
  validateGeoJsonArtifact,
} = require('./lib/static-data-validation');

function parseArgs(argv) {
  const args = {
    dir: 'out',
    gzipOnly: false,
    requireCities: [],
    requireCitiesFile: null,
    minFeatures: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i] || args.dir;
    else if (a === '--gzip-only') args.gzipOnly = true;
    else if (a === '--require-city') args.requireCities.push(String(argv[++i] || '').toLowerCase());
    else if (a === '--require-cities-file') args.requireCitiesFile = argv[++i] || null;
    else if (a === '--min-features') args.minFeatures = Number.parseInt(argv[++i] || '0', 10);
  }

  if (!Number.isFinite(args.minFeatures) || args.minFeatures < 0) {
    throw new Error('[validate-static-data] --min-features must be a non-negative integer');
  }

  return args;
}

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

function validateStaticData(args, options) {
  const opts = options || {};
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..');
  const dir = path.resolve(repoRoot, args.dir);
  const artifactRoot = path.dirname(dir);
  const manifestPath = path.join(dir, 'data-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`[validate-static-data] Missing manifest: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.dataMode !== 'gzip-only') {
    throw new Error('[validate-static-data] data-manifest.json must declare dataMode="gzip-only"');
  }

  const cities = manifest.cities || {};
  const requiredCities = new Set(args.requireCities.map((city) => slugify(city)));
  if (args.requireCitiesFile) {
    for (const city of readCitiesFile(path.resolve(repoRoot, args.requireCitiesFile))) {
      requiredCities.add(slugify(city));
    }
  }

  for (const city of requiredCities) {
    const entry = cities[city];
    if (!entry || !entry.accidents || !entry.accidents.gzipPath) {
      throw new Error(`[validate-static-data] Missing accidents gzip entry for required city: ${city}`);
    }

    const abs = path.join(artifactRoot, entry.accidents.gzipPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`[validate-static-data] Missing required accidents gzip file: ${entry.accidents.gzipPath}`);
    }

    if (args.gzipOnly) {
      const rawAbs = abs.replace(/\.gz$/i, '');
      if (fs.existsSync(rawAbs)) {
        throw new Error(`[validate-static-data] Raw file exists in gzip-only mode: ${path.relative(repoRoot, rawAbs)}`);
      }
    }

    const validation = validateGeoJsonArtifact(abs.replace(/\.gz$/i, ''), {
      gzipOnly: args.gzipOnly,
      minFeatures: args.minFeatures,
    });
    if (!validation.ok) {
      throw new Error(`[validate-static-data] Invalid accidents artefact for ${city}: ${validation.errors.join('; ')}`);
    }
  }

  return { manifest, cityCount: Object.keys(cities).length };
}

function main(argv) {
  try {
    const args = parseArgs(argv);
    const result = validateStaticData(args);
    process.stdout.write(`[validate-static-data] OK (${result.cityCount} city entries)\n`);
  } catch (error) {
    fail(error.message);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { parseArgs, validateStaticData, main };
