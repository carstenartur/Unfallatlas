'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { gunzipSync } = require('node:zlib');
const { assertCompleteLicenseText } = require('./validate-vendor-license-evidence');

const POLICY_RELATIVE_PATH = 'vendor/provenance-policy.json';
const LEAFLET_HEAT_ASSET = 'vendor/leaflet.heat/leaflet-heat.js';
const LEAFLET_HEAT_SOURCE = 'dist/leaflet-heat-global.js';
const DOCX_ASSET = 'vendor/export/docx.js';
const DOCX_BUILD_LOCK = 'vendor/docx-build/npm-lock.json.gz';
const PDF_ASSET = 'vendor/export/pdfmake.js';
const COMPLETE_INVENTORY_SCOPE = 'delivered-assets-component-level';
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const VENDOR_BUILD_LOCK_SCHEMA_VERSION = 1;
const VENDOR_BUILD_LOCK_TYPE = 'unfallatlas-vendor-build-lock';
const VENDOR_BUILD_LOCK_REFERENCE_TYPE = 'vendor-build-lock-reference';

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function npmPurl(name, version) {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
}

function safeFileStem(value) {
  return value.replace(/[^a-z0-9._-]+/gi, '_');
}

function sriSha512Hex(integrity) {
  const match = String(integrity || '').match(/(?:^|\s)sha512-([A-Za-z0-9+/]+={0,2})(?:\s|$)/);
  if (!match) throw new Error(`[vendor-provenance] Invalid SHA-512 integrity: ${integrity || 'missing'}`);
  const hex = Buffer.from(match[1], 'base64').toString('hex');
  if (!/^[a-f0-9]{128}$/.test(hex)) throw new Error('[vendor-provenance] Invalid SHA-512 digest length');
  return hex;
}

function loadPolicy(repoRoot) {
  const sourcePath = path.join(repoRoot, POLICY_RELATIVE_PATH);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`[vendor-provenance] Missing policy: ${sourcePath}`);
  }
  const policy = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (policy.schemaVersion !== 1 || !policy.policyId ||
      policy.completeInventoryScope !== COMPLETE_INVENTORY_SCOPE ||
      !Array.isArray(policy.trustedVendorBuilders) ||
      !Array.isArray(policy.unresolvedAssets)) {
    throw new Error('[vendor-provenance] Unsupported or incomplete provenance policy');
  }
  const ids = new Set();
  const paths = new Set();
  for (const gap of policy.unresolvedAssets) {
    if (!gap || typeof gap.id !== 'string' || !gap.id || ids.has(gap.id) ||
        !Array.isArray(gap.paths) || gap.paths.length === 0 ||
        !Array.isArray(gap.missingEvidence) || gap.missingEvidence.length === 0 ||
        !Array.isArray(gap.migrationOptions) || gap.migrationOptions.length === 0) {
      throw new Error(`[vendor-provenance] Invalid unresolved asset entry: ${gap && gap.id}`);
    }
    ids.add(gap.id);
    for (const assetPath of gap.paths) {
      if (typeof assetPath !== 'string' || !assetPath.startsWith('vendor/') || paths.has(`${gap.id}\0${assetPath}`)) {
        throw new Error(`[vendor-provenance] Invalid unresolved asset path: ${assetPath}`);
      }
      paths.add(`${gap.id}\0${assetPath}`);
    }
  }
  return { policy, sourcePath };
}

function parsePackageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const index = lockPath.lastIndexOf(marker);
  if (index < 0) return null;
  const remainder = lockPath.slice(index + marker.length);
  const segments = remainder.split('/');
  return segments[0].startsWith('@') ? segments.slice(0, 2).join('/') : segments[0];
}

function loadLockComponents(repoRoot, lockFile = 'package-lock.json') {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, lockFile), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages) {
    throw new Error('[vendor-provenance] package-lock.json must use lockfileVersion 3');
  }
  const byName = new Map();
  for (const [lockPath, entry] of Object.entries(lock.packages)) {
    if (!lockPath || !entry || !entry.version || !entry.integrity) continue;
    const name = parsePackageNameFromLockPath(lockPath);
    if (!name) continue;
    const component = {
      name,
      version: entry.version,
      purl: npmPurl(name, entry.version),
      integrity: entry.integrity,
      licenseExpression: entry.license || null,
      lockPath,
      resolved: entry.resolved || null,
    };
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(component);
  }
  for (const components of byName.values()) {
    components.sort((left, right) => left.purl.localeCompare(right.purl) || left.lockPath.localeCompare(right.lockPath));
  }
  return { lock, byName };
}

