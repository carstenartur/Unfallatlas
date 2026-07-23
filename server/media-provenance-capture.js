'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const mediaProvenanceBadge = require('../js/ua.media_provenance_badge');

const captureStorage = new AsyncLocalStorage();
const PAGE_MARKER = Symbol.for('unfallatlas.mediaProvenanceCapturePage');
const SOURCE_BADGE_ID = 'ua-video-source-provenance';
const SOURCE_BADGE_BORDER = mediaProvenanceBadge.BORDER_COLOR;
const SOURCE_BADGE_BACKGROUND = mediaProvenanceBadge.BACKGROUND_COLOR;
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
  try {
    return mediaProvenanceBadge.sourceLabel(manifest, hash);
  } catch (error) {
    fail(error.code || 'invalid_media_source', error.message || String(error), error.details || null);
  }
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

  const result = await page.evaluate(async ({ badgeId }) => {
    const UA = window.UA;
    await UA.exportProvenanceReady;
    if (UA.exportProvenanceError) throw UA.exportProvenanceError;
    if (!UA.documentExportProvenanceRuntime ||
        typeof UA.documentExportProvenanceRuntime.createSnapshot !== 'function') {
      throw new Error('Document SourceManifest runtime is unavailable for media capture');
    }
    if (!UA.mediaProvenanceBadge || typeof UA.mediaProvenanceBadge.install !== 'function') {
      throw new Error('Shared media provenance badge runtime is unavailable');
    }
    const ctx = typeof UA.getRuntimeContext === 'function' ? UA.getRuntimeContext() : null;
    if (!ctx) throw new Error('Runtime context is unavailable for media capture');
    const snapshot = await UA.documentExportProvenanceRuntime.createSnapshot(ctx);
    const installed = UA.mediaProvenanceBadge.install(snapshot, {
      id: badgeId,
      mode: 'viewport',
      inset: 8,
    });
    return {
      manifest: snapshot.manifest,
      sourceManifestSha256: snapshot.sourceManifestSha256,
      visibleBadge: {
        id: installed.id,
        text: installed.text,
        sourceId: installed.sourceId,
        sourceWidth: installed.sourceWidth,
        sourceHeight: installed.sourceHeight,
        rect: installed.image.rect,
        borderColor: installed.borderColor,
        backgroundColor: installed.backgroundColor,
      },
    };
  }, { badgeId: SOURCE_BADGE_ID });

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
