'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  listGeneratedMedia,
  prepareCandidateDirectory,
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

  test('refuses a symlinked candidate path without touching its target', () => {
    const externalDirectory = path.join(temporaryRoot, 'external-candidate-target');
    fs.mkdirSync(externalDirectory, { recursive: true });
    fs.writeFileSync(path.join(externalDirectory, 'sentinel.txt'), 'must survive');
    fs.mkdirSync(path.dirname(candidateDirectory), { recursive: true });
    fs.symlinkSync(
      externalDirectory,
      candidateDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    expect(() => prepareCandidateDirectory(canonicalDirectory, candidateDirectory))
      .toThrow(/Candidate screenshot path must be missing or a real directory/);

    expect(fs.lstatSync(candidateDirectory).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(externalDirectory, 'sentinel.txt'), 'utf8'))
      .toBe('must survive');
  });

  test('lists generated media deterministically and rejects links inside the candidate tree', () => {
    const nested = path.join(candidateDirectory, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const topLevel = path.join(candidateDirectory, 'z-last.png');
    const nestedFirst = path.join(nested, 'a-first.webp');
    fs.writeFileSync(topLevel, 'png bytes');
    fs.writeFileSync(nestedFirst, 'webp bytes');
    fs.writeFileSync(path.join(candidateDirectory, 'README.md'), 'support file');

    expect(listGeneratedMedia(candidateDirectory)).toEqual([nestedFirst, topLevel]);

    const linkedTarget = path.join(temporaryRoot, 'linked-media-target');
    fs.mkdirSync(linkedTarget, { recursive: true });
    fs.writeFileSync(path.join(linkedTarget, 'external.png'), 'external bytes');
    fs.symlinkSync(
      linkedTarget,
      path.join(candidateDirectory, 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect(() => listGeneratedMedia(candidateDirectory))
      .toThrow(/Candidate screenshot tree must not contain links/);
  });

  const unsupportedEntryTest = process.platform === 'win32' ? test.skip : test;
  unsupportedEntryTest('rejects special filesystem entries in support and candidate trees', () => {
    const supportFifo = path.join(canonicalDirectory, 'unsupported-support.fifo');
    const supportResult = spawnSync('mkfifo', [supportFifo], { encoding: 'utf8' });
    expect(supportResult.status).toBe(0);
    expect(() => prepareCandidateDirectory(canonicalDirectory, candidateDirectory))
      .toThrow(/Unsupported canonical screenshot support entry/);

    fs.rmSync(supportFifo, { force: true });
    fs.mkdirSync(candidateDirectory, { recursive: true });
    const candidateFifo = path.join(candidateDirectory, 'unsupported-candidate.fifo');
    const candidateResult = spawnSync('mkfifo', [candidateFifo], { encoding: 'utf8' });
    expect(candidateResult.status).toBe(0);
    expect(() => listGeneratedMedia(candidateDirectory))
      .toThrow(/Unsupported candidate screenshot entry/);
  });

  test('restores reviewed media when the transient QA output tree is removed', () => {
    const before = snapshotDirectory(canonicalDirectory);
    const canonicalParent = path.dirname(canonicalDirectory);

    withCandidateScreenshotWorkspace(({ canonicalDirectory: mounted }) => {
      fs.writeFileSync(path.join(mounted, 'generated.png'), 'candidate bytes');
      const rootBackups = fs.readdirSync(temporaryRoot)
        .filter(name => name.startsWith('.canonical-screenshots.backup-'));
      expect(rootBackups).toHaveLength(1);
      expect(fs.readdirSync(canonicalParent)
        .filter(name => name.startsWith('screenshots.backup-'))).toEqual([]);

      fs.rmSync(path.join(temporaryRoot, 'out'), { recursive: true, force: true });
      expect(fs.existsSync(path.dirname(candidateDirectory))).toBe(false);
    }, { canonicalDirectory, candidateDirectory });

    expect(snapshotDirectory(canonicalDirectory)).toBe(before);
    expect(fs.readFileSync(path.join(candidateDirectory, 'generated.png'), 'utf8'))
      .toBe('candidate bytes');
    expect(fs.readdirSync(temporaryRoot)
      .filter(name => name.startsWith('.canonical-screenshots.backup-'))).toEqual([]);
    expect(fs.readdirSync(canonicalParent)
      .filter(name => name.startsWith('screenshots.backup-'))).toEqual([]);
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

  test('Maven-owned npm scripts mount candidates for both evidence gates in semantic order', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(packageJson.scripts['qa:e2e:extended'])
      .toBe('node scripts/run-extended-e2e-isolated.js');

    const evidenceCommand = packageJson.scripts['qa:e2e:evidence'];
    const semanticGate = evidenceCommand.indexOf('validate-screenshot-evidence.js');
    const candidateGate = evidenceCommand.indexOf('validate-doc-media.js --candidate-screenshots');
    expect(semanticGate).toBeGreaterThan(-1);
    expect(candidateGate).toBeGreaterThan(semanticGate);

    const evidenceWrapper = fs.readFileSync(
      path.join(ROOT, 'scripts', 'validate-extended-e2e-evidence.js'),
      'utf8'
    );
    expect(evidenceWrapper).toContain(
      "['validate-screenshot-evidence.js', { mountAtCanonicalPath: true }]"
    );
    expect(evidenceWrapper).toContain(
      "['validate-doc-media.js', { mountAtCanonicalPath: true }]"
    );
  });
});
