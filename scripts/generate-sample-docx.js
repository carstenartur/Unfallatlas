#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { createDeterministicMapPng, toDataUrl } = require('./deterministic-map-fixture');
const scenarios = require('./document-golden-scenarios');
const docxSourceLinks = require('../js/ua.docx_source_links');
const docxPagination = require('../js/ua.docx_pagination');

const DEFAULT_SCENARIO_ID = 'bonn-urban-junction';
const BASELINE_MAP_DESCRIPTION =
  '24 synthetic accidents, severity table, year trend and two report maps.';

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
    else if (arg === '--scenario') options.scenario = argv[++index];
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

function resolveScenario(value) {
  if (value == null) return scenarios.getScenario(DEFAULT_SCENARIO_ID);
  if (typeof value === 'string') return scenarios.getScenario(value);
  return scenarios.normalizeScenario(value);
}

function isBaselineScenario(scenario) {
  return Boolean(scenario && scenario.id === DEFAULT_SCENARIO_ID);
}

function involvementFlags(involvement = {}) {
  return Object.freeze({
    IstRad: involvement.cyclist ? 1 : 0,
    IstFuss: involvement.pedestrian ? 1 : 0,
    IstPKW: involvement.car ? 1 : 0,
    IstKrad: involvement.motorcycle ? 1 : 0,
    IstGkfz: involvement.heavyGoods ? 1 : 0,
    IstSonstig: involvement.other ? 1 : 0,
  });
}

function createAccidentPoints(count, bounds = {}, involvement = {
  cyclist: true,
  pedestrian: false,
  car: true,
  motorcycle: false,
  heavyGoods: false,
  other: false,
}) {
  const south = Number(bounds.south ?? 50.728);
  const west = Number(bounds.west ?? 7.087);
  const north = Number(bounds.north ?? 50.739);
  const east = Number(bounds.east ?? 7.105);
  const columns = 6;
  const rows = Math.max(1, Math.ceil(count / columns));
  const rowDivisor = Math.max(6, rows + 1);
  const flags = involvementFlags(involvement);
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const latitude = south + ((row + 1) / rowDivisor) * (north - south);
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
      ...flags,
      // The live application carries the original normalized Unfallatlas
      // fields under props. Keep the convenience top-level fields above for
      // render helpers, but also provide the real filter/mask input shape so
      // unrestricted and involvement-filtered map populations are computed
      // through the same code paths as browser data.
      props: {
        ukategorie: String(severity),
        ujahr: String(year),
        strzustand: '0',
        uwochentag: String((index % 5) + 1),
        ustunde: String(7 + (index % 12)),
        istrad: String(flags.IstRad),
        istfuss: String(flags.IstFuss),
        istpkw: String(flags.IstPKW),
        istkrad: String(flags.IstKrad),
        istgkfz: String(flags.IstGkfz),
        istsonstig: String(flags.IstSonstig),
      },
    };
  });
}

function createBounds(scenario) {
  const source = scenario.bounds;
  return {
    south: source.south,
    west: source.west,
    north: source.north,
    east: source.east,
    getSouth: () => source.south,
    getWest: () => source.west,
    getNorth: () => source.north,
    getEast: () => source.east,
    getSouthWest: () => ({ lat: source.south, lng: source.west }),
    getNorthEast: () => ({ lat: source.north, lng: source.east }),
    getCenter: () => ({ lat: scenario.center.lat, lng: scenario.center.lon }),
    contains: (point) => Boolean(
      point &&
      Number(point.lat) >= source.south && Number(point.lat) <= source.north &&
      Number(point.lon ?? point.lng) >= source.west && Number(point.lon ?? point.lng) <= source.east
    ),
  };
}

function createContext(scenarioValue) {
  const scenario = resolveScenario(scenarioValue);
  const bounds = createBounds(scenario);
  const points = createAccidentPoints(
    scenario.accidentCount,
    bounds,
    scenario.involvement,
  );
  return {
    CITY_RAW: scenario.city,
    mapMode: 'standard',
    map: {
      getCenter: () => ({ lat: scenario.center.lat, lng: scenario.center.lon }),
      getZoom: () => scenario.zoom,
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
    // captions claimed n=0 while the narrative and tables contained cases.
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
      incBikeEl: { checked: scenario.involvement.cyclist },
      incPedEl: { checked: scenario.involvement.pedestrian },
      incCarEl: { checked: scenario.involvement.car },
      incMotoEl: { checked: scenario.involvement.motorcycle },
      incGkfzEl: { checked: scenario.involvement.heavyGoods },
      incSonEl: { checked: scenario.involvement.other },
    },
  };
}

function formatDecimal(value) {
  return Number(value).toFixed(3).replace('.', ',');
}

