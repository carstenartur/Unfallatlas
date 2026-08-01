'use strict';

/**
 * Production entry point. It installs security and optional runtime
 * integrations before the legacy Express application is evaluated.
 */

const path = require('path');
const {
  installContextGenerationCapabilityAlias,
  registerContextGenerationRoutes,
} = require('./context-generation/routes');
const {
  installVideoExportPlaywrightRuntime,
} = require('./video-export-playwright-runtime');
const {
  installMediaExportProvenanceHttp,
} = require('./media-export-provenance-http');

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https:",
  "worker-src 'self' blob:",
  "media-src 'self' blob:",
  "form-action 'self'",
  'upgrade-insecure-requests',
].join('; ');

function installSecurityHeaders(app) {
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(self), payment=(), usb=()'
    );
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    next();
  });
}

installVideoExportPlaywrightRuntime();

const videoExportModulePath = require.resolve('./video-export.js');
require(videoExportModulePath);
const videoExportWithProvenance = require('./video-export-with-provenance.js');
require.cache[videoExportModulePath].exports = videoExportWithProvenance;

const expressModulePath = require.resolve('express');
const originalExpress = require(expressModulePath);

function expressWithRuntimeIntegrations(...args) {
  const app = originalExpress(...args);
  installSecurityHeaders(app);
  installMediaExportProvenanceHttp(app);
  installContextGenerationCapabilityAlias(app);

  setImmediate(() => {
    try {
      registerContextGenerationRoutes(app, { root: path.resolve(__dirname, '..') });
      console.log('Kontextdatengenerierung: GET /api/context-generation/status, POST /api/context-generation/jobs');
    } catch (error) {
      console.error('[context-generation] route registration failed:', error.message);
    }
  });
  return app;
}

const intrinsicFunctionKeys = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);
for (const key of Reflect.ownKeys(originalExpress)) {
  if (intrinsicFunctionKeys.has(key)) continue;
  const descriptor = Object.getOwnPropertyDescriptor(originalExpress, key);
  if (descriptor) Object.defineProperty(expressWithRuntimeIntegrations, key, descriptor);
}
Object.setPrototypeOf(expressWithRuntimeIntegrations, Object.getPrototypeOf(originalExpress));
require.cache[expressModulePath].exports = expressWithRuntimeIntegrations;

require('./index.js');

module.exports = { CONTENT_SECURITY_POLICY, installSecurityHeaders };
