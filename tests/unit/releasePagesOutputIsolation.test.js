/** @jest-environment node */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { JSDOM } = require('jsdom');
const { validate } = require('../../scripts/validate-screenshot-evidence');
const { validateBuildPaths } = require('../../scripts/build-site');

const ROOT = path.resolve(__dirname, '../..');
const gatePath = path.join(ROOT, 'scripts/run-pages-quality-gate.cjs');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function pagesOutputFor(activeProfiles) {
  const document = new JSDOM(fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8'), {
    contentType: 'text/xml',
  }).window.document;
  const project = document.documentElement;
  const properties = {};
  const readProperties = element => {
    const node = [...element.children].find(child => child.localName === 'properties');
    for (const property of node?.children || []) properties[property.localName] = property.textContent.trim();
  };
  readProperties(project);
  const profiles = [...project.children].find(child => child.localName === 'profiles');
  for (const profile of profiles.children) {
    const id = [...profile.children].find(child => child.localName === 'id')?.textContent.trim();
    if (activeProfiles.includes(id)) readProperties(profile);
  }
  return properties['pages.outputDir'];
}

function writeJson(root, relative, value) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function prepareEvidence(root) {
  const imagePath = 'docs/screenshots/01-startansicht.png';
  const image = fs.readFileSync(path.join(ROOT, 'docs/screenshots/15-export-pdf-rendered.png'));
  fs.mkdirSync(path.join(root, 'docs/screenshots'), { recursive: true });
  fs.writeFileSync(path.join(root, imagePath), image);
  writeJson(root, 'docs/media-manifest.json', { schemaVersion: 1, assets: [{ path: imagePath, kind: 'screenshot' }] });
  const manifest = { schemaVersion: 1, fingerprint: 'a'.repeat(64),
    application: { fingerprint: 'b'.repeat(64) }, data: { fingerprint: 'c'.repeat(64) } };
  const buildFile = writeJson(root, '_site/build-manifest.json', manifest);
  const evidenceFile = writeJson(root, 'out/qa/screenshot-readiness/01-startansicht.json', {
    schemaVersion: 1, revision: process.env.GITHUB_SHA || null,
    screenshot: { path: imagePath, bytes: image.length, sha256: sha256(image) },
    build: { path: '_site/build-manifest.json', sha256: sha256(fs.readFileSync(buildFile)),
      fingerprint: manifest.fingerprint, applicationFingerprint: manifest.application.fingerprint,
      dataFingerprint: manifest.data.fingerprint },
    criteria: { city: 'Hannover', layers: ['cluster'], requireCompleteCoverage: true, mapSourceMode: 'fixture' },
    lifecycle: { status: 'ready', city: 'Hannover', counts: { loaded: 100, filtered: 80, viewport: 12 },
      coverage: { complete: true }, render: { submitted: true, revision: 7, completedRevision: 7,
        layers: { cluster: { requested: true, complete: true, visible: 12 } } } },
  });
  return { buildFile, evidenceFile };
}

// Run the private production build lifecycle with real filesystem operations.
// Only child commands are substituted: the build boundary materializes a
// different Pages manifest, as the actual public-profile build does in CI.
function buildPages(root, outputDirectory) {
  const actualRequire = createRequire(gatePath);
  const moduleObject = { exports: {} };
  const childProcess = require('node:child_process');
  const localRequire = name => name === 'node:child_process' ? {
    ...childProcess,
    spawnSync(_command, args) {
      if (path.basename(args[0]) === 'build-site.js') {
        const output = args[args.indexOf('--output-dir') + 1];
        writeJson(root, `${output}/build-manifest.json`, { schemaVersion: 1,
          fingerprint: 'd'.repeat(64), application: { fingerprint: 'e'.repeat(64) },
          data: { fingerprint: 'c'.repeat(64) } });
      }
      return { status: 0 };
    },
  } : actualRequire(name);
  vm.runInNewContext(fs.readFileSync(gatePath, 'utf8') + '\nmodule.exports = { buildAndValidateSite };', {
    require: localRequire, module: moduleObject, __dirname: path.join(root, 'scripts'),
    process: { ...process, env: { ...process.env, PAGES_OUTPUT_DIR: outputDirectory, PAGES_REFRESH_RIS: '0' },
      stdout: { write() {} } },
    setTimeout, clearTimeout,
  }, { filename: gatePath });
  moduleObject.exports.buildAndValidateSite();
}

test('combined release profiles preserve the exact site and receipts used by extended browser QA', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-pages-output-'));
  try {
    const profiles = ['release-site', 'pages', 'e2e', 'system-it', 'location-brief-golden', 'document-render'];
    const output = pagesOutputFor(profiles);
    const { buildFile, evidenceFile } = prepareEvidence(root);
    const originalBuild = fs.readFileSync(buildFile);
    const originalEvidence = fs.readFileSync(evidenceFile);
    expect(validate({ root }).valid).toBe(true);
    fs.mkdirSync(path.join(root, output), { recursive: true });
    fs.writeFileSync(path.join(root, output, 'obsolete.txt'), 'old Pages output');
    expect(() => validateBuildPaths(root, path.join(root, output), path.join(root, 'out'), path.join(root, 'out')))
      .not.toThrow();

    buildPages(root, output);

    expect(fs.readFileSync(buildFile)).toEqual(originalBuild);
    expect(fs.readFileSync(evidenceFile)).toEqual(originalEvidence);
    expect(validate({ root })).toMatchObject({ valid: true, totals: { screenshots: 1, evidence: 1 } });
    expect(fs.existsSync(path.join(root, output, 'obsolete.txt'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(root, output, 'build-manifest.json'))).application.fingerprint)
      .toBe('e'.repeat(64));

    // Isolation must not weaken the original strict receipt check.
    fs.appendFileSync(buildFile, '\n');
    expect(validate({ root })).toMatchObject({ valid: false,
      errors: expect.arrayContaining([expect.stringContaining('build manifest SHA-256/fingerprints do not match')]) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the standalone Pages profile still builds the canonical publication directory', () => {
  expect(pagesOutputFor(['pages'])).toBe('_site');
});