function scenarioMask(involvement) {
  return (involvement.cyclist ? 1 : 0) |
    (involvement.pedestrian ? 2 : 0) |
    (involvement.car ? 4 : 0) |
    (involvement.motorcycle ? 8 : 0) |
    (involvement.heavyGoods ? 16 : 0) |
    (involvement.other ? 32 : 0);
}

function involvementLabel(involvement) {
  const labels = [];
  if (involvement.cyclist) labels.push('[Rad]');
  if (involvement.pedestrian) labels.push('[Fuß]');
  if (involvement.car) labels.push('[PKW]');
  if (involvement.motorcycle) labels.push('[Krad]');
  if (involvement.heavyGoods) labels.push('[Gkfz]');
  if (involvement.other) labels.push('[Sonstige]');
  return labels.join('+');
}

function severitySummary(points) {
  const bySev = { '1': 0, '2': 0, '3': 0, other: 0 };
  for (const point of points) {
    const key = String(point.severity);
    if (Object.hasOwn(bySev, key)) bySev[key] += 1;
    else bySev.other += 1;
  }
  return { total: points.length, bySev };
}

function yearSummary(points, label) {
  const years = new Map();
  for (const point of points) years.set(point.year, (years.get(point.year) || 0) + 1);
  return [...years.entries()]
    .sort(([left], [right]) => left - right)
    .map(([year, total]) => ({ year, total, classes: [`${label}=${total}`] }));
}

