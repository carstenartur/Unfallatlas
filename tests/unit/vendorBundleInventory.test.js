'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { copyVendorAssets, copyVendorLicenses } = require('../../scripts/build-site');
const { docxSourcePackages } = require('../../scripts/vendor-provenance');
const { validatePolicyBinding, validateVendorProvenance } = require('../../scripts/validate-vendor-provenance');

const repoRoot = path.resolve(__dirname, '../..');
const policy = require('../../vendor/provenance-policy.json');
const docxAsset = 'vendor/export/docx.js';
const bundlePath = 'node_modules/docx/dist/index.iife.js';
const lockPath = 'vendor/docx-build/npm-lock.json.gz';
const pdfAsset = 'vendor/export/pdfmake.js';
const svgRef = 'urn:unfallatlas:vendor-source:pdfmake:svg-to-pdfkit';

describe('DOCX upstream component inventory', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-docx-component-inventory-'));
    for (const file of [bundlePath, lockPath, 'node_modules/nanoid/LICENSE', 'node_modules/fflate/LICENSE']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, file), path.join(root, file));
    }
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('identifies exactly the fflate and nanoid packages from the upstream lock', () => {
    const components = docxSourcePackages(root, policy.verifiedBundleInventories[docxAsset]);
    expect(components.map(component => [component.purl, component.lockFile, component.lockSha256])).toEqual([
      ['pkg:npm/fflate@0.8.3', lockPath, policy.verifiedBundleInventories[docxAsset].lockSha256],
      ['pkg:npm/nanoid@6.0.2', lockPath, policy.verifiedBundleInventories[docxAsset].lockSha256],
    ]);
  });

  test('rejects a new module marker even if the delivered bytes were hashed again', () => {
    fs.appendFileSync(path.join(root, bundlePath), '\n// node_modules/unlisted/index.js\n');
    expect(() => docxSourcePackages(root, policy.verifiedBundleInventories[docxAsset])).toThrow(/DOCX bundle SHA-256/);
  });

  test('rejects a modified supplier lock and a changed component license', () => {
    fs.appendFileSync(path.join(root, 'node_modules/nanoid/LICENSE'), '\nchanged');
    expect(() => docxSourcePackages(root, policy.verifiedBundleInventories[docxAsset])).toThrow(/license.*nanoid/i);
    fs.appendFileSync(path.join(root, lockPath), 'changed');
    expect(() => docxSourcePackages(root, policy.verifiedBundleInventories[docxAsset])).toThrow(/DOCX upstream lock SHA-256/);
  });

});

function withVendorArtifact(check) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-vendor-component-inventory-'));
  try {
    const assets = copyVendorAssets(repoRoot, root);
    copyVendorLicenses(repoRoot, root, undefined, assets);
    const noticePath = path.join(root, 'vendor/third-party-notices.json');
    const notice = validateVendorProvenance(noticePath);
    check(root, noticePath, notice);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('rejects a DOCX notice with a missing embedded npm component', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const docx = notice.assetAssessments.find(asset => asset.path === docxAsset);
    docx.contains = docx.contains.filter(purl => purl !== 'pkg:npm/nanoid@6.0.2');
    expect(() => validatePolicyBinding(notice, policy)).toThrow(/verified component inventory.*docx\.js/i);
  });
});

test('rejects coordinated omission of the SVG fork from the notice and SBOM', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const sbomPath = path.join(root, notice.sbom.path);
    const sbom = JSON.parse(fs.readFileSync(sbomPath));
    notice.supplementalLicenses = notice.supplementalLicenses.filter(license => license.ref !== svgRef);
    notice.assetAssessments.find(asset => asset.path === pdfAsset).containsFiles = [];
    sbom.components = sbom.components.filter(component => component['bom-ref'] !== svgRef);
    const pdf = sbom.dependencies.find(item => item.ref === `urn:unfallatlas:vendor-asset:${pdfAsset}`);
    pdf.dependsOn = pdf.dependsOn.filter(ref => ref !== svgRef);
    fs.writeFileSync(sbomPath, JSON.stringify(sbom));
    notice.sbom.sha256 = crypto.createHash('sha256').update(fs.readFileSync(sbomPath)).digest('hex');
    fs.writeFileSync(noticePath, JSON.stringify(notice));
    expect(() => validateVendorProvenance(noticePath)).toThrow(/verified component inventory.*pdfmake\.js/i);
  });
});

