#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  DISABLED_CAPABILITIES,
  EXCLUDED_PACKAGE_NAMES,
  EXCLUDED_VENDOR_ROOTS,
  LEGACY_HTML,
  NOTICE_PATH,
  PROFILE_ID,
  PUBLIC_ASSET_PATHS,
  PUBLIC_PACKAGES,
  SBOM_PATH,
  fingerprintFiles,
  listFiles,
  parseArgs,
  sha256File
} = require('./build-public-pages-profile');
const {
  assertLocalAssetReferences,
  assertNoRuntimeCdn,
  assertSymlinkFreeTree
} = require('./build-site');

function assert(condition, message) {
  if (!condition) throw new Error(`[validate-public-pages-profile] ${message}`);
}

function sameValues(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function exactSorted(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(sameValues(left, right), `${label} mismatch. Expected ${right.join(', ')}, got ${left.join(', ')}`);
}

function assertHash(value, label) {
  assert(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), `${label} is not SHA-256`);
}

function assertInsideRoot(root, target, label) {
  const relative = path.relative(root, target);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `unsafe ${label}: ${target}`);
}

function readJson(file, label) {
  assert(fs.existsSync(file), `missing ${label}: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`[validate-public-pages-profile] Invalid ${label}: ${error.message}`);
  }
}

function validateHtml(siteRoot, allowedVendorPaths) {
  const canonical = fs.readFileSync(path.join(siteRoot, 'werkbank_v2.html'), 'utf8');
  assert(canonical.includes(`name="unfallwerkbank:distribution-profile" content="${PROFILE_ID}"`),
    'canonical page lacks the distribution-profile marker');
  assert(canonical.includes('js/ua.public-preview.js'), 'canonical page lacks the public preview runtime');
  for (const prefix of ['vendor/export/', 'vendor/leaflet.heat/', 'vendor/leaflet-draw/', 'vendor/leaflet-image/']) {
    assert(!canonical.includes(prefix), `canonical page still references excluded vendor path ${prefix}`);
  }

  const publicRuntime = fs.readFileSync(path.join(siteRoot, 'js', 'ua.public-preview.js'), 'utf8');
  assert(publicRuntime.includes(PROFILE_ID), 'public runtime does not declare the expected profile');
  for (const capability of DISABLED_CAPABILITIES) {
    assert(publicRuntime.includes(capability), `public runtime does not declare disabled capability ${capability}`);
  }
  for (const id of ['btnDraw', 'toggleHeat', 'btnExportWord', 'btnExportPDF']) {
    assert(publicRuntime.includes(id), `public runtime does not disable ${id}`);
  }

  for (const legacy of LEGACY_HTML) {
    const source = fs.readFileSync(path.join(siteRoot, legacy), 'utf8');
    assert(source.includes('werkbank_v2.html'), `${legacy} is not a canonical redirect`);
    assert(!source.includes('vendor/'), `${legacy} still embeds a vendor runtime`);
  }

  const htmlFiles = listFiles(siteRoot).filter(file => path.extname(file).toLowerCase() === '.html');
  for (const file of htmlFiles) {
    const source = fs.readFileSync(file, 'utf8');
    const matches = source.matchAll(/(?:src|href)=["'](vendor\/[^"'?#]+)["']/g);
    for (const match of matches) {
      assert(allowedVendorPaths.has(match[1]),
        `${path.relative(siteRoot, file)} references non-profile vendor asset ${match[1]}`);
    }
  }
}

function validatePublicPagesProfile(options = {}) {
  const repoRoot = path.resolve(options.root || path.join(__dirname, '..'));
  const siteRoot = path.resolve(repoRoot, options.site || '_site');
  assertInsideRoot(repoRoot, siteRoot, 'site directory');
  assert(fs.existsSync(siteRoot) && fs.statSync(siteRoot).isDirectory(), `site directory does not exist: ${siteRoot}`);
  assertSymlinkFreeTree(siteRoot, 'public Pages site');

  for (const excluded of EXCLUDED_VENDOR_ROOTS) {
    assert(!fs.existsSync(path.join(siteRoot, excluded)), `excluded vendor tree is still delivered: ${excluded}`);
  }

  const manifestPath = path.join(siteRoot, 'build-manifest.json');
  const noticePath = path.join(siteRoot, NOTICE_PATH);
  const sbomPath = path.join(siteRoot, SBOM_PATH);
  const manifest = readJson(manifestPath, 'build manifest');
  const notice = readJson(noticePath, 'public third-party notice');
  const sbom = readJson(sbomPath, 'public CycloneDX SBOM');
  const lock = readJson(path.join(repoRoot, 'package-lock.json'), 'package lock');

  assert(manifest.schemaVersion === 1, 'unexpected build-manifest schema');
  assert(manifest.distribution && manifest.distribution.profile === PROFILE_ID, 'wrong distribution profile');
  assert(manifest.distribution.publicPreview === true, 'publicPreview flag is not true');
  assert(manifest.distribution.vendorInventoryComplete === true, 'profile does not claim a complete vendor inventory');
  exactSorted(manifest.distribution.disabledCapabilities || [], DISABLED_CAPABILITIES, 'disabled capabilities');

  const publicPackageNames = Object.keys(PUBLIC_PACKAGES).sort();
  exactSorted(Object.keys(manifest.dependencies || {}), publicPackageNames, 'build-manifest dependency set');
  for (const packageName of publicPackageNames) {
    const locked = lock.packages && lock.packages[`node_modules/${packageName}`];
    assert(locked && locked.version === manifest.dependencies[packageName],
      `dependency ${packageName} is not bound to package-lock.json`);
  }

  const assetPaths = (manifest.vendorAssets || []).map(asset => asset.path);
  exactSorted(assetPaths, PUBLIC_ASSET_PATHS, 'delivered vendor assets');
  const allowedVendorPaths = new Set([
    ...PUBLIC_ASSET_PATHS,
    ...Object.values(PUBLIC_PACKAGES).map(value => value.licensePath),
    NOTICE_PATH,
    SBOM_PATH
  ]);
  const vendorFiles = listFiles(path.join(siteRoot, 'vendor'))
    .map(file => path.relative(siteRoot, file).replace(/\\/g, '/'));
  exactSorted(vendorFiles, allowedVendorPaths, 'public vendor file tree');

  for (const asset of manifest.vendorAssets) {
    assert(publicPackageNames.includes(asset.package), `asset belongs to excluded package: ${asset.package}`);
    const absolute = path.join(siteRoot, asset.path);
    assert(fs.existsSync(absolute), `missing vendor asset ${asset.path}`);
    assertHash(asset.sha256, `asset hash ${asset.path}`);
    assert(sha256File(absolute) === asset.sha256, `vendor asset hash drift: ${asset.path}`);
    assert(fs.statSync(absolute).size === asset.bytes, `vendor asset byte-size drift: ${asset.path}`);
  }

  assert(notice.schemaVersion === 1, 'unexpected public notice schema');
  assert(notice.distributionProfile === PROFILE_ID, 'notice profile mismatch');
  assert(notice.inventoryScope === 'public-preview-core-delivered-assets', 'notice scope mismatch');
  assert(notice.complete === true, 'public notice is not complete');
  assert(Array.isArray(notice.knownGaps) && notice.knownGaps.length === 0, 'public notice contains unresolved gaps');
  exactSorted(notice.excludedPackages || [], EXCLUDED_PACKAGE_NAMES, 'excluded package declaration');
  exactSorted(notice.disabledCapabilities || [], DISABLED_CAPABILITIES, 'notice disabled capabilities');
  exactSorted((notice.dependencies || []).map(dependency => dependency.package), publicPackageNames,
    'notice dependencies');
  exactSorted((notice.components || []).map(component => component.name), publicPackageNames,
    'notice components');
  exactSorted((notice.assetAssessments || []).map(asset => asset.path), PUBLIC_ASSET_PATHS,
    'notice asset assessments');
  assert(Array.isArray(notice.fontEvidence) && notice.fontEvidence.length === 0,
    'public profile unexpectedly delivers font containers');

  for (const dependency of notice.dependencies) {
    const policy = PUBLIC_PACKAGES[dependency.package];
    const locked = lock.packages[`node_modules/${dependency.package}`];
    assert(dependency.version === locked.version, `notice version drift for ${dependency.package}`);
    assert(dependency.integrity === locked.integrity, `notice integrity drift for ${dependency.package}`);
    assert(dependency.resolved === locked.resolved, `notice resolved URL drift for ${dependency.package}`);
    assert(dependency.spdx === policy.spdx, `notice SPDX drift for ${dependency.package}`);
    assert(dependency.licenseTextPath === policy.licensePath,
      `notice license path drift for ${dependency.package}`);
    const licenseAbsolute = path.join(siteRoot, dependency.licenseTextPath);
    assert(fs.existsSync(licenseAbsolute), `missing license text for ${dependency.package}`);
    assertHash(dependency.licenseTextSha256, `license hash for ${dependency.package}`);
    assert(sha256File(licenseAbsolute) === dependency.licenseTextSha256,
      `license hash drift for ${dependency.package}`);
  }

  const assessmentByPath = new Map(notice.assetAssessments.map(asset => [asset.path, asset]));
  for (const manifestAsset of manifest.vendorAssets) {
    const assessment = assessmentByPath.get(manifestAsset.path);
    assert(assessment && assessment.sha256 === manifestAsset.sha256,
      `notice is not bound to ${manifestAsset.path}`);
    assert(assessment.reproducible === true && assessment.provenanceComplete === true,
      `asset provenance is incomplete: ${manifestAsset.path}`);
    assert(Array.isArray(assessment.contains) && assessment.contains.length === 1,
      `asset contains relation is incomplete: ${manifestAsset.path}`);
    assert(Array.isArray(assessment.gaps) && assessment.gaps.length === 0,
      `asset contains a provenance gap: ${manifestAsset.path}`);
  }

  assert(sbom.bomFormat === 'CycloneDX' && sbom.specVersion === '1.6', 'SBOM is not CycloneDX 1.6');
  const completeness = (sbom.metadata && sbom.metadata.properties || [])
    .find(property => property.name === 'unfallatlas:inventory-completeness');
  assert(completeness && completeness.value === 'complete', 'SBOM completeness marker is missing');
  const profileProperty = (sbom.metadata && sbom.metadata.properties || [])
    .find(property => property.name === 'unfallatlas:distribution-profile');
  assert(profileProperty && profileProperty.value === PROFILE_ID, 'SBOM profile marker is missing');
  const composition = Array.isArray(sbom.compositions) ? sbom.compositions[0] : null;
  assert(composition && composition.aggregate === 'complete', 'SBOM composition is not complete');
  exactSorted(
    composition.assemblies || [],
    PUBLIC_ASSET_PATHS.map(assetPath => `urn:unfallatlas:public-vendor-asset:${assetPath}`),
    'SBOM assemblies'
  );
  assert(notice.sbom && notice.sbom.path === SBOM_PATH && notice.sbom.complete === true,
    'notice SBOM reference is incomplete');
  assertHash(notice.sbom.sha256, 'notice SBOM hash');
  assert(sha256File(sbomPath) === notice.sbom.sha256, 'SBOM hash drift');

  assert(manifest.thirdPartyNotices && manifest.thirdPartyNotices.path === NOTICE_PATH,
    'build manifest notice path mismatch');
  assert(manifest.thirdPartyNotices.complete === true, 'build manifest does not mark notice complete');
  assertHash(manifest.thirdPartyNotices.sha256, 'build-manifest notice hash');
  assert(sha256File(noticePath) === manifest.thirdPartyNotices.sha256, 'notice hash drift');

  validateHtml(siteRoot, allowedVendorPaths);
  assertLocalAssetReferences(siteRoot);
  assertNoRuntimeCdn(siteRoot);

  const appFiles = listFiles(siteRoot).filter(file => {
    const relative = path.relative(siteRoot, file).replace(/\\/g, '/');
    return relative !== 'build-manifest.json' && !relative.startsWith('out/');
  });
  const applicationFingerprint = fingerprintFiles(siteRoot, appFiles);
  assertHash(manifest.application && manifest.application.fingerprint, 'application fingerprint');
  assert(applicationFingerprint === manifest.application.fingerprint, 'application fingerprint drift');
  const overallFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    application: manifest.application.fingerprint,
    dependencies: manifest.dependencies,
    thirdPartyNotices: manifest.thirdPartyNotices.sha256,
    data: manifest.data.fingerprint,
    networkPolicy: manifest.networkPolicy,
    distribution: manifest.distribution
  })).digest('hex');
  assertHash(manifest.fingerprint, 'build fingerprint');
  assert(overallFingerprint === manifest.fingerprint, 'build fingerprint drift');

  process.stdout.write(
    `[validate-public-pages-profile] ${PROFILE_ID} is complete: ${PUBLIC_ASSET_PATHS.length} assets, ` +
    `${publicPackageNames.length} packages, no excluded bundles.\n`
  );
  return {
    profile: PROFILE_ID,
    assetCount: PUBLIC_ASSET_PATHS.length,
    packageCount: publicPackageNames.length,
    buildFingerprint: manifest.fingerprint
  };
}

function main(argv) {
  const args = parseArgs(argv);
  validatePublicPagesProfile(args);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  }
}

module.exports = { validatePublicPagesProfile };
