#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  POLICY_RELATIVE_PATH,
  VENDOR_BUILD_LOCK_REFERENCE_TYPE,
  VENDOR_BUILD_LOCK_SCHEMA_VERSION,
  VENDOR_BUILD_LOCK_TYPE,
  sriSha512Hex,
  validateCompletenessClaims,
} = require('./vendor-provenance');

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SHA512_PATTERN = /^[a-f0-9]{128}$/;
const DSSE_PAYLOAD_TYPE = 'application/vnd.in-toto+json';
const IN_TOTO_STATEMENT_TYPE = 'https://in-toto.io/Statement/v1';
const SLSA_PROVENANCE_TYPE = 'https://slsa.dev/provenance/v1';
const VENDOR_BUILD_TYPE = 'https://github.com/carstenartur/Unfallatlas/vendor-build/v1';
const BUILD_INPUT_TYPES = new Set([
  'build-config',
  'dependency-lock',
  'dsse-provenance',
  'license-file',
  'source-archive',
  'source-file',
  'toolchain-archive',
]);

function parseArgs(argv) {
  const args = {
    manifest: '_site/vendor/third-party-notices.json',
    requireComplete: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--manifest') args.manifest = argv[++index] || '';
    else if (argument === '--require-complete') args.requireComplete = true;
    else throw new Error(`[validate-vendor-provenance] Unknown argument: ${argument}`);
  }
  if (!args.manifest) throw new Error('[validate-vendor-provenance] --manifest requires a path');
  return args;
}

