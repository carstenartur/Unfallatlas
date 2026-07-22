#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROFILE_ID = 'public-preview-core-v1';
const TRACKING_ISSUE = 'https://github.com/carstenartur/Unfallatlas/issues/406';
const PUBLIC_PACKAGES = Object.freeze({
  leaflet: Object.freeze({ spdx: 'BSD-2-Clause', licensePath: 'vendor/licenses/leaflet.txt' }),
  'leaflet.markercluster': Object.freeze({ spdx: 'MIT', licensePath: 'vendor/licenses/leaflet.markercluster.txt' })
});
const PUBLIC_ASSET_PATHS = Object.freeze([
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet.markercluster/MarkerCluster.css',
  'vendor/leaflet.markercluster/MarkerCluster.Default.css',
  'vendor/leaflet.markercluster/leaflet.markercluster.js'
]);
const EXCLUDED_VENDOR_ROOTS = Object.freeze([
  'vendor/export',
  'vendor/leaflet.heat',
  'vendor/leaflet-draw',
  'vendor/leaflet-image'
]);
const EXCLUDED_PACKAGE_NAMES = Object.freeze([
  'docx', 'file-saver', 'leaflet-draw', 'leaflet-image', 'leaflet.heat', 'pdfmake'
]);
const LEGACY_HTML = Object.freeze([
  'index.html', 'combi.html', 'showcase.html', 'unfallwerkbank.html', 'werkbank.html'
]);
const DISABLED_CAPABILITIES = Object.freeze([
  'interactive-rectangle-drawing',
  'heatmap',
  'word-export',
  'pdf-export'
]);
const NOTICE_PATH = 'vendor/third-party-notices.json';
const SBOM_PATH = 'vendor/public-preview-sbom.cdx.json';

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

