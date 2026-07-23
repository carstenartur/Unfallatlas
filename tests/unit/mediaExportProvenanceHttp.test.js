'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');
const {
  sha256Buffer,
  createVideoMediaSidecar,
  sharedMediaProvenanceStore,
} = require('../../server/media-export-provenance');
const {
  requestedPackaging,
  provenancePath,
  installMediaExportProvenanceHttp,
} = require('../../server/media-export-provenance-http');

function fixtureSidecar(bytes = Buffer.from('GIF89a-http-fixture')) {
  const digest = sha256Buffer(bytes);
  const manifest = {
    schemaVersion: 1,
    artifactId: 'media-http-test',
    generatedAt: '2026-07-23T04:00:00Z',
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
      licenseId: 'DL-DE-BY-2.0',
      licenseName: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
      licenseUrl: 'https://www.govdata.de/dl-de/by-2-0',
      retrievedAt: '2026-07-23T03:59:00Z',
      changedOrDerived: true,
    }],
    transformations: [],
  };
  const exportResult = {
    format: 'gif',
    extension: 'gif',
    contentType: 'image/gif',
    evidence: {
      artifact: {
        format: 'gif',
        contentType: 'image/gif',
        bytes: bytes.length,
        sha256: digest.hex,
        sha256Base64: digest.base64,
      },
      state: { canonical: { schemaVersion: 1, city: 'Bonn' }, sha256: 'c'.repeat(64) },
      build: { fingerprint: 'a'.repeat(64) },
      data: { fingerprint: 'b'.repeat(64) },
      semantic: { pdf: { completed: true } },
    },
  };
  const capture = {
    manifest,
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
  const sidecar = createVideoMediaSidecar(exportResult, capture, {
    verified: true,
    frameCount: 20,
    maxBorderPixels: 800,
    maxBackgroundPixels: 15_000,
    rect: capture.visibleBadge.rect,
  });
  return { bytes, digest, sidecar };
}

function fakeApp() {
  return {
    gets: [],
    uses: [],
    get(pathValue, handler) { this.gets.push({ path: pathValue, handler }); },
    use(handler) { this.uses.push(handler); },
  };
}

function fakeResponse() {
  const headers = new Map();
  const response = {
    headers,
    statusCode: 200,
    headersSent: false,
    body: null,
    sentFile: null,
    setHeader(name, value) { headers.set(String(name).toLowerCase(), String(value)); },
    getHeader(name) { return headers.get(String(name).toLowerCase()); },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; this.headersSent = true; return this; },
    send(value) { this.body = value; this.headersSent = true; return this; },
    sendFile(filePath, callback) {
      this.sentFile = filePath;
      this.headersSent = true;
      if (typeof callback === 'function') callback(null);
      return this;
    },
  };
  return response;
}

