#!/usr/bin/env node
'use strict';

/**
 * Strict preflight for the producer datasets consumed by enrich_geojson.js.
 *
 * The enricher removes old context fields before applying providers. Running it
 * with a missing or partial cache can therefore destroy valid slope/traffic
 * data. Production workflows must run this check immediately before enriching.
 */

const fs = require('fs');
const path = require('path');

const { readJsonMaybeGz } = require('./lib/read-json-maybe-gz');
const { readCitiesFile, slugify } = require('./lib/static-data-validation');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    root: REPO_ROOT,
    citiesFile: null,
    cities: [],
    osmDir: null,
    demDir: null,
    trafficDir: null,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = path.resolve(argv[++i] || args.root);
    else if (arg === '--cities-file') args.citiesFile = argv[++i] || null;
    else if (arg === '--city') args.cities.push(argv[++i]);
    else if (arg === '--osm-dir') args.osmDir = argv[++i] || null;
    else if (arg === '--dem-dir') args.demDir = argv[++i] || null;
    else if (arg === '--traffic-dir') args.trafficDir = argv[++i] || null;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg && arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
  }

  args.citiesFile = path.resolve(args.citiesFile || path.join(args.root, 'cities.txt'));
  args.osmDir = path.resolve(args.osmDir || process.env.ENRICH_OSM_DATA_DIR || path.join(args.root, '.enrichment-cache/osm'));
  args.demDir = path.resolve(args.demDir || process.env.ENRICH_DEM_DATA_DIR || path.join(args.root, '.enrichment-cache/dem'));
  args.trafficDir = path.resolve(args.trafficDir || process.env.ENRICH_TRAFFIC_DATA_DIR || path.join(args.root, '.enrichment-cache/traffic'));
  return args;
}

function readDataset(file) {
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.gz`)) {
    return { value: null, error: 'missing' };
  }
  try {
    return { value: readJsonMaybeGz(file), error: null };
  } catch (error) {
    return { value: null, error: `unreadable: ${error.message}` };
  }
}

function validateOsm(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['not an object'];
  if (data.coverage !== 'full') errors.push(`coverage=${JSON.stringify(data.coverage)}, expected "full"`);
  if (!data.ways || typeof data.ways !== 'object' || Object.keys(data.ways).length === 0) errors.push('ways is missing or empty');
  if (!data.wayGeometries || typeof data.wayGeometries !== 'object' || Object.keys(data.wayGeometries).length === 0) errors.push('wayGeometries is missing or empty');
  if (!Array.isArray(data.index)) errors.push('index is not an array');
  if (!data.producerVersion) errors.push('producerVersion is missing');
  return errors;
}

function validateDem(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['not an object'];
  if (!Array.isArray(data.points) || data.points.length === 0) errors.push('points is missing or empty');
  if (!data.wayElevations || typeof data.wayElevations !== 'object' || Object.keys(data.wayElevations).length === 0) errors.push('wayElevations is missing or empty');
  if (!data.producerVersion) errors.push('producerVersion is missing');
  return errors;
}

function validateTraffic(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['not an object'];
  if (!data.ways || typeof data.ways !== 'object' || Object.keys(data.ways).length === 0) errors.push('ways is missing or empty');
  if (!data.source) errors.push('source is missing');
  if (!data.datasetVersion && !data.producerVersion) errors.push('datasetVersion/producerVersion is missing');
  return errors;
}

function validateCityInputs(city, dirs) {
  const slug = slugify(city);
  const specs = [
    { kind: 'osm', dir: dirs.osmDir, file: `osm_${slug}.json`, validate: validateOsm },
    { kind: 'dem', dir: dirs.demDir, file: `dem_${slug}.json`, validate: validateDem },
    { kind: 'traffic', dir: dirs.trafficDir, file: `traffic_${slug}.json`, validate: validateTraffic },
  ];
  const problems = [];

  for (const spec of specs) {
    const file = path.join(spec.dir, spec.file);
    const loaded = readDataset(file);
    if (loaded.error) {
      problems.push(`${spec.kind}: ${loaded.error} (${file})`);
      continue;
    }
    for (const error of spec.validate(loaded.value)) {
      problems.push(`${spec.kind}: ${error} (${file})`);
    }
  }

  return { city, slug, ok: problems.length === 0, problems };
}

function validateAll(args) {
  const requested = args.cities.length > 0 ? args.cities : readCitiesFile(args.citiesFile);
  const seen = new Set();
  const cities = [];
  for (const city of requested) {
    const slug = slugify(city);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    cities.push(validateCityInputs(city, args));
  }
  return {
    ok: cities.length > 0 && cities.every(city => city.ok),
    directories: { osm: args.osmDir, dem: args.demDir, traffic: args.trafficDir },
    cities,
  };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/check-enrichment-inputs.js [options]\n\n` +
    `  --city <name>         validate one city (repeatable)\n` +
    `  --cities-file <path>  default: cities.txt\n` +
    `  --osm-dir <path>      default: $ENRICH_OSM_DATA_DIR or .enrichment-cache/osm\n` +
    `  --dem-dir <path>      default: $ENRICH_DEM_DATA_DIR or .enrichment-cache/dem\n` +
    `  --traffic-dir <path>  default: $ENRICH_TRAFFIC_DATA_DIR or .enrichment-cache/traffic\n` +
    `  --json                machine-readable report\n`);
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const result = validateAll(args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const city of result.cities) {
      if (city.ok) console.log(`[enrichment-preflight] ${city.slug}: OK`);
      else {
        console.error(`[enrichment-preflight] ${city.slug}: FAILED`);
        for (const problem of city.problems) console.error(`  - ${problem}`);
      }
    }
  }
  return result.ok ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  parseArgs,
  readDataset,
  validateOsm,
  validateDem,
  validateTraffic,
  validateCityInputs,
  validateAll,
  main,
};
