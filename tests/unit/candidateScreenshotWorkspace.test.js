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

  test('routes generated media through a real directory and restores reviewed media byte-for-byte', () => {
    const before = snapshotDirectory(canonicalDirectory);

    withCandidateScreenshotWorkspace(({ canonicalDirectory: mounted, candidateDirectory: candidate }) => {
      expect(fs.lstatSync(mounted).isSymbolicLink()).toBe(false);
      expect(fs.lstatSync(mounted).isDirectory()).toBe(true);
      expect(fs.existsSync(candidate)).toBe(false);
      expect(fs.existsSync(path.join(mounted, 'reviewed.png'))).toBe(false);
      expect(fs.readFileSync(path.join(mounted, 'README.md'), 'utf8')).toBe('support file\n');
      fs.writeFileSync(path.join(mounted, 'generated.png'), 'candidate bytes');
    }, { canonicalDirectory, candidateDirectory });

    expect(snapshotDirectory(canonicalDirectory)).toBe(before);
    expect(fs.readFileSync(path.join(canonicalDirectory, 'reviewed.png'), 'utf8'))
      .toBe('reviewed bytes');
    expect(fs.readFileSync(path.join(candidateDirectory, 'generated.png'), 'utf8'))
      .toBe('candidate bytes');
  });

  test('restores reviewed media even when candidate generation fails', () => {
    const before = snapshotDirectory(canonicalDirectory);

    expect(() => withCandidateScreenshotWorkspace(({ canonicalDirectory: mounted }) => {
      fs.writeFileSync(path.join(mounted, 'partial.png'), 'partial candidate');
      throw new Error('deliberate candidate failure');
    }, { canonicalDirectory, candidateDirectory }))
      .toThrow('deliberate candidate failure');

    expect(snapshotDirectory(canonicalDirectory)).toBe(before);
    expect(fs.existsSync(path.join(candidateDirectory, 'partial.png'))).toBe(true);
  });

  test('fails closed when a command recreates the candidate path while it is mounted', () => {
    const before = snapshotDirectory(canonicalDirectory);

    expect(() => withCandidateScreenshotWorkspace(({ canonicalDirectory: mounted }) => {
      fs.writeFileSync(path.join(mounted, 'generated.png'), 'candidate bytes');
      fs.mkdirSync(candidateDirectory, { recursive: true });
      fs.writeFileSync(path.join(candidateDirectory, 'unexpected.txt'), 'unexpected bytes');
    }, { canonicalDirectory, candidateDirectory }))
      .toThrow(/Candidate screenshot path was recreated/);

    expect(snapshotDirectory(canonicalDirectory)).toBe(before);
    expect(fs.readFileSync(path.join(candidateDirectory, 'generated.png'), 'utf8'))
      .toBe('candidate bytes');
    const recovery = fs.readdirSync(path.dirname(candidateDirectory))
      .find(name => name.startsWith('candidate-screenshots.unexpected-'));
    expect(recovery).toBeDefined();
    expect(fs.readFileSync(
      path.join(path.dirname(candidateDirectory), recovery, 'unexpected.txt'),
      'utf8'
    )).toBe('unexpected bytes');
  });

  test('Maven-owned npm scripts expose semantic evidence before candidate media validation', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(packageJson.scripts['qa:e2e:extended'])
      .toBe('node scripts/run-extended-e2e-isolated.js');

    const evidenceCommand = packageJson.scripts['qa:e2e:evidence'];
    const semanticGate = evidenceCommand.indexOf('validate-screenshot-evidence.js');
    const candidateGate = evidenceCommand.indexOf('validate-doc-media.js --candidate-screenshots');
    expect(semanticGate).toBeGreaterThan(-1);
    expect(candidateGate).toBeGreaterThan(semanticGate);
  });
});