function validateVendorProvenance(manifestPath, options = {}) {
  const absolute = path.resolve(manifestPath);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
    throw new Error(`[validate-vendor-provenance] Manifest does not exist: ${absolute}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`[validate-vendor-provenance] Invalid JSON: ${error.message}`);
  }
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.dependencies) ||
      !Array.isArray(manifest.components) || !Array.isArray(manifest.assetAssessments) ||
      !Array.isArray(manifest.fontEvidence) || !Array.isArray(manifest.knownGaps) ||
      typeof manifest.complete !== 'boolean' || typeof manifest.inventoryScope !== 'string') {
    throw new Error('[validate-vendor-provenance] Unsupported or incomplete notice schema');
  }
  validateDiagnosticInventory(manifest);
  const artifactRoot = path.basename(path.dirname(absolute)) === 'vendor'
    ? path.dirname(path.dirname(absolute))
    : path.dirname(absolute);
  verifyDiagnosticEvidenceFiles(artifactRoot, manifest);
  verifyEvidenceFile(artifactRoot, manifest.provenancePolicy, 'provenance policy');
  verifyEvidenceFile(artifactRoot, manifest.sbom, 'CycloneDX SBOM');
  const policy = JSON.parse(fs.readFileSync(path.join(artifactRoot, manifest.provenancePolicy.path), 'utf8'));
  const trustedPolicyPath = path.join(__dirname, '..', POLICY_RELATIVE_PATH);
  const trustedPolicyBytes = fs.readFileSync(trustedPolicyPath);
  const trustedPolicySha256 = crypto.createHash('sha256').update(trustedPolicyBytes).digest('hex');
  if (manifest.provenancePolicy.path !== POLICY_RELATIVE_PATH ||
      manifest.provenancePolicy.sha256 !== trustedPolicySha256) {
    throw new Error('[validate-vendor-provenance] Artifact policy is not bound to the checked-in trust policy');
  }
  const trustedPolicy = JSON.parse(trustedPolicyBytes.toString('utf8'));
  validatePolicyBinding(manifest, policy, trustedPolicy);
  const sbom = JSON.parse(fs.readFileSync(path.join(artifactRoot, manifest.sbom.path), 'utf8'));
  if (sbom.bomFormat !== 'CycloneDX' || sbom.specVersion !== '1.6' ||
      !Array.isArray(sbom.components) || !Array.isArray(sbom.dependencies) ||
      !Array.isArray(sbom.compositions)) {
    throw new Error('[validate-vendor-provenance] Invalid CycloneDX 1.6 diagnostic SBOM');
  }
  validateDiagnosticSbom(manifest, sbom);
  if (manifest.complete === true) {
    validateCompletenessClaims(manifest);
    validateCompleteSbom(manifest, sbom);
    verifyCompleteEvidenceFiles(artifactRoot, manifest);
    loadAndValidateVendorBuildLock(artifactRoot, manifest, trustedPolicy);
  }
  if (options.requireComplete && manifest.complete !== true) {
    throw new Error(
      '[validate-vendor-provenance] Release/deployment blocked: browser vendor provenance is incomplete. ' +
      `Resolve ${manifest.trackingIssue || 'the tracked vendor-provenance issue'} or deliberately remove the opaque assets.`
    );
  }
  return manifest;
}

function toUniqueMap(entries, key, label) {
  const result = new Map();
  for (const entry of entries) {
    const value = entry && entry[key];
    if (typeof value !== 'string' || !value || result.has(value)) {
      throw new Error(`[validate-vendor-provenance] Invalid or duplicate ${label}: ${value || 'missing'}`);
    }
    result.set(value, entry);
  }
  return result;
}

function propertiesMap(component, label) {
  return toUniqueMap(component.properties || [], 'name', `${label} property`);
}

function hashValue(component, algorithm) {
  const matches = (component.hashes || []).filter(hash => hash && hash.alg === algorithm);
  return matches.length === 1 ? matches[0].content : null;
}

function assertExactStringSet(actual, expected, label) {
  const actualValues = actual && typeof actual[Symbol.iterator] === 'function' ? [...actual].sort() : [];
  const expectedValues = [...expected].sort();
  if (new Set(actualValues).size !== actualValues.length ||
      JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    throw new Error(`[validate-vendor-provenance] ${label} mismatch`);
  }
}

function validateDiagnosticSbom(manifest, sbom) {
  const sbomComponents = toUniqueMap(sbom.components, 'bom-ref', 'SBOM component ref');
  const expectedRefs = new Set();

  for (const component of manifest.components) {
    expectedRefs.add(component.purl);
    const sbomComponent = sbomComponents.get(component.purl);
    const properties = sbomComponent ? propertiesMap(sbomComponent, `component ${component.purl}`) : new Map();
    const expressions = (sbomComponent && sbomComponent.licenses || [])
      .map(license => license && license.expression)
      .filter(Boolean);
    if (!sbomComponent || sbomComponent.type !== 'library' || sbomComponent.name !== component.name ||
        sbomComponent.version !== component.version || sbomComponent.purl !== component.purl ||
        hashValue(sbomComponent, 'SHA-512') !== sriSha512Hex(component.integrity) ||
        properties.get('unfallatlas:license-text-count')?.value !== String(component.licenseTexts.length) ||
        properties.get('unfallatlas:lock-integrity')?.value !== component.integrity ||
        (component.licenseExpression && !expressions.includes(component.licenseExpression))) {
      throw new Error(`[validate-vendor-provenance] SBOM component evidence mismatch: ${component.purl}`);
    }
  }

  for (const font of manifest.fontEvidence) {
    const ref = `urn:unfallatlas:font:${font.name}`;
    expectedRefs.add(ref);
    const sbomFont = sbomComponents.get(ref);
    const properties = sbomFont ? propertiesMap(sbomFont, `font ${font.name}`) : new Map();
    const expressions = (sbomFont && sbomFont.licenses || [])
      .map(license => license && license.expression)
      .filter(Boolean);
    if (!sbomFont || sbomFont.type !== 'file' || sbomFont.name !== font.name ||
        sbomFont.version !== (font.nameTable.version || 'unknown') ||
        hashValue(sbomFont, 'SHA-256') !== font.decodedSha256 ||
        !expressions.includes(font.licenseExpression) ||
        properties.get('unfallatlas:font-family')?.value !== (font.nameTable.family || 'unknown') ||
        properties.get('unfallatlas:font-postscript-name')?.value !== (font.nameTable.postscriptName || 'unknown') ||
        properties.get('unfallatlas:provenance-status')?.value !== (manifest.complete ? 'complete' : 'incomplete')) {
      throw new Error(`[validate-vendor-provenance] SBOM font evidence mismatch: ${font.name}`);
    }
  }

  const expectedAssetRefs = [];
  for (const asset of manifest.assetAssessments) {
    const ref = `urn:unfallatlas:vendor-asset:${asset.path}`;
    expectedRefs.add(ref);
    expectedAssetRefs.push(ref);
    const sbomAsset = sbomComponents.get(ref);
    const properties = sbomAsset ? propertiesMap(sbomAsset, `asset ${asset.path}`) : new Map();
    if (!sbomAsset || sbomAsset.type !== 'file' || sbomAsset.name !== path.basename(asset.path) ||
        hashValue(sbomAsset, 'SHA-256') !== asset.sha256 ||
        properties.get('unfallatlas:path')?.value !== asset.path ||
        properties.get('unfallatlas:reproducible')?.value !== String(asset.reproducible) ||
        properties.get('unfallatlas:provenance-complete')?.value !== String(asset.provenanceComplete) ||
        properties.get('unfallatlas:gaps')?.value !== JSON.stringify(asset.gaps) ||
        properties.get('unfallatlas:unresolved-detected-components')?.value !==
          JSON.stringify(asset.unresolvedDetectedComponents)) {
      throw new Error(`[validate-vendor-provenance] SBOM delivered asset evidence mismatch: ${asset.path}`);
    }
  }

  assertExactStringSet(sbomComponents.keys(), expectedRefs, 'SBOM component refs');
  const dependencies = toUniqueMap(sbom.dependencies, 'ref', 'SBOM dependency ref');
  assertExactStringSet(dependencies.keys(), expectedAssetRefs, 'SBOM dependency refs');
  for (const asset of manifest.assetAssessments) {
    const ref = `urn:unfallatlas:vendor-asset:${asset.path}`;
    assertExactStringSet(
      dependencies.get(ref).dependsOn,
      [...asset.contains, ...asset.containsFiles],
      `SBOM contains relation for ${asset.path}`
    );
  }

  const aggregate = manifest.complete ? 'complete' : 'incomplete';
  if (sbom.compositions.length !== 1 || sbom.compositions[0].aggregate !== aggregate) {
    throw new Error(`[validate-vendor-provenance] SBOM requires one exact ${aggregate} composition`);
  }
  assertExactStringSet(sbom.compositions[0].assemblies, expectedAssetRefs, 'SBOM composition assemblies');
  const metadataProperties = propertiesMap(sbom.metadata || {}, 'SBOM metadata');
  if (metadataProperties.get('unfallatlas:inventory-completeness')?.value !== aggregate ||
      metadataProperties.get('unfallatlas:tracking-issue')?.value !== manifest.trackingIssue) {
    throw new Error('[validate-vendor-provenance] SBOM metadata completeness mismatch');
  }
}

function validatePolicyBinding(manifest, policy, trustedPolicy = policy) {
  if (!policy || policy.schemaVersion !== 1 || policy.policyId !== manifest.provenancePolicy.policyId ||
      !Array.isArray(policy.trustedVendorBuilders) ||
      !Array.isArray(policy.unresolvedAssets) || !trustedPolicy ||
      canonicalJson(policy) !== canonicalJson(trustedPolicy)) {
    throw new Error('[validate-vendor-provenance] Provenance policy metadata mismatch');
  }
  validateTrustedVendorBuilders(trustedPolicy, { requireTwo: manifest.complete === true });
  const projected = policy.unresolvedAssets.map(gap => ({
    id: gap.id,
    paths: gap.paths,
    kind: gap.kind,
    missingEvidence: gap.missingEvidence,
    migrationOptions: gap.migrationOptions,
  }));
  if (JSON.stringify(projected) !== JSON.stringify(manifest.knownGaps)) {
    throw new Error('[validate-vendor-provenance] Notice gaps drift from the checked-in provenance policy');
  }
}

function decodeCanonicalBase64(value, label) {
  if (typeof value !== 'string' || !value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`[validate-vendor-provenance] Invalid base64 ${label}`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new Error(`[validate-vendor-provenance] Non-canonical base64 ${label}`);
  }
  return decoded;
}

function validateTrustedVendorBuilders(policy, options = {}) {
  if (!policy || !Array.isArray(policy.trustedVendorBuilders)) {
    throw new Error('[validate-vendor-provenance] Provenance policy has no trusted vendor builders');
  }
  if (options.requireTwo && policy.trustedVendorBuilders.length < 2) {
    throw new Error('[validate-vendor-provenance] Complete provenance requires two policy-trusted builders');
  }
  const builders = toUniqueMap(policy.trustedVendorBuilders, 'keyId', 'trusted vendor builder key id');
  const builderIds = new Set();
  const publicKeys = new Set();
  const validated = new Map();
  for (const builder of builders.values()) {
    assertExactObjectKeys(builder, ['keyId', 'builderId', 'publicKey'], `trusted builder ${builder.keyId}`);
    assertUpstreamLocator(builder.builderId, `trusted builder id ${builder.keyId}`);
    assertExactObjectKeys(builder.publicKey, ['type', 'encoding', 'value'], `trusted builder public key ${builder.keyId}`);
    if (builder.publicKey.type !== 'ed25519' || builder.publicKey.encoding !== 'spki-der-base64') {
      throw new Error(`[validate-vendor-provenance] Unsupported trusted builder key: ${builder.keyId}`);
    }
    const der = decodeCanonicalBase64(builder.publicKey.value, `trusted builder key ${builder.keyId}`);
    const expectedKeyId = `ed25519:${crypto.createHash('sha256').update(der).digest('hex')}`;
    let keyObject;
    try {
      keyObject = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    } catch (error) {
      throw new Error(`[validate-vendor-provenance] Invalid trusted builder public key ${builder.keyId}: ${error.message}`);
    }
    if (builder.keyId !== expectedKeyId || keyObject.asymmetricKeyType !== 'ed25519' ||
        builderIds.has(builder.builderId) || publicKeys.has(builder.publicKey.value)) {
      throw new Error(`[validate-vendor-provenance] Trusted builders require unique Ed25519 identities: ${builder.keyId}`);
    }
    builderIds.add(builder.builderId);
    publicKeys.add(builder.publicKey.value);
    validated.set(builder.keyId, { ...builder, keyObject });
  }
  return validated;
}

function validateCompleteSbom(manifest, sbom) {
  const componentRefs = new Set();
  for (const component of sbom.components || []) {
    if (component && typeof component['bom-ref'] === 'string') componentRefs.add(component['bom-ref']);
  }
  for (const component of manifest.components) {
    if (!componentRefs.has(component.purl)) {
      throw new Error(`[validate-vendor-provenance] Complete SBOM omits component: ${component.purl}`);
    }
  }
  for (const font of manifest.fontEvidence) {
    if (!componentRefs.has(`urn:unfallatlas:font:${font.name}`)) {
      throw new Error(`[validate-vendor-provenance] Complete SBOM omits font: ${font.name}`);
    }
  }
  const dependencyByRef = new Map((sbom.dependencies || []).map(dependency => [dependency.ref, dependency]));
  const expectedAssemblies = [];
  for (const asset of manifest.assetAssessments) {
    const assetRef = `urn:unfallatlas:vendor-asset:${asset.path}`;
    expectedAssemblies.push(assetRef);
    if (!componentRefs.has(assetRef)) {
      throw new Error(`[validate-vendor-provenance] Complete SBOM omits delivered asset: ${asset.path}`);
    }
    const dependency = dependencyByRef.get(assetRef);
    const actual = dependency && Array.isArray(dependency.dependsOn) ? [...dependency.dependsOn].sort() : [];
    const expected = [...asset.contains, ...asset.containsFiles].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`[validate-vendor-provenance] SBOM contains relation mismatch: ${asset.path}`);
    }
  }
  const completeCompositions = (sbom.compositions || [])
    .filter(composition => composition.aggregate === 'complete');
  if (completeCompositions.length !== 1 ||
      JSON.stringify([...(completeCompositions[0].assemblies || [])].sort()) !== JSON.stringify(expectedAssemblies.sort())) {
    throw new Error('[validate-vendor-provenance] Complete SBOM requires one exact complete composition');
  }
  const metadataProperties = new Map(
    ((sbom.metadata && sbom.metadata.properties) || []).map(property => [property.name, property.value])
  );
  if (metadataProperties.get('unfallatlas:inventory-completeness') !== 'complete') {
    throw new Error('[validate-vendor-provenance] Complete SBOM metadata is not marked complete');
  }
}

function validateDiagnosticInventory(manifest) {
  if (!manifest.provenancePolicy || !manifest.provenancePolicy.path ||
      !HASH_PATTERN.test(String(manifest.provenancePolicy.sha256 || '')) ||
      !manifest.sbom || manifest.sbom.specVersion !== '1.6' ||
      !HASH_PATTERN.test(String(manifest.sbom.sha256 || ''))) {
    throw new Error('[validate-vendor-provenance] Missing policy/SBOM evidence');
  }
  const components = new Set();
  for (const component of manifest.components) {
    if (!component || typeof component.purl !== 'string' || !component.purl.startsWith('pkg:') ||
        components.has(component.purl) || !component.version || !component.integrity || !component.attestation ||
        !Array.isArray(component.licenseTexts)) {
      throw new Error('[validate-vendor-provenance] Invalid diagnostic component inventory');
    }
    for (const license of component.licenseTexts) {
      if (!license || !license.path || !HASH_PATTERN.test(String(license.sha256 || ''))) {
        throw new Error(`[validate-vendor-provenance] Invalid declared license evidence: ${component.purl}`);
      }
    }
    components.add(component.purl);
  }
  const assetPaths = new Set();
  for (const asset of manifest.assetAssessments) {
    if (!asset || typeof asset.path !== 'string' || assetPaths.has(asset.path) ||
        !HASH_PATTERN.test(String(asset.sha256 || '')) || !Array.isArray(asset.contains) || asset.contains.length === 0 ||
        !Array.isArray(asset.gaps) || !Array.isArray(asset.unresolvedDetectedComponents) ||
        !Array.isArray(asset.containsFiles) ||
        typeof asset.reproducible !== 'boolean' || typeof asset.provenanceComplete !== 'boolean') {
      throw new Error('[validate-vendor-provenance] Invalid delivered asset assessment');
    }
    assetPaths.add(asset.path);
    for (const purl of asset.contains) {
      if (!components.has(purl)) {
        throw new Error(`[validate-vendor-provenance] Asset contains unknown diagnostic component: ${asset.path} -> ${purl}`);
      }
    }
  }
  const gapIds = new Set();
  for (const gap of manifest.knownGaps) {
    if (!gap || !gap.id || gapIds.has(gap.id) || !Array.isArray(gap.paths) || gap.paths.length === 0 ||
        !Array.isArray(gap.missingEvidence) || gap.missingEvidence.length === 0 ||
        !Array.isArray(gap.migrationOptions) || gap.migrationOptions.length === 0) {
      throw new Error('[validate-vendor-provenance] Invalid machine-readable provenance gap');
    }
    gapIds.add(gap.id);
    for (const assetPath of gap.paths) {
      if (!assetPaths.has(assetPath)) {
        throw new Error(`[validate-vendor-provenance] Provenance gap references unknown asset: ${assetPath}`);
      }
    }
  }
  for (const asset of manifest.assetAssessments) {
    for (const gapId of asset.gaps) {
      if (!gapIds.has(gapId)) {
        throw new Error(`[validate-vendor-provenance] Asset references unknown provenance gap: ${asset.path} -> ${gapId}`);
      }
    }
    if (asset.provenanceComplete !== (asset.gaps.length === 0)) {
      throw new Error(`[validate-vendor-provenance] Asset provenance status contradicts its gaps: ${asset.path}`);
    }
  }
  if (manifest.fontEvidence.length !== 4) {
    throw new Error('[validate-vendor-provenance] Diagnostic inventory must identify exactly four embedded fonts');
  }
  for (const font of manifest.fontEvidence) {
    if (!font || !font.name || !HASH_PATTERN.test(String(font.decodedSha256 || '')) ||
        font.decodedSha256 !== font.sourceSha256 || !font.nameTable || !font.nameTable.family ||
        !font.nameTable.fullName || !font.nameTable.postscriptName || !font.nameTable.version ||
        !Array.isArray(font.licenseTexts)) {
      throw new Error(`[validate-vendor-provenance] Invalid embedded font evidence: ${font && font.name}`);
    }
    for (const license of font.licenseTexts) {
      if (!license || !license.path || !HASH_PATTERN.test(String(license.sha256 || ''))) {
        throw new Error(`[validate-vendor-provenance] Invalid declared font license evidence: ${font.name}`);
      }
    }
  }
  const fontsByRef = new Map(manifest.fontEvidence.map(font => [`urn:unfallatlas:font:${font.name}`, font]));
  const assetsByPath = new Map(manifest.assetAssessments.map(asset => [asset.path, asset]));
  const fileOwners = new Map();
  for (const asset of manifest.assetAssessments) {
    for (const ref of asset.containsFiles) {
      if (!fontsByRef.has(ref)) {
        throw new Error(`[validate-vendor-provenance] Asset contains unknown file component: ${asset.path} -> ${ref}`);
      }
      if (fileOwners.has(ref)) {
        throw new Error(`[validate-vendor-provenance] File component has multiple delivered containers: ${ref}`);
      }
      fileOwners.set(ref, asset.path);
    }
  }
  for (const [ref, font] of fontsByRef) {
    if (!assetsByPath.has(font.decodedFrom) || fileOwners.get(ref) !== font.decodedFrom) {
      throw new Error(`[validate-vendor-provenance] Font is orphaned from its delivered asset: ${font.name}`);
    }
  }
}

function resolveEvidencePath(artifactRoot, record, label) {
  if (!record || typeof record.path !== 'string' || !record.path || !HASH_PATTERN.test(String(record.sha256 || ''))) {
    throw new Error(`[validate-vendor-provenance] Missing ${label} reference`);
  }
  const absolute = path.resolve(artifactRoot, record.path);
  const relative = path.relative(artifactRoot, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[validate-vendor-provenance] ${label} escapes the artifact root`);
  }
  return absolute;
}

