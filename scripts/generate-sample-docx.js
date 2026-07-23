#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createDeterministicMapPng, toDataUrl } = require('./deterministic-map-fixture');
const docxSourceLinks = require('../js/ua.docx_source_links');

class SampleDocxError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'SampleDocxError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new SampleDocxError(code, message, details);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') options.outPath = argv[++index];
    else fail('unknown_argument', `Unknown argument: ${arg}`);
  }
  return options;
}

function configurePdfMake() {
  const pdfMake = require('pdfmake/build/pdfmake');
  const pdfFonts = require('pdfmake/build/vfs_fonts');
  if (typeof pdfMake.addVirtualFileSystem === 'function') pdfMake.addVirtualFileSystem(pdfFonts);
  else pdfMake.vfs = pdfFonts;
  return pdfMake;
}

function createAccidentPoints(count, bounds = {}) {
  const south = Number(bounds.south ?? 50.728);
  const west = Number(bounds.west ?? 7.087);
  const north = Number(bounds.north ?? 50.739);
  const east = Number(bounds.east ?? 7.105);
  return Array.from({ length: count }, (_, index) => {
    const column = index % 6;
    const row = Math.floor(index / 6);
    const latitude = south + ((row + 1) / 6) * (north - south);
    const longitude = west + ((column + 1) / 7) * (east - west);
    return {
      lat: latitude,
      lon: longitude,
      latitude,
      longitude,
      severity: index % 12 === 0 ? 1 : index % 4 === 0 ? 2 : 3,
      year: 2022 + (index % 3),
      IstRad: 1,
      IstPKW: 1,
    };
  });
}

function createContext() {
  const bounds = {
    south: 50.728,
    west: 7.087,
    north: 50.739,
    east: 7.105,
    getSouth: () => 50.728,
    getWest: () => 7.087,
    getNorth: () => 50.739,
    getEast: () => 7.105,
    getSouthWest: () => ({ lat: 50.728, lng: 7.087 }),
    getNorthEast: () => ({ lat: 50.739, lng: 7.105 }),
    getCenter: () => ({ lat: 50.7335, lng: 7.096 }),
    contains: () => true,
  };
  const points = createAccidentPoints(24, bounds);
  return {
    CITY_RAW: 'Bonn',
    mapMode: 'standard',
    map: {
      getCenter: () => ({ lat: 50.7335, lng: 7.096 }),
      getZoom: () => 15,
      getBounds: () => bounds,
      eachLayer: () => {},
      fitBounds: () => {},
      setView: () => {},
    },
    selectionBounds: bounds,
    // Mirror the real runtime snapshot instead of providing only viewportPts.
    // The report renderer deliberately derives different map populations from
    // allPts, filteredAll/filteredCapped and viewportPts. Leaving the first
    // three arrays absent produced a visually plausible Golden DOCX whose
    // captions claimed n=0 while the narrative and tables contained 24 cases.
    allPts: points,
    filteredAll: points,
    filteredCapped: points,
    viewportPts: points,
    ui: {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      dayTypeEl: { value: 'all' },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      incBikeEl: { checked: true },
      incPedEl: { checked: false },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      incGkfzEl: { checked: false },
      incSonEl: { checked: false },
    },
  };
}

function createReportData() {
  return {
    text: [
      'Sachverhalt:',
      'Im markierten innerstädtischen Knoten in Bonn wurden 24 Unfälle mit Personenschaden aus den Jahren 2022 bis 2024 ausgewertet.',
      'Die räumliche Auswahl, die Unfallpunkte und die Verletzungsschwere sind in der Übersichtskarte gemeinsam dargestellt.',
      '',
      'Methodik',
      'Die Auswertung umfasst ausschließlich den markierten Kartenausschnitt und die aktiven Filter. Kontextinformationen werden nicht als Kausalnachweis interpretiert.',
      '',
      'Beschlussvorschlag:',
      'Die zuständige Verwaltung wird gebeten, den Knoten innerhalb von sechs Monaten auf kurzfristige Sicht-, Markierungs- und Führungsmaßnahmen zu prüfen und dem zuständigen Gremium schriftlich über Ergebnis und Umsetzungszeitraum zu berichten.',
      '',
      'Datenquelle',
      'Unfallatlas der Statistischen Ämter des Bundes und der Länder: https://www.statistikportal.de/de/karten/unfallatlas',
    ].join('\n'),
    structured: {
      meta: {
        city: 'Bonn',
        date: '23.07.2026',
        areaName: 'Innerstädtischer Knoten Bonn-Zentrum',
        bounds: '50,728–50,739 N; 7,087–7,105 E',
        link: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=Bonn',
        filters: {
          involvementMode: 'and',
          includeCyclist: true,
          includeCar: true,
        },
        gremium: { typ: 'Bezirksvertretung' },
      },
      severity: { total: 24, bySev: { '1': 1, '2': 6, '3': 17, other: 0 } },
      deviations: {
        focus: [
          {
            mask: 5,
            label: '[Rad]+[PKW]',
            locCnt: 11,
            baseCnt: 120,
            locR: 11 / 24,
            baseR: 120 / 820,
            factor: 3.13,
          },
        ],
        rows: [],
        local: { total: 24, byMask: { 5: 11 } },
        baseline: { total: 820, byMask: { 5: 120 } },
      },
      yearTable: [
        { year: 2022, total: 7, classes: ['[Rad]+[PKW]=3', '[Rad]=2', '[PKW]=2'] },
        { year: 2023, total: 8, classes: ['[Rad]+[PKW]=4', '[Rad]=2', '[PKW]=2'] },
        { year: 2024, total: 9, classes: ['[Rad]+[PKW]=4', '[Rad]=3', '[PKW]=2'] },
      ],
      patterns: [],
      poi: null,
      references: [
        {
          title: 'Unfallatlas – Straßenverkehrsunfälle mit Personenschaden',
          url: 'https://www.statistikportal.de/de/karten/unfallatlas',
        },
      ],
    },
  };
}

