#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { readJsonMaybeGz } = require('./lib/read-json-maybe-gz');
const { writeJsonArtifact } = require('./lib/static-data-compression');
const { readCitiesFile, slugify } = require('./lib/static-data-validation');

const PRODUCER_VERSION = '1.2.0';
const SCHEMA_VERSION = 2;
const DEFAULT_ZOOM = 13;
const EXPLICIT_ID_KEYS = Object.freeze([
  'id', 'ID', 'objectid', 'OBJECTID', 'uid', 'UID',
  'unfall_id', 'UNFALL_ID', 'uidentstlae', 'UIDENTSTLAE',
]);
const YEAR_KEYS = Object.freeze([
  'year', 'YEAR', 'ujahr', 'UJAHR', 'jahr', 'JAHR',
  'sourceYear', 'source_year',
]);

function parseArgs(argv) {
  const root = path.resolve(__dirname, '..');
  const args = {
    root,
    inputDir: path.join(root, 'out'),
    outputDir: path.join(root, 'out'),
    citiesFile: path.join(root, 'cities.txt'),
    cities: [],
    zoom: DEFAULT_ZOOM,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') args.root = path.resolve(argv[++index] || root);
    else if (arg === '--input-dir') args.inputDir = path.resolve(args.root, argv[++index] || 'out');
    else if (arg === '--output-dir') args.outputDir = path.resolve(args.root, argv[++index] || 'out');
    else if (arg === '--cities-file') args.citiesFile = path.resolve(args.root, argv[++index] || 'cities.txt');
    else if (arg === '--city') args.cities.push(argv[++index]);
    else if (arg === '--zoom') args.zoom = Number.parseInt(argv[++index], 10);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`[build-accident-tiles] Unknown argument: ${arg}`);
  }

  if (!Number.isInteger(args.zoom) || args.zoom < 0 || args.zoom > 22) {
    throw new Error('[build-accident-tiles] --zoom must be an integer from 0 to 22');
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/build-accident-tiles.js [options]',
    '',
    'Options:',
    '  --city <name>       Process one city (repeatable; default: cities.txt)',
    '  --input-dir <dir>   Full-city GeoJSON source directory (default: out)',
    '  --output-dir <dir>  Output root containing accidenttiles/ (default: out)',
    '  --zoom <n>          Slippy-tile zoom (default: 13)',
    '  --cities-file <p>   City list used when --city is omitted',
    '  --root <dir>        Repository root',
  ].join('\n');
}

function lonToTileX(lon, zoom) {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function latToTileY(lat, zoom) {
  const bounded = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radians = bounded * Math.PI / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2)
      * Math.pow(2, zoom)
  );
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalFeatureYear(properties) {
  for (const key of YEAR_KEYS) {
    const raw = properties[key];
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (/^(?:18|19|20|21)\d{2}$/.test(value)) return value;
  }
  return null;
}

function explicitFeatureIdentity(key, value, properties) {
  const normalized = String(value).trim();
  const year = canonicalFeatureYear(properties);
  // IDs in the all-years accident exports are only unique within one source
  // year. Keep the legacy representation for sources without a trustworthy
  // year, so duplicates still fail closed instead of being guessed apart.
  return year ? `${key}:${year}:${normalized}` : `${key}:${normalized}`;
}

function canonicalFeatureIdentity(feature) {
  const properties = feature && feature.properties && typeof feature.properties === 'object'
    ? feature.properties
    : {};
  if (feature && feature.id !== undefined && feature.id !== null && String(feature.id).trim()) {
    return {
      key: explicitFeatureIdentity('feature.id', feature.id, properties),
      explicit: true,
    };
  }
  for (const key of EXPLICIT_ID_KEYS) {
    if (properties[key] !== undefined && properties[key] !== null && String(properties[key]).trim()) {
      return {
        key: explicitFeatureIdentity(key, properties[key], properties),
        explicit: true,
      };
    }
  }
  const canonical = JSON.stringify({
    geometry: feature && feature.geometry,
    properties,
  });
  return { key: `derived:${sha256(canonical)}`, explicit: false };
}

