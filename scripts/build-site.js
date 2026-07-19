#!/usr/bin/env node
'use strict';

/**
 * Canonical static-site build used by Pages, Playwright and screenshot QA.
 *
 * The checked-in HTML intentionally references `vendor/…`; this command is
 * the only place that materialises those browser assets from package-lock.json.
 * No runtime JavaScript dependency is fetched from a CDN.
 */

const crypto = require('crypto');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const { main: buildStaticData } = require('./build-static-data');
const { validateStaticData } = require('./validate-static-data');

const STATIC_ENTRIES = Object.freeze([
  '.zenodo.json',
  'ARCHITECTURE.md',
  'CITATION.cff',
  'CITATION.md',
  'LICENSE',
  'README.md',
  'TESTING.md',
  'WERKBANK_V2.md',
  'codemeta.json',
  'index.html',
  'combi.html',
  'showcase.html',
  'unfallwerkbank.html',
  'werkbank.html',
  'werkbank_v2.html',
  'cities.txt',
  'css',
  'data',
  'docs',
  'js',
  'templates',
  'tours',
  'usage.md',
]);

const VENDOR_ASSETS = Object.freeze([
  ['leaflet', 'dist/leaflet.js', 'vendor/leaflet/leaflet.js'],
  ['leaflet', 'dist/leaflet.css', 'vendor/leaflet/leaflet.css'],
  ['leaflet', 'dist/images/layers.png', 'vendor/leaflet/images/layers.png'],
  ['leaflet', 'dist/images/layers-2x.png', 'vendor/leaflet/images/layers-2x.png'],
  ['leaflet', 'dist/images/marker-icon.png', 'vendor/leaflet/images/marker-icon.png'],
  ['leaflet', 'dist/images/marker-icon-2x.png', 'vendor/leaflet/images/marker-icon-2x.png'],
  ['leaflet', 'dist/images/marker-shadow.png', 'vendor/leaflet/images/marker-shadow.png'],
  ['leaflet.markercluster', 'dist/MarkerCluster.css', 'vendor/leaflet.markercluster/MarkerCluster.css'],
  ['leaflet.markercluster', 'dist/MarkerCluster.Default.css', 'vendor/leaflet.markercluster/MarkerCluster.Default.css'],
  ['leaflet.markercluster', 'dist/leaflet.markercluster.js', 'vendor/leaflet.markercluster/leaflet.markercluster.js'],
  ['leaflet.heat', 'dist/leaflet-heat.js', 'vendor/leaflet.heat/leaflet-heat.js'],
  ['leaflet-draw', 'dist/leaflet.draw.css', 'vendor/leaflet-draw/leaflet.draw.css'],
  ['leaflet-draw', 'dist/leaflet.draw.js', 'vendor/leaflet-draw/leaflet.draw.js'],
  ['leaflet-draw', 'dist/images/spritesheet.png', 'vendor/leaflet-draw/images/spritesheet.png'],
  ['leaflet-draw', 'dist/images/spritesheet-2x.png', 'vendor/leaflet-draw/images/spritesheet-2x.png'],
  ['leaflet-draw', 'dist/images/spritesheet.svg', 'vendor/leaflet-draw/images/spritesheet.svg'],
  ['leaflet-image', 'leaflet-image.js', 'vendor/leaflet-image/leaflet-image.js'],
  ['docx', 'dist/index.iife.js', 'vendor/export/docx.js'],
  ['pdfmake', 'build/pdfmake.min.js', 'vendor/export/pdfmake.js'],
  ['pdfmake', 'build/vfs_fonts.js', 'vendor/export/pdfmake-fonts.js'],
  ['file-saver', 'dist/FileSaver.min.js', 'vendor/export/file-saver.js'],
]);

// SPDX identifiers and license texts are resolved only from the exact packages
// installed by `npm ci`. Some upstream npm archives contain only package.json
// license metadata; that distinction is preserved in the generated notices.
const VENDOR_LICENSES = Object.freeze({
  leaflet: Object.freeze({ spdx: 'BSD-2-Clause', sourcePath: 'LICENSE' }),
  'leaflet.markercluster': Object.freeze({ spdx: 'MIT', sourcePath: 'MIT-LICENCE.txt' }),
  'leaflet.heat': Object.freeze({ spdx: 'BSD-2-Clause', sourcePath: 'LICENSE' }),
  'leaflet-draw': Object.freeze({ spdx: 'MIT', sourcePath: null }),
  'leaflet-image': Object.freeze({ spdx: 'BSD-2-Clause', sourcePath: null }),
  docx: Object.freeze({ spdx: 'MIT', sourcePath: 'LICENSE' }),
  pdfmake: Object.freeze({ spdx: 'MIT', sourcePath: 'LICENSE' }),
  'file-saver': Object.freeze({ spdx: 'MIT', sourcePath: 'LICENSE.md' }),
});

