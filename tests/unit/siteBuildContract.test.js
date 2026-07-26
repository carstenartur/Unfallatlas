'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const REPLACED_CONTRACTS = new Set([
  'full releases stay fail-closed while the reduced Pages profile declares gaps through Maven',
  'release bundles the canonical built site instead of raw repository files',
]);

const originalTest = global.test;
global.test = new Proxy(originalTest, {
  apply(target, thisArg, args) {
    if (REPLACED_CONTRACTS.has(args[0])) return undefined;
    return Reflect.apply(target, thisArg, args);
  },
});
try {
  require('./siteBuildContract.legacy.cjs');
} finally {
  global.test = originalTest;
}

describe('Maven-owned release site contract', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

  test('full releases stay fail-closed while the reduced Pages profile declares gaps through Maven', () => {
    const release = fs.readFileSync(
      path.join(ROOT, '.github/workflows/deploy-release.yml'),
      'utf8'
    );
    const dockerPublish = fs.readFileSync(
      path.join(ROOT, '.github/workflows/docker-publish.yml'),
      'utf8'
    );
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const releaseScript = packageJson.scripts['qa:release-site'];

    for (const workflow of [release, dockerPublish]) {
      expect(workflow).toContain('-Prelease-site');
      expect(workflow).not.toContain('npm run validate:vendor-provenance');
    }
    expect(pom).toContain('<id>release-site</id>');
    expect(pom).toContain('<arguments>run qa:release-site</arguments>');
    expect(releaseScript).toContain('validate:media');
    expect(releaseScript).toContain('validate:vendor-provenance -- --require-complete');
    expect(releaseScript.indexOf('validate:media'))
      .toBeLessThan(releaseScript.indexOf('validate:vendor-provenance -- --require-complete'));
    expect(dockerPublish.indexOf('-Prelease-site'))
      .toBeLessThan(dockerPublish.indexOf('docker/login-action'));
    expect(dockerPublish.indexOf('-Prelease-site'))
      .toBeLessThan(dockerPublish.indexOf('docker/build-push-action'));

    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    expect(dockerPublish).toMatch(/build-args:\s*\|\s*REQUIRE_COMPLETE_VENDOR_PROVENANCE=1/);
    expect(dockerfile).toMatch(/ARG REQUIRE_COMPLETE_VENDOR_PROVENANCE=0/);
    expect(dockerfile).toMatch(
      /1\) npm run validate:vendor-provenance -- -- --require-complete/
    );
    expect(dockerfile.indexOf('npm run build:site')).toBeLessThan(
      dockerfile.indexOf('npm run validate:vendor-provenance -- -- --require-complete')
    );

    const pagesGate = fs.readFileSync(path.join(ROOT, 'scripts/run-pages-quality-gate.cjs'), 'utf8');
    expect(pom).toContain('<id>pages</id>');
    expect(pom).toContain('<id>pages-regenerated</id>');
    expect(pom).toContain('run qa:pages:artifact');
    expect(pagesGate).toContain('validate-public-pages-profile.js');
    expect(pagesGate).not.toContain('--require-complete');
  });

  test('release bundles the canonical built site instead of raw repository files', () => {
    const release = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-release.yml'), 'utf8');
    const releaseGate = release.indexOf('-Prelease-site');
    const bundle = release.indexOf('zip -X');
    const releaseScript = packageJson.scripts['qa:release-site'];

    expect(releaseGate).toBeGreaterThan(-1);
    expect(bundle).toBeGreaterThan(releaseGate);
    expect(release).toContain('find . -type f -exec touch -t 198001010000 {} +');
    expect(releaseScript).toContain('build:site');
    expect(releaseScript).toContain('validate:vendor-provenance -- --require-complete');
    expect(releaseScript.indexOf('build:site'))
      .toBeLessThan(releaseScript.indexOf('validate:vendor-provenance -- --require-complete'));
    expect(release).toContain('LC_ALL=C sort');
    expect(release).toContain('rm -f -- "$ZIP_NAME"');
    expect(release).not.toContain('zip -r');
    expect(release).not.toContain('DIRS=(css js tours templates docs)');

    const buildSite = fs.readFileSync(path.join(ROOT, 'scripts/build-site.js'), 'utf8');
    expect(buildSite).toContain("path.join(outputRoot, 'out')");
  });
});
