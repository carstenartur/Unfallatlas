#!/usr/bin/env node
'use strict';

/**
 * Atomic publication contract for official accident datasets.
 *
 * This is deliberately broader than the browser-runtime schema gate:
 * - binds the officially reviewed latest year;
 * - executes the real browser extraction/filter helpers;
 * - proves aggregate GeoJSON/CSV parity;
 * - hashes every published aggregate artifact;
 * - rejects unexpected/raw aggregate files;
 * - binds canonical user scenarios quantitatively;
 * - compares a candidate release with the preceding checked-in manifest.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const { validateRepository } = require('./validate-accident-runtime-contract');

const CONTRACT = 'unfallwerkbank-accident-data-release/v1';
const REPORT_CONTRACT = 'unfallwerkbank-accident-publication-audit/v1';

class AccidentPublicationError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'AccidentPublicationError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new AccidentPublicationError(code, message, details);
}

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, '..'),
    inputDir: 'out',
    citiesFile: 'cities.txt',
    policy: 'config/accident-data-policy.json',
    manifest: 'data/accident-data-release.json',
    previousManifest: null,
    report: 'out/qa/accident-publication.json',
    writeManifest: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--root') args.root = path.resolve(argv[++index] || args.root);
    else if (argument === '--input-dir') args.inputDir = argv[++index] || args.inputDir;
    else if (argument === '--cities-file') args.citiesFile = argv[++index] || args.citiesFile;
    else if (argument === '--policy') args.policy = argv[++index] || args.policy;
    else if (argument === '--manifest') args.manifest = argv[++index] || args.manifest;
    else if (argument === '--previous-manifest') args.previousManifest = argv[++index] || null;
    else if (argument === '--report') args.report = argv[++index] || args.report;
    else if (argument === '--write-manifest') args.writeManifest = true;
    else if (argument === '--help' || argument === '-h') args.help = true;
    else fail('unknown_argument', `Unknown argument: ${argument}`);
  }
  for (const key of ['inputDir', 'citiesFile', 'policy', 'manifest', 'report']) {
    args[key] = path.resolve(args.root, args[key]);
  }
  if (args.previousManifest) args.previousManifest = path.resolve(args.root, args.previousManifest);
  return args;
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('json_read_failed', `Cannot read ${label || file}`, { file, cause: error.message });
  }
  return value;
}

function requiredString(value, pathName) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_policy', `${pathName} must be a non-empty string`, { value });
  }
  return value.trim();
}

function finiteFraction(value, pathName) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > 1) {
    fail('invalid_policy', `${pathName} must be greater than 0 and at most 1`, { value });
  }
  return number;
}

function integer(value, pathName, minimum = 0) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) {
    fail('invalid_policy', `${pathName} must be an integer >= ${minimum}`, { value });
  }
  return number;
}

function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_policy', 'Policy must be an object');
  }
  if (value.contract !== 'unfallwerkbank-accident-data-policy/v1') {
    fail('invalid_policy_contract', 'Unsupported accident-data policy contract', {
      actual: value.contract,
    });
  }
  const source = value.source || {};
  const minimums = value.canonicalScenarioMinimums || {};
  const regression = value.regressionPolicy || {};
  const normalized = {
    schemaVersion: integer(value.schemaVersion, 'policy.schemaVersion', 1),
    contract: value.contract,
    source: {
      publisher: requiredString(source.publisher, 'policy.source.publisher'),
      datasetTitle: requiredString(source.datasetTitle, 'policy.source.datasetTitle'),
      officialIndexUrl: requiredString(source.officialIndexUrl, 'policy.source.officialIndexUrl'),
      officialStatusUrl: requiredString(source.officialStatusUrl, 'policy.source.officialStatusUrl'),
      licenseId: requiredString(source.licenseId, 'policy.source.licenseId'),
      licenseUrl: requiredString(source.licenseUrl, 'policy.source.licenseUrl'),
    },
    firstYear: integer(value.firstYear, 'policy.firstYear', 2016),
    expectedLatestYear: integer(value.expectedLatestYear, 'policy.expectedLatestYear', 2016),
    officialReleaseDate: requiredString(value.officialReleaseDate, 'policy.officialReleaseDate'),
    minimumConfiguredCities: integer(
      value.minimumConfiguredCities,
      'policy.minimumConfiguredCities',
      1
    ),
    regressionPolicy: {
      minimumRetainedCityFeatureFraction: finiteFraction(
        regression.minimumRetainedCityFeatureFraction,
        'policy.regressionPolicy.minimumRetainedCityFeatureFraction'
      ),
      minimumRetainedScenarioFraction: finiteFraction(
        regression.minimumRetainedScenarioFraction,
        'policy.regressionPolicy.minimumRetainedScenarioFraction'
      ),
    },
    canonicalScenarioMinimums: Object.fromEntries(
      Object.entries(minimums).map(([id, minimum]) => [
        requiredString(id, 'policy.canonicalScenarioMinimums key'),
        integer(minimum, `policy.canonicalScenarioMinimums.${id}`, 1),
      ])
    ),
  };
  if (normalized.expectedLatestYear < normalized.firstYear) {
    fail('invalid_policy', 'expectedLatestYear is before firstYear');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized.officialReleaseDate)) {
    fail('invalid_policy', 'officialReleaseDate must use YYYY-MM-DD');
  }
  for (const uri of [
    normalized.source.officialIndexUrl,
    normalized.source.officialStatusUrl,
    normalized.source.licenseUrl,
  ]) {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch (_) {
      fail('invalid_policy', `Invalid absolute URL: ${uri}`);
    }
    if (parsed.protocol !== 'https:') fail('invalid_policy', `Policy URL must use HTTPS: ${uri}`);
  }
  return Object.freeze(normalized);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Value(value) {
  return sha256Bytes(Buffer.from(stableJson(value)));
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function readGzip(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    fail('artifact_read_failed', `Cannot read ${file}`, { cause: error.message });
  }
  let uncompressed;
  try {
    uncompressed = zlib.gunzipSync(bytes);
  } catch (error) {
    fail('invalid_gzip', `Cannot decompress ${file}`, { cause: error.message });
  }
  return { bytes, uncompressed };
}

/**
 * Count RFC-4180-style records, including quoted newlines and doubled quotes.
 * Returns data rows, excluding one mandatory header row.
 */
