'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const captureStorage = new AsyncLocalStorage();
const PAGE_MARKER = Symbol.for('unfallatlas.mediaProvenanceCapturePage');
const SOURCE_BADGE_ID = 'ua-video-source-provenance';
const SOURCE_BADGE_BORDER = Object.freeze([255, 193, 7]);
const SOURCE_BADGE_BACKGROUND = Object.freeze([0, 77, 64]);
const DEFAULT_CAPTURE_TIMEOUT_MS = 180_000;

class MediaProvenanceCaptureError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'MediaProvenanceCaptureError';
    this.code = code;
    this.status = 422;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new MediaProvenanceCaptureError(code, message, details);
}

function timeoutValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 30_000
    ? Math.min(parsed, 10 * 60_000)
    : DEFAULT_CAPTURE_TIMEOUT_MS;
}

function sourceLabel(manifest, hash) {
  const source = Array.isArray(manifest && manifest.sources)
    ? manifest.sources.find(item => item && item.role === 'accidents') || manifest.sources[0]
    : null;
  if (!source) fail('missing_media_source', 'Media provenance requires at least one source');
  const publisher = String(source.publisher || '').trim();
  const dataset = String(source.datasetTitle || '').trim();
  const license = String(source.licenseId || source.licenseName || '').trim();
  if (!publisher || !dataset || !license) {
    fail('incomplete_media_source', 'Publisher, dataset and licence are required for the visible media badge');
  }
  return [
    `Quelle: ${publisher} – ${dataset}`,
    `Lizenz: ${license}`,
    `Manifest: ${String(hash).slice(0, 12)}`,
  ].join(' · ');
}

async function captureFromPage(page, context) {
  const timeoutMs = timeoutValue(context.options && context.options.timeoutMs);
  await page.waitForSelector('#ua-video-semantic-evidence', {
    state: 'attached',
    timeout: timeoutMs,
  });
  await page.waitForFunction(() => Boolean(window.UA && window.UA.exportProvenanceReady), null, {
    timeout: timeoutMs,
  });

  const result = await page.evaluate(async ({
    badgeId,
    border,
    background,
  }) => {
    const UA = window.UA;
    await UA.exportProvenanceReady;
    if (UA.exportProvenanceError) throw UA.exportProvenanceError;
    if (!UA.documentExportProvenanceRuntime ||
        typeof UA.documentExportProvenanceRuntime.createSnapshot !== 'function') {
      throw new Error('Document SourceManifest runtime is unavailable for media capture');
    }
    const ctx = typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null;
    if (!ctx) throw new Error('Runtime context is unavailable for media capture');
    const snapshot = await UA.documentExportProvenanceRuntime.createSnapshot(ctx);
    const manifest = snapshot && snapshot.manifest;
    const source = Array.isArray(manifest && manifest.sources)
      ? manifest.sources.find(item => item && item.role === 'accidents') || manifest.sources[0]
      : null;
    if (!source) throw new Error('SourceManifest contains no media source');
    const publisher = String(source.publisher || '').trim();
    const dataset = String(source.datasetTitle || '').trim();
    const license = String(source.licenseId || source.licenseName || '').trim();
    if (!publisher || !dataset || !license) {
      throw new Error('SourceManifest media source is incomplete');
    }
    const label = [
      `Quelle: ${publisher} – ${dataset}`,
      `Lizenz: ${license}`,
      `Manifest: ${String(snapshot.sourceManifestSha256 || '').slice(0, 12)}`,
    ].join(' · ');

    document.getElementById(badgeId)?.remove();
    const badge = document.createElement('div');
    badge.id = badgeId;
    badge.dataset.sourceManifestSha256 = String(snapshot.sourceManifestSha256 || '');
    badge.textContent = label;
    Object.assign(badge.style, {
      position: 'fixed',
      left: '12px',
      right: '12px',
      bottom: '8px',
      zIndex: '2147483647',
      boxSizing: 'border-box',
      padding: '7px 10px',
      border: `3px solid rgb(${border.join(', ')})`,
      borderRadius: '5px',
      background: `rgb(${background.join(', ')})`,
      color: 'white',
      font: '700 13px/1.25 system-ui, sans-serif',
      letterSpacing: '0.01em',
      pointerEvents: 'none',
      whiteSpace: 'normal',
    });
    document.body.appendChild(badge);
    const rect = badge.getBoundingClientRect();
    return {
      manifest,
      sourceManifestSha256: snapshot.sourceManifestSha256,
      visibleBadge: {
        id: badgeId,
        text: label,
        rect: {
          x: Number(rect.x),
          y: Number(rect.y),
          width: Number(rect.width),
          height: Number(rect.height),
        },
        borderColor: border,
        backgroundColor: background,
      },
    };
  }, {
    badgeId: SOURCE_BADGE_ID,
    border: SOURCE_BADGE_BORDER,
    background: SOURCE_BADGE_BACKGROUND,
  });

  if (!result || !result.manifest ||
      !/^[a-f0-9]{64}$/.test(String(result.sourceManifestSha256 || ''))) {
    fail('invalid_media_manifest', 'Browser media capture returned an invalid SourceManifest snapshot');
  }
  const expectedLabel = sourceLabel(result.manifest, result.sourceManifestSha256);
  if (!result.visibleBadge || result.visibleBadge.text !== expectedLabel) {
    fail('media_badge_mismatch', 'Visible source badge does not match the captured SourceManifest');
  }
  return result;
}

function attachPageToMediaProvenanceCapture(page, logger = console) {
  const context = captureStorage.getStore();
  if (!context || !page || typeof page.goto !== 'function') return page;
  if (page[PAGE_MARKER]) return page;

  const originalGoto = page.goto.bind(page);
  page.goto = async function gotoWithMediaProvenance(...args) {
    const response = await originalGoto(...args);
    if (!context.snapshotPromise) {
      context.snapshotPromise = captureFromPage(page, context).catch(error => {
        logger.error?.('[media-provenance] capture failed:', error);
        throw error;
      });
    }
    return response;
  };
  Object.defineProperty(page, PAGE_MARKER, { value: true });
  return page;
}

async function runWithMediaProvenanceCapture(options, task) {
  if (typeof task !== 'function') fail('invalid_capture_task', 'Media provenance capture task is required');
  const context = {
    options: Object.freeze({ ...(options || {}) }),
    snapshotPromise: null,
  };
  return captureStorage.run(context, async () => {
    const result = await task();
    if (!context.snapshotPromise) {
      fail('media_capture_not_started', 'No Playwright page was attached to the media provenance capture');
    }
    let capture;
    try {
      capture = await context.snapshotPromise;
    } catch (error) {
      if (result && result.path) {
        try { require('fs').unlinkSync(result.path); } catch (_) { /* ignore */ }
      }
      throw error;
    }
    return { result, capture };
  });
}

module.exports = {
  DEFAULT_CAPTURE_TIMEOUT_MS,
  SOURCE_BADGE_ID,
  SOURCE_BADGE_BORDER,
  SOURCE_BADGE_BACKGROUND,
  MediaProvenanceCaptureError,
  sourceLabel,
  captureFromPage,
  attachPageToMediaProvenanceCapture,
  runWithMediaProvenanceCapture,
};