function assertDocxBytes(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1024) {
    fail('invalid_docx', 'Generated DOCX is unexpectedly small');
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    fail('invalid_docx', 'Generated document does not have a ZIP/DOCX signature');
  }
  return buffer;
}

async function generateSampleDocx(options = {}) {
  const outPath = path.resolve(
    options.outPath || path.join(__dirname, '..', 'out', 'ci-render-gate.docx'),
  );
  const mapDataUrl = toDataUrl(
    createDeterministicMapPng({
      width: 960,
      height: 640,
      title: 'Bonn road-safety golden fixture',
      scenario: 'Bonn cyclist and car urban junction',
    }),
  );
  const capturedDownloads = [];
  const mockWindow = {
    UA: {},
    location: {
      href: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html',
      pathname: '/Unfallatlas/werkbank_v2.html',
      search: '',
      hash: '',
      origin: 'https://carstenartur.github.io',
      protocol: 'https:',
      host: 'carstenartur.github.io',
    },
    docx: options.docx || require('docx'),
    pdfMake: options.pdfMake || configurePdfMake(),
    saveAs: (blob, filename) => capturedDownloads.push({ blob, filename }),
    leafletImage: (_map, callback) => {
      setTimeout(() => callback(null, { toDataURL: () => mapDataUrl }), 0);
    },
  };

  const utilsSource = fs.readFileSync(
    options.utilsPath || path.resolve(__dirname, '..', 'js', 'ua.utils.js'),
    'utf8',
  );
  const reportSource = fs.readFileSync(
    options.reportPath || path.resolve(__dirname, '..', 'js', 'ua.report_v2.js'),
    'utf8',
  );
  // eslint-disable-next-line no-new-func
  new Function('window', utilsSource)(mockWindow);
  // eslint-disable-next-line no-new-func
  new Function('window', reportSource)(mockWindow);

  const UA = mockWindow.UA;
  UA.captureExportMapImage = async () => mapDataUrl;
  UA._captureExportMapImage = UA.captureExportMapImage;
  UA._captureDetailMap = async () => mapDataUrl;
  UA._captureClusterMaps = async () => [
    {
      image: mapDataUrl,
      bounds: { south: 50.73, west: 7.091, north: 50.736, east: 7.101 },
      total: 11,
      points: createAccidentPoints(11, {
        south: 50.73,
        west: 7.091,
        north: 50.736,
        east: 7.101,
      }),
      label: 'Detailkarte Bonn-Zentrum',
      zoom: 16,
      lat: 50.7335,
      lon: 7.096,
    },
  ];
  const linkRuntime = docxSourceLinks.install(UA, mockWindow);
  if (!linkRuntime.available) {
    fail('docx_source_links_unavailable', 'DOCX source-link runtime could not be installed');
  }

  await UA.exportToWord(createContext(), createReportData(), {
    includeMap: true,
    includePOIs: false,
    includeReferences: true,
    _skipQAGate: true,
  });

  if (capturedDownloads.length !== 1) {
    fail(
      'unexpected_download_count',
      `Expected one DOCX download, received ${capturedDownloads.length}`,
      { filenames: capturedDownloads.map((item) => item.filename) },
    );
  }
  const download = capturedDownloads[0];
  if (!download.blob || typeof download.blob.arrayBuffer !== 'function') {
    fail('invalid_blob', 'DOCX exporter did not return a readable Blob');
  }
  const buffer = assertDocxBytes(Buffer.from(await download.blob.arrayBuffer()));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  return {
    outPath,
    bytes: buffer.length,
    downloadName: download.filename,
    mapBytes: Buffer.from(mapDataUrl.split(',')[1], 'base64').length,
  };
}

async function main(argv) {
  const cli = parseArgs(argv);
  const result = await generateSampleDocx(cli);
  process.stdout.write(
    `[generate-sample-docx] wrote ${result.bytes} bytes to ${result.outPath}; ` +
      `embedded map fixture ${result.mapBytes} bytes; browser name ${result.downloadName}.\n`,
  );
  return result;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  SampleDocxError,
  parseArgs,
  createAccidentPoints,
  createContext,
  createReportData,
  assertDocxBytes,
  generateSampleDocx,
  main,
};