// A source-map path selects a specific installed package, including nested copies.
function pdfmakeSourcePackages(repoRoot, appLock, inventory) {
  const directory = 'vendor/pdfmake-build';
  const lockFile = directory + '/npm-lock.json';
  const lockSha256 = sha256File(path.join(repoRoot, lockFile));
  if (lockSha256 !== inventory?.lockSha256) {
    throw new Error('[vendor-provenance] PDF upstream lock SHA-256 differs from the verified build lock');
  }
  const buildLock = loadLockComponents(repoRoot, lockFile);
  const mapBytes = fs.readFileSync(path.join(repoRoot, 'node_modules/pdfmake/build/pdfmake.min.js.map'));
  if (sha256Buffer(mapBytes) !== inventory.sourceMapSha256) {
    throw new Error('[vendor-provenance] PDF source-map SHA-256 differs from the verified upstream build');
  }
  const sourceMap = JSON.parse(mapBytes.toString('utf8'));
  const archived = JSON.parse(fs.readFileSync(path.join(repoRoot, directory, 'license-files.json'), 'utf8'));
  const xml = JSON.parse(fs.readFileSync(path.join(repoRoot, directory, 'xmldoc/source.json'), 'utf8'));
  const components = new Map();
  const unresolved = new Set();
  for (const source of sourceMap.sources) {
    let relative = source.replace(/^webpack:\/\/pdfmake\/\.\//, '');
    if (source === 'webpack://pdfmake/../xmldoc.ts') {
      const root = path.join(repoRoot, 'node_modules/xmldoc');
      const metadata = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
      const entry = metadata.exports?.['.']?.import;
      if (metadata.version !== xml.version || entry !== './dist/xmldoc.js' ||
          sha256File(path.join(root, entry)) !== xml.jsSha256 ||
          sha256File(path.join(root, entry + '.map')) !== xml.mapSha256) {
        throw new Error('[vendor-provenance] Remapped xmldoc source differs from its reproduced ES import');
      }
      relative = 'node_modules/xmldoc/dist/xmldoc.js';
    }
    if (!relative.startsWith('node_modules/')) {
      if (!relative.startsWith('src/') && !source.startsWith('webpack://pdfmake/webpack/')) unresolved.add(source);
      continue;
    }
    const dependency = relative.match(/^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//);
    const component = (buildLock.byName.get(dependency?.[2]) || []).find(item => item.lockPath === dependency[1]);
    if (!component) throw new Error('[vendor-provenance] Missing pdfmake build-lock path for ' + source);
    if (components.has(component.lockPath)) continue;
    const installed = (appLock.byName.get(component.name) || []).find(item => item.integrity === component.integrity && item.version === component.version);
    const license = archived[component.lockPath];
    if (!installed && !license) throw new Error('[vendor-provenance] Missing upstream license for ' + component.purl);
    if (license && !/^[a-zA-Z0-9._-]+$/.test(license.file)) throw new Error('[vendor-provenance] Invalid archived license filename');
    const licenseSource = license && path.join(repoRoot, directory, 'licenses', license.file);
    if (license && sha256File(licenseSource) !== license.sha256) throw new Error('[vendor-provenance] Changed upstream license for ' + component.purl);
    const pinned = inventory.components.find(item => item.purl === component.purl);
    components.set(component.lockPath, {
      ...component, lockFile, lockSha256, installedPath: installed?.lockPath,
      archivedLicense: licenseSource, upstreamLicenseName: license?.source,
      ...(pinned ? pinnedLicense(repoRoot, component, pinned, installed?.lockPath) : {}),
    });
  }
  return { components: [...components.values()], unresolved: [...unresolved].sort(), sourceMap };
}

function docxSourcePackages(repoRoot, inventory) {
  const bundle = fs.readFileSync(path.join(repoRoot, 'node_modules/docx/dist/index.iife.js'));
  if (sha256Buffer(bundle) !== inventory?.bundleSha256) {
    throw new Error('[vendor-provenance] DOCX bundle SHA-256 differs from the verified upstream build');
  }
  const modules = [...bundle.toString('utf8').matchAll(/^[\t ]*\/\/ (node_modules\/[^\s]+)$/gm)]
    .map(match => match[1]).sort();
  if (JSON.stringify(modules) !== JSON.stringify(inventory.modules)) {
    throw new Error('[vendor-provenance] DOCX npm module paths differ from the verified inventory');
  }

  let lockBytes;
  try {
    lockBytes = gunzipSync(fs.readFileSync(path.join(repoRoot, DOCX_BUILD_LOCK)));
  } catch (error) {
    throw new Error('[vendor-provenance] Unable to verify DOCX upstream lock SHA-256', { cause: error });
  }
  if (sha256Buffer(lockBytes) !== inventory.lockSha256) {
    throw new Error('[vendor-provenance] DOCX upstream lock SHA-256 differs from the supplier lock');
  }
  const lock = JSON.parse(lockBytes.toString('utf8'));
  const moduleLockPaths = [...new Set(modules.map(module => module.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)[1]))].sort();
  if (JSON.stringify(moduleLockPaths) !== JSON.stringify(inventory.components.map(component => component.lockPath).sort())) {
    throw new Error('[vendor-provenance] DOCX npm module paths do not match the expected lock entries');
  }
  return inventory.components.map(expected => {
    const component = lock.packages[expected.lockPath];
    const name = parsePackageNameFromLockPath(expected.lockPath);
    if (!component || npmPurl(name, component.version) !== expected.purl || component.license !== expected.spdx) {
      throw new Error(`[vendor-provenance] DOCX upstream lock differs for ${expected.purl}`);
    }
    return {
      name,
      version: component.version,
      purl: expected.purl,
      integrity: component.integrity,
      lockPath: expected.lockPath,
      resolved: component.resolved,
      lockFile: DOCX_BUILD_LOCK,
      lockSha256: inventory.lockSha256,
      ...pinnedLicense(repoRoot, component, expected, expected.lockPath),
    };
  });
}

function pinnedLicense(repoRoot, component, expected, installedPath) {
  if (component.integrity !== expected.integrity || component.resolved !== expected.resolved || !installedPath) {
    throw new Error(`[vendor-provenance] Upstream lock or installed archive differs for ${expected.purl}`);
  }
  const license = path.join(repoRoot, installedPath, expected.licenseFile);
  const bytes = fs.readFileSync(license);
  if (sha256Buffer(bytes) !== expected.licenseSha256) {
    throw new Error(`[vendor-provenance] Changed upstream license for ${expected.purl}`);
  }
  assertCompleteLicenseText(bytes.toString('utf8').replace(/\s+/g, ' '), expected.spdx, expected.purl);
  return { licenseExpression: expected.spdx, archivedLicense: license, upstreamLicenseName: expected.licenseFile };
}

function firstLicenseFiles(packageRoot) {
  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) return [];
  return fs.readdirSync(packageRoot)
    .filter(name => /^(?:licen[sc]e|copying|copyright)(?:[._-].*)?$/i.test(name))
    .map(name => path.join(packageRoot, name))
    .filter(file => fs.statSync(file).isFile())
    .sort((left, right) => left.localeCompare(right));
}

