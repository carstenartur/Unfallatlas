'use strict';

const fs = require('fs');
const path = require('path');

const { buildSite } = require('../../scripts/build-site');
const {
  DISABLED_CAPABILITIES,
  PROFILE_ID,
  PUBLIC_ASSET_PATHS,
  PUBLIC_PACKAGES,
  applyPublicPagesProfile,
} = require('../../scripts/build-public-pages-profile');
const { validatePublicPagesProfile } = require('../../scripts/validate-public-pages-profile');

const ROOT = path.resolve(__dirname, '../..');
const OUTPUT_RELATIVE = path.join(
  '.build',
  `public-pages-profile-test-${process.pid}-${process.env.JEST_WORKER_ID || '0'}`
);
const OUTPUT = path.join(ROOT, OUTPUT_RELATIVE);

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(OUTPUT, relative), 'utf8'));
}

function writeJson(relative, value) {
  fs.writeFileSync(path.join(OUTPUT, relative), `${JSON.stringify(value, null, 2)}\n`);
}

function workflowJobs(source) {
  const buildStart = source.indexOf('  build:');
  const deployStart = source.indexOf('  deploy:');
  expect(buildStart).toBeGreaterThan(-1);
  expect(deployStart).toBeGreaterThan(buildStart);
  return {
    build: source.slice(buildStart, deployStart),
    deploy: source.slice(deployStart),
  };
}

jest.setTimeout(180000);

