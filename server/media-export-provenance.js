'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createStoredZip } = require('../js/ua.zip');
const videoExportContract = require('../js/ua.video-export-contract');

const execFileAsync = promisify(execFile);
const SIDECAR_SCHEMA_VERSION = 1;
const PROVENANCE_TTL_MS = 15 * 60_000;
const PROVENANCE_MAX_ENTRIES = 64;
const BADGE_COLOR_TOLERANCE = 55;
const BADGE_MIN_BORDER_PIXELS = 60;
const BADGE_MIN_BACKGROUND_PIXELS = 300;
const BADGE_SAMPLE_FPS = 1;
const BADGE_SAMPLE_FRAMES = 8;
const BASE_ENCODED_INSPECTION_FPS = 2;
const FFMPEG_TIMEOUT_MS = 120_000;
const MAX_BADGE_BUFFER_BYTES = 16 * 1024 * 1024;

class MediaExportProvenanceError extends Error {
  constructor(code, message, details) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'MediaExportProvenanceError';
    this.code = code;
    this.status = 422;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new MediaExportProvenanceError(code, message, details);
}

function sha256Buffer(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const digest = crypto.createHash('sha256').update(buffer).digest();
  return { hex: digest.toString('hex'), base64: digest.toString('base64') };
}

function stableJson(value, pretty = false) {
  const canonical = videoExportContract.stableStringify(value);
  return pretty ? `${JSON.stringify(JSON.parse(canonical), null, 2)}\n` : canonical;
}

function safeBaseName(value) {
  const name = String(value || 'unfallatlas-analyse')
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return name || 'unfallatlas-analyse';
}

function positiveDimensions(value, code, message) {
  const dimensions = {
    width: Math.round(Number(value && value.width)),
    height: Math.round(Number(value && value.height)),
  };
  if (!Number.isInteger(dimensions.width) || !Number.isInteger(dimensions.height) ||
      dimensions.width <= 0 || dimensions.height <= 0 ||
      dimensions.width > 8192 || dimensions.height > 8192) {
    fail(code, message, { dimensions: value || null });
  }
  return dimensions;
}

function finiteRect(rect, dimensions) {
  const candidate = {
    x: Math.round(Number(rect && rect.x)),
    y: Math.round(Number(rect && rect.y)),
    width: Math.round(Number(rect && rect.width)),
    height: Math.round(Number(rect && rect.height)),
  };
  if (!Number.isInteger(candidate.x) || !Number.isInteger(candidate.y) ||
      !Number.isInteger(candidate.width) || !Number.isInteger(candidate.height) ||
      candidate.x < 0 || candidate.y < 0 || candidate.width < 20 || candidate.height < 12 ||
      candidate.x + candidate.width > dimensions.width ||
      candidate.y + candidate.height > dimensions.height) {
    fail('invalid_source_badge_rect', 'Visible source badge has invalid browser-frame coordinates', {
      rect: rect || null,
      dimensions,
    });
  }
  return candidate;
}

