'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { prepareExtendedE2E } = require('../../scripts/prepare-extended-e2e');

describe('extended E2E preparation', () => {
  let temporaryRoot;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'unfallatlas-prepare-e2e-'));
  });

  afterEach(() => {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  test('clears only transient readiness JSON and preserves reviewed documentation media', () => {
    const canonicalDirectory = path.join(temporaryRoot, 'docs', 'screenshots');
    const readinessDirectory = path.join(temporaryRoot, 'out', 'qa', 'screenshot-readiness');
    fs.mkdirSync(canonicalDirectory, { recursive: true });
    fs.mkdirSync(readinessDirectory, { recursive: true });

    const reviewedScreenshot = path.join(canonicalDirectory, 'reviewed.png');
    const supportFile = path.join(canonicalDirectory, 'README.md');
    const staleEvidence = path.join(readinessDirectory, 'stale.json');
    const retainedEvidenceSupport = path.join(readinessDirectory, 'README.md');
    fs.writeFileSync(reviewedScreenshot, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
    fs.writeFileSync(supportFile, 'documentation support file\n');
    fs.writeFileSync(staleEvidence, '{}\n');
    fs.writeFileSync(retainedEvidenceSupport, 'readiness support file\n');

    const canonicalBefore = fs.readdirSync(canonicalDirectory)
      .sort()
      .map(name => [name, fs.readFileSync(path.join(canonicalDirectory, name))]);

    const result = prepareExtendedE2E({ root: temporaryRoot, log: false });

    expect(result.readinessDirectory).toBe(readinessDirectory);
    expect(fs.existsSync(staleEvidence)).toBe(false);
    expect(fs.readFileSync(retainedEvidenceSupport, 'utf8')).toBe('readiness support file\n');
    const canonicalAfter = fs.readdirSync(canonicalDirectory)
      .sort()
      .map(name => [name, fs.readFileSync(path.join(canonicalDirectory, name))]);
    expect(canonicalAfter.map(([name]) => name)).toEqual(canonicalBefore.map(([name]) => name));
    canonicalAfter.forEach(([name, contents], index) => {
      expect(name).toBe(canonicalBefore[index][0]);
      expect(contents.equals(canonicalBefore[index][1])).toBe(true);
    });
  });

  test('does not create or mutate a canonical screenshot directory', () => {
    const canonicalDirectory = path.join(temporaryRoot, 'docs', 'screenshots');

    prepareExtendedE2E({ root: temporaryRoot, log: false });

    expect(fs.existsSync(canonicalDirectory)).toBe(false);
    expect(fs.existsSync(path.join(temporaryRoot, 'out', 'qa', 'screenshot-readiness')))
      .toBe(true);
  });
});