describe('public Pages distribution profile', () => {
  beforeAll(() => {
    fs.rmSync(OUTPUT, { recursive: true, force: true });
    buildSite({
      root: ROOT,
      inputDir: 'out',
      poiDir: 'out',
      outputDir: OUTPUT_RELATIVE,
    });
    applyPublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE });
  });

  afterAll(() => {
    fs.rmSync(OUTPUT, { recursive: true, force: true });
  });

  test('publishes every browser-side capability while declaring hardening gaps honestly', () => {
    const result = validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE });
    expect(result).toMatchObject({
      profile: PROFILE_ID,
      assetCount: PUBLIC_ASSET_PATHS.length,
      packageCount: Object.keys(PUBLIC_PACKAGES).length,
    });
    expect(result.knownGapCount).toBeGreaterThan(0);

    const manifest = readJson('build-manifest.json');
    expect(manifest.distribution).toMatchObject({
      profile: PROFILE_ID,
      publicPreview: true,
      vendorInventoryComplete: false,
      complianceMode: 'declared-known-provenance-gaps',
      provenanceGapsBlockCapabilities: false,
      knownLicenseRestrictions: [],
      knownLicenseConflicts: [],
    });
    expect(DISABLED_CAPABILITIES).toEqual(['video-export']);
    expect(manifest.distribution.disabledCapabilities).toEqual(['video-export']);
    expect(manifest.networkPolicy.disabledCapabilities).toEqual(['video-export']);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(Object.keys(PUBLIC_PACKAGES).sort());
    expect(manifest.vendorAssets.map(asset => asset.path).sort()).toEqual([...PUBLIC_ASSET_PATHS].sort());

    const notice = readJson('vendor/third-party-notices.json');
    expect(notice.complete).toBe(false);
    expect(notice.knownGaps.length).toBeGreaterThan(0);
    expect(notice.provenanceGapsBlockCapabilities).toBe(false);
    expect(notice.knownLicenseRestrictions).toEqual([]);
    expect(notice.disabledCapabilities).toEqual(['video-export']);
    expect(notice.excludedPackages).toEqual([]);
    expect(notice.supplementalLicenses).toEqual(expect.arrayContaining([
      expect.objectContaining({ component: 'simpleheat@0.2.0', spdx: 'BSD-2-Clause' }),
    ]));

    for (const relative of PUBLIC_ASSET_PATHS) {
      expect(fs.existsSync(path.join(OUTPUT, relative))).toBe(true);
    }
    const canonical = fs.readFileSync(path.join(OUTPUT, 'werkbank_v2.html'), 'utf8');
    expect(canonical).toContain(`content="${PROFILE_ID}"`);
    expect(canonical).toContain('js/ua.public-preview.js');
    expect(canonical).toContain('vendor/leaflet.heat/leaflet-heat.js');
    expect(canonical).toContain('vendor/leaflet-draw/leaflet.draw.js');
    expect(canonical).toContain('vendor/leaflet-image/leaflet-image.js');

    const publicRuntime = fs.readFileSync(path.join(OUTPUT, 'js', 'ua.public-preview.js'), 'utf8');
    expect(publicRuntime).toContain("'video-export'");
    expect(publicRuntime).not.toContain('UA.ensureExportLibraries =');
    expect(publicRuntime).not.toContain("hideElement(document.getElementById('exportGroupAntrag'))");
    expect(publicRuntime).toContain('eine bekannte Lizenzbeschränkung');

    const index = fs.readFileSync(path.join(OUTPUT, 'index.html'), 'utf8');
    expect(index).toContain('werkbank_v2.html');
    expect(index).not.toContain('vendor/');
  });

  test('rejects delivered asset hash drift', () => {
    const relative = PUBLIC_ASSET_PATHS[0];
    const absolute = path.join(OUTPUT, relative);
    const original = fs.readFileSync(absolute);
    fs.appendFileSync(absolute, '\nmutated');
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/vendor asset hash drift/);
    } finally {
      fs.writeFileSync(absolute, original);
    }
  });

  test('rejects an undeclared or hidden provenance gap', () => {
    const noticePath = 'vendor/third-party-notices.json';
    const notice = readJson(noticePath);
    const original = JSON.stringify(notice, null, 2) + '\n';
    notice.knownGaps.pop();
    writeJson(noticePath, notice);
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/declared provenance gaps mismatch/);
    } finally {
      fs.writeFileSync(path.join(OUTPUT, noticePath), original);
    }
  });

  test('rejects a claimed license restriction without evidence', () => {
    const noticePath = 'vendor/third-party-notices.json';
    const notice = readJson(noticePath);
    const original = JSON.stringify(notice, null, 2) + '\n';
    notice.knownLicenseRestrictions.push('fabricated restriction');
    writeJson(noticePath, notice);
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/unknown license restrictions/);
    } finally {
      fs.writeFileSync(path.join(OUTPUT, noticePath), original);
    }
  });

  test('rejects missing mandatory direct-package, supplemental or font license texts', () => {
    const notice = readJson('vendor/third-party-notices.json');
    const directLicense = path.join(OUTPUT, notice.dependencies[0].licenseTextPath);
    const supplementalLicense = path.join(OUTPUT, notice.supplementalLicenses[0].path);
    const fontLicense = path.join(OUTPUT, notice.fontEvidence[0].licenseTexts[0].path);
    const directBytes = fs.readFileSync(directLicense);
    const supplementalBytes = fs.readFileSync(supplementalLicense);
    const fontBytes = fs.readFileSync(fontLicense);
    try {
      fs.rmSync(directLicense);
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/missing license text/);
      fs.writeFileSync(directLicense, directBytes);
      fs.rmSync(supplementalLicense);
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/missing supplemental license text/);
      fs.writeFileSync(supplementalLicense, supplementalBytes);
      fs.rmSync(fontLicense);
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/missing font license text/);
    } finally {
      fs.writeFileSync(directLicense, directBytes);
      fs.writeFileSync(supplementalLicense, supplementalBytes);
      fs.writeFileSync(fontLicense, fontBytes);
    }
  });

  test('rejects undeclared vendor references in the canonical page', () => {
    const canonicalPath = path.join(OUTPUT, 'werkbank_v2.html');
    const original = fs.readFileSync(canonicalPath, 'utf8');
    fs.writeFileSync(canonicalPath, original.replace('</body>',
      '  <script src="vendor/undeclared/rogue.js"></script>\n</body>'));
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/references undeclared vendor asset/);
    } finally {
      fs.writeFileSync(canonicalPath, original);
    }
  });

  test('rejects manifest hashes that are not rebound after notice mutation', () => {
    const noticePath = path.join(OUTPUT, 'vendor', 'third-party-notices.json');
    const original = fs.readFileSync(noticePath);
    const notice = JSON.parse(original);
    notice.source += ' mutated';
    fs.writeFileSync(noticePath, `${JSON.stringify(notice, null, 2)}\n`);
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/notice hash drift/);
    } finally {
      fs.writeFileSync(noticePath, original);
    }
  });

  test('keeps Pages pragmatic while full release provenance remains a separate gate', () => {
    const generatedPages = fs.readFileSync(
      path.join(ROOT, '.github/workflows/generate-data-deploy-pages.yml'),
      'utf8'
    );
    const currentPages = fs.readFileSync(
      path.join(ROOT, '.github/workflows/deploy-pages-current-data.yml'),
      'utf8'
    );
    const release = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-release.yml'), 'utf8');
    const docker = fs.readFileSync(path.join(ROOT, '.github/workflows/docker-publish.yml'), 'utf8');

    for (const pages of [generatedPages, currentPages]) {
      const jobs = workflowJobs(pages);
      expect(pages).toContain('npm run build:pages-profile -- --site _site');
      expect(pages).toContain('npm run validate:pages-profile -- --site _site');
      expect(pages).toContain('npx playwright test tests/e2e/smoke.spec.js --project=chromium');
      expect(jobs.build).toMatch(/permissions:\s*\n\s*contents: read/);
      expect(jobs.build).toContain('persist-credentials: false');
      expect(jobs.build).not.toContain('pages: write');
      expect(jobs.build).not.toContain('id-token: write');
      expect(jobs.deploy).toContain('pages: write');
      expect(jobs.deploy).toContain('id-token: write');
      expect(jobs.deploy).toContain('Pin Pages source to GitHub Actions');
      expect(jobs.deploy).toContain('build_type=workflow');
      expect(jobs.deploy).toContain('vendor/leaflet.heat/leaflet-heat.js');
      expect(jobs.deploy).toContain('vendor/leaflet-draw/leaflet.draw.js');
      expect(jobs.deploy).toContain('vendor/export/docx.js');
      expect(jobs.deploy).toContain('vendor/export/pdfmake.js');
    }

    expect(currentPages).not.toContain('validate:vendor-provenance -- --require-complete');
    expect(generatedPages).toContain('validate:vendor-provenance -- --require-complete');
    expect(release).toContain('npm run validate:vendor-provenance -- --require-complete');
    expect(docker).toContain('npm run validate:vendor-provenance -- --require-complete');
    expect(docker).toContain('REQUIRE_COMPLETE_VENDOR_PROVENANCE=1');
  });
});
