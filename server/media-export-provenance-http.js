'use strict';

const {
  sharedMediaProvenanceStore,
  stableJson,
  sha256Buffer,
  createVideoMediaBundle,
} = require('./media-export-provenance');

const PACKAGING_VALUES = Object.freeze(['binary', 'zip']);
const PROVENANCE_PATH_PREFIX = '/api/export-video/provenance/';
const VIDEO_RESPONSE_HEADERS = Object.freeze([
  'Content-Disposition',
  'Content-Length',
  'Content-Digest',
  'Digest',
]);

function requestedPackaging(req) {
  const value = req && req.query && req.query.packaging;
  return String(value || 'binary').toLowerCase();
}

function provenancePath(artifactSha256) {
  return `${PROVENANCE_PATH_PREFIX}${artifactSha256}.json`;
}

function setProvenanceHeaders(res, sidecar) {
  const artifactSha = sidecar.artifact.sha256;
  const path = provenancePath(artifactSha);
  res.setHeader('X-Unfallatlas-Source-Manifest-SHA256', sidecar.sourceManifestSha256);
  res.setHeader('X-Unfallatlas-Media-Provenance-SHA256', sidecar.sha256);
  res.setHeader('X-Unfallatlas-Provenance-URL', path);
  res.setHeader('Link', `<${path}>; rel="describedby"; type="application/json"`);
}

function sendJsonError(res, status, payload) {
  if (typeof res.removeHeader === 'function') {
    for (const name of VIDEO_RESPONSE_HEADERS) res.removeHeader(name);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(payload);
}

function installMediaExportProvenanceHttp(app) {
  if (!app || typeof app.use !== 'function' || typeof app.get !== 'function') {
    throw new TypeError('Express app is required for media provenance HTTP integration');
  }

  app.get(`${PROVENANCE_PATH_PREFIX}:artifactSha.json`, (req, res) => {
    const artifactSha = String(req.params && req.params.artifactSha || '').toLowerCase();
    const sidecar = sharedMediaProvenanceStore.get(artifactSha);
    if (!sidecar) {
      return sendJsonError(res, 404, {
        error: 'media_provenance_not_found',
        message: 'Der Provenienz-Sidecar ist nicht vorhanden oder bereits abgelaufen.',
      });
    }
    const body = Buffer.from(stableJson(sidecar, true), 'utf8');
    const digest = sha256Buffer(body);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.setHeader('ETag', `"sha256-${digest.hex}"`);
    res.setHeader('Content-Digest', `sha-256=:${digest.base64}:`);
    res.setHeader('X-Unfallatlas-Media-Provenance-SHA256', sidecar.sha256);
    return res.send(body);
  });

  // This middleware is registered before server/index.js creates the legacy
  // image response. It preserves that route and only decorates its final
  // sendFile boundary, where the wrapper has already stored the exact sidecar.
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/api/export-video') return next();
    const packaging = requestedPackaging(req);
    if (!PACKAGING_VALUES.includes(packaging)) {
      return sendJsonError(res, 400, {
        error: 'unsupported_packaging',
        supportedPackaging: PACKAGING_VALUES,
      });
    }

    const originalSendFile = res.sendFile.bind(res);
    res.sendFile = function sendVideoWithProvenance(filePath, callback) {
      const artifactSha = String(res.getHeader('X-Unfallatlas-Artifact-SHA256') || '').toLowerCase();
      const sidecar = sharedMediaProvenanceStore.get(artifactSha);
      if (!sidecar) {
        const error = new Error('Media provenance sidecar is unavailable');
        error.code = 'media_provenance_unavailable';
        if (!res.headersSent) {
          sendJsonError(res, 500, {
            error: error.code,
            message: 'Der Medienexport wurde ohne vollständige Provenienz abgebrochen.',
          });
        }
        if (typeof callback === 'function') queueMicrotask(() => callback(error));
        return res;
      }

      setProvenanceHeaders(res, sidecar);
      if (packaging === 'binary') return originalSendFile(filePath, callback);

      try {
        const bundle = createVideoMediaBundle({
          path: filePath,
          format: sidecar.artifact.format,
          extension: sidecar.artifact.filename.split('.').pop(),
          contentType: sidecar.artifact.contentType,
        }, sidecar, { baseName: 'unfallatlas-analyse' });
        const digest = sha256Buffer(bundle.buffer);
        res.setHeader('Content-Type', bundle.contentType);
        res.setHeader('Content-Disposition', `attachment; filename="${bundle.filename}"`);
        res.setHeader('Content-Length', String(bundle.bytes));
        res.setHeader('Content-Digest', `sha-256=:${digest.base64}:`);
        res.setHeader('Digest', `SHA-256=${digest.base64}`);
        res.setHeader('X-Unfallatlas-Package-SHA256', bundle.sha256);
        res.send(bundle.buffer);
        if (typeof callback === 'function') queueMicrotask(() => callback(null));
      } catch (error) {
        if (!res.headersSent) {
          sendJsonError(res, 500, {
            error: error.code || 'media_bundle_failed',
            message: error.message || 'Medienpaket konnte nicht erzeugt werden.',
          });
        }
        if (typeof callback === 'function') queueMicrotask(() => callback(error));
      }
      return res;
    };
    return next();
  });

  return Object.freeze({
    packaging: PACKAGING_VALUES,
    provenancePath,
  });
}

module.exports = {
  PACKAGING_VALUES,
  PROVENANCE_PATH_PREFIX,
  requestedPackaging,
  provenancePath,
  setProvenanceHeaders,
  sendJsonError,
  installMediaExportProvenanceHttp,
};