function validateFeature(feature, index) {
  if (!feature || feature.type !== 'Feature') {
    throw new Error(`feature ${index} is not a GeoJSON Feature`);
  }
  const geometry = feature.geometry;
  if (!geometry || geometry.type !== 'Point' || !Array.isArray(geometry.coordinates)) {
    throw new Error(`feature ${index} is not a Point geometry`);
  }
  const [lon, lat] = geometry.coordinates;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)
      || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
    throw new Error(`feature ${index} has invalid coordinates`);
  }
  return { lon, lat };
}

function buildTilePlan(geojson, city, zoom) {
  if (!geojson || geojson.type !== 'FeatureCollection' || !Array.isArray(geojson.features)) {
    throw new Error(`${city}: source is not a FeatureCollection`);
  }

  const byTile = new Map();
  const identities = new Map();
  let explicitIdCount = 0;
  let derivedIdCount = 0;

  geojson.features.forEach((feature, index) => {
    const { lon, lat } = validateFeature(feature, index);
    const identity = canonicalFeatureIdentity(feature);
    if (identities.has(identity.key)) {
      throw new Error(
        `${city}: duplicate feature identity ${identity.key} at indexes `
        + `${identities.get(identity.key)} and ${index}`
      );
    }
    identities.set(identity.key, index);
    if (identity.explicit) explicitIdCount += 1;
    else derivedIdCount += 1;

    const x = lonToTileX(lon, zoom);
    const y = latToTileY(lat, zoom);
    const key = `${x}/${y}`;
    if (!byTile.has(key)) {
      byTile.set(key, { x, y, features: [], featureIdentities: [] });
    }
    byTile.get(key).features.push(feature);
    byTile.get(key).featureIdentities.push(identity.key);
  });

  const tiles = Array.from(byTile.values())
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const sourceFingerprint = sha256(JSON.stringify(geojson));
  return {
    sourceFingerprint,
    sourceProperties: geojson.properties && typeof geojson.properties === 'object'
      ? geojson.properties
      : null,
    totalCount: geojson.features.length,
    explicitIdCount,
    derivedIdCount,
    tiles,
  };
}

function tilePayload(slug, zoom, tile, sourceProperties) {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    city: slug,
    z: zoom,
    x: tile.x,
    y: tile.y,
    type: 'FeatureCollection',
    features: tile.features,
    // Stable producer identities let the runtime deduplicate across repeated
    // and overlapping viewport tile requests without re-hashing application data.
    featureIdentities: tile.featureIdentities,
  };
  if (sourceProperties) payload.properties = sourceProperties;
  return payload;
}

function writeStagedCity(stageRoot, outputRoot, city, slug, zoom, plan) {
  const cityDir = path.join(stageRoot, 'accidenttiles', slug);
  for (const tile of plan.tiles) {
    const logical = path.join(cityDir, String(zoom), String(tile.x), `${tile.y}.json`);
    writeJsonArtifact(logical, tilePayload(slug, zoom, tile, plan.sourceProperties), {
      compression: 'gzip-only',
      root: outputRoot,
    });
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    producerVersion: PRODUCER_VERSION,
    city: slug,
    z: zoom,
    sourceFingerprint: plan.sourceFingerprint,
    totalCount: plan.totalCount,
    explicitIdCount: plan.explicitIdCount,
    derivedIdCount: plan.derivedIdCount,
    tiles: plan.tiles.map(tile => ({ x: tile.x, y: tile.y, count: tile.features.length })),
  };
  writeJsonArtifact(path.join(cityDir, 'index.json'), manifest, {
    compression: 'gzip-only',
    root: outputRoot,
  });
  return { cityDir, manifest };
}

function readGzipJson(filePath) {
  return readJsonMaybeGz(filePath.replace(/\.gz$/i, ''));
}

