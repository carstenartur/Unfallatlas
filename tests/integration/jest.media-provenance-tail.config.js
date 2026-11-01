'use strict';

const path = require('path');

// Required by ProductionContainerIT, where the production codecs are installed.
// This explicit project also permits local runs with FFmpeg and ImageMagick.
module.exports = {
  rootDir: path.resolve(__dirname, '..', '..'),
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/integration/mediaExportProvenanceTail.testcontainers.test.js'],
};