function npmPurl(name, version) {
  return `pkg:npm/${encodeURIComponent(name).replace(/%2F/gi, '/')}@${version}`;
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
  <title>Unfallwerkbank – öffentliche Kernvorschau</title>
</head>
<body>
  <p>Weiter zur <a href="werkbank_v2.html">öffentlichen Kernvorschau der Unfallwerkbank</a>.</p>
  <script>location.replace('werkbank_v2.html' + location.search + location.hash);</script>
</body>
</html>
`;
}

function patchCanonicalHtml(siteRoot) {
  const htmlPath = path.join(siteRoot, 'werkbank_v2.html');
  if (!fs.existsSync(htmlPath)) throw new Error('[public-pages-profile] Missing werkbank_v2.html');
  let html = fs.readFileSync(htmlPath, 'utf8');
  const forbiddenReferences = [
    'vendor/leaflet.heat/',
    'vendor/leaflet-draw/',
    'vendor/leaflet-image/',
    'vendor/export/'
  ];
  html = html
    .split(/\r?\n/)
    .filter(line => !forbiddenReferences.some(reference => line.includes(reference)))
    .join('\n');

  if (!html.includes('name="unfallwerkbank:distribution-profile"')) {
    html = html.replace(
      /(<meta name="unfallatlas:data-mode"[^>]*>)/,
      `$1\n  <meta name="unfallwerkbank:distribution-profile" content="${PROFILE_ID}" />`
    );
  }
  html = html.replace(
    /<title>([^<]*)<\/title>/,
    '<title>Unfallwerkbank – öffentliche Kernvorschau</title>'
  );
  if (!html.includes('js/ua.public-preview.js')) {
    const appScript = /(<script src="js\/ua\.app_v2\.js[^>]*><\/script>)/;
    if (!appScript.test(html)) {
      throw new Error('[public-pages-profile] Cannot locate ua.app_v2.js insertion point');
    }
    html = html.replace(
      appScript,
      `<script src="js/ua.public-preview.js?v=1"></script>\n  $1`
    );
  }
  fs.writeFileSync(htmlPath, `${html.trimEnd()}\n`);
}

function removeExcludedVendorFiles(siteRoot, oldManifest) {
  for (const relative of EXCLUDED_VENDOR_ROOTS) {
    fs.rmSync(path.join(siteRoot, relative), { recursive: true, force: true });
  }

  const licensesRoot = path.join(siteRoot, 'vendor', 'licenses');
  if (fs.existsSync(licensesRoot)) {
    const allowed = new Set(Object.values(PUBLIC_PACKAGES).map(value => path.basename(value.licensePath)));
    for (const entry of fs.readdirSync(licensesRoot)) {
      if (!allowed.has(entry)) fs.rmSync(path.join(licensesRoot, entry), { recursive: true, force: true });
    }
  }

  const oldNotice = oldManifest && oldManifest.thirdPartyNotices;
  for (const relative of [
    oldNotice && oldNotice.sbom && oldNotice.sbom.path,
    oldNotice && oldNotice.provenancePolicy && oldNotice.provenancePolicy.path,
    'vendor/sbom.cdx.json',
    'vendor/provenance-policy.json'
  ].filter(Boolean)) {
    if (relative !== NOTICE_PATH && relative !== SBOM_PATH) {
      fs.rmSync(path.join(siteRoot, relative), { recursive: true, force: true });
    }
  }
}

function buildPublicInventory(repoRoot, siteRoot, manifest) {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
  const expectedAssetPaths = new Set(PUBLIC_ASSET_PATHS);
  const publicAssets = (manifest.vendorAssets || [])
    .filter(asset => Object.prototype.hasOwnProperty.call(PUBLIC_PACKAGES, asset.package))
    .sort((left, right) => left.path.localeCompare(right.path));

  const actualAssetPaths = new Set(publicAssets.map(asset => asset.path));
  if (actualAssetPaths.size !== expectedAssetPaths.size ||
      [...expectedAssetPaths].some(assetPath => !actualAssetPaths.has(assetPath))) {
    throw new Error('[public-pages-profile] Canonical build does not contain the exact public vendor asset set');
  }

  const components = Object.keys(PUBLIC_PACKAGES).sort().map(packageName => {
    const packageRecord = lock.packages && lock.packages[`node_modules/${packageName}`];
    if (!packageRecord || !packageRecord.version || !packageRecord.integrity || !packageRecord.resolved) {
      throw new Error(`[public-pages-profile] Missing locked package evidence for ${packageName}`);
    }
    const policy = PUBLIC_PACKAGES[packageName];
    const licenseAbsolute = path.join(siteRoot, policy.licensePath);
    if (!fs.existsSync(licenseAbsolute)) {
      throw new Error(`[public-pages-profile] Missing complete license text for ${packageName}`);
    }
    const ownedAssets = publicAssets.filter(asset => asset.package === packageName).map(asset => asset.path).sort();
    return {
      type: 'library',
      name: packageName,
      version: packageRecord.version,
      purl: npmPurl(packageName, packageRecord.version),
      integrity: packageRecord.integrity,
      resolved: packageRecord.resolved,
      licenseExpression: policy.spdx,
      licenseTexts: [{
        path: policy.licensePath,
        sha256: sha256File(licenseAbsolute),
        copyrightIncluded: true
      }],
      deliveredAssets: ownedAssets
    };
  });

  const componentByPackage = new Map(components.map(component => [component.name, component]));
  const assetAssessments = publicAssets.map(asset => {
    const absolute = path.join(siteRoot, asset.path);
    if (!fs.existsSync(absolute) || sha256File(absolute) !== asset.sha256) {
      throw new Error(`[public-pages-profile] Canonical vendor asset hash drift: ${asset.path}`);
    }
    return {
      path: asset.path,
      bytes: fs.statSync(absolute).size,
      sha256: asset.sha256,
      reproducible: true,
      provenanceComplete: true,
      source: 'exact file copied from the integrity-pinned npm package installed by npm ci',
      contains: [componentByPackage.get(asset.package).purl],
      gaps: []
    };
  });

  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      properties: [
        { name: 'unfallatlas:distribution-profile', value: PROFILE_ID },
        { name: 'unfallatlas:inventory-completeness', value: 'complete' }
      ]
    },
    components: [
      ...components.map(component => ({
        type: 'library',
        'bom-ref': component.purl,
        name: component.name,
        version: component.version,
        purl: component.purl,
        licenses: [{ expression: component.licenseExpression }],
        properties: [
          { name: 'unfallatlas:npm-integrity', value: component.integrity },
          { name: 'unfallatlas:resolved', value: component.resolved }
        ]
      })),
      ...assetAssessments.map(asset => ({
        type: 'file',
        'bom-ref': `urn:unfallatlas:public-vendor-asset:${asset.path}`,
        name: asset.path,
        hashes: [{ alg: 'SHA-256', content: asset.sha256 }]
      }))
    ],
    dependencies: assetAssessments.map(asset => ({
      ref: `urn:unfallatlas:public-vendor-asset:${asset.path}`,
      dependsOn: asset.contains
    })),
    compositions: [{
      aggregate: 'complete',
      assemblies: assetAssessments.map(asset => `urn:unfallatlas:public-vendor-asset:${asset.path}`)
    }]
  };
  const sbomAbsolute = path.join(siteRoot, SBOM_PATH);
  fs.mkdirSync(path.dirname(sbomAbsolute), { recursive: true });
  fs.writeFileSync(sbomAbsolute, `${JSON.stringify(sbom, null, 2)}\n`);

  const notice = {
    schemaVersion: 1,
    distributionProfile: PROFILE_ID,
    source: 'exact locked npm package files retained by the public Pages profile',
    inventoryScope: 'public-preview-core-delivered-assets',
    complete: true,
    trackingIssue: TRACKING_ISSUE,
    knownGaps: [],
    excludedPackages: EXCLUDED_PACKAGE_NAMES,
    disabledCapabilities: DISABLED_CAPABILITIES,
    dependencies: components.map(component => ({
      package: component.name,
      version: component.version,
      purl: component.purl,
      spdx: component.licenseExpression,
      integrity: component.integrity,
      resolved: component.resolved,
      evidence: 'bundled-license-text',
      licenseTextPath: component.licenseTexts[0].path,
      licenseTextSha256: component.licenseTexts[0].sha256
    })),
    components,
    assetAssessments,
    fontEvidence: [],
    sbom: {
      path: SBOM_PATH,
      sha256: sha256File(sbomAbsolute),
      specVersion: '1.6',
      complete: true
    }
  };
  const noticeAbsolute = path.join(siteRoot, NOTICE_PATH);
  fs.writeFileSync(noticeAbsolute, `${JSON.stringify(notice, null, 2)}\n`);
  return { publicAssets, notice, noticeAbsolute };
}

function updateBuildManifest(siteRoot, manifest, inventory) {
  manifest.dependencies = Object.fromEntries(
    inventory.notice.dependencies.map(dependency => [dependency.package, dependency.version])
  );
  manifest.vendorAssets = inventory.publicAssets;
  manifest.thirdPartyNotices = {
    path: NOTICE_PATH,
    sha256: sha256File(inventory.noticeAbsolute),
    complete: true,
    inventoryScope: inventory.notice.inventoryScope,
    trackingIssue: TRACKING_ISSUE,
    dependencies: inventory.notice.dependencies,
    sbom: inventory.notice.sbom,
    knownGapIds: [],
    componentCount: inventory.notice.components.length,
    assetCount: inventory.notice.assetAssessments.length,
    fontCount: 0
  };
  manifest.distribution = {
    profile: PROFILE_ID,
    publicPreview: true,
    vendorInventoryComplete: true,
    disabledCapabilities: DISABLED_CAPABILITIES,
    fullDistributionTrackingIssue: TRACKING_ISSUE
  };
  manifest.networkPolicy = Object.assign({}, manifest.networkPolicy, {
    distributionProfile: PROFILE_ID,
    disabledCapabilities: DISABLED_CAPABILITIES
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
    distribution: manifest.distribution
  })).digest('hex');
  fs.writeFileSync(path.join(siteRoot, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
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

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  removeExcludedVendorFiles(siteRoot, manifest);
  patchCanonicalHtml(siteRoot);
  for (const legacy of LEGACY_HTML) {
    fs.writeFileSync(path.join(siteRoot, legacy), redirectDocument());
  }
  const inventory = buildPublicInventory(repoRoot, siteRoot, manifest);
  updateBuildManifest(siteRoot, manifest, inventory);

  process.stdout.write(
    `[public-pages-profile] Materialized ${PROFILE_ID} with ${inventory.publicAssets.length} fully inventoried vendor assets; ` +
    `${DISABLED_CAPABILITIES.join(', ')} disabled.\n`
  );
  return {
    profile: PROFILE_ID,
    siteRoot,
    assetCount: inventory.publicAssets.length,
    disabledCapabilities: [...DISABLED_CAPABILITIES]
  };
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
  PROFILE_ID,
  PUBLIC_ASSET_PATHS,
  PUBLIC_PACKAGES,
  SBOM_PATH,
  applyPublicPagesProfile,
  fingerprintFiles,
  listFiles,
  parseArgs,
  sha256File
};
