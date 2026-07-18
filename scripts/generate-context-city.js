#!/usr/bin/env node
'use strict';

/**
 * Generate OSM, elevation/slope and traffic context for exactly one city.
 *
 * All expensive producer work and enrichment happen in a staging directory.
 * The public out/ tree is replaced only after producer preflight and context
 * validation succeed, so a failed refresh cannot delete working context data.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const osmProducer = require('./producers/osm_producer');
const demTileProducer = require('./producers/dem_tile_producer');
const demProducer = require('./producers/dem_producer');
const trafficProducer = require('./producers/traffic_producer');
const enricher = require('./enrich_geojson');
const { readJsonMaybeGz } = require('./lib/read-json-maybe-gz');
const { validateAll: validateContextDatasets } = require('./check-context-datasets');
const {
  fingerprintJsonArtifact,
  validateCityInputs,
  validateOsm,
  validateDem,
  validateTraffic,
} = require('./check-enrichment-inputs');
const { readCitiesFile, slugify, validateGeoJsonArtifact } = require('./lib/static-data-validation');

const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {
    root: REPO_ROOT,
    city: null,
    inputDir: 'out',
    outputDir: 'out',
    cacheDir: '.enrichment-cache',
    workDir: '.build/context-generation',
    force: false,
    keepWork: false,
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = path.resolve(argv[++i] || args.root);
    else if (arg === '--city') args.city = argv[++i] || null;
    else if (arg === '--input-dir') args.inputDir = argv[++i] || args.inputDir;
    else if (arg === '--output-dir') args.outputDir = argv[++i] || args.outputDir;
    else if (arg === '--cache-dir') args.cacheDir = argv[++i] || args.cacheDir;
    else if (arg === '--work-dir') args.workDir = argv[++i] || args.workDir;
    else if (arg === '--force') args.force = true;
    else if (arg === '--keep-work') args.keepWork = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg && arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`);
  }

  args.inputDir = path.resolve(args.root, args.inputDir);
  args.outputDir = path.resolve(args.root, args.outputDir);
  args.cacheDir = path.resolve(args.root, args.cacheDir);
  args.workDir = path.resolve(args.root, args.workDir);
  return args;
}

function resolveCanonicalCity(root, requested) {
  if (!requested || !String(requested).trim()) throw new Error('--city is required');
  const wanted = slugify(requested);
  const cities = readCitiesFile(path.join(root, 'cities.txt'));
  const canonical = cities.find(city => slugify(city) === wanted);
  if (!canonical) {
    throw new Error(`Unknown city ${JSON.stringify(requested)}; only entries from cities.txt are allowed`);
  }
  return { city: canonical, slug: wanted };
}

function copyLogicalArtifact(sourceDir, targetDir, logicalName) {
  const raw = path.join(sourceDir, logicalName);
  const gz = `${raw}.gz`;
  fs.mkdirSync(targetDir, { recursive: true });
  if (fs.existsSync(raw)) {
    fs.copyFileSync(raw, path.join(targetDir, logicalName));
    return path.join(targetDir, logicalName);
  }
  if (fs.existsSync(gz)) {
    fs.copyFileSync(gz, path.join(targetDir, `${logicalName}.gz`));
    return path.join(targetDir, `${logicalName}.gz`);
  }
  throw new Error(`Missing input artifact: ${raw}[.gz]`);
}

function assertProducerResult(kind, result, expectedFile) {
  if (result && result.skipped && result.reason !== 'already cached') {
    throw new Error(`${kind} producer skipped: ${result.reason}`);
  }
  if (!fs.existsSync(expectedFile)) {
    throw new Error(`${kind} producer did not create ${expectedFile}`);
  }
}

function producerDatasetIsCurrent(file, validator, inputFingerprint) {
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.gz`)) return false;
  try {
    const data = readJsonMaybeGz(file);
    return validator(data, { expectedFingerprint: inputFingerprint }).length === 0;
  } catch (_) {
    return false;
  }
}

function stampProducerDataset(file, inputFingerprint) {
  const data = readJsonMaybeGz(file);
  data.inputFingerprint = inputFingerprint;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  if (fs.existsSync(`${file}.gz`)) fs.rmSync(`${file}.gz`, { force: true });
}

function withProviderEnvironment(dirs, fn) {
  const names = ['ENRICH_OSM_DATA_DIR', 'ENRICH_DEM_DATA_DIR', 'ENRICH_TRAFFIC_DATA_DIR'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.ENRICH_OSM_DATA_DIR = dirs.osmDir;
  process.env.ENRICH_DEM_DATA_DIR = dirs.demDir;
  process.env.ENRICH_TRAFFIC_DATA_DIR = dirs.trafficDir;
  try {
    return fn();
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

function gzipFileInPlace(file) {
  const target = `${file}.gz`;
  const tmp = `${target}.${process.pid}.tmp`;
  const compressed = zlib.gzipSync(fs.readFileSync(file), { level: 9, mtime: 0 });
  fs.writeFileSync(tmp, compressed);
  fs.renameSync(tmp, target);
  fs.unlinkSync(file);
}

function gzipGeneratedTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) gzipGeneratedTree(absolute);
    else if (entry.isFile() && /\.(?:json|geojson)$/i.test(entry.name)) gzipFileInPlace(absolute);
  }
}

function removePath(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function prepareTransactionEntry(entry, txId) {
  const parent = path.dirname(entry.destination);
  fs.mkdirSync(parent, { recursive: true });
  entry.incoming = `${entry.destination}.${txId}.incoming`;
  entry.backup = `${entry.destination}.${txId}.backup`;
  entry.backedUp = false;
  entry.installed = false;
  removePath(entry.incoming);
  removePath(entry.backup);
  if (!entry.source) return;
  if (entry.directory) {
    fs.cpSync(entry.source, entry.incoming, { recursive: true });
  } else {
    fs.copyFileSync(entry.source, entry.incoming);
  }
}

/**
 * Install one complete city dataset as a small filesystem transaction.
 *
 * POSIX filesystems cannot atomically rename several independent paths in one
 * syscall, therefore every old destination is first moved to a transaction
 * backup. If any subsequent rename fails, all already-installed destinations
 * are removed and every backup is restored in reverse order. The optional
 * `onCommitStep` hook exists only for deterministic rollback tests.
 */