function parseArgs(argv) {
  const args = {
    root: null,
    inputDir: 'out',
    poiDir: 'out',
    outputDir: '_site',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i] || args.root;
    else if (arg === '--input-dir') args.inputDir = argv[++i] || args.inputDir;
    else if (arg === '--poi-dir') args.poiDir = argv[++i] || args.poiDir;
    else if (arg === '--output-dir') args.outputDir = argv[++i] || args.outputDir;
    else throw new Error(`[build-site] Unknown argument: ${arg}`);
  }
  return args;
}

function ensureInsideRoot(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[build-site] Refusing unsafe ${label}: ${target}`);
  }
}

function isSameOrInside(parent, target) {
  const relative = path.relative(parent, target);
  return !relative || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function pathsOverlap(left, right) {
  return isSameOrInside(left, right) || isSameOrInside(right, left);
}

function assertNoSymlinkComponents(root, target, label) {
  const relative = path.relative(root, target);
  let cursor = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) {
      throw new Error(`[build-site] Refusing symlinked ${label}: ${cursor}`);
    }
  }
}

function validateBuildPaths(repoRoot, finalOutputRoot, inputDir, poiDir) {
  ensureInsideRoot(repoRoot, finalOutputRoot, 'output directory');
  ensureInsideRoot(repoRoot, inputDir, 'input directory');
  ensureInsideRoot(repoRoot, poiDir, 'POI directory');
  assertNoSymlinkComponents(repoRoot, finalOutputRoot, 'output directory');
  assertNoSymlinkComponents(repoRoot, inputDir, 'input directory');
  assertNoSymlinkComponents(repoRoot, poiDir, 'POI directory');

  const canonicalOutput = path.join(repoRoot, '_site');
  const isolatedBuildRoot = path.join(repoRoot, '.build');
  const isCanonicalOutput = finalOutputRoot === canonicalOutput;
  const isIsolatedBuildOutput = finalOutputRoot !== isolatedBuildRoot &&
    isSameOrInside(isolatedBuildRoot, finalOutputRoot);
  if (!isCanonicalOutput && !isIsolatedBuildOutput) {
    throw new Error(
      '[build-site] Output must be the canonical _site directory or an isolated child of .build: ' +
      finalOutputRoot
    );
  }

  for (const [label, source] of [['input directory', inputDir], ['POI directory', poiDir]]) {
    if (pathsOverlap(finalOutputRoot, source)) {
      throw new Error(`[build-site] Output directory overlaps ${label}: ${source}`);
    }
  }
  for (const entry of STATIC_ENTRIES) {
    const source = path.join(repoRoot, entry);
    if (pathsOverlap(finalOutputRoot, source)) {
      throw new Error(`[build-site] Output directory overlaps static source: ${source}`);
    }
  }
}

function installBuiltSite(stagingRoot, finalOutputRoot, hooks = {}) {
  const renameSync = hooks.renameSync || fs.renameSync;
  const rmSync = hooks.rmSync || fs.rmSync;
  const existsSync = hooks.existsSync || fs.existsSync;
  const backupRoot = `${finalOutputRoot}.previous-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  let previousMoved = false;

  if (existsSync(backupRoot)) {
    throw new Error(`[build-site] Refusing occupied build backup path: ${backupRoot}`);
  }
  if (existsSync(finalOutputRoot)) {
    renameSync(finalOutputRoot, backupRoot);
    previousMoved = true;
  }

  try {
    renameSync(stagingRoot, finalOutputRoot);
  } catch (installError) {
    if (previousMoved) {
      try {
        if (existsSync(finalOutputRoot)) {
          throw new Error(`replacement unexpectedly exists at ${finalOutputRoot}`);
        }
        renameSync(backupRoot, finalOutputRoot);
        previousMoved = false;
      } catch (restoreError) {
        installError.message +=
          `; restoring the previous build failed (${restoreError.message}). ` +
          `The previous build remains at ${backupRoot}`;
      }
    }
    throw installError;
  }

  if (previousMoved) {
    try {
      rmSync(backupRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      process.stderr.write(
        `[build-site] New build installed, but previous build cleanup failed at ${backupRoot}: ` +
        `${cleanupError.message}\n`
      );
    }
  }
}

function assertSymlinkFreeTree(root, label = 'tree') {
  if (!fs.existsSync(root)) throw new Error(`[build-site] Missing ${label}: ${root}`);
  const visit = current => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`[build-site] Refusing symbolic link in ${label}: ${current}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort((a, b) => a.localeCompare(b))) {
        visit(path.join(current, entry));
      }
      return;
    }
    if (!stat.isFile()) {
      throw new Error(`[build-site] Refusing non-regular entry in ${label}: ${current}`);
    }
  };
  visit(root);
}

function copyEntry(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`[build-site] Missing static entry: ${source}`);
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    throw new Error(`[build-site] Refusing symbolic link while copying: ${source}`);
  }
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source).sort((a, b) => a.localeCompare(b))) {
      copyEntry(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`[build-site] Refusing non-regular entry while copying: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function resolveActualPackageManager() {
  const userAgent = String(process.env.npm_config_user_agent || '');
  const userAgentMatch = userAgent.match(/(?:^|\s)npm\/([^\s]+)/);
  const version = userAgentMatch
    ? userAgentMatch[1]
    : childProcess.execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`[build-site] Cannot determine the actual npm version: ${version || 'empty'}`);
  }
  return `npm@${version}`;
}

