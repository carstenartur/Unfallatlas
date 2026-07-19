'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { dimensions, validate } = require('../../scripts/validate-doc-media');

const ROOT = path.resolve(__dirname, '../..');

describe('documentation media policy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/media-manifest.json'), 'utf8'));
  const fixtureImage = path.join(ROOT, 'docs/screenshots/15-export-pdf-rendered.png');
  const temporaryRoots = [];

  function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  function createIsolatedRepository() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-media-policy-'));
    temporaryRoots.push(root);
    const docs = path.join(root, 'docs');
    fs.mkdirSync(docs, { recursive: true });
    const mediaPath = path.join(docs, 'candidate.png');
    fs.copyFileSync(fixtureImage, mediaPath);
    const target = dimensions(fixtureImage);
    const bytes = fs.statSync(mediaPath).size;
    fs.writeFileSync(path.join(root, 'README.md'), '![Kandidat](docs/candidate.png)\n');
    const isolatedManifest = {
      schemaVersion: 1,
      defaults: {
        maxBytes: bytes + 1024,
        maxTotalBytes: bytes + 2048,
        screenshotTarget: target,
        exceptionPolicy: { trackingIssue: 404, expiresOn: '2099-12-31' },
      },
      assets: [{
        path: 'docs/candidate.png',
        kind: 'screenshot',
        purpose: 'Isoliertes Validator-Testbild.',
        target,
        references: ['README.md'],
      }],
    };
    const manifestPath = path.join(docs, 'media-manifest.json');
    writeJson(manifestPath, isolatedManifest);
    return { root, manifest: isolatedManifest, manifestPath, mediaPath, target, bytes };
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('all committed media, Markdown references, dimensions and budgets validate', () => {
    const report = validate({ root: ROOT, manifest: 'docs/media-manifest.json' });
    expect(report.errors).toEqual([]);
    expect(report.valid).toBe(true);
    expect(report.totals.assets).toBe(manifest.assets.length);
  });

  test('legacy dimensions and above-default budgets are always justified', () => {
    const standardBudget = manifest.defaults.maxBytes;
    for (const asset of manifest.assets) {
      if ((asset.acceptedLegacy || []).length > 0 || Number(asset.maxBytes || 0) > standardBudget) {
        expect(asset.exception).toEqual(expect.any(String));
        expect(asset.exception.trim().length).toBeGreaterThan(20);
      }
    }
  });

  test('new full-screen screenshot candidates target 1280x640', () => {
    const panelAssets = new Set([
      'docs/screenshots/02-stadtauswahl.png',
      'docs/screenshots/03-filter.png',
      'docs/screenshots/08-stundenfilter.png',
    ]);
    const documentPreview = 'docs/screenshots/15-export-pdf-rendered.png';
    for (const asset of manifest.assets.filter(entry => entry.kind === 'screenshot')) {
      if (panelAssets.has(asset.path)) expect(asset.target).toEqual({ width: 440, height: 620 });
      else if (asset.path !== documentPreview) expect(asset.target).toEqual({ width: 1280, height: 640 });
    }
    const screenshotSpec = fs.readFileSync(path.join(ROOT, 'tests/e2e/screenshots.spec.js'), 'utf8');
    expect(screenshotSpec).toMatch(/viewport:\s*\{\s*width:\s*1280,\s*height:\s*640\s*\}/);
  });

  test('fails closed when a PNG has a valid signature but corrupt chunks', () => {
    const fixture = createIsolatedRepository();
    const corrupt = Buffer.alloc(33, 0);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(corrupt);
    fs.writeFileSync(fixture.mediaPath, corrupt);

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });

    expect(report.valid).toBe(false);
    expect(report.errors.join('\n')).toMatch(/(?:invalid|incomplete|truncated) PNG/i);
    expect(report.assets[0].status).toBe('error');
    expect(report.assets[0].dimensions).toBeNull();
  });

  test('rejects unknown schema, media kind and non-integer budgets', () => {
    const fixture = createIsolatedRepository();
    fixture.manifest.schemaVersion = 99;
    fixture.manifest.defaults.maxBytes = 'one megabyte';
    fixture.manifest.defaults.maxTotalBytes = 0;
    fixture.manifest.assets[0].kind = 'movie';
    fixture.manifest.assets[0].maxBytes = 1.5;
    writeJson(fixture.manifestPath, fixture.manifest);

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });

    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      'manifest.schemaVersion must equal 1',
      'manifest.defaults.maxBytes must be a positive integer',
      'manifest.defaults.maxTotalBytes must be a positive integer',
      'docs/candidate.png: unsupported kind movie',
      'docs/candidate.png: maxBytes must be a positive integer',
    ]));
  });

  test('returns a machine-readable failure report for an unreadable manifest', () => {
    const fixture = createIsolatedRepository();
    fs.writeFileSync(fixture.manifestPath, '{ invalid json');

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });

    expect(report).toEqual(expect.objectContaining({
      schemaVersion: 2,
      valid: false,
      assets: [],
      totals: expect.objectContaining({ assets: 0, bytes: 0 }),
    }));
    expect(report.manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.errors.join('\n')).toMatch(/cannot read media manifest/i);
  });

  test('rejects an escaping manifest path without probing or hashing the external target', () => {
    const fixture = createIsolatedRepository();
    const externalManifest = path.resolve(fixture.root, '..', 'external-media-manifest.json');
    const existsSpy = jest.spyOn(fs, 'existsSync');
    const statSpy = jest.spyOn(fs, 'statSync');
    const readSpy = jest.spyOn(fs, 'readFileSync');
    const hashSpy = jest.spyOn(crypto, 'createHash');
    let report;
    let calls;
    try {
      report = validate({ root: fixture.root, manifest: externalManifest });
      calls = {
        exists: existsSpy.mock.calls.length,
        stat: statSpy.mock.calls.length,
        read: readSpy.mock.calls.length,
        hash: hashSpy.mock.calls.length,
      };
    } finally {
      existsSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
      hashSpy.mockRestore();
    }

    expect(report.valid).toBe(false);
    expect(report.manifest).toEqual({ path: '../external-media-manifest.json', sha256: null });
    expect(report.errors).toContain('manifest path escapes repository root');
    expect(calls).toEqual({ exists: 0, stat: 0, read: 0, hash: 0 });
  });

  test('rejects an escaping asset path without probing or hashing the external target', () => {
    const fixture = createIsolatedRepository();
    const externalAsset = path.resolve(fixture.root, '..', 'external-media.png');
    fixture.manifest.assets[0].path = '../external-media.png';
    writeJson(fixture.manifestPath, fixture.manifest);
    const existsSpy = jest.spyOn(fs, 'existsSync');
    const statSpy = jest.spyOn(fs, 'statSync');
    const readSpy = jest.spyOn(fs, 'readFileSync');
    let report;
    try {
      report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });
    } finally {
      const touchedExternal = calls => calls.some(([candidate]) =>
        typeof candidate === 'string' && path.resolve(candidate) === externalAsset
      );
      expect(touchedExternal(existsSpy.mock.calls)).toBe(false);
      expect(touchedExternal(statSpy.mock.calls)).toBe(false);
      expect(touchedExternal(readSpy.mock.calls)).toBe(false);
      existsSpy.mockRestore();
      statSpy.mockRestore();
      readSpy.mockRestore();
    }

    expect(report.valid).toBe(false);
    expect(report.errors).toContain('../external-media.png: asset path escapes repository root');
    expect(report.assets[0]).toEqual(expect.objectContaining({
      path: '../external-media.png',
      bytes: null,
      sha256: null,
      status: 'error',
    }));
  });

  test('finds broken media references in Markdown anywhere in the repository', () => {
    const fixture = createIsolatedRepository();
    const nestedDocs = path.join(fixture.root, 'notes', 'reviews');
    fs.mkdirSync(nestedDocs, { recursive: true });
    fs.writeFileSync(path.join(nestedDocs, 'qa.md'), '![Defekt](../../docs/missing.png)\n');

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });

    expect(report.valid).toBe(false);
    expect(report.errors).toContain('notes/reviews/qa.md: broken media reference docs/missing.png');
  });

  test('does not mistake an atomic site-build staging directory for repository documentation', () => {
    const fixture = createIsolatedRepository();
    const staging = path.join(fixture.root, '_site.tmp-123-fixture', 'docs');
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'DOKUMENTATION.md'), '![Build-Kopie](missing.png)\n');

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });

    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
  });

  test('rejects byte-identical assets and a breached repository total budget', () => {
    const fixture = createIsolatedRepository();
    const duplicatePath = path.join(fixture.root, 'docs', 'duplicate.png');
    fs.copyFileSync(fixture.mediaPath, duplicatePath);
    fs.writeFileSync(
      path.join(fixture.root, 'README.md'),
      '![Kandidat](docs/candidate.png)\n![Duplikat](docs/duplicate.png)\n'
    );
    fixture.manifest.defaults.maxTotalBytes = (fixture.bytes * 2) - 1;
    fixture.manifest.assets.push({
      path: 'docs/duplicate.png',
      kind: 'screenshot',
      purpose: 'Absichtlich byte-identisches Validator-Testbild.',
      target: fixture.target,
      references: ['README.md'],
    });
    writeJson(fixture.manifestPath, fixture.manifest);

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });

    expect(report.valid).toBe(false);
    expect(report.errors.some(error => error.startsWith('duplicate media bytes ('))).toBe(true);
    expect(report.errors).toContain(
      `documentation media total ${fixture.bytes * 2} bytes exceeds budget ${(fixture.bytes * 2) - 1}`
    );
    expect(report.totals.bytes).toBe(fixture.bytes * 2);
  });

  test.each([
    '.github/workflows/deploy-release.yml',
    '.github/workflows/generate-screenshots.yml',
    '.github/workflows/visual-check.yml',
    '.github/workflows/test.yml',
  ])('%s validates media with the repository-owned command', workflowPath => {
    const workflow = fs.readFileSync(path.join(ROOT, workflowPath), 'utf8');
    expect(workflow).toContain('npm run validate:media');
  });
});
