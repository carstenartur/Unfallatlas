'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  snapshotDirectory,
  withCandidateScreenshotWorkspace,
} = require('../../scripts/candidate-screenshot-workspace');

const ROOT = path.resolve(__dirname, '../..');

describe('isolated extended-E2E documentation screenshots', () => {
  let temporaryRoot;
  let canonicalDirectory;
  let candidateDirectory;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-candidate-screenshots-'));
    canonicalDirectory = path.join(temporaryRoot, 'docs', 'screenshots');
    candidateDirectory = path.join(temporaryRoot, 'out', 'qa', 'candidate-screenshots');
    fs.mkdirSync(canonicalDirectory, { recursive: true });
    fs.writeFileSync(path.join(canonicalDirectory, 'README.md'), 'support file\n');
    fs.writeFileSync(path.join(canonicalDirectory, 'reviewed.png'), 'reviewed bytes');
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test('routes generated media to a candidate directory and restores reviewed media byte-for-byte', () => {
    const before = snapshotDirectory(canonicalDirectory);

    withCandidateScreenshotWorkspace(({ canonicalDirectory: redirected, candidateDirectory: candidate }) => {
      expect(fs.lstatSync(redirected).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(redirected, 'reviewed.png'))).toBe(false);
      expect(fs.readFileSync(path.join(redirected, 'README.md'), 'utf8')).toBe('support file\n');
      fs.writeFileSync(path.join(redirected, 'generated.png'), 'candidate bytes');
      expect(fs.readFileSync(path.join(candidate, 'generated.png'), 'utf8')).toBe('candidate bytes');
    }, { canonicalDirectory, candidateDirectory });

    expect(snapshotDirectory(canonicalDirectory)).toBe(before);
    expect(fs.readFileSync(path.join(canonicalDirectory, 'reviewed.png'), 'utf8'))
      .toBe('reviewed bytes');
    expect(fs.readFileSync(path.join(candidateDirectory, 'generated.png'), 'utf8'))
      .toBe('candidate bytes');
  });

  test('restores reviewed media even when candidate generation fails', () => {
    const before = snapshotDirectory(canonicalDirectory);

    expect(() => withCandidateScreenshotWorkspace(({ canonicalDirectory: redirected }) => {
      fs.writeFileSync(path.join(redirected, 'partial.png'), 'partial candidate');
      throw new Error('deliberate candidate failure');
    }, { canonicalDirectory, candidateDirectory }))
      .toThrow('deliberate candidate failure');

    expect(snapshotDirectory(canonicalDirectory)).toBe(before);
    expect(fs.existsSync(path.join(candidateDirectory, 'partial.png'))).toBe(true);
  });

  test('Maven-owned npm scripts use the isolation wrappers', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(packageJson.scripts['qa:e2e:extended'])
      .toBe('node scripts/run-extended-e2e-isolated.js');
    expect(packageJson.scripts['qa:e2e:evidence'])
      .toBe('node scripts/validate-extended-e2e-evidence.js');
  });
});