function validateStagedCity(cityDir, manifest, expectedCount) {
  const rawFiles = [];
  const gzipFiles = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.name.endsWith('.gz')) gzipFiles.push(absolute);
      else rawFiles.push(absolute);
    }
  };
  walk(cityDir);
  if (rawFiles.length > 0) {
    throw new Error(`raw tile artefacts remain: ${rawFiles.join(', ')}`);
  }

  const indexPath = path.join(cityDir, 'index.json.gz');
  if (!fs.existsSync(indexPath)) throw new Error('missing gzip tile manifest');
  const persistedManifest = readGzipJson(indexPath);
  if (persistedManifest.schemaVersion !== SCHEMA_VERSION
      || persistedManifest.totalCount !== expectedCount) {
    throw new Error('persisted manifest does not match source count/schema');
  }

  let count = 0;
  const persistedIdentities = new Set();
  for (const tile of manifest.tiles) {
    const tilePath = path.join(cityDir, String(manifest.z), String(tile.x), `${tile.y}.json.gz`);
    if (!fs.existsSync(tilePath)) throw new Error(`missing tile ${tile.x}/${tile.y}`);
    const payload = readGzipJson(tilePath);
    if (payload.type !== 'FeatureCollection' || payload.city !== manifest.city
        || payload.z !== manifest.z || payload.x !== tile.x || payload.y !== tile.y
        || !Array.isArray(payload.features) || payload.features.length !== tile.count
        || !Array.isArray(payload.featureIdentities)
        || payload.featureIdentities.length !== payload.features.length) {
      throw new Error(`invalid tile payload ${tile.x}/${tile.y}`);
    }
    for (const identity of payload.featureIdentities) {
      if (typeof identity !== 'string' || !identity) {
        throw new Error(`invalid feature identity in tile ${tile.x}/${tile.y}`);
      }
      if (persistedIdentities.has(identity)) {
        throw new Error(`duplicate persisted feature identity ${identity}`);
      }
      persistedIdentities.add(identity);
    }
    count += payload.features.length;
  }
  if (count !== expectedCount || persistedIdentities.size !== expectedCount) {
    throw new Error(
      `tile identity/feature total ${persistedIdentities.size}/${count} does not equal source total ${expectedCount}`
    );
  }
  if (gzipFiles.length !== manifest.tiles.length + 1) {
    throw new Error('unexpected gzip artefact count in staged tree');
  }
  return { tileCount: manifest.tiles.length, featureCount: count };
}

function installStagedCity(outputDir, slug, stagedCityDir, hooks = {}) {
  const parent = path.join(outputDir, 'accidenttiles');
  const target = path.join(parent, slug);
  const backup = path.join(parent, `.${slug}.backup-${process.pid}-${Date.now()}`);
  fs.mkdirSync(parent, { recursive: true });
  let backedUp = false;
  try {
    if (fs.existsSync(target)) {
      fs.renameSync(target, backup);
      backedUp = true;
    }
    if (typeof hooks.beforeInstall === 'function') hooks.beforeInstall({ target, backup });
    fs.renameSync(stagedCityDir, target);
    if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    if (backedUp && fs.existsSync(backup)) fs.renameSync(backup, target);
    throw error;
  }
  return target;
}

function buildCity(options) {
  const city = options.city;
  const slug = slugify(city);
  const sourceLogical = path.join(options.inputDir, `output_all_years_${slug}.geojson`);
  const geojson = readJsonMaybeGz(sourceLogical);
  const plan = buildTilePlan(geojson, city, options.zoom);
  const stageRoot = fs.mkdtempSync(path.join(options.outputDir, '.accidenttiles-stage-'));
  try {
    const staged = writeStagedCity(stageRoot, options.outputDir, city, slug, options.zoom, plan);
    const validation = validateStagedCity(staged.cityDir, staged.manifest, plan.totalCount);
    installStagedCity(options.outputDir, slug, staged.cityDir, options.hooks);
    return {
      city,
      slug,
      zoom: options.zoom,
      sourceFingerprint: plan.sourceFingerprint,
      explicitIdCount: plan.explicitIdCount,
      derivedIdCount: plan.derivedIdCount,
      ...validation,
    };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  fs.mkdirSync(args.outputDir, { recursive: true });
  const cities = args.cities.length > 0 ? args.cities : readCitiesFile(args.citiesFile);
  if (cities.length === 0) throw new Error('[build-accident-tiles] no cities selected');

  for (const city of cities) {
    const result = buildCity({
      city,
      inputDir: args.inputDir,
      outputDir: args.outputDir,
      zoom: args.zoom,
    });
    process.stdout.write(
      `[build-accident-tiles] OK ${city}: ${result.featureCount} features in `
      + `${result.tileCount} gzip tiles at z=${result.zoom}\n`
    );
  }
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) {
    process.stderr.write(`[build-accident-tiles] ${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  PRODUCER_VERSION,
  SCHEMA_VERSION,
  DEFAULT_ZOOM,
  parseArgs,
  lonToTileX,
  latToTileY,
  canonicalFeatureIdentity,
  buildTilePlan,
  validateStagedCity,
  installStagedCity,
  buildCity,
  main,
};
