#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  slugify,
  readCitiesFile,
  validateGeoJsonArtifact,
} = require('./lib/static-data-validation');

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, '..'),
    citiesFile: 'cities.txt',
    outDir: 'out',
    tempRoot: '.build/raw',
    minFeatures: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = path.resolve(argv[++i] || args.root);
    else if (arg === '--cities-file') args.citiesFile = argv[++i] || args.citiesFile;
    else if (arg === '--out-dir') args.outDir = argv[++i] || args.outDir;
    else if (arg === '--temp-root') args.tempRoot = argv[++i] || args.tempRoot;
    else if (arg === '--min-features') args.minFeatures = Number.parseInt(argv[++i] || '0', 10);
  }

  if (!Number.isFinite(args.minFeatures) || args.minFeatures < 0) {
    throw new Error('[generate-accident-data] --min-features must be a non-negative integer');
  }

  args.citiesFile = path.resolve(args.root, args.citiesFile);
  args.outDir = path.resolve(args.root, args.outDir);
  args.tempRoot = path.resolve(args.root, args.tempRoot);
  return args;
}

function isExistingArtifactValid(outDir, city, minFeatures) {
  const slug = slugify(city);
  const logicalPath = path.join(outDir, `output_all_years_${slug}.geojson`);
  const validation = validateGeoJsonArtifact(logicalPath, {
    gzipOnly: false,
    minFeatures,
  });
  return validation.ok;
}

function syncZipCache(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) return;
  fs.mkdirSync(targetDir, { recursive: true });
  for (const name of fs.readdirSync(sourceDir)) {
    if (!/\.zip$/i.test(name)) continue;
    fs.copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
  }
}

function stageCityOutputs(repoRoot, city, tempRoot, minFeatures) {
  const slug = slugify(city);
  const cityTempDir = path.join(tempRoot, slug);
  const downloadCacheDir = path.join(tempRoot, 'download-cache');
  fs.rmSync(cityTempDir, { recursive: true, force: true });
  fs.mkdirSync(cityTempDir, { recursive: true });
  syncZipCache(downloadCacheDir, cityTempDir);

  const result = spawnSync(
    path.join(repoRoot, 'convertAmt2gmaps.sh'),
    ['--outdir', cityTempDir, '--limit', '0', '--city', city, '--rad', '', '--pkw', '', '--fuss', '', '--krad', ''],
    {
      cwd: repoRoot,
      stdio: 'inherit',
    }
  );

  if (result.status !== 0) {
    throw new Error(`[generate-accident-data] convertAmt2gmaps.sh failed for ${city}`);
  }

  const geojsonPath = path.join(cityTempDir, `output_all_years_${slug}.geojson`);
  const csvPath = path.join(cityTempDir, `output_all_years_${slug}.csv`);
  if (!fs.existsSync(geojsonPath)) {
    throw new Error(`[generate-accident-data] Missing staged GeoJSON for ${city}: ${geojsonPath}`);
  }
  if (!fs.existsSync(csvPath)) {
    throw new Error(`[generate-accident-data] Missing staged CSV for ${city}: ${csvPath}`);
  }

  const validation = validateGeoJsonArtifact(geojsonPath, {
    gzipOnly: false,
    minFeatures,
  });
  if (!validation.ok) {
    throw new Error(
      `[generate-accident-data] Invalid staged GeoJSON for ${city}: ${validation.errors.join('; ')}`
    );
  }

  syncZipCache(cityTempDir, downloadCacheDir);

  return { slug, cityTempDir, geojsonPath, csvPath, featureCount: validation.featureCount };
}

function installCityOutputs(outDir, staged) {
  fs.mkdirSync(outDir, { recursive: true });

  const targets = [
    { source: staged.geojsonPath, destination: path.join(outDir, path.basename(staged.geojsonPath)) },
    { source: staged.csvPath, destination: path.join(outDir, path.basename(staged.csvPath)) },
  ];

  for (const file of targets) {
    fs.copyFileSync(file.source, file.destination);
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const cities = readCitiesFile(args.citiesFile);
  fs.mkdirSync(args.tempRoot, { recursive: true });
  fs.mkdirSync(args.outDir, { recursive: true });

  let regenerated = 0;
  let skipped = 0;

  for (const city of cities) {
    if (isExistingArtifactValid(args.outDir, city, args.minFeatures)) {
      skipped += 1;
      process.stdout.write(`[generate-accident-data] SKIP ${city} (existing artefact is valid)\n`);
      continue;
    }

    const staged = stageCityOutputs(args.root, city, args.tempRoot, args.minFeatures);
    installCityOutputs(args.outDir, staged);
    regenerated += 1;
    process.stdout.write(
      `[generate-accident-data] OK ${city} -> out/output_all_years_${staged.slug}.geojson (${staged.featureCount} features)\n`
    );
  }

  process.stdout.write(
    `[generate-accident-data] Done: ${cities.length} cities (${skipped} skipped, ${regenerated} regenerated)\n`
  );
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  parseArgs,
  isExistingArtifactValid,
  stageCityOutputs,
  installCityOutputs,
  main,
};
