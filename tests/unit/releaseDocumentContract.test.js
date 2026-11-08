'use strict';

const {
  auditRenderedDocument
} = require('../../scripts/rendered-document-audit');
function model(extra = {}) {
  return {
    documentId: 'release',
    renderer: 'test',
    pages: [{
      number: 1,
      width: 595,
      height: 842,
      words: [{
        text: 'Readable release evidence document',
        xMin: 30,
        yMin: 30,
        xMax: 300,
        yMax: 50
      }],
      images: [],
      headings: [],
      links: [],
      tableRows: []
    }],
    ...extra
  };
}
test('release contract fails closed on missing or mismatched independently observed manifest hash', () => {
  const base = {
    requireSourceManifestHash: true,
    expectedSourceManifestHash: 'a'.repeat(64)
  };
  expect(auditRenderedDocument(model(base)).issues.some(x => x.code === 'source_manifest_missing')).toBe(true);
  expect(auditRenderedDocument(model({
    ...base,
    sourceManifestHash: 'b'.repeat(64)
  })).issues.some(x => x.code === 'source_manifest_mismatch')).toBe(true);
  expect(auditRenderedDocument(model({
    ...base,
    sourceManifestHash: 'a'.repeat(64)
  })).issues.some(x => x.code.startsWith('source_manifest_'))).toBe(false);
});
test('generic smoke documents do not acquire an implicit release claim', () => {
  expect(auditRenderedDocument(model()).issues.some(x => x.code.startsWith('source_manifest_'))).toBe(false);
});
