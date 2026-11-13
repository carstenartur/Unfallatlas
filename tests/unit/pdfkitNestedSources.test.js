'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyVendorAssets, copyVendorLicenses } = require('../../scripts/build-site');
const { validateVendorProvenance } = require('../../scripts/validate-vendor-provenance');

const repo = path.resolve(__dirname, '../..');
const asset = 'vendor/export/pdfmake.js';
const base = 'urn:unfallatlas:vendor-source:pdfkit:noble-hashes:';
const files = ['_md.js', '_u64.js', 'legacy.js', 'sha2.js', 'utils.js'];

test('links five hash sources and the ICC color profile to the delivered PDF exporter', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfkit-inventory-'));
  try {
    copyVendorLicenses(repo, out, undefined, copyVendorAssets(repo, out));
    const noticeFile = path.join(out, 'vendor/third-party-notices.json');
    const notice = JSON.parse(fs.readFileSync(noticeFile));
    const records = notice.supplementalLicenses.filter(record => record.ref?.startsWith(base));
    expect(records.map(record => record.ref).sort()).toEqual(files.map(file => base + file));
    const sbom = JSON.parse(fs.readFileSync(path.join(out, notice.sbom.path)));
    const owner = sbom.dependencies.find(entry => entry.ref === 'urn:unfallatlas:vendor-asset:' + asset);
    const profile = notice.supplementalLicenses.find(record => record.ref === 'urn:unfallatlas:vendor-source:pdfkit:icc:srgb2014');
    expect(owner.dependsOn).toContain(profile.ref);
    expect(profile).toMatchObject({ asset, spdx: 'LicenseRef-ICC-Profile',
      sourceSha256: '384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a' });
    expect(fs.readFileSync(path.join(out, profile.path), 'utf8')).toContain('Copyright International Color Consortium, 2015');
    for (const record of records) {
      expect(owner.dependsOn).toContain(record.ref);
      expect(record).toMatchObject({ asset, spdx: 'MIT', copyrightIncluded: true });
      expect(sbom.components.find(entry => entry['bom-ref'] === record.ref).hashes)
        .toContainEqual({ alg: 'SHA-256', content: record.sourceSha256 });
      expect(fs.readFileSync(path.join(out, record.path), 'utf8')).toContain('Copyright (c) 2022 Paul Miller');
    }
    notice.supplementalLicenses = notice.supplementalLicenses.filter(record => record.ref !== base + 'sha2.js');
    fs.writeFileSync(noticeFile, JSON.stringify(notice));
    expect(() => validateVendorProvenance(noticeFile)).toThrow();
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
