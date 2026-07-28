#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createDeterministicMapPng, toDataUrl } = require('./deterministic-map-fixture');
const docxSourceLinks = require('../js/ua.docx_source_links');
const docxPagination = require('../js/ua.docx_pagination');

const GOLDEN_SCENARIOS = Object.freeze({
  'bonn-standard': Object.freeze({
    id: 'bonn-standard',
    city: 'Bonn',
    count: 24,
    clusterCount: 11,
    areaName: 'Innerstädtischer Knoten Bonn-Zentrum',
    bounds: Object.freeze({ south: 50.728, west: 7.087, north: 50.739, east: 7.105 }),
    contextMode: 'available',
  }),
  'hannover-standard': Object.freeze({
    id: 'hannover-standard',
    city: 'Hannover',
    count: 18,
    clusterCount: 7,
    areaName: 'Innerstädtischer Knoten Hannover-Mitte',
    bounds: Object.freeze({ south: 52.366, west: 9.721, north: 52.381, east: 9.745 }),
    contextMode: 'available',
  }),
  'bonn-few-rows': Object.freeze({
    id: 'bonn-few-rows',
    city: 'Bonn',
    count: 3,
    clusterCount: 2,
    areaName: 'Kleiner Auswertungsfall Bonn',
    bounds: Object.freeze({ south: 50.731, west: 7.092, north: 50.735, east: 7.099 }),
    contextMode: 'available',
  }),
  'hannover-many-rows': Object.freeze({
    id: 'hannover-many-rows',
    city: 'Hannover',
    count: 72,
    clusterCount: 24,
    areaName: 'Mehrseitiger Auswertungsfall Hannover',
    bounds: Object.freeze({ south: 52.35, west: 9.69, north: 52.405, east: 9.78 }),
    contextMode: 'available',
  }),
  'bonn-missing-context': Object.freeze({
    id: 'bonn-missing-context',
    city: 'Bonn',
    count: 8,
    clusterCount: 4,
    areaName: 'Bonn ohne verfügbare Kontextdaten',
    bounds: Object.freeze({ south: 50.728, west: 7.087, north: 50.739, east: 7.105 }),
    contextMode: 'missing',
  }),
});

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
    else if (arg === '--scenario') options.scenarioId = argv[++index];
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
  const columns = Math.max(3, Math.min(12, Math.ceil(Math.sqrt(Math.max(1, count)))));
  const rows = Math.max(1, Math.ceil(Math.max(1, count) / columns));
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const latitude = south + ((row + 1) / (rows + 1)) * (north - south);
    const longitude = west + ((column + 1) / (columns + 1)) * (east - west);
    const severity = index % 12 === 0 ? 1 : index % 4 === 0 ? 2 : 3;
    const year = 2022 + (index % 3);
    return {
      lat: latitude,
      lon: longitude,
      latitude,
      longitude,
      severity,
      year,
      IstRad: 1,
      IstPKW: 1,
      props: {
        ukategorie: String(severity),
        ujahr: String(year),
        strzustand: '0',
        uwochentag: String((index % 5) + 1),
        ustunde: String(7 + (index % 12)),
        istrad: '1',
        istpkw: '1',
        istfuss: '0',
        istkrad: '0',
        istgkfz: '0',
        istsonstig: '0',
      },
    };
  });
}

function createBounds(raw = {}) {
  const south = Number(raw.south ?? 50.728);
  const west = Number(raw.west ?? 7.087);
  const north = Number(raw.north ?? 50.739);
  const east = Number(raw.east ?? 7.105);
  const center = { lat: (south + north) / 2, lng: (west + east) / 2 };
  return {
    south, west, north, east,
    getSouth: () => south,
    getWest: () => west,
    getNorth: () => north,
    getEast: () => east,
    getSouthWest: () => ({ lat: south, lng: west }),
    getNorthEast: () => ({ lat: north, lng: east }),
    getCenter: () => ({ ...center }),
    contains: () => true,
  };
}

function createContext() {
  const bounds = createBounds();
  const points = createAccidentPoints(24, bounds);
  return createContextFromScenario(GOLDEN_SCENARIOS['bonn-standard'], points, bounds);
}

