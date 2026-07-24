'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const validator = require('../../scripts/validate-word-compatibility-evidence');

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallwerkbank-word-evidence-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'js'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
  fs.writeFileSync(path.join(root, 'js/renderer.js'), 'renderer-v1\n');
  fs.writeFileSync(path.join(root, 'tests/fixtures/contract.json'), '{"rows":10}\n');
  fs.writeFileSync(path.join(root, 'config/word-compatibility-inputs.json'), JSON.stringify({
    schemaVersion: validator.INPUT_SCHEMA,
    files: ['tests/fixtures/contract.json', 'js/renderer.js'],
    lockedPackages: ['docx'],
  }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    lockfileVersion: 3,
    packages: {
      'node_modules/docx': {
        version: '9.7.1',
        resolved: 'https://registry.npmjs.org/docx/-/docx-9.7.1.tgz',
        integrity: 'sha512-example',
      },
    },
  }));
  return root;
}

function validReceipt(inputEvidence, now) {
  return {
    schemaVersion: validator.EVIDENCE_SCHEMA,
    inputFingerprint: inputEvidence.fingerprint,
    testedAt: new Date(now - 24 * 60 * 60 * 1000).toISOString(),
    sourceCommit: 'a'.repeat(40),
    artifact: {
      filename: 'source.docx',
      bytes: 26228,
      sha256: 'b'.repeat(64),
      documentId: 'ci-docx-sample',
      generator: 'npm run generate:sample-docx',
    },
    environment: {
      product: 'Microsoft Word',
      version: 'Microsoft 365 Version 2506 Build 18925.20216',
      platform: 'Windows 11 24H2',
    },
    reviewer: { githubLogin: 'carstenartur' },
    observedPageCount: 6,
    checks: Object.fromEntries(validator.REQUIRED_CHECKS.map((key) => [key, true])),
    notes: 'Opened, saved, reopened and links checked manually.',
  };
}