function verifyEvidenceFile(artifactRoot, record, label) {
  const absolute = resolveEvidencePath(artifactRoot, record, label);
  assertSymlinkFreeEvidencePath(artifactRoot, absolute, label);
  if (!fs.existsSync(absolute) || !fs.lstatSync(absolute).isFile()) {
    throw new Error(`[validate-vendor-provenance] Missing ${label}: ${absolute}`);
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
  if (actual !== record.sha256) throw new Error(`[validate-vendor-provenance] ${label} hash drift`);
}

function assertSymlinkFreeEvidencePath(artifactRoot, absolute, label) {
  const resolvedRoot = path.resolve(artifactRoot);
  let current = resolvedRoot;
  if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
    throw new Error(`[validate-vendor-provenance] ${label} artifact root is a symbolic link`);
  }
  const relative = path.relative(resolvedRoot, absolute);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error(`[validate-vendor-provenance] ${label} traverses a symbolic link: ${current}`);
    }
  }
}

function verifyDiagnosticEvidenceFiles(artifactRoot, manifest) {
  for (const asset of manifest.assetAssessments) {
    verifyEvidenceFile(
      artifactRoot,
      { path: asset.path, sha256: asset.sha256 },
      `delivered asset ${asset.path}`
    );
  }
  for (const dependency of manifest.dependencies) {
    if (dependency.licenseTextPath === null && dependency.licenseTextSha256 === null) continue;
    verifyEvidenceFile(
      artifactRoot,
      { path: dependency.licenseTextPath, sha256: dependency.licenseTextSha256 },
      `direct-package license text for ${dependency.package}`
    );
  }
  for (const component of manifest.components) {
    for (const license of component.licenseTexts) {
      verifyEvidenceFile(artifactRoot, license, `component license text for ${component.purl}`);
    }
  }
  for (const font of manifest.fontEvidence) {
    for (const license of font.licenseTexts) {
      verifyEvidenceFile(artifactRoot, license, `font license text for ${font.name}`);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactObjectKeys(value, keys, label) {
  if (!isPlainObject(value)) {
    throw new Error(`[validate-vendor-provenance] Missing or invalid ${label}`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`[validate-vendor-provenance] Invalid ${label} fields`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new Error(`[validate-vendor-provenance] Missing or invalid ${label}`);
  }
  return value;
}

function assertExactStringArray(value, label, options = {}) {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0) ||
      value.some(entry => typeof entry !== 'string' || !entry.trim() || /[\0\r\n]/.test(entry)) ||
      new Set(value).size !== value.length) {
    throw new Error(`[validate-vendor-provenance] Missing, invalid or duplicate ${label}`);
  }
  return value;
}

function assertSafeRelativeLockPath(value, label, options = {}) {
  assertNonEmptyString(value, label);
  if (value.includes('\\') || path.posix.isAbsolute(value) ||
      (!options.allowDot && value === '.') ||
      path.posix.normalize(value) !== value || value === '..' || value.startsWith('../')) {
    throw new Error(`[validate-vendor-provenance] Unsafe ${label}: ${value}`);
  }
  return value;
}

function assertUpstreamLocator(value, label) {
  assertNonEmptyString(value, label);
  if (/^pkg:[^\s]+$/.test(value) || /^git\+https:\/\/[^\s]+$/.test(value)) return value;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password) return value;
  } catch (_) {
    // Fall through to the fail-closed error below.
  }
  throw new Error(`[validate-vendor-provenance] Invalid upstream locator for ${label}`);
}

