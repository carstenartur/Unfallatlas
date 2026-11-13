'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { copyVendorAssets, copyVendorLicenses } = require('../../scripts/build-site');
const { docxSourcePackages, verifyLeafletImageModules } = require('../../scripts/vendor-provenance');
const { validatePolicyBinding, validateVendorProvenance } = require('../../scripts/validate-vendor-provenance');

const repoRoot = path.resolve(__dirname, '../..');
const policy = require('../../vendor/provenance-policy.json');
const docxAsset = 'vendor/export/docx.js';
const bundlePath = 'node_modules/docx/dist/index.iife.js';
const lockPath = 'vendor/docx-build/npm-lock.json.gz';
const pdfAsset = 'vendor/export/pdfmake.js';
const svgRef = 'urn:unfallatlas:vendor-source:pdfmake:svg-to-pdfkit';
const leafletImageAsset = 'vendor/leaflet-image/leaflet-image.js';
const leafletImagePurl = 'pkg:npm/leaflet-image@0.4.0';
const d3QueuePurl = 'pkg:npm/d3-queue@2.0.3';

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

test('publishes the exact source evidence for both Leaflet-image Browserify modules', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const asset = notice.assetAssessments.find(entry => entry.path === leafletImageAsset);
    expect(asset).toMatchObject({
      contains: [d3QueuePurl, leafletImagePurl],
      reproducible: false,
      provenanceComplete: false,
      gaps: ['leaflet-image-embedded-d3-queue'],
      componentAttestations: [
        {
          purl: leafletImagePurl, lockFile: 'package-lock.json', lockPath: 'node_modules/leaflet-image',
          source: {
            path: 'node_modules/leaflet-image/index.js',
            sha256: 'c3bb8b9abfb441bc07da76f5951b00eb27920fd7ee3fb2f2e5688c018b2b36b5',
          },
        },
        {
          purl: d3QueuePurl, lockFile: 'package-lock.json', lockPath: 'node_modules/d3-queue',
          source: {
            path: 'node_modules/d3-queue/build/d3-queue.js',
            sha256: 'ebcbfbced3793cfa6dfc0469c216770618c4b493f261bdb79bff58a82e4f50a4',
          },
        },
      ],
    });
    const owner = notice.components.find(component => component.purl === leafletImagePurl);
    expect(owner.licenseTexts).toEqual([{
      path: 'vendor/licenses/leaflet-image.txt',
      sha256: '10ec4a19b848ec18b5314e34794fb307b375ce2719a5149f79669d3648eeff95',
      copyrightIncluded: true,
    }]);
    const queue = notice.components.find(component => component.purl === d3QueuePurl);
    expect(queue.licenseTexts).toEqual([{
      path: 'vendor/licenses/components/d3-queue-2.0.3-LICENSE.txt',
      sha256: 'f037f99927dd7415275d1d14a4f4c7e162861594583ef255b1a28cb0716e1cfe',
      copyrightIncluded: true,
    }]);

    const sbom = JSON.parse(fs.readFileSync(path.join(root, notice.sbom.path)));
    const assetRef = `urn:unfallatlas:vendor-asset:${leafletImageAsset}`;
    const property = sbom.components.find(component => component['bom-ref'] === assetRef)
      .properties.find(item => item.name === 'unfallatlas:component-lock-attestations');
    expect(JSON.parse(property.value)).toEqual(asset.componentAttestations);
    expect(sbom.dependencies.find(entry => entry.ref === assetRef).dependsOn).toEqual(asset.contains);
  });
});

