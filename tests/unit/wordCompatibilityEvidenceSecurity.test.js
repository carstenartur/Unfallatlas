'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const validator = require('../../scripts/validate-word-compatibility-evidence');

function fixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'word-evidence-security-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'renderer'), { recursive: true });
  fs.writeFileSync(path.join(root, 'renderer/input.js'), 'stable\n');
  fs.writeFileSync(path.join(root, 'config/word-compatibility-inputs.json'), JSON.stringify({
    schemaVersion: validator.INPUT_SCHEMA,
    files: ['renderer/input.js'],
    lockedPackages: ['docx'],
  }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
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

describe('Word evidence filesystem and workflow safety', () => {
  let root;

  beforeEach(() => {
    root = fixtureRepo();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    '../outside.json',
    'nested/../../outside.json',
    '/tmp/outside.json',
    '',
  ])('rejects repository path escape %#', (candidate) => {
    expect(() => validator.resolveInsideRoot(root, candidate, 'candidate'))
      .toThrow(/unsafe_path|invalid_string/);
  });

  test('writes a structured failure report when receipt validation fails', () => {
    fs.writeFileSync(path.join(root, 'evidence.json'), '{"schemaVersion":"wrong"}\n');

    expect(() => validator.main([
      '--root', root,
      '--evidence', 'evidence.json',
      '--report', 'out/failure.json',
    ])).toThrow();

    const report = JSON.parse(fs.readFileSync(path.join(root, 'out/failure.json'), 'utf8'));
    expect(report).toMatchObject({
      schemaVersion: validator.REPORT_SCHEMA,
      passed: false,
      validation: null,
      evidencePath: 'evidence.json',
      error: {
        name: 'WordCompatibilityEvidenceError',
        code: 'unexpected_fields',
      },
    });
    expect(report.inputEvidence.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('writes a structured failure report for an unsafe evidence path', () => {
    expect(() => validator.main([
      '--root', root,
      '--evidence', '../outside.json',
      '--report', 'out/unsafe-path.json',
    ])).toThrow(/unsafe_path/);

    const report = JSON.parse(fs.readFileSync(path.join(root, 'out/unsafe-path.json'), 'utf8'));
    expect(report).toMatchObject({
      passed: false,
      evidencePath: '../outside.json',
      error: { code: 'unsafe_path' },
    });
  });

  test('rejects unsafe config, report and template paths before reading or writing', () => {
    expect(() => validator.computeInputEvidence(root, '../config.json'))
      .toThrow(/unsafe_path/);
    expect(() => validator.main([
      '--root', root,
      '--print-fingerprint',
      '--report', '../report.json',
    ])).toThrow(/unsafe_path/);
    expect(() => validator.main([
      '--root', root,
      '--write-template', '../template.json',
    ])).toThrow(/unsafe_path/);
  });

  test('workflow passes dispatch inputs only through quoted environment variables', () => {
    const workflow = fs.readFileSync(
      path.resolve(__dirname, '../../.github/workflows/word-compatibility-evidence.yml'),
      'utf8',
    );
    expect(workflow).toContain('WORD_EVIDENCE_PATH: ${{ inputs.evidence_path }}');
    expect(workflow).toContain('WORD_EVIDENCE_MAX_AGE_DAYS: ${{ inputs.max_age_days }}');
    expect(workflow).toContain('--evidence "$WORD_EVIDENCE_PATH"');
    expect(workflow).toContain('--max-age-days "$WORD_EVIDENCE_MAX_AGE_DAYS"');
    expect(workflow).not.toMatch(/--evidence\s+'?\$\{\{\s*inputs\.evidence_path/);
    expect(workflow).not.toMatch(/--max-age-days\s+'?\$\{\{\s*inputs\.max_age_days/);
    expect(workflow).toContain('if: always()');
    expect(workflow).toContain('if-no-files-found: error');
  });
});
