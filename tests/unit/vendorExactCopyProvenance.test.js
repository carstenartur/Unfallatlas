/** @jest-environment node */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const exactCopyManifest = require('../../scripts/vendor-exact-copy-manifest');
const provenance = require('../../scripts/vendor-exact-copy-provenance');

const LOCK_ID = '1'.repeat(64);
const ASSET_SHA = '2'.repeat(64);
const LOCK_SHA = '3'.repeat(64);
const DATA_SHA = '4'.repeat(64);
const PURL = 'pkg:npm/docx@9.7.1';
const ASSET_PATH = 'vendor/export/docx.js';
const LOCK_REF = 'export.docx.iife';

function exactCopy() {
  return {
    type: 'vendor-build-lock-reference',
    schemaVersion: 1,
    lockId: LOCK_ID,
    lockRef: LOCK_REF,
    method: 'byte-for-byte-copy',
    componentPurl: PURL,
    input: { path: 'dist/index.iife.js', bytes: 5, sha256: ASSET_SHA },
    auxiliaryInputs: [],
    output: { path: ASSET_PATH, bytes: 5, sha256: ASSET_SHA },
  };
}

function summary() {
  return {
    lockRef: LOCK_REF,
    path: ASSET_PATH,
    componentPurl: PURL,
    inputSha256: ASSET_SHA,
    outputSha256: ASSET_SHA,
  };
}

function fixtureObjects() {
  const summaries = [summary()];
  const bindingFingerprint = provenance.sha256Buffer(
    Buffer.from(exactCopyManifest.stableJson(summaries)),
  );
  const manifest = {
    schemaVersion: 1,
    application: { name: 'fixture', version: '1', fingerprint: '5'.repeat(64) },
    dependencies: { docx: '9.7.1' },
    vendorAssets: [{
      package: 'docx',
      version: '9.7.1',
      purl: PURL,
      sourcePath: 'dist/index.iife.js',
      path: ASSET_PATH,
      bytes: 5,
      sha256: ASSET_SHA,
      exactCopy: exactCopy(),
    }],
    vendorExactCopyLock: {
      schemaVersion: 1,
      type: 'unfallatlas-vendor-exact-copy-manifest-binding',
      path: 'vendor/exact-copy-lock.json',
      sha256: LOCK_SHA,
      lockId: LOCK_ID,
      operationCount: 1,
      coveredAssetCount: 1,
      assetBindingFingerprint: bindingFingerprint,
      assetBindings: summaries,
    },
    thirdPartyNotices: {
      path: 'vendor/third-party-notices.json',
      sha256: null,
      complete: false,
    },
    data: { fingerprint: DATA_SHA },
    networkPolicy: { runtimeLibraries: 'local-only' },
    fingerprint: '6'.repeat(64),
  };
  const notice = {
    schemaVersion: 2,
    complete: false,
    components: [{ name: 'docx', version: '9.7.1', purl: PURL }],
    assetAssessments: [{
      path: ASSET_PATH,
      package: 'docx',
      bytes: 5,
      sha256: ASSET_SHA,
      contains: [],
    }],
    sbom: {
      path: 'vendor/sbom.cdx.json',
      sha256: null,
      specVersion: '1.6',
      complete: false,
    },
  };
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    components: [
      { type: 'library', 'bom-ref': PURL, name: 'docx', version: '9.7.1', purl: PURL },
      {
        type: 'file',
        'bom-ref': `${provenance.ASSET_REF_PREFIX}${ASSET_PATH}`,
        name: 'docx.js',
        hashes: [{ alg: 'SHA-256', content: ASSET_SHA }],
        properties: [],
      },
    ],
    dependencies: [{
      ref: `${provenance.ASSET_REF_PREFIX}${ASSET_PATH}`,
      dependsOn: [],
    }],
    compositions: [{ aggregate: 'incomplete' }],
  };
  return { manifest, notice, sbom };
}

function writeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-exact-copy-provenance-'));
  fs.mkdirSync(path.join(root, 'vendor', 'export'), { recursive: true });
  fs.writeFileSync(path.join(root, ASSET_PATH), 'asset');
  fs.writeFileSync(path.join(root, 'vendor', 'exact-copy-lock.json'), '{"lock":true}\n');
  const values = fixtureObjects();
  const sbomFile = path.join(root, 'vendor', 'sbom.cdx.json');
  fs.writeFileSync(sbomFile, provenance.serialiseJson(values.sbom));
  values.notice.sbom.sha256 = provenance.sha256File(sbomFile);
  const noticeFile = path.join(root, 'vendor', 'third-party-notices.json');
  fs.writeFileSync(noticeFile, provenance.serialiseJson(values.notice));
  values.manifest.thirdPartyNotices.sha256 = provenance.sha256File(noticeFile);
  fs.writeFileSync(path.join(root, 'build-manifest.json'), provenance.serialiseJson(values.manifest));
  return { root, ...values };
}

