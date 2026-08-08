#!/usr/bin/env node
'use strict';

/**
 * Strict preflight for the producer datasets consumed by enrich_geojson.js.
 *
 * The enricher removes old context fields before applying providers. Running it
 * with a missing, stale or partial cache can therefore destroy valid slope /
 * traffic data. Production workflows must run this check immediately before
 * enriching.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { readJsonMaybeGz } = require('./lib/read-json-maybe-gz');
const { readCitiesFile, slugify } = require('./lib/static-data-validation');
const { PER_FEATURE_FIELDS, PER_WAY_FIELDS } = require('./enrich_geojson');
const osmProducer = require('./producers/osm_producer');
const demProducer = require('./producers/dem_producer');
const trafficProducer = require('./producers/traffic_producer');

const REPO_ROOT = path.resolve(__dirname, '..');
const CURRENT_PRODUCER_VERSIONS = Object.freeze({
  osm: osmProducer.PRODUCER_VERSION,
  dem: demProducer.PRODUCER_VERSION,
  traffic: trafficProducer.PRODUCER_VERSION,
});

/**
 * Fields added after the core enricher has written its first staged result.
 *
 * `apply-qualitative-traffic-proxy.js` and provider-specific adapters run after
 * `enrich_geojson.js`. They therefore cannot be derived solely from the core
 * module's historical PER_FEATURE_FIELDS list. All of these values are
 * context/enrichment output, never part of the immutable official accident
 * input. Leaving one of them in the fingerprint caused a freshly generated
 * city to fail its own final preflight after tens of minutes of successful
 * producer work.
 */
const POST_ENRICHMENT_FEATURE_FIELDS = Object.freeze([
  'traffic_measurement_type',
  'traffic_proxy_class',
  'traffic_volume_value',
  'traffic_volume_unit',
  'traffic_volume_year',
  'traffic_volume_source',
  'traffic_volume_confidence',
  'traffic_proxy_basis',
  'traffic_observation_id',
  'traffic_mode',
  'traffic_period',
  'traffic_match_quality',
  'traffic_match_distance_m',
  'traffic_source_id',
  'traffic_dataset_url',
  'traffic_license_id',
  'traffic_license_url',
  'traffic_retrieved_at',
  'road_slope_source_id',
  'road_slope_source',
  'road_slope_resolution_m',
  'road_slope_profile_window_m',
  'road_slope_direction',
  'road_slope_quality',
  'road_slope_reliable_for_road',
  'road_slope_residual_mad_m',
  'road_slope_uncertainty_percent',
  'road_slope_uncertainty_reasons',
]);

const ENRICHMENT_FEATURE_FIELDS = new Set([
  ...(PER_FEATURE_FIELDS || []),
  ...(PER_WAY_FIELDS || []),
  ...POST_ENRICHMENT_FEATURE_FIELDS,
]);

