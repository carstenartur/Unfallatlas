'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { validate, writeReport } = require('../../scripts/validate-screenshot-evidence');

const ROOT = path.resolve(__dirname, '../..');
const FIXTURE_IMAGE = path.join(ROOT, 'docs/screenshots/15-export-pdf-rendered.png');

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

describe('canonical screenshot evidence policy', () => {
  const temporaryRoots = [];

  function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-screenshot-evidence-'));
    temporaryRoots.push(root);
    const screenshotPath = 'docs/screenshots/01-startansicht.png';
    const screenshotFile = path.join(root, screenshotPath);
    fs.mkdirSync(path.dirname(screenshotFile), { recursive: true });
    fs.copyFileSync(FIXTURE_IMAGE, screenshotFile);
    const screenshotBytes = fs.readFileSync(screenshotFile);
    const buildManifest = {
      schemaVersion: 1,
      fingerprint: 'a'.repeat(64),
      application: { fingerprint: 'b'.repeat(64) },
      data: { fingerprint: 'c'.repeat(64) },
    };
    const buildFile = path.join(root, '_site/build-manifest.json');
    writeJson(buildFile, buildManifest);
    const buildBytes = fs.readFileSync(buildFile);
    writeJson(path.join(root, 'docs/media-manifest.json'), {
      schemaVersion: 1,
      assets: [{ path: screenshotPath, kind: 'screenshot' }],
    });
    const lifecycle = {
      status: 'ready',
      city: 'Hannover',
      counts: { loaded: 100, filtered: 80, viewport: 12 },
      coverage: { complete: true },
      render: {
        submitted: true,
        revision: 7,
        completedRevision: 7,
        layers: { cluster: { requested: true, complete: true, visible: 12 } },
      },
    };
    const evidenceFile = path.join(root, 'out/qa/screenshot-readiness/01-startansicht.json');
    writeJson(evidenceFile, {
      schemaVersion: 1,
      revision: process.env.GITHUB_SHA || null,
      screenshot: { path: screenshotPath, bytes: screenshotBytes.length, sha256: sha256(screenshotBytes) },
      build: {
        path: '_site/build-manifest.json',
        sha256: sha256(buildBytes),
        fingerprint: buildManifest.fingerprint,
        applicationFingerprint: buildManifest.application.fingerprint,
        dataFingerprint: buildManifest.data.fingerprint,
      },
      criteria: { city: 'Hannover', layers: ['cluster'], requireCompleteCoverage: true, mapSourceMode: 'fixture' },
      lifecycle,
    });
    return { root, screenshotFile, buildFile, evidenceFile };
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('accepts an exact one-to-one image, sidecar and build binding', () => {
    const fixture = createFixture();
    const report = validate({ root: fixture.root });

    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.totals).toEqual({ screenshots: 1, evidence: 1 });
    expect(report.screenshots[0]).toEqual(expect.objectContaining({ status: 'valid' }));
  });

  test('rejects changed image bytes and orphaned evidence', () => {
    const fixture = createFixture();
    fs.appendFileSync(fixture.screenshotFile, Buffer.from('tampered'));
    writeJson(path.join(fixture.root, 'out/qa/screenshot-readiness/orphan.json'), { schemaVersion: 1 });

    const report = validate({ root: fixture.root });

    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      'out/qa/screenshot-readiness/orphan.json: evidence has no matching screenshot',
      'docs/screenshots/01-startansicht.png: evidence screenshot byte count does not match',
      'docs/screenshots/01-startansicht.png: evidence screenshot SHA-256 does not match',
    ]));
  });

  test('rejects a build manifest changed after screenshot capture', () => {
    const fixture = createFixture();
    fs.appendFileSync(fixture.buildFile, '\n');

    const report = validate({ root: fixture.root });

    expect(report.valid).toBe(false);
    expect(report.errors).toContain(
      'docs/screenshots/01-startansicht.png: evidence build manifest SHA-256/fingerprints do not match'
    );
  });

  test.each([null, false, 0, ''])('rejects a falsy non-object evidence sidecar (%p)', invalidEvidence => {
    const fixture = createFixture();
    writeJson(fixture.evidenceFile, invalidEvidence);

    const report = validate({ root: fixture.root });

    expect(report.valid).toBe(false);
    expect(report.errors).toContain(
      'docs/screenshots/01-startansicht.png: evidence must be a non-array JSON object'
    );
    expect(report.totals).toEqual({ screenshots: 1, evidence: 0 });
    expect(report.screenshots[0]).toEqual(expect.objectContaining({ status: 'error' }));
  });

  const symlinkTest = process.platform === 'win32' ? test.skip : test;

  symlinkTest.each([
    ['screenshot directory', 'docs/screenshots'],
    ['evidence directory', 'out/qa/screenshot-readiness'],
    ['build manifest', '_site/build-manifest.json'],
    ['media manifest', 'docs/media-manifest.json'],
  ])('rejects an external symlink in the canonical %s input', (label, relativeTarget) => {
    const fixture = createFixture();
    const target = path.join(fixture.root, relativeTarget);
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-external-evidence-'));
    temporaryRoots.push(externalRoot);
    const externalTarget = path.join(externalRoot, path.basename(target));
    const targetStats = fs.lstatSync(target);
    if (targetStats.isDirectory()) fs.cpSync(target, externalTarget, { recursive: true });
    else fs.copyFileSync(target, externalTarget);
    fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(externalTarget, target, targetStats.isDirectory() ? 'dir' : 'file');

    const report = validate({ root: fixture.root });

    expect(report.valid).toBe(false);
    expect(report.errors.join('\n')).toContain(`${label} must not contain symbolic links`);
  });

  symlinkTest('refuses to write a report through an external symlink parent', () => {
    const fixture = createFixture();
    const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-external-report-'));
    temporaryRoots.push(externalRoot);
    const reportLink = path.join(fixture.root, 'report-link');
    fs.symlinkSync(externalRoot, reportLink, 'dir');

    expect(() => writeReport(fixture.root, 'report-link/evidence.json', { valid: true })).toThrow(
      'report path must not contain symbolic links'
    );
    expect(fs.existsSync(path.join(externalRoot, 'evidence.json'))).toBe(false);
  });
});
