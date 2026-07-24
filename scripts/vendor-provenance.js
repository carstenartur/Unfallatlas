'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const POLICY_RELATIVE_PATH = 'vendor/provenance-policy.json';
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

function loadLockComponents(repoRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
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

function discoverPackageNames(file) {
  const names = new Set();
  let sources;
  if (file.endsWith('.map')) {
    const sourceMap = JSON.parse(fs.readFileSync(file, 'utf8'));
    sources = Array.isArray(sourceMap.sources) ? sourceMap.sources.join('\n') : '';
  } else {
    sources = fs.readFileSync(file, 'utf8');
  }
  const pattern = /node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/g;
  let match;
  while ((match = pattern.exec(sources))) names.add(match[1]);
  return [...names].sort();
}

function firstLicenseFiles(packageRoot) {
  if (!fs.existsSync(packageRoot) || !fs.statSync(packageRoot).isDirectory()) return [];
  return fs.readdirSync(packageRoot)
    .filter(name => /^(?:licen[sc]e|copying|copyright)(?:[._-].*)?$/i.test(name))
    .map(name => path.join(packageRoot, name))
    .filter(file => fs.statSync(file).isFile())
    .sort((left, right) => left.localeCompare(right));
}

function copyComponentLicenseEvidence(repoRoot, outputRoot, component) {
  const packageRoot = path.join(repoRoot, component.lockPath);
  let metadata = null;
  const metadataPath = path.join(packageRoot, 'package.json');
  if (fs.existsSync(metadataPath)) {
    metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }
  const expression = component.licenseExpression || (metadata && metadata.license) || null;
  const licenseTexts = [];
  for (const source of firstLicenseFiles(packageRoot)) {
    const relativePath = `vendor/licenses/components/${safeFileStem(component.name)}-${safeFileStem(component.version)}-${safeFileStem(path.basename(source))}.txt`;
    const destination = path.join(outputRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    const contents = fs.readFileSync(destination, 'utf8');
    licenseTexts.push({
      path: relativePath,
      sha256: sha256Buffer(contents),
      copyrightIncluded: /copyright|\(c\)|©/i.test(contents),
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
    attestation: {
      type: 'npm-package-lock-integrity',
      value: component.integrity,
      lockPath: component.lockPath,
    },
  };
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
    return {
      name,
      bytes: decoded.length,
      decodedSha256,
      sourceSha256,
      decodedFrom: 'vendor/export/pdfmake-fonts.js',
      suppliedBy: pdfmakePurl,
      nameTable: parseTrueTypeNameTable(decoded),
      licenseExpression: 'OFL-1.1',
      licenseTexts: [fontLicense],
      attestation: null,
    };
  });
}

function buildAssetAssessments(repoRoot, copiedAssets, policy, lockComponents) {
  const gapByPath = new Map();
  const gapKindById = new Map();
  for (const gap of policy.unresolvedAssets) {
    gapKindById.set(gap.id, gap.kind);
    for (const assetPath of gap.paths) {
      if (!gapByPath.has(assetPath)) gapByPath.set(assetPath, []);
      gapByPath.get(assetPath).push(gap.id);
    }
  }
  const directPurls = new Map();
  for (const asset of copiedAssets) {
    const candidates = lockComponents.byName.get(asset.package) || [];
    const component = candidates.find(candidate => candidate.lockPath === `node_modules/${asset.package}`);
    if (!component) throw new Error(`[vendor-provenance] Missing locked component for ${asset.package}`);
    directPurls.set(asset.package, component.purl);
  }

  const discoveredByAsset = new Map();
  const discover = (assetPath, sourcePath) => {
    const names = discoverPackageNames(sourcePath);
    const purls = [];
    const unresolved = [];
    for (const name of names) {
      const candidates = lockComponents.byName.get(name) || [];
      if (candidates.length === 0) unresolved.push(name);
      else for (const component of candidates) purls.push(component.purl);
    }
    discoveredByAsset.set(assetPath, { purls: [...new Set(purls)].sort(), unresolved });
  };
  discover('vendor/export/docx.js', path.join(repoRoot, 'node_modules/docx/dist/index.iife.js'));
  discover('vendor/export/pdfmake.js', path.join(repoRoot, 'node_modules/pdfmake/build/pdfmake.js.map'));

  return copiedAssets.map(asset => {
    const detected = discoveredByAsset.get(asset.path) || { purls: [], unresolved: [] };
    const contains = new Set([directPurls.get(asset.package), ...detected.purls]);
    if (asset.path === 'vendor/leaflet-image/leaflet-image.js') {
      const d3Queue = (lockComponents.byName.get('d3-queue') || [])[0];
      if (d3Queue) contains.add(d3Queue.purl);
    }
    const unresolvedDetectedComponents = [...detected.unresolved];
    if (asset.path === 'vendor/leaflet.heat/leaflet-heat.js') {
      unresolvedDetectedComponents.push('simpleheat@0.2.0');
    }
    const gaps = (gapByPath.get(asset.path) || []).sort();
    const reproducible = gaps.every(gapId => gapKindById.get(gapId) === 'missing-redistribution-evidence');
    return {
      path: asset.path,
      package: asset.package,
      bytes: asset.bytes,
      sha256: asset.sha256,
      reproducible,
      reproductionMethod: reproducible ? 'exact-file-from-integrity-pinned-npm-archive' : null,
      provenanceComplete: gaps.length === 0,
      contains: [...contains].sort(),
      containsFiles: [],
      unresolvedDetectedComponents: [...new Set(unresolvedDetectedComponents)].sort(),
      gaps,
    };
  });
}

function writeDiagnosticSbom(outputRoot, components, assets, fontEvidence, policy) {
  const componentByPurl = new Map(components.map(component => [component.purl, component]));
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
      ],
    });
  }
  const dependencies = assets.map(asset => ({
    ref: `urn:unfallatlas:vendor-asset:${asset.path}`,
    dependsOn: [
      ...asset.contains.filter(purl => componentByPurl.has(purl)),
      ...asset.containsFiles,
    ].sort(),
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

function buildDiagnosticProvenance(repoRoot, outputRoot, copiedAssets) {
  const { policy, sourcePath } = loadPolicy(repoRoot);
  const policyOutputPath = POLICY_RELATIVE_PATH;
  const policyDestination = path.join(outputRoot, policyOutputPath);
  fs.mkdirSync(path.dirname(policyDestination), { recursive: true });
  fs.copyFileSync(sourcePath, policyDestination);

  const lockComponents = loadLockComponents(repoRoot);
  const assets = buildAssetAssessments(repoRoot, copiedAssets, policy, lockComponents);
  const requiredPurls = new Set(assets.flatMap(asset => asset.contains));
  const selected = [];
  for (const candidates of lockComponents.byName.values()) {
    for (const candidate of candidates) if (requiredPurls.has(candidate.purl)) selected.push(candidate);
  }
  const components = [...new Map(selected.map(component => [component.purl, component])).values()]
    .sort((left, right) => left.purl.localeCompare(right.purl))
    .map(component => copyComponentLicenseEvidence(repoRoot, outputRoot, component));
  const fontEvidence = collectFontEvidence(repoRoot, outputRoot);
  const simpleheatLicenseSource = path.join(repoRoot, 'licenses/vendor/simpleheat-BSD-2-Clause.txt');
  const simpleheatLicensePath = 'vendor/licenses/simpleheat-BSD-2-Clause.txt';
  const simpleheatLicenseDestination = path.join(outputRoot, simpleheatLicensePath);
  if (!fs.existsSync(simpleheatLicenseSource)) {
    throw new Error(`[vendor-provenance] Missing simpleheat license text: ${simpleheatLicenseSource}`);
  }
  fs.mkdirSync(path.dirname(simpleheatLicenseDestination), { recursive: true });
  fs.copyFileSync(simpleheatLicenseSource, simpleheatLicenseDestination);
  const supplementalLicenses = [{
    component: 'simpleheat@0.2.0',
    spdx: 'BSD-2-Clause',
    path: simpleheatLicensePath,
    sha256: sha256File(simpleheatLicenseDestination),
    copyrightIncluded: true,
  }];
  const fontContainer = assets.find(asset => asset.path === 'vendor/export/pdfmake-fonts.js');
  if (!fontContainer) throw new Error('[vendor-provenance] Missing delivered pdfmake font container');
  fontContainer.containsFiles = fontEvidence
    .map(font => `urn:unfallatlas:font:${font.name}`)
    .sort();
  const sbom = writeDiagnosticSbom(outputRoot, components, assets, fontEvidence, policy);
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
  POLICY_RELATIVE_PATH,
  VENDOR_BUILD_LOCK_REFERENCE_TYPE,
  VENDOR_BUILD_LOCK_SCHEMA_VERSION,
  VENDOR_BUILD_LOCK_TYPE,
  buildDiagnosticProvenance,
  collectFontEvidence,
  discoverPackageNames,
  loadPolicy,
  npmPurl,
  parseTrueTypeNameTable,
  sriSha512Hex,
  validateCompletenessClaims,
};
