#!/usr/bin/env node
/**
 * scripts/generate-sample-pdf.js — CI render-gate helper
 *
 * Erzeugt eine Beispiel-PDF mit der realen ua.report_v2-Export-Pipeline
 * und schreibt sie nach `out/ci-render-gate.pdf`. Das so erzeugte PDF
 * wird anschließend vom `npm run test:render-gate`-Skript
 * (scripts/check-pdf-render.js) geprüft.
 *
 * Verwendung:
 *   node scripts/generate-sample-pdf.js
 *   node scripts/generate-sample-pdf.js --out out/my-test.pdf
 *
 * Exit-Codes:
 *   0  PDF erfolgreich geschrieben
 *   1  Fehler beim Erzeugen
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI-Argument: --out <path>
// ---------------------------------------------------------------------------
const args  = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 && args[outIdx + 1]
  ? path.resolve(args[outIdx + 1])
  : path.resolve(__dirname, '..', 'out', 'ci-render-gate.pdf');

// Ensure output directory exists.
fs.mkdirSync(path.dirname(outPath), { recursive: true });

// ---------------------------------------------------------------------------
// Minimal browser-like globals needed by ua.report_v2's IIFE
// ---------------------------------------------------------------------------
const pdfMakeLib = require('pdfmake/build/pdfmake');
const pdfFonts   = require('pdfmake/build/vfs_fonts');
if (typeof pdfMakeLib.addVirtualFileSystem === 'function') {
  pdfMakeLib.addVirtualFileSystem(pdfFonts);
} else {
  pdfMakeLib.vfs = pdfFonts;
}

const mockWindow = {
  UA: {},
  location: {
    href: 'http://localhost/',
    pathname: '/werkbank_v2.html',
    search: '',
    hash: '',
    origin: 'http://localhost',
    protocol: 'http:',
    host: 'localhost',
  },
  pdfMake: pdfMakeLib,
  docx: require('docx'),
  saveAs: () => {},
  // leafletImage stub: returns a 1×1 transparent PNG so the map path runs
  // through without a real Leaflet instance.
  leafletImage: (_map, cb) => setTimeout(() => cb(null, {
    toDataURL: () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  }), 0),
};

// Load ua.utils.js first (ua.report_v2 depends on UA.normKey etc.)
const utilsSrc  = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'ua.utils.js'), 'utf8');
const reportSrc = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'ua.report_v2.js'), 'utf8');

// eslint-disable-next-line no-new-func
(new Function('window', utilsSrc))(mockWindow);
// eslint-disable-next-line no-new-func
(new Function('window', reportSrc))(mockWindow);

const UA = mockWindow.UA;

// ---------------------------------------------------------------------------
// Stub map-capture helpers directly on UA so the image path runs end-to-end
// through the PDF rendering pipeline (fitImageToMax, image nodes, etc.)
// without needing a real Leaflet instance or a browser URL context.
//
// A synthetic 1×1 PNG is used — the render gate exercises whether pdfmake
// can serialise and poppler/gs can render the resulting PDF pages, not
// whether the pixel content is accurate.
// ---------------------------------------------------------------------------
const STUB_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

UA.captureExportMapImage = async () => STUB_PNG;
UA._captureExportMapImage = UA.captureExportMapImage;
UA._captureDetailMap = async () => STUB_PNG;
UA._captureClusterMaps = async () => [{
  image: STUB_PNG,
  bounds: { south: 50.69, west: 7.13, north: 50.74, east: 7.18 },
  total: 3,
  points: [],
  label: 'Cluster Bonn-Zentrum',
  zoom: 16,
  lat: 50.7326,
  lon: 7.0963,
}];

// ---------------------------------------------------------------------------
// Intercept pdfMake.createPdf to capture the docDefinition buffer via
// getBuffer() rather than triggering a browser download().
// ---------------------------------------------------------------------------
let capturedDef = null;
const origCreatePdf = pdfMakeLib.createPdf.bind(pdfMakeLib);
mockWindow.pdfMake.createPdf = (def) => {
  capturedDef = def;
  const doc = origCreatePdf(def);
  // Override download() so the export code doesn't crash looking for a DOM.
  doc.download = () => {};
  return doc;
};

// ---------------------------------------------------------------------------
// Fixture context + report data (minimal but representative)
// ---------------------------------------------------------------------------
const ctx = {
  CITY_RAW: 'Bonn',
  map: {
    getCenter: () => ({ lat: 50.7326, lng: 7.0963 }),
    getZoom:   () => 14,
    eachLayer:  () => {},
    fitBounds:  () => {},
    setView:    () => {},
    getBounds:  () => ({
      getSouth: () => 50.69,
      getNorth: () => 50.74,
      getWest:  () => 7.13,
      getEast:  () => 7.18,
    }),
  },
  selectionBounds: {
    south:      50.69,
    west:       7.13,
    north:      50.74,
    east:       7.18,
    getSouth:   () => 50.69,
    getWest:    () => 7.13,
    getNorth:   () => 50.74,
    getEast:    () => 7.18,
    contains:   () => true,
  },
  viewportPts: [],
};

const reportData = {
  text: [
    'Sachverhalt:',
    'Im markierten Kartenausschnitt Bonn-Bad Godesberg wurden 20 Unfälle ausgewertet.',
    'Davon waren 8 Radunfälle, 5 Fußgängerunfälle und 7 PKW-Unfälle.',
    '',
    'Beschlussvorschlag:',
    'Der Bezirksrat bittet die Verwaltung, den markierten Bereich auf Sicherheitspotenzial zu prüfen.',
  ].join('\n'),
  structured: {
    meta: {
      city: 'Bonn',
      date: new Date().toLocaleDateString('de-DE'),
      gremium: { typ: 'Bezirksrat' },
    },
    severity: { total: 20, bySev: { '3': 16, '2': 3, '1': 1 } },
  },
};

// ---------------------------------------------------------------------------
// Run the export, then write the PDF buffer to disk.
// ---------------------------------------------------------------------------
(async () => {
  try {
    await UA.exportToPDF(ctx, reportData, {
      includeMap: true,
      includePOIs: false,
      includeReferences: false,
      _skipQAGate: true,
    });
  } catch (err) {
    // exportToPDF may throw if download() is intercepted in an unexpected
    // way — log but continue so we can still write the captured definition.
    process.stderr.write('generate-sample-pdf: exportToPDF threw: ' + err.message + '\n');
  }

  if (!capturedDef) {
    process.stderr.write('generate-sample-pdf: no docDefinition captured — export did not call pdfMake.createPdf\n');
    process.exit(1);
  }

  // Use getBuffer() (Node.js pdfmake API) to serialise the definition to PDF.
  // pdfmake 0.3.x returns a Promise; older versions support callback style.
  let buffer;
  const pdfDoc = origCreatePdf(capturedDef);
  try {
    const maybePromise = pdfDoc.getBuffer();
    if (maybePromise && typeof maybePromise.then === 'function') {
      buffer = await maybePromise;
    }
  } catch (_) {
    // Fallback for callback-based pdfmake versions.
  }

  if (!buffer) {
    buffer = await new Promise((resolve, reject) => {
      try {
        pdfDoc.getBuffer(resolve);
      } catch (err) {
        reject(err);
      }
    });
  }

  try {
    fs.writeFileSync(outPath, buffer);
    process.stdout.write('generate-sample-pdf: wrote ' + buffer.length + ' bytes to ' + outPath + '\n');
    process.exit(0);
  } catch (writeErr) {
    process.stderr.write('generate-sample-pdf: failed to write ' + outPath + ': ' + writeErr.message + '\n');
    process.exit(1);
  }
})();