function npmLockAttestation(component) {
  return {
    type: 'npm-package-lock-integrity',
    value: component.integrity,
    lockPath: component.lockPath,
    ...(component.lockFile ? { lockFile: component.lockFile, lockSha256: component.lockSha256 } : {}),
  };
}

function copyComponentLicenseEvidence(repoRoot, outputRoot, component) {
  const packageRoot = path.join(repoRoot, component.installedPath || component.lockPath);
  let metadata = null;
  const metadataPath = path.join(packageRoot, 'package.json');
  if (!component.archivedLicense && fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }
  const expression = component.licenseExpression || (metadata && metadata.license) || null;
  const licenseTexts = [];
  for (const source of component.archivedLicense ? [component.archivedLicense] : firstLicenseFiles(packageRoot)) {
    const relativePath = componentLicensePath(component, component.upstreamLicenseName || path.basename(source));
    const destination = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    const contents = fs.readFileSync(destination);
    licenseTexts.push({
      path: relativePath,
      sha256: sha256Buffer(contents),
      copyrightIncluded: /copyright|\(c\)|©/i.test(contents.toString('utf8')),
    });
  }
  return {
    name: component.name,
    version: component.version,
    purl: component.purl,
    integrity: component.integrity,
    resolved: component.resolved,
    licenseExpression: expression,
    licenseTexts,
    attestation: npmLockAttestation(component),
  };
}

function componentLicensePath(component, file) {
  return `vendor/licenses/components/${safeFileStem(component.name)}-${safeFileStem(component.version)}-${safeFileStem(file)}.txt`;
}

function decodeUtf16Be(buffer) {
  const swapped = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    swapped[index] = buffer[index + 1];
    swapped[index + 1] = buffer[index];
  }
  return swapped.toString('utf16le').replace(/\0/g, '');
}

function parseTrueTypeNameTable(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
    throw new Error('[vendor-provenance] Invalid TrueType font');
  }
  const tableCount = buffer.readUInt16BE(4);
  let nameOffset = null;
  let nameLength = null;
  for (let index = 0; index < tableCount; index++) {
    const offset = 12 + (index * 16);
    if (offset + 16 > buffer.length) throw new Error('[vendor-provenance] Truncated TrueType table directory');
    if (buffer.toString('ascii', offset, offset + 4) === 'name') {
      nameOffset = buffer.readUInt32BE(offset + 8);
      nameLength = buffer.readUInt32BE(offset + 12);
      break;
    }
  }
  if (nameOffset === null || nameOffset + nameLength > buffer.length || nameLength < 6) {
    throw new Error('[vendor-provenance] Missing or invalid TrueType name table');
  }
  const count = buffer.readUInt16BE(nameOffset + 2);
  const stringsOffset = nameOffset + buffer.readUInt16BE(nameOffset + 4);
  const values = new Map();
  for (let index = 0; index < count; index++) {
    const record = nameOffset + 6 + (index * 12);
    if (record + 12 > nameOffset + nameLength) break;
    const platform = buffer.readUInt16BE(record);
    const language = buffer.readUInt16BE(record + 4);
    const nameId = buffer.readUInt16BE(record + 6);
    const length = buffer.readUInt16BE(record + 8);
    const offset = stringsOffset + buffer.readUInt16BE(record + 10);
    if (offset + length > buffer.length) continue;
    const raw = buffer.subarray(offset, offset + length);
    const value = platform === 0 || platform === 3 ? decodeUtf16Be(raw) : raw.toString('latin1');
    const priority = platform === 3 && (language === 0x0409 || language === 0) ? 3 : platform === 0 ? 2 : 1;
    if (!values.has(nameId) || values.get(nameId).priority < priority) values.set(nameId, { value, priority });
  }
  const get = id => values.has(id) ? values.get(id).value : null;
  return {
    copyright: get(0),
    family: get(1),
    subfamily: get(2),
    fullName: get(4),
    version: get(5),
    postscriptName: get(6),
  };
}

function collectFontEvidence(repoRoot, outputRoot) {
  const pdfmakeMetadata = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'node_modules/pdfmake/package.json'),
    'utf8'
  ));
  if (!pdfmakeMetadata.version) throw new Error('[vendor-provenance] Missing installed pdfmake version');
  const pdfmakePurl = npmPurl('pdfmake', pdfmakeMetadata.version);
  const vfs = require(path.join(repoRoot, 'node_modules/pdfmake/build/vfs_fonts.js'));
  const release = JSON.parse(fs.readFileSync(path.join(repoRoot, 'vendor/pdfmake-build/roboto-release.json'), 'utf8'));
  const names = Object.keys(vfs).sort();
  if (names.length !== 4 || names.some(name => !/^Roboto-(?:Regular|Medium|Italic|MediumItalic)\.ttf$/.test(name))) {
    throw new Error(`[vendor-provenance] Unexpected pdfmake font set: ${names.join(', ')}`);
  }
  const licenseSource = path.join(repoRoot, 'licenses/vendor/Roboto-OFL-1.1.txt');
  const licensePath = 'vendor/licenses/fonts/Roboto-OFL-1.1.txt';
  const licenseDestination = path.join(outputRoot, licensePath);
  if (!fs.existsSync(licenseSource)) {
    throw new Error(`[vendor-provenance] Missing Roboto OFL text: ${licenseSource}`);
  }
  fs.mkdirSync(path.dirname(licenseDestination), { recursive: true });
  fs.copyFileSync(licenseSource, licenseDestination);
  const fontLicense = {
    path: licensePath,
    sha256: sha256File(licenseDestination),
    copyrightIncluded: true,
  };

  return names.map(name => {
    const decoded = Buffer.from(vfs[name], 'base64');
    const sourcePath = path.join(repoRoot, 'node_modules/pdfmake/fonts/Roboto', name);
    if (!fs.existsSync(sourcePath)) throw new Error(`[vendor-provenance] Missing decoded font source: ${sourcePath}`);
    const source = fs.readFileSync(sourcePath);
    const decodedSha256 = sha256Buffer(decoded);
    const sourceSha256 = sha256Buffer(source);
    if (decodedSha256 !== sourceSha256) {
      throw new Error(`[vendor-provenance] ${name} differs between vfs_fonts.js and the supplied TTF`);
    }
    const upstream = release.files[name];
    const nameTable = parseTrueTypeNameTable(decoded);
    if (!upstream || decodedSha256 !== upstream.sha256 || nameTable.postscriptName !== upstream.postscriptName ||
        nameTable.version !== upstream.version) {
      throw new Error(`[vendor-provenance] ${name} differs from the pinned Roboto typeface release`);
    }
    return {
      name,
      upstreamRelease: { version: release.release, archiveUrl: release.archiveUrl,
        archiveSha256: release.archiveSha256, path: upstream.path },
      bytes: decoded.length,
      decodedSha256,
      sourceSha256,
      decodedFrom: 'vendor/export/pdfmake-fonts.js',
      suppliedBy: pdfmakePurl,
      nameTable,
      licenseExpression: 'OFL-1.1',
      licenseTexts: [fontLicense],
      attestation: null,
    };
  });
}