test.each([
  'node_modules/leaflet-image/index.js',
  'node_modules/d3-queue/build/d3-queue.js',
])('rejects a rehashed %s when its Browserify module bytes differ', sourcePath => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-leaflet-image-modules-'));
  try {
    const inventory = JSON.parse(JSON.stringify(policy.verifiedBundleInventories[leafletImageAsset]));
    const inputs = ['node_modules/leaflet-image/leaflet-image.js', ...inventory.browserifyModules.map(module => module.path)];
    for (const input of inputs) {
      fs.mkdirSync(path.dirname(path.join(root, input)), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, input), path.join(root, input));
    }
    const source = path.join(root, sourcePath);
    fs.appendFileSync(source, '\n// changed source\n');
    inventory.browserifyModules.find(module => module.path === sourcePath).sha256 =
      crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    expect(() => verifyLeafletImageModules(root, inventory)).toThrow(/Browserify module differs from the pinned source/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a rehashed Leaflet-image bundle with changed bytes', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const sbom = JSON.parse(fs.readFileSync(path.join(root, notice.sbom.path)));
    const bundlePath = path.join(root, leafletImageAsset);
    fs.appendFileSync(bundlePath, '\n// changed bundle\n');
    const bytes = fs.readFileSync(bundlePath);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const asset = notice.assetAssessments.find(entry => entry.path === leafletImageAsset);
    Object.assign(asset, { bytes: bytes.length, sha256 });
    sbom.components.find(component => component['bom-ref'] === `urn:unfallatlas:vendor-asset:${leafletImageAsset}`)
      .hashes[0].content = sha256;

    writeRehashedSbom(root, noticePath, notice, sbom);
    expect(() => validateVendorProvenance(noticePath)).toThrow(/verified component inventory.*leaflet-image\.js/i);
  });
});

test('rejects coordinated removal of d3-queue from the Leaflet-image inventory', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const sbom = JSON.parse(fs.readFileSync(path.join(root, notice.sbom.path)));
    const assetRef = `urn:unfallatlas:vendor-asset:${leafletImageAsset}`;
    const asset = notice.assetAssessments.find(entry => entry.path === leafletImageAsset);
    asset.contains = [leafletImagePurl];
    notice.components = notice.components.filter(component => component.purl !== d3QueuePurl);
    sbom.components = sbom.components.filter(component => component['bom-ref'] !== d3QueuePurl);
    sbom.dependencies.find(entry => entry.ref === assetRef).dependsOn = asset.contains;
    asset.componentAttestations = asset.componentAttestations.filter(entry => entry.purl !== d3QueuePurl);
    sbom.components.find(component => component['bom-ref'] === assetRef)
      .properties.find(item => item.name === 'unfallatlas:component-lock-attestations').value =
      JSON.stringify(asset.componentAttestations);

    writeRehashedSbom(root, noticePath, notice, sbom);
    expect(() => validateVendorProvenance(noticePath)).toThrow(/verified component inventory.*leaflet-image\.js/i);
  });
});

test('rejects a rehashed Leaflet-image module source hash in both the notice and the SBOM', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const sbom = JSON.parse(fs.readFileSync(path.join(root, notice.sbom.path)));
    const asset = notice.assetAssessments.find(entry => entry.path === leafletImageAsset);
    asset.componentAttestations.find(entry => entry.purl === d3QueuePurl).source.sha256 = 'a'.repeat(64);
    sbom.components.find(component => component['bom-ref'] === `urn:unfallatlas:vendor-asset:${leafletImageAsset}`)
      .properties.find(item => item.name === 'unfallatlas:component-lock-attestations').value =
      JSON.stringify(asset.componentAttestations);

    writeRehashedSbom(root, noticePath, notice, sbom);
    expect(() => validateVendorProvenance(noticePath)).toThrow(/package and license evidence.*leaflet-image\.js/i);
  });
});

test('rejects a rehashed d3-queue license replacement', () => {
  withVendorArtifact((root, noticePath, notice) => {
    const [license] = notice.components.find(component => component.purl === d3QueuePurl).licenseTexts;
    const replacement = 'rehashed replacement';
    fs.writeFileSync(path.join(root, license.path), replacement);
    license.sha256 = crypto.createHash('sha256').update(replacement).digest('hex');
    fs.writeFileSync(noticePath, JSON.stringify(notice));
    expect(() => validateVendorProvenance(noticePath)).toThrow(/component or license.*d3-queue/i);
  });
});

test.each([
  [d3QueuePurl, [{ expression: 'BSD-3-Clause' }, { license: { id: 'MIT' } }]],
  [leafletImagePurl, [{ expression: 'BSD-2-Clause', license: { id: 'MIT' } }]],
])('rejects an extra license claim for %s in a rehashed SBOM', (purl, licenses) => {
  withVendorArtifact((root, noticePath, notice) => {
    const sbom = JSON.parse(fs.readFileSync(path.join(root, notice.sbom.path)));
    sbom.components.find(component => component.purl === purl).licenses = licenses;
    writeRehashedSbom(root, noticePath, notice, sbom);
    expect(() => validateVendorProvenance(noticePath)).toThrow(`SBOM component evidence mismatch: ${purl}`);
  });
});

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