function projectBadgeRect(visibleBadge, encodedFrameEvidence) {
  const sourceDimensions = positiveDimensions({
    width: visibleBadge && visibleBadge.sourceWidth,
    height: visibleBadge && visibleBadge.sourceHeight,
  }, 'invalid_source_badge_dimensions', 'Visible source badge is missing browser dimensions');
  const encodedDimensions = positiveDimensions(encodedFrameEvidence,
    'invalid_encoded_dimensions', 'Encoded media evidence is missing frame dimensions');
  const sourceRect = finiteRect(visibleBadge && visibleBadge.rect, sourceDimensions);
  const scaleX = encodedDimensions.width / sourceDimensions.width;
  const scaleY = encodedDimensions.height / sourceDimensions.height;
  const left = Math.max(0, Math.floor(sourceRect.x * scaleX));
  const top = Math.max(0, Math.floor(sourceRect.y * scaleY));
  const right = Math.min(encodedDimensions.width,
    Math.ceil((sourceRect.x + sourceRect.width) * scaleX));
  const bottom = Math.min(encodedDimensions.height,
    Math.ceil((sourceRect.y + sourceRect.height) * scaleY));
  const rect = {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
  if (rect.width < 8 || rect.height < 6 ||
      rect.x + rect.width > encodedDimensions.width ||
      rect.y + rect.height > encodedDimensions.height) {
    fail('invalid_projected_source_badge_rect', 'Source badge cannot be projected into encoded-frame space', {
      sourceRect,
      sourceDimensions,
      encodedDimensions,
      rect,
    });
  }
  return Object.freeze({ sourceRect, sourceDimensions, encodedDimensions, rect, scaleX, scaleY });
}

function closeColor(r, g, b, expected, tolerance = BADGE_COLOR_TOLERANCE) {
  return Math.abs(r - expected[0]) <= tolerance &&
    Math.abs(g - expected[1]) <= tolerance &&
    Math.abs(b - expected[2]) <= tolerance;
}

function badgeSampleStartSeconds(encodedFrameEvidence) {
  const inspectedFrames = Number(encodedFrameEvidence && encodedFrameEvidence.frameCount);
  const durationSeconds = Number.isFinite(inspectedFrames) && inspectedFrames > 0
    ? inspectedFrames / BASE_ENCODED_INSPECTION_FPS
    : 0;
  // The source strip is installed after the semantic analysis gate and remains
  // fixed until the recorded context closes. Inspecting the tail avoids earlier
  // frames that correctly predate provenance capture and bounds raw output.
  return Math.max(0, Math.floor(durationSeconds - BADGE_SAMPLE_FRAMES));
}

async function verifyEncodedSourceBadge(artifactPath, visibleBadge, encodedFrameEvidence) {
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    fail('missing_media_artifact', 'Encoded media artifact is unavailable for source-badge verification');
  }
  const projection = projectBadgeRect(visibleBadge, encodedFrameEvidence);
  const { rect } = projection;
  const border = visibleBadge && visibleBadge.borderColor;
  const background = visibleBadge && visibleBadge.backgroundColor;
  if (!Array.isArray(border) || border.length !== 3 ||
      !Array.isArray(background) || background.length !== 3) {
    fail('invalid_source_badge_palette', 'Visible source badge is missing its verification palette');
  }

  const sampleStartSeconds = badgeSampleStartSeconds(encodedFrameEvidence);
  const { stdout } = await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-ss', String(sampleStartSeconds),
    '-i', artifactPath,
    '-vf', `fps=${BADGE_SAMPLE_FPS},crop=${rect.width}:${rect.height}:${rect.x}:${rect.y}`,
    '-frames:v', String(BADGE_SAMPLE_FRAMES),
    '-pix_fmt', 'rgb24',
    '-f', 'rawvideo',
    'pipe:1',
  ], {
    timeout: FFMPEG_TIMEOUT_MS,
    encoding: 'buffer',
    maxBuffer: MAX_BADGE_BUFFER_BYTES,
  });
  const bytes = Buffer.from(stdout || []);
  const frameBytes = rect.width * rect.height * 3;
  if (!frameBytes || bytes.length % frameBytes !== 0) {
    fail('source_badge_frame_decode_invalid', 'Decoded source-badge frames have an invalid byte length', {
      bytes: bytes.length,
      frameBytes,
      rect,
    });
  }
  const frameCount = bytes.length / frameBytes;
  if (!(frameCount > 0)) {
    fail('source_badge_frames_missing', 'No encoded frame was available for source-badge verification');
  }

  let maxBorderPixels = 0;
  let maxBackgroundPixels = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let borderPixels = 0;
    let backgroundPixels = 0;
    const start = frame * frameBytes;
    const end = start + frameBytes;
    for (let offset = start; offset + 2 < end; offset += 3) {
      const r = bytes[offset], g = bytes[offset + 1], b = bytes[offset + 2];
      if (closeColor(r, g, b, border)) borderPixels += 1;
      if (closeColor(r, g, b, background)) backgroundPixels += 1;
    }
    maxBorderPixels = Math.max(maxBorderPixels, borderPixels);
    maxBackgroundPixels = Math.max(maxBackgroundPixels, backgroundPixels);
  }

  const requiredBorderPixels = Math.max(20, Math.min(
    BADGE_MIN_BORDER_PIXELS,
    Math.round((rect.width + rect.height) * 0.1),
  ));
  const requiredBackgroundPixels = Math.max(100, Math.min(
    BADGE_MIN_BACKGROUND_PIXELS,
    Math.round(rect.width * rect.height * 0.02),
  ));
  const verified = maxBorderPixels >= requiredBorderPixels &&
    maxBackgroundPixels >= requiredBackgroundPixels;
  if (!verified) {
    fail('source_badge_not_encoded', 'Visible SourceManifest badge was not found in the encoded animation', {
      frameCount,
      maxBorderPixels,
      maxBackgroundPixels,
      requiredBorderPixels,
      requiredBackgroundPixels,
      sampleStartSeconds,
      projection,
    });
  }
  return Object.freeze({
    verified: true,
    frameCount,
    maxBorderPixels,
    maxBackgroundPixels,
    requiredBorderPixels,
    requiredBackgroundPixels,
    tolerance: BADGE_COLOR_TOLERANCE,
    sampleStartSeconds,
    ...projection,
  });
}

function validateCapture(capture) {
  if (!capture || !capture.manifest ||
      !/^[a-f0-9]{64}$/.test(String(capture.sourceManifestSha256 || ''))) {
    fail('invalid_media_capture', 'Media export requires a valid SourceManifest capture');
  }
  if (!capture.visibleBadge || !String(capture.visibleBadge.text || '').trim()) {
    fail('missing_visible_source_badge', 'Media export requires a visible source badge');
  }
  return capture;
}

