#!/usr/bin/env node
'use strict';

/**
 * Guard against the failure mode where `@playwright/test` is updated but the
 * Docker base image stays behind. The Dockerfile deliberately uses
 * PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, so the preinstalled browser bundle in
 * mcr.microsoft.com/playwright must match the npm package version.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function readJson(absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'));
}

function readText(absPath) {
  return fs.readFileSync(absPath, 'utf8');
}

function cleanVersion(raw) {
  const value = String(raw || '').trim();
  const match = value.match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function fail(message, details = []) {
  console.error(`\n❌ ${message}`);
  for (const detail of details) console.error(`   - ${detail}`);
  process.exit(1);
}

/**
 * Extract all relevant Playwright version strings from the given file
 * contents. Pure — never reads from disk, never exits.
 *
 * @param {{pkg: object, lock: object, dockerfile: string}} sources
 * @returns {{pkgVersion, lockRootVersion, lockNodeVersion, dockerTag, dockerVersion, skipBrowserDownload, missing: string[]}}
 */
function extractVersions({ pkg, lock, dockerfile }) {
  const pkgVersion = cleanVersion(pkg.dependencies && pkg.dependencies['@playwright/test']);
  const lockRootVersion = cleanVersion(lock.packages && lock.packages[''] && lock.packages[''].dependencies && lock.packages[''].dependencies['@playwright/test']);
  const lockNodeVersion = cleanVersion(lock.packages && lock.packages['node_modules/@playwright/test'] && lock.packages['node_modules/@playwright/test'].version);
  const dockerMatch = dockerfile.match(/^FROM\s+mcr\.microsoft\.com\/playwright:v([^\s]+)$/m);
  const dockerTag = dockerMatch ? dockerMatch[1] : '';
  const dockerVersion = cleanVersion(dockerTag);
  const skipBrowserDownload = /PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD\s*=\s*1/.test(dockerfile);

  const missing = [];
  if (!pkgVersion) missing.push('package.json dependencies.@playwright/test');
  if (!lockRootVersion) missing.push('package-lock.json packages[""].dependencies.@playwright/test');
  if (!lockNodeVersion) missing.push('package-lock.json packages["node_modules/@playwright/test"].version');
  if (!dockerVersion) missing.push('Dockerfile FROM mcr.microsoft.com/playwright:v<version>-...');

  return { pkgVersion, lockRootVersion, lockNodeVersion, dockerTag, dockerVersion, skipBrowserDownload, missing };
}

/**
 * Check that all Playwright versions are aligned.
 * Returns `{ ok: true, version }` or `{ ok: false, message, details }`.
 *
 * @param {string} [repoRoot]  absolute repo root; defaults to parent of __dirname
 * @returns {{ ok: boolean, version?: string, message?: string, details?: string[] }}
 */
function checkVersions(repoRoot) {
  const r = repoRoot || root;
  const pkg = readJson(path.join(r, 'package.json'));
  const lock = readJson(path.join(r, 'package-lock.json'));
  const dockerfile = readText(path.join(r, 'Dockerfile'));
  const { pkgVersion, lockRootVersion, lockNodeVersion, dockerTag, dockerVersion, skipBrowserDownload, missing } =
    extractVersions({ pkg, lock, dockerfile });

  if (missing.length) {
    return { ok: false, message: 'Playwright version metadata is incomplete.', details: missing };
  }

  const versions = [pkgVersion, lockRootVersion, lockNodeVersion, dockerVersion];
  const unique = Array.from(new Set(versions));
  if (unique.length !== 1) {
    return {
      ok: false,
      message: 'Playwright npm package and Docker base image versions are out of sync.',
      details: [
        `package.json @playwright/test: ${pkgVersion}`,
        `package-lock root @playwright/test: ${lockRootVersion}`,
        `package-lock node_modules/@playwright/test: ${lockNodeVersion}`,
        `Dockerfile mcr.microsoft.com/playwright: ${dockerTag}`,
        skipBrowserDownload
          ? 'Dockerfile uses PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, so this mismatch can break container-only video export tests.'
          : 'Dockerfile does not set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, but versions should still stay aligned.',
      ],
    };
  }

  return { ok: true, version: pkgVersion };
}

function main() {
  const result = checkVersions();
  if (!result.ok) {
    fail(result.message, result.details);
  }
  console.log(`✅ Playwright Docker/npm versions aligned: ${result.version}`);
}

if (require.main === module) {
  main();
}

module.exports = { cleanVersion, extractVersions, checkVersions };
