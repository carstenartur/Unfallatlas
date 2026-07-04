'use strict';

/**
 * Tests for scripts/check-playwright-docker-version.js
 *
 * Covers: cleanVersion parsing, extractVersions pure logic, checkVersions
 * happy path, version-mismatch case, and missing-metadata case.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const { cleanVersion, extractVersions, checkVersions } =
  require('../../scripts/check-playwright-docker-version.js');

// ---------------------------------------------------------------------------
// cleanVersion
// ---------------------------------------------------------------------------

describe('cleanVersion', () => {
  test('extracts semver from a bare version string', () => {
    expect(cleanVersion('1.61.1')).toBe('1.61.1');
  });

  test('extracts semver from a caret range', () => {
    expect(cleanVersion('^1.61.1')).toBe('1.61.1');
  });

  test('extracts semver from a docker tag with OS suffix', () => {
    expect(cleanVersion('1.61.1-jammy')).toBe('1.61.1');
  });

  test('returns empty string for undefined / null / empty', () => {
    expect(cleanVersion(undefined)).toBe('');
    expect(cleanVersion(null)).toBe('');
    expect(cleanVersion('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// extractVersions  (pure — no disk I/O)
// ---------------------------------------------------------------------------

function makeInputs(opts = {}) {
  const version = opts.version || '1.61.1';
  const dockerVersion = opts.dockerVersion || version;
  const lockVersion = opts.lockVersion || version;
  return {
    pkg: { dependencies: { '@playwright/test': version } },
    lock: {
      packages: {
        '': { dependencies: { '@playwright/test': version } },
        'node_modules/@playwright/test': { version: lockVersion },
      },
    },
    dockerfile: [
      `FROM mcr.microsoft.com/playwright:v${dockerVersion}-jammy`,
      'ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1',
    ].join('\n'),
  };
}

describe('extractVersions', () => {
  test('returns all versions and empty missing array when data is complete', () => {
    const result = extractVersions(makeInputs());
    expect(result.pkgVersion).toBe('1.61.1');
    expect(result.lockRootVersion).toBe('1.61.1');
    expect(result.lockNodeVersion).toBe('1.61.1');
    expect(result.dockerVersion).toBe('1.61.1');
    expect(result.dockerTag).toBe('1.61.1-jammy');
    expect(result.skipBrowserDownload).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  test('reports missing entry when package.json has no @playwright/test', () => {
    const inputs = makeInputs();
    delete inputs.pkg.dependencies['@playwright/test'];
    const result = extractVersions(inputs);
    expect(result.missing).toContain('package.json dependencies.@playwright/test');
  });

  test('reports missing entry when Dockerfile has no matching FROM line', () => {
    const inputs = makeInputs();
    inputs.dockerfile = 'FROM node:24\nENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1';
    const result = extractVersions(inputs);
    expect(result.missing).toContain('Dockerfile FROM mcr.microsoft.com/playwright:v<version>-...');
  });

  test('detects mismatched lock vs package.json versions', () => {
    const result = extractVersions(makeInputs({ version: '1.61.1', lockVersion: '1.60.0' }));
    expect(result.lockNodeVersion).toBe('1.60.0');
    expect(result.pkgVersion).toBe('1.61.1');
    expect(result.missing).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// checkVersions  (reads real temp files on disk)
// ---------------------------------------------------------------------------

function writeFile(dir, relPath, content) {
  const abs = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content));
}

function makeRepo(dir, opts = {}) {
  const version = opts.version || '1.61.1';
  const dockerVersion = opts.dockerVersion || version;
  const lockVersion = opts.lockVersion || version;

  writeFile(dir, 'package.json', {
    dependencies: { '@playwright/test': version },
  });
  writeFile(dir, 'package-lock.json', {
    packages: {
      '': { dependencies: { '@playwright/test': version } },
      'node_modules/@playwright/test': { version: lockVersion },
    },
  });
  writeFile(dir, 'Dockerfile', [
    `FROM mcr.microsoft.com/playwright:v${dockerVersion}-jammy`,
    'ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1',
  ].join('\n'));
}

describe('checkVersions', () => {
  test('returns ok=true when all versions are aligned', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-docker-'));
    makeRepo(dir);
    const result = checkVersions(dir);
    expect(result.ok).toBe(true);
    expect(result.version).toBe('1.61.1');
  });

  test('returns ok=false with mismatch details when Docker tag differs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-docker-'));
    makeRepo(dir, { version: '1.61.1', dockerVersion: '1.60.0' });
    const result = checkVersions(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/out of sync/);
    expect(result.details.some(d => d.includes('1.60.0'))).toBe(true);
    expect(result.details.some(d => d.includes('1.61.1'))).toBe(true);
  });

  test('returns ok=false when package-lock version differs from package.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-docker-'));
    makeRepo(dir, { version: '1.61.1', lockVersion: '1.60.0' });
    const result = checkVersions(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/out of sync/);
  });

  test('returns ok=false with incomplete details when Dockerfile FROM is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-docker-'));
    makeRepo(dir);
    writeFile(dir, 'Dockerfile', 'FROM node:24\n');
    const result = checkVersions(dir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/incomplete/);
    expect(result.details.some(d => d.includes('Dockerfile FROM'))).toBe(true);
  });
});
