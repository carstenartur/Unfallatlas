'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const {
  MediaExportProvenanceError,
  MediaProvenanceStore,
  sha256Buffer,
  stableJson,
  safeBaseName,
  verifyEncodedSourceBadge,
  createVideoMediaSidecar,
  createVideoMediaBundle,
} = require('../../server/media-export-provenance');

function manifest() {
  return {
    schemaVersion: 1,
    artifactId: 'media-bonn-test',
    generatedAt: '2026-07-23T03:30:00Z',
    applicationVersion: 'test-build',
    buildFingerprint: 'a'.repeat(64),
    dataFingerprint: 'b'.repeat(64),
    scenario: { city: 'Bonn', filters: {}, years: [2024] },
    sources: [{
      sourceId: 'accidents.unfallatlas',
      role: 'accidents',
      publisher: 'Statistische Ämter des Bundes und der Länder',
      datasetTitle: 'Unfallatlas Deutschland',
      datasetUrl: 'https://unfallatlas.statistikportal.de/',
      distributionUrl: 'https://unfallatlas.statistikportal.de/_downloads/',
      licenseId: 'DL-DE-BY-2.0',
      licenseName: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
      licenseUrl: 'https://www.govdata.de/dl-de/by-2-0',
      requiredAttribution: '© Statistische Ämter des Bundes und der Länder, Unfallatlas',
      retrievedAt: '2026-07-23T03:29:00Z',
      changedOrDerived: true,
      changeNotice: 'Räumlich und nach den gewählten Filtern ausgewählt.',
    }],
    transformations: [],
  };
}

function fixture(format = 'gif', bytes = Buffer.from('GIF89a-provenance-fixture')) {
  const digest = sha256Buffer(bytes);
  const extension = format === 'apng' ? 'png' : format;
  const contentType = format === 'apng' ? 'image/apng' : `image/${format}`;
  const evidence = {
    schemaVersion: 1,
    state: { canonical: { schemaVersion: 1, city: 'Bonn' }, sha256: 'c'.repeat(64) },
    build: { fingerprint: 'a'.repeat(64) },
    data: { fingerprint: 'b'.repeat(64) },
    artifact: {
      format,
      contentType,
      bytes: bytes.length,
      sha256: digest.hex,
      sha256Base64: digest.base64,
    },
    semantic: {
      lifecycle: { counts: { loaded: 12, filtered: 12, viewport: 12 } },
      framesAfterEncoding: { frameCount: 20 },
      preview: { localAccidents: 12 },
      pdf: { completed: true },
    },
  };
  const capture = {
    manifest: manifest(),
    sourceManifestSha256: 'd'.repeat(64),
    visibleBadge: {
      id: 'ua-video-source-provenance',
      text: 'Quelle: Statistische Ämter des Bundes und der Länder – Unfallatlas Deutschland · ' +
        'Lizenz: DL-DE-BY-2.0 · Manifest: dddddddddddd',
      rect: { x: 12, y: 670, width: 1256, height: 42 },
      borderColor: [255, 193, 7],
      backgroundColor: [0, 77, 64],
    },
  };
  const encoded = {
    verified: true,
    frameCount: 20,
    maxBorderPixels: 800,
    maxBackgroundPixels: 15_000,
    tolerance: 55,
    rect: capture.visibleBadge.rect,
  };
  const exportResult = { format, extension, contentType, evidence };
  return { bytes, digest, evidence, capture, encoded, exportResult };
}