function parseArgs(argv) {
  const args = {
    root: REPO_ROOT,
    citiesFile: null,
    cities: [],
    inputDir: null,
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
    else if (arg === '--input-dir') args.inputDir = argv[++i] || null;
    else if (arg === '--osm-dir') args.osmDir = argv[++i] || null;
    else if (arg === '--dem-dir') args.demDir = argv[++i] || null;
    else if (arg === '--traffic-dir') args.trafficDir = argv[++i] || null;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg && arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
  }

  args.citiesFile = path.resolve(args.citiesFile || path.join(args.root, 'cities.txt'));
  args.inputDir = path.resolve(args.inputDir || path.join(args.root, 'out'));
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

function normalizeAccidentGeoJson(value) {
  if (!value || typeof value !== 'object') return value;
  const clone = JSON.parse(JSON.stringify(value));
  if (Array.isArray(clone.features)) {
    for (const feature of clone.features) {
      const properties = feature && feature.properties;
      if (!properties || typeof properties !== 'object') continue;
      for (const field of ENRICHMENT_FEATURE_FIELDS) delete properties[field];
    }
  }
  if (clone.properties && typeof clone.properties === 'object' && !Array.isArray(clone.properties)) {
    delete clone.properties.enrichmentDicts;
    delete clone.properties.enrichmentSummary;
    if (Object.keys(clone.properties).length === 0) delete clone.properties;
  }
  return clone;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function fingerprintJsonArtifact(file) {
  const value = normalizeAccidentGeoJson(readJsonMaybeGz(file));
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function validateCommon(data, expectedVersion, versionFields, expectedFingerprint) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['not an object'];
  const actualVersion = versionFields.map(field => data[field]).find(Boolean);
  if (!actualVersion) {
    errors.push(`${versionFields.join('/')} is missing`);
  } else if (expectedVersion && actualVersion !== expectedVersion) {
    errors.push(`producer version ${JSON.stringify(actualVersion)}, expected ${JSON.stringify(expectedVersion)}`);
  }
  if (typeof data.inputFingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(data.inputFingerprint)) {
    errors.push('inputFingerprint is missing or invalid');
  } else if (expectedFingerprint && data.inputFingerprint !== expectedFingerprint) {
    errors.push(`inputFingerprint does not match current accident GeoJSON (${data.inputFingerprint} != ${expectedFingerprint})`);
  }
  return errors;
}

function validateOsm(data, options) {
  const opts = options || {};
  const errors = validateCommon(
    data,
    opts.expectedVersion || CURRENT_PRODUCER_VERSIONS.osm,
    ['producerVersion'],
    opts.expectedFingerprint,
  );
  if (!data || typeof data !== 'object') return errors;
  if (data.coverage !== 'full') errors.push(`coverage=${JSON.stringify(data.coverage)}, expected "full"`);
  if (!data.ways || typeof data.ways !== 'object' || Object.keys(data.ways).length === 0) errors.push('ways is missing or empty');
  if (!data.wayGeometries || typeof data.wayGeometries !== 'object' || Object.keys(data.wayGeometries).length === 0) errors.push('wayGeometries is missing or empty');
  if (!Array.isArray(data.index)) errors.push('index is not an array');
  return errors;
}

function validateDem(data, options) {
  const opts = options || {};
  const errors = validateCommon(
    data,
    opts.expectedVersion || CURRENT_PRODUCER_VERSIONS.dem,
    ['producerVersion'],
    opts.expectedFingerprint,
  );
  if (!data || typeof data !== 'object') return errors;
  if (!Array.isArray(data.points) || data.points.length === 0) errors.push('points is missing or empty');
  if (!data.wayElevations || typeof data.wayElevations !== 'object' || Object.keys(data.wayElevations).length === 0) errors.push('wayElevations is missing or empty');
  return errors;
}

function validateTraffic(data, options) {
  const opts = options || {};
  const errors = validateCommon(
    data,
    opts.expectedVersion || CURRENT_PRODUCER_VERSIONS.traffic,
    ['producerVersion', 'datasetVersion'],
    opts.expectedFingerprint,
  );
  if (!data || typeof data !== 'object') return errors;
  if (!data.ways || typeof data.ways !== 'object' || Object.keys(data.ways).length === 0) errors.push('ways is missing or empty');
  if (!data.source) errors.push('source is missing');

  if (data.measurementType === 'proxy' && data.ways && typeof data.ways === 'object') {
    for (const [wayId, row] of Object.entries(data.ways)) {
      if (!row || typeof row !== 'object') {
        errors.push(`ways.${wayId} is not an object`);
        continue;
      }
      if (row.measurementType !== 'proxy') errors.push(`ways.${wayId}.measurementType must be "proxy"`);
      if (!['low', 'medium', 'high', 'very_high'].includes(row.proxyClass)) {
        errors.push(`ways.${wayId}.proxyClass is missing or invalid`);
      }
      for (const forbidden of ['value', 'unit', 'year']) {
        if (row[forbidden] != null) errors.push(`ways.${wayId}.${forbidden} is forbidden for a proxy`);
      }
    }
  }
  return errors;
}

function validateCityInputs(city, dirs, options) {
  const opts = options || {};
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
    for (const error of spec.validate(loaded.value, { expectedFingerprint: opts.expectedFingerprint })) {
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
    let expectedFingerprint = null;
    const inputFile = path.join(args.inputDir, `output_all_years_${slug}.geojson`);
    try {
      expectedFingerprint = fingerprintJsonArtifact(inputFile);
    } catch (error) {
      cities.push({
        city,
        slug,
        ok: false,
        problems: [`accident input: ${error.message} (${inputFile}[.gz])`],
      });
      continue;
    }
    cities.push(validateCityInputs(city, args, { expectedFingerprint }));
  }
  return {
    ok: cities.length > 0 && cities.every(city => city.ok),
    directories: {
      input: args.inputDir,
      osm: args.osmDir,
      dem: args.demDir,
      traffic: args.trafficDir,
    },
    cities,
  };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/check-enrichment-inputs.js [options]\n\n` +
    `  --city <name>         validate one city (repeatable)\n` +
    `  --cities-file <path>  default: cities.txt\n` +
    `  --input-dir <path>    accident GeoJSON directory (default: out)\n` +
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
  CURRENT_PRODUCER_VERSIONS,
  POST_ENRICHMENT_FEATURE_FIELDS,
  ENRICHMENT_FEATURE_FIELDS,
  parseArgs,
  readDataset,
  normalizeAccidentGeoJson,
  canonicalJson,
  fingerprintJsonArtifact,
  validateCommon,
  validateOsm,
  validateDem,
  validateTraffic,
  validateCityInputs,
  validateAll,
  main,
};