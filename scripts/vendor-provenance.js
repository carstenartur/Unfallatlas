'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { gunzipSync, brotliDecompressSync } = require('node:zlib');
const { assertCompleteLicenseText } = require('./validate-vendor-license-evidence');

const POLICY_RELATIVE_PATH = 'vendor/provenance-policy.json';
const LEAFLET_HEAT_ASSET = 'vendor/leaflet.heat/leaflet-heat.js';
const LEAFLET_HEAT_SOURCE = 'dist/leaflet-heat-global.js';
const LEAFLET_IMAGE_ASSET = 'vendor/leaflet-image/leaflet-image.js';
const DOCX_ASSET = 'vendor/export/docx.js';
const DOCX_BUILD_LOCK = 'vendor/docx-build/npm-lock.json.gz';
const { collectUnicodeData, unicodeDataRecords } = require('./pdf-unicode-data');
const PDF_ASSET = 'vendor/export/pdfmake.js';
const PDF_WEBPACK_SOURCE_PREFIX = 'webpack://pdfmake/webpack/';
const { collectPdfkitSources, pdfkitSourceRecords } = require('./pdfkit-nested-sources');
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

function pdfmakeWebpackRecords(inventory) {
  const runtime = inventory.webpackRuntime;
  const component = inventory.components.find(item => item.purl === runtime?.purl && item.lockPath === 'node_modules/webpack');
  if (!component || !Object.keys(runtime.sections || {}).length) {
    throw new Error('[vendor-provenance] Missing PDF Webpack runtime inventory');
  }
  const version = component.purl.slice('pkg:npm/webpack@'.length);
  const licensePath = componentLicensePath({ name: 'webpack', version }, component.licenseFile);
  return Object.entries(runtime.sections).map(([section, sourceSha256]) => ({
    ref: `urn:unfallatlas:vendor-source:pdfmake:webpack:${encodeURIComponent(section)}`,
    component: `Webpack ${section}`,
    sourcePath: PDF_WEBPACK_SOURCE_PREFIX + section,
    sourceSha256,
    sourcePurl: component.purl,
    spdx: component.spdx,
    copyright: runtime.copyright,
    path: licensePath,
    sha256: component.licenseSha256,
  }));
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
  const webpackRecords = pdfmakeWebpackRecords(inventory);
  const webpackSources = new Map(webpackRecords.map(record => [record.sourcePath, record.sourceSha256]));
  for (const [index, source] of sourceMap.sources.entries()) {
    let relative = source.replace(/^webpack:\/\/pdfmake\/\.\//, '');
    if (source.startsWith(PDF_WEBPACK_SOURCE_PREFIX)) {
      const content = sourceMap.sourcesContent?.[index];
      if (typeof content !== 'string' || sha256Buffer(content) !== webpackSources.get(source)) {
        throw new Error('[vendor-provenance] Unexpected PDF Webpack source map section: ' + source);
      }
      webpackSources.delete(source);
      relative = 'node_modules/webpack/';
    }
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
      if (!relative.startsWith('src/')) unresolved.add(source);
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
      ...(pinned ? pinnedLicense(repoRoot, component, pinned, installed?.lockPath, licenseSource) : {}),
    });
  }
  if (webpackSources.size) {
    throw new Error('[vendor-provenance] Missing PDF Webpack source map sections: ' + [...webpackSources.keys()].join(', '));
  }
  return { components: [...components.values()], unresolved: [...unresolved].sort(), sourceMap, webpackRecords };
}

function docxRuntimeRecords(runtimes) {
  return runtimes.flatMap(runtime => runtime.modules.map(module => ({
    ref: `urn:unfallatlas:vendor-source:docx:${encodeURIComponent(module.label.slice(2))}`,
    component: `${runtime.component} ${module.sourcePath}`, sourcePath: module.sourcePath, sourceSha256: module.sourceSha256,
    sourceArchive: runtime.sourceArchive, sourceIntegrity: runtime.sourceIntegrity,
    moduleLabel: module.label, ...(runtime.sourceUrl && { sourceUrl: runtime.sourceUrl }),
    spdx: runtime.spdx, path: runtime.path, sha256: runtime.sha256,
  })));
}

function collectDocxRuntimes(repoRoot, outputRoot, inventory) {
  const bundle = fs.readFileSync(path.join(repoRoot, 'node_modules/docx/dist/index.iife.js'), 'utf8');
  const actual = [...bundle.matchAll(/^[\t ]*\/\/ (\\0\S+)$/gm)].map(match => match[1]).sort();
  const records = docxRuntimeRecords(inventory.generatedRuntimes);
  if (JSON.stringify(actual) !== JSON.stringify(records.map(record => record.moduleLabel).sort())) {
    throw new Error('[vendor-provenance] DOCX generated runtime modules differ from their verified source inventory');
  }
  for (const runtime of inventory.generatedRuntimes) {
    const notice = fs.readFileSync(path.join(repoRoot, runtime.licenseFile));
    if (sha256Buffer(notice) !== runtime.sha256) throw new Error('Changed DOCX runtime notice: ' + runtime.component);
    const target = path.join(outputRoot, runtime.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, notice);
  }
  return records.map(record => ({ ...record, asset: DOCX_ASSET, copyrightIncluded: true }));
}

function collectDocxSections(repoRoot, outputRoot, inventory) {
  const bundle = fs.readFileSync(path.join(repoRoot, 'node_modules/docx/dist/index.iife.js'), 'utf8');
  return inventory.attributedSections.map(({ start, end, licenseFile, record }) => {
    const first = bundle.indexOf(start);
    const last = bundle.indexOf(end, first + start.length);
    if (first < 0 || first !== bundle.lastIndexOf(start) || last < 0 ||
        sha256Buffer(bundle.slice(first, last)) !== record.emittedSha256) {
      throw new Error('DOCX attributed section differs: ' + record.component);
    }
    const notice = fs.readFileSync(path.join(repoRoot, licenseFile));
    if (sha256Buffer(notice) !== record.sha256) throw new Error('Changed DOCX source notice: ' + record.component);
    const target = path.join(outputRoot, record.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, notice);
    return { ...record, asset: DOCX_ASSET, copyrightIncluded: true };
  });
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

function pinnedLicense(repoRoot, component, expected, installedPath, archivedLicense) {
  if (component.integrity !== expected.integrity || component.resolved !== expected.resolved ||
      (!installedPath && !archivedLicense)) {
    throw new Error(`[vendor-provenance] Upstream lock or installed archive differs for ${expected.purl}`);
  }
  const license = archivedLicense || path.join(repoRoot, installedPath, expected.licenseFile);
  const bytes = fs.readFileSync(license);
  if (sha256Buffer(bytes) !== expected.licenseSha256) {
    throw new Error(`[vendor-provenance] Changed upstream license for ${expected.purl}`);
  }
  assertCompleteLicenseText(bytes.toString('utf8').replace(/\s+/g, ' '), expected.spdx, expected.purl);
  return { licenseExpression: expected.spdx, archivedLicense: license, upstreamLicenseName: expected.licenseFile };
}

function verifyLeafletImageModules(repoRoot, inventory) {
  const bundle = fs.readFileSync(path.join(repoRoot, 'node_modules/leaflet-image/leaflet-image.js'));
  if (sha256Buffer(bundle) !== inventory?.bundleSha256) {
    throw new Error('[vendor-provenance] Leaflet-image bundle SHA-256 differs from the pinned npm asset');
  }
  const modules = inventory.browserifyModules;
  if (!Array.isArray(modules) || modules.length !== 2 || modules[0]?.purl !== inventory.owner ||
      modules[1]?.purl !== inventory.components?.[0]?.purl) {
    throw new Error('[vendor-provenance] Invalid Leaflet-image Browserify module inventory');
  }

  // The pinned Browserify table maps the first module's d3-queue import to module 2.
  // Compare the raw module bodies without running the bundle or normalizing whitespace.
  const first = Buffer.from('({1:[function(require,module,exports){\n');
  const second = Buffer.from('\n},{"d3-queue":2}],2:[function(require,module,exports){\n');
  const end = Buffer.from('\n},{}]},{},[1])(1)\n});');
  const firstOffset = bundle.indexOf(first);
  const secondOffset = bundle.indexOf(second, firstOffset + first.length);
  const endOffset = bundle.length - end.length;
  if (firstOffset < 0 || secondOffset < 0 || secondOffset + second.length >= endOffset ||
      !bundle.subarray(endOffset).equals(end)) {
    throw new Error('[vendor-provenance] Unexpected Leaflet-image Browserify module table');
  }
  const bodies = [
    bundle.subarray(firstOffset + first.length, secondOffset),
    bundle.subarray(secondOffset + second.length, endOffset),
  ];
  return new Map(modules.map(({ purl, path: sourcePath, sha256 }, index) => {
    const source = fs.readFileSync(path.join(repoRoot, sourcePath));
    if (!source.equals(bodies[index]) || sha256Buffer(source) !== sha256) {
      throw new Error(`[vendor-provenance] Leaflet-image Browserify module differs from the pinned source: ${sourcePath}`);
    }
    return [purl, { path: sourcePath, sha256 }];
  }));
}

function leafletImageSourcePackages(repoRoot, lockComponents, inventory) {
  const moduleSources = verifyLeafletImageModules(repoRoot, inventory);
  const [expected] = inventory.components;
  const queue = lockComponents.byName.get('d3-queue')?.find(component => component.lockPath === expected.lockPath);
  if (!queue || queue.purl !== expected.purl || queue.licenseExpression !== expected.spdx) {
    throw new Error('[vendor-provenance] Leaflet-image d3-queue lock entry differs from the pinned component');
  }
  return {
    components: [{
      ...queue,
      lockFile: inventory.lockFile,
      ...pinnedLicense(repoRoot, queue, expected, queue.lockPath),
    }],
    unresolved: [],
    moduleSources,
  };
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
    ...(component.lockFile && { lockFile: component.lockFile }),
    ...(component.lockSha256 && { lockSha256: component.lockSha256 }),
  };
}

function copyComponentLicenseEvidence(repoRoot, outputRoot, component, directLicense) {
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
  if (!licenseTexts.length && directLicense?.licenseTextPath) {
    const contents = fs.readFileSync(path.join(outputRoot, directLicense.licenseTextPath));
    assertCompleteLicenseText(contents.toString('utf8'), expression, component.purl);
    licenseTexts.push({ path: directLicense.licenseTextPath, sha256: sha256Buffer(contents), copyrightIncluded: true });
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

function brotliDecoderRecords(expected) {
  return Object.keys(expected.files).sort().map(file => ({
    ref: `urn:unfallatlas:vendor-source:pdfmake:brotli-decoder:${path.posix.basename(file)}`,
    component: `Brotli decoder ${file}`,
    sourcePath: `${expected.lockPath}/${file}`,
    sourceSha256: expected.files[file],
    spdx: expected.spdx,
    copyright: expected.copyright,
    path: expected.path,
    sha256: expected.sha256,
  }));
}

// Fontkit's npm bundle has its own source map inside the pdfmake source map.
function collectFontkitSources(repoRoot, outputRoot, pdfmake, expected) {
  const fontkit = pdfmake.components.find(item => item.lockPath === 'node_modules/fontkit');
  if (!fontkit?.installedPath) throw new Error('Fontkit is missing from the PDF build lock');
  const root = path.join(repoRoot, fontkit.installedPath);
  const browserModule = 'dist/browser-module.mjs';
  const bundle = fs.readFileSync(path.join(root, browserModule));
  const mapBytes = fs.readFileSync(path.join(root, browserModule + '.map'));
  const moduleId = 'webpack://pdfmake/./node_modules/fontkit/' + browserModule;
  const outer = pdfmake.sourceMap.sources.indexOf(moduleId);
  if (outer < 0 || pdfmake.sourceMap.sources.lastIndexOf(moduleId) !== outer ||
      pdfmake.sourceMap.sourcesContent[outer] !== bundle.toString('utf8') || sha256Buffer(mapBytes) !== expected.mapSha256) {
    throw new Error('Fontkit browser module or source map differs from the PDF exporter');
  }
  const map = JSON.parse(mapBytes);
  const inputs = expected.sections.map(({ file, start, end, licenseFile, record }) => {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const index = map.sources.indexOf(file);
    const begin = source.indexOf(start);
    const endAt = end ? source.indexOf(end, begin + start.length) : source.length;
    const section = source.slice(begin, end ? endAt + end.length : endAt);
    if (index < 0 || map.sources.lastIndexOf(file) !== index || map.sourcesContent[index] !== source ||
        begin < 0 || begin !== source.lastIndexOf(start) || endAt < 0 ||
        sha256Buffer(section) !== record.sourceSha256) {
      throw new Error('Fontkit attributed source differs: ' + file);
    }
    return { file, licenseFile, record };
  });
  const deliveredPath = path.join(outputRoot, PDF_ASSET);
  const delivered = fs.readFileSync(fs.existsSync(deliveredPath)
    ? deliveredPath : path.join(repoRoot, 'node_modules/pdfmake/build/pdfmake.min.js'), 'utf8');
  for (const input of expected.grammarInputs) {
    const grammar = fs.readFileSync(path.join(root, input.file));
    const generated = fs.readFileSync(path.join(root, input.generatedFile), 'utf8');
    const index = map.sources.indexOf(input.generatedFile);
    if (sha256Buffer(grammar) !== input.record.sourceSha256 || sha256Buffer(generated) !== input.record.generatedSha256 ||
        index < 0 || map.sources.lastIndexOf(input.generatedFile) !== index || map.sourcesContent[index] !== generated ||
        delivered.indexOf(generated) < 0 || delivered.indexOf(generated) !== delivered.lastIndexOf(generated)) {
      throw new Error('Fontkit grammar or embedded state machine differs: ' + input.file);
    }
    inputs.push(input);
  }
  return inputs.map(({ file, licenseFile, record }) => {
    const license = fs.readFileSync(path.join(repoRoot, 'vendor/pdfmake-build/licenses', licenseFile));
    if (sha256Buffer(license) !== record.sha256) throw new Error('Fontkit source license differs: ' + file);
    const destination = path.join(outputRoot, record.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, license);
    return { ...record, asset: PDF_ASSET, copyrightIncluded: true };
  });
}

function collectBrotliDictionary(repoRoot, outputRoot, sourceMap, installedRoot, expected) {
  const entry = 'webpack://pdfmake/./node_modules/brotli/dec/dictionary.bin.js';
  const index = sourceMap.sources.indexOf(entry);
  const wrapper = fs.readFileSync(path.join(installedRoot, 'dec/dictionary.bin.js'), 'utf8');
  const encoded = /^module\.exports="([A-Za-z0-9+/]+={0,2})";\n$/.exec(wrapper);
  if (!encoded || index < 0 || sourceMap.sources.lastIndexOf(entry) !== index || sourceMap.sourcesContent[index] !== wrapper) {
    throw new Error('Embedded Brotli dictionary does not match the npm source');
  }
  const bytes = brotliDecompressSync(Buffer.from(encoded[1], 'base64'), { maxOutputLength: 122784 });
  if (bytes.length !== 122784 || sha256Buffer(bytes) !== expected.sourceSha256) {
    throw new Error('Decoded Brotli dictionary differs from its original');
  }
  const license = fs.readFileSync(path.join(repoRoot, 'vendor/pdfmake-build/licenses/Brotli-MIT.txt'));
  if (sha256Buffer(license) !== expected.sha256) throw new Error('Brotli dictionary license differs');
  const destination = path.join(outputRoot, expected.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, license);
  return { ...expected, asset: PDF_ASSET, copyrightIncluded: true };
}

function collectBrotliDecoderLicenses(repoRoot, outputRoot, pdfmake, expected) {
  const component = pdfmake.components.find(item => item.purl === expected.purl && item.lockPath === expected.lockPath);
  if (!component?.installedPath) {
    throw new Error('[vendor-provenance] Missing installed Brotli archive matching the PDF build lock');
  }
  const installedRoot = path.join(repoRoot, component.installedPath);
  const metadata = JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8'));
  if (metadata.name !== component.name || metadata.version !== component.version) {
    throw new Error('[vendor-provenance] Installed Brotli package differs from the PDF build lock');
  }

  const records = brotliDecoderRecords(expected);
  const mapPrefix = 'webpack://pdfmake/./';
  const packagePrefix = `${mapPrefix}${expected.lockPath}/`;
  const decoderSources = new Map();
  for (const [index, name] of pdfmake.sourceMap.sources.entries()) {
    if (!name.startsWith(packagePrefix)) continue;
    const content = pdfmake.sourceMap.sourcesContent?.[index];
    if (typeof content !== 'string') {
      throw new Error(`[vendor-provenance] Missing Brotli source-map content: ${name}`);
    }
    const bytes = Buffer.from(content);
    if (sha256Buffer(bytes.subarray(0, expected.headerBytes)) !== expected.headerSha256) continue;
    const sourcePath = name.slice(mapPrefix.length);
    if (decoderSources.has(sourcePath)) {
      throw new Error(`[vendor-provenance] Duplicate Brotli decoder source-map path: ${sourcePath}`);
    }
    decoderSources.set(sourcePath, bytes);
  }
  if (decoderSources.size !== records.length || records.some(record => !decoderSources.has(record.sourcePath))) {
    throw new Error('[vendor-provenance] Brotli decoder source-map paths differ from the verified notice scope');
  }
  for (const record of records) {
    const file = record.sourcePath.slice(expected.lockPath.length + 1);
    const source = fs.readFileSync(path.join(installedRoot, file));
    if (sha256Buffer(source) !== record.sourceSha256 || !source.equals(decoderSources.get(record.sourcePath)) ||
        !source.toString('utf8', 0, expected.headerBytes).startsWith(`/* ${expected.copyright}\n`)) {
      throw new Error(`[vendor-provenance] Brotli decoder source differs from the delivered PDF bundle map: ${record.sourcePath}`);
    }
  }

  const license = fs.readFileSync(path.join(repoRoot, expected.licenseTextPath));
  if (sha256Buffer(license) !== expected.licenseTextSha256) {
    throw new Error('[vendor-provenance] Brotli decoder Apache license differs from the pinned text');
  }
  const notice = Buffer.concat([Buffer.from([
    `Brotli decoder files from ${component.name}@${component.version}`,
    expected.copyright,
    '',
    'The following decoder files are included in the pdfmake browser bundle:',
    ...Object.keys(expected.files).sort(),
    '',
  ].join('\n')), license]);
  if (sha256Buffer(notice) !== expected.sha256) {
    throw new Error('[vendor-provenance] Brotli decoder notice differs from the verified text');
  }
  const destination = path.join(outputRoot, expected.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, notice);
  const port = expected.cPort;
  const portNotice = fs.readFileSync(path.join(repoRoot, port.licenseFile));
  const portRecords = port.records.map(record => {
    const file = record.sourcePath.slice(expected.lockPath.length + 1);
    const source = fs.readFileSync(path.join(installedRoot, file));
    const id = mapPrefix + record.sourcePath;
    const index = pdfmake.sourceMap.sources.indexOf(id);
    if (index < 0 || index !== pdfmake.sourceMap.sources.lastIndexOf(id) ||
        !source.equals(Buffer.from(pdfmake.sourceMap.sourcesContent[index])) || sha256Buffer(source) !== record.sourceSha256 ||
        sha256Buffer(portNotice) !== record.sha256) {
      throw new Error('Brotli C port or notice differs: ' + record.sourcePath);
    }
    fs.writeFileSync(path.join(outputRoot, record.path), portNotice);
    return { ...record, asset: PDF_ASSET, copyrightIncluded: true };
  });
  const decoder = records.map(record => ({ ...record, asset: PDF_ASSET, copyrightIncluded: true }));
  return [...decoder, ...portRecords, collectBrotliDictionary(repoRoot, outputRoot, pdfmake.sourceMap, installedRoot, expected.dictionary)];
}

function buildAssetAssessments(repoRoot, copiedAssets, policy, lockComponents, discoveredByAsset) {
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

  return copiedAssets.map(asset => {
    const detected = discoveredByAsset.get(asset.path);
    const bundledComponents = [directComponents.get(asset.package), ...(detected?.components || [])];
    const contains = new Set(bundledComponents.map(component => component.purl));
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
        componentAttestations: bundledComponents.map(component => {
          const source = detected.moduleSources?.get(component.purl);
          return {
            purl: component.purl,
            lockFile: 'package-lock.json',
            ...npmLockAttestation(component),
            ...(source && { source }),
          };
        }),
      }),
      unresolvedDetectedComponents: [...new Set(detected?.unresolved || [])].sort(),
      gaps,
    };
  });
}