function listFiles(root) {
  const files = [];
  const visit = current => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`[build-site] Refusing symbolic link in build artifact: ${current}`);
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort((a, b) => a.localeCompare(b))) {
        visit(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      files.push(current);
    } else {
      throw new Error(`[build-site] Refusing non-regular build artifact: ${current}`);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return files;
}

function resolveLockedVersions(repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const packageNames = [...new Set(VENDOR_ASSETS.map(([packageName]) => packageName))].sort();
  return Object.fromEntries(packageNames.map(packageName => {
    const version = lock.packages && lock.packages[`node_modules/${packageName}`] &&
      lock.packages[`node_modules/${packageName}`].version;
    if (!version) throw new Error(`[build-site] ${packageName} is not pinned in package-lock.json`);
    return [packageName, version];
  }));
}

function copyVendorAssets(repoRoot, outputRoot) {
  const lockedVersions = resolveLockedVersions(repoRoot);
  for (const [packageName, lockedVersion] of Object.entries(lockedVersions)) {
    const installedPackage = path.join(repoRoot, 'node_modules', packageName, 'package.json');
    if (!fs.existsSync(installedPackage)) {
      throw new Error(`[build-site] Missing installed package metadata for ${packageName}. Run npm ci first.`);
    }
    const installedVersion = JSON.parse(fs.readFileSync(installedPackage, 'utf8')).version;
    if (installedVersion !== lockedVersion) {
      throw new Error(
        `[build-site] Installed ${packageName}@${installedVersion || 'unknown'} does not match lockfile ${lockedVersion}. ` +
        'Run npm ci before building.'
      );
    }
  }
  const copied = [];
  for (const [packageName, packagePath, outputPath] of VENDOR_ASSETS) {
    const source = path.join(repoRoot, 'node_modules', packageName, packagePath);
    const destination = path.join(outputRoot, outputPath);
    if (!fs.existsSync(source)) {
      throw new Error(`[build-site] Missing ${packageName} browser asset: ${source}. Run npm ci first.`);
    }
    copyEntry(source, destination);
    copied.push({
      package: packageName,
      path: outputPath,
      bytes: fs.statSync(destination).size,
      sha256: sha256File(destination),
    });
  }
  return copied;
}

function normaliseRepository(repository) {
  if (typeof repository === 'string') return repository;
  if (repository && typeof repository.url === 'string') return repository.url;
  return null;
}

function copyVendorLicenses(repoRoot, outputRoot, lockedVersions = resolveLockedVersions(repoRoot)) {
  const packageNames = Object.keys(lockedVersions).sort();
  const configuredNames = Object.keys(VENDOR_LICENSES).sort();
  if (JSON.stringify(packageNames) !== JSON.stringify(configuredNames)) {
    throw new Error(
      '[build-site] Vendor license policy does not cover the locked browser packages. ' +
      `Locked: ${packageNames.join(', ')}; configured: ${configuredNames.join(', ')}`
    );
  }

  const dependencies = packageNames.map(packageName => {
    const policy = VENDOR_LICENSES[packageName];
    const packageRoot = path.join(repoRoot, 'node_modules', packageName);
    const metadataPath = path.join(packageRoot, 'package.json');
    if (!fs.existsSync(metadataPath)) {
      throw new Error(`[build-site] Missing installed package metadata for ${packageName}. Run npm ci first.`);
    }
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (metadata.version !== lockedVersions[packageName]) {
      throw new Error(
        `[build-site] License evidence for ${packageName}@${metadata.version || 'unknown'} does not match ` +
        `lockfile ${lockedVersions[packageName]}. Run npm ci before building.`
      );
    }
    if (typeof metadata.license === 'string' && metadata.license !== policy.spdx) {
      throw new Error(
        `[build-site] ${packageName}@${metadata.version} declares ${metadata.license}, ` +
        `but the vendor license policy expects ${policy.spdx}.`
      );
    }

    let licenseTextPath = null;
    let licenseTextSha256 = null;
    if (policy.sourcePath) {
      const source = path.join(packageRoot, policy.sourcePath);
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`[build-site] Missing license text for ${packageName}: ${source}`);
      }
      licenseTextPath = `vendor/licenses/${packageName.replace(/[^a-z0-9._-]/gi, '_')}.txt`;
      const destination = path.join(outputRoot, licenseTextPath);
      copyEntry(source, destination);
      licenseTextSha256 = sha256File(destination);
    }

    return {
      package: packageName,
      version: metadata.version,
      spdx: policy.spdx,
      repository: normaliseRepository(metadata.repository),
      evidence: licenseTextPath ? 'bundled-license-text' : 'installed-package-metadata',
      licenseTextPath,
      licenseTextSha256,
    };
  });

  const noticePath = 'vendor/third-party-notices.json';
  const destination = path.join(outputRoot, noticePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const notice = {
    schemaVersion: 2,
    source: 'package-lock.json and npm packages installed by npm ci',
    inventoryScope: 'direct-npm-packages-only',
    complete: false,
    trackingIssue: 'https://github.com/carstenartur/Unfallatlas/issues/406',
    knownGaps: [
      'opaque docx and pdfmake browser bundles contain components not reproducible from this project lock',
      'pdfmake-fonts contains four Roboto font binaries requiring font-level OFL provenance',
      'leaflet-image and leaflet.heat contain bundled transitive components',
      'leaflet-draw and leaflet-image npm archives do not contain the required top-level license text',
    ],
    dependencies,
  };
  fs.writeFileSync(destination, `${JSON.stringify(notice, null, 2)}\n`);

  return {
    path: noticePath,
    sha256: sha256File(destination),
    complete: notice.complete,
    inventoryScope: notice.inventoryScope,
    trackingIssue: notice.trackingIssue,
    dependencies,
  };
}

