#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  VENDOR_ASSETS,
  VENDOR_LICENSES,
} = require('./build-site');

// The identifier is retained for URL/test compatibility. The profile is no
// longer a reduced feature set: it is the complete browser application with
// explicitly documented (non-blocking) provenance-hardening gaps.
const PROFILE_ID = 'public-preview-core-v1';
const PROFILE_LABEL = 'Öffentliche Browser-Version';
const TRACKING_ISSUE = 'https://github.com/carstenartur/Unfallatlas/issues/406';
const NOTICE_PATH = 'vendor/third-party-notices.json';
const SBOM_PATH = 'vendor/sbom.cdx.json';
const POLICY_PATH = 'vendor/provenance-policy.json';
const DISABLED_CAPABILITIES = Object.freeze(['video-export']);
const EXCLUDED_VENDOR_ROOTS = Object.freeze([]);
const EXCLUDED_PACKAGE_NAMES = Object.freeze([]);
const LEGACY_HTML = Object.freeze([
  'index.html', 'combi.html', 'showcase.html', 'unfallwerkbank.html', 'werkbank.html'
]);
const PUBLIC_PACKAGES = Object.freeze(Object.fromEntries(
  Object.entries(VENDOR_LICENSES).map(([packageName, policy]) => [packageName, Object.freeze({
    spdx: policy.spdx,
    licensePath: `vendor/licenses/${packageName.replace(/[^a-z0-9._-]/gi, '_')}.txt`,
  })])
));
const PUBLIC_ASSET_PATHS = Object.freeze(VENDOR_ASSETS.map(([, , outputPath]) => outputPath));

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function listFiles(root) {
  const files = [];
  const visit = current => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`[public-pages-profile] Refusing symbolic link: ${current}`);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(current).sort((a, b) => a.localeCompare(b))) {
        visit(path.join(current, entry));
      }
    } else if (stat.isFile()) {
      files.push(current);
    } else {
      throw new Error(`[public-pages-profile] Refusing non-regular entry: ${current}`);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return files;
}

function fingerprintFiles(outputRoot, files) {
  const digest = crypto.createHash('sha256');
  for (const file of files.slice().sort((a, b) => a.localeCompare(b))) {
    const relative = path.relative(outputRoot, file).replace(/\\/g, '/');
    digest.update(relative);
    digest.update('\0');
    digest.update(sha256File(file));
    digest.update('\n');
  }
  return digest.digest('hex');
}

function parseArgs(argv) {
  const args = { root: null, site: '_site' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') args.root = argv[++index] || args.root;
    else if (arg === '--site') args.site = argv[++index] || args.site;
    else throw new Error(`[public-pages-profile] Unknown argument: ${arg}`);
  }
  return args;
}

function assertInsideRoot(root, target, label) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[public-pages-profile] Refusing unsafe ${label}: ${target}`);
  }
}

function redirectDocument() {
  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <meta http-equiv="refresh" content="0; url=werkbank_v2.html">
  <link rel="canonical" href="werkbank_v2.html">
  <title>Unfallwerkbank – öffentliche Browser-Version</title>
</head>
<body>
  <p>Weiter zur <a href="werkbank_v2.html">öffentlichen Browser-Version der Unfallwerkbank</a>.</p>
  <script>location.replace('werkbank_v2.html' + location.search + location.hash);</script>
</body>
</html>
`;
}