function clean(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

describe('vendor exact-copy provenance propagation', () => {
  test('binds notice and CycloneDX evidence and refreshes every dependent hash', () => {
    const fixture = writeFixture();
    try {
      const result = provenance.bindExactCopyProvenance({ outputRoot: fixture.root });
      expect(result.bindingCount).toBe(1);

      const notice = JSON.parse(fs.readFileSync(result.noticePath, 'utf8'));
      const assessment = notice.assetAssessments[0];
      expect(assessment.contains).toContain(PURL);
      expect(assessment.exactCopy.lockRef).toBe(LOCK_REF);
      expect(notice.vendorExactCopyLock.assetBindings).toEqual([summary()]);

      const sbom = JSON.parse(fs.readFileSync(result.sbomPath, 'utf8'));
      const assetRef = `${provenance.ASSET_REF_PREFIX}${ASSET_PATH}`;
      expect(sbom.dependencies.find(entry => entry.ref === assetRef).dependsOn).toContain(PURL);
      const fileComponent = sbom.components.find(entry => entry['bom-ref'] === assetRef);
      const properties = Object.fromEntries(fileComponent.properties.map(entry => [entry.name, entry.value]));
      expect(properties['unfallatlas:exact-copy-lock-ref']).toBe(LOCK_REF);
      expect(properties['unfallatlas:exact-copy-output-sha256']).toBe(ASSET_SHA);

      const manifest = JSON.parse(fs.readFileSync(result.manifestPath, 'utf8'));
      expect(manifest.thirdPartyNotices.sha256).toBe(provenance.sha256File(result.noticePath));
      expect(manifest.thirdPartyNotices.sbom.sha256).toBe(provenance.sha256File(result.sbomPath));
      expect(manifest.thirdPartyNotices.vendorExactCopyLock.lockId).toBe(LOCK_ID);
      expect(manifest.application.fingerprint)
        .toBe(exactCopyManifest.fingerprintApplicationFiles(fixture.root).fingerprint);
      expect(manifest.fingerprint).toBe(exactCopyManifest.recomputeOverallFingerprint(manifest));
    } finally {
      clean(fixture.root);
    }
  });

  test('rejects a summary that no longer describes the delivered asset binding', () => {
    const { manifest } = fixtureObjects();
    manifest.vendorExactCopyLock.assetBindings[0].outputSha256 = '9'.repeat(64);
    expect(() => provenance.collectBindings(manifest)).toThrow(/binding_summary_mismatch/);
  });

  test('requires referenced components in both notices and CycloneDX', () => {
    const values = fixtureObjects();
    const binding = provenance.collectBindings(values.manifest);
    values.notice.components = [];
    expect(() => provenance.bindNotice(values.notice, binding)).toThrow(/missing_notice_component/);

    const second = fixtureObjects();
    const secondBinding = provenance.collectBindings(second.manifest);
    second.sbom.components = second.sbom.components.filter(entry => entry['bom-ref'] !== PURL);
    expect(() => provenance.bindSbom(second.sbom, secondBinding)).toThrow(/missing_sbom_component/);
  });

  test('restores every original file after a mid-installation failure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-provenance-rollback-'));
    const files = ['a.json', 'b.json', 'c.json'].map((name, index) => {
      const file = path.join(root, name);
      fs.writeFileSync(file, provenance.serialiseJson({ original: index }));
      return file;
    });
    let renames = 0;
    try {
      expect(() => provenance.replaceFilesAtomically(
        files.map((file, index) => ({ file, value: { replacement: index } })),
        {
          renameSync(from, to) {
            renames += 1;
            if (renames === 4) throw new Error('injected installation failure');
            fs.renameSync(from, to);
          },
        },
      )).toThrow(/injected installation failure/);
      files.forEach((file, index) => {
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ original: index });
      });
      expect(fs.readdirSync(root).sort()).toEqual(['a.json', 'b.json', 'c.json']);
    } finally {
      clean(root);
    }
  });
});
