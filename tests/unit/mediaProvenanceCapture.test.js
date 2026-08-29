'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  SOURCE_BADGE_ID,
  SOURCE_BADGE_RECORDING_HOLD_MS,
  MediaProvenanceCaptureError,
  sourceLabel,
  captureFromPage,
  attachPageToMediaProvenanceCapture,
  waitForMediaProvenanceCapture,
  runWithMediaProvenanceCapture,
} = require('../../server/media-provenance-capture');

function validManifest() {
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
      licenseId: 'DL-DE-BY-2.0',
      licenseName: 'Datenlizenz Deutschland – Namensnennung – Version 2.0',
      licenseUrl: 'https://www.govdata.de/dl-de/by-2-0',
      retrievedAt: '2026-07-23T03:29:00Z',
      changedOrDerived: true,
    }],
    transformations: [],
  };
}

function validCapture() {
  const manifest = validManifest();
  const hash = 'c'.repeat(64);
  return {
    manifest,
    sourceManifestSha256: hash,
    visibleBadge: {
      id: SOURCE_BADGE_ID,
      text: sourceLabel(manifest, hash),
      sourceWidth: 1280,
      sourceHeight: 720,
      rect: { x: 12, y: 676, width: 1256, height: 36 },
      borderColor: [255, 193, 7],
      backgroundColor: [0, 77, 64],
    },
  };
}

function fakePage(capture = validCapture()) {
  const browserContext = {
    close: jest.fn(async () => undefined),
  };
  return {
    goto: jest.fn(async () => ({ ok: true })),
    waitForSelector: jest.fn(async () => undefined),
    waitForFunction: jest.fn(async () => undefined),
    evaluate: jest.fn(async () => capture),
    waitForTimeout: jest.fn(async () => undefined),
    context: jest.fn(() => browserContext),
    browserContext,
  };
}

describe('media SourceManifest browser capture', () => {
  test('builds the visible source label only from the captured manifest', () => {
    const manifest = validManifest();
    const hash = 'd'.repeat(64);
    expect(sourceLabel(manifest, hash)).toBe(
      'Quelle: Statistische Ämter des Bundes und der Länder – Unfallatlas Deutschland · ' +
      'Lizenz: DL-DE-BY-2.0 · Manifest: dddddddddddd'
    );
  });

  test('fails closed when the visible source record is incomplete', () => {
    const manifest = validManifest();
    manifest.sources[0].licenseId = '';
    manifest.sources[0].licenseName = '';
    expect(() => sourceLabel(manifest, 'e'.repeat(64))).toThrow(MediaProvenanceCaptureError);
  });

  test('accepts only a valid snapshot whose visible badge matches the manifest', async () => {
    const capture = validCapture();
    const page = fakePage(capture);

    await expect(captureFromPage(page, { options: {} })).resolves.toEqual(capture);
    expect(page.waitForSelector).toHaveBeenCalledWith('#ua-video-semantic-evidence', {
      state: 'attached',
      timeout: 180_000,
    });
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test('binds one asynchronous page capture to the surrounding video export', async () => {
    const capture = validCapture();
    const page = fakePage(capture);
    const originalGoto = page.goto;
    const result = { path: '/tmp/media.gif', format: 'gif' };

    const wrapped = await runWithMediaProvenanceCapture({}, async () => {
      attachPageToMediaProvenanceCapture(page, { error: jest.fn() });
      await page.goto('http://localhost:8000/werkbank_v2.html');
      return result;
    });

    expect(wrapped).toEqual({ result, capture });
    expect(originalGoto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test('waits for the visible source badge and records it before closing the browser context', async () => {
    const capture = validCapture();
    const page = fakePage(capture);
    const originalClose = page.browserContext.close;
    let resolveCapture;
    page.evaluate.mockImplementationOnce(() => new Promise(resolve => {
      resolveCapture = resolve;
    }));
    const result = { path: '/tmp/media.gif', format: 'gif' };

    const wrapped = runWithMediaProvenanceCapture({}, async () => {
      attachPageToMediaProvenanceCapture(page, { error: jest.fn() });
      await page.goto('http://localhost:8000/werkbank_v2.html');

      const closePromise = page.browserContext.close();
      await new Promise(resolve => setImmediate(resolve));
      expect(typeof resolveCapture).toBe('function');
      expect(originalClose).not.toHaveBeenCalled();

      resolveCapture(capture);
      await closePromise;
      expect(page.waitForTimeout).toHaveBeenCalledWith(SOURCE_BADGE_RECORDING_HOLD_MS);
      expect(originalClose).toHaveBeenCalledTimes(1);
      return result;
    });

    await expect(wrapped).resolves.toEqual({ result, capture });
  });

  test('is idempotent when the runtime sees the same page twice', async () => {
    const page = fakePage();
    const originalGoto = page.goto;
    const wrappedClose = page.browserContext.close;
    await runWithMediaProvenanceCapture({}, async () => {
      const first = attachPageToMediaProvenanceCapture(page);
      const firstClose = page.browserContext.close;
      const second = attachPageToMediaProvenanceCapture(page);
      expect(second).toBe(first);
      expect(page.browserContext.close).toBe(firstClose);
      expect(page.browserContext.close).not.toBe(wrappedClose);
      await page.goto('http://localhost:8000/werkbank_v2.html');
      return { path: '/tmp/media.webp' };
    });
    expect(originalGoto).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  test('does not require provenance capture for direct base-export callers', async () => {
    await expect(waitForMediaProvenanceCapture(fakePage())).resolves.toBeNull();
  });

  test('removes a generated artifact when provenance capture fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-capture-test-'));
    const artifactPath = path.join(tempDir, 'broken.gif');
    fs.writeFileSync(artifactPath, Buffer.from('GIF89a'));
    const page = fakePage({ manifest: null, sourceManifestSha256: 'broken' });

    await expect(runWithMediaProvenanceCapture({}, async () => {
      attachPageToMediaProvenanceCapture(page, { error: jest.fn() });
      await page.goto('http://localhost:8000/werkbank_v2.html');
      return { path: artifactPath };
    })).rejects.toThrow(/invalid_media_manifest/);

    expect(fs.existsSync(artifactPath)).toBe(false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('rejects a task that never creates a Playwright page', async () => {
    await expect(runWithMediaProvenanceCapture({}, async () => ({ path: '/tmp/none.gif' })))
      .rejects.toThrow(/media_capture_not_started/);
  });
});
