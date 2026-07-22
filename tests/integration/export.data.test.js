'use strict';

/**
 * Executes the unchanged data-export integration suite from the legacy source
 * fixture. Document-export coverage lives in export.document.test.js, where the
 * pdfMake content model is inspected recursively after final-page hardening.
 */
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, 'export.legacy-source.js'),
  'utf8'
);
const marker = [
  '/**',
  ' * Integration tests for data export functions (CSV, GeoJSON, KML)',
  ' */',
].join('\n');
const start = source.indexOf(marker);
if (start < 0) {
  throw new Error('Legacy data-export integration-suite marker is missing');
}

// The extracted suffix contains only the Data Export describe block and uses
// the same Jest/jsdom scope as the former combined integration file.
eval(source.slice(start));
