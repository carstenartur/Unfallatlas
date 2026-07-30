#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const exactCopyManifest = require('./vendor-exact-copy-manifest');

const NOTICE_BINDING_SCHEMA_VERSION = 1;
const NOTICE_BINDING_TYPE = 'unfallatlas-vendor-exact-copy-provenance-binding';
const ASSET_REF_PREFIX = 'urn:unfallatlas:vendor-asset:';

class VendorExactCopyProvenanceError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'VendorExactCopyProvenanceError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new VendorExactCopyProvenanceError(code, message, details);
}

function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`);
  }
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_value', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requiredHash(value, label) {
  const hash = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(hash)) fail('invalid_value', `${label} must be a lowercase SHA-256 digest`);
  return hash;
}

function requiredBytes(value, label) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) fail('invalid_value', `${label} must be a positive safe integer`);
  return bytes;
}

function resolveArtifactFile(outputRoot, relativePath, label) {
  const relative = requiredString(relativePath, `${label} path`).replace(/\\/g, '/');
  const target = path.resolve(outputRoot, relative);
  const rel = path.relative(outputRoot, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('unsafe_path', `${label} escapes the output root`, { relative });
  }
  if (!fs.existsSync(target)) fail('missing_file', `${label} does not exist`, { target });
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_file', `${label} must be a non-symlink regular file`, { target });
  return { relative, target };
}

function readJson(file, label) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail('invalid_json', `${label} is not valid JSON`, { file, cause: error.message });
  }
  return plainObject(value, label);
}

function writeJson(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function collectBindings(manifest) {
  const lock = plainObject(manifest.vendorExactCopyLock, 'build manifest vendorExactCopyLock');
  const lockId = requiredHash(lock.lockId, 'vendorExactCopyLock.lockId');
  const assets = Array.isArray(manifest.vendorAssets) ? manifest.vendorAssets : [];
  const bindings = [];
  const seenPaths = new Set();
  const seenRefs = new Set();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = plainObject(assets[index], `vendorAssets[${index}]`);
    if (!asset.exactCopy) continue;
    const exactCopy = plainObject(asset.exactCopy, `vendorAssets[${index}].exactCopy`);
    const assetPath = requiredString(asset.path, `vendorAssets[${index}].path`).replace(/\\/g, '/');
    const lockRef = requiredString(exactCopy.lockRef, `${assetPath}.exactCopy.lockRef`);
    if (seenPaths.has(assetPath)) fail('duplicate_asset', 'duplicate exact-copy asset path', { assetPath });
    if (seenRefs.has(lockRef)) fail('duplicate_lock_ref', 'duplicate exact-copy lockRef', { lockRef });
    seenPaths.add(assetPath);
    seenRefs.add(lockRef);
    if (exactCopy.lockId !== lockId || exactCopy.method !== 'byte-for-byte-copy') {
      fail('binding_drift', 'asset exact-copy identity differs from the manifest lock', { assetPath, lockRef });
    }
    const output = plainObject(exactCopy.output, `${assetPath}.exactCopy.output`);
    const componentPurl = requiredString(exactCopy.componentPurl, `${assetPath}.exactCopy.componentPurl`);
    const outputPath = requiredString(output.path, `${assetPath}.exactCopy.output.path`).replace(/\\/g, '/');
    if (outputPath !== assetPath || requiredBytes(output.bytes, `${assetPath}.exactCopy.output.bytes`) !== requiredBytes(asset.bytes, `${assetPath}.bytes`) ||
        requiredHash(output.sha256, `${assetPath}.exactCopy.output.sha256`) !== requiredHash(asset.sha256, `${assetPath}.sha256`)) {
      fail('binding_drift', 'asset exact-copy output differs from delivered asset metadata', { assetPath, lockRef });
    }
    bindings.push(Object.freeze({
      path: assetPath,
      package: requiredString(asset.package, `${assetPath}.package`),
      bytes: requiredBytes(asset.bytes, `${assetPath}.bytes`),
      sha256: requiredHash(asset.sha256, `${assetPath}.sha256`),
      lockRef,
      componentPurl,
      exactCopy: clone(exactCopy),
    }));
  }
  bindings.sort((left, right) => left.lockRef.localeCompare(right.lockRef));
  const declared = Array.isArray(lock.assetBindings) ? lock.assetBindings : [];
  if (Number(lock.coveredAssetCount) !== bindings.length || declared.length !== bindings.length) {
    fail('binding_count_mismatch', 'manifest exact-copy summary differs from delivered assets', {
      expected: bindings.length,
      coveredAssetCount: lock.coveredAssetCount,
      summaryCount: declared.length,
    });
  }
  const fingerprint = sha256Buffer(Buffer.from(exactCopyManifest.stableJson(bindings.map(binding => ({
    lockRef: binding.lockRef,
    path: binding.path,
    componentPurl: binding.componentPurl,
    inputSha256: binding.exactCopy.input.sha256,
    outputSha256: binding.exactCopy.output.sha256,
  })))));
  if (fingerprint !== lock.assetBindingFingerprint) {
    fail('binding_fingerprint_mismatch', 'manifest asset-binding fingerprint differs from exact-copy assets', {
      expected: fingerprint,
      actual: lock.assetBindingFingerprint,
    });
  }
  return Object.freeze({ lock, lockId, bindings: Object.freeze(bindings) });
}

function bindNotice(notice, binding) {
  if (!Array.isArray(notice.assetAssessments)) fail('invalid_notice', 'third-party notices require assetAssessments');
  const byPath = new Map();
  for (let index = 0; index < notice.assetAssessments.length; index += 1) {
    const assessment = plainObject(notice.assetAssessments[index], `assetAssessments[${index}]`);
    const assetPath = requiredString(assessment.path, `assetAssessments[${index}].path`).replace(/\\/g, '/');
    if (byPath.has(assetPath)) fail('duplicate_notice_asset', 'third-party notices contain duplicate asset paths', { assetPath });
    byPath.set(assetPath, { index, assessment });
  }
  const replacements = new Map();
  for (const item of binding.bindings) {
    const found = byPath.get(item.path);
    if (!found) fail('missing_notice_asset', 'exact-copy asset is absent from third-party notices', { path: item.path });
    const assessment = found.assessment;
    if (assessment.package !== item.package || Number(assessment.bytes) !== item.bytes || assessment.sha256 !== item.sha256) {
      fail('notice_asset_drift', 'third-party notice asset differs from the delivered exact-copy asset', { path: item.path });
    }
    const contains = new Set(Array.isArray(assessment.contains) ? assessment.contains : []);
    contains.add(item.componentPurl);
    replacements.set(found.index, {
      ...assessment,
      contains: [...contains].sort(),
      exactCopy: clone(item.exactCopy),
    });
  }
  notice.assetAssessments = notice.assetAssessments.map((assessment, index) => replacements.get(index) || assessment);
  notice.vendorExactCopyLock = {
    type: NOTICE_BINDING_TYPE,
    schemaVersion: NOTICE_BINDING_SCHEMA_VERSION,
    lockId: binding.lockId,
    path: binding.lock.path,
    sha256: binding.lock.sha256,
    coveredAssetCount: binding.bindings.length,
    assetBindingFingerprint: binding.lock.assetBindingFingerprint,
    assetBindings: binding.bindings.map(item => ({
      lockRef: item.lockRef,
      path: item.path,
      componentPurl: item.componentPurl,
      inputSha256: item.exactCopy.input.sha256,
      outputSha256: item.exactCopy.output.sha256,
    })),
  };
  return notice;
}

function setProperty(component, name, value) {
  const properties = Array.isArray(component.properties) ? component.properties : [];
  const filtered = properties.filter(property => property && property.name !== name);
  filtered.push({ name, value: String(value) });
  filtered.sort((left, right) => String(left.name).localeCompare(String(right.name)));
  component.properties = filtered;
}

function bindSbom(sbom, binding) {
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6') {
    fail('invalid_sbom', 'exact-copy provenance requires CycloneDX 1.6');
  }
  if (!Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    fail('invalid_sbom', 'CycloneDX components and dependencies are required');
  }
  const components = new Map();
  for (const component of sbom.components) {
    const ref = component && component['bom-ref'];
    if (typeof ref !== 'string') continue;
    if (components.has(ref)) fail('duplicate_sbom_ref', 'CycloneDX contains a duplicate bom-ref', { ref });
    components.set(ref, component);
  }
  const dependencies = new Map();
  for (const dependency of sbom.dependencies) {
    const ref = dependency && dependency.ref;
    if (typeof ref !== 'string') continue;
    if (dependencies.has(ref)) fail('duplicate_sbom_dependency', 'CycloneDX contains a duplicate dependency ref', { ref });
    dependencies.set(ref, dependency);
  }
  for (const item of binding.bindings) {
    const ref = `${ASSET_REF_PREFIX}${item.path}`;
    const component = components.get(ref);
    const dependency = dependencies.get(ref);
    if (!component || component.type !== 'file') fail('missing_sbom_asset', 'CycloneDX file component is missing', { ref });
    if (!dependency) fail('missing_sbom_dependency', 'CycloneDX asset dependency edge is missing', { ref });
    const dependsOn = new Set(Array.isArray(dependency.dependsOn) ? dependency.dependsOn : []);
    dependsOn.add(item.componentPurl);
    dependency.dependsOn = [...dependsOn].sort();
    setProperty(component, 'unfallatlas:exact-copy-lock-id', binding.lockId);
    setProperty(component, 'unfallatlas:exact-copy-lock-ref', item.lockRef);
    setProperty(component, 'unfallatlas:exact-copy-component-purl', item.componentPurl);
    setProperty(component, 'unfallatlas:exact-copy-input-sha256', item.exactCopy.input.sha256);
    setProperty(component, 'unfallatlas:exact-copy-output-sha256', item.exactCopy.output.sha256);
    setProperty(component, 'unfallatlas:exact-copy-method', item.exactCopy.method);
  }
  return sbom;
}

function bindExactCopyProvenance(options = {}) {
  const outputRoot = fs.realpathSync(path.resolve(String(options.outputRoot || '')));
  const manifestFile = path.join(outputRoot, 'build-manifest.json');
  const manifest = readJson(manifestFile, 'build manifest');
  const binding = collectBindings(manifest);

  const noticeRef = plainObject(manifest.thirdPartyNotices, 'build manifest thirdPartyNotices');
  const noticeFile = resolveArtifactFile(outputRoot, noticeRef.path, 'third-party notices');
  if (sha256File(noticeFile.target) !== requiredHash(noticeRef.sha256, 'thirdPartyNotices.sha256')) {
    fail('notice_hash_drift', 'third-party notices differ from the build manifest');
  }
  const notice = bindNotice(readJson(noticeFile.target, 'third-party notices'), binding);
  const sbomRef = plainObject(notice.sbom, 'third-party notices sbom');
  const sbomFile = resolveArtifactFile(outputRoot, sbomRef.path, 'CycloneDX SBOM');
  if (sha256File(sbomFile.target) !== requiredHash(sbomRef.sha256, 'third-party notices sbom.sha256')) {
    fail('sbom_hash_drift', 'CycloneDX SBOM differs from third-party notices');
  }
  const sbom = bindSbom(readJson(sbomFile.target, 'CycloneDX SBOM'), binding);
  writeJson(sbomFile.target, sbom);
  notice.sbom = { ...notice.sbom, sha256: sha256File(sbomFile.target) };
  writeJson(noticeFile.target, notice);

  manifest.thirdPartyNotices = {
    ...manifest.thirdPartyNotices,
    sha256: sha256File(noticeFile.target),
    sbom: clone(notice.sbom),
    vendorExactCopyLock: clone(notice.vendorExactCopyLock),
  };
  const application = exactCopyManifest.fingerprintApplicationFiles(outputRoot);
  manifest.application = {
    ...(manifest.application || {}),
    files: application.files,
    fingerprint: application.fingerprint,
  };
  manifest.fingerprint = exactCopyManifest.recomputeOverallFingerprint(manifest);
  writeJson(manifestFile, manifest);

  return Object.freeze({
    manifest: Object.freeze(manifest),
    manifestPath: manifestFile,
    manifestSha256: sha256File(manifestFile),
    noticePath: noticeFile.target,
    noticeSha256: manifest.thirdPartyNotices.sha256,
    sbomPath: sbomFile.target,
    sbomSha256: notice.sbom.sha256,
    bindingCount: binding.bindings.length,
  });
}

module.exports = Object.freeze({
  NOTICE_BINDING_SCHEMA_VERSION,
  NOTICE_BINDING_TYPE,
  ASSET_REF_PREFIX,
  VendorExactCopyProvenanceError,
  sha256Buffer,
  sha256File,
  plainObject,
  requiredString,
  requiredHash,
  requiredBytes,
  resolveArtifactFile,
  readJson,
  writeJson,
  collectBindings,
  bindNotice,
  setProperty,
  bindSbom,
  bindExactCopyProvenance,
});
