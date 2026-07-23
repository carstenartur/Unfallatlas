'use strict';

const fs = require('fs');
const baseVideoExport = require('./video-export');
const {
  runWithMediaProvenanceCapture,
} = require('./media-provenance-capture');
const {
  verifyEncodedSourceBadge,
  createVideoMediaSidecar,
  sharedMediaProvenanceStore,
} = require('./media-export-provenance');

async function exportVideo(params, opts = {}) {
  const { result, capture } = await runWithMediaProvenanceCapture({
    timeoutMs: Number(process.env.VIDEO_EXPORT_PROVENANCE_TIMEOUT_MS) || 180_000,
  }, () => baseVideoExport.exportVideo(params, opts));

  try {
    const encodedFrameEvidence = result && result.evidence &&
      result.evidence.semantic && result.evidence.semantic.framesAfterEncoding;
    const encodedBadgeEvidence = await verifyEncodedSourceBadge(
      result.path,
      capture.visibleBadge,
      encodedFrameEvidence,
    );
    const mediaProvenance = createVideoMediaSidecar(
      result,
      capture,
      encodedBadgeEvidence,
      { baseName: 'unfallatlas-analyse' },
    );
    sharedMediaProvenanceStore.put(mediaProvenance);
    return Object.freeze({
      ...result,
      sourceManifest: capture.manifest,
      sourceManifestSha256: capture.sourceManifestSha256,
      mediaProvenance,
    });
  } catch (error) {
    if (result && result.path) {
      try { fs.unlinkSync(result.path); } catch (_) { /* ignore */ }
    }
    throw error;
  }
}

module.exports = {
  ...baseVideoExport,
  exportVideo,
};
