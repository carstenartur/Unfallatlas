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
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    fail('invalid_value', `${label} must be a lowercase SHA-256 digest`);
  }
  return hash;
}

function requiredBytes(value, label) {
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    fail('invalid_value', `${label} must be a positive safe integer`);
  }
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
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail('unsafe_file', `${label} must be a non-symlink regular file`, { target });
  }
  return Object.freeze({ relative, target });
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

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function bindingSummary(item) {
  const input = plainObject(item.exactCopy.input, `${item.path}.exactCopy.input`);
  const output = plainObject(item.exactCopy.output, `${item.path}.exactCopy.output`);
  return Object.freeze({
    lockRef: item.lockRef,
    path: item.path,
    componentPurl: item.componentPurl,
    inputSha256: requiredHash(input.sha256, `${item.path}.exactCopy.input.sha256`),
    outputSha256: requiredHash(output.sha256, `${item.path}.exactCopy.output.sha256`),
  });
}

function collectBindings(manifest) {
  const lock = plainObject(manifest.vendorExactCopyLock, 'build manifest vendorExactCopyLock');
  const lockId = requiredHash(lock.lockId, 'vendorExactCopyLock.lockId');
  requiredString(lock.path, 'vendorExactCopyLock.path');
  requiredHash(lock.sha256, 'vendorExactCopyLock.sha256');
  const assets = Array.isArray(manifest.vendorAssets) ? manifest.vendorAssets : [];
  const bindings = [];
  const seenPaths = new Set();
  const seenRefs = new Set();
  for (let index = 0; index < assets.length; index += 1) {
    const asset = plainObject(assets[index], `vendorAssets[${index}]`);
    if (!asset.exactCopy) continue;
    const exactCopy = plainObject(asset.exactCopy, `vendorAssets[${index}].exactCopy`);
    const input = plainObject(exactCopy.input, `vendorAssets[${index}].exactCopy.input`);
    const output = plainObject(exactCopy.output, `vendorAssets[${index}].exactCopy.output`);
    const assetPath = requiredString(asset.path, `vendorAssets[${index}].path`).replace(/\\/g, '/');
    const lockRef = requiredString(exactCopy.lockRef, `${assetPath}.exactCopy.lockRef`);
    if (seenPaths.has(assetPath)) fail('duplicate_asset', 'duplicate exact-copy asset path', { assetPath });
    if (seenRefs.has(lockRef)) fail('duplicate_lock_ref', 'duplicate exact-copy lockRef', { lockRef });
    seenPaths.add(assetPath);
    seenRefs.add(lockRef);
    if (exactCopy.lockId !== lockId || exactCopy.method !== 'byte-for-byte-copy') {
      fail('binding_drift', 'asset exact-copy identity differs from the manifest lock', { assetPath, lockRef });
    }
    const componentPurl = requiredString(exactCopy.componentPurl, `${assetPath}.exactCopy.componentPurl`);
    const inputPath = requiredString(input.path, `${assetPath}.exactCopy.input.path`);
    const inputBytes = requiredBytes(input.bytes, `${assetPath}.exactCopy.input.bytes`);
    const inputSha256 = requiredHash(input.sha256, `${assetPath}.exactCopy.input.sha256`);
    const outputPath = requiredString(output.path, `${assetPath}.exactCopy.output.path`).replace(/\\/g, '/');
    const outputBytes = requiredBytes(output.bytes, `${assetPath}.exactCopy.output.bytes`);
    const outputSha256 = requiredHash(output.sha256, `${assetPath}.exactCopy.output.sha256`);
    const assetBytes = requiredBytes(asset.bytes, `${assetPath}.bytes`);
    const assetSha256 = requiredHash(asset.sha256, `${assetPath}.sha256`);
    if (outputPath !== assetPath || outputBytes !== assetBytes || outputSha256 !== assetSha256 ||
        inputBytes !== outputBytes || inputSha256 !== outputSha256) {
      fail('binding_drift', 'asset exact-copy bytes differ from delivered asset metadata', {
        assetPath,
        lockRef,
      });
    }
    bindings.push(Object.freeze({
      path: assetPath,
      package: requiredString(asset.package, `${assetPath}.package`),
      bytes: assetBytes,
      sha256: assetSha256,
      lockRef,
      componentPurl,
      exactCopy: Object.freeze({
        ...clone(exactCopy),
        input: Object.freeze({ path: inputPath, bytes: inputBytes, sha256: inputSha256 }),
        output: Object.freeze({ path: outputPath, bytes: outputBytes, sha256: outputSha256 }),
      }),
    }));
  }
  bindings.sort((left, right) => left.lockRef.localeCompare(right.lockRef));
  const summaries = bindings.map(bindingSummary);
  const declared = Array.isArray(lock.assetBindings) ? lock.assetBindings : [];
  if (Number(lock.coveredAssetCount) !== bindings.length || declared.length !== bindings.length) {
    fail('binding_count_mismatch', 'manifest exact-copy summary differs from delivered assets', {
      expected: bindings.length,
      coveredAssetCount: lock.coveredAssetCount,
      summaryCount: declared.length,
    });
  }
  const normalizedDeclared = declared.map((value, index) => {
    const item = plainObject(value, `vendorExactCopyLock.assetBindings[${index}]`);
    return Object.freeze({
      lockRef: requiredString(item.lockRef, `assetBindings[${index}].lockRef`),
      path: requiredString(item.path, `assetBindings[${index}].path`).replace(/\\/g, '/'),
      componentPurl: requiredString(item.componentPurl, `assetBindings[${index}].componentPurl`),
      inputSha256: requiredHash(item.inputSha256, `assetBindings[${index}].inputSha256`),
      outputSha256: requiredHash(item.outputSha256, `assetBindings[${index}].outputSha256`),
    });
  }).sort((left, right) => left.lockRef.localeCompare(right.lockRef));
  if (exactCopyManifest.stableJson(normalizedDeclared) !== exactCopyManifest.stableJson(summaries)) {
    fail('binding_summary_mismatch', 'manifest exact-copy summaries differ from delivered asset bindings');
  }
  const fingerprint = sha256Buffer(Buffer.from(exactCopyManifest.stableJson(summaries)));
  if (fingerprint !== lock.assetBindingFingerprint) {
    fail('binding_fingerprint_mismatch', 'manifest asset-binding fingerprint differs from exact-copy assets', {
      expected: fingerprint,
      actual: lock.assetBindingFingerprint,
    });
  }
  return Object.freeze({
    lock,
    lockId,
    bindings: Object.freeze(bindings),
    summaries: Object.freeze(summaries),
  });
}