function createContextFromScenario(scenario, points, suppliedBounds) {
  const bounds = suppliedBounds || createBounds(scenario.bounds);
  const center = bounds.getCenter();
  const context = {
    CITY_RAW: scenario.city,
    mapMode: 'standard',
    map: {
      getCenter: () => ({ ...center }),
      getZoom: () => scenario.count > 40 ? 13 : 15,
      getBounds: () => bounds,
      eachLayer: () => {},
      fitBounds: () => {},
      setView: () => {},
    },
    selectionBounds: bounds,
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
  if (scenario.contextMode === 'missing') {
    context.contextDataState = Object.freeze({
      status: 'missing',
      slope: false,
      traffic: false,
      roads: false,
    });
  }
  return context;
}

function severitySummary(points) {
  const bySev = { '1': 0, '2': 0, '3': 0, other: 0 };
  for (const point of points) {
    const key = String(point.severity);
    if (Object.prototype.hasOwnProperty.call(bySev, key)) bySev[key] += 1;
    else bySev.other += 1;
  }
  return { total: points.length, bySev };
}

function yearSummary(points) {
  const rows = new Map();
  for (const point of points) {
    const year = Number(point.year);
    if (!rows.has(year)) rows.set(year, { year, total: 0, classes: [] });
    rows.get(year).total += 1;
  }
  return [...rows.values()].sort((left, right) => left.year - right.year).map(row => ({
    ...row,
    classes: [`[Rad]+[PKW]=${row.total}`],
  }));
}

function formatBounds(bounds) {
  return `${String(bounds.south).replace('.', ',')}–${String(bounds.north).replace('.', ',')} N; ` +
    `${String(bounds.west).replace('.', ',')}–${String(bounds.east).replace('.', ',')} E`;
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

function createReportDataFromScenario(scenario, points) {
  if (scenario.id === 'bonn-standard') return createReportData();
  const serious = Math.min(points.length, Math.max(1, Math.round(points.length * 0.42)));
  const baselineTotal = Math.max(100, points.length * 20);
  const baselineMask = Math.max(10, Math.round(baselineTotal * 0.15));
  const factor = Number(((serious / Math.max(1, points.length)) /
    (baselineMask / baselineTotal)).toFixed(2));
  const contextSentence = scenario.contextMode === 'missing'
    ? 'Für diesen Fall stehen keine Straßen-, Steigungs- oder Verkehrskontextdaten zur Verfügung; der Bericht kennzeichnet diese Lücke ausdrücklich.'
    : 'Verfügbare Kontextinformationen werden ergänzend dargestellt, aber nicht als Kausalnachweis interpretiert.';
  return {
    text: [
      'Sachverhalt:',
      `Im markierten Bereich in ${scenario.city} wurden ${points.length} Unfälle mit Personenschaden aus den Jahren 2022 bis 2024 ausgewertet.`,
      'Die räumliche Auswahl, die Unfallpunkte und die Verletzungsschwere sind in der Übersichtskarte gemeinsam dargestellt.',
      '',
      'Methodik',
      `Die Auswertung umfasst ausschließlich den markierten Kartenausschnitt und die aktiven Filter. ${contextSentence}`,
      '',
      'Beschlussvorschlag:',
      'Die zuständige Verwaltung wird gebeten, den Bereich auf kurzfristige Sicht-, Markierungs- und Führungsmaßnahmen zu prüfen und dem zuständigen Gremium schriftlich zu berichten.',
      '',
      'Datenquelle',
      'Unfallatlas der Statistischen Ämter des Bundes und der Länder: https://www.statistikportal.de/de/karten/unfallatlas',
    ].join('\n'),
    structured: {
      meta: {
        city: scenario.city,
        date: '28.07.2026',
        areaName: scenario.areaName,
        bounds: formatBounds(scenario.bounds),
        link: `https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=${encodeURIComponent(scenario.city)}`,
        filters: {
          involvementMode: 'and',
          includeCyclist: true,
          includeCar: true,
        },
        contextAvailability: scenario.contextMode,
        gremium: { typ: 'Bezirksvertretung' },
      },
      severity: severitySummary(points),
      deviations: {
        focus: [{
          mask: 5,
          label: '[Rad]+[PKW]',
          locCnt: serious,
          baseCnt: baselineMask,
          locR: serious / Math.max(1, points.length),
          baseR: baselineMask / baselineTotal,
          factor,
        }],
        rows: [],
        local: { total: points.length, byMask: { 5: serious } },
        baseline: { total: baselineTotal, byMask: { 5: baselineMask } },
      },
      yearTable: yearSummary(points),
      patterns: [],
      poi: null,
      references: [{
        title: 'Unfallatlas – Straßenverkehrsunfälle mit Personenschaden',
        url: 'https://www.statistikportal.de/de/karten/unfallatlas',
      }],
    },
  };
}

function resolveScenario(id) {
  const scenarioId = id || 'bonn-standard';
  const scenario = GOLDEN_SCENARIOS[scenarioId];
  if (!scenario) {
    fail('unknown_scenario', `Unknown Golden scenario: ${scenarioId}`, {
      available: Object.keys(GOLDEN_SCENARIOS),
    });
  }
  return scenario;
}

function createGoldenScenario(id) {
  const scenario = resolveScenario(id);
  const bounds = createBounds(scenario.bounds);
  const points = createAccidentPoints(scenario.count, bounds);
  return {
    descriptor: scenario,
    points,
    context: createContextFromScenario(scenario, points, bounds),
    reportData: createReportDataFromScenario(scenario, points),
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
  const scenario = createGoldenScenario(options.scenarioId || 'bonn-standard');
  const descriptor = scenario.descriptor;
  const context = options.context || scenario.context;
  const reportData = options.reportData || scenario.reportData;
  const outPath = path.resolve(
    options.outPath || path.join(__dirname, '..', 'out', 'ci-render-gate.docx'),
  );
  const mapDataUrl = toDataUrl(
    createDeterministicMapPng({
      width: 960,
      height: 640,
      title: `${descriptor.city} road-safety golden fixture`,
      scenario: descriptor.id,
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
  new Function('window', utilsSource)(mockWindow); // eslint-disable-line no-new-func
  new Function('window', reportSource)(mockWindow); // eslint-disable-line no-new-func

  const UA = mockWindow.UA;
  UA.captureExportMapImage = async () => mapDataUrl;
  UA._captureExportMapImage = UA.captureExportMapImage;
  UA._captureDetailMap = async () => mapDataUrl;
  UA._captureClusterMaps = async () => [{
    image: mapDataUrl,
    bounds: descriptor.bounds,
    total: descriptor.clusterCount,
    points: scenario.points.slice(0, descriptor.clusterCount),
    label: `Detailkarte ${descriptor.areaName}`,
    zoom: descriptor.count > 40 ? 14 : 16,
    lat: context.map.getCenter().lat,
    lon: context.map.getCenter().lng,
  }];
  const linkRuntime = docxSourceLinks.install(UA, mockWindow);
  if (!linkRuntime.available) {
    fail('docx_source_links_unavailable', 'DOCX source-link runtime could not be installed');
  }
  const paginationRuntime = docxPagination.install(UA, mockWindow);
  if (!paginationRuntime.available) {
    fail('docx_pagination_unavailable', 'DOCX pagination runtime could not be installed');
  }

  await UA.exportToWord(context, reportData, {
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
    scenarioId: descriptor.id,
    city: descriptor.city,
    accidentCount: descriptor.count,
    contextMode: descriptor.contextMode,
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
    `[generate-sample-docx] ${result.scenarioId}: wrote ${result.bytes} bytes to ${result.outPath}; ` +
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
  GOLDEN_SCENARIOS,
  SampleDocxError,
  parseArgs,
  createAccidentPoints,
  createBounds,
  createContext,
  createContextFromScenario,
  createReportData,
  createReportDataFromScenario,
  createGoldenScenario,
  resolveScenario,
  severitySummary,
  yearSummary,
  assertDocxBytes,
  generateSampleDocx,
  main,
};
