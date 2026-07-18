'use strict';

/**
 * Production entry point.
 *
 * server/index.js predates the optional context-generation API and creates the
 * Express app internally. This small preload wrapper attaches the optional
 * routes without duplicating the large server file. A later server refactor can
 * replace this with an exported createApp() factory without changing the API.
 */

const path = require('path');
const { registerContextGenerationRoutes } = require('./context-generation/routes');

const expressModulePath = require.resolve('express');
const originalExpress = require(expressModulePath);

function expressWithContextGeneration(...args) {
  const app = originalExpress(...args);
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
  if (descriptor) Object.defineProperty(expressWithContextGeneration, key, descriptor);
}
Object.setPrototypeOf(expressWithContextGeneration, Object.getPrototypeOf(originalExpress));
require.cache[expressModulePath].exports = expressWithContextGeneration;

require('./index.js');