function writeDiagnosticSbom(outputRoot, components, assets, fontEvidence, policy, embeddedSources) {
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
  for (const source of embeddedSources) {
    sbomComponents.push({
      type: 'file', 'bom-ref': source.ref, name: source.sourcePath,
      hashes: [{ alg: 'SHA-256', content: source.sourceSha256 }],
      licenses: [{ expression: source.spdx }],
      ...(source.copyright && { copyright: source.copyright }),
      properties: [
        { name: 'unfallatlas:license-path', value: source.path },
        { name: 'unfallatlas:license-sha256', value: source.sha256 },
        ...(source.sourcePurl ? [{ name: 'unfallatlas:source-package', value: source.sourcePurl }] : []),
      ],
    });
  }
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
  const leafletImageInventory = policy.verifiedBundleInventories?.[LEAFLET_IMAGE_ASSET];
  const leafletImage = leafletImageSourcePackages(repoRoot, lockComponents, leafletImageInventory);
  const discoveredByAsset = new Map([
    [PDF_ASSET, pdfmake],
    [DOCX_ASSET, { components: docx, unresolved: [] }],
    [LEAFLET_IMAGE_ASSET, leafletImage],
  ]);
  const assets = buildAssetAssessments(repoRoot, copiedAssets, policy, lockComponents, discoveredByAsset);
  const requiredPurls = new Set(assets.flatMap(asset => asset.contains));
  const selected = [];
  for (const candidates of lockComponents.byName.values()) {
    for (const candidate of candidates) if (requiredPurls.has(candidate.purl)) selected.push(candidate);
  }
  for (const { components } of discoveredByAsset.values()) selected.push(...components);
  const directLicenses = new Map(dependencies.map(dependency => [
    `pkg:npm/${dependency.package}@${dependency.version}`, dependency,
  ]));
  const components = [...new Map(selected.map(component => [component.purl, component])).values()]
    .sort((left, right) => left.purl.localeCompare(right.purl))
    .map(component => copyComponentLicenseEvidence(repoRoot, outputRoot, component,
      directLicenses.get(component.purl)));
  const fontEvidence = collectFontEvidence(repoRoot, outputRoot);
  const simpleheat = components.find(component => component.attestation.lockPath === 'node_modules/simpleheat');
  const simpleheatLicense = simpleheat?.licenseTexts.find(license => license.copyrightIncluded);
  if (!simpleheatLicense || simpleheat.licenseExpression !== 'BSD-2-Clause') {
    throw new Error('[vendor-provenance] Missing BSD-2-Clause license evidence for locked simpleheat');
  }
  const embeddedSources = [
    ...collectDocxRuntimes(repoRoot, outputRoot, policy.verifiedBundleInventories[DOCX_ASSET]),
    ...collectDocxSections(repoRoot, outputRoot, policy.verifiedBundleInventories[DOCX_ASSET]),
    ...collectUnicodeData(repoRoot, outputRoot, pdfmake.sourceMap, pdfInventory.unicodeDataManifestSha256),
    ...collectFontkitSources(repoRoot, outputRoot, pdfmake, pdfInventory.fontkitSources),
    collectEmbeddedSvgLicense(repoRoot, outputRoot, pdfmake.sourceMap, pdfInventory.embeddedSource),
    ...collectBrotliDecoderLicenses(repoRoot, outputRoot, pdfmake, pdfInventory.brotliDecoder),
    ...collectPdfkitSources(repoRoot, outputRoot, pdfmake, pdfInventory.nestedPdfkitSources),
    ...pdfmake.webpackRecords.map(record => ({ ...record, asset: PDF_ASSET, copyrightIncluded: true })),
  ];
  const supplementalLicenses = [{
    component: `simpleheat@${simpleheat.version}`,
    spdx: simpleheat.licenseExpression,
    ...simpleheatLicense,
  }, ...embeddedSources];
  for (const asset of assets) {
    asset.containsFiles = embeddedSources.filter(source => source.asset === asset.path)
      .map(source => source.ref).sort();
  }
  const fontContainer = assets.find(asset => asset.path === 'vendor/export/pdfmake-fonts.js');
  if (!fontContainer) throw new Error('[vendor-provenance] Missing delivered pdfmake font container');
  fontContainer.containsFiles = fontEvidence
    .map(font => `urn:unfallatlas:font:${font.name}`)
    .sort();
  validateVerifiedBundleInventories({ assetAssessments: assets, components, dependencies, supplementalLicenses }, policy);
  const sbom = writeDiagnosticSbom(outputRoot, components, assets, fontEvidence, policy, embeddedSources);
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
    const embeddedSources = [
      ...docxRuntimeRecords(expected.generatedRuntimes || []),
      ...(expected.attributedSections || []).map(section => section.record),
      ...(expected.unicodeDataManifestSha256 ? unicodeDataRecords(expected.unicodeDataManifestSha256) : []),
      ...(expected.fontkitSources?.sections.map(section => section.record) || []),
      ...(expected.fontkitSources?.grammarInputs?.map(input => input.record) || []),
      ...(expected.embeddedSource ? [expected.embeddedSource] : []),
      ...(expected.brotliDecoder ? [...brotliDecoderRecords(expected.brotliDecoder), ...expected.brotliDecoder.cPort.records, expected.brotliDecoder.dictionary] : []),
      ...(expected.nestedPdfkitSources ? pdfkitSourceRecords(expected.nestedPdfkitSources) : []),
      ...(expected.webpackRuntime ? pdfmakeWebpackRecords(expected) : []),
    ];
    const fileRefs = embeddedSources.map(source => source.ref).sort();
    const gaps = policy.unresolvedAssets.filter(gap => gap.paths.includes(assetPath)).map(gap => gap.id).sort();
    const rebuild = policy.verifiedSourceRebuilds?.[assetPath];
    if (asset?.sha256 !== expected.bundleSha256 || !Array.isArray(asset.contains) ||
        JSON.stringify([...asset.contains].sort()) !== JSON.stringify(purls) ||
        JSON.stringify(asset.containsFiles) !== JSON.stringify(fileRefs) ||
        JSON.stringify(asset.gaps) !== JSON.stringify(gaps) || asset.unresolvedDetectedComponents?.length !== 0 ||
        (rebuild ? rebuild.sha256 !== expected.bundleSha256 : !expected.browserifyModules) ||
        asset.reproducible !== Boolean(rebuild) || asset.reproductionMethod !== (rebuild?.command ?? null)) {
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
    for (const source of embeddedSources) {
      knownSources.add(source.ref);
      const evidence = supplementalLicenses.find(license => license.ref === source.ref);
      if (evidence?.asset !== assetPath || evidence.copyrightIncluded !== true ||
          Object.entries(source).some(([key, value]) => evidence[key] !== value)) {
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

function validateCompleteSupplementalSources(manifest) {
  const lockId = manifest.vendorBuildLock.lockId;
  const records = manifest.supplementalLicenses ?? [];
  if (!Array.isArray(records) || records.some(record => !isPlainObject(record))) {
    throw new Error('[vendor-provenance] Invalid supplemental source inventory');
  }
  const sources = new Map();
  const assets = new Map(manifest.assetAssessments.map(asset => [asset.path, asset]));
  for (const source of records.filter(record => Object.hasOwn(record, 'ref'))) {
    if (typeof source.ref !== 'string' || !/^urn:unfallatlas:vendor-source:[^\s]+$/.test(source.ref) ||
        sources.has(source.ref) || typeof source.sourcePath !== 'string' || !source.sourcePath.trim() ||
        typeof source.spdx !== 'string' || !source.spdx.trim()) {
      throw new Error('[vendor-provenance] Invalid or duplicate supplemental source');
    }
    assertHash(source.sourceSha256, `source SHA-256 for ${source.ref}`);
    assertBuildLockReference(source.attestation, lockId, `supplemental source ${source.ref}`);
    validateCompleteLicenseRecord({ ...source, attestation: source.licenseAttestation }, source.ref, lockId);
    if (Object.hasOwn(source, 'sourceNoticePath') || Object.hasOwn(source, 'sourceNoticeSha256')) {
      if (typeof source.sourceNoticePath !== 'string' || !source.sourceNoticePath.trim()) {
        throw new Error(`[vendor-provenance] Missing original notice path for ${source.ref}`);
      }
      assertHash(source.sourceNoticeSha256, `original notice SHA-256 for ${source.ref}`);
    }
    const asset = assets.get(source.asset);
    if (!asset?.containsFiles?.includes(source.ref) ||
        (source.sourcePurl && !asset.contains?.includes(source.sourcePurl))) {
      throw new Error(`[vendor-provenance] Supplemental source is not bound to its delivered container: ${source.ref}`);
    }
    sources.set(source.ref, source);
  }
  return sources;
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
      component.buildAttestation ?? component.attestation,
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
  const supplementalSources = validateCompleteSupplementalSources(manifest);
  const fileOwners = new Map();
  for (const asset of manifest.assetAssessments) {
    for (const fileRef of asset.containsFiles) {
      if (!fontRefs.has(fileRef) && !supplementalSources.has(fileRef)) {
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
  validateCompleteSupplementalSources,
  validateVerifiedBundleInventories,
  verifyLeafletImageModules,
};
