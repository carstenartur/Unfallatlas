'use strict';

/**
 * Production entry point.
 *
 * server/index.js predates the optional runtime integrations and creates the
 * Express app internally. This small preload wrapper attaches those boundaries
 * without duplicating the large server file. A later server refactor can replace
 * this with an exported createApp() factory without changing the public API.
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

// Install before index.js imports video-export.js. The latter captures
// Playwright's chromium launcher during module evaluation, so the production
// boundary must already be active at that point.
installVideoExportPlaywrightRuntime();

// Keep the large, independently tested video implementation unchanged. The
// wrapper consumes it, binds the final animation to the browser SourceManifest
// and verifies the visible source strip after encoding. Redirect only the module
// cache entry that server/index.js imports.
const videoExportModulePath = require.resolve('./video-export.js');
require(videoExportModulePath);
const videoExportWithProvenance = require('./video-export-with-provenance.js');
require.cache[videoExportModulePath].exports = videoExportWithProvenance;

const expressModulePath = require.resolve('express');
const originalExpress = require(expressModulePath);

function expressWithRuntimeIntegrations(...args) {
  const app = originalExpress(...args);

  // Register synchronously so the sidecar route and sendFile boundary precede
  // the legacy /api/export-video handler and the static-site middleware.
  installMediaExportProvenanceHttp(app);

  // The JSON-named status alias must also precede static middleware. The static
  // distribution contains a same-path fallback document, while Docker redirects
  // this request to the dynamic API. Full job routes stay deferred until the
  // legacy application has installed JSON body parsing.
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

// Preserve Express' static helpers (`express.json`, `express.static`, Router,
// …), but never redefine intrinsic Function properties on the wrapper.
const intrinsicFunctionKeys = new Set(['length', 'name', 'prototype', 'arguments', 'caller']);
for (const key of Reflect.ownKeys(originalExpress)) {
  if (intrinsicFunctionKeys.has(key)) continue;
  const descriptor = Object.getOwnPropertyDescriptor(originalExpress, key);
  if (descriptor) Object.defineProperty(expressWithRuntimeIntegrations, key, descriptor);
}
Object.setPrototypeOf(expressWithRuntimeIntegrations, Object.getPrototypeOf(originalExpress));
require.cache[expressModulePath].exports = expressWithRuntimeIntegrations;

require('./index.js');
