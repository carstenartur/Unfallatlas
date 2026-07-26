'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ALLOWED_FORMATS, dimensions, inspectMedia, validate } = require('../../scripts/validate-doc-media');

const ROOT = path.resolve(__dirname, '../..');

describe('documentation media policy', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/media-manifest.json'), 'utf8'));
  const fixtureImage = path.join(ROOT, 'docs/screenshots/15-export-pdf-rendered.png');
  const temporaryRoots = [];

  function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }

  function fileSha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  function tinyFalseGreenGif() {
    const header = Buffer.alloc(13);
    header.write('GIF89a', 0, 'ascii');
    header.writeUInt16LE(720, 6);
    header.writeUInt16LE(405, 8);
    header[10] = 0x80;
    const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
    const frame = pixel => {
      const packed = pixel === 0 ? Buffer.from([0x44, 0x01]) : Buffer.from([0x4c, 0x01]);
      return Buffer.from([
        0x21, 0xf9, 0x04, 0x00, 0x02, 0x00, 0x00, 0x00,
        0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0,
        0x02, 0x02, ...packed, 0x00,
      ]);
    };
    return Buffer.concat([header, palette, frame(0), frame(1), Buffer.from([0x3b])]);
  }

  function writeEvidenceFixture(root, mediaPath, assetPath) {
    const evidenceRoot = path.join(root, 'qa', 'screenshot-evidence');
    const readinessDirectory = path.join(evidenceRoot, 'readiness');
    fs.mkdirSync(readinessDirectory, { recursive: true });
    const screenshot = {
      path: assetPath,
      bytes: fs.statSync(mediaPath).size,
      sha256: fileSha256(mediaPath),
    };
    const revision = 'a'.repeat(40);
    const build = {
      path: '_site/build-manifest.json',
      sha256: 'b'.repeat(64),
      fingerprint: 'c'.repeat(64),
      applicationFingerprint: 'd'.repeat(64),
      dataFingerprint: 'e'.repeat(64),
    };
    const sidecarName = 'candidate.json';
    const sidecarPath = path.join(readinessDirectory, sidecarName);
    writeJson(sidecarPath, {
      schemaVersion: 1,
      revision,
      screenshot,
      build,
      criteria: { city: 'Teststadt', layers: ['cluster'], requireCompleteCoverage: true },
      lifecycle: {
        status: 'ready',
        city: 'Teststadt',
        counts: { loaded: 1, filtered: 1, viewport: 1 },
        coverage: { complete: true, city: 'Teststadt', loadedFeatureCount: 1 },
        render: {
          submitted: true,
          revision: 1,
          completedRevision: 1,
          layers: { cluster: { requested: true, expected: 1, processed: 1, visible: 1, complete: true } },
        },
        error: null,
      },
    });
    const summaryPath = path.join(evidenceRoot, 'summary.json');
    const summaryEntry = {
      ...screenshot,
      evidence: `out/qa/screenshot-readiness/${sidecarName}`,
      status: 'valid',
      errors: [],
    };
    writeJson(summaryPath, {
      schemaVersion: 1,
      valid: true,
      revision,
      build,
      totals: { screenshots: 1, evidence: 1 },
      screenshots: [summaryEntry],
      errors: [],
    });
    const readinessBytes = fs.statSync(sidecarPath).size;
    const readinessHash = fileSha256(sidecarPath);
    writeJson(path.join(evidenceRoot, 'provenance.json'), {
      schemaVersion: 1,
      source: {
        artifactName: 'fixture', artifactId: 1, artifactZipSha256: 'f'.repeat(64),
        evidenceRevision: revision, evidenceStatus: 'valid', evidenceCount: 1,
      },
      build: {
        manifestSha256: build.sha256,
        fingerprint: build.fingerprint,
        applicationFingerprint: build.applicationFingerprint,
        dataFingerprint: build.dataFingerprint,
      },
      summary: {
        path: 'qa/screenshot-evidence/summary.json',
        sha256: fileSha256(summaryPath),
        entriesSha256: crypto.createHash('sha256')
          .update(`${screenshot.path}\t${screenshot.sha256}\t${screenshot.bytes}\n`)
          .digest('hex'),
      },
      readiness: {
        directory: 'qa/screenshot-evidence/readiness',
        files: 1,
        bytes: readinessBytes,
        entriesSha256: crypto.createHash('sha256')
          .update(`${sidecarName}\t${readinessHash}\t${readinessBytes}\n`)
          .digest('hex'),
      },
    });
  }

  function rewriteSidecarAndRebind(root, mutate) {
    const evidenceRoot = path.join(root, 'qa', 'screenshot-evidence');
    const sidecarPath = path.join(evidenceRoot, 'readiness', 'candidate.json');
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
    mutate(sidecar);
    writeJson(sidecarPath, sidecar);
    const provenancePath = path.join(evidenceRoot, 'provenance.json');
    const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    const bytes = fs.statSync(sidecarPath).size;
    const digest = fileSha256(sidecarPath);
    provenance.readiness.bytes = bytes;
    provenance.readiness.entriesSha256 = crypto.createHash('sha256')
      .update(`candidate.json\t${digest}\t${bytes}\n`)
      .digest('hex');
    writeJson(provenancePath, provenance);
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
      evidenceLedger: 'qa/screenshot-evidence/provenance.json',
      defaults: {
        maxBytes: bytes + 1024,
        maxTotalBytes: bytes + 2048,
        screenshotTarget: target,
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
    writeEvidenceFixture(root, mediaPath, 'docs/candidate.png');
    return { root, manifest: isolatedManifest, manifestPath, mediaPath, target, bytes };
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('tooling boundary validates manifest policy without claiming final media evidence', () => {
    const policy = validate({ root: ROOT, manifest: 'docs/media-manifest.json', policyOnly: true });
    expect(policy.errors).toEqual([]);
    expect(policy.valid).toBe(true);
    expect(policy.mode).toBe('policy-only');
    expect(policy.mediaValidated).toBe(false);
    expect(policy.evidenceValidated).toBe(false);
    expect(policy.evidence).toEqual(expect.objectContaining({ mode: 'policy-only', validated: false }));
    expect(policy.totals.assets).toBe(manifest.assets.length);
    expect(policy.assets.every(asset => asset.bytes === null && asset.dimensions === null)).toBe(true);

    const strict = validate({ root: ROOT, manifest: 'docs/media-manifest.json' });
    const evidenceLedger = path.join(ROOT, manifest.evidenceLedger);
    if (fs.existsSync(evidenceLedger)) {
      expect(strict.errors).toEqual([]);
      expect(strict.valid).toBe(true);
      expect(strict.mode).toBe('strict');
      expect(strict.mediaValidated).toBe(true);
      expect(strict.evidenceValidated).toBe(true);
    } else {
      expect(strict.valid).toBe(false);
      expect(strict.errors).toContain(`${manifest.evidenceLedger}: screenshot evidence ledger is missing`);
    }
  });

  test('static media cannot use legacy dimensions or above-default budgets', () => {
    const standardBudget = manifest.defaults.maxBytes;
    for (const asset of manifest.assets) {
      expect(asset).not.toHaveProperty('acceptedLegacy');
      if (asset.kind !== 'animation') {
        expect(Number(asset.maxBytes || standardBudget)).toBeLessThanOrEqual(standardBudget);
      } else if (Number(asset.maxBytes || 0) > standardBudget) {
        expect(asset.exception).toEqual(expect.any(String));
        expect(asset.exception.trim().length).toBeGreaterThan(20);
        expect(asset.maxDurationMs).toEqual(expect.any(Number));
      }
    }
  });

  test('the canonical animation policy is explicit and the promoted asset satisfies it', () => {
    const animation = manifest.assets.find(asset => asset.kind === 'animation');
    expect(animation).toEqual(expect.objectContaining({
      maxBytes: expect.any(Number),
      maxDurationMs: expect.any(Number),
      exception: expect.any(String),
    }));
    expect(animation.exception.trim().length).toBeGreaterThan(20);

    if (!fs.existsSync(path.join(ROOT, manifest.evidenceLedger))) {
      const policy = validate({ root: ROOT, manifest: 'docs/media-manifest.json', policyOnly: true });
      expect(policy.valid).toBe(true);
      expect(policy.mediaValidated).toBe(false);
      return;
    }

    const inspected = inspectMedia(path.join(ROOT, animation.path));
    expect(inspected.animated).toBe(true);
    expect(inspected.frames).toBeGreaterThan(1);
    expect(inspected.durationMs).toBeLessThanOrEqual(animation.maxDurationMs);
    expect(inspected.visualEvidence).toEqual(expect.objectContaining({
      valid: true,
      paintedCanvasRatio: 1,
      uniqueCompositedFrames: expect.any(Number),
    }));
    expect(inspected.visualEvidence.uniqueCompositedFrames).toBeGreaterThan(1);
    expect(inspected.visualEvidence.maxChangedPixels).toBeGreaterThanOrEqual(
      inspected.visualEvidence.requiredChangedPixels
    );
    expect(fs.statSync(path.join(ROOT, animation.path)).size).toBeLessThanOrEqual(animation.maxBytes);
  });

  test('validate:media rejects tiny visually false-green GIF animation frames', () => {
    const fixture = createIsolatedRepository();
    fs.unlinkSync(fixture.mediaPath);
    const gifPath = path.join(fixture.root, 'docs', 'candidate.gif');
    fs.writeFileSync(gifPath, tinyFalseGreenGif());
    fs.writeFileSync(path.join(fixture.root, 'README.md'), '![Kandidat](docs/candidate.gif)\n');
    fixture.manifest.assets[0] = {
      path: 'docs/candidate.gif',
      kind: 'animation',
      purpose: 'Adversarial tiny-frame animation.',
      target: { width: 720, height: 405 },
      maxBytes: 4096,
      maxDurationMs: 1000,
      exception: 'Deliberately malformed visual evidence for validator coverage.',
      references: ['README.md'],
    };
    writeJson(fixture.manifestPath, fixture.manifest);
    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });
    expect(report.valid).toBe(false);
    expect(report.errors.join('\n')).toMatch(/visual canvas coverage/i);
  });

  test('every animation requires explicit budgets and a substantive exception', () => {
    const fixture = createIsolatedRepository();
    fixture.manifest.assets[0].kind = 'animation';
    delete fixture.manifest.assets[0].maxBytes;
    delete fixture.manifest.assets[0].maxDurationMs;
    delete fixture.manifest.assets[0].exception;
    writeJson(fixture.manifestPath, fixture.manifest);

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });
    expect(report.errors).toEqual(expect.arrayContaining([
      'docs/candidate.png: animation requires an explicit positive maxBytes',
      'docs/candidate.png: animation requires an explicit positive maxDurationMs',
      'docs/candidate.png: animation requires a substantive exception rationale',
    ]));
  });

  test('animation policy fails closed for WebP/APNG while static WebP remains inspectable', () => {
    expect([...ALLOWED_FORMATS.animation]).toEqual(['gif']);
    expect(ALLOWED_FORMATS.screenshot.has('webp')).toBe(true);
    const fixture = createIsolatedRepository();
    const webpPath = path.join(fixture.root, 'docs', 'candidate.webp');
    const webp = Buffer.alloc(30);
    webp.write('RIFF', 0, 'ascii');
    webp.writeUInt32LE(22, 4);
    webp.write('WEBP', 8, 'ascii');
    webp.write('VP8X', 12, 'ascii');
    webp.writeUInt32LE(10, 16);
    expect(inspectMedia((fs.writeFileSync(webpPath, webp), webpPath))).toEqual(expect.objectContaining({
      format: 'webp', animated: false, width: 1, height: 1,
    }));

    fixture.manifest.assets[0] = {
      path: 'docs/candidate.webp', kind: 'animation', purpose: 'Animated policy mutation.',
      target: { width: 1, height: 1 }, maxBytes: 1000, maxDurationMs: 1000,
      exception: 'A substantive but unsupported animated WebP policy exception.', references: ['README.md'],
    };
    fs.writeFileSync(path.join(fixture.root, 'README.md'), '![Kandidat](docs/candidate.webp)\n');
    writeJson(fixture.manifestPath, fixture.manifest);
    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json', candidateScreenshots: true });
    expect(report.errors).toContain('docs/candidate.webp: webp is not allowed for kind animation');
  });

  test.each([
    ['missing coverage', sidecar => { delete sidecar.lifecycle.coverage; }, /lifecycle is not ready/i],
    ['city mismatch', sidecar => { sidecar.lifecycle.city = 'Andere Stadt'; }, /lifecycle is not ready/i],
    ['render revision mismatch', sidecar => { sidecar.lifecycle.render.completedRevision = 0; }, /lifecycle is not ready/i],
    ['unpainted requested heatmap', sidecar => {
      sidecar.criteria.layers = ['heatmap'];
      sidecar.lifecycle.render.layers = {
        heatmap: { requested: true, expected: 1, processed: 1, visible: 1, painted: false, complete: true },
      };
    }, /requested heatmap has no painted-pixel evidence/i],
  ])('durable evidence rejects semantic sidecar mutation: %s', (_label, mutate, expected) => {
    const fixture = createIsolatedRepository();
    rewriteSidecarAndRebind(fixture.root, mutate);
    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });
    expect(report.valid).toBe(false);
    expect(report.errors.join('\n')).toMatch(expected);
  });

  test('candidate mode validates generated screenshots but defers the accepted ledger', () => {
    const fixture = createIsolatedRepository();
    fs.writeFileSync(path.join(fixture.root, fixture.manifest.evidenceLedger), '{ broken ledger');
    expect(validate({ root: fixture.root, manifest: 'docs/media-manifest.json' }).valid).toBe(false);
    const candidate = validate({
      root: fixture.root,
      manifest: 'docs/media-manifest.json',
      candidateScreenshots: true,
    });
    expect(candidate.valid).toBe(true);
    expect(candidate.mode).toBe('candidate-screenshots');
    expect(candidate.mediaValidated).toBe(false);
    expect(candidate.candidateMediaValidated).toBe(true);
    expect(candidate.evidenceValidated).toBe(false);
    expect(candidate.deferredAssets).toEqual([]);
    expect(candidate.evidence.mode).toBe('candidate-screenshots');
    expect(candidate.assets[0]).toEqual(expect.objectContaining({
      status: 'valid', deferred: false, validationScope: 'generated-candidate',
    }));
  });

  test('candidate mode explicitly defers non-generated animation bytes while strict mode rejects them', () => {
    const fixture = createIsolatedRepository();
    const animationPath = path.join(fixture.root, 'docs', 'deferred.gif');
    fs.writeFileSync(animationPath, tinyFalseGreenGif());
    fs.writeFileSync(
      path.join(fixture.root, 'README.md'),
      '![Kandidat](docs/candidate.png)\n![Animation](docs/deferred.gif)\n'
    );
    fixture.manifest.assets.push({
      path: 'docs/deferred.gif',
      kind: 'animation',
      purpose: 'Nicht in diesem Screenshot-Lauf erzeugtes, absichtlich ungültiges Altmedium.',
      target: { width: 720, height: 405 },
      maxBytes: 4096,
      maxDurationMs: 1000,
      exception: 'The animation is deliberately invalid so strict validation must still reject it.',
      references: ['README.md'],
    });
    writeJson(fixture.manifestPath, fixture.manifest);

    const strict = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });
    expect(strict.valid).toBe(false);
    expect(strict.errors.join('\n')).toMatch(/visual canvas coverage/i);

    const candidate = validate({
      root: fixture.root,
      manifest: 'docs/media-manifest.json',
      candidateScreenshots: true,
    });
    expect(candidate.valid).toBe(true);
    expect(candidate.deferredAssets).toEqual(['docs/deferred.gif']);
    expect(candidate.assets.find(asset => asset.path === 'docs/deferred.gif')).toEqual(expect.objectContaining({
      status: 'deferred',
      deferred: true,
      validationScope: 'strict-checked-in-media',
      bytes: null,
      dimensions: null,
    }));
    expect(candidate.assets.find(asset => asset.path === 'docs/candidate.png')).toEqual(expect.objectContaining({
      status: 'valid',
      deferred: false,
      validationScope: 'generated-candidate',
    }));
  });

  test('rejects reintroduced legacy dimensions and static budget overrides', () => {
    const fixture = createIsolatedRepository();
    fixture.manifest.assets[0].acceptedLegacy = [fixture.target];
    fixture.manifest.assets[0].maxBytes = fixture.manifest.defaults.maxBytes + 1;
    fixture.manifest.assets[0].exception = 'A deliberately invalid static-media exception for the mutation test.';
    writeJson(fixture.manifestPath, fixture.manifest);

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json' });

    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(expect.arrayContaining([
      'docs/candidate.png: acceptedLegacy is no longer permitted',
      'docs/candidate.png: static media may not declare policy exceptions',
      `docs/candidate.png: static media may not override the ${fixture.manifest.defaults.maxBytes}-byte standard budget`,
    ]));
  });

  test('new full-screen screenshot candidates target 1280x640', () => {
    const documentPreview = 'docs/screenshots/15-export-pdf-rendered.png';
    for (const asset of manifest.assets.filter(entry => entry.kind === 'screenshot')) {
      if (asset.path !== documentPreview) expect(asset.target).toEqual({ width: 1280, height: 640 });
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

    const report = validate({ root: fixture.root, manifest: 'docs/media-manifest.json', policyOnly: true });

    expect(report.valid).toBe(false);
    expect(report.mode).toBe('policy-only');
    expect(report.mediaValidated).toBe(false);
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
    ['.github/workflows/deploy-release.yml', 'release-site', 'qa:release-site'],
    ['.github/workflows/generate-screenshots.yml', 'documentation-live', 'qa:documentation-live'],
    ['.github/workflows/visual-check.yml', 'documentation-live', 'qa:documentation-live'],
  ])('%s delegates media validation to a repository-owned Maven profile', (workflowPath, profile, script) => {
    const workflow = fs.readFileSync(path.join(ROOT, workflowPath), 'utf8');
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    expect(workflow).toContain(`-P${profile}`);
    expect(workflow).not.toContain('npm run validate:media');
    expect(workflow).not.toContain('npm run validate:screenshot-evidence');
    expect(pom).toContain(`<id>${profile}</id>`);
    expect(pom).toContain(`<arguments>run ${script}</arguments>`);
    expect(packageJson.scripts[script]).toEqual(expect.any(String));
  });

  test('the test workflow delegates media and evidence validation to Maven', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/test.yml'), 'utf8');
    const pom = fs.readFileSync(path.join(ROOT, 'pom.xml'), 'utf8');
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    expect(workflow).toContain('mvn -B -ntp clean verify -Pe2e,system-it,location-brief-golden');
    expect(workflow).not.toContain('npm run validate:media');
    expect(workflow).not.toContain('npm run validate:screenshot-evidence');
    expect(pom).toContain('<arguments>run qa:e2e:evidence</arguments>');
    expect(packageJson.scripts['qa:e2e:evidence']).toContain('validate-screenshot-evidence.js');
    expect(packageJson.scripts['qa:e2e:evidence']).toContain(
      'validate-doc-media.js --candidate-screenshots'
    );
  });

  test('repository runners validate semantic evidence before candidate media policy', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const e2eCommand = packageJson.scripts['qa:e2e:evidence'];
    const liveRunner = fs.readFileSync(
      path.join(ROOT, 'scripts/run-live-documentation-qa.js'),
      'utf8'
    );

    for (const command of [e2eCommand, liveRunner]) {
      const evidenceGate = command.indexOf('validate-screenshot-evidence.js');
      const candidateGate = command.indexOf('validate-doc-media.js');
      expect(evidenceGate).toBeGreaterThan(-1);
      expect(candidateGate).toBeGreaterThan(evidenceGate);
    }
  });
});
