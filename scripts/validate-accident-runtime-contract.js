#!/usr/bin/env node
'use strict';

/**
 * Fail-closed compatibility gate for the checked-in accident datasets.
 *
 * File existence and a non-zero feature count are not sufficient: the browser
 * relies on a stable, lowercase property contract and on involvement flags that
 * can be interpreted by js/ua.filters.js. This validator deliberately executes
 * the same extraction and involvement helpers as the web application and fails
 * before a data-refresh workflow is allowed to commit incompatible bytes.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { readJsonMaybeGz } = require('./lib/read-json-maybe-gz');
const { readCitiesFile, slugify } = require('./lib/static-data-validation');

const REQUIRED_PROPERTIES = Object.freeze([
  'year',
  'ukategorie',
  'umonat',
  'ustunde',
  'uwochentag',
  'strzustand',
  'istrad',
  'istpkw',
  'istfuss',
  'istkrad',
  'istgkfz',
  'istsonstig',
]);
const PRIMARY_INVOLVEMENT_PROPERTIES = Object.freeze([
  'istrad',
  'istpkw',
  'istfuss',
  'istkrad',
]);
const OPTIONAL_INVOLVEMENT_PROPERTIES = Object.freeze([
  'istgkfz',
  'istsonstig',
]);
const INVOLVEMENT_PROPERTIES = Object.freeze([
  ...PRIMARY_INVOLVEMENT_PROPERTIES,
  ...OPTIONAL_INVOLVEMENT_PROPERTIES,
]);
const GERMANY_BOUNDS = Object.freeze({ south: 46, west: 4, north: 56, east: 17 });
const CANONICAL_SCENARIOS = Object.freeze([
  Object.freeze({
    id: 'hannover-default-or',
    city: 'Hannover',
    mode: 'or',
    involvement: Object.freeze({ bike: true, pedestrian: true, car: true }),
    minimumMatches: 1,
  }),
  Object.freeze({
    id: 'bonn-bike-car-and',
    city: 'Bonn',
    mode: 'and',
    involvement: Object.freeze({ bike: true, pedestrian: false, car: true }),
    minimumMatches: 1,
  }),
  Object.freeze({
    id: 'bonn-bike-solo',
    city: 'Bonn',
    mode: 'solo',
    involvement: Object.freeze({ bike: true, pedestrian: false, car: false }),
    minimumMatches: 1,
  }),
]);

class AccidentRuntimeContractError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'AccidentRuntimeContractError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new AccidentRuntimeContractError(code, message, details);
}

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, '..'),
    inputDir: 'out',
    citiesFile: 'cities.txt',
    report: null,
    expectedLatestYear: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') args.root = path.resolve(argv[++index] || args.root);
    else if (argument === '--input-dir') args.inputDir = argv[++index] || args.inputDir;
    else if (argument === '--cities-file') args.citiesFile = argv[++index] || args.citiesFile;
    else if (argument === '--report') args.report = argv[++index] || null;
    else if (argument === '--expected-latest-year') {
      args.expectedLatestYear = Number.parseInt(argv[++index] || '', 10);
    } else if (argument === '--help' || argument === '-h') args.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  if (args.expectedLatestYear != null &&
      (!Number.isInteger(args.expectedLatestYear) || args.expectedLatestYear < 2016 || args.expectedLatestYear > 2100)) {
    fail('invalid_expected_year', '--expected-latest-year must be an integer from 2016 through 2100');
  }
  args.inputDir = path.resolve(args.root, args.inputDir);
  args.citiesFile = path.resolve(args.root, args.citiesFile);
  args.report = args.report ? path.resolve(args.root, args.report) : null;
  return args;
}

function loadBrowserRuntime(root) {
  const sandbox = {
    window: {
      UA: {
        DataResources: {},
        WEEKEND_SET: new Set(['6', '7']),
      },
    },
    console,
    URL,
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Math,
    JSON,
  };
  vm.createContext(sandbox);
  for (const relative of ['js/ua.data_v2.js', 'js/ua.filters.js']) {
    const file = path.join(root, relative);
    vm.runInContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: relative });
  }
  const runtime = sandbox.window.UA;
  if (typeof runtime.extractPoints !== 'function' || typeof runtime.maskFromProps !== 'function' ||
      typeof runtime.matchesInvolvementFilter !== 'function') {
    fail('runtime_load_failed', 'Browser extraction/filter helpers are unavailable');
  }
  return runtime;
}

function scalar(value) {
  return value !== null && value !== undefined &&
    (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean');
}

function integerInRange(value, minimum, maximum) {
  const text = String(value == null ? '' : value).trim();
  if (!/^-?\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number >= minimum && number <= maximum ? number : null;
}

function validateFeature(feature, index, city, runtime) {
  if (!feature || feature.type !== 'Feature') {
    fail('invalid_feature', `${city} feature ${index} is not a GeoJSON Feature`);
  }
  const geometry = feature.geometry;
  if (!geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates) ||
      geometry.coordinates.length < 2) {
    fail('invalid_geometry', `${city} feature ${index} is not a Point geometry`);
  }
  const lon = Number(geometry.coordinates[0]);
  const lat = Number(geometry.coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < GERMANY_BOUNDS.south || lat > GERMANY_BOUNDS.north ||
      lon < GERMANY_BOUNDS.west || lon > GERMANY_BOUNDS.east) {
    fail('invalid_coordinate', `${city} feature ${index} has an invalid Germany coordinate`, {
      coordinate: geometry.coordinates,
    });
  }

  const properties = feature.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    fail('invalid_properties', `${city} feature ${index} has no property object`);
  }
  const missing = REQUIRED_PROPERTIES.filter((key) => !Object.prototype.hasOwnProperty.call(properties, key));
  if (missing.length) {
    fail('missing_runtime_properties', `${city} feature ${index} lacks browser-required properties`, {
      missing,
      available: Object.keys(properties).sort(),
    });
  }
  for (const key of REQUIRED_PROPERTIES) {
    if (!scalar(properties[key])) {
      fail('invalid_runtime_property', `${city} feature ${index} property ${key} is not scalar`, {
        value: properties[key],
      });
    }
  }

  const year = integerInRange(properties.year, 2016, 2100);
  const severity = integerInRange(properties.ukategorie, 1, 3);
  const month = integerInRange(properties.umonat, 1, 12);
  const hour = integerInRange(properties.ustunde, 0, 23);
  const weekday = integerInRange(properties.uwochentag, 1, 7);
  if (year == null) fail('invalid_year', `${city} feature ${index} has invalid year`, { value: properties.year });
  if (severity == null) fail('invalid_severity', `${city} feature ${index} has invalid ukategorie`, { value: properties.ukategorie });
  if (month == null) fail('invalid_month', `${city} feature ${index} has invalid umonat`, { value: properties.umonat });
  if (hour == null) fail('invalid_hour', `${city} feature ${index} has invalid ustunde`, { value: properties.ustunde });
  if (weekday == null) fail('invalid_weekday', `${city} feature ${index} has invalid uwochentag`, { value: properties.uwochentag });

  const roadCondition = String(properties.strzustand == null ? '' : properties.strzustand).trim();
  if (!['', '0', '1', '2'].includes(roadCondition)) {
    fail('invalid_road_condition', `${city} feature ${index} has a road condition the UI cannot select`, {
      value: properties.strzustand,
    });
  }

  for (const key of PRIMARY_INVOLVEMENT_PROPERTIES) {
    const value = String(properties[key]).trim();
    if (value !== '0' && value !== '1') {
      fail('invalid_involvement_value', `${city} feature ${index} has invalid ${key}`, { value: properties[key] });
    }
  }
  for (const key of OPTIONAL_INVOLVEMENT_PROPERTIES) {
    const value = String(properties[key]).trim();
    // Some historic source years did not publish these two optional modes.
    // The current browser treats an empty value as false; preserve that legacy
    // compatibility while still rejecting arbitrary schema drift.
    if (value !== '' && value !== '0' && value !== '1') {
      fail('invalid_involvement_value', `${city} feature ${index} has invalid ${key}`, { value: properties[key] });
    }
  }
  const mask = runtime.maskFromProps(properties);
  if (!Number.isInteger(mask) || mask < 1 || mask > 63) {
    fail('unusable_involvement_mask', `${city} feature ${index} cannot be used by the browser involvement filters`, {
      mask,
      involvement: Object.fromEntries(INVOLVEMENT_PROPERTIES.map((key) => [key, properties[key]])),
    });
  }
  return { year, mask };
}

function contiguousYears(years) {
  if (!years.length) return [];
  const missing = [];
  for (let year = years[0]; year <= years[years.length - 1]; year += 1) {
    if (!years.includes(year)) missing.push(year);
  }
  return missing;
}

function makeScenarioContext(scenario) {
  const involvement = scenario.involvement || {};
  return {
    involvementMode: scenario.mode,
    ui: {
      incBikeEl: { checked: !!involvement.bike },
      incPedEl: { checked: !!involvement.pedestrian },
      incCarEl: { checked: !!involvement.car },
      incMotoEl: { checked: !!involvement.motorcycle },
      incGkfzEl: { checked: !!involvement.gkfz },
      incSonEl: { checked: !!involvement.sonstig },
    },
  };
}

function countScenarioMatches(features, scenario, runtime) {
  const context = makeScenarioContext(scenario);
  let count = 0;
  for (const feature of features) {
    const mask = runtime.maskFromProps(feature.properties || {});
    if (runtime.matchesInvolvementFilter(context, mask)) count += 1;
  }
  return count;
}

function readCityDataset(inputDir, slug) {
  const logical = path.join(inputDir, `output_all_years_${slug}.geojson`);
  try {
    return readJsonMaybeGz(logical, { mode: 'gzip-only' });
  } catch (error) {
    fail('dataset_read_failed', `Cannot read ${path.basename(logical)}.gz`, { cause: error.message });
  }
}

function validateCity(options) {
  const { city, slug, inputDir, runtime } = options;
  const dataset = readCityDataset(inputDir, slug);
  if (!dataset || dataset.type !== 'FeatureCollection' || !Array.isArray(dataset.features)) {
    fail('invalid_feature_collection', `${city} dataset is not a GeoJSON FeatureCollection`);
  }
  if (dataset.features.length < 10) {
    fail('implausible_feature_count', `${city} dataset has fewer than ten features`, {
      featureCount: dataset.features.length,
    });
  }

  const extracted = runtime.extractPoints(dataset);
  if (!Array.isArray(extracted) || extracted.length !== dataset.features.length) {
    fail('browser_extraction_mismatch', `${city} loses features in UA.extractPoints`, {
      sourceFeatures: dataset.features.length,
      extractedPoints: Array.isArray(extracted) ? extracted.length : null,
    });
  }

  const byYear = new Map();
  for (let index = 0; index < dataset.features.length; index += 1) {
    const observed = validateFeature(dataset.features[index], index, city, runtime);
    byYear.set(observed.year, (byYear.get(observed.year) || 0) + 1);
  }
  const years = [...byYear.keys()].sort((left, right) => left - right);
  const missingYears = contiguousYears(years);
  if (missingYears.length) {
    fail('year_gap', `${city} dataset has gaps between its first and latest year`, {
      years,
      missingYears,
    });
  }
  return {
    city,
    slug,
    featureCount: dataset.features.length,
    years,
    minimumYear: years[0],
    latestYear: years[years.length - 1],
    byYear: Object.fromEntries([...byYear.entries()].sort((a, b) => a[0] - b[0])),
    features: dataset.features,
  };
}

function validateRepository(options = {}) {
  const root = path.resolve(options.root || path.join(__dirname, '..'));
  const inputDir = path.resolve(root, options.inputDir || 'out');
  const citiesFile = path.resolve(root, options.citiesFile || 'cities.txt');
  const expectedLatestYear = options.expectedLatestYear == null
    ? null
    : Number(options.expectedLatestYear);
  const runtime = loadBrowserRuntime(root);
  const cities = readCitiesFile(citiesFile);
  const cityReports = [];
  const featuresByCity = new Map();

  for (const city of cities) {
    const report = validateCity({ city, slug: slugify(city), inputDir, runtime });
    featuresByCity.set(city.toLocaleLowerCase('de'), report.features);
    cityReports.push({ ...report, features: undefined });
  }
  const latestYears = [...new Set(cityReports.map((city) => city.latestYear))].sort();
  if (latestYears.length !== 1) {
    fail('inconsistent_latest_year', 'Configured cities do not expose one common latest accident year', {
      latestYears,
      cities: cityReports.map(({ city, latestYear }) => ({ city, latestYear })),
    });
  }
  const latestYear = latestYears[0];
  if (expectedLatestYear != null && latestYear !== expectedLatestYear) {
    fail('latest_year_mismatch', 'Checked-in data does not match the requested official latest year', {
      expectedLatestYear,
      actualLatestYear: latestYear,
    });
  }

  const scenarioReports = [];
  for (const scenario of CANONICAL_SCENARIOS) {
    const features = featuresByCity.get(scenario.city.toLocaleLowerCase('de'));
    if (!features) fail('missing_scenario_city', `Canonical scenario city is not configured: ${scenario.city}`);
    const matches = countScenarioMatches(features, scenario, runtime);
    if (matches < scenario.minimumMatches) {
      fail('canonical_scenario_empty', `Canonical application scenario ${scenario.id} has no usable accidents`, {
        city: scenario.city,
        matches,
        minimumMatches: scenario.minimumMatches,
      });
    }
    scenarioReports.push({ id: scenario.id, city: scenario.city, matches });
  }

  return Object.freeze({
    schemaVersion: 1,
    contract: 'unfallwerkbank-checked-in-accident-runtime/v1',
    checkedCities: cityReports.length,
    latestYear,
    requiredProperties: REQUIRED_PROPERTIES,
    cityReports: cityReports.map((city) => Object.freeze(city)),
    canonicalScenarios: scenarioReports.map((scenario) => Object.freeze(scenario)),
  });
}

function writeReport(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/validate-accident-runtime-contract.js ' +
      '[--input-dir out] [--cities-file cities.txt] [--expected-latest-year 2025] [--report file]\n',
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  try {
    const report = validateRepository(args);
    if (args.report) writeReport(args.report, report);
    process.stdout.write(
      `[accident-runtime-contract] PASS: ${report.checkedCities} cities, latest year ${report.latestYear}, ` +
        `${report.canonicalScenarios.length} canonical scenarios.\n`,
    );
    return 0;
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      contract: 'unfallwerkbank-checked-in-accident-runtime/v1',
      passed: false,
      error: {
        name: error && error.name ? error.name : 'Error',
        code: error && error.code ? error.code : null,
        message: error && error.message ? error.message : String(error),
        details: error && error.details ? error.details : null,
      },
    };
    if (args.report) writeReport(args.report, failure);
    process.stderr.write(`${failure.error.message}\n`);
    if (failure.error.details) process.stderr.write(`${JSON.stringify(failure.error.details, null, 2)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = Object.freeze({
  REQUIRED_PROPERTIES,
  PRIMARY_INVOLVEMENT_PROPERTIES,
  OPTIONAL_INVOLVEMENT_PROPERTIES,
  INVOLVEMENT_PROPERTIES,
  GERMANY_BOUNDS,
  CANONICAL_SCENARIOS,
  AccidentRuntimeContractError,
  parseArgs,
  loadBrowserRuntime,
  integerInRange,
  validateFeature,
  contiguousYears,
  makeScenarioContext,
  countScenarioMatches,
  readCityDataset,
  validateCity,
  validateRepository,
  writeReport,
  main,
});