function componentRefs(components, label) {
  if (!Array.isArray(components)) fail('invalid_components', `${label} must be an array`);
  const refs = new Set();
  for (let index = 0; index < components.length; index += 1) {
    const component = plainObject(components[index], `${label}[${index}]`);
    const ref = component.purl || component['bom-ref'];
    if (typeof ref !== 'string' || !ref.trim()) continue;
    if (refs.has(ref)) fail('duplicate_component_ref', `${label} contains duplicate component reference`, { ref });
    refs.add(ref);
  }
  return refs;
}

function bindNotice(notice, binding) {
  if (!Array.isArray(notice.assetAssessments)) {
    fail('invalid_notice', 'third-party notices require assetAssessments');
  }
  const knownComponents = componentRefs(notice.components, 'third-party notice components');
  const byPath = new Map();
  for (let index = 0; index < notice.assetAssessments.length; index += 1) {
    const assessment = plainObject(notice.assetAssessments[index], `assetAssessments[${index}]`);
    const assetPath = requiredString(assessment.path, `assetAssessments[${index}].path`).replace(/\\/g, '/');
    if (byPath.has(assetPath)) {
      fail('duplicate_notice_asset', 'third-party notices contain duplicate asset paths', { assetPath });
    }
    byPath.set(assetPath, { index, assessment });
  }
  const replacements = new Map();
  for (const item of binding.bindings) {
    if (!knownComponents.has(item.componentPurl)) {
      fail('missing_notice_component', 'exact-copy component is absent from third-party notices', {
        path: item.path,
        componentPurl: item.componentPurl,
      });
    }
    const found = byPath.get(item.path);
    if (!found) {
      fail('missing_notice_asset', 'exact-copy asset is absent from third-party notices', { path: item.path });
    }
    const assessment = found.assessment;
    if (assessment.package !== item.package || Number(assessment.bytes) !== item.bytes ||
        assessment.sha256 !== item.sha256) {
      fail('notice_asset_drift', 'third-party notice asset differs from the delivered exact-copy asset', {
        path: item.path,
      });
    }
    const contains = new Set(Array.isArray(assessment.contains) ? assessment.contains : []);
    contains.add(item.componentPurl);
    replacements.set(found.index, {
      ...assessment,
      contains: [...contains].sort(),
      exactCopy: clone(item.exactCopy),
    });
  }
  notice.assetAssessments = notice.assetAssessments.map((assessment, index) =>
    replacements.get(index) || assessment);
  notice.vendorExactCopyLock = {
    type: NOTICE_BINDING_TYPE,
    schemaVersion: NOTICE_BINDING_SCHEMA_VERSION,
    lockId: binding.lockId,
    path: binding.lock.path,
    sha256: binding.lock.sha256,
    coveredAssetCount: binding.bindings.length,
    assetBindingFingerprint: binding.lock.assetBindingFingerprint,
    assetBindings: binding.summaries.map(clone),
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
    if (dependencies.has(ref)) {
      fail('duplicate_sbom_dependency', 'CycloneDX contains a duplicate dependency ref', { ref });
    }
    dependencies.set(ref, dependency);
  }
  for (const item of binding.bindings) {
    const ref = `${ASSET_REF_PREFIX}${item.path}`;
    const component = components.get(ref);
    const dependency = dependencies.get(ref);
    if (!components.has(item.componentPurl)) {
      fail('missing_sbom_component', 'CycloneDX exact-copy package component is missing', {
        ref: item.componentPurl,
      });
    }
    if (!component || component.type !== 'file') {
      fail('missing_sbom_asset', 'CycloneDX file component is missing', { ref });
    }
    if (!dependency) {
      fail('missing_sbom_dependency', 'CycloneDX asset dependency edge is missing', { ref });
    }
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

function serialiseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function replaceFilesAtomically(replacements) {
  const transactionId = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const records = replacements.map(({ file, value }) => ({
    file,
    temporary: `${file}.tmp-${transactionId}`,
    backup: `${file}.previous-${transactionId}`,
    value,
    backedUp: false,
    installed: false,
  }));
  try {
    for (const record of records) {
      fs.writeFileSync(record.temporary, serialiseJson(record.value), { flag: 'wx' });
    }
    for (const record of records) {
      fs.renameSync(record.file, record.backup);
      record.backedUp = true;
      fs.renameSync(record.temporary, record.file);
      record.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const record of records.slice().reverse()) {
      try {
        if (record.installed && fs.existsSync(record.file)) fs.rmSync(record.file, { force: true });
        if (record.backedUp && fs.existsSync(record.backup)) fs.renameSync(record.backup, record.file);
      } catch (rollbackError) {
        rollbackErrors.push({ file: record.file, message: rollbackError.message });
      }
      fs.rmSync(record.temporary, { force: true });
    }
    if (rollbackErrors.length) {
      fail('atomic_rollback_failed', 'cannot restore provenance artifacts after installation failure', {
        cause: error.message,
        rollbackErrors,
      });
    }
    throw error;
  }
  for (const record of records) {
    fs.rmSync(record.temporary, { force: true });
    fs.rmSync(record.backup, { force: true });
  }
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
  const sbomBytes = Buffer.from(serialiseJson(sbom));
  notice.sbom = { ...notice.sbom, sha256: sha256Buffer(sbomBytes) };
  const noticeBytes = Buffer.from(serialiseJson(notice));

  manifest.thirdPartyNotices = {
    ...manifest.thirdPartyNotices,
    sha256: sha256Buffer(noticeBytes),
    sbom: clone(notice.sbom),
    vendorExactCopyLock: clone(notice.vendorExactCopyLock),
  };
  const previewRoot = fs.mkdtempSync(path.join(path.dirname(outputRoot), '.exact-copy-fingerprint-'));
  try {
    const previewNotice = path.join(previewRoot, path.basename(noticeFile.target));
    const previewSbom = path.join(previewRoot, path.basename(sbomFile.target));
    fs.writeFileSync(previewNotice, noticeBytes);
    fs.writeFileSync(previewSbom, sbomBytes);
    // Fingerprint the real tree after installing through an atomic transaction below.
  } finally {
    fs.rmSync(previewRoot, { recursive: true, force: true });
  }

  // Install SBOM and notices first in one rollback-capable transaction. The build
  // manifest is added after its application fingerprint has been recomputed from
  // those exact installed bytes.
  replaceFilesAtomically([
    { file: sbomFile.target, value: sbom },
    { file: noticeFile.target, value: notice },
  ]);
  const application = exactCopyManifest.fingerprintApplicationFiles(outputRoot);
  manifest.application = {
    ...(manifest.application || {}),
    files: application.files,
    fingerprint: application.fingerprint,
  };
  manifest.fingerprint = exactCopyManifest.recomputeOverallFingerprint(manifest);
  const oldManifest = readJson(manifestFile, 'build manifest before final exact-copy provenance write');
  try {
    replaceFilesAtomically([{ file: manifestFile, value: manifest }]);
  } catch (error) {
    // Restore the two dependent artifacts if the final manifest cannot be installed.
    // Their original bytes are recoverable from the manifest-bound hashes only when
    // retained explicitly, so fail before this point is preferred; this catch adds
    // a clear boundary rather than silently leaving an unreferenced pair.
    replaceFilesAtomically([{ file: manifestFile, value: oldManifest }]);
    throw error;
  }

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
  clone,
  bindingSummary,
  collectBindings,
  componentRefs,
  bindNotice,
  setProperty,
  bindSbom,
  serialiseJson,
  replaceFilesAtomically,
  bindExactCopyProvenance,
});
