#!/usr/bin/env node
/**
 * scripts/check-data-paths.js
 *
 * Build-time validator for per-city accident GeoJSON artefacts.
 *
 * Usage:
 *   node scripts/check-data-paths.js
 *   node scripts/check-data-paths.js --gzip-only --min-features 10
 *   node scripts/check-data-paths.js --dir _site/out --cities-file cities.txt
 *   node scripts/check-data-paths.js --warn
 */

'use strict';

const fs = require('fs');
const path = require('path');

const {
  slugify,
  readCitiesFile,
  validateGeoJsonArtifact,
} = require('./lib/static-data-validation');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    warnOnly: false,
    dir: path.join(ROOT, 'out'),
    citiesFile: path.join(ROOT, 'cities.txt'),
    gzipOnly: false,
    minFeatures: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--warn') args.warnOnly = true;
    else if (arg === '--dir') args.dir = argv[++i] || args.dir;
    else if (arg === '--cities-file') args.citiesFile = argv[++i] || args.citiesFile;
    else if (arg === '--gzip-only') args.gzipOnly = true;
    else if (arg === '--min-features') args.minFeatures = Number.parseInt(argv[++i] || '0', 10);
  }

  if (!Number.isFinite(args.minFeatures) || args.minFeatures < 0) {
    throw new Error('check-data-paths: --min-features must be a non-negative integer');
  }

  args.dir = path.resolve(ROOT, args.dir);
  args.citiesFile = path.resolve(ROOT, args.citiesFile);
  return args;
}

function validateCityArtifact(options) {
  const outDir = options.outDir;
  const repoRoot = options.repoRoot || ROOT;
  const city = options.city;
  const slug = options.slug || slugify(city);
  const gzipOnly = !!options.gzipOnly;
  const minFeatures = Number.isFinite(options.minFeatures) ? options.minFeatures : 0;

  const rawPath = path.join(outDir, `output_all_years_${slug}.geojson`);
  const gzPath = `${rawPath}.gz`;
  const rawExists = fs.existsSync(rawPath);
  const gzExists = fs.existsSync(gzPath);
  const errors = [];

  if (gzipOnly) {
    if (!gzExists) errors.push(`Missing gzip artefact: ${path.relative(repoRoot, gzPath)}`);
    if (rawExists) errors.push(`Raw artefact exists in gzip-only mode: ${path.relative(repoRoot, rawPath)}`);
  } else if (!rawExists && !gzExists) {
    errors.push(`Missing artefact: out/output_all_years_${slug}.geojson[.gz]`);
  }

  if (errors.length > 0) {
    return { ok: false, city, slug, rawExists, gzExists, featureCount: null, errors };
  }

  const validation = validateGeoJsonArtifact(rawPath, { gzipOnly, minFeatures });
  return {
    ok: validation.ok,
    city,
    slug,
    rawExists,
    gzExists,
    featureCount: validation.featureCount,
    errors: validation.errors,
  };
}

function validateDataPaths(options) {
  const repoRoot = options.repoRoot || ROOT;
  const outDir = path.resolve(repoRoot, options.dir || 'out');
  const citiesFile = path.resolve(repoRoot, options.citiesFile || 'cities.txt');
  const gzipOnly = !!options.gzipOnly;
  const minFeatures = Number.isFinite(options.minFeatures) ? options.minFeatures : 0;

  const cities = readCitiesFile(citiesFile);
  const failures = [];

  for (const city of cities) {
    const result = validateCityArtifact({
      repoRoot,
      outDir,
      city,
      gzipOnly,
      minFeatures,
    });
    if (!result.ok) failures.push(result);
  }

  return {
    checkedCities: cities.length,
    failures,
  };
}

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  let result;
  try {
    result = validateDataPaths(args);
  } catch (error) {
    console.error(`check-data-paths: ${error.message}`);
    process.exit(2);
  }

  console.log(`check-data-paths: checked ${result.checkedCities} cities from ${path.relative(ROOT, args.citiesFile)}`);

  if (result.failures.length === 0) {
    console.log('check-data-paths: all expected GeoJSON files are valid ✓');
    process.exit(0);
  }

  console.error(`check-data-paths: ${result.failures.length} invalid city artefact(s):`);
  for (const failure of result.failures) {
    console.error(`  - ${failure.city} (${failure.slug})`);
    for (const error of failure.errors) {
      console.error(`      ${error}`);
    }
  }

  if (args.warnOnly) {
    console.warn('check-data-paths: running in --warn mode; not failing the build.');
    process.exit(0);
  }

  process.exit(1);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseArgs,
  validateCityArtifact,
  validateDataPaths,
  main,
};
