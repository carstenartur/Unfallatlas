/** @jest-environment node */
'use strict';

const crypto = require('node:crypto');
const docx = require('docx');
const JSZip = require('jszip');
const provenance = require('../../js/ua.export_provenance');
const artifact = require('../../js/ua.artifact_provenance');
const source = require('../../js/ua.source_manifest');
const documentExport = require('../../js/ua.document_export_provenance');

const UA = { BUILD: '2026-07-19 00:00 UTC' };
const context = () => ({ CITY_RAW: 'Bonn', allPts: [] });
const fetchBuild = manifest => jest.fn(async () => ({ ok: true, json: async () => manifest }));
const hash = text => crypto.createHash('sha256').update(text).digest('hex');

test('one build response identifies the application and the selection transformation in both document formats', async () => {
  const build = { application: { name: 'fixture', version: '4.2.0-rc.1' }, fingerprint: 'a'.repeat(64) };
  const root = { fetch: fetchBuild(build) };
  const [manifest, other] = await Promise.all([context(), context()].map(ctx => provenance.createManifest(ctx, { root, UA })));
  expect(root.fetch).toHaveBeenCalledTimes(1);
  expect(manifest.applicationVersion).toBe('4.2.0-rc.1');
  expect(other.applicationVersion).toBe(manifest.applicationVersion);
  expect(manifest.transformations[0].softwareVersion).toBe(manifest.applicationVersion);
  expect(manifest.buildFingerprint).toBe(hash(source.stableStringify(build)));

  const view = documentExport.buildSourceView(await artifact.normalizeAndHash(manifest));
  expect(JSON.stringify(documentExport.buildPdfBodyNodes(view))).toContain('Anwendung: 4.2.0-rc.1');
  const file = new docx.Document({ sections: [{ children: documentExport.buildDocxBodyNodes(docx, view) }] });
  const archive = await JSZip.loadAsync(await docx.Packer.toBuffer(file));
  expect(await archive.file('word/document.xml').async('string')).toContain('Anwendung: 4.2.0-rc.1');
});

test('older build manifests retain their explicit fingerprint; offline labels cannot stand in for a version', async () => {
  const old = { buildFingerprint: 'b'.repeat(64), application: { version: '  ' } };
  const missingVersion = await provenance.createManifest(context(), { UA, root: { fetch: fetchBuild(old) } });
  expect(missingVersion.buildFingerprint).toBe(old.buildFingerprint);
  expect(missingVersion.applicationVersion).toBe('Version unbekannt');
  const offline = await provenance.createManifest(context(), { UA, root: { fetch: async () => { throw new Error('offline'); } } });
  expect(offline.buildFingerprint).toBe(hash(UA.BUILD));
  expect(offline.applicationVersion).toBe('Version unbekannt');

  const existing = { ...offline, applicationVersion: UA.BUILD };
  const fetch = jest.fn();
  const reopened = await provenance.createManifest({ exportSourceManifest: existing }, { UA, root: { fetch } });
  expect(reopened.applicationVersion).toBe(UA.BUILD);
  expect(fetch).not.toHaveBeenCalled();
});