function countCsvRows(buffer, file) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  let records = 0;
  let inQuotes = false;
  let hasContent = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      hasContent = true;
    } else if ((character === '\n' || character === '\r') && !inQuotes) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      if (hasContent) records += 1;
      hasContent = false;
    } else {
      if (!/\s/.test(character)) hasContent = true;
    }
  }
  if (inQuotes) fail('invalid_csv', `${file} ends inside a quoted field`);
  if (hasContent) records += 1;
  if (records < 1) fail('invalid_csv', `${file} has no header row`);
  return records - 1;
}

function artifactDescriptor(root, file) {
  const { bytes, uncompressed } = readGzip(file);
  return Object.freeze({
    path: relative(root, file),
    bytes: bytes.length,
    uncompressedBytes: uncompressed.length,
    sha256: sha256Bytes(bytes),
    contentSha256: sha256Bytes(uncompressed),
  });
}

function expectedArtifactNames(runtimeReport) {
  return new Set(runtimeReport.cityReports.flatMap((city) => [
    `output_all_years_${city.slug}.geojson.gz`,
    `output_all_years_${city.slug}.csv.gz`,
  ]));
}

function auditAggregateInventory(inputDir, runtimeReport) {
  const expected = expectedArtifactNames(runtimeReport);
  const actual = new Set();
  const raw = [];
  for (const entry of fs.readdirSync(inputDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (/^output_all_years_.+\.(?:csv|geojson)\.gz$/i.test(entry.name)) actual.add(entry.name);
    if (/^output_all_years_.+\.(?:csv|geojson)$/i.test(entry.name)) raw.push(entry.name);
    if (/^output_all_years_.+\.tmp$/i.test(entry.name)) raw.push(entry.name);
  }
  if (raw.length) {
    fail('raw_or_temporary_aggregate', 'Raw or temporary aggregate files must not be published', {
      files: raw.sort(),
    });
  }
  const missing = [...expected].filter((name) => !actual.has(name)).sort();
  const unexpected = [...actual].filter((name) => !expected.has(name)).sort();
  if (missing.length || unexpected.length) {
    fail('aggregate_inventory_mismatch', 'Published aggregate file inventory is inconsistent', {
      missing,
      unexpected,
    });
  }
}

function buildReleaseManifest(root, inputDir, policy, runtimeReport) {
  auditAggregateInventory(inputDir, runtimeReport);
  if (runtimeReport.checkedCities < policy.minimumConfiguredCities) {
    fail('configured_city_regression', 'Configured city count is below the reviewed minimum', {
      actual: runtimeReport.checkedCities,
      minimum: policy.minimumConfiguredCities,
    });
  }

  const scenarioById = new Map(
    runtimeReport.canonicalScenarios.map((scenario) => [scenario.id, scenario])
  );
  for (const [id, minimum] of Object.entries(policy.canonicalScenarioMinimums)) {
    const scenario = scenarioById.get(id);
    if (!scenario) fail('canonical_scenario_missing', `Required scenario is absent: ${id}`);
    if (scenario.matches < minimum) {
      fail('canonical_scenario_below_floor', `Scenario ${id} is below its reviewed floor`, {
        actual: scenario.matches,
        minimum,
      });
    }
  }

  const cities = runtimeReport.cityReports.map((city) => {
    const geojsonFile = path.join(inputDir, `output_all_years_${city.slug}.geojson.gz`);
    const csvFile = path.join(inputDir, `output_all_years_${city.slug}.csv.gz`);
    const geojson = artifactDescriptor(root, geojsonFile);
    const csvCompressed = readGzip(csvFile);
    const csv = Object.freeze({
      path: relative(root, csvFile),
      bytes: csvCompressed.bytes.length,
      uncompressedBytes: csvCompressed.uncompressed.length,
      sha256: sha256Bytes(csvCompressed.bytes),
      contentSha256: sha256Bytes(csvCompressed.uncompressed),
    });
    const csvRows = countCsvRows(csvCompressed.uncompressed, csv.path);
    if (csvRows !== city.featureCount) {
      fail('csv_geojson_count_mismatch', `${city.city} CSV and GeoJSON represent different row counts`, {
        city: city.city,
        csvRows,
        geojsonFeatures: city.featureCount,
        csv: csv.path,
        geojson: geojson.path,
      });
    }
    return Object.freeze({
      city: city.city,
      slug: city.slug,
      featureCount: city.featureCount,
      minimumYear: city.minimumYear,
      latestYear: city.latestYear,
      years: city.years,
      byYear: city.byYear,
      artifacts: Object.freeze({ csv, geojson }),
    });
  }).sort((left, right) => left.slug.localeCompare(right.slug));

  const body = {
    schemaVersion: 1,
    contract: CONTRACT,
    releaseId: `unfallatlas-${policy.firstYear}-${policy.expectedLatestYear}-${policy.officialReleaseDate}`,
    source: policy.source,
    officialReleaseDate: policy.officialReleaseDate,
    firstYear: policy.firstYear,
    latestYear: runtimeReport.latestYear,
    checkedCities: runtimeReport.checkedCities,
    policySha256: sha256Value(policy),
    canonicalScenarios: runtimeReport.canonicalScenarios
      .map((scenario) => ({ ...scenario }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    cities,
  };
  return Object.freeze({
    ...body,
    fingerprint: sha256Value(body),
  });
}

function compareReleaseManifests(actual, expected, label) {
  const actualJson = stableJson(actual);
  const expectedJson = stableJson(expected);
  if (actualJson !== expectedJson) {
    fail('release_manifest_drift', `${label || 'Checked-in release manifest'} does not match published bytes`, {
      actualFingerprint: actual && actual.fingerprint,
      expectedFingerprint: expected && expected.fingerprint,
    });
  }
}

function auditRegression(candidate, previous, policy) {
  if (!previous) return;
  if (previous.contract !== CONTRACT) {
    fail('previous_manifest_contract', 'Previous manifest uses an unsupported contract', {
      actual: previous.contract,
    });
  }
  if (candidate.latestYear < previous.latestYear) {
    fail('latest_year_regression', 'Candidate latest year is older than the previous release', {
      previous: previous.latestYear,
      candidate: candidate.latestYear,
    });
  }

  const previousCities = new Map(previous.cities.map((city) => [city.slug, city]));
  const candidateCities = new Map(candidate.cities.map((city) => [city.slug, city]));
  for (const [slug, oldCity] of previousCities) {
    const nextCity = candidateCities.get(slug);
    if (!nextCity) fail('city_removed', `Candidate release removes city ${slug}`);
    const minimum = Math.floor(
      oldCity.featureCount * policy.regressionPolicy.minimumRetainedCityFeatureFraction
    );
    if (nextCity.featureCount < minimum) {
      fail('city_feature_regression', `Candidate release loses too many records for ${slug}`, {
        previous: oldCity.featureCount,
        candidate: nextCity.featureCount,
        minimum,
      });
    }
  }

  const previousScenarios = new Map(
    previous.canonicalScenarios.map((scenario) => [scenario.id, scenario])
  );
  const candidateScenarios = new Map(
    candidate.canonicalScenarios.map((scenario) => [scenario.id, scenario])
  );
  for (const [id, oldScenario] of previousScenarios) {
    const nextScenario = candidateScenarios.get(id);
    if (!nextScenario) fail('scenario_removed', `Candidate release removes scenario ${id}`);
    const minimum = Math.floor(
      oldScenario.matches * policy.regressionPolicy.minimumRetainedScenarioFraction
    );
    if (nextScenario.matches < minimum) {
      fail('scenario_regression', `Candidate release loses too many matches for ${id}`, {
        previous: oldScenario.matches,
        candidate: nextScenario.matches,
        minimum,
      });
    }
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function validatePublication(options) {
  const policy = validatePolicy(readJson(options.policy, 'accident-data policy'));
  const runtimeReport = validateRepository({
    root: options.root,
    inputDir: relative(options.root, options.inputDir),
    citiesFile: relative(options.root, options.citiesFile),
    expectedLatestYear: policy.expectedLatestYear,
  });
  const candidate = buildReleaseManifest(options.root, options.inputDir, policy, runtimeReport);
  const previous = options.previousManifest && fs.existsSync(options.previousManifest)
    ? readJson(options.previousManifest, 'previous release manifest')
    : null;
  auditRegression(candidate, previous, policy);

  if (options.writeManifest) {
    writeJson(options.manifest, candidate);
  } else {
    if (!fs.existsSync(options.manifest)) {
      fail('release_manifest_missing', `Checked-in release manifest is absent: ${options.manifest}`);
    }
    compareReleaseManifests(candidate, readJson(options.manifest, 'release manifest'));
  }

  return Object.freeze({
    schemaVersion: 1,
    contract: REPORT_CONTRACT,
    passed: true,
    policy: relative(options.root, options.policy),
    manifest: relative(options.root, options.manifest),
    releaseId: candidate.releaseId,
    releaseFingerprint: candidate.fingerprint,
    latestYear: candidate.latestYear,
    checkedCities: candidate.checkedCities,
    totalFeatures: candidate.cities.reduce((sum, city) => sum + city.featureCount, 0),
    canonicalScenarios: candidate.canonicalScenarios,
    artifactCount: candidate.cities.length * 2,
  });
}

function printHelp() {
  process.stdout.write(
    'Usage: node scripts/validate-accident-publication.js ' +
      '[--write-manifest] [--previous-manifest file] [--report file]\n'
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  try {
    const report = validatePublication(args);
    writeJson(args.report, report);
    process.stdout.write(
      `[accident-publication] PASS ${report.releaseId}: ` +
        `${report.checkedCities} cities, ${report.totalFeatures} features, ` +
        `${report.artifactCount} aggregate artifacts.\n`
    );
    return 0;
  } catch (error) {
    const failure = {
      schemaVersion: 1,
      contract: REPORT_CONTRACT,
      passed: false,
      error: {
        name: error && error.name ? error.name : 'Error',
        code: error && error.code ? error.code : null,
        message: error && error.message ? error.message : String(error),
        details: error && error.details ? error.details : null,
      },
    };
    try {
      writeJson(args.report, failure);
    } catch (_) {
      // The primary failure remains more useful than a secondary report failure.
    }
    process.stderr.write(`${failure.error.message}\n`);
    if (failure.error.details) {
      process.stderr.write(`${JSON.stringify(failure.error.details, null, 2)}\n`);
    }
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = Object.freeze({
  CONTRACT,
  REPORT_CONTRACT,
  AccidentPublicationError,
  parseArgs,
  validatePolicy,
  stableValue,
  stableJson,
  sha256Bytes,
  sha256Value,
  countCsvRows,
  artifactDescriptor,
  auditAggregateInventory,
  buildReleaseManifest,
  compareReleaseManifests,
  auditRegression,
  validatePublication,
  main,
});