function installGeneratedCity(stagedOut, outputDir, slug, options) {
  const opts = options || {};
  const required = [
    `output_all_years_${slug}.geojson.gz`,
    `ways_${slug}.json.gz`,
    `output_all_years_${slug}.enrichment.meta.json.gz`,
  ];
  for (const name of required) {
    if (!fs.existsSync(path.join(stagedOut, name))) throw new Error(`Staged artifact missing: ${name}`);
  }

  const stagedTiles = path.join(stagedOut, 'ctxtiles', slug);
  if (!fs.existsSync(path.join(stagedTiles, 'index.json.gz'))) {
    throw new Error(`Staged context tile index missing for ${slug}`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const txId = `ua-context-${slug}-${Date.now()}-${process.pid}`;
  const entries = [
    {
      label: 'context tiles',
      source: stagedTiles,
      destination: path.join(outputDir, 'ctxtiles', slug),
      directory: true,
    },
    ...required.map(name => ({
      label: name,
      source: path.join(stagedOut, name),
      destination: path.join(outputDir, name),
      directory: false,
    })),
    ...required.map(name => ({
      label: `remove stale raw ${name.replace(/\.gz$/, '')}`,
      source: null,
      destination: path.join(outputDir, name.replace(/\.gz$/, '')),
      directory: false,
    })),
  ];

  for (const entry of entries) prepareTransactionEntry(entry, txId);

  try {
    // Phase 1: move every existing public destination out of the way. No new
    // data is visible until all old paths have a recoverable backup.
    for (const entry of entries) {
      if (fs.existsSync(entry.destination)) {
        fs.renameSync(entry.destination, entry.backup);
        entry.backedUp = true;
      }
    }

    // Phase 2: install all staged paths. Entries without a source represent
    // transactional deletions of stale raw files.
    let step = 0;
    for (const entry of entries) {
      if (entry.source) fs.renameSync(entry.incoming, entry.destination);
      entry.installed = true;
      step += 1;
      if (typeof opts.onCommitStep === 'function') opts.onCommitStep({ step, entry });
    }

    // Only after every destination is in place can old backups be discarded.
    for (const entry of entries) removePath(entry.backup);
  } catch (error) {
    // Roll back in reverse order. Destinations whose backup phase was never
    // reached remain untouched because `backedUp` is false.
    for (const entry of entries.slice().reverse()) {
      if (entry.installed && fs.existsSync(entry.destination)) removePath(entry.destination);
      if (entry.backedUp && fs.existsSync(entry.backup)) {
        fs.renameSync(entry.backup, entry.destination);
      }
      removePath(entry.incoming);
    }
    throw error;
  } finally {
    for (const entry of entries) {
      removePath(entry.incoming);
      removePath(entry.backup);
    }
  }
}

async function generateContextCity(options) {
  const args = { ...options };
  const resolved = resolveCanonicalCity(args.root, args.city);
  const city = resolved.city;
  const slug = resolved.slug;
  const runId = `${slug}-${Date.now()}-${process.pid}`;
  const runRoot = path.join(args.workDir, runId);
  const producerRoot = path.join(runRoot, 'producer-root');
  const producerInput = path.join(producerRoot, 'out');
  const stagedOut = path.join(runRoot, 'out');
  const dirs = {
    osmDir: path.join(args.cacheDir, 'osm'),
    demDir: path.join(args.cacheDir, 'dem'),
    trafficDir: path.join(args.cacheDir, 'traffic'),
    tilesDir: path.join(args.cacheDir, 'dem-tiles'),
  };

  fs.mkdirSync(producerInput, { recursive: true });
  fs.mkdirSync(stagedOut, { recursive: true });
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  try {
    const logicalGeoJson = `output_all_years_${slug}.geojson`;
    copyLogicalArtifact(args.inputDir, producerInput, logicalGeoJson);
    const logicalInput = path.join(producerInput, logicalGeoJson);
    const inputValidation = validateGeoJsonArtifact(logicalInput, { minFeatures: 1 });
    if (!inputValidation.ok) throw new Error(`Invalid accident GeoJSON for ${city}: ${inputValidation.errors.join('; ')}`);
    const inputFingerprint = fingerprintJsonArtifact(logicalInput);

    const osmFile = path.join(dirs.osmDir, `osm_${slug}.json`);
    const demFile = path.join(dirs.demDir, `dem_${slug}.json`);
    const trafficFile = path.join(dirs.trafficDir, `traffic_${slug}.json`);

    console.log(`[context-generation] ${city}: OSM road network`);
    const forceOsm = args.force || !producerDatasetIsCurrent(osmFile, validateOsm, inputFingerprint);
    const osmResult = await osmProducer.produceCity(producerRoot, slug, {
      outDir: dirs.osmDir,
      force: forceOsm,
      interTileDelayMs: 1000,
    });
    assertProducerResult('OSM', osmResult, osmFile);
    stampProducerDataset(osmFile, inputFingerprint);
    const osmRegenerated = !(osmResult && osmResult.skipped);

    console.log(`[context-generation] ${city}: SRTM tiles`);
    const tileResult = await demTileProducer.downloadTilesForCities(producerRoot, [slug], dirs.tilesDir, {
      force: false,
      silent: false,
    });
    if (!tileResult || tileResult.errors > 0) {
      throw new Error(`DEM tile download failed (${tileResult ? tileResult.errors : 'unknown'} errors)`);
    }

    console.log(`[context-generation] ${city}: elevation and slope`);
    const forceDem = args.force || osmRegenerated || !producerDatasetIsCurrent(demFile, validateDem, inputFingerprint);
    const demResult = await demProducer.produceCity(producerRoot, slug, {
      outDir: dirs.demDir,
      osmDir: dirs.osmDir,
      tilesDir: dirs.tilesDir,
      force: forceDem,
    });
    assertProducerResult('DEM', demResult, demFile);
    stampProducerDataset(demFile, inputFingerprint);

    console.log(`[context-generation] ${city}: traffic proxy`);
    const forceTraffic = args.force || osmRegenerated || !producerDatasetIsCurrent(trafficFile, validateTraffic, inputFingerprint);
    const trafficResult = trafficProducer.produceCity(producerRoot, slug, {
      outDir: dirs.trafficDir,
      osmDir: dirs.osmDir,
      force: forceTraffic,
    });
    assertProducerResult('Traffic', trafficResult, trafficFile);
    stampProducerDataset(trafficFile, inputFingerprint);

    const preflight = validateCityInputs(city, dirs, { expectedFingerprint: inputFingerprint });
    if (!preflight.ok) throw new Error(`Producer preflight failed: ${preflight.problems.join('; ')}`);

    console.log(`[context-generation] ${city}: enrich in staging`);
    const enrichment = withProviderEnvironment(dirs, () => enricher.enrichCityFile(slug, {
      inputDir: producerInput,
      outputDir: stagedOut,
    }));
    if (enrichment.skipped || !enrichment.wroteCompanions) {
      throw new Error(`Enrichment produced no context data: ${enrichment.reason || 'no companions'}`);
    }

    const validation = validateContextDatasets(runRoot);
    if (validation.summary.total !== 1 || validation.summary.failed !== 0) {
      const details = validation.cities.flatMap(item => item.problems || []).join('; ');
      throw new Error(`Staged context validation failed: ${details || JSON.stringify(validation.summary)}`);
    }

    gzipGeneratedTree(stagedOut);
    installGeneratedCity(stagedOut, args.outputDir, slug);
    console.log(`[context-generation] ${city}: installed atomically`);

    return {
      city,
      slug,
      featureCount: inputValidation.featureCount,
      inputFingerprint,
      generatedAt: enrichment.meta && enrichment.meta.generatedAt,
      counts: enrichment.meta && enrichment.meta.counts,
      cacheDir: args.cacheDir,
      outputDir: args.outputDir,
    };
  } finally {
    if (!args.keepWork) fs.rmSync(runRoot, { recursive: true, force: true });
  }
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/generate-context-city.js --city <name> [options]\n\n` +
    `  --input-dir <dir>   accident GeoJSON source (default: out)\n` +
    `  --output-dir <dir>  generated public data target (default: out)\n` +
    `  --cache-dir <dir>   reusable producer cache (default: .enrichment-cache)\n` +
    `  --work-dir <dir>    staging root (default: .build/context-generation)\n` +
    `  --force             rebuild OSM/DEM/traffic producer files\n` +
    `  --keep-work         retain staging files for diagnostics\n` +
    `  --json              print final result as JSON\n`);
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  try {
    const result = await generateContextCity(args);
    if (args.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    console.error(`[context-generation] FAILED: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}

module.exports = {
  parseArgs,
  resolveCanonicalCity,
  copyLogicalArtifact,
  assertProducerResult,
  producerDatasetIsCurrent,
  stampProducerDataset,
  gzipGeneratedTree,
  installGeneratedCity,
  generateContextCity,
  main,
};