test('rejects coordinated replacement of an embedded PDF component license', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const [license] = notice.components.find(component => component.purl === 'pkg:npm/base64-js@1.5.1').licenseTexts;
    const replacement = 'rehashed replacement';
    fs.writeFileSync(path.join(root, license.path), replacement);
    license.sha256 = crypto.createHash('sha256').update(replacement).digest('hex');
    fs.writeFileSync(noticePath, JSON.stringify(notice));
    expect(() => validateVendorProvenance(noticePath)).toThrow(/package and license evidence.*pdfmake\.js/i);
  });
});

function writeRehashedSbom(root, noticePath, notice, sbom) {
  const sbomBytes = JSON.stringify(sbom);
  fs.writeFileSync(path.join(root, notice.sbom.path), sbomBytes);
  notice.sbom.sha256 = crypto.createHash('sha256').update(sbomBytes).digest('hex');
  fs.writeFileSync(noticePath, JSON.stringify(notice));
}

test.each([
  ['name', 'another-library'],
  ['version', '99.0.0'],
  ['attestation', { type: 'forged', lockPath: 'node_modules/unrelated' }],
])('rejects a rehashed notice and SBOM with a changed PDF component %s', (field, replacement) => {
  withVendorArtifact((root, noticePath, notice) => {
    const purl = 'pkg:npm/base64-js@1.5.1';
    const sbom = JSON.parse(fs.readFileSync(path.join(root, notice.sbom.path)));
    notice.components.find(component => component.purl === purl)[field] = replacement;
    if (field !== 'attestation') sbom.components.find(component => component.purl === purl)[field] = replacement;
    writeRehashedSbom(root, noticePath, notice, sbom);
    expect(() => validateVendorProvenance(noticePath)).toThrow(/package and license evidence.*pdfmake\.js/i);
  });
});

test('rejects the DOCX lock substituted for the PDF edge of a shared package', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const purl = 'pkg:npm/fflate@0.8.3';
    const docx = notice.assetAssessments.find(asset => asset.path === docxAsset);
    const pdf = notice.assetAssessments.find(asset => asset.path === pdfAsset);
    const docxProof = docx.componentAttestations?.find(entry => entry.purl === purl);
    const pdfProof = pdf.componentAttestations?.find(entry => entry.purl === purl);
    expect(docxProof).toMatchObject({
      lockFile: lockPath, lockSha256: policy.verifiedBundleInventories[docxAsset].lockSha256,
    });
    expect(pdfProof).toMatchObject({
      lockFile: 'vendor/pdfmake-build/npm-lock.json', lockSha256: policy.verifiedBundleInventories[pdfAsset].lockSha256,
    });

    const sbom = JSON.parse(fs.readFileSync(path.join(root, notice.sbom.path)));
    const sbomPdf = sbom.components.find(component => component['bom-ref'] === `urn:unfallatlas:vendor-asset:${pdfAsset}`);
    const property = sbomPdf.properties.find(item => item.name === 'unfallatlas:component-lock-attestations');
    expect(JSON.parse(property.value)).toEqual(pdf.componentAttestations);
    property.value = '[]';
    writeRehashedSbom(root, noticePath, notice, sbom);
    expect(() => validateVendorProvenance(noticePath)).toThrow(/SBOM delivered asset evidence mismatch.*pdfmake\.js/i);

    Object.assign(pdfProof, docxProof);
    property.value = JSON.stringify(pdf.componentAttestations);
    writeRehashedSbom(root, noticePath, notice, sbom);
    expect(() => validateVendorProvenance(noticePath)).toThrow(/package and license evidence.*pdfmake\.js/i);
  });
});

test('rejects a rehashed direct-package DOCX license replacement', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const docx = notice.dependencies.find(dependency => dependency.package === 'docx');
    const replacement = 'replacement owner license';
    fs.writeFileSync(path.join(root, docx.licenseTextPath), replacement);
    docx.licenseTextSha256 = crypto.createHash('sha256').update(replacement).digest('hex');
    fs.writeFileSync(noticePath, JSON.stringify(notice));
    expect(() => validateVendorProvenance(noticePath)).toThrow(/package and license evidence.*docx\.js/i);
  });
});
