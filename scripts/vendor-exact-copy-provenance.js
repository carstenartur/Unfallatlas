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
  const valueString = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(valueString)) {
    fail('invalid_value', `${label} must be a lowercase SHA-256 digest`);
  }
  return valueString;
}

function requiredBytes(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail('invalid_value', `${label} must be a positive safe integer`);
  }
  return number;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function serialiseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
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

function resolveOutputRoot(value) {
  const requested = path.resolve(String(value || ''));
  let root;
  try {
    root = fs.realpathSync(requested);
  } catch (error) {
    fail('missing_root', 'outputRoot does not exist', { requested, cause: error.message });
  }
  if (!fs.statSync(root).isDirectory()) fail('invalid_root', 'outputRoot must be a directory', { root });
  return root;
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

function bindingSummary(binding) {
  return Object.freeze({
    lockRef: binding.lockRef,
    path: binding.path,
    componentPurl: binding.componentPurl,
    inputSha256: binding.exactCopy.input.sha256,
    outputSha256: binding.exactCopy.output.sha256,
  });
}

function collectBindings(manifestValue) {
  const manifest = plainObject(manifestValue, 'build manifest');
  const lock = plainObject(manifest.vendorExactCopyLock, 'vendorExactCopyLock');
  const lockId = requiredHash(lock.lockId, 'vendorExactCopyLock.lockId');
  requiredString(lock.path, 'vendorExactCopyLock.path');
  requiredHash(lock.sha256, 'vendorExactCopyLock.sha256');
  if (!Array.isArray(manifest.vendorAssets)) fail('invalid_assets', 'build manifest vendorAssets must be an array');

  const bindings = [];
  const paths = new Set();
  const refs = new Set();
  for (let index = 0; index < manifest.vendorAssets.length; index += 1) {
    const asset = plainObject(manifest.vendorAssets[index], `vendorAssets[${index}]`);
    if (asset.exactCopy == null) continue;
    const exactCopy = plainObject(asset.exactCopy, `vendorAssets[${index}].exactCopy`);
    const input = plainObject(exactCopy.input, `vendorAssets[${index}].exactCopy.input`);
    const output = plainObject(exactCopy.output, `vendorAssets[${index}].exactCopy.output`);
    const assetPath = requiredString(asset.path, `vendorAssets[${index}].path`).replace(/\\/g, '/');
    const lockRef = requiredString(exactCopy.lockRef, `${assetPath}.exactCopy.lockRef`);
    if (paths.has(assetPath)) fail('duplicate_asset', 'duplicate exact-copy asset path', { assetPath });
    if (refs.has(lockRef)) fail('duplicate_lock_ref', 'duplicate exact-copy lockRef', { lockRef });
    paths.add(assetPath);
    refs.add(lockRef);

    const packageName = requiredString(asset.package, `${assetPath}.package`);
    const assetBytes = requiredBytes(asset.bytes, `${assetPath}.bytes`);
    const assetSha256 = requiredHash(asset.sha256, `${assetPath}.sha256`);
    const componentPurl = requiredString(exactCopy.componentPurl, `${assetPath}.exactCopy.componentPurl`);
    const inputPath = requiredString(input.path, `${assetPath}.exactCopy.input.path`);
    const inputBytes = requiredBytes(input.bytes, `${assetPath}.exactCopy.input.bytes`);
    const inputSha256 = requiredHash(input.sha256, `${assetPath}.exactCopy.input.sha256`);
    const outputPath = requiredString(output.path, `${assetPath}.exactCopy.output.path`).replace(/\\/g, '/');
    const outputBytes = requiredBytes(output.bytes, `${assetPath}.exactCopy.output.bytes`);
    const outputSha256 = requiredHash(output.sha256, `${assetPath}.exactCopy.output.sha256`);
    if (exactCopy.lockId !== lockId || exactCopy.method !== 'byte-for-byte-copy' ||
        outputPath !== assetPath || outputBytes !== assetBytes || outputSha256 !== assetSha256 ||
        inputBytes !== outputBytes || inputSha256 !== outputSha256) {
      fail('binding_drift', 'exact-copy binding differs from delivered asset bytes', { assetPath, lockRef });
    }
    bindings.push(Object.freeze({
      path: assetPath,
      package: packageName,
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
    fail('binding_count_mismatch', 'vendorExactCopyLock summary count differs from delivered assets');
  }
  const normalizedDeclared = declared.map((entryValue, index) => {
    const entry = plainObject(entryValue, `vendorExactCopyLock.assetBindings[${index}]`);
    return Object.freeze({
      lockRef: requiredString(entry.lockRef, `assetBindings[${index}].lockRef`),
      path: requiredString(entry.path, `assetBindings[${index}].path`).replace(/\\/g, '/'),
      componentPurl: requiredString(entry.componentPurl, `assetBindings[${index}].componentPurl`),
      inputSha256: requiredHash(entry.inputSha256, `assetBindings[${index}].inputSha256`),
      outputSha256: requiredHash(entry.outputSha256, `assetBindings[${index}].outputSha256`),
    });
  }).sort((left, right) => left.lockRef.localeCompare(right.lockRef));
  if (exactCopyManifest.stableJson(normalizedDeclared) !== exactCopyManifest.stableJson(summaries)) {
    fail('binding_summary_mismatch', 'vendorExactCopyLock assetBindings differ from delivered assets');
  }
  const fingerprint = sha256Buffer(Buffer.from(exactCopyManifest.stableJson(summaries)));
  if (fingerprint !== requiredHash(lock.assetBindingFingerprint, 'vendorExactCopyLock.assetBindingFingerprint')) {
    fail('binding_fingerprint_mismatch', 'vendorExactCopyLock fingerprint differs from delivered assets');
  }
  return Object.freeze({ lock, lockId, bindings: Object.freeze(bindings), summaries: Object.freeze(summaries) });
}

function componentRefs(components, label, key) {
  if (!Array.isArray(components)) fail('invalid_components', `${label} must be an array`);
  const refs = new Set();
  for (let index = 0; index < components.length; index += 1) {
    const component = plainObject(components[index], `${label}[${index}]`);
    const ref = component[key];
    if (typeof ref !== 'string' || !ref.trim()) continue;
    if (refs.has(ref)) fail('duplicate_component_ref', `${label} contains duplicate component reference`, { ref });
    refs.add(ref);
  }
  return refs;
}

function bindNotice(noticeValue, binding) {
  const notice = plainObject(noticeValue, 'third-party notices');
  if (!Array.isArray(notice.assetAssessments)) fail('invalid_notice', 'third-party notices require assetAssessments');
  const knownComponents = componentRefs(notice.components, 'third-party notice components', 'purl');
  const assessmentsByPath = new Map();
  for (let index = 0; index < notice.assetAssessments.length; index += 1) {
    const assessment = plainObject(notice.assetAssessments[index], `assetAssessments[${index}]`);
    const assetPath = requiredString(assessment.path, `assetAssessments[${index}].path`).replace(/\\/g, '/');
    if (assessmentsByPath.has(assetPath)) fail('duplicate_notice_asset', 'duplicate notice asset path', { assetPath });
    assessmentsByPath.set(assetPath, { index, assessment });
  }
  const replacements = new Map();
  for (const item of binding.bindings) {
    if (!knownComponents.has(item.componentPurl)) {
      fail('missing_notice_component', 'exact-copy component is absent from third-party notices', {
        path: item.path,
        componentPurl: item.componentPurl,
      });
    }
    const found = assessmentsByPath.get(item.path);
    if (!found) fail('missing_notice_asset', 'exact-copy asset is absent from third-party notices', { path: item.path });
    const assessment = found.assessment;
    if (assessment.package !== item.package || Number(assessment.bytes) !== item.bytes ||
        assessment.sha256 !== item.sha256) {
      fail('notice_asset_drift', 'notice asset differs from delivered exact-copy asset', { path: item.path });
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
  component.properties = properties
    .filter(property => property && property.name !== name)
    .concat({ name, value: String(value) })
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

function bindSbom(sbomValue, binding) {
  const sbom = plainObject(sbomValue, 'CycloneDX SBOM');
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6' ||
      !Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies)) {
    fail('invalid_sbom', 'exact-copy provenance requires CycloneDX 1.6 components and dependencies');
  }
  const components = new Map();
  for (const component of sbom.components) {
    const ref = component && component['bom-ref'];
    if (typeof ref !== 'string') continue;
    if (components.has(ref)) fail('duplicate_sbom_ref', 'duplicate CycloneDX bom-ref', { ref });
    components.set(ref, component);
  }
  const dependencies = new Map();
  for (const dependency of sbom.dependencies) {
    const ref = dependency && dependency.ref;
    if (typeof ref !== 'string') continue;
    if (dependencies.has(ref)) fail('duplicate_sbom_dependency', 'duplicate CycloneDX dependency ref', { ref });
    dependencies.set(ref, dependency);
  }
  for (const item of binding.bindings) {
    const assetRef = `${ASSET_REF_PREFIX}${item.path}`;
    const assetComponent = components.get(assetRef);
    const dependency = dependencies.get(assetRef);
    if (!components.has(item.componentPurl)) {
      fail('missing_sbom_component', 'CycloneDX package component is missing', { ref: item.componentPurl });
    }
    if (!assetComponent || assetComponent.type !== 'file') {
      fail('missing_sbom_asset', 'CycloneDX vendor file component is missing', { ref: assetRef });
    }
    if (!dependency) fail('missing_sbom_dependency', 'CycloneDX vendor dependency edge is missing', { ref: assetRef });
    const dependsOn = new Set(Array.isArray(dependency.dependsOn) ? dependency.dependsOn : []);
    dependsOn.add(item.componentPurl);
    dependency.dependsOn = [...dependsOn].sort();
    setProperty(assetComponent, 'unfallatlas:exact-copy-lock-id', binding.lockId);
    setProperty(assetComponent, 'unfallatlas:exact-copy-lock-ref', item.lockRef);
    setProperty(assetComponent, 'unfallatlas:exact-copy-component-purl', item.componentPurl);
    setProperty(assetComponent, 'unfallatlas:exact-copy-input-sha256', item.exactCopy.input.sha256);
    setProperty(assetComponent, 'unfallatlas:exact-copy-output-sha256', item.exactCopy.output.sha256);
    setProperty(assetComponent, 'unfallatlas:exact-copy-method', item.exactCopy.method);
  }
  return sbom;
}

function fingerprintApplicationFilesWithOverrides(outputRoot, overrides) {
  const files = exactCopyManifest.fingerprintApplicationFiles(outputRoot).files;
  const digest = crypto.createHash('sha256');
  for (const relative of files) {
    const bytes = overrides.has(relative)
      ? Buffer.from(overrides.get(relative))
      : fs.readFileSync(path.join(outputRoot, relative));
    digest.update(`${relative}\0${sha256Buffer(bytes)}`);
    if (relative !== files[files.length - 1]) digest.update('\n');
  }
  return Object.freeze({ files, fingerprint: digest.digest('hex') });
}

function replaceFilesAtomically(replacements, hooks = {}) {
  const writeFileSync = hooks.writeFileSync || fs.writeFileSync;
  const renameSync = hooks.renameSync || fs.renameSync;
  const rmSync = hooks.rmSync || fs.rmSync;
  const existsSync = hooks.existsSync || fs.existsSync;
  const lstatSync = hooks.lstatSync || fs.lstatSync;
  const transactionId = `${process.pid}-${crypto.randomBytes(5).toString('hex')}`;
  const seen = new Set();
  const records = replacements.map(({ file, value }) => {
    const target = path.resolve(file);
    if (seen.has(target)) fail('duplicate_transaction_target', 'atomic transaction contains duplicate file', { target });
    seen.add(target);
    if (!existsSync(target)) fail('missing_transaction_target', 'atomic transaction target is missing', { target });
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      fail('unsafe_transaction_target', 'atomic transaction target must be a non-symlink regular file', { target });
    }
    return {
      file: target,
      temporary: `${target}.tmp-${transactionId}`,
      backup: `${target}.previous-${transactionId}`,
      bytes: Buffer.from(serialiseJson(value)),
      backedUp: false,
      installed: false,
    };
  });
  try {
    for (const record of records) writeFileSync(record.temporary, record.bytes, { flag: 'wx' });
    for (const record of records) {
      renameSync(record.file, record.backup);
      record.backedUp = true;
      renameSync(record.temporary, record.file);
      record.installed = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const record of records.slice().reverse()) {
      try {
        if (record.installed && existsSync(record.file)) rmSync(record.file, { force: true });
        if (record.backedUp && existsSync(record.backup)) renameSync(record.backup, record.file);
      } catch (rollbackError) {
        rollbackErrors.push({ file: record.file, message: rollbackError.message });
      }
      try { rmSync(record.temporary, { force: true }); } catch (_) { /* preserve primary failure */ }
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
    try { rmSync(record.temporary, { force: true }); } catch (_) { /* already installed */ }
    try { rmSync(record.backup, { force: true }); } catch (_) { /* valid output remains installed */ }
  }
}

function bindExactCopyProvenance(options = {}) {
  const outputRoot = resolveOutputRoot(options.outputRoot);
  const manifestFile = resolveArtifactFile(outputRoot, 'build-manifest.json', 'build manifest');
  const manifest = readJson(manifestFile.target, 'build manifest');
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
  const application = fingerprintApplicationFilesWithOverrides(outputRoot, new Map([
    [noticeFile.relative, noticeBytes],
    [sbomFile.relative, sbomBytes],
  ]));
  manifest.application = {
    ...(manifest.application || {}),
    files: application.files,
    fingerprint: application.fingerprint,
  };
  manifest.fingerprint = exactCopyManifest.recomputeOverallFingerprint(manifest);

  replaceFilesAtomically([
    { file: sbomFile.target, value: sbom },
    { file: noticeFile.target, value: notice },
    { file: manifestFile.target, value: manifest },
  ], options.transactionHooks);

  return Object.freeze({
    manifest: Object.freeze(manifest),
    manifestPath: manifestFile.target,
    manifestSha256: sha256File(manifestFile.target),
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
  clone,
  serialiseJson,
  readJson,
  resolveOutputRoot,
  resolveArtifactFile,
  bindingSummary,
  collectBindings,
  componentRefs,
  bindNotice,
  setProperty,
  bindSbom,
  fingerprintApplicationFilesWithOverrides,
  replaceFilesAtomically,
  bindExactCopyProvenance,
});