describe('Microsoft Word compatibility evidence', () => {
  let root;
  const now = Date.parse('2026-07-23T16:00:00.000Z');

  beforeEach(() => {
    root = tempRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('computes a deterministic fingerprint from declared files and locked packages', () => {
    const first = validator.computeInputEvidence(root);
    const second = validator.computeInputEvidence(root);

    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual([
      'js/renderer.js',
      'tests/fixtures/contract.json',
    ]);
    expect(first.packages).toEqual([expect.objectContaining({
      name: 'docx',
      version: '9.7.1',
      integrity: 'sha512-example',
    })]);
  });

  test('invalidates evidence when renderer bytes or the locked DOCX package change', () => {
    const before = validator.computeInputEvidence(root).fingerprint;
    fs.appendFileSync(path.join(root, 'js/renderer.js'), 'changed\n');
    const afterRenderer = validator.computeInputEvidence(root).fingerprint;
    expect(afterRenderer).not.toBe(before);

    const lockPath = path.join(root, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    lock.packages['node_modules/docx'].version = '9.8.0';
    fs.writeFileSync(lockPath, JSON.stringify(lock));
    expect(validator.computeInputEvidence(root).fingerprint).not.toBe(afterRenderer);
  });

  test('accepts recent evidence with every required manual Word check', () => {
    const input = validator.computeInputEvidence(root);
    const report = validator.validateReceipt(validReceipt(input, now), input, {
      now,
      maxAgeDays: 30,
    });

    expect(report).toMatchObject({
      passed: true,
      inputFingerprint: input.fingerprint,
      sourceCommit: 'a'.repeat(40),
      observedPageCount: 6,
      reviewer: { githubLogin: 'carstenartur' },
    });
    expect(report.ageDays).toBeCloseTo(1);
    expect(Object.values(report.checks).every(Boolean)).toBe(true);
  });

  test('rejects stale, future or fingerprint-mismatched evidence', () => {
    const input = validator.computeInputEvidence(root);
    const stale = validReceipt(input, now);
    stale.testedAt = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => validator.validateReceipt(stale, input, { now, maxAgeDays: 30 }))
      .toThrow(/evidence_expired/);

    const future = validReceipt(input, now);
    future.testedAt = new Date(now + 10 * 60 * 1000).toISOString();
    expect(() => validator.validateReceipt(future, input, { now }))
      .toThrow(/evidence_from_future/);

    const mismatch = validReceipt(input, now);
    mismatch.inputFingerprint = 'c'.repeat(64);
    expect(() => validator.validateReceipt(mismatch, input, { now }))
      .toThrow(/input_fingerprint_mismatch/);
  });

  test.each(validator.REQUIRED_CHECKS)(
    'fails closed when manual check %s is not explicitly true',
    (check) => {
      const input = validator.computeInputEvidence(root);
      const receipt = validReceipt(input, now);
      receipt.checks[check] = false;
      expect(() => validator.validateReceipt(receipt, input, { now }))
        .toThrow(/word_checks_failed/);
    },
  );

  test('rejects malformed artifact, reviewer, page count and unexpected fields', () => {
    const input = validator.computeInputEvidence(root);

    const badArtifact = validReceipt(input, now);
    badArtifact.artifact.filename = 'report.pdf';
    expect(() => validator.validateReceipt(badArtifact, input, { now }))
      .toThrow(/invalid_artifact/);

    const badReviewer = validReceipt(input, now);
    badReviewer.reviewer.githubLogin = '-invalid-';
    expect(() => validator.validateReceipt(badReviewer, input, { now }))
      .toThrow(/invalid_reviewer/);

    const badPages = validReceipt(input, now);
    badPages.observedPageCount = 0;
    expect(() => validator.validateReceipt(badPages, input, { now }))
      .toThrow(/invalid_page_count/);

    const unexpected = validReceipt(input, now);
    unexpected.approved = true;
    expect(() => validator.validateReceipt(unexpected, input, { now }))
      .toThrow(/unexpected_fields/);
  });

  test('rejects unsafe, duplicate or missing fingerprint inputs', () => {
    const configPath = path.join(root, 'config/word-compatibility-inputs.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.files = ['../outside.js'];
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(() => validator.computeInputEvidence(root)).toThrow(/unsafe_path/);

    config.files = ['js/renderer.js', 'js/renderer.js'];
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(() => validator.computeInputEvidence(root)).toThrow(/duplicate_value/);

    config.files = ['js/missing.js'];
    fs.writeFileSync(configPath, JSON.stringify(config));
    expect(() => validator.computeInputEvidence(root)).toThrow(/input_file_missing/);
  });

  test('writes an intentionally incomplete template carrying the current fingerprint', () => {
    const input = validator.computeInputEvidence(root);
    const template = validator.templateFor(input, now);

    expect(template.inputFingerprint).toBe(input.fingerprint);
    expect(template.testedAt).toBe('2026-07-23T16:00:00.000Z');
    expect(template.artifact.bytes).toBe(0);
    expect(template.observedPageCount).toBe(0);
    expect(Object.values(template.checks).every((value) => value === false)).toBe(true);
    expect(() => validator.validateReceipt(template, input, { now }))
      .toThrow(/invalid_commit|invalid_artifact|invalid_reviewer|invalid_page_count|word_checks_failed/);
  });

  test('CLI writes a template and a machine-readable validation report', () => {
    const templatePath = 'out/word-template.json';
    validator.main([
      '--root', root,
      '--write-template', templatePath,
    ]);
    const writtenTemplate = JSON.parse(fs.readFileSync(path.join(root, templatePath), 'utf8'));
    const input = validator.computeInputEvidence(root);
    expect(writtenTemplate.inputFingerprint).toBe(input.fingerprint);

    const evidencePath = path.join(root, 'word-evidence.json');
    fs.writeFileSync(evidencePath, JSON.stringify(validReceipt(input, Date.now())));
    const result = validator.main([
      '--root', root,
      '--evidence', 'word-evidence.json',
      '--report', 'out/word-report.json',
      '--max-age-days', '30',
    ]);
    expect(result.validation.passed).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'out/word-report.json'), 'utf8')))
      .toMatchObject({ validation: { passed: true } });
  });
});
