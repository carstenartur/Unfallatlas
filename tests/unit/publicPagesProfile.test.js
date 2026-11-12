'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

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
const HEAT_ASSET = 'vendor/leaflet.heat/leaflet-heat.js';
const PDF_ASSET = 'vendor/export/pdfmake.js';
const SVG_REF = 'urn:unfallatlas:vendor-source:pdfmake:svg-to-pdfkit';
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

  test('hides the server-only priorities action and omits its client in the public page', () => {
    const html = fs.readFileSync(path.join(OUTPUT, 'werkbank_v2.html'), 'utf8');
    const page = new DOMParser().parseFromString(html, 'text/html');
    const opener = page.getElementById('btnPrioritiesOpen');
    expect(opener.closest('[hidden]')).not.toBeNull();
    expect(page.querySelector('script[src^="js/ua.priorities.js"]')).toBeNull();
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
    expect(DISABLED_CAPABILITIES).toEqual(['priorities', 'video-export']);
    expect(manifest.distribution.disabledCapabilities).toEqual(DISABLED_CAPABILITIES);
    expect(manifest.networkPolicy.disabledCapabilities).toEqual(DISABLED_CAPABILITIES);
    expect(Object.keys(manifest.dependencies).sort()).toEqual(Object.keys(PUBLIC_PACKAGES).sort());
    expect(manifest.vendorAssets.map(asset => asset.path).sort()).toEqual([...PUBLIC_ASSET_PATHS].sort());

    const notice = readJson('vendor/third-party-notices.json');
    expect(notice.complete).toBe(false);
    expect(notice.knownGaps.length).toBeGreaterThan(0);
    expect(notice.provenanceGapsBlockCapabilities).toBe(false);
    expect(notice.knownLicenseRestrictions).toEqual([]);
    expect(notice.disabledCapabilities).toEqual(DISABLED_CAPABILITIES);
    expect(notice.excludedPackages).toEqual([]);
    for (const relative of PUBLIC_ASSET_PATHS) {
      expect(fs.existsSync(path.join(OUTPUT, relative))).toBe(true);
    }
    const canonical = fs.readFileSync(path.join(OUTPUT, 'werkbank_v2.html'), 'utf8');
    expect(canonical).toContain(`content="${PROFILE_ID}"`);
    expect(canonical).toContain('js/ua.public-preview.js');
    expect(canonical).toContain(HEAT_ASSET);
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

  test('loads the delivered heatmap as a classic Leaflet script', () => {
    try {
      window.eval(fs.readFileSync(path.join(OUTPUT, 'vendor/leaflet/leaflet.js'), 'utf8'));
      window.eval(fs.readFileSync(path.join(OUTPUT, HEAT_ASSET), 'utf8'));
      const { L } = window;
      expect(L.heatLayer([[50.7, 7.1, 0.5]])).toBeInstanceOf(L.HeatLayer);
    } finally {
      delete window.L;
    }
  });

  test('publishes the original license of the SVG-to-PDFKit fork embedded in the PDF export', () => {
    const notice = readJson('vendor/third-party-notices.json');
    const source = path.join(ROOT, 'node_modules/pdfmake/src/3rd-party/svg-to-pdfkit');
    const license = notice.supplementalLicenses.find(item => item.component === 'svg-to-pdfkit');
    expect(license).toMatchObject({ spdx: 'MIT', asset: 'vendor/export/pdfmake.js' });
    expect(fs.readFileSync(path.join(OUTPUT, license.path))).toEqual(fs.readFileSync(path.join(source, 'LICENSE')));
    const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'source.js'))).digest('hex');
    expect(license.sourceSha256).toBe(digest);
    expect(license.ref).toBe(SVG_REF);
    expect(notice.assetAssessments.find(asset => asset.path === PDF_ASSET).containsFiles).toEqual([SVG_REF]);
    const sbom = readJson('vendor/sbom.cdx.json');
    expect(sbom.components.find(component => component['bom-ref'] === SVG_REF)).toMatchObject({
      name: license.sourcePath,
      hashes: [{ alg: 'SHA-256', content: digest }],
      licenses: [{ expression: 'MIT' }],
    });
    expect(sbom.dependencies.find(item => item.ref === `urn:unfallatlas:vendor-asset:${PDF_ASSET}`).dependsOn)
      .toContain(SVG_REF);
  });

  test('links PDF source-map modules to the exact upstream build packages and archives their licenses', () => {
    const notice = readJson('vendor/third-party-notices.json');
    const pdf = notice.assetAssessments.find(asset => asset.path === 'vendor/export/pdfmake.js');
    expect(pdf).toMatchObject({ reproducible: true, provenanceComplete: false, reproductionMethod: 'bash scripts/verify-pdfmake-upstream.sh' });
    const expected = ['base64-js@0.0.8', 'base64-js@1.5.1', 'buffer@6.0.3', 'core-js@3.51.0', 'sax@1.6.1'];
    expect(pdf.contains).toEqual(expect.arrayContaining(expected.map(name => 'pkg:npm/' + name)));
    expect(pdf.contains).not.toContain('pkg:npm/base64-js@1.3.1');
    expect(pdf.contains).not.toContain('pkg:npm/sax@1.6.0');
    const sax = notice.components.find(item => item.purl === 'pkg:npm/sax@1.6.1');
    expect(sax.attestation.lockFile).toBe('vendor/pdfmake-build/npm-lock.json');
    const xml = notice.components.find(component => component.purl === 'pkg:npm/xmldoc@2.0.3');
    expect(xml.attestation.lockFile).toBe('vendor/pdfmake-build/npm-lock.json');
    expect(xml.licenseExpression).toBe('MIT');
    expect(pdf.contains).toContain(xml.purl);
    expect(pdf.unresolvedDetectedComponents).not.toContain('webpack://pdfmake/../xmldoc.ts');
    expect(sax.licenseExpression).toBe('BlueOak-1.0.0');
    expect(fs.readFileSync(path.join(OUTPUT, sax.licenseTexts[0].path))).toEqual(
      fs.readFileSync(path.join(ROOT, 'vendor/pdfmake-build/licenses/sax-1.6.1.txt'))
    );
  });

  test('binds the embedded Simpleheat version and license to the heatmap and SBOM', () => {
    const purl = 'pkg:npm/simpleheat@1.0.0';
    const notice = readJson('vendor/third-party-notices.json');
    const embedded = notice.components.find(component => component.purl === purl);
    const locked = require('../../package-lock.json').packages['node_modules/simpleheat'];
    expect(embedded).toMatchObject({ integrity: locked.integrity, licenseExpression: 'BSD-2-Clause' });
    const license = notice.supplementalLicenses.find(entry => entry.component === 'simpleheat@1.0.0');
    expect(license).toMatchObject({ spdx: 'BSD-2-Clause', copyrightIncluded: true });
    expect(fs.readFileSync(path.join(OUTPUT, license.path))).toEqual(
      fs.readFileSync(path.join(ROOT, 'node_modules/simpleheat/LICENSE'))
    );
    const assessment = notice.assetAssessments.find(asset => asset.path === HEAT_ASSET);
    expect(assessment.contains).toContain(purl);
    expect(assessment.unresolvedDetectedComponents).toEqual([]);
    expect(assessment.provenanceComplete).toBe(false);
    const sbom = readJson('vendor/sbom.cdx.json');
    expect(sbom.dependencies.find(entry => entry.ref === `urn:unfallatlas:vendor-asset:${HEAT_ASSET}`)
      .dependsOn).toContain(purl);
  });

  test('rejects a heatmap notice missing its locked Simpleheat component relationship', () => {
    const noticePath = 'vendor/third-party-notices.json';
    const notice = readJson(noticePath);
    const original = JSON.stringify(notice, null, 2) + '\n';
    const assessment = notice.assetAssessments.find(asset => asset.path === HEAT_ASSET);
    assessment.contains = assessment.contains.filter(purl => !purl.startsWith('pkg:npm/simpleheat@'));
    writeJson(noticePath, notice);
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/heatmap lacks its locked simpleheat component/);
    } finally {
      fs.writeFileSync(path.join(OUTPUT, noticePath), original);
    }
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

  test('rejects an upstream font release path that names another variant', () => {
    const file = 'vendor/third-party-notices.json';
    const original = fs.readFileSync(path.join(OUTPUT, file));
    const notice = JSON.parse(original);
    notice.fontEvidence[0].upstreamRelease.path = 'android/static/' + notice.fontEvidence[0].name;
    writeJson(file, notice);
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/original Roboto release evidence drift/);
    } finally {
      fs.writeFileSync(path.join(OUTPUT, file), original);
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

  test('keeps all Pages build and QA logic in Maven instead of Actions', () => {
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
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

    expect(pom).toContain('<id>pages</id>');
    expect(pom).toContain('<id>pages-regenerated</id>');
    expect(pom).toContain('run qa:pages:artifact');
    expect(pom).toContain('run generate:pages-data');
    expect(pom).toContain('<module>analysis-service</module>');

    const workflows = [currentPages, generatedPages];
    for (const pages of workflows) {
      const jobs = workflowJobs(pages);
      expect(pages).toMatch(/mvn -B -ntp clean verify -Ppages(?:-regenerated)?/);
      expect(pages).not.toContain('npm ci');
      expect(pages).not.toContain('npm run build:site');
      expect(pages).not.toContain('npx playwright');
      expect(pages).not.toContain('node scripts/');
      expect(jobs.build).toMatch(/permissions:\s*\n\s*contents: read/);
      expect(jobs.build).toContain('persist-credentials: false');
      expect(jobs.build).not.toContain('pages: write');
      expect(jobs.build).not.toContain('id-token: write');
      expect(jobs.deploy).toContain('pages: write');
      expect(jobs.deploy).toContain('id-token: write');
      expect(jobs.deploy).not.toContain('Pin Pages source to GitHub Actions');
      expect(jobs.deploy).not.toContain('build_type=workflow');
      expect(jobs.deploy).toContain('Deploy Maven-verified artifact');
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(currentPages).not.toContain('validate:vendor-provenance');
    expect(release).toContain('-Prelease-site');
    expect(docker).toContain('-Prelease-site');
    expect(release).not.toContain('npm run validate:vendor-provenance');
    expect(docker).not.toContain('npm run validate:vendor-provenance');
    expect(packageJson.scripts['qa:release-site'])
      .toContain('validate:vendor-provenance');
    expect(docker).toContain('REQUIRE_COMPLETE_VENDOR_PROVENANCE=1');
  });
});