function digestFile(file, algorithm) {
  return crypto.createHash(algorithm).update(fs.readFileSync(file)).digest('hex');
}

function validateDigestRecord(record, label) {
  assertExactObjectKeys(record, ['algorithm', 'value'], `${label} digest`);
  const expectedPattern = record.algorithm === 'sha256'
    ? HASH_PATTERN
    : record.algorithm === 'sha512' ? SHA512_PATTERN : null;
  if (!expectedPattern || !expectedPattern.test(String(record.value || ''))) {
    throw new Error(`[validate-vendor-provenance] Invalid ${label} digest`);
  }
}

function validateLockReference(reference, lock, label) {
  assertExactObjectKeys(
    reference,
    ['type', 'schemaVersion', 'lockId', 'lockRef'],
    `${label} build-lock reference`
  );
  if (reference.type !== VENDOR_BUILD_LOCK_REFERENCE_TYPE ||
      reference.schemaVersion !== VENDOR_BUILD_LOCK_SCHEMA_VERSION ||
      reference.lockId !== lock.lockId ||
      typeof reference.lockRef !== 'string' || !reference.lockRef.trim()) {
    throw new Error(`[validate-vendor-provenance] Invalid ${label} build-lock reference`);
  }
  return reference.lockRef;
}

function registerExpectedLockSource(expected, reference, descriptor) {
  if (expected.has(reference)) {
    throw new Error(`[validate-vendor-provenance] Build-lock source reference is reused: ${reference}`);
  }
  expected.set(reference, descriptor);
}

function expectedBuildLockSources(manifest, lock) {
  const expected = new Map();
  for (const component of manifest.components) {
    registerExpectedLockSource(
      expected,
      validateLockReference(component.attestation, lock, `component ${component.purl}`),
      { type: 'component', owner: component }
    );
    for (const license of component.licenseTexts) {
      registerExpectedLockSource(
        expected,
        validateLockReference(license.attestation, lock, `license ${license.path}`),
        { type: 'license', ownerRef: component.purl, owner: component, license }
      );
    }
  }
  for (const font of manifest.fontEvidence) {
    const fontRef = `urn:unfallatlas:font:${font.name}`;
    registerExpectedLockSource(
      expected,
      validateLockReference(font.attestation, lock, `font ${font.name}`),
      { type: 'font', ownerRef: fontRef, owner: font }
    );
    for (const license of font.licenseTexts) {
      registerExpectedLockSource(
        expected,
        validateLockReference(license.attestation, lock, `font license ${license.path}`),
        { type: 'license', ownerRef: fontRef, owner: font, license }
      );
    }
  }
  return expected;
}

