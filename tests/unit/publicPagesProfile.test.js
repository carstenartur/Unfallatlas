'use strict';

const fs = require('fs');
const path = require('path');

const { buildSite } = require('../../scripts/build-site');
const {
  DISABLED_CAPABILITIES,
  EXCLUDED_VENDOR_ROOTS,
  PROFILE_ID,
  PUBLIC_ASSET_PATHS,
  applyPublicPagesProfile
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
    deploy: source.slice(deployStart)
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
      outputDir: OUTPUT_RELATIVE
    });
    applyPublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE });
  });

  afterAll(() => {
    fs.rmSync(OUTPUT, { recursive: true, force: true });
  });

  test('materializes and validates a complete reduced artifact from a normal checkout', () => {
    const result = validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE });
    expect(result).toMatchObject({
      profile: PROFILE_ID,
      assetCount: PUBLIC_ASSET_PATHS.length,
      packageCount: 2
    });

    const manifest = readJson('build-manifest.json');
    expect(manifest.distribution).toMatchObject({
      profile: PROFILE_ID,
      publicPreview: true,
      vendorInventoryComplete: true
    });
    expect(manifest.distribution.disabledCapabilities.sort()).toEqual([...DISABLED_CAPABILITIES].sort());
    expect(Object.keys(manifest.dependencies).sort()).toEqual(['leaflet', 'leaflet.markercluster']);
    expect(manifest.vendorAssets.map(asset => asset.path).sort()).toEqual([...PUBLIC_ASSET_PATHS].sort());

    for (const excluded of EXCLUDED_VENDOR_ROOTS) {
      expect(fs.existsSync(path.join(OUTPUT, excluded))).toBe(false);
    }
    const canonical = fs.readFileSync(path.join(OUTPUT, 'werkbank_v2.html'), 'utf8');
    expect(canonical).toContain(`content="${PROFILE_ID}"`);
    expect(canonical).toContain('js/ua.public-preview.js');
    expect(canonical).not.toMatch(/vendor\/(?:export|leaflet\.heat|leaflet-draw|leaflet-image)\//);
    const index = fs.readFileSync(path.join(OUTPUT, 'index.html'), 'utf8');
    expect(index).toContain('werkbank_v2.html');
    expect(index).not.toContain('vendor/');
  });

  test('rejects an excluded bundle reintroduced after profile generation', () => {
    const rogue = path.join(OUTPUT, 'vendor', 'export', 'rogue.js');
    fs.mkdirSync(path.dirname(rogue), { recursive: true });
    fs.writeFileSync(rogue, 'window.rogue = true;\n');
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/excluded vendor tree is still delivered/);
    } finally {
      fs.rmSync(path.join(OUTPUT, 'vendor', 'export'), { recursive: true, force: true });
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

  test('rejects a forged complete notice with a hidden gap', () => {
    const noticePath = 'vendor/third-party-notices.json';
    const notice = readJson(noticePath);
    const original = JSON.stringify(notice, null, 2) + '\n';
    notice.knownGaps.push({ id: 'forged-gap' });
    writeJson(noticePath, notice);
    try {
      expect(() => validatePublicPagesProfile({ root: ROOT, site: OUTPUT_RELATIVE }))
        .toThrow(/public notice contains unresolved gaps/);
    } finally {
      fs.writeFileSync(path.join(OUTPUT, noticePath), original);
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

  test('keeps build jobs read-only and full releases blocked', () => {
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
      expect(jobs.build).not.toContain('actions/configure-pages');
      expect(jobs.build.indexOf('validate:pages-profile'))
        .toBeLessThan(jobs.build.indexOf('Smoke-test the exact'));
      expect(jobs.build.indexOf('Smoke-test the exact'))
        .toBeLessThan(jobs.build.indexOf('actions/upload-pages-artifact'));
      expect(jobs.deploy).toContain('pages: write');
      expect(jobs.deploy).toContain('id-token: write');
      expect(jobs.deploy.indexOf('actions/configure-pages'))
        .toBeLessThan(jobs.deploy.indexOf('actions/deploy-pages'));
    }

    expect(currentPages).toMatch(/pull_request:\s*\n\s*branches: \[main\]/);
    expect(currentPages).toMatch(/push:\s*\n\s*branches: \[main\]/);
    expect(currentPages).not.toContain('validate:vendor-provenance -- --require-complete');

    expect(generatedPages).toMatch(
      /Full-distribution provenance gate is not applicable[\s\S]*if: \$\{\{ false \}\}[\s\S]*validate:vendor-provenance -- --require-complete/
    );
    expect(release).toContain('npm run validate:vendor-provenance -- --require-complete');
    expect(docker).toContain('npm run validate:vendor-provenance -- --require-complete');
    expect(docker).toContain('REQUIRE_COMPLETE_VENDOR_PROVENANCE=1');
  });
});
