'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { copyVendorAssets, copyVendorLicenses } = require('../../scripts/build-site');
const { validateVendorProvenance } = require('../../scripts/validate-vendor-provenance');

test('binds three regenerated Unicode data resources to the delivered PDF and the data license', () => {
  const root = path.resolve(__dirname, '../..');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-unicode-'));
  try {
    copyVendorLicenses(root, out, undefined, copyVendorAssets(root, out));
    const noticesFile = path.join(out, 'vendor/third-party-notices.json');
    const notices = JSON.parse(fs.readFileSync(noticesFile));
    const records = notices.supplementalLicenses.filter(entry => entry.ref?.startsWith('urn:unfallatlas:vendor-source:ucd:'));
    expect(records.map(entry => entry.ref.split(':').pop()).sort()).toEqual(['classes.trie', 'data.json', 'data.trie']);
    const sbom = JSON.parse(fs.readFileSync(path.join(out, notices.sbom.path)));
    const owner = sbom.dependencies.find(entry => entry.ref === 'urn:unfallatlas:vendor-asset:vendor/export/pdfmake.js');
    for (const record of records) {
      expect(record.spdx).toBe('Unicode-3.0');
      expect(fs.readFileSync(path.join(out, record.path), 'utf8')).toContain('COPYRIGHT AND PERMISSION NOTICE');
      expect(owner.dependsOn).toContain(record.ref);
      expect(sbom.components.find(entry => entry['bom-ref'] === record.ref).licenses).toEqual([{ expression: 'Unicode-3.0' }]);
    }
    records[0].sourceSha256 = 'a'.repeat(64);
    fs.writeFileSync(noticesFile, JSON.stringify(notices));
    expect(() => validateVendorProvenance(noticesFile)).toThrow();
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
