#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { readJsonMaybeGz, readTextMaybeGz } = require('./lib/read-json-maybe-gz');
const { writeTextArtifact } = require('./lib/static-data-compression');

function parseArgs(argv) {
  const args = {
    root: null,
    inputDir: 'out',
    poiDir: 'out',
    outputDir: '_site/out',
    manifest: '_site/out/data-manifest.json',
    gzipOnly: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input-dir') args.inputDir = argv[++i] || args.inputDir;
    else if (a === '--root') args.root = argv[++i] || null;
    else if (a === '--poi-dir') args.poiDir = argv[++i] || args.poiDir;
    else if (a === '--output-dir') args.outputDir = argv[++i] || args.outputDir;
    else if (a === '--manifest') args.manifest = argv[++i] || args.manifest;
    else if (a === '--gzip-only') args.gzipOnly = true;
  }

  return args;
}

function listFiles(dir, predicate) {
  const out = [];
  if (!fs.existsSync(dir)) return out;

  const walk = (base) => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      const abs = path.join(base, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (predicate(abs)) out.push(abs);
    }
  };

  walk(dir);
  return out.sort();
}

function cityFromFile(fileName, prefix, suffix) {
  if (!fileName.startsWith(prefix) || !fileName.endsWith(suffix)) return null;
  return fileName.slice(prefix.length, fileName.length - suffix.length);
}

function logicalFromAbsolute(absPath, baseDir, outPrefix = 'out') {
  const rel = path.relative(baseDir, absPath).replace(/\\/g, '/');
  return `${outPrefix}/${rel}`;
}

