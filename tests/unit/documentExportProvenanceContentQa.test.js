'use strict';

function manifest() {
  return {
    schemaVersion: 1,
    artifactId: 'qa-document-export',
    generatedAt: '2026-07-22T12:00:00Z',
    applicationVersion: 'test-build',
    buildFingerprint: 'a'.repeat(64),
    dataFingerprint: 'b'.repeat(64),
    scenario: { city: 'Hannover', filters: {}, years: [2024] },
    sources: [{
      sourceId: 'accidents.test',
      role: 'accidents',
      publisher: 'Test publisher',
      datasetTitle: 'Test dataset',
      datasetUrl: 'https://example.com/dataset',
      licenseId: 'CC0-1.0',
      licenseName: 'Creative Commons CC0 1.0 Universal',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      retrievedAt: '2026-07-22T11:00:00Z',
      changedOrDerived: false,
    }],
    transformations: [],
  };
}

describe('document export provenance content QA', () => {
  beforeEach(() => {
    jest.resetModules();
    window.UA = {};
  });

  afterEach(() => {
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('runs the common export QA gate over the generated source section', async () => {
    const value = manifest();
    const gate = jest.fn(() => ({ ok: true }));
    const UA = {
      exportProvenanceRuntime: { createManifest: jest.fn(async () => value) },
      artifactProvenance: {
        normalizeAndHash: jest.fn(async () => ({
          manifest: value,
          sha256: 'c'.repeat(64),
        })),
      },
      runExportQAGate: gate,
    };
    const api = require('../../js/ua.document_export_provenance');

    const snapshot = await api.createSnapshot({}, UA, {});

    expect(snapshot.view.artifactId).toBe('qa-document-export');
    expect(gate).toHaveBeenCalledTimes(1);
    const qaTree = gate.mock.calls[0][0];
    expect(qaTree).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: api.SOURCE_HEADING }),
    ]));
    expect(JSON.stringify(qaTree)).toContain('Dokument-ID');
    expect(JSON.stringify(qaTree)).toContain('qa-document-export');
  });

  test('aborts before rendering when provenance text violates the publication gate', async () => {
    const value = manifest();
    value.sources[0].qualityNotes = ['Fetch is aborted'];
    const UA = {
      exportProvenanceRuntime: { createManifest: jest.fn(async () => value) },
      artifactProvenance: {
        normalizeAndHash: jest.fn(async () => ({
          manifest: value,
          sha256: 'c'.repeat(64),
        })),
      },
      runExportQAGate: jest.fn(() => ({
        ok: false,
        violations: [{ kind: 'phrase', sample: 'Fetch is aborted' }],
      })),
    };
    const api = require('../../js/ua.document_export_provenance');

    await expect(api.createSnapshot({}, UA, {}))
      .rejects.toThrow(/document_content_qa_failed/);
  });
});