function validateLockInputs(artifactRoot, lock) {
  if (!Array.isArray(lock.inputs) || lock.inputs.length === 0) {
    throw new Error('[validate-vendor-provenance] Vendor build lock requires local hashed inputs');
  }
  const declaredInputs = toUniqueMap(lock.inputs, 'id', 'vendor build input id');
  const inputs = new Map();
  const paths = new Set();
  for (const input of declaredInputs.values()) {
    assertExactObjectKeys(input, ['id', 'type', 'path', 'sha256'], `vendor build input ${input.id}`);
    assertNonEmptyString(input.id, 'vendor build input id');
    if (!BUILD_INPUT_TYPES.has(input.type)) {
      throw new Error(`[validate-vendor-provenance] Invalid vendor build input type: ${input.id}`);
    }
    assertSafeRelativeLockPath(input.path, `vendor build input path for ${input.id}`);
    if (paths.has(input.path)) {
      throw new Error(`[validate-vendor-provenance] Duplicate vendor build input path: ${input.path}`);
    }
    paths.add(input.path);
    verifyEvidenceFile(artifactRoot, input, `vendor build input ${input.id}`);
    inputs.set(input.id, {
      ...input,
      absolutePath: resolveEvidencePath(artifactRoot, input, `vendor build input ${input.id}`),
    });
  }
  return inputs;
}

function validateUpstreamBinding(upstream, inputs, label, expected = {}) {
  assertExactObjectKeys(upstream, ['type', 'locator', 'digest', 'inputRef'], `${label} upstream`);
  if (!new Set(['npm-registry-archive', 'release-archive', 'source-file']).has(upstream.type)) {
    throw new Error(`[validate-vendor-provenance] Invalid ${label} upstream type`);
  }
  assertUpstreamLocator(upstream.locator, `${label} upstream`);
  validateDigestRecord(upstream.digest, label);
  const input = inputs.get(upstream.inputRef);
  if (!input) throw new Error(`[validate-vendor-provenance] ${label} references an unknown upstream input`);
  if (expected.inputTypes && !expected.inputTypes.has(input.type)) {
    throw new Error(`[validate-vendor-provenance] ${label} references the wrong upstream input type`);
  }
  const actualDigest = upstream.digest.algorithm === 'sha256'
    ? input.sha256
    : digestFile(input.absolutePath, upstream.digest.algorithm);
  if (actualDigest !== upstream.digest.value) {
    throw new Error(`[validate-vendor-provenance] ${label} upstream digest does not match local input`);
  }
  return input;
}

function validateLockToolchain(lock, inputs) {
  if (!Array.isArray(lock.toolchain) || lock.toolchain.length < 3) {
    throw new Error('[validate-vendor-provenance] Vendor build lock requires a concrete toolchain');
  }
  const declaredTools = toUniqueMap(lock.toolchain, 'id', 'vendor toolchain id');
  const tools = new Map();
  const requiredTypes = new Set(['runtime', 'package-manager', 'build-tool']);
  const names = new Set();
  for (const tool of declaredTools.values()) {
    assertExactObjectKeys(tool, ['id', 'type', 'name', 'version', 'upstream'], `toolchain entry ${tool.id}`);
    assertNonEmptyString(tool.id, 'toolchain id');
    assertNonEmptyString(tool.name, `toolchain name for ${tool.id}`);
    assertNonEmptyString(tool.version, `toolchain version for ${tool.id}`);
    if (!requiredTypes.has(tool.type) || /(?:^|[._-])(?:latest|next|x|\*)(?:$|[._-])/i.test(tool.version)) {
      throw new Error(`[validate-vendor-provenance] Invalid concrete toolchain entry: ${tool.id}`);
    }
    requiredTypes.delete(tool.type);
    if (names.has(tool.name)) {
      throw new Error(`[validate-vendor-provenance] Duplicate toolchain executable name: ${tool.name}`);
    }
    names.add(tool.name);
    const input = validateUpstreamBinding(tool.upstream, inputs, `toolchain ${tool.id}`, {
      inputTypes: new Set(['toolchain-archive']),
    });
    if (tool.upstream.type === 'npm-registry-archive' && !tool.upstream.locator.startsWith('pkg:npm/')) {
      throw new Error(`[validate-vendor-provenance] npm toolchain locator mismatch: ${tool.id}`);
    }
    tools.set(tool.id, { ...tool, upstreamInput: input });
  }
  if (requiredTypes.size > 0) {
    throw new Error(`[validate-vendor-provenance] Vendor toolchain omits: ${[...requiredTypes].join(', ')}`);
  }
  return tools;
}

function validateLockSource(source, descriptor, inputs) {
  assertExactObjectKeys(source, ['id', 'type', 'subject', 'upstream'], `vendor source ${source.id}`);
  assertExactObjectKeys(source.upstream, ['type', 'locator', 'digest', 'inputRef'], `vendor source upstream ${source.id}`);
  if (source.type !== descriptor.type) {
    throw new Error(`[validate-vendor-provenance] Vendor source type mismatch: ${source.id}`);
  }
  if (source.type === 'component') {
    const component = descriptor.owner;
    assertExactObjectKeys(
      source.subject,
      ['type', 'purl', 'version', 'integrity'],
      `component source subject ${source.id}`
    );
    if (source.subject.type !== 'component' || source.subject.purl !== component.purl ||
        source.subject.version !== component.version || source.subject.integrity !== component.integrity ||
        source.upstream.type !== 'npm-registry-archive' ||
        source.upstream.locator !== component.resolved) {
      throw new Error(`[validate-vendor-provenance] Component upstream binding mismatch: ${source.id}`);
    }
    const input = validateUpstreamBinding(source.upstream, inputs, `component source ${source.id}`, {
      inputTypes: new Set(['source-archive']),
    });
    if (source.upstream.digest.algorithm !== 'sha512' ||
        source.upstream.digest.value !== sriSha512Hex(component.integrity)) {
      throw new Error(`[validate-vendor-provenance] Component archive integrity mismatch: ${source.id}`);
    }
    return { ...source, upstreamInput: input };
  }
  if (source.type === 'font') {
    const font = descriptor.owner;
    assertExactObjectKeys(source.subject, ['type', 'ref', 'name', 'sha256'], `font source subject ${source.id}`);
    if (source.subject.type !== 'font' || source.subject.ref !== descriptor.ownerRef ||
        source.subject.name !== font.name || source.subject.sha256 !== font.sourceSha256 ||
        source.upstream.type !== 'source-file') {
      throw new Error(`[validate-vendor-provenance] Font upstream binding mismatch: ${source.id}`);
    }
    const input = validateUpstreamBinding(source.upstream, inputs, `font source ${source.id}`, {
      inputTypes: new Set(['source-file']),
    });
    if (source.upstream.digest.algorithm !== 'sha256' ||
        source.upstream.digest.value !== font.sourceSha256) {
      throw new Error(`[validate-vendor-provenance] Font source hash mismatch: ${source.id}`);
    }
    return { ...source, upstreamInput: input };
  }
  const { license } = descriptor;
  assertExactObjectKeys(
    source.subject,
    ['type', 'ownerRef', 'path', 'sha256', 'copyrightIncluded'],
    `license source subject ${source.id}`
  );
  if (source.subject.type !== 'license' || source.subject.ownerRef !== descriptor.ownerRef ||
      source.subject.path !== license.path || source.subject.sha256 !== license.sha256 ||
      source.subject.copyrightIncluded !== true || source.upstream.type !== 'source-file') {
    throw new Error(`[validate-vendor-provenance] License upstream binding mismatch: ${source.id}`);
  }
  const input = validateUpstreamBinding(source.upstream, inputs, `license source ${source.id}`, {
    inputTypes: new Set(['license-file']),
  });
  if (source.upstream.digest.algorithm !== 'sha256' || source.upstream.digest.value !== license.sha256 ||
      input.path !== license.path) {
    throw new Error(`[validate-vendor-provenance] License file binding mismatch: ${source.id}`);
  }
  assertFullLicenseAndCopyrightContents(
    fs.readFileSync(input.absolutePath, 'utf8'),
    descriptor.owner.licenseExpression,
    `license source ${source.id}`
  );
  return { ...source, upstreamInput: input };
}

