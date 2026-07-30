/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const exactCopyManifest = require('../../scripts/vendor-exact-copy-manifest');
const provenance = require('../../scripts/vendor-exact-copy-provenance');

describe('virtual exact-copy application fingerprint', () => {
  test('uses replacement bytes without mutating the existing site tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-copy-virtual-fingerprint-'));
    try {
      fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
      fs.writeFileSync(path.join(root, 'index.html'), '<html>fixture</html>\n');
      fs.writeFileSync(path.join(root, 'vendor', 'third-party-notices.json'), '{"old":true}\n');
      fs.writeFileSync(path.join(root, 'vendor', 'sbom.cdx.json'), '{"old":true}\n');
      const originalNotice = fs.readFileSync(path.join(root, 'vendor', 'third-party-notices.json'));
      const originalSbom = fs.readFileSync(path.join(root, 'vendor', 'sbom.cdx.json'));
      const newNotice = Buffer.from('{"new":true}\n');
      const newSbom = Buffer.from('{"bomFormat":"CycloneDX"}\n');

      const virtual = provenance.fingerprintApplicationFilesWithOverrides(root, new Map([
        ['vendor/third-party-notices.json', newNotice],
        ['vendor/sbom.cdx.json', newSbom],
      ]));

      expect(fs.readFileSync(path.join(root, 'vendor', 'third-party-notices.json'))).toEqual(originalNotice);
      expect(fs.readFileSync(path.join(root, 'vendor', 'sbom.cdx.json'))).toEqual(originalSbom);

      fs.writeFileSync(path.join(root, 'vendor', 'third-party-notices.json'), newNotice);
      fs.writeFileSync(path.join(root, 'vendor', 'sbom.cdx.json'), newSbom);
      expect(virtual).toEqual(exactCopyManifest.fingerprintApplicationFiles(root));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not allow an override to add an untracked application path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-copy-untracked-'));
    try {
      fs.writeFileSync(path.join(root, 'index.html'), 'fixture');
      const baseline = exactCopyManifest.fingerprintApplicationFiles(root);
      const virtual = provenance.fingerprintApplicationFilesWithOverrides(root, new Map([
        ['not-in-tree.json', Buffer.from('unexpected')],
      ]));
      expect(virtual).toEqual(baseline);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