function verifyEmbeddedSimpleheat(repoRoot, asset, lockComponents) {
  const component = (lockComponents.byName.get('simpleheat') || [])
    .find(candidate => candidate.lockPath === 'node_modules/simpleheat');
  if (!component) throw new Error('[vendor-provenance] Missing locked simpleheat component');
  const packageRoot = path.join(repoRoot, component.installedPath || component.lockPath);
  const installed = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (installed.name !== component.name || installed.version !== component.version) {
    throw new Error('[vendor-provenance] Installed simpleheat does not match package-lock.json');
  }

  const bundle = path.join(repoRoot, 'node_modules/leaflet.heat', LEAFLET_HEAT_SOURCE);
  const sourceMap = JSON.parse(fs.readFileSync(`${bundle}.map`, 'utf8'));
  const sourceIndex = sourceMap.sources.indexOf('../node_modules/simpleheat/simpleheat.js');
  const embeddedSource = sourceMap.sourcesContent?.[sourceIndex];
  // Match the exact copied bundle and its supplier source map to the locked source.
  // This does not independently reproduce the supplier's build.
  if (sha256File(bundle) !== asset.sha256 || typeof embeddedSource !== 'string' ||
      !fs.readFileSync(path.join(packageRoot, 'simpleheat.js')).equals(Buffer.from(embeddedSource))) {
    throw new Error('[vendor-provenance] Leaflet.heat bundle does not match the locked simpleheat source');
  }
  return component;
}

// pdfmake ships a modified SVG-to-PDFKit implementation inside its npm archive.
function collectEmbeddedSvgLicense(repoRoot, outputRoot, map, expected) {
  const root = path.join(repoRoot, 'node_modules/pdfmake');
  const { sourcePath } = expected;
  const source = fs.readFileSync(path.join(root, sourcePath));
  const entries = map.sources.map((name, index) => name === 'webpack://pdfmake/./' + sourcePath ? index : -1)
    .filter(index => index >= 0);
  if (sha256Buffer(source) !== expected.sourceSha256 || map.file !== 'pdfmake.min.js' || entries.length !== 1 ||
      typeof map.sourcesContent?.[entries[0]] !== 'string' ||
      !source.equals(Buffer.from(map.sourcesContent[entries[0]]))) {
    throw new Error('[vendor-provenance] SVG-to-PDFKit source differs from the delivered PDF bundle map');
  }
  const license = fs.readFileSync(path.join(root, path.dirname(sourcePath), 'LICENSE'));
  if (sha256Buffer(license) !== expected.sha256) {
    throw new Error('[vendor-provenance] SVG-to-PDFKit license SHA-256 differs from the pinned fork');
  }
  assertCompleteLicenseText(license.toString('utf8'), expected.spdx, sourcePath);
  fs.mkdirSync(path.dirname(path.join(outputRoot, expected.path)), { recursive: true });
  fs.writeFileSync(path.join(outputRoot, expected.path), license);
  return { ...expected, asset: PDF_ASSET, copyrightIncluded: true };
}

function buildAssetAssessments(repoRoot, copiedAssets, policy, lockComponents, docx, pdfmake) {
  const gapByPath = new Map();
  const gapKindById = new Map();
  for (const gap of policy.unresolvedAssets) {
    gapKindById.set(gap.id, gap.kind);
    for (const assetPath of gap.paths) {
      if (!gapByPath.has(assetPath)) gapByPath.set(assetPath, []);
      gapByPath.get(assetPath).push(gap.id);
    }
  }
  const directComponents = new Map();
  for (const asset of copiedAssets) {
    const candidates = lockComponents.byName.get(asset.package) || [];
    const component = candidates.find(candidate => candidate.lockPath === `node_modules/${asset.package}`);
    if (!component) throw new Error(`[vendor-provenance] Missing locked component for ${asset.package}`);
    directComponents.set(asset.package, component);
  }

  const discoveredByAsset = new Map([
    [DOCX_ASSET, { components: docx, unresolved: [] }],
    [PDF_ASSET, pdfmake],
  ]);

  return copiedAssets.map(asset => {
    const detected = discoveredByAsset.get(asset.path);
    const bundledComponents = [directComponents.get(asset.package), ...(detected?.components || [])];
    const contains = new Set(bundledComponents.map(component => component.purl));
    if (asset.path === 'vendor/leaflet-image/leaflet-image.js') {
      const d3Queue = (lockComponents.byName.get('d3-queue') || [])[0];
      if (d3Queue) contains.add(d3Queue.purl);
    }
    if (asset.path === LEAFLET_HEAT_ASSET) {
      contains.add(verifyEmbeddedSimpleheat(repoRoot, asset, lockComponents).purl);
    }
    const gaps = (gapByPath.get(asset.path) || []).sort();
    const rebuilt = policy.verifiedSourceRebuilds?.[asset.path];
    const sourceRebuild = rebuilt && rebuilt.sha256 === asset.sha256;
    const exactCopy = gaps.every(gapId => gapKindById.get(gapId) === 'missing-redistribution-evidence');
    return {
      path: asset.path,
      package: asset.package,
      bytes: asset.bytes,
      sha256: asset.sha256,
      reproducible: Boolean(sourceRebuild || exactCopy),
      reproductionMethod: sourceRebuild ? rebuilt.command : exactCopy ? 'exact-file-from-integrity-pinned-npm-archive' : null,
      provenanceComplete: gaps.length === 0,
      contains: [...contains].sort(),
      containsFiles: [],
      ...(detected && {
        componentAttestations: bundledComponents.map(component => ({
          purl: component.purl,
          lockFile: 'package-lock.json',
          ...npmLockAttestation(component),
        })),
      }),
      unresolvedDetectedComponents: [...new Set(detected?.unresolved || [])].sort(),
      gaps,
    };
  });
}