function writeCompressedJsonFromLogical(logicalPath, sourceBaseDir, outputDir, rootDir) {
  const rel = logicalPath.replace(/^out\//, '');
  const sourceLogical = path.join(sourceBaseDir, rel);
  const json = readJsonMaybeGz(sourceLogical);
  const text = JSON.stringify(json);

  const targetAbs = path.join(outputDir, rel);
  writeTextArtifact(targetAbs, text, { compression: 'gzip-only', root: rootDir });

  return { json, targetAbs };
}

function sha256File(filePath) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(filePath));
  return h.digest('hex');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyJsonTree(files, sourceDir, outputDir, repoRoot, processed) {
  for (const abs of files) {
    const rel = path.relative(sourceDir, abs).replace(/\\/g, '/').replace(/\.gz$/i, '');
    const logicalPath = `out/${rel}`;
    if (processed.has(logicalPath)) continue;

    const sourceLogical = path.join(sourceDir, rel);
    const text = readTextMaybeGz(sourceLogical);
    const targetAbs = path.join(outputDir, rel);
    writeTextArtifact(targetAbs, text, { compression: 'gzip-only', root: repoRoot });
    processed.add(logicalPath);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const repoRoot = args.root ? path.resolve(args.root) : path.resolve(__dirname, '..');
  const inputDir = path.resolve(repoRoot, args.inputDir);
  const poiDir = path.resolve(repoRoot, args.poiDir);
  const outputDir = path.resolve(repoRoot, args.outputDir);
  const manifestPath = path.resolve(repoRoot, args.manifest);

  if (!args.gzipOnly) {
    throw new Error('[build-static-data] This script currently supports only --gzip-only mode.');
  }

  ensureDir(outputDir);

  const accidentFiles = listFiles(inputDir, (abs) => /output_all_years_[^.]+\.geojson(\.gz)?$/i.test(path.basename(abs)));
  const metaFiles = listFiles(inputDir, (abs) => /output_all_years_[^.]+\.enrichment\.meta\.json(\.gz)?$/i.test(path.basename(abs)));
  const waysFiles = listFiles(inputDir, (abs) => /ways_[^.]+\.json(\.gz)?$/i.test(path.basename(abs)));
  const contextTileFiles = listFiles(path.join(inputDir, 'ctxtiles'), (abs) => /\.json(\.gz)?$/i.test(abs));
  const accidentTileFiles = listFiles(path.join(inputDir, 'accidenttiles'), (abs) => /\.json(\.gz)?$/i.test(abs));
  const poiFiles = listFiles(poiDir, (abs) => /poi_[^.]+\.geojson(\.gz)?$/i.test(path.basename(abs)));

  const processed = new Set();
  const manifest = {
    schemaVersion: 2,
    dataMode: 'gzip-only',
    // Keep repeated builds byte-for-byte stable. Source datasets carry their
    // own acquisition/enrichment timestamps; this deployment manifest records
    // composition and fingerprints rather than wall-clock build time.
    generatedAt: null,
    cities: {},
  };

  const ensureCity = (slug) => {
    if (!manifest.cities[slug]) manifest.cities[slug] = {};
    return manifest.cities[slug];
  };

  for (const abs of accidentFiles) {
    const base = path.basename(abs).replace(/\.gz$/i, '');
    const slug = cityFromFile(base, 'output_all_years_', '.geojson');
    if (!slug) continue;
    const city = ensureCity(slug);
    const logicalPath = `out/output_all_years_${slug}.geojson`;
    if (processed.has(logicalPath)) continue;

    const { json, targetAbs } = writeCompressedJsonFromLogical(logicalPath, inputDir, outputDir, repoRoot);
    const gzAbs = `${targetAbs}.gz`;
    city.accidents = {
      logicalPath,
      gzipPath: `${logicalPath}.gz`,
      features: Array.isArray(json.features) ? json.features.length : 0,
      sha256: sha256File(gzAbs),
    };
    processed.add(logicalPath);
  }

  for (const abs of poiFiles) {
    const base = path.basename(abs).replace(/\.gz$/i, '');
    const slug = cityFromFile(base, 'poi_', '.geojson');
    if (!slug) continue;
    const city = ensureCity(slug);
    const logicalPath = `out/poi_${slug}.geojson`;
    if (processed.has(logicalPath)) continue;

    const { json } = writeCompressedJsonFromLogical(logicalPath, poiDir, outputDir, repoRoot);
    city.poi = {
      gzipPath: `${logicalPath}.gz`,
      features: Array.isArray(json.features) ? json.features.length : 0,
    };
    processed.add(logicalPath);
  }

  for (const abs of waysFiles) {
    const base = path.basename(abs).replace(/\.gz$/i, '');
    const slug = cityFromFile(base, 'ways_', '.json');
    if (!slug) continue;
    const logicalPath = `out/ways_${slug}.json`;
    if (processed.has(logicalPath)) continue;
    writeCompressedJsonFromLogical(logicalPath, inputDir, outputDir, repoRoot);
    processed.add(logicalPath);
  }

  for (const abs of metaFiles) {
    const base = path.basename(abs).replace(/\.gz$/i, '');
    const slug = cityFromFile(base, 'output_all_years_', '.enrichment.meta.json');
    if (!slug) continue;
    const city = ensureCity(slug);
    const logicalPath = `out/output_all_years_${slug}.enrichment.meta.json`;
    if (processed.has(logicalPath)) continue;

    const { json } = writeCompressedJsonFromLogical(logicalPath, inputDir, outputDir, repoRoot);
    city.enrichment = {
      metaPath: `${logicalPath}.gz`,
      hasElevation: Number((json?.counts || {}).withElevation || 0) > 0,
      hasSlope: Number((json?.slope || {}).withSlope || 0) > 0,
      hasTrafficProxy: Number((json?.counts || {}).withTrafficProxy || 0) > 0,
      contextTiles: Number((json?.counts || {}).contextTiles || 0),
    };
    processed.add(logicalPath);
  }

  copyJsonTree(contextTileFiles, inputDir, outputDir, repoRoot, processed);
  copyJsonTree(accidentTileFiles, inputDir, outputDir, repoRoot, processed);

  for (const abs of accidentTileFiles) {
    const rel = path.relative(inputDir, abs).replace(/\\/g, '/').replace(/\.gz$/i, '');
    const match = /^accidenttiles\/([^/]+)\/index\.json$/i.exec(rel);
    if (!match) continue;
    const slug = match[1];
    const json = readJsonMaybeGz(path.join(inputDir, rel));
    ensureCity(slug).accidentTiles = {
      manifestPath: `out/${rel}.gz`,
      z: json.z,
      tiles: Array.isArray(json.tiles) ? json.tiles.length : 0,
      features: Number(json.totalCount || 0),
      sourceFingerprint: json.sourceFingerprint || null,
    };
  }

  ensureDir(path.dirname(manifestPath));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  process.stdout.write(
    `[build-static-data] Wrote ${processed.size} gzip artefacts and manifest ${path.relative(repoRoot, manifestPath)}\n`
  );
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseArgs,
  main,
  cityFromFile,
  logicalFromAbsolute,
  copyJsonTree,
};