function assertNoRuntimeCdn(outputRoot) {
  const forbidden = /(?:unpkg\.com|cdn\.jsdelivr\.net)\//i;
  const offenders = [];
  for (const file of listFiles(outputRoot)) {
    if (!/\.(?:html|js)$/i.test(file)) continue;
    const relative = path.relative(outputRoot, file).replace(/\\/g, '/');
    if (relative.startsWith('docs/')) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (forbidden.test(source)) offenders.push(relative);
  }
  if (offenders.length) {
    throw new Error(`[build-site] Runtime CDN references remain in: ${offenders.join(', ')}`);
  }
}

function assertLocalAssetReferences(outputRoot) {
  if (!fs.existsSync(outputRoot) || !fs.statSync(outputRoot).isDirectory()) {
    throw new Error(`[build-site] Site output does not exist: ${outputRoot}`);
  }
  const errors = [];
  const isExternal = reference => /^(?:https?:)?\/\//i.test(reference.trim());
  const addLocalReference = (file, rawReference, kind) => {
    if (!rawReference || /^(?:data:|mailto:|tel:|javascript:|#)/i.test(rawReference.trim())) return;
    const reference = rawReference.trim().split('#')[0].split('?')[0];
    if (!reference) return;
    const absolute = reference.startsWith('/')
      ? path.resolve(outputRoot, reference.replace(/^\/+/, ''))
      : path.resolve(path.dirname(file), reference);
    const relative = path.relative(outputRoot, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(absolute)) {
      errors.push(
        `Missing or escaping local ${kind}: ` +
        `${path.relative(outputRoot, file).replace(/\\/g, '/')} -> ${rawReference}`
      );
    }
  };

  for (const cssFile of listFiles(outputRoot).filter(file => path.extname(file).toLowerCase() === '.css')) {
    const source = fs.readFileSync(cssFile, 'utf8');
    const pattern = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi;
    let match;
    while ((match = pattern.exec(source))) {
      const rawReference = match[2].trim();
      if (!rawReference || /^(?:data:|#)/i.test(rawReference)) continue;
      if (isExternal(rawReference)) {
        errors.push(
          `External runtime CSS dependency: ` +
          `${path.relative(outputRoot, cssFile).replace(/\\/g, '/')} -> ${rawReference}`
        );
        continue;
      }
      addLocalReference(cssFile, rawReference, 'CSS asset');
    }

    // CSS permits quoted @import values without url(...), too.
    const importPattern = /@import\s+(['"])([^'"]+)\1/gi;
    while ((match = importPattern.exec(source))) {
      const rawReference = match[2].trim();
      if (isExternal(rawReference)) {
        errors.push(
          `External runtime stylesheet import: ` +
          `${path.relative(outputRoot, cssFile).replace(/\\/g, '/')} -> ${rawReference}`
        );
        continue;
      }
      addLocalReference(cssFile, rawReference, 'stylesheet import');
    }
  }

  for (const htmlFile of listFiles(outputRoot).filter(file => path.extname(file).toLowerCase() === '.html')) {
    const source = fs.readFileSync(htmlFile, 'utf8');
    const tagPattern = /<([a-z][a-z0-9:-]*)\b[^>]*>/gi;
    let tagMatch;
    while ((tagMatch = tagPattern.exec(source))) {
      const tagName = tagMatch[1].toLowerCase();
      const attributes = {};
      const attributePattern = /\b(src|href|rel)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/gi;
      let attributeMatch;
      while ((attributeMatch = attributePattern.exec(tagMatch[0]))) {
        attributes[attributeMatch[1].toLowerCase()] =
          attributeMatch[2] ?? attributeMatch[3] ?? attributeMatch[4] ?? '';
      }

      const runtimeReference = tagName === 'script'
        ? attributes.src
        : (tagName === 'link' && /(?:^|\s)stylesheet(?:\s|$)/i.test(attributes.rel || '')
          ? attributes.href
          : null);
      if (runtimeReference && isExternal(runtimeReference)) {
        errors.push(
          `External runtime ${tagName === 'script' ? 'script' : 'stylesheet'} dependency: ` +
          `${path.relative(outputRoot, htmlFile).replace(/\\/g, '/')} -> ${runtimeReference}`
        );
      }

      for (const attributeName of ['src', 'href']) {
        const rawReference = attributes[attributeName];
        if (!rawReference || isExternal(rawReference)) continue;
        addLocalReference(htmlFile, rawReference, `HTML ${attributeName} asset`);
      }
    }
  }
  if (errors.length) {
    throw new Error(`[build-site] Invalid runtime asset references:\n${errors.join('\n')}`);
  }
}

function fingerprintFiles(outputRoot, files) {
  const digest = crypto.createHash('sha256');
  for (const file of files) {
    const relative = path.relative(outputRoot, file).replace(/\\/g, '/');
    digest.update(relative);
    digest.update('\0');
    digest.update(sha256File(file));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function buildSite(options = {}) {
  const repoRoot = path.resolve(options.root || path.join(__dirname, '..'));
  const finalOutputRoot = path.resolve(repoRoot, options.outputDir || '_site');
  const outputRoot = `${finalOutputRoot}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const inputDir = path.resolve(repoRoot, options.inputDir || 'out');
  const poiDir = path.resolve(repoRoot, options.poiDir || 'out');
  validateBuildPaths(repoRoot, finalOutputRoot, inputDir, poiDir);
  ensureInsideRoot(repoRoot, outputRoot, 'staging output directory');

  try {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.mkdirSync(outputRoot, { recursive: true });

  assertSymlinkFreeTree(inputDir, 'input data tree');
  if (poiDir !== inputDir) assertSymlinkFreeTree(poiDir, 'POI data tree');
  for (const entry of STATIC_ENTRIES) {
    const source = path.join(repoRoot, entry);
    assertSymlinkFreeTree(source, `static source ${entry}`);
    copyEntry(source, path.join(outputRoot, entry));
  }
  const vendorAssets = copyVendorAssets(repoRoot, outputRoot);
  const thirdPartyNotices = copyVendorLicenses(repoRoot, outputRoot);
  if (thirdPartyNotices.complete !== true) {
    process.stderr.write(
      `[build-site] WARNING: vendor provenance is incomplete; Pages/release remain blocked by ` +
      `${thirdPartyNotices.trackingIssue}.\n`
    );
  }

  buildStaticData([
    '--root', repoRoot,
    '--input-dir', path.relative(repoRoot, inputDir),
    '--poi-dir', path.relative(repoRoot, poiDir),
    '--output-dir', path.relative(repoRoot, path.join(outputRoot, 'out')),
    '--manifest', path.relative(repoRoot, path.join(outputRoot, 'out', 'data-manifest.json')),
    '--gzip-only',
  ]);

    validateStaticData({
      dir: path.relative(repoRoot, path.join(outputRoot, 'out')),
      gzipOnly: true,
      requireCities: Array.isArray(options.requiredCities) ? options.requiredCities : [],
      requireCitiesFile: options.requiredCitiesFile === undefined ? 'cities.txt' : options.requiredCitiesFile,
      minFeatures: Number.isInteger(options.minFeatures) ? options.minFeatures : 10,
    }, { repoRoot });

    assertSymlinkFreeTree(outputRoot, 'site output tree');
    assertLocalAssetReferences(outputRoot);
    assertNoRuntimeCdn(outputRoot);

  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const dataManifestPath = path.join(outputRoot, 'out', 'data-manifest.json');
  const dataFiles = listFiles(path.join(outputRoot, 'out'));
  const dataArtifacts = dataFiles.map(file => ({
    path: path.relative(outputRoot, file).replace(/\\/g, '/'),
    bytes: fs.statSync(file).size,
    sha256: sha256File(file),
  }));
  const dataFingerprint = fingerprintFiles(outputRoot, dataFiles);
  const appFiles = listFiles(outputRoot).filter(file => {
    const relative = path.relative(outputRoot, file).replace(/\\/g, '/');
    return relative !== 'build-manifest.json' && !relative.startsWith('out/');
  });
  const manifest = {
    schemaVersion: 1,
    toolchain: {
      node: process.version,
      zlib: process.versions.zlib,
      packageManager: resolveActualPackageManager(),
      packageManagerDeclared: packageJson.packageManager,
    },
    application: {
      name: packageJson.name,
      version: packageJson.version,
      fingerprint: fingerprintFiles(outputRoot, appFiles),
    },
    dependencies: resolveLockedVersions(repoRoot),
    vendorAssets,
    thirdPartyNotices,
    data: {
      manifestPath: 'out/data-manifest.json',
      sha256: sha256File(dataManifestPath),
      fingerprint: dataFingerprint,
      artifacts: dataArtifacts,
      ...JSON.parse(fs.readFileSync(dataManifestPath, 'utf8')),
    },
    networkPolicy: {
      runtimeLibraries: 'local-only',
      offlineCore: 'UI, filters and locally built accident data remain available; remote basemap tiles may be absent.',
      optionalRemoteServices: ['basemap tiles', 'Overpass context lookup', 'server APIs'],
    },
  };
  manifest.fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    application: manifest.application.fingerprint,
    dependencies: manifest.dependencies,
    thirdPartyNotices: manifest.thirdPartyNotices.sha256,
    data: manifest.data.fingerprint,
    networkPolicy: manifest.networkPolicy,
  })).digest('hex');
    fs.writeFileSync(path.join(outputRoot, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    installBuiltSite(outputRoot, finalOutputRoot, options.installHooks);
    process.stdout.write(
      `[build-site] Built ${path.relative(repoRoot, finalOutputRoot)} with ${vendorAssets.length} locked browser assets ` +
      `and ${Object.keys(manifest.data.cities || {}).length} cities.\n`
    );
    return manifest;
  } catch (error) {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    throw error;
  }
}

function main(argv) {
  const args = parseArgs(argv);
  return buildSite(args);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  STATIC_ENTRIES,
  VENDOR_ASSETS,
  VENDOR_LICENSES,
  assertSymlinkFreeTree,
  assertLocalAssetReferences,
  assertNoRuntimeCdn,
  buildSite,
  copyVendorAssets,
  copyVendorLicenses,
  copyEntry,
  installBuiltSite,
  parseArgs,
  listFiles,
  resolveActualPackageManager,
  resolveLockedVersions,
  validateBuildPaths,
};