describe('media export provenance sidecars', () => {
  test('builds a deterministic sidecar bound to artifact and SourceManifest hashes', () => {
    const value = fixture();
    const first = createVideoMediaSidecar(
      value.exportResult,
      value.capture,
      value.encoded,
      { baseName: 'Bonn Analyse' },
    );
    const second = createVideoMediaSidecar(
      value.exportResult,
      value.capture,
      value.encoded,
      { baseName: 'Bonn Analyse' },
    );

    expect(first).toEqual(second);
    expect(first.artifact.filename).toBe('Bonn-Analyse.gif');
    expect(first.artifact.sha256).toBe(value.digest.hex);
    expect(first.sourceManifestSha256).toBe('d'.repeat(64));
    expect(first.sourceManifest.scenario.years).toEqual([2024]);
    expect(first.visibleSourceBadge.encodedEvidence.verified).toBe(true);
    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    const { sha256, ...core } = first;
    expect(sha256Buffer(Buffer.from(stableJson(core), 'utf8')).hex).toBe(sha256);
  });

  test('creates a portable ZIP with exact media bytes, sidecar and README', async () => {
    const value = fixture('webp', Buffer.from('RIFF-fixture-WEBP-animation'));
    const sidecar = createVideoMediaSidecar(
      value.exportResult,
      value.capture,
      value.encoded,
    );
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-provenance-bundle-'));
    const mediaPath = path.join(tempDir, 'animation.webp');
    fs.writeFileSync(mediaPath, value.bytes);

    const bundle = createVideoMediaBundle(
      { ...value.exportResult, path: mediaPath },
      sidecar,
      { baseName: 'unfallatlas-analyse' },
    );
    const archive = await JSZip.loadAsync(bundle.buffer);
    const names = Object.keys(archive.files).sort();
    expect(names).toEqual([
      'README.txt',
      'unfallatlas-analyse.sources.json',
      'unfallatlas-analyse.webp',
    ]);
    const media = await archive.file('unfallatlas-analyse.webp').async('nodebuffer');
    const sidecarJson = JSON.parse(
      await archive.file('unfallatlas-analyse.sources.json').async('string')
    );
    const readme = await archive.file('README.txt').async('string');

    expect(media.equals(value.bytes)).toBe(true);
    expect(sha256Buffer(media).hex).toBe(sidecar.artifact.sha256);
    expect(sidecarJson).toEqual(sidecar);
    expect(readme).toContain(sidecar.sourceManifestSha256);
    expect(readme).toContain('Statistische Ämter des Bundes und der Länder');
    expect(bundle.sha256).toBe(sha256Buffer(bundle.buffer).hex);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('fails closed without verified encoded badge evidence', () => {
    const value = fixture();
    expect(() => createVideoMediaSidecar(
      value.exportResult,
      value.capture,
      { verified: false },
    )).toThrow(/unverified_visible_source_badge/);
  });

  test('rejects encoded-badge verification when the artifact is absent', async () => {
    await expect(verifyEncodedSourceBadge('/does/not/exist.gif', {
      rect: { x: 12, y: 670, width: 1256, height: 42 },
      borderColor: [255, 193, 7],
      backgroundColor: [0, 77, 64],
    })).rejects.toThrow(MediaExportProvenanceError);
  });

  test('retains sidecars for a bounded TTL and evicts oldest entries', () => {
    let now = 1000;
    const store = new MediaProvenanceStore({
      ttlMs: 100,
      maxEntries: 2,
      now: () => now,
    });
    const sidecars = ['1', '2', '3'].map((prefix, index) => {
      const value = fixture('gif', Buffer.from(`artifact-${index}`));
      const sidecar = createVideoMediaSidecar(value.exportResult, value.capture, value.encoded);
      return {
        ...sidecar,
        artifact: { ...sidecar.artifact, sha256: prefix.repeat(64) },
      };
    });

    store.put(sidecars[0]);
    store.put(sidecars[1]);
    store.put(sidecars[2]);
    expect(store.get('1'.repeat(64))).toBeNull();
    expect(store.get('2'.repeat(64))).toBe(sidecars[1]);
    expect(store.get('3'.repeat(64))).toBe(sidecars[2]);

    now += 101;
    expect(store.get('2'.repeat(64))).toBeNull();
    expect(store.get('3'.repeat(64))).toBeNull();
  });

  test('normalizes unsafe package base names', () => {
    expect(safeBaseName(' Bonn / Kreuzung: Test ')).toBe('Bonn-Kreuzung-Test');
    expect(safeBaseName('')).toBe('unfallatlas-analyse');
  });
});