function validateLockSources(manifest, lock, inputs) {
  if (!Array.isArray(lock.sources) || lock.sources.length === 0) {
    throw new Error('[validate-vendor-provenance] Vendor build lock requires typed upstream sources');
  }
  const expected = expectedBuildLockSources(manifest, lock);
  const declaredSources = toUniqueMap(lock.sources, 'id', 'vendor source id');
  assertExactStringSet(declaredSources.keys(), expected.keys(), 'vendor build-lock source refs');
  const sources = new Map();
  for (const [sourceId, descriptor] of expected) {
    sources.set(sourceId, validateLockSource(declaredSources.get(sourceId), descriptor, inputs));
  }
  return sources;
}

function validateLockCommands(lock, inputs, tools) {
  if (!Array.isArray(lock.commands) || lock.commands.length === 0) {
    throw new Error('[validate-vendor-provenance] Vendor build lock requires argv-based build commands');
  }
  const commands = toUniqueMap(lock.commands, 'id', 'vendor build command id');
  const usedTools = new Set();
  for (const command of commands.values()) {
    assertExactObjectKeys(
      command,
      ['id', 'cwd', 'argv', 'toolchainRefs', 'inputRefs', 'outputRefs'],
      `vendor build command ${command.id}`
    );
    assertSafeRelativeLockPath(command.cwd, `working directory for ${command.id}`, { allowDot: true });
    assertExactStringArray(command.argv, `argv for ${command.id}`);
    assertExactStringArray(command.toolchainRefs, `toolchain refs for ${command.id}`);
    assertExactStringArray(command.inputRefs, `input refs for ${command.id}`);
    assertExactStringArray(command.outputRefs, `output refs for ${command.id}`, { allowEmpty: true });
    const referencedTools = command.toolchainRefs.map(ref => {
      const tool = tools.get(ref);
      if (!tool) throw new Error(`[validate-vendor-provenance] Unknown toolchain ref in ${command.id}: ${ref}`);
      usedTools.add(ref);
      if (!command.inputRefs.includes(tool.upstream.inputRef)) {
        throw new Error(`[validate-vendor-provenance] Command ${command.id} omits its toolchain archive input`);
      }
      return tool;
    });
    const executable = path.posix.basename(command.argv[0]).replace(/\.cmd$/i, '');
    if (!referencedTools.some(tool => tool.name === executable) ||
        /^(?:ba|da|z)?sh$|^(?:cmd|powershell|pwsh)$/i.test(executable)) {
      throw new Error(`[validate-vendor-provenance] Command ${command.id} is not a direct toolchain argv invocation`);
    }
    for (const inputRef of command.inputRefs) {
      if (!inputs.has(inputRef)) {
        throw new Error(`[validate-vendor-provenance] Unknown input ref in ${command.id}: ${inputRef}`);
      }
    }
    const commandInputPaths = new Set(command.inputRefs.map(ref => inputs.get(ref).path));
    for (const argument of command.argv.slice(1)) {
      if (argument.startsWith('-') || (!argument.includes('/') && !/\.(?:c?js|mjs|json|ya?ml|toml)$/i.test(argument))) {
        continue;
      }
      assertSafeRelativeLockPath(argument, `local argv input for ${command.id}`);
      const argumentPath = path.posix.normalize(path.posix.join(command.cwd, argument));
      if (!commandInputPaths.has(argumentPath)) {
        throw new Error(`[validate-vendor-provenance] Command ${command.id} uses an unhashed local argv input: ${argument}`);
      }
    }
  }
  assertExactStringSet(usedTools, tools.keys(), 'toolchain command coverage');
  return commands;
}

function requiredBuildInputRefs(asset, sources, tools) {
  const required = new Set([...tools.values()].map(tool => tool.upstream.inputRef));
  const subjectRefs = new Set([...asset.contains, ...asset.containsFiles]);
  for (const source of sources.values()) {
    if (source.type === 'component' && subjectRefs.has(source.subject.purl)) {
      required.add(source.upstream.inputRef);
    } else if (source.type === 'font' && subjectRefs.has(source.subject.ref)) {
      required.add(source.upstream.inputRef);
    }
  }
  return required;
}

function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('[validate-vendor-provenance] Non-finite number in signed provenance');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new Error('[validate-vendor-provenance] Unsupported value in signed provenance');
}

