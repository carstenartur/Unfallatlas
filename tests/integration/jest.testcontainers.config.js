/**
 * Dedicated Jest project for testcontainers-based integration tests.
 *
 * Why a separate config:
 *   - Long timeouts (the container takes 30-120 s to come up; the
 *     export inside takes another 20-60 s).
 *   - Single worker — running multiple containers in parallel exhausts
 *     local Docker resources and the ffmpeg pipeline inside.
 *   - Node test environment (no jsdom needed; the test only does HTTP).
 *   - By default, this config runs the production-container smoke test only.
 *     The heavier real-data location-brief golden QA is opt-in via
 *     RUN_LOCATION_BRIEF_GOLDEN=1.
 *
 * Run with:
 *   npm run test:integration:tc
 *   npm run test:location-brief-golden:tc
 */

'use strict';

const path = require('path');

const runLocationBriefGolden = process.env.RUN_LOCATION_BRIEF_GOLDEN === '1';

module.exports = {
  rootDir: path.resolve(__dirname, '..', '..'),
  testEnvironment: 'node',
  testMatch: runLocationBriefGolden
    ? ['<rootDir>/tests/integration/locationBriefGoldenCases.testcontainers.test.js']
    : ['<rootDir>/tests/integration/videoExport.testcontainers.test.js'],
  testTimeout: 360_000,
  maxWorkers: 1,
  // The default Jest setup file pulls in jsdom-only globals
  // (TextEncoder/TextDecoder shims). They are no-ops here but harmless;
  // we keep the same setup for parity with the rest of the suite.
  setupFiles: ['<rootDir>/tests/setup.js']
};