describe('media provenance HTTP integration', () => {
  test('parses packaging and builds stable sidecar paths', () => {
    expect(requestedPackaging({ query: {} })).toBe('binary');
    expect(requestedPackaging({ query: { packaging: 'ZIP' } })).toBe('zip');
    expect(provenancePath('a'.repeat(64)))
      .toBe(`/api/export-video/provenance/${'a'.repeat(64)}.json`);
  });

  test('serves the stored JSON sidecar with content digest', () => {
    const value = fixtureSidecar();
    sharedMediaProvenanceStore.put(value.sidecar);
    const app = fakeApp();
    installMediaExportProvenanceHttp(app);
    const route = app.gets.find(entry => entry.path.includes(':artifactSha.json'));
    const res = fakeResponse();

    route.handler({ params: { artifactSha: value.digest.hex } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('application/json');
    expect(res.getHeader('content-digest')).toMatch(/^sha-256=:/);
    const parsed = JSON.parse(Buffer.from(res.body).toString('utf8'));
    expect(parsed.artifact.sha256).toBe(value.digest.hex);
    expect(parsed.sourceManifestSha256).toBe('d'.repeat(64));
    expect(parsed.visibleSourceBadge.encodedEvidence.verified).toBe(true);
  });

  test('decorates the backward-compatible binary download with a describedby link', async () => {
    const value = fixtureSidecar();
    sharedMediaProvenanceStore.put(value.sidecar);
    const app = fakeApp();
    installMediaExportProvenanceHttp(app);
    const middleware = app.uses[0];
    const req = { method: 'POST', path: '/api/export-video', query: {} };
    const res = fakeResponse();
    let nextCalled = false;

    middleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);
    res.setHeader('X-Unfallatlas-Artifact-SHA256', value.digest.hex);
    const callback = jest.fn();
    res.sendFile('/tmp/unfallatlas.gif', callback);

    expect(res.sentFile).toBe('/tmp/unfallatlas.gif');
    expect(callback).toHaveBeenCalledWith(null);
    expect(res.getHeader('x-unfallatlas-source-manifest-sha256')).toBe('d'.repeat(64));
    expect(res.getHeader('x-unfallatlas-media-provenance-sha256')).toBe(value.sidecar.sha256);
    expect(res.getHeader('link')).toContain('rel="describedby"');
    expect(res.getHeader('x-unfallatlas-provenance-url'))
      .toBe(provenancePath(value.digest.hex));
  });

  test('returns a portable ZIP when packaging=zip', async () => {
    const value = fixtureSidecar(Buffer.from('GIF89a-zip-http-fixture'));
    sharedMediaProvenanceStore.put(value.sidecar);
    const app = fakeApp();
    installMediaExportProvenanceHttp(app);
    const middleware = app.uses[0];
    const req = { method: 'POST', path: '/api/export-video', query: { packaging: 'zip' } };
    const res = fakeResponse();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-http-zip-'));
    const mediaPath = path.join(tempDir, 'animation.gif');
    fs.writeFileSync(mediaPath, value.bytes);

    middleware(req, res, () => undefined);
    res.setHeader('X-Unfallatlas-Artifact-SHA256', value.digest.hex);
    const callback = jest.fn();
    res.sendFile(mediaPath, callback);
    await new Promise(resolve => queueMicrotask(resolve));

    expect(res.getHeader('content-type')).toBe('application/zip');
    expect(res.getHeader('x-unfallatlas-package-sha256')).toBe(sha256Buffer(res.body).hex);
    expect(callback).toHaveBeenCalledWith(null);
    const archive = await JSZip.loadAsync(Buffer.from(res.body));
    expect(archive.file('unfallatlas-analyse.gif')).not.toBeNull();
    expect(archive.file('unfallatlas-analyse.sources.json')).not.toBeNull();
    expect(archive.file('README.txt')).not.toBeNull();
    const embedded = await archive.file('unfallatlas-analyse.gif').async('nodebuffer');
    expect(embedded.equals(value.bytes)).toBe(true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects unsupported packaging before running the expensive export', () => {
    const app = fakeApp();
    installMediaExportProvenanceHttp(app);
    const res = fakeResponse();
    const next = jest.fn();
    app.uses[0]({
      method: 'POST',
      path: '/api/export-video',
      query: { packaging: 'tar' },
    }, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: 'unsupported_packaging',
      supportedPackaging: ['binary', 'zip'],
    });
  });

  test('fails closed if the route tries to send an artifact without a sidecar', async () => {
    const app = fakeApp();
    installMediaExportProvenanceHttp(app);
    const res = fakeResponse();
    app.uses[0]({ method: 'POST', path: '/api/export-video', query: {} }, res, () => undefined);
    res.setHeader('X-Unfallatlas-Artifact-SHA256', 'f'.repeat(64));
    const callback = jest.fn();

    res.sendFile('/tmp/untracked.gif', callback);
    await new Promise(resolve => queueMicrotask(resolve));

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('media_provenance_unavailable');
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      code: 'media_provenance_unavailable',
    }));
  });
});
