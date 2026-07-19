'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  STATIC_ENTRIES,
  VENDOR_ASSETS,
  VENDOR_LICENSES,
  assertSymlinkFreeTree,
  assertLocalAssetReferences,
  copyEntry,
  copyVendorLicenses,
  installBuiltSite,
  resolveActualPackageManager,
  resolveLockedVersions,
  validateBuildPaths,
} = require('../../scripts/build-site');
const { validateVendorProvenance } = require('../../scripts/validate-vendor-provenance');

const ROOT = path.resolve(__dirname, '../..');

describe('canonical site build contract', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const browserPackages = [
    'leaflet', 'leaflet-draw', 'leaflet-image', 'leaflet.heat', 'leaflet.markercluster',
    'docx', 'pdfmake', 'file-saver',
  ];

  test('all browser dependencies are exact and resolve to the lockfile version', () => {
    const locked = resolveLockedVersions(ROOT);
    for (const packageName of browserPackages) {
      expect(packageJson.dependencies[packageName]).toMatch(/^\d+\.\d+\.\d+(?:[-+].+)?$/);
      expect(locked[packageName]).toBe(packageJson.dependencies[packageName]);
    }
  });

  test('the Node/npm toolchain contract is pinned in package and lock metadata', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
    expect(packageJson.packageManager).toMatch(/^npm@\d+\.\d+\.\d+$/);
    expect(packageJson.engines).toEqual({ node: '24.x', npm: '>=11 <12' });
    expect(lock.packages[''].engines).toEqual(packageJson.engines);
    expect(resolveActualPackageManager()).toMatch(/^npm@\d+\.\d+\.\d+/);
  });

  test('every declared vendor input exists after npm ci', () => {
    for (const [packageName, packagePath] of VENDOR_ASSETS) {
      expect(fs.existsSync(path.join(ROOT, 'node_modules', packageName, packagePath))).toBe(true);
    }
  });

  test('runtime assets are local, present and cannot escape the site artifact', () => {
    const destinations = new Set(VENDOR_ASSETS.map(([, , destination]) => destination));
    expect(destinations).toContain('vendor/leaflet-draw/images/spritesheet.svg');
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-site-assets-'));
    try {
      fs.mkdirSync(path.join(fixture, 'css'), { recursive: true });
      fs.mkdirSync(path.join(fixture, 'images'), { recursive: true });
      fs.writeFileSync(path.join(fixture, 'css/app.css'), 'button{background:url(../images/icon.svg)}');
      fs.writeFileSync(path.join(fixture, 'images/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      fs.writeFileSync(path.join(fixture, 'index.html'), '<link rel="stylesheet" href="css/app.css">');
      expect(() => assertLocalAssetReferences(fixture)).not.toThrow();

      fs.rmSync(path.join(fixture, 'images/icon.svg'));
      expect(() => assertLocalAssetReferences(fixture)).toThrow(/Missing or escaping local CSS asset/);

      fs.writeFileSync(path.join(fixture, 'images/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
      fs.writeFileSync(path.join(fixture, 'css/app.css'), 'a{background:url(https://cdn.example/icon.svg)}');
      expect(() => assertLocalAssetReferences(fixture)).toThrow(/External runtime CSS dependency/);

      fs.writeFileSync(path.join(fixture, 'css/app.css'), '@import "https://cdn.example/theme.css";');
      expect(() => assertLocalAssetReferences(fixture)).toThrow(/External runtime stylesheet import/);

      fs.writeFileSync(path.join(fixture, 'css/app.css'), 'button{color:inherit}');
      fs.writeFileSync(
        path.join(fixture, 'index.html'),
        '<link rel="stylesheet" href="https://cdn.example/app.css"><script src="//cdn.example/app.js"></script>'
      );
      expect(() => assertLocalAssetReferences(fixture)).toThrow(/External runtime stylesheet dependency/);
      expect(() => assertLocalAssetReferences(fixture)).toThrow(/External runtime script dependency/);
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
    expect(() => assertLocalAssetReferences(path.join(os.tmpdir(), 'missing-ua-site-output')))
      .toThrow(/does not exist/);
  });

  test('site output is confined to _site or an isolated .build child and cannot overlap inputs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-site-paths-'));
    try {
      for (const directory of ['out', 'data', 'docs', '.build']) {
        fs.mkdirSync(path.join(root, directory), { recursive: true });
      }
      expect(() => validateBuildPaths(
        root,
        path.join(root, '_site'),
        path.join(root, 'out'),
        path.join(root, 'out')
      )).not.toThrow();
      expect(() => validateBuildPaths(
        root,
        path.join(root, '.build', 'context-e2e', 'site'),
        path.join(root, '.build', 'context-e2e', 'generated'),
        path.join(root, 'out')
      )).not.toThrow();

      for (const unsafeOutput of ['out', 'docs', 'data', '.build']) {
        expect(() => validateBuildPaths(
          root,
          path.join(root, unsafeOutput),
          path.join(root, 'out'),
          path.join(root, 'out')
        )).toThrow(/Output must be|overlaps/);
      }
      expect(() => validateBuildPaths(
        root,
        path.join(root, '.build', 'shared'),
        path.join(root, '.build', 'shared', 'input'),
        path.join(root, 'out')
      )).toThrow(/overlaps input directory/);

      const symlink = path.join(root, '.build', 'linked');
      fs.symlinkSync(path.join(root, 'docs'), symlink, 'dir');
      expect(() => validateBuildPaths(
        root,
        path.join(symlink, 'site'),
        path.join(root, 'out'),
        path.join(root, 'out')
      )).toThrow(/Refusing symlinked output directory/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('static sources, copies and build inventories reject nested symbolic links', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-site-symlink-tree-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'destination');
    const external = path.join(root, 'external.txt');
    try {
      fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
      fs.writeFileSync(path.join(source, 'regular.txt'), 'safe');
      fs.writeFileSync(external, 'must not be copied');
      fs.symlinkSync(external, path.join(source, 'nested', 'escape.txt'), 'file');

      expect(() => assertSymlinkFreeTree(source, 'fixture source')).toThrow(/symbolic link/);
      expect(() => copyEntry(source, destination)).toThrow(/symbolic link/);
      expect(fs.existsSync(path.join(destination, 'nested', 'escape.txt'))).toBe(false);

      fs.rmSync(path.join(source, 'nested', 'escape.txt'));
      fs.writeFileSync(path.join(source, 'nested', 'safe.txt'), 'safe');
      expect(() => assertSymlinkFreeTree(source, 'fixture source')).not.toThrow();
      expect(() => copyEntry(source, destination)).not.toThrow();
      expect(fs.readFileSync(path.join(destination, 'nested', 'safe.txt'), 'utf8')).toBe('safe');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('failed site installation restores the last known-good build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-site-swap-'));
    const finalOutput = path.join(root, '_site');
    const staging = path.join(root, '_site.tmp-test');
    try {
      fs.mkdirSync(finalOutput);
      fs.mkdirSync(staging);
      fs.writeFileSync(path.join(finalOutput, 'version.txt'), 'known-good');
      fs.writeFileSync(path.join(staging, 'version.txt'), 'candidate');

      expect(() => installBuiltSite(staging, finalOutput, {
        renameSync(source, destination) {
          if (source === staging && destination === finalOutput) {
            throw new Error('simulated install failure');
          }
          fs.renameSync(source, destination);
        },
      })).toThrow(/simulated install failure/);
      expect(fs.readFileSync(path.join(finalOutput, 'version.txt'), 'utf8')).toBe('known-good');
      expect(fs.readdirSync(root).filter(name => name.includes('.previous-'))).toEqual([]);

      installBuiltSite(staging, finalOutput);
      expect(fs.readFileSync(path.join(finalOutput, 'version.txt'), 'utf8')).toBe('candidate');
      expect(fs.readdirSync(root).filter(name => name.includes('.previous-'))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('vendor notice reports its top-level scope honestly and blocks release while incomplete', () => {
    expect(Object.keys(VENDOR_LICENSES).sort()).toEqual(browserPackages.sort());
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-site-licenses-'));
    try {
      const notices = copyVendorLicenses(ROOT, fixture);
      expect(notices.dependencies).toHaveLength(browserPackages.length);
      expect(notices.complete).toBe(false);
      expect(notices.inventoryScope).toBe('direct-npm-packages-only');
      expect(notices.trackingIssue).toContain('/issues/406');
      expect(fs.existsSync(path.join(fixture, notices.path))).toBe(true);
      expect(notices.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(() => validateVendorProvenance(path.join(fixture, notices.path)))
        .not.toThrow();
      expect(() => validateVendorProvenance(path.join(fixture, notices.path), { requireComplete: true }))
        .toThrow(/Release\/deployment blocked/);

      for (const dependency of notices.dependencies) {
        expect(dependency.version).toBe(packageJson.dependencies[dependency.package]);
        expect(dependency.spdx).toMatch(/^(?:MIT|BSD-2-Clause)$/);
        if (dependency.evidence === 'bundled-license-text') {
          expect(dependency.licenseTextPath).toMatch(/^vendor\/licenses\/.+\.txt$/);
          expect(fs.statSync(path.join(fixture, dependency.licenseTextPath)).size).toBeGreaterThan(100);
          expect(dependency.licenseTextSha256).toMatch(/^[a-f0-9]{64}$/);
        } else {
          expect(dependency.evidence).toBe('installed-package-metadata');
          expect(dependency.licenseTextPath).toBeNull();
        }
      }
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true });
    }
  });

  test.each(['index.html', 'combi.html', 'werkbank.html', 'unfallwerkbank.html', 'werkbank_v2.html'])(
    '%s uses local vendor assets and no runtime package CDN',
    htmlFile => {
      const html = fs.readFileSync(path.join(ROOT, htmlFile), 'utf8');
      expect(html).toContain('vendor/leaflet/leaflet.js');
      expect(html).not.toMatch(/(?:unpkg\.com|cdn\.jsdelivr\.net)\//);
    }
  );

  test('lazy export libraries are loaded from the built vendor directory', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js/ua.report_v2.js'), 'utf8');
    for (const asset of ['docx.js', 'pdfmake.js', 'pdfmake-fonts.js', 'file-saver.js']) {
      expect(source).toContain(`vendor/export/${asset}`);
    }
    expect(source).not.toMatch(/(?:unpkg\.com|cdn\.jsdelivr\.net)\//);
  });

  test('Pages and Playwright execute the same build command', () => {
    const pages = fs.readFileSync(path.join(ROOT, '.github/workflows/generate-data-deploy-pages.yml'), 'utf8');
    const playwright = fs.readFileSync(path.join(ROOT, 'playwright.config.js'), 'utf8');
    expect(pages).toContain('npm run build:site');
    expect(pages).toContain('npm run validate:media -- --report out/qa/pages-documentation-media.json');
    expect(pages).toContain('npm run validate:vendor-provenance -- --require-complete');
    expect(pages).toContain('pages-documentation-media-report');
    expect(playwright).toContain("command: 'npm run serve:site'");
  });

  test('release bundles the canonical built site instead of raw repository files', () => {
    const release = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-release.yml'), 'utf8');
    const build = release.indexOf('npm run build:site');
    const bundle = release.indexOf('zip -X');
    expect(build).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(build);
    expect(release).toContain('find . -type f -exec touch -t 198001010000 {} +');
    expect(release).toContain('npm run validate:vendor-provenance -- --require-complete');
    expect(release).toContain('LC_ALL=C sort');
    expect(release).toContain('rm -f -- "$ZIP_NAME"');
    expect(release).not.toContain('zip -r');
    expect(release).not.toContain('DIRS=(css js tours templates docs)');
    expect(STATIC_ENTRIES).not.toContain('out');
    expect(fs.readFileSync(path.join(ROOT, 'scripts/build-site.js'), 'utf8'))
      .toContain("path.join(outputRoot, 'out')");
  });

  test('container integration always builds the exact checked-out Docker context', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
    expect(workflow).toContain('npm run test:integration:tc');
    expect(workflow).not.toContain('use_prebuilt');
    expect(workflow).not.toContain('ghcr.io/carstenartur/unfallatlas:latest');
    expect(workflow).not.toContain('UNFALLATLAS_IMAGE:');
  });
});
