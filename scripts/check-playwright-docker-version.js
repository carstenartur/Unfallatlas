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

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(root, relPath), 'utf8'));
}

function readText(relPath) {
  return fs.readFileSync(path.join(root, relPath), 'utf8');
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

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const dockerfile = readText('Dockerfile');

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
if (missing.length) fail('Playwright version metadata is incomplete.', missing);

const versions = [pkgVersion, lockRootVersion, lockNodeVersion, dockerVersion];
const unique = Array.from(new Set(versions));
if (unique.length !== 1) {
  fail('Playwright npm package and Docker base image versions are out of sync.', [
    `package.json @playwright/test: ${pkgVersion}`,
    `package-lock root @playwright/test: ${lockRootVersion}`,
    `package-lock node_modules/@playwright/test: ${lockNodeVersion}`,
    `Dockerfile mcr.microsoft.com/playwright: ${dockerTag}`,
    skipBrowserDownload
      ? 'Dockerfile uses PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, so this mismatch can break container-only video export tests.'
      : 'Dockerfile does not set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1, but versions should still stay aligned.'
  ]);
}

console.log(`✅ Playwright Docker/npm versions aligned: ${pkgVersion}`);