function dssePreAuthenticationEncoding(payloadType, payload) {
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${Buffer.byteLength(payloadType, 'utf8')} ${payloadType} ${payload.length} `, 'utf8'),
    payload,
  ]);
}

function expectedAttestedToolchain(command, tools) {
  return command.toolchainRefs.map(ref => {
    const tool = tools.get(ref);
    return {
      id: tool.id,
      type: tool.type,
      name: tool.name,
      version: tool.version,
      upstream: {
        type: tool.upstream.type,
        locator: tool.upstream.locator,
        digest: { ...tool.upstream.digest },
        input: { path: tool.upstreamInput.path, sha256: tool.upstreamInput.sha256 },
      },
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function expectedResolvedDependencies(command, inputs) {
  return command.inputRefs.map(ref => {
    const input = inputs.get(ref);
    return { uri: `file:${input.path}`, digest: { sha256: input.sha256 } };
  }).sort((left, right) => left.uri.localeCompare(right.uri));
}

function validateSignedSlsaStatement(statement, context) {
  const { lock, output, command, inputs, tools, builder } = context;
  assertExactObjectKeys(statement, ['_type', 'subject', 'predicateType', 'predicate'], 'in-toto statement');
  if (statement._type !== IN_TOTO_STATEMENT_TYPE || statement.predicateType !== SLSA_PROVENANCE_TYPE ||
      !Array.isArray(statement.subject) || statement.subject.length !== 1) {
    throw new Error('[validate-vendor-provenance] Invalid in-toto/SLSA provenance statement');
  }
  assertExactObjectKeys(statement.subject[0], ['name', 'digest'], 'in-toto subject');
  assertExactObjectKeys(statement.subject[0].digest, ['sha256'], 'in-toto subject digest');
  if (statement.subject[0].name !== output.path || statement.subject[0].digest.sha256 !== output.sha256) {
    throw new Error(`[validate-vendor-provenance] Signed provenance output subject mismatch: ${output.id}`);
  }
  assertExactObjectKeys(statement.predicate, ['buildDefinition', 'runDetails'], 'SLSA predicate');
  const definition = statement.predicate.buildDefinition;
  assertExactObjectKeys(
    definition,
    ['buildType', 'externalParameters', 'internalParameters', 'resolvedDependencies'],
    'SLSA build definition'
  );
  if (definition.buildType !== VENDOR_BUILD_TYPE) {
    throw new Error(`[validate-vendor-provenance] Signed provenance build type mismatch: ${output.id}`);
  }
  const expectedExternal = {
    lockId: lock.lockId,
    commandRef: output.commandRef,
    cwd: command.cwd,
    argv: command.argv,
  };
  const expectedInternal = { toolchain: expectedAttestedToolchain(command, tools) };
  const expectedDependencies = expectedResolvedDependencies(command, inputs);
  if (canonicalJson(definition.externalParameters) !== canonicalJson(expectedExternal) ||
      canonicalJson(definition.internalParameters) !== canonicalJson(expectedInternal) ||
      canonicalJson(definition.resolvedDependencies) !== canonicalJson(expectedDependencies)) {
    throw new Error(`[validate-vendor-provenance] Signed provenance command/input/toolchain mismatch: ${output.id}`);
  }
  const runDetails = statement.predicate.runDetails;
  assertExactObjectKeys(runDetails, ['builder', 'metadata'], 'SLSA run details');
  assertExactObjectKeys(runDetails.builder, ['id'], 'SLSA builder');
  assertExactObjectKeys(runDetails.metadata, ['invocationId'], 'SLSA invocation metadata');
  assertNonEmptyString(runDetails.metadata.invocationId, `SLSA invocation id for ${output.id}`);
  if (runDetails.builder.id !== builder.builderId) {
    throw new Error(`[validate-vendor-provenance] Signed provenance builder mismatch: ${output.id}`);
  }
  return {
    builderId: runDetails.builder.id,
    invocationId: runDetails.metadata.invocationId,
  };
}

function verifyDsseSlsaProvenance(input, rebuild, context, trustedBuilders) {
  let envelope;
  try {
    envelope = JSON.parse(fs.readFileSync(input.absolutePath, 'utf8'));
  } catch (error) {
    throw new Error(`[validate-vendor-provenance] Invalid DSSE provenance ${input.id}: ${error.message}`);
  }
  assertExactObjectKeys(envelope, ['payloadType', 'payload', 'signatures'], `DSSE envelope ${input.id}`);
  if (envelope.payloadType !== DSSE_PAYLOAD_TYPE || !Array.isArray(envelope.signatures) ||
      envelope.signatures.length !== 1) {
    throw new Error(`[validate-vendor-provenance] Invalid DSSE envelope ${input.id}`);
  }
  const signatureRecord = envelope.signatures[0];
  assertExactObjectKeys(signatureRecord, ['keyid', 'sig'], `DSSE signature ${input.id}`);
  if (signatureRecord.keyid !== rebuild.builderKeyId) {
    throw new Error(`[validate-vendor-provenance] DSSE key id mismatch: ${input.id}`);
  }
  const builder = trustedBuilders.get(signatureRecord.keyid);
  if (!builder) {
    throw new Error(`[validate-vendor-provenance] DSSE uses an untrusted builder key: ${signatureRecord.keyid}`);
  }
  const payload = decodeCanonicalBase64(envelope.payload, `DSSE payload ${input.id}`);
  const signature = decodeCanonicalBase64(signatureRecord.sig, `DSSE signature ${input.id}`);
  if (signature.length !== 64 || !crypto.verify(
    null,
    dssePreAuthenticationEncoding(envelope.payloadType, payload),
    builder.keyObject,
    signature
  )) {
    throw new Error(`[validate-vendor-provenance] DSSE signature verification failed: ${input.id}`);
  }
  let statement;
  try {
    statement = JSON.parse(payload.toString('utf8'));
  } catch (error) {
    throw new Error(`[validate-vendor-provenance] Invalid signed in-toto payload ${input.id}: ${error.message}`);
  }
  if (!payload.equals(Buffer.from(canonicalJson(statement), 'utf8'))) {
    throw new Error(`[validate-vendor-provenance] Signed in-toto payload is not canonical JSON: ${input.id}`);
  }
  return validateSignedSlsaStatement(statement, { ...context, builder });
}

function validateLockOutputs(artifactRoot, manifest, lock, inputs, commands, sources, tools, trustedBuilders) {
  if (!Array.isArray(lock.outputs) || lock.outputs.length === 0) {
    throw new Error('[validate-vendor-provenance] Vendor build lock requires exact outputs');
  }
  const outputs = toUniqueMap(lock.outputs, 'id', 'vendor build output id');
  const inputPaths = new Set([...inputs.values()].map(input => input.path));
  const assetsByOutput = new Map();
  for (const asset of manifest.assetAssessments) {
    const outputRef = validateLockReference(asset.buildAttestation, lock, `asset ${asset.path}`);
    if (assetsByOutput.has(outputRef)) {
      throw new Error(`[validate-vendor-provenance] Vendor output reference is reused: ${outputRef}`);
    }
    assetsByOutput.set(outputRef, asset);
  }
  assertExactStringSet(outputs.keys(), assetsByOutput.keys(), 'vendor build-lock output refs');

  const producedBy = new Map();
  for (const command of commands.values()) {
    for (const outputRef of command.outputRefs) {
      if (producedBy.has(outputRef)) {
        throw new Error(`[validate-vendor-provenance] Vendor output has multiple producing commands: ${outputRef}`);
      }
      producedBy.set(outputRef, command.id);
    }
  }
  assertExactStringSet(producedBy.keys(), outputs.keys(), 'vendor command output coverage');
  const usedProvenanceInputs = new Set();
  const invocationIds = new Set();

  for (const [outputId, output] of outputs) {
    const asset = assetsByOutput.get(outputId);
    assertExactObjectKeys(
      output,
      ['id', 'path', 'sha256', 'commandRef', 'contains', 'containsFiles', 'rebuilds'],
      `vendor build output ${outputId}`
    );
    assertSafeRelativeLockPath(output.path, `vendor output path for ${outputId}`);
    if (output.path !== asset.path || output.sha256 !== asset.sha256 ||
        output.commandRef !== producedBy.get(outputId)) {
      throw new Error(`[validate-vendor-provenance] Vendor output/asset binding mismatch: ${outputId}`);
    }
    if (inputPaths.has(output.path)) {
      throw new Error(`[validate-vendor-provenance] Vendor output is circularly declared as an input: ${outputId}`);
    }
    verifyEvidenceFile(artifactRoot, output, `vendor build output ${outputId}`);
    assertExactStringSet(output.contains, asset.contains, `vendor output contains for ${outputId}`);
    assertExactStringSet(output.containsFiles, asset.containsFiles, `vendor output containsFiles for ${outputId}`);
    const command = commands.get(output.commandRef);
    const requiredInputs = requiredBuildInputRefs(asset, sources, tools);
    for (const inputRef of requiredInputs) {
      if (!command.inputRefs.includes(inputRef)) {
        throw new Error(`[validate-vendor-provenance] Output command omits source/toolchain input: ${outputId} -> ${inputRef}`);
      }
    }
    if (!Array.isArray(output.rebuilds) || output.rebuilds.length < 2) {
      throw new Error(`[validate-vendor-provenance] Output requires two independently signed rebuilds: ${outputId}`);
    }
    const builderKeyIds = new Set();
    const builderIds = new Set();
    for (const rebuild of output.rebuilds) {
      assertExactObjectKeys(
        rebuild,
        ['builderKeyId', 'sha256', 'provenanceInputRef'],
        `rebuild record for ${outputId}`
      );
      const provenanceInput = inputs.get(rebuild.provenanceInputRef);
      if (!provenanceInput || provenanceInput.type !== 'dsse-provenance' ||
          builderKeyIds.has(rebuild.builderKeyId) || usedProvenanceInputs.has(rebuild.provenanceInputRef) ||
          rebuild.sha256 !== output.sha256 || !HASH_PATTERN.test(String(rebuild.sha256 || ''))) {
        throw new Error(`[validate-vendor-provenance] Output/rebuild hash, builder or provenance mismatch: ${outputId}`);
      }
      const verified = verifyDsseSlsaProvenance(
        provenanceInput,
        rebuild,
        { lock, output, command, inputs, tools },
        trustedBuilders
      );
      if (builderIds.has(verified.builderId) || invocationIds.has(verified.invocationId)) {
        throw new Error(`[validate-vendor-provenance] Signed rebuild builders and invocations must be unique: ${outputId}`);
      }
      builderKeyIds.add(rebuild.builderKeyId);
      builderIds.add(verified.builderId);
      invocationIds.add(verified.invocationId);
      usedProvenanceInputs.add(rebuild.provenanceInputRef);
    }
  }
  return outputs;
}

function validateNoOrphanLockInputs(inputs, tools, commands, sources, outputs) {
  const referenced = new Set();
  for (const tool of tools.values()) referenced.add(tool.upstream.inputRef);
  for (const command of commands.values()) for (const ref of command.inputRefs) referenced.add(ref);
  for (const source of sources.values()) referenced.add(source.upstream.inputRef);
  for (const output of outputs.values()) {
    for (const rebuild of output.rebuilds) referenced.add(rebuild.provenanceInputRef);
  }
  assertExactStringSet(referenced, inputs.keys(), 'vendor build input coverage');
}

function validateVendorBuildLock(artifactRoot, manifest, lock, policy) {
  assertExactObjectKeys(
    lock,
    ['schemaVersion', 'type', 'lockId', 'toolchain', 'commands', 'inputs', 'sources', 'outputs'],
    'vendor build lock'
  );
  if (lock.schemaVersion !== VENDOR_BUILD_LOCK_SCHEMA_VERSION || lock.type !== VENDOR_BUILD_LOCK_TYPE ||
      lock.lockId !== manifest.vendorBuildLock.lockId) {
    throw new Error('[validate-vendor-provenance] Unsupported or mismatched vendor build-lock schema');
  }
  assertNonEmptyString(lock.lockId, 'vendor build lock id');
  const inputs = validateLockInputs(artifactRoot, lock);
  const tools = validateLockToolchain(lock, inputs);
  const sources = validateLockSources(manifest, lock, inputs);
  const commands = validateLockCommands(lock, inputs, tools);
  const trustedBuilders = validateTrustedVendorBuilders(policy, { requireTwo: true });
  const outputs = validateLockOutputs(
    artifactRoot,
    manifest,
    lock,
    inputs,
    commands,
    sources,
    tools,
    trustedBuilders
  );
  validateNoOrphanLockInputs(inputs, tools, commands, sources, outputs);
  return { lock, inputs, tools, sources, commands, outputs, trustedBuilders };
}

function loadAndValidateVendorBuildLock(artifactRoot, manifest, policy) {
  verifyEvidenceFile(artifactRoot, manifest.vendorBuildLock, 'vendor build lock');
  const absolute = resolveEvidencePath(artifactRoot, manifest.vendorBuildLock, 'vendor build lock');
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch (error) {
    throw new Error(`[validate-vendor-provenance] Invalid vendor build-lock JSON: ${error.message}`);
  }
  return validateVendorBuildLock(artifactRoot, manifest, lock, policy);
}

function assertFullLicenseAndCopyrightContents(contents, expression, label) {
  if (contents.length < 200 || !/(?:copyright|\(c\)|©)/i.test(contents)) {
    throw new Error(`[validate-vendor-provenance] ${label} is not a full license and copyright text`);
  }
  const knownMarkers = [];
  if (/\bMIT\b/i.test(expression)) knownMarkers.push(/permission is hereby granted[\s\S]+software is provided/i);
  if (/BSD-[23]-Clause/i.test(expression)) knownMarkers.push(/redistribution and use[\s\S]+this list of conditions/i);
  if (/OFL-1\.1/i.test(expression)) knownMarkers.push(/SIL OPEN FONT LICENSE[\s\S]+permission & conditions/i);
  if (/Apache-2\.0/i.test(expression)) knownMarkers.push(/Apache License[\s\S]+terms and conditions/i);
  if (/\bISC\b/i.test(expression)) knownMarkers.push(/permission to use, copy, modify[\s\S]+software is provided/i);
  if (/MPL-2\.0/i.test(expression)) knownMarkers.push(/Mozilla Public License[\s\S]+definitions/i);
  if (/GPL/i.test(expression)) knownMarkers.push(/GNU (?:LESSER )?GENERAL PUBLIC LICENSE[\s\S]+terms and conditions/i);
  const hasKnownLicense = knownMarkers.length
    ? knownMarkers.some(pattern => pattern.test(contents))
    : /licen[sc]e[\s\S]+(?:permission|redistribution|terms and conditions)/i.test(contents);
  if (!hasKnownLicense) {
    throw new Error(`[validate-vendor-provenance] ${label} does not match ${expression}`);
  }
}

function assertFullLicenseAndCopyrightText(artifactRoot, license, expression, label) {
  const absolute = resolveEvidencePath(artifactRoot, license, label);
  assertFullLicenseAndCopyrightContents(fs.readFileSync(absolute, 'utf8'), expression, label);
}

function verifyCompleteEvidenceFiles(artifactRoot, manifest) {
  verifyEvidenceFile(artifactRoot, manifest.vendorBuildLock, 'vendor build lock');
  for (const component of manifest.components) {
    for (const license of component.licenseTexts) {
      verifyEvidenceFile(artifactRoot, license, `license text for ${component.purl}`);
      assertFullLicenseAndCopyrightText(
        artifactRoot,
        license,
        component.licenseExpression,
        `license text for ${component.purl}`
      );
    }
  }
  for (const font of manifest.fontEvidence) {
    for (const license of font.licenseTexts) {
      verifyEvidenceFile(artifactRoot, license, `font license text for ${font.name}`);
      assertFullLicenseAndCopyrightText(
        artifactRoot,
        license,
        font.licenseExpression,
        `font license text for ${font.name}`
      );
    }
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const manifest = validateVendorProvenance(args.manifest, { requireComplete: args.requireComplete });
  process.stdout.write(
    `[validate-vendor-provenance] ${manifest.complete ? 'complete' : 'INCOMPLETE'} ` +
    `(${manifest.inventoryScope})\n`
  );
  return manifest;
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  loadAndValidateVendorBuildLock,
  main,
  parseArgs,
  validateCompleteSbom,
  validateDiagnosticSbom,
  validateDiagnosticInventory,
  validatePolicyBinding,
  validateVendorBuildLock,
  validateVendorProvenance,
  verifyDiagnosticEvidenceFiles,
  verifyEvidenceFile,
};