function patchCanonicalHtml(siteRoot) {
  const htmlPath = path.join(siteRoot, 'werkbank_v2.html');
  if (!fs.existsSync(htmlPath)) throw new Error('[public-pages-profile] Missing werkbank_v2.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  if (!html.includes('name="unfallwerkbank:distribution-profile"')) {
    html = html.replace(
      /(<meta name="unfallatlas:data-mode"[^>]*>)/,
      `$1\n  <meta name="unfallwerkbank:distribution-profile" content="${PROFILE_ID}" />`
    );
  }
  html = html.replace(/<title>([^<]*)<\/title>/, `<title>${PROFILE_LABEL}</title>`);

  if (!html.includes('js/ua.public-preview.js')) {
    const appScript = /(<script src="js\/ua\.app_v2\.js[^>]*><\/script>)/;
    if (!appScript.test(html)) {
      throw new Error('[public-pages-profile] Cannot locate ua.app_v2.js insertion point');
    }
    html = html.replace(
      appScript,
      `<script src="js/ua.public-preview.js?v=2"></script>\n  $1`
    );
  }

  fs.writeFileSync(htmlPath, `${html.trimEnd()}\n`);
}

function readJson(file, label) {
  if (!fs.existsSync(file)) throw new Error(`[public-pages-profile] Missing ${label}: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`[public-pages-profile] Invalid ${label}: ${error.message}`);
  }
}

function exactSet(actual, expected, label) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`[public-pages-profile] ${label} mismatch. Expected ${right.join(', ')}, got ${left.join(', ')}`);
  }
}

function buildPublicInventory(repoRoot, siteRoot, manifest, notice) {
  const lock = readJson(path.join(repoRoot, 'package-lock.json'), 'package lock');
  const packageNames = Object.keys(PUBLIC_PACKAGES).sort();
  exactSet(Object.keys(manifest.dependencies || {}), packageNames, 'dependency set');
  exactSet((manifest.vendorAssets || []).map(asset => asset.path), PUBLIC_ASSET_PATHS, 'vendor asset set');
  exactSet((notice.dependencies || []).map(item => item.package), packageNames, 'notice dependency set');

  const dependencyByName = new Map((notice.dependencies || []).map(item => [item.package, item]));
  for (const packageName of packageNames) {
    const locked = lock.packages && lock.packages[`node_modules/${packageName}`];
    if (!locked || !locked.version || !locked.integrity || !locked.resolved) {
      throw new Error(`[public-pages-profile] Missing locked package evidence for ${packageName}`);
    }
    if (manifest.dependencies[packageName] !== locked.version) {
      throw new Error(`[public-pages-profile] Manifest version drift for ${packageName}`);
    }
    const dependency = dependencyByName.get(packageName);
    const policy = PUBLIC_PACKAGES[packageName];
    if (!dependency || dependency.version !== locked.version || dependency.spdx !== policy.spdx) {
      throw new Error(`[public-pages-profile] Notice evidence drift for ${packageName}`);
    }
    if (!dependency.licenseTextPath) {
      throw new Error(`[public-pages-profile] Missing bundled license text for ${packageName}`);
    }
    const licenseAbsolute = path.join(siteRoot, dependency.licenseTextPath);
    if (!fs.existsSync(licenseAbsolute) || sha256File(licenseAbsolute) !== dependency.licenseTextSha256) {
      throw new Error(`[public-pages-profile] License evidence drift for ${packageName}`);
    }
  }

  for (const asset of manifest.vendorAssets || []) {
    const absolute = path.join(siteRoot, asset.path);
    if (!fs.existsSync(absolute) || sha256File(absolute) !== asset.sha256 || fs.statSync(absolute).size !== asset.bytes) {
      throw new Error(`[public-pages-profile] Canonical vendor asset drift: ${asset.path}`);
    }
  }

  return { packageNames, assetPaths: [...PUBLIC_ASSET_PATHS] };
}

function annotateNotice(siteRoot, notice) {
  if (notice.schemaVersion !== 2 || notice.complete !== false) {
    throw new Error('[public-pages-profile] Expected the canonical diagnostic notice with declared gaps');
  }
  if (!Array.isArray(notice.knownGaps)) {
    throw new Error('[public-pages-profile] Canonical notice lacks known-gaps inventory');
  }
  const annotated = {
    ...notice,
    distributionProfile: PROFILE_ID,
    distributionLabel: PROFILE_LABEL,
    complianceMode: 'declared-known-provenance-gaps',
    knownLicenseRestrictions: [],
    knownLicenseConflicts: [],
    provenanceGapsBlockCapabilities: false,
    disabledCapabilities: [...DISABLED_CAPABILITIES],
    excludedPackages: [],
    policyStatement:
      'Known reproducibility and component-level provenance gaps are documented as hardening work; ' +
      'they are not treated as a license-based prohibition on the browser features.',
  };
  const noticeAbsolute = path.join(siteRoot, NOTICE_PATH);
  fs.writeFileSync(noticeAbsolute, `${JSON.stringify(annotated, null, 2)}\n`);
  return { notice: annotated, noticeAbsolute };
}

function updateBuildManifest(siteRoot, manifest, annotated, inventory) {
  const notice = annotated.notice;
  const sbomPath = notice.sbom && notice.sbom.path || SBOM_PATH;
  const sbomAbsolute = path.join(siteRoot, sbomPath);
  const policyAbsolute = path.join(siteRoot, POLICY_PATH);
  if (!fs.existsSync(sbomAbsolute) || !fs.existsSync(policyAbsolute)) {
    throw new Error('[public-pages-profile] Missing diagnostic SBOM or provenance policy');
  }

  manifest.thirdPartyNotices = {
    path: NOTICE_PATH,
    sha256: sha256File(annotated.noticeAbsolute),
    complete: false,
    inventoryScope: notice.inventoryScope,
    trackingIssue: TRACKING_ISSUE,
    dependencies: notice.dependencies,
    sbom: notice.sbom,
    provenancePolicy: notice.provenancePolicy,
    knownGapIds: notice.knownGaps.map(gap => gap.id).sort(),
    componentCount: notice.components.length,
    assetCount: notice.assetAssessments.length,
    fontCount: notice.fontEvidence.length,
  };
  manifest.distribution = {
    profile: PROFILE_ID,
    label: PROFILE_LABEL,
    publicPreview: true,
    vendorInventoryComplete: false,
    complianceMode: notice.complianceMode,
    knownLicenseRestrictions: [],
    knownLicenseConflicts: [],
    provenanceGapsBlockCapabilities: false,
    disabledCapabilities: [...DISABLED_CAPABILITIES],
    provenanceHardeningIssue: TRACKING_ISSUE,
  };
  manifest.networkPolicy = Object.assign({}, manifest.networkPolicy, {
    distributionProfile: PROFILE_ID,
    disabledCapabilities: [...DISABLED_CAPABILITIES],
  });

  const appFiles = listFiles(siteRoot).filter(file => {
    const relative = path.relative(siteRoot, file).replace(/\\/g, '/');
    return relative !== 'build-manifest.json' && !relative.startsWith('out/');
  });
  manifest.application.fingerprint = fingerprintFiles(siteRoot, appFiles);
  manifest.fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    application: manifest.application.fingerprint,
    dependencies: manifest.dependencies,
    thirdPartyNotices: manifest.thirdPartyNotices.sha256,
    data: manifest.data.fingerprint,
    networkPolicy: manifest.networkPolicy,
    distribution: manifest.distribution,
  })).digest('hex');
  fs.writeFileSync(path.join(siteRoot, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    profile: PROFILE_ID,
    siteRoot,
    assetCount: inventory.assetPaths.length,
    packageCount: inventory.packageNames.length,
    disabledCapabilities: [...DISABLED_CAPABILITIES],
    knownGapCount: notice.knownGaps.length,
  };
}

function applyPublicPagesProfile(options = {}) {
  const repoRoot = path.resolve(options.root || path.join(__dirname, '..'));
  const siteRoot = path.resolve(repoRoot, options.site || '_site');
  assertInsideRoot(repoRoot, siteRoot, 'site directory');
  const manifestPath = path.join(siteRoot, 'build-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('[public-pages-profile] Build the canonical site before applying the public profile');
  }
  if (!fs.existsSync(path.join(siteRoot, 'js', 'ua.public-preview.js'))) {
    throw new Error('[public-pages-profile] Public preview runtime was not copied into the site');
  }

  patchCanonicalHtml(siteRoot);
  for (const legacy of LEGACY_HTML) {
    fs.writeFileSync(path.join(siteRoot, legacy), redirectDocument());
  }

  const manifest = readJson(manifestPath, 'build manifest');
  const notice = readJson(path.join(siteRoot, NOTICE_PATH), 'third-party notice');
  const inventory = buildPublicInventory(repoRoot, siteRoot, manifest, notice);
  const annotated = annotateNotice(siteRoot, notice);
  const result = updateBuildManifest(siteRoot, manifest, annotated, inventory);

  process.stdout.write(
    `[public-pages-profile] Materialized ${PROFILE_LABEL} with ${result.assetCount} locked browser assets; ` +
    `only ${DISABLED_CAPABILITIES.join(', ')} disabled; ${result.knownGapCount} provenance-hardening gaps declared.\n`
  );
  return result;
}

function main(argv) {
  const args = parseArgs(argv);
  applyPublicPagesProfile(args);
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
  DISABLED_CAPABILITIES,
  EXCLUDED_PACKAGE_NAMES,
  EXCLUDED_VENDOR_ROOTS,
  LEGACY_HTML,
  NOTICE_PATH,
  POLICY_PATH,
  PROFILE_ID,
  PROFILE_LABEL,
  PUBLIC_ASSET_PATHS,
  PUBLIC_PACKAGES,
  SBOM_PATH,
  TRACKING_ISSUE,
  applyPublicPagesProfile,
  fingerprintFiles,
  listFiles,
  parseArgs,
  sha256File,
};
