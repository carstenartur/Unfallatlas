'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  assertCompleteLicenseText,
  validateVendorLicenseEvidence,
} = require('../../scripts/validate-vendor-license-evidence');

const ROOT = path.resolve(__dirname, '../..');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function copyFile(root, relative) {
  const source = path.join(ROOT, relative);
  const destination = path.join(root, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-vendor-license-evidence-'));
  copyFile(root, 'vendor/license-evidence.json');
  copyFile(root, 'vendor/provenance-policy.json');
  copyFile(root, 'package-lock.json');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor/license-evidence.json'), 'utf8'));
  for (const record of manifest.records) copyFile(root, record.licenseTextPath);
  return root;
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
}

function writeJson(root, relative, value) {
  fs.writeFileSync(path.join(root, relative), `${JSON.stringify(value, null, 2)}\n`);
}

describe('vendor plugin licence evidence', () => {
  test('validates the checked-in exact and project-level evidence honestly', () => {
    const report = validateVendorLicenseEvidence({ root: ROOT });
    expect(report).toEqual(expect.objectContaining({
      recordCount: 5,
      exactReleaseRecordCount: 3,
      projectLicenseRecordCount: 2,
      lockedRecordCount: 4,
      unresolvedRecordCount: 1,
    }));
    expect(report.records.map(record => `${record.package}@${record.version}`)).toEqual([
      'leaflet-draw@1.0.4',
      'leaflet.heat@0.2.0',
      'simpleheat@0.2.0',
      'leaflet-image@0.4.0',
      'd3-queue@2.0.3',
    ]);
    expect(report.records.find(record => record.package === 'simpleheat')).toEqual(
      expect.objectContaining({ lockRequired: false, releaseBinding: 'project-license-with-package-metadata' })
    );
  });

  test.each([
    ['MIT', 'Copyright 2026 Example\nPermission is hereby granted\n'],
    ['BSD-2-Clause', 'Copyright 2026 Example\nRedistribution and use in source and binary forms\n'],
    ['BSD-3-Clause', 'Copyright 2026 Example\nRedistribution and use in source and binary forms\n'],
  ])('rejects a truncated %s text even when a caller supplies it directly', (spdx, text) => {
    expect(() => assertCompleteLicenseText(text, spdx, 'fixture')).toThrow(/complete/);
  });

  test('rejects byte drift in a checked-in licence text', () => {
    const root = createFixture();
    try {
      fs.appendFileSync(path.join(root, 'vendor/license-sources/leaflet-draw-1.0.4.txt'), '\nmutated\n');
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/License hash drift/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a truncated text even when its manifest hash is recomputed', () => {
    const root = createFixture();
    try {
      const relative = 'vendor/license-sources/d3-queue-2.0.3.txt';
      const truncated = 'Copyright 2012-2016 Michael Bostock\nRedistribution and use in source and binary forms\n';
      fs.writeFileSync(path.join(root, relative), truncated);
      const evidence = readJson(root, 'vendor/license-evidence.json');
      evidence.records.find(record => record.package === 'd3-queue').licenseTextSha256 = sha256(truncated);
      writeJson(root, 'vendor/license-evidence.json', evidence);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/complete copyright-bearing text/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects package-lock version or integrity drift', () => {
    const root = createFixture();
    try {
      const lock = readJson(root, 'package-lock.json');
      lock.packages['node_modules/leaflet-draw'].version = '1.0.3';
      writeJson(root, 'package-lock.json', lock);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/Lock binding missing for leaflet-draw@1\.0\.4/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects an unlocked component without a matching unresolved policy gap', () => {
    const root = createFixture();
    try {
      const policy = readJson(root, 'vendor/provenance-policy.json');
      policy.unresolvedAssets = policy.unresolvedAssets.filter(item => item.id !== 'leaflet-heat-embedded-simpleheat');
      writeJson(root, 'vendor/provenance-policy.json', policy);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/not bound to an unresolved policy gap/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects unsupported release bindings instead of upgrading evidence claims', () => {
    const root = createFixture();
    try {
      const evidence = readJson(root, 'vendor/license-evidence.json');
      evidence.records[2].releaseBinding = 'exact-release-file';
      evidence.records[2].sourceRef = 'invented-v0.2.0-tag';
      evidence.records[2].releaseBinding = 'supplier-asserted';
      writeJson(root, 'vendor/license-evidence.json', evidence);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/Unsupported release binding/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects escaping evidence paths and invalid covered assets', () => {
    const root = createFixture();
    try {
      const evidence = readJson(root, 'vendor/license-evidence.json');
      evidence.records[0].licenseTextPath = '../outside.txt';
      writeJson(root, 'vendor/license-evidence.json', evidence);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/canonical path under vendor/);

      const evidence2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/license-evidence.json'), 'utf8'));
      evidence2.records[0].coversAssets = ['../outside.js'];
      writeJson(root, 'vendor/license-evidence.json', evidence2);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/canonical path under vendor/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects duplicate package and duplicate text-path claims', () => {
    const root = createFixture();
    try {
      const evidence = readJson(root, 'vendor/license-evidence.json');
      evidence.records.push({ ...evidence.records[0] });
      writeJson(root, 'vendor/license-evidence.json', evidence);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/Duplicate package evidence/);

      const evidence2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/license-evidence.json'), 'utf8'));
      evidence2.records[1].licenseTextPath = evidence2.records[0].licenseTextPath;
      evidence2.records[1].licenseTextSha256 = evidence2.records[0].licenseTextSha256;
      writeJson(root, 'vendor/license-evidence.json', evidence2);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/Duplicate license text path/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('normalizes path separators before duplicate checks', () => {
    const root = createFixture();
    try {
      const evidence = readJson(root, 'vendor/license-evidence.json');
      evidence.records[1].licenseTextPath = evidence.records[0].licenseTextPath.replace(/\//g, '\\');
      evidence.records[1].licenseTextSha256 = evidence.records[0].licenseTextSha256;
      writeJson(root, 'vendor/license-evidence.json', evidence);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/Duplicate license text path/);

      const evidence2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'vendor/license-evidence.json'), 'utf8'));
      evidence2.records[0].coversAssets = ['vendor/assets/example.js', 'vendor\\assets\\example.js'];
      writeJson(root, 'vendor/license-evidence.json', evidence2);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/Invalid covered asset/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects non-HTTPS upstream repositories and malformed blob SHAs', () => {
    const root = createFixture();
    try {
      const evidence = readJson(root, 'vendor/license-evidence.json');
      evidence.records[0].sourceRepository = 'http://example.org/project';
      writeJson(root, 'vendor/license-evidence.json', evidence);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/must use https/);

      evidence.records[0].sourceRepository = 'https://example.org/project';
      evidence.records[0].sourceBlobSha = 'abc';
      writeJson(root, 'vendor/license-evidence.json', evidence);
      expect(() => validateVendorLicenseEvidence({ root })).toThrow(/Invalid upstream blob SHA/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