function createVideoMediaSidecar(exportResult, capture, encodedBadgeEvidence, options = {}) {
  validateCapture(capture);
  const evidence = exportResult && exportResult.evidence;
  const artifact = evidence && evidence.artifact;
  if (!artifact || !/^[a-f0-9]{64}$/.test(String(artifact.sha256 || ''))) {
    fail('invalid_media_evidence', 'Video export result has no valid artifact evidence');
  }
  if (!encodedBadgeEvidence || encodedBadgeEvidence.verified !== true) {
    fail('unverified_visible_source_badge', 'Encoded media source badge was not verified');
  }
  const baseName = safeBaseName(options.baseName);
  const filename = `${baseName}.${exportResult.extension}`;
  const core = {
    schemaVersion: SIDECAR_SCHEMA_VERSION,
    kind: 'unfallatlas-media-provenance',
    artifact: {
      artifactId: `media-${artifact.sha256.slice(0, 24)}`,
      filename,
      format: exportResult.format,
      contentType: exportResult.contentType,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      sha256Base64: artifact.sha256Base64,
    },
    sourceManifestSha256: capture.sourceManifestSha256,
    sourceManifest: capture.manifest,
    visibleSourceBadge: {
      ...capture.visibleBadge,
      encodedEvidence: encodedBadgeEvidence,
    },
    generationEvidence: evidence,
  };
  const digest = sha256Buffer(Buffer.from(stableJson(core), 'utf8')).hex;
  return Object.freeze({ ...core, sha256: digest });
}

function sourceSummary(sidecar) {
  const sources = sidecar && sidecar.sourceManifest && sidecar.sourceManifest.sources;
  return (Array.isArray(sources) ? sources : []).map(source => {
    const label = `${source.publisher} – ${source.datasetTitle}`;
    const licence = `${source.licenseName} (${source.licenseId})`;
    return `- ${label}; Lizenz: ${licence}; Datensatz: ${source.datasetUrl}`;
  }).join('\n');
}

function createVideoMediaBundle(exportResult, sidecar, options = {}) {
  const baseName = safeBaseName(options.baseName);
  const artifactBuffer = fs.readFileSync(exportResult.path);
  const sidecarText = stableJson(sidecar, true);
  const readme = [
    'Unfallwerkbank – Medienexport mit Quellenprovenienz',
    '',
    `Artefakt: ${baseName}.${exportResult.extension}`,
    `Artefakt-SHA-256: ${sidecar.artifact.sha256}`,
    `SourceManifest-SHA-256: ${sidecar.sourceManifestSha256}`,
    `Sidecar-SHA-256: ${sidecar.sha256}`,
    '',
    'Quellen:',
    sourceSummary(sidecar) || '- keine Quelle dokumentiert',
    '',
    'Die Datei *.sources.json enthält Szenario, Filter, Quellen, Lizenzen,',
    'Build-/Datenfingerprint, Transformationen und den Hash des Medienartefakts.',
    '',
  ].join('\n');
  const bytes = createStoredZip([
    { name: `${baseName}.${exportResult.extension}`, content: artifactBuffer },
    { name: `${baseName}.sources.json`, content: sidecarText },
    { name: 'README.txt', content: readme },
  ]);
  const buffer = Buffer.from(bytes);
  return Object.freeze({
    buffer,
    bytes: buffer.length,
    sha256: sha256Buffer(buffer).hex,
    contentType: 'application/zip',
    filename: `${baseName}-${exportResult.format}.zip`,
  });
}

class MediaProvenanceStore {
  constructor(options = {}) {
    this.ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : PROVENANCE_TTL_MS;
    this.maxEntries = Number(options.maxEntries) > 0
      ? Math.floor(Number(options.maxEntries))
      : PROVENANCE_MAX_ENTRIES;
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.entries = new Map();
  }

  cleanup() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      this.entries.delete(this.entries.keys().next().value);
    }
  }

  put(sidecar) {
    const key = String(sidecar && sidecar.artifact && sidecar.artifact.sha256 || '');
    if (!/^[a-f0-9]{64}$/.test(key)) fail('invalid_store_key', 'Sidecar artifact hash is invalid');
    this.cleanup();
    this.entries.delete(key);
    this.entries.set(key, {
      sidecar,
      expiresAt: this.now() + this.ttlMs,
    });
    this.cleanup();
    return key;
  }

  get(keyValue) {
    const key = String(keyValue || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(key)) return null;
    this.cleanup();
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Refresh insertion order without extending the expiry.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.sidecar;
  }
}

const sharedMediaProvenanceStore = new MediaProvenanceStore();

module.exports = {
  SIDECAR_SCHEMA_VERSION,
  PROVENANCE_TTL_MS,
  PROVENANCE_MAX_ENTRIES,
  MediaExportProvenanceError,
  MediaProvenanceStore,
  sharedMediaProvenanceStore,
  sha256Buffer,
  stableJson,
  safeBaseName,
  positiveDimensions,
  projectBadgeRect,
  badgeSampleStartSeconds,
  verifyEncodedSourceBadge,
  createVideoMediaSidecar,
  createVideoMediaBundle,
};