function writeDiagnosticSbom(outputRoot, components, assets, fontEvidence, policy, svgLicense) {
  const sbomComponents = components.map(component => ({
    type: 'library',
    'bom-ref': component.purl,
    name: component.name,
    version: component.version,
    purl: component.purl,
    hashes: component.integrity ? [{ alg: 'SHA-512', content: sriSha512Hex(component.integrity) }] : undefined,
    licenses: component.licenseExpression ? [{ expression: component.licenseExpression }] : undefined,
    properties: [
      { name: 'unfallatlas:license-text-count', value: String(component.licenseTexts.length) },
      { name: 'unfallatlas:lock-integrity', value: component.integrity || 'missing' },
    ],
  }));
  for (const font of fontEvidence) {
    sbomComponents.push({
      type: 'file',
      'bom-ref': `urn:unfallatlas:font:${font.name}`,
      name: font.name,
      version: font.nameTable.version || 'unknown',
      hashes: [{ alg: 'SHA-256', content: font.decodedSha256 }],
      licenses: [{ expression: font.licenseExpression }],
      properties: [
        { name: 'unfallatlas:font-family', value: font.nameTable.family || 'unknown' },
        { name: 'unfallatlas:font-postscript-name', value: font.nameTable.postscriptName || 'unknown' },
        { name: 'unfallatlas:provenance-status', value: 'incomplete' },
      ],
    });
  }
  for (const asset of assets) {
    sbomComponents.push({
      type: 'file',
      'bom-ref': `urn:unfallatlas:vendor-asset:${asset.path}`,
      name: path.basename(asset.path),
      hashes: [{ alg: 'SHA-256', content: asset.sha256 }],
      properties: [
        { name: 'unfallatlas:path', value: asset.path },
        { name: 'unfallatlas:reproducible', value: String(asset.reproducible) },
        { name: 'unfallatlas:provenance-complete', value: String(asset.provenanceComplete) },
        { name: 'unfallatlas:gaps', value: JSON.stringify(asset.gaps) },
        {
          name: 'unfallatlas:unresolved-detected-components',
          value: JSON.stringify(asset.unresolvedDetectedComponents),
        },
        ...(asset.componentAttestations ? [{
          name: 'unfallatlas:component-lock-attestations',
          value: JSON.stringify(asset.componentAttestations),
        }] : []),
      ],
    });
  }
  // The modified fork has a source hash inside the pinned pdfmake archive.
  sbomComponents.push({
    type: 'file', 'bom-ref': svgLicense.ref, name: svgLicense.sourcePath,
    hashes: [{ alg: 'SHA-256', content: svgLicense.sourceSha256 }],
    licenses: [{ expression: svgLicense.spdx }],
    properties: [
      { name: 'unfallatlas:license-path', value: svgLicense.path },
      { name: 'unfallatlas:license-sha256', value: svgLicense.sha256 },
    ],
  });
  const dependencies = assets.map(asset => ({
    ref: `urn:unfallatlas:vendor-asset:${asset.path}`,
    dependsOn: [...asset.contains, ...asset.containsFiles].sort(),
  }));
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: { type: 'application', name: 'unfallatlas-browser-vendor-assets' },
      properties: [
        { name: 'unfallatlas:inventory-completeness', value: 'incomplete' },
        { name: 'unfallatlas:tracking-issue', value: policy.trackingIssue },
      ],
    },
    components: sbomComponents,
    dependencies,
    compositions: [{
      aggregate: 'incomplete',
      assemblies: assets.map(asset => `urn:unfallatlas:vendor-asset:${asset.path}`),
    }],
  };
  const relativePath = 'vendor/sbom.cdx.json';
  const destination = path.join(outputRoot, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(sbom, null, 2)}\n`);
  return { path: relativePath, sha256: sha256File(destination), specVersion: sbom.specVersion, complete: false };
}

function buildDiagnosticProvenance(repoRoot, outputRoot, copiedAssets, dependencies) {
  const { policy, sourcePath } = loadPolicy(repoRoot);
  const policyOutputPath = POLICY_RELATIVE_PATH;
  const policyDestination = path.join(outputRoot, policyOutputPath);
  fs.mkdirSync(path.dirname(policyDestination), { recursive: true });
  fs.copyFileSync(sourcePath, policyDestination);

  const lockComponents = loadLockComponents(repoRoot);
  const docx = docxSourcePackages(repoRoot, policy.verifiedBundleInventories?.[DOCX_ASSET]);
  const pdfInventory = policy.verifiedBundleInventories?.[PDF_ASSET];
  const pdfmake = pdfmakeSourcePackages(repoRoot, lockComponents, pdfInventory);
  const assets = buildAssetAssessments(repoRoot, copiedAssets, policy, lockComponents, docx, pdfmake);
  const requiredPurls = new Set(assets.flatMap(asset => asset.contains));
  const selected = [];
  for (const candidates of lockComponents.byName.values()) {
    for (const candidate of candidates) if (requiredPurls.has(candidate.purl)) selected.push(candidate);
  }
  selected.push(...pdfmake.components, ...docx);
  const components = [...new Map(selected.map(component => [component.purl, component])).values()]
    .sort((left, right) => left.purl.localeCompare(right.purl))
    .map(component => copyComponentLicenseEvidence(repoRoot, outputRoot, component));
  const fontEvidence = collectFontEvidence(repoRoot, outputRoot);
  const simpleheat = components.find(component => component.attestation.lockPath === 'node_modules/simpleheat');
  const simpleheatLicense = simpleheat?.licenseTexts.find(license => license.copyrightIncluded);
  if (!simpleheatLicense || simpleheat.licenseExpression !== 'BSD-2-Clause') {
    throw new Error('[vendor-provenance] Missing BSD-2-Clause license evidence for locked simpleheat');
  }
  const svgLicense = collectEmbeddedSvgLicense(repoRoot, outputRoot, pdfmake.sourceMap, pdfInventory.embeddedSource);
  const supplementalLicenses = [{
    component: `simpleheat@${simpleheat.version}`,
    spdx: simpleheat.licenseExpression,
    ...simpleheatLicense,
  }, svgLicense];
  const pdfBundle = assets.find(asset => asset.path === PDF_ASSET);
  if (!pdfBundle) throw new Error('[vendor-provenance] Missing delivered pdfmake bundle');
  pdfBundle.containsFiles.push(svgLicense.ref);
  const fontContainer = assets.find(asset => asset.path === 'vendor/export/pdfmake-fonts.js');
  if (!fontContainer) throw new Error('[vendor-provenance] Missing delivered pdfmake font container');
  fontContainer.containsFiles = fontEvidence
    .map(font => `urn:unfallatlas:font:${font.name}`)
    .sort();
  validateVerifiedBundleInventories({ assetAssessments: assets, components, dependencies, supplementalLicenses }, policy);
  const sbom = writeDiagnosticSbom(outputRoot, components, assets, fontEvidence, policy, svgLicense);
  return {
    policy: {
      path: policyOutputPath,
      sha256: sha256File(policyDestination),
      policyId: policy.policyId,
    },
    knownGaps: policy.unresolvedAssets.map(gap => ({
      id: gap.id,
      paths: gap.paths,
      kind: gap.kind,
      missingEvidence: gap.missingEvidence,
      migrationOptions: gap.migrationOptions,
    })),
    assets,
    components,
    fontEvidence,
    supplementalLicenses,
    sbom,
  };
}

function validateVerifiedBundleInventories(manifest, policy) {
  const componentsByPurl = new Map((manifest.components || []).map(component => [component.purl, component]));
  const supplementalLicenses = manifest.supplementalLicenses || [];
  const knownSources = new Set();
  for (const [assetPath, expected] of Object.entries(policy.verifiedBundleInventories || {})) {
    const asset = manifest.assetAssessments?.find(assessment => assessment.path === assetPath);
    const purls = [...new Set([
      expected.owner, ...expected.components.map(component => component.purl), ...(expected.sourceMapPurls || []),
    ])].sort();
    const fileRefs = expected.embeddedSource ? [expected.embeddedSource.ref] : [];
    const gaps = policy.unresolvedAssets.filter(gap => gap.paths.includes(assetPath)).map(gap => gap.id).sort();
    const rebuild = policy.verifiedSourceRebuilds?.[assetPath];
    if (asset?.sha256 !== expected.bundleSha256 || !Array.isArray(asset.contains) ||
        JSON.stringify([...asset.contains].sort()) !== JSON.stringify(purls) ||
        JSON.stringify(asset.containsFiles) !== JSON.stringify(fileRefs) ||
        JSON.stringify(asset.gaps) !== JSON.stringify(gaps) || asset.unresolvedDetectedComponents?.length !== 0 ||
        rebuild?.sha256 !== expected.bundleSha256 || asset.reproducible !== true || asset.reproductionMethod !== rebuild.command) {
      throw new Error(`[vendor-provenance] Asset differs from the verified component inventory: ${assetPath}`);
    }
    for (const entry of expected.components) {
      const component = componentsByPurl.get(entry.purl);
      if (component?.integrity !== entry.integrity || component.resolved !== entry.resolved ||
          component.licenseExpression !== entry.spdx || npmPurl(component.name, component.version) !== entry.purl ||
          !Array.isArray(component.licenseTexts) ||
          !component.licenseTexts.some(license => license.sha256 === entry.licenseSha256 &&
            license.path === componentLicensePath(component, entry.licenseFile) && license.copyrightIncluded) ||
          component.attestation?.type !== 'npm-package-lock-integrity' || component.attestation.value !== entry.integrity ||
          component.attestation.lockFile !== expected.lockFile ||
          component.attestation?.lockSha256 !== expected.lockSha256 || component.attestation?.lockPath !== entry.lockPath) {
        throw new Error(`[vendor-provenance] Component or license differs from the verified inventory: ${entry.purl}`);
      }
    }
    const components = purls.map(purl => componentsByPurl.get(purl));
    const owner = componentsByPurl.get(expected.owner);
    const ownerDependencies = (manifest.dependencies || []).filter(dependency => dependency.package === owner?.name);
    if (!Array.isArray(asset.componentAttestations) || ownerDependencies.length !== 1 ||
        components.some(component => !component || !Array.isArray(component.licenseTexts)) ||
        bundleComponentEvidenceSha256(components, asset.componentAttestations, ownerDependencies[0]) !== expected.componentEvidenceSha256) {
      throw new Error(`[vendor-provenance] Package and license evidence differs from the verified inventory: ${assetPath}`);
    }
    if (expected.embeddedSource) {
      knownSources.add(expected.embeddedSource.ref);
      const evidence = supplementalLicenses.find(license => license.ref === expected.embeddedSource.ref);
      if (evidence?.asset !== assetPath || evidence.copyrightIncluded !== true ||
          Object.entries(expected.embeddedSource).some(([key, value]) => evidence[key] !== value)) {
        throw new Error(`[vendor-provenance] Embedded source or license differs from the verified inventory: ${assetPath}`);
      }
    }
  }
  if (supplementalLicenses.some(license => license.ref && !knownSources.has(license.ref))) {
    throw new Error('[vendor-provenance] Undeclared embedded source component');
  }
}

function bundleComponentEvidenceSha256(components, componentAttestations, ownerDependency) {
  // The caller orders the rows by purl. Sort each license set by its delivered path.
  const evidence = [
    Object.entries(ownerDependency).sort(),
    components.map(component => [
      component.purl, component.name, component.version, component.integrity, component.resolved, component.licenseExpression,
      Object.entries(component.attestation || {}).sort(),
      component.licenseTexts.map(license => [license.path, license.sha256, license.copyrightIncluded])
        .sort(([left], [right]) => left.localeCompare(right)),
    ]),
    componentAttestations.map(attestation => Object.entries(attestation || {}).sort()),
  ];
  return sha256Buffer(JSON.stringify(evidence));
}

function assertHash(value, label) {
  if (!HASH_PATTERN.test(String(value || ''))) throw new Error(`[vendor-provenance] Missing or invalid ${label}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactObjectKeys(value, keys, label) {
  if (!isPlainObject(value)) throw new Error(`[vendor-provenance] Missing or invalid ${label}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`[vendor-provenance] Invalid ${label} fields`);
  }
}

function assertBuildLockReference(reference, lockId, label) {
  assertExactObjectKeys(
    reference,
    ['type', 'schemaVersion', 'lockId', 'lockRef'],
    `${label} build-lock reference`
  );
  if (reference.type !== VENDOR_BUILD_LOCK_REFERENCE_TYPE ||
      reference.schemaVersion !== VENDOR_BUILD_LOCK_SCHEMA_VERSION ||
      reference.lockId !== lockId ||
      typeof reference.lockRef !== 'string' || !reference.lockRef.trim()) {
    throw new Error(`[vendor-provenance] Invalid ${label} build-lock reference`);
  }
  return reference.lockRef;
}

function validateCompleteLicenseRecord(license, ownerRef, lockId) {
  assertHash(license && license.sha256, `license SHA-256 for ${ownerRef}`);
  if (!license || typeof license.path !== 'string' || !license.path || license.copyrightIncluded !== true) {
    throw new Error(`[vendor-provenance] Full license and copyright evidence is required: ${ownerRef}`);
  }
  assertBuildLockReference(license.attestation, lockId, `license ${license.path}`);
}

function validateCompletenessClaims(manifest) {
  if (manifest.complete !== true) throw new Error('[vendor-provenance] complete must be true');
  if (manifest.inventoryScope !== COMPLETE_INVENTORY_SCOPE) {
    throw new Error(`[vendor-provenance] Complete inventory must use scope ${COMPLETE_INVENTORY_SCOPE}`);
  }
  if (!Array.isArray(manifest.knownGaps) || manifest.knownGaps.length !== 0) {
    throw new Error('[vendor-provenance] complete:true is incompatible with known provenance gaps');
  }
  assertExactObjectKeys(
    manifest.vendorBuildLock,
    ['path', 'sha256', 'reproducible', 'type', 'schemaVersion', 'lockId'],
    'vendor build-lock manifest reference'
  );
  if (manifest.vendorBuildLock.reproducible !== true ||
      manifest.vendorBuildLock.type !== VENDOR_BUILD_LOCK_TYPE ||
      manifest.vendorBuildLock.schemaVersion !== VENDOR_BUILD_LOCK_SCHEMA_VERSION ||
      typeof manifest.vendorBuildLock.lockId !== 'string' || !manifest.vendorBuildLock.lockId.trim() ||
      typeof manifest.vendorBuildLock.path !== 'string' || !manifest.vendorBuildLock.path) {
    throw new Error('[vendor-provenance] Complete inventory requires a reproducible vendor build lock');
  }
  assertHash(manifest.vendorBuildLock.sha256, 'vendor build lock SHA-256');
  const lockId = manifest.vendorBuildLock.lockId;
  if (!manifest.sbom || manifest.sbom.specVersion !== '1.6' || manifest.sbom.complete !== true) {
    throw new Error('[vendor-provenance] Complete inventory requires a complete CycloneDX 1.6 SBOM');
  }
  assertHash(manifest.sbom.sha256, 'SBOM SHA-256');
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) {
    throw new Error('[vendor-provenance] Complete inventory requires components');
  }
  const purls = new Set();
  const componentByNameVersion = new Map();
  const componentLockRefs = new Set();
  for (const component of manifest.components) {
    if (!component || typeof component.purl !== 'string' || !component.purl.startsWith('pkg:') || purls.has(component.purl)) {
      throw new Error('[vendor-provenance] Every component requires a unique purl');
    }
    purls.add(component.purl);
    if (!component.name || !component.version || !component.integrity || !component.resolved ||
        !component.licenseExpression || !Array.isArray(component.licenseTexts) || component.licenseTexts.length === 0) {
      throw new Error(`[vendor-provenance] Component evidence is incomplete: ${component.purl}`);
    }
    const nameVersion = `${component.name}\0${component.version}`;
    if (componentByNameVersion.has(nameVersion)) {
      throw new Error(`[vendor-provenance] Duplicate component name/version: ${component.name}@${component.version}`);
    }
    componentByNameVersion.set(nameVersion, component);
    const componentLockRef = assertBuildLockReference(
      component.attestation,
      lockId,
      `component ${component.purl}`
    );
    if (componentLockRefs.has(componentLockRef)) {
      throw new Error(`[vendor-provenance] Duplicate component build-lock reference: ${componentLockRef}`);
    }
    componentLockRefs.add(componentLockRef);
    for (const license of component.licenseTexts) {
      validateCompleteLicenseRecord(license, component.purl, lockId);
    }
  }
  if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length === 0) {
    throw new Error('[vendor-provenance] Complete inventory requires direct dependency license evidence');
  }
  const dependencyKeys = new Set();
  for (const dependency of manifest.dependencies) {
    const key = dependency && `${dependency.package}\0${dependency.version}`;
    const component = componentByNameVersion.get(key);
    if (!dependency || !component || dependencyKeys.has(key) ||
        dependency.evidence !== 'bundled-license-text' || dependency.spdx !== component.licenseExpression ||
        typeof dependency.licenseTextPath !== 'string' || !dependency.licenseTextPath) {
      throw new Error(`[vendor-provenance] Direct dependency evidence is incomplete: ${dependency && dependency.package}`);
    }
    assertHash(dependency.licenseTextSha256, `direct dependency license SHA-256 for ${dependency.package}`);
    if (!component.licenseTexts.some(license =>
      license.path === dependency.licenseTextPath && license.sha256 === dependency.licenseTextSha256)) {
      throw new Error(`[vendor-provenance] Direct dependency license is not bound to its component: ${dependency.package}`);
    }
    dependencyKeys.add(key);
  }
  if (!Array.isArray(manifest.assetAssessments) || manifest.assetAssessments.length === 0) {
    throw new Error('[vendor-provenance] Complete inventory requires delivered asset assessments');
  }
  const assetLockRefs = new Set();
  const containedPurls = new Set();
  for (const asset of manifest.assetAssessments) {
    assertHash(asset && asset.sha256, `asset SHA-256 for ${asset && asset.path}`);
    if (!asset.path || asset.reproducible !== true || asset.provenanceComplete !== true ||
        !Array.isArray(asset.contains) || asset.contains.length === 0 || !Array.isArray(asset.containsFiles) ||
        !Array.isArray(asset.unresolvedDetectedComponents) || asset.unresolvedDetectedComponents.length !== 0) {
      throw new Error(`[vendor-provenance] Asset contains/reproduction evidence is incomplete: ${asset && asset.path}`);
    }
    const assetLockRef = assertBuildLockReference(
      asset.buildAttestation,
      lockId,
      `asset ${asset.path}`
    );
    if (assetLockRefs.has(assetLockRef)) {
      throw new Error(`[vendor-provenance] Duplicate asset build-lock reference: ${assetLockRef}`);
    }
    assetLockRefs.add(assetLockRef);
    for (const purl of asset.contains) {
      if (!purls.has(purl)) throw new Error(`[vendor-provenance] Asset contains unknown component: ${asset.path} -> ${purl}`);
      containedPurls.add(purl);
    }
  }
  if (containedPurls.size !== purls.size) {
    throw new Error('[vendor-provenance] Complete component inventory contains unbound components');
  }
  if (!Array.isArray(manifest.fontEvidence) || manifest.fontEvidence.length !== 4) {
    throw new Error('[vendor-provenance] Complete inventory requires exactly four font records');
  }
  const fontLockRefs = new Set();
  for (const font of manifest.fontEvidence) {
    assertHash(font && font.decodedSha256, `decoded font SHA-256 for ${font && font.name}`);
    assertHash(font && font.sourceSha256, `font source SHA-256 for ${font && font.name}`);
    if (font.decodedSha256 !== font.sourceSha256 || !font.nameTable || !font.nameTable.family ||
        !font.nameTable.fullName || !font.nameTable.postscriptName || !font.nameTable.version ||
        !font.licenseExpression || !Array.isArray(font.licenseTexts) || font.licenseTexts.length === 0) {
      throw new Error(`[vendor-provenance] Font provenance is incomplete: ${font && font.name}`);
    }
    const fontLockRef = assertBuildLockReference(font.attestation, lockId, `font ${font.name}`);
    if (fontLockRefs.has(fontLockRef)) {
      throw new Error(`[vendor-provenance] Duplicate font build-lock reference: ${fontLockRef}`);
    }
    fontLockRefs.add(fontLockRef);
    for (const license of font.licenseTexts) {
      validateCompleteLicenseRecord(license, `font ${font.name}`, lockId);
    }
  }
  const assetsByPath = new Map(manifest.assetAssessments.map(asset => [asset.path, asset]));
  const fontRefs = new Set(manifest.fontEvidence.map(font => `urn:unfallatlas:font:${font.name}`));
  const fileOwners = new Map();
  for (const asset of manifest.assetAssessments) {
    for (const fileRef of asset.containsFiles) {
      if (!fontRefs.has(fileRef)) {
        throw new Error(`[vendor-provenance] Asset contains unknown file component: ${asset.path} -> ${fileRef}`);
      }
      if (fileOwners.has(fileRef)) {
        throw new Error(`[vendor-provenance] File component has multiple delivered containers: ${fileRef}`);
      }
      fileOwners.set(fileRef, asset.path);
    }
  }
  for (const font of manifest.fontEvidence) {
    const fontRef = `urn:unfallatlas:font:${font.name}`;
    if (!assetsByPath.has(font.decodedFrom) || fileOwners.get(fontRef) !== font.decodedFrom) {
      throw new Error(`[vendor-provenance] Font is not bound to its delivered container: ${font.name}`);
    }
  }
  return manifest;
}

module.exports = {
  COMPLETE_INVENTORY_SCOPE,
  LEAFLET_HEAT_ASSET,
  LEAFLET_HEAT_SOURCE,
  POLICY_RELATIVE_PATH,
  VENDOR_BUILD_LOCK_REFERENCE_TYPE,
  VENDOR_BUILD_LOCK_SCHEMA_VERSION,
  VENDOR_BUILD_LOCK_TYPE,
  buildDiagnosticProvenance,
  collectFontEvidence,
  docxSourcePackages,
  loadPolicy,
  npmPurl,
  parseTrueTypeNameTable,
  sriSha512Hex,
  validateCompletenessClaims,
  validateVerifiedBundleInventories,
};