function createBaselineReportData() {
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

function createReportData(scenarioValue) {
  const scenario = resolveScenario(scenarioValue);
  if (isBaselineScenario(scenario)) return createBaselineReportData();

  const points = createAccidentPoints(
    scenario.accidentCount,
    scenario.bounds,
    scenario.involvement,
  );
  const mask = scenarioMask(scenario.involvement);
  const label = involvementLabel(scenario.involvement);
  const localFocus = Math.max(1, Math.min(scenario.accidentCount, scenario.clusterCount));
  const baseTotal = Math.max(820, scenario.accidentCount * 20);
  const baseFocus = Math.max(localFocus + 1, Math.round(baseTotal * 0.15));
  const focus = scenario.accidentCount < 5
    ? []
    : [
        {
          mask,
          label,
          locCnt: localFocus,
          baseCnt: baseFocus,
          locR: localFocus / scenario.accidentCount,
          baseR: baseFocus / baseTotal,
          factor: (localFocus / scenario.accidentCount) / (baseFocus / baseTotal),
        },
      ];
  const contextLine = scenario.context.status === 'available'
    ? `Kontextstatus: verfügbar. ${scenario.context.summary}`
    : scenario.context.status === 'uncertain'
      ? `Kontextstatus: unsicher. ${scenario.context.summary}`
      : `Kontextstatus: nicht verfügbar. ${scenario.context.summary}`;
  return {
    text: [
      'Sachverhalt:',
      `Im markierten Untersuchungsraum ${scenario.areaName} wurden ${scenario.accidentCount} Unfälle mit Personenschaden aus den Jahren 2022 bis 2024 ausgewertet.`,
      'Die räumliche Auswahl, die Unfallpunkte und die Verletzungsschwere sind in der Übersichtskarte gemeinsam dargestellt.',
      '',
      'Methodik',
      'Die Auswertung umfasst ausschließlich den markierten Kartenausschnitt und die aktiven Filter. Kontextinformationen werden nicht als Kausalnachweis interpretiert.',
      contextLine,
      ...scenario.narrativeParagraphs.flatMap((paragraph) => ['', paragraph]),
      '',
      'Beschlussvorschlag:',
      'Die zuständige Verwaltung wird gebeten, den Untersuchungsraum innerhalb von sechs Monaten auf kurzfristige Sicht-, Markierungs- und Führungsmaßnahmen zu prüfen und dem zuständigen Gremium schriftlich über Ergebnis und Umsetzungszeitraum zu berichten.',
      '',
      'Datenquelle',
      'Unfallatlas der Statistischen Ämter des Bundes und der Länder: https://www.statistikportal.de/de/karten/unfallatlas',
    ].join('\n'),
    structured: {
      meta: {
        city: scenario.city,
        date: '28.07.2026',
        areaName: scenario.areaName,
        bounds: `${formatDecimal(scenario.bounds.south)}–${formatDecimal(scenario.bounds.north)} N; ` +
          `${formatDecimal(scenario.bounds.west)}–${formatDecimal(scenario.bounds.east)} E`,
        link: `https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?city=${encodeURIComponent(scenario.city)}`,
        filters: {
          involvementMode: 'and',
          includeCyclist: scenario.involvement.cyclist,
          includePedestrian: scenario.involvement.pedestrian,
          includeCar: scenario.involvement.car,
          includeMotorcycle: scenario.involvement.motorcycle,
          includeHeavyGoods: scenario.involvement.heavyGoods,
          includeOther: scenario.involvement.other,
        },
        gremium: { typ: 'Bezirksvertretung' },
      },
      severity: severitySummary(points),
      deviations: {
        focus,
        rows: [],
        local: {
          total: scenario.accidentCount,
          byMask: { [mask]: localFocus },
        },
        baseline: {
          total: baseTotal,
          byMask: { [mask]: baseFocus },
        },
      },
      yearTable: yearSummary(points, label),
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

function assertDocxBytes(buffer, minimumBytes = 1024) {
  if (!Buffer.isBuffer(buffer) || buffer.length < minimumBytes) {
    fail('invalid_docx', 'Generated DOCX is unexpectedly small', {
      minimumBytes,
      actualBytes: Buffer.isBuffer(buffer) ? buffer.length : null,
    });
  }
  if (buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    fail('invalid_docx', 'Generated document does not have a ZIP/DOCX signature');
  }
  return buffer;
}

function clusterBounds(scenario) {
  if (isBaselineScenario(scenario)) {
    return { south: 50.73, west: 7.091, north: 50.735, east: 7.101 };
  }
  const latInset = (scenario.bounds.north - scenario.bounds.south) * 0.2;
  const lonInset = (scenario.bounds.east - scenario.bounds.west) * 0.2;
  return {
    south: scenario.bounds.south + latInset,
    west: scenario.bounds.west + lonInset,
    north: scenario.bounds.north - latInset,
    east: scenario.bounds.east - lonInset,
  };
}

function mapFixtureMetadata(scenario) {
  return Object.freeze({
    title: `${scenario.city} road-safety golden fixture`,
    scenario: isBaselineScenario(scenario)
      ? BASELINE_MAP_DESCRIPTION
      : scenario.description,
  });
}

function clusterLabel(scenario) {
  return isBaselineScenario(scenario)
    ? 'Detailkarte Bonn-Zentrum'
    : `Detailkarte ${scenario.areaName}`;
}

async function generateSampleDocx(options = {}) {
  const scenario = resolveScenario(options.scenario);
  const outPath = path.resolve(
    options.outPath || path.join(__dirname, '..', 'out', 'ci-render-gate.docx'),
  );
  const mapMetadata = mapFixtureMetadata(scenario);
  const mapDataUrl = toDataUrl(
    createDeterministicMapPng({
      width: 960,
      height: 640,
      ...mapMetadata,
    }),
  );
  const capturedDownloads = [];
  const mockWindow = {
    UA: {},
    location: {
      href: 'https://carstenartur.github.io/Unfallatlas/werkbank_v2.html',
      pathname: '/Unfallatlas/werkbank_v2.html',
      search: `?city=${encodeURIComponent(scenario.city)}`,
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
  const detailBounds = clusterBounds(scenario);
  UA._captureClusterMaps = async () => [
    {
      image: mapDataUrl,
      bounds: detailBounds,
      total: scenario.clusterCount,
      points: createAccidentPoints(
        scenario.clusterCount,
        detailBounds,
        scenario.involvement,
      ),
      label: clusterLabel(scenario),
      zoom: scenario.zoom + 1,
      lat: scenario.center.lat,
      lon: scenario.center.lon,
    },
  ];
  const linkRuntime = docxSourceLinks.install(UA, mockWindow);
  if (!linkRuntime.available) {
    fail('docx_source_links_unavailable', 'DOCX source-link runtime could not be installed');
  }
  const paginationRuntime = docxPagination.install(UA, mockWindow);
  if (!paginationRuntime.available) {
    fail('docx_pagination_unavailable', 'DOCX pagination runtime could not be installed');
  }

  const context = options.context || createContext(scenario);
  const reportData = options.reportData || createReportData(scenario);
  await UA.exportToWord(context, reportData, {
    ...scenario.exportOptions,
    ...(options.exportOptions || {}),
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
  const buffer = assertDocxBytes(
    Buffer.from(await download.blob.arrayBuffer()),
    scenario.expectations.minimumDocxBytes,
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
  return {
    scenarioId: scenario.id,
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
    `[generate-sample-docx] scenario ${result.scenarioId}: wrote ${result.bytes} bytes ` +
      `to ${result.outPath}; embedded map fixture ${result.mapBytes} bytes; ` +
      `browser name ${result.downloadName}.\n`,
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
  DEFAULT_SCENARIO_ID,
  BASELINE_MAP_DESCRIPTION,
  SampleDocxError,
  parseArgs,
  resolveScenario,
  isBaselineScenario,
  involvementFlags,
  createAccidentPoints,
  createBounds,
  createContext,
  severitySummary,
  yearSummary,
  createBaselineReportData,
  createReportData,
  assertDocxBytes,
  clusterBounds,
  mapFixtureMetadata,
  clusterLabel,
  generateSampleDocx,
  main,
};
