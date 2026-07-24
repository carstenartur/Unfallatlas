#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  DISABLED_CAPABILITIES,
  LEGACY_HTML,
  NOTICE_PATH,
  POLICY_PATH,
  PROFILE_ID,
  PUBLIC_ASSET_PATHS,
  PUBLIC_PACKAGES,
  SBOM_PATH,
  fingerprintFiles,
  listFiles,
  parseArgs,
  sha256File,
} = require('./build-public-pages-profile');
const {
  assertLocalAssetReferences,
  assertNoRuntimeCdn,
  assertSymlinkFreeTree,
} = require('./build-site');

function assert(condition, message) {
  if (!condition) throw new Error(`[validate-public-pages-profile] ${message}`);
}

function exactSorted(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  assert(JSON.stringify(left) === JSON.stringify(right),
    `${label} mismatch. Expected ${right.join(', ')}, got ${left.join(', ')}`);
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

function validateHtml(siteRoot) {
  const canonical = fs.readFileSync(path.join(siteRoot, 'werkbank_v2.html'), 'utf8');
  assert(canonical.includes(`name="unfallwerkbank:distribution-profile" content="${PROFILE_ID}"`),
    'canonical page lacks the distribution-profile marker');
  assert(canonical.includes('js/ua.public-preview.js'), 'canonical page lacks the public browser runtime');

  for (const reference of [
    'vendor/leaflet.heat/leaflet-heat.js',
    'vendor/leaflet-draw/leaflet.draw.css',
    'vendor/leaflet-draw/leaflet.draw.js',
    'vendor/leaflet-image/leaflet-image.js',
  ]) {
    assert(canonical.includes(reference), `canonical page lacks browser capability asset ${reference}`);
  }

  const publicRuntime = fs.readFileSync(path.join(siteRoot, 'js', 'ua.public-preview.js'), 'utf8');
  assert(publicRuntime.includes(PROFILE_ID), 'public runtime does not declare the expected profile');
  exactSorted(DISABLED_CAPABILITIES, ['video-export'], 'disabled capabilities policy');
  assert(publicRuntime.includes("'video-export'"), 'public runtime does not disable the backend-only video export');
  assert(!publicRuntime.includes('UA.ensureExportLibraries ='), 'public runtime still blocks Word/PDF libraries');
  assert(!publicRuntime.includes("hideElement(document.getElementById('exportGroupAntrag'))"),
    'public runtime still hides Word/PDF export controls');
  assert(!publicRuntime.includes('disableButton(ctx.ui.btnDraw'), 'public runtime still disables rectangle drawing');
  assert(!publicRuntime.includes('hideElement(heatToggle)'), 'public runtime still hides the heatmap');
  assert(publicRuntime.includes('eine bekannte Lizenzbeschränkung'),
    'public runtime does not explain that no known license restriction is asserted');

  for (const legacy of LEGACY_HTML) {
    const source = fs.readFileSync(path.join(siteRoot, legacy), 'utf8');
    assert(source.includes('werkbank_v2.html'), `${legacy} is not a canonical redirect`);
    assert(!source.includes('vendor/'), `${legacy} still embeds a vendor runtime`);
  }
}

function validatePublicPagesProfile(options = {}) {
  const repoRoot = path.resolve(options.root || path.join(__dirname, '..'));
  const siteRoot = path.resolve(repoRoot, options.site || '_site');
  assertInsideRoot(repoRoot, siteRoot, 'site directory');
  assert(fs.existsSync(siteRoot) && fs.statSync(siteRoot).isDirectory(), `site directory does not exist: ${siteRoot}`);
  assertSymlinkFreeTree(siteRoot, 'public Pages site');

  const manifestPath = path.join(siteRoot, 'build-manifest.json');
  const noticePath = path.join(siteRoot, NOTICE_PATH);
  const sbomPath = path.join(siteRoot, SBOM_PATH);
  const policyPath = path.join(siteRoot, POLICY_PATH);
  const manifest = readJson(manifestPath, 'build manifest');
  const notice = readJson(noticePath, 'third-party notice');
  const sbom = readJson(sbomPath, 'CycloneDX SBOM');
  const policy = readJson(policyPath, 'provenance policy');
  const lock = readJson(path.join(repoRoot, 'package-lock.json'), 'package lock');

  assert(manifest.schemaVersion === 1, 'unexpected build-manifest schema');
  assert(manifest.distribution && manifest.distribution.profile === PROFILE_ID, 'wrong distribution profile');
  assert(manifest.distribution.publicPreview === true, 'publicPreview flag is not true');
  assert(manifest.distribution.vendorInventoryComplete === false,
    'profile must not overstate component-level provenance completeness');
  assert(manifest.distribution.provenanceGapsBlockCapabilities === false,
    'documented provenance gaps still block browser capabilities');
  assert(Array.isArray(manifest.distribution.knownLicenseRestrictions) &&
    manifest.distribution.knownLicenseRestrictions.length === 0,
  'profile asserts a license restriction without evidence');
  exactSorted(manifest.distribution.disabledCapabilities || [], DISABLED_CAPABILITIES, 'disabled capabilities');
  exactSorted(manifest.networkPolicy.disabledCapabilities || [], DISABLED_CAPABILITIES,
    'network policy disabled capabilities');

  const packageNames = Object.keys(PUBLIC_PACKAGES).sort();
  exactSorted(Object.keys(manifest.dependencies || {}), packageNames, 'build-manifest dependency set');
  for (const packageName of packageNames) {
    const locked = lock.packages && lock.packages[`node_modules/${packageName}`];
    assert(locked && locked.version === manifest.dependencies[packageName],
      `dependency ${packageName} is not bound to package-lock.json`);
  }

  const assetPaths = (manifest.vendorAssets || []).map(asset => asset.path);
  exactSorted(assetPaths, PUBLIC_ASSET_PATHS, 'delivered vendor assets');
  for (const asset of manifest.vendorAssets) {
    const absolute = path.join(siteRoot, asset.path);
    assert(fs.existsSync(absolute), `missing vendor asset ${asset.path}`);
    assertHash(asset.sha256, `asset hash ${asset.path}`);
    assert(sha256File(absolute) === asset.sha256, `vendor asset hash drift: ${asset.path}`);
    assert(fs.statSync(absolute).size === asset.bytes, `vendor asset byte-size drift: ${asset.path}`);
  }

  assert(notice.schemaVersion === 2, 'unexpected notice schema');
  assert(notice.distributionProfile === PROFILE_ID, 'notice profile mismatch');
  assert(notice.complete === false, 'notice overstates complete component-level provenance');
  assert(notice.complianceMode === 'declared-known-provenance-gaps', 'notice compliance mode mismatch');
  assert(notice.provenanceGapsBlockCapabilities === false,
    'notice still treats provenance hardening gaps as capability blockers');
  exactSorted(notice.disabledCapabilities || [], DISABLED_CAPABILITIES, 'notice disabled capabilities');
  exactSorted(notice.excludedPackages || [], [], 'notice excluded package declaration');
  assert(Array.isArray(notice.knownLicenseRestrictions) && notice.knownLicenseRestrictions.length === 0,
    'notice asserts unknown license restrictions');
  assert(Array.isArray(notice.knownLicenseConflicts) && notice.knownLicenseConflicts.length === 0,
    'notice asserts unknown license conflicts');

  const expectedGapIds = (policy.unresolvedAssets || []).map(gap => gap.id).sort();
  const noticeGapIds = (notice.knownGaps || []).map(gap => gap.id).sort();
  exactSorted(noticeGapIds, expectedGapIds, 'declared provenance gaps');

  const dependencies = new Map((notice.dependencies || []).map(item => [item.package, item]));
  exactSorted([...dependencies.keys()], packageNames, 'notice direct dependencies');
  for (const packageName of packageNames) {
    const dependency = dependencies.get(packageName);
    const locked = lock.packages[`node_modules/${packageName}`];
    const packagePolicy = PUBLIC_PACKAGES[packageName];
    assert(dependency.version === locked.version, `notice version drift for ${packageName}`);
    assert(dependency.spdx === packagePolicy.spdx, `notice SPDX drift for ${packageName}`);
    assert(dependency.licenseTextPath, `notice lacks bundled license text for ${packageName}`);
    const licenseAbsolute = path.join(siteRoot, dependency.licenseTextPath);
    assert(fs.existsSync(licenseAbsolute), `missing license text for ${packageName}`);
    assertHash(dependency.licenseTextSha256, `license hash for ${packageName}`);
    assert(sha256File(licenseAbsolute) === dependency.licenseTextSha256,
      `license hash drift for ${packageName}`);
  }

  const componentByNameVersion = new Map((notice.components || []).map(component => [
    `${component.name}\0${component.version}`,
    component,
  ]));
  const assessmentByPath = new Map((notice.assetAssessments || []).map(asset => [asset.path, asset]));
  exactSorted([...assessmentByPath.keys()], PUBLIC_ASSET_PATHS, 'notice asset assessments');
  for (const manifestAsset of manifest.vendorAssets) {
    const assessment = assessmentByPath.get(manifestAsset.path);
    assert(assessment && assessment.sha256 === manifestAsset.sha256,
      `notice is not bound to ${manifestAsset.path}`);
    const direct = componentByNameVersion.get(`${assessment.package}\0${manifest.dependencies[assessment.package]}`);
    assert(direct && Array.isArray(assessment.contains) && assessment.contains.includes(direct.purl),
      `asset lacks direct package contains relation: ${manifestAsset.path}`);
    if (assessment.provenanceComplete === true) {
      assert(Array.isArray(assessment.gaps) && assessment.gaps.length === 0,
        `complete asset declares gaps: ${manifestAsset.path}`);
    } else {
      assert(Array.isArray(assessment.gaps) && assessment.gaps.length > 0,
        `incomplete asset lacks an explicit gap: ${manifestAsset.path}`);
      for (const gapId of assessment.gaps) {
        assert(expectedGapIds.includes(gapId), `asset references undeclared gap ${gapId}`);
      }
    }
  }

  assert(Array.isArray(notice.fontEvidence) && notice.fontEvidence.length === 4,
    'expected four embedded Roboto font records');
  for (const font of notice.fontEvidence) {
    assert(font.licenseExpression === 'OFL-1.1', `font license drift for ${font.name}`);
    assert(Array.isArray(font.licenseTexts) && font.licenseTexts.length > 0,
      `font lacks bundled OFL text: ${font.name}`);
    for (const license of font.licenseTexts) {
      const absolute = path.join(siteRoot, license.path);
      assert(fs.existsSync(absolute), `missing font license text ${license.path}`);
      assertHash(license.sha256, `font license hash ${license.path}`);
      assert(sha256File(absolute) === license.sha256, `font license hash drift ${license.path}`);
    }
  }

  assert(sbom.bomFormat === 'CycloneDX' && sbom.specVersion === '1.6', 'SBOM is not CycloneDX 1.6');
  const completeness = (sbom.metadata && sbom.metadata.properties || [])
    .find(property => property.name === 'unfallatlas:inventory-completeness');
  assert(completeness && completeness.value === 'incomplete',
    'diagnostic SBOM must state its known component-level gaps');
  const composition = Array.isArray(sbom.compositions) ? sbom.compositions[0] : null;
  assert(composition && composition.aggregate === 'incomplete', 'SBOM composition must remain honest');
  exactSorted(
    composition.assemblies || [],
    PUBLIC_ASSET_PATHS.map(assetPath => `urn:unfallatlas:vendor-asset:${assetPath}`),
    'SBOM assemblies'
  );
  assert(notice.sbom && notice.sbom.path === SBOM_PATH && notice.sbom.complete === false,
    'notice SBOM reference must be diagnostic and incomplete');
  assertHash(notice.sbom.sha256, 'notice SBOM hash');
  assert(sha256File(sbomPath) === notice.sbom.sha256, 'SBOM hash drift');

  assert(manifest.thirdPartyNotices && manifest.thirdPartyNotices.path === NOTICE_PATH,
    'build manifest notice path mismatch');
  assert(manifest.thirdPartyNotices.complete === false,
    'build manifest overstates notice completeness');
  exactSorted(manifest.thirdPartyNotices.knownGapIds || [], expectedGapIds,
    'build manifest provenance gaps');
  assertHash(manifest.thirdPartyNotices.sha256, 'build-manifest notice hash');
  assert(sha256File(noticePath) === manifest.thirdPartyNotices.sha256, 'notice hash drift');

  validateHtml(siteRoot);
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
    distribution: manifest.distribution,
  })).digest('hex');
  assertHash(manifest.fingerprint, 'build fingerprint');
  assert(overallFingerprint === manifest.fingerprint, 'build fingerprint drift');

  process.stdout.write(
    `[validate-public-pages-profile] ${PROFILE_ID}: ${PUBLIC_ASSET_PATHS.length} locked assets, ` +
    `${packageNames.length} direct packages, ${expectedGapIds.length} declared hardening gaps, ` +
    `only video-export disabled.\n`
  );
  return {
    profile: PROFILE_ID,
    assetCount: PUBLIC_ASSET_PATHS.length,
    packageCount: packageNames.length,
    knownGapCount: expectedGapIds.length,
    buildFingerprint: manifest.fingerprint,
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
