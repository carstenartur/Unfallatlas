/** @jest-environment node */
'use strict';

const provenance = require('../../scripts/vendor-exact-copy-provenance');

const ASSET_PATH = 'vendor/export/docx.js';
const ASSET_REF = `${provenance.ASSET_REF_PREFIX}${ASSET_PATH}`;
const PURL = 'pkg:npm/docx@9.7.1';
const SHA = 'a'.repeat(64);

function binding() {
  return Object.freeze({
    lockId: 'b'.repeat(64),
    bindings: Object.freeze([Object.freeze({
      path: ASSET_PATH,
      package: 'docx',
      bytes: 42,
      sha256: SHA,
      lockRef: 'export.docx.iife',
      componentPurl: PURL,
      exactCopy: Object.freeze({
        method: 'byte-for-byte-copy',
        input: Object.freeze({ sha256: SHA }),
        output: Object.freeze({ sha256: SHA }),
      }),
    })]),
  });
}

function sbom(hash = SHA) {
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    components: [
      { type: 'library', 'bom-ref': ` ${PURL} `, purl: PURL },
      {
        type: 'file',
        'bom-ref': ASSET_REF,
        hashes: [{ alg: 'SHA-256', content: hash }],
        properties: [],
      },
    ],
    dependencies: [{ ref: ASSET_REF, dependsOn: [] }],
  };
}

describe('vendor exact-copy review hardening', () => {
  test('normalizes component references before duplicate detection and lookup', () => {
    expect(provenance.componentRefs([
      { purl: ` ${PURL} ` },
    ], 'components', 'purl')).toEqual(new Set([PURL]));

    expect(() => provenance.componentRefs([
      { purl: PURL },
      { purl: ` ${PURL} ` },
    ], 'components', 'purl')).toThrow(/duplicate_component_ref/);
  });

  test('accepts a CycloneDX file component only when its SHA-256 matches the asset', () => {
    const output = provenance.bindSbom(sbom(), binding());
    const dependency = output.dependencies.find(entry => entry.ref === ASSET_REF);
    expect(dependency.dependsOn).toContain(PURL);
  });

  test('rejects CycloneDX file hash drift before adding exact-copy properties', () => {
    const value = sbom('c'.repeat(64));
    expect(() => provenance.bindSbom(value, binding())).toThrow(/sbom_asset_hash_drift/);
    expect(value.components.find(entry => entry['bom-ref'] === ASSET_REF).properties).toEqual([]);
  });

  test('rejects missing or ambiguous SHA-256 declarations', () => {
    const missing = sbom();
    delete missing.components.find(entry => entry['bom-ref'] === ASSET_REF).hashes;
    expect(() => provenance.bindSbom(missing, binding())).toThrow(/missing_sbom_asset_hash/);

    const duplicate = sbom();
    duplicate.components.find(entry => entry['bom-ref'] === ASSET_REF).hashes.push({
      alg: 'SHA_256',
      content: SHA,
    });
    expect(() => provenance.bindSbom(duplicate, binding())).toThrow(/ambiguous_sbom_asset_hash/);
  });
});
