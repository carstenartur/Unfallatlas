"use strict";

// Optional source pilot: actual published Mannesmannufer hourly values and
// a separately licensed official station point with an opt-in cycleway binding.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const traffic = require('../../js/ua.traffic_provider');
const {parseCsv} = require('./koeln_kfz_link_csv_provider');

const SOURCE_ID = 'traffic.count.duesseldorf-mannesmannufer-hourly-2024';
const PUBLISHER = 'Landeshauptstadt Düsseldorf – Amt für Verkehrsmanagement';
const DISTRIBUTION_URL = 'https://opendata.duesseldorf.de/sites/default/files/Mannesmannufer_IN_OUT_2024_0.csv';
const STATIONS_URL = 'https://opendata.duesseldorf.de/sites/default/files/Z%C3%A4hlstellen_2.csv';
const DISTRIBUTION_SHA256 = '06f2f90fb145b224077f69f777aff345007ca7612f916b58ba9a764f6e1576f7';
const STATIONS_SHA256 = 'e436955bd45fc322d62cd96b9cbdcc353d5ea9256a950785fcee8d8cfaed32db';
const DISTRIBUTION_BYTES = 408091;
const STATIONS_BYTES = 1692;
const COUNT_HEADER_SHA256 = 'ad6dc3e2d2643877c72abf7041bedac470b7a21b725367be29c9f85ec354e2fc';
const STATION_HEADER = 'standort;installiert;latitude;longitude;kommentar';
const STATION_NAME = 'mannesmann ufer-totem 01';
const DIRECTIONS = Object.freeze(['Mannesmann Ufer Stadteinwaerts (Ri. Sueden)', 'Mannesmann Ufer Stadtauswaerts (Ri. Norden)']);
const UNBOUND_SOURCE_NOTE = 'Koordinaten aus expliziter Standortzeile mannesmann ufer-totem 01; keine belegte Lagegenauigkeit, Straßenpassung oder OSM-Way-ID.';
const UNBOUND_STATION_NOTE = 'Amtlicher Stationspunkt; Standortdistribution geändert 31.03.2022. Keine belegte Lagegenauigkeit oder OSM-/Straßenzuordnung.';
const REVIEWED_STATION_NOTE = 'Amtlicher Stationspunkt; Standortdistribution geändert 31.03.2022. Abstand zum geprüften Radweg aus den Geometrien berechnet; absolute Lagegenauigkeit unbekannt.';
const REVIEWED_DIRECTIONS = Object.freeze([
  Object.freeze({direction: DIRECTIONS[0], stationWayDirection: 'forward'}),
  Object.freeze({direction: DIRECTIONS[1], stationWayDirection: 'backward'}),
]);
const OSM_EVIDENCE_ROOT = path.join(__dirname, 'evidence/duesseldorf-mannesmannufer-2024');
const OSM_EVIDENCE = [
  ['way', 1219366607, 1, 626, '11e54518102d6e53a5fc8daf066f807f2c7d86e7b2c74f3f17847cfcbb4e26b4', '2026-11-13T05:28:39.297Z'],
  ['node', 11298492540, 1, 391, '8eed33e401d37e0e907cf6df7ba594ddee5dc7861c13508d11fbdc8769855264', '2026-11-13T05:28:39.294Z'],
  ['node', 1223516213, 3, 392, '8ed0b4f1efbcc36af110f70501e9fea8e720c75fd63506a62a17887e9f5d2fce', '2026-11-13T05:28:39.289Z'],
  ['node', 7756613438, 1, 392, '8147fb4e471786a7a3ed8f5845b05848058de25a16706633dd38a2cb31caa2f3', '2026-11-13T05:28:39.290Z'],
  ['node', 203983852, 15, 390, '4967acee047aa80f2f148c9eae75898656d776c4a648e6582335d933a84c40cc', '2026-11-13T05:28:39.299Z'],
];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

class DuesseldorfHourlyError extends Error {
  constructor(code, message) {super(`${code}: ${message}`); this.name = 'DuesseldorfHourlyError'; this.code = code;}
}
function fail(code, message) {throw new DuesseldorfHourlyError(code, message);}

function csv(bytes, limit) {
  if (!Buffer.isBuffer(bytes) || bytes.length > limit) fail('invalid_distribution', 'Expected bounded original CSV bytes');
  let text;
  try {text = new TextDecoder('utf8', {fatal: true}).decode(bytes);} catch (_) {fail('invalid_utf8', 'Original CSV must be UTF8');}
  try {return parseCsv(text);} catch (error) {fail('invalid_csv', error.message);}
}

function stationPoint(bytes) {
  const {delimiter, rows} = csv(bytes, 10000);
  if (delimiter !== ';' || rows[0].join(';') !== STATION_HEADER) fail('invalid_header', 'Official station columns changed');
  const seen = new Set();
  let selected;
  for (const row of rows.slice(1)) {
    if (row.length !== 5) fail('row_width', 'Invalid station row');
    const [name, installed, lat, lon, notes] = row;
    if (!name || seen.has(name)) fail('duplicate_station', 'Missing or duplicated official station name');
    seen.add(name);
    if (![lat, lon].every(value => /^\d+\.\d+$/.test(value)) || Number(lat) < 51 || Number(lat) > 52 || Number(lon) < 6 || Number(lon) > 7)
      fail('invalid_coordinate', 'Invalid official Düsseldorf station point');
    if (name === STATION_NAME) selected = {geometry: {type: 'Point', coordinates: [Number(lon), Number(lat)]}, installed, notes};
  }
  if (!selected) fail('missing_station', 'Exact reviewed official Mannesmannufer station absent');
  return selected;
}

function sourceTime(value) {
  const match = /^(\d{2})-(\d{2})-(2024) (\d{2}):00:00$/.exec(value);
  if (!match || Number(match[4]) > 23) fail('invalid_time', value);
  const [, day, month, year, hour] = match;
  // UTC is used only as a calendar-label arithmetic device. The source has no
  // timezone; this number is never emitted as a physical instant or UTC clock.
  const label = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour));
  const date = new Date(label);
  if (date.getUTCFullYear() !== 2024 || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) fail('invalid_time', value);
  return {label, id: `${year}${month}${day}T${hour}`};
}

function parseHourlyCsv(countBytes, stationBytes) {
  const station = stationPoint(stationBytes);
  const {delimiter, rows} = csv(countBytes, 1000000);
  if (delimiter !== ';' || sha256(rows[0].join(';')) !== COUNT_HEADER_SHA256) fail('invalid_header', 'Official count columns changed');
  const observations = [], gaps = [], seen = new Set();
  let previous, missingCountCells = 0;
  for (const row of rows.slice(1)) {
    if (row.length !== 6) fail('row_width', 'Incomplete or extended original count row');
    const time = sourceTime(row[0]);
    if (seen.has(row[0])) fail('duplicate_time', 'Ambiguous repeated source time label');
    seen.add(row[0]);
    if (previous) {
      const hours = (time.label - previous.label) / 3600000;
      if (hours <= 0) fail('unordered_time', 'Source rows are not chronological');
      if (hours !== 1) gaps.push({previous: previous.text, next: row[0], labelHours: hours});
    }
    previous = {...time, text: row[0]};
    for (const [i, direction] of DIRECTIONS.entries()) {
      const text = row[i + 1];
      if (text === '') {missingCountCells += 1; continue;}
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) fail('invalid_count', text);
      observations.push({observationId: `duesseldorf-mannesmannufer-${time.id}-${i === 0 ? 'in' : 'out'}`,
        measurementType: 'count', mode: 'bicycle', year: 2024, period: `Stundenwert, Quellzeit: ${row[0]}`,
        value: Number(text), unit: 'Fahrräder/Stunde', direction, geometry: station.geometry,
        qualityNotes: [
          'Originaler Stundenwert; Zeitzone und genaue Intervallgrenzen nicht angegeben. Keine Tagesumrechnung oder Richtungssumme.',
          'Zeitlücken bleiben Lücken; wiederholte Zeitlabels werden nicht ohne amtliche Unterscheidung zusammengefasst.',
          `Amtliche Standortbezeichnung: ${STATION_NAME}; installiert laut Standortdatei: ${station.installed}; ${station.notes}.`,
          UNBOUND_STATION_NOTE,
        ]});
    }
  }
  return {rowCount: rows.length - 1, missingCountCells, gaps, observations};
}

function createDescriptor(options) {
  const opts = options || {};
  for (const key of ['retrievedAt', 'stationsRetrievedAt'])
    if (typeof opts[key] !== 'string' || !opts[key].includes('T')) fail('invalid_date', `${key} requires an actual retrieval timestamp`);
  const base = {id: SOURCE_ID, publisher: PUBLISHER,
    datasetTitle: 'Mannesmannufer IN OUT – Wetterabhängige Jahresübersicht Dauerzählstelle 2024',
    datasetUrl: 'https://opendata.duesseldorf.de/dataset/wetterabh%C3%A4ngige-jahres%C3%BCbersicht-der-dauerz%C3%A4hlstellen-radverkehr-2024',
    distributionUrl: DISTRIBUTION_URL, licenseId: 'DL-DE-BY-2.0',
    licenseName: 'Datenlizenz Deutschland – Namensnennung – Version 2.0', licenseUrl: 'https://www.govdata.de/dl-de/by-2-0',
    requiredAttribution: 'Landeshauptstadt Düsseldorf', temporalCoverage: '2024-01-01/2024-12-31', spatialCoverage: 'Düsseldorf – Dauerzählstelle Mannesmannufer',
    contentHash: DISTRIBUTION_SHA256, changedOrDerived: true,
    changeNotice: 'Originale UTF8-CSV-Stundenwerte richtungsgetrennt normalisiert und mit dem ausdrücklich benannten amtlichen Standortpunkt verbunden; keine Tagesumrechnung, Lückenfüllung oder OSM-Zuordnung.',
    permissions: {permitsRedistribution: true, permitsDerivatives: true, commercialUseAllowed: true},
    measurementType: 'count', modes: ['bicycle'], unit: 'Fahrräder/Stunde', priority: 1};
  // Both acquisition clocks use the existing strict SourceManifest validator.
  // Only the primary count descriptor is emitted; geometry has its own literal
  // provenance/clock below, not a fictitious second count observation.
  traffic.normalizeDescriptor({...base, retrievedAt: opts.stationsRetrievedAt});
  return traffic.normalizeDescriptor({...base, retrievedAt: opts.retrievedAt, qualityNotes: [
    'Historische Richtungs-Stundenwerte 2024; kein DTV oder tägliches Verkehrsvolumen. Originale Zeitlabels ohne belegte Zeitzone/Intervallgrenzen.',
    'Original: 8.783 eindeutige Stundenlabels; 31.03.2024 02:00 fehlt, 27.10.2024 02:00 steht nur einmal. Keine Zeitzonen-/Sommerzeitrekonstruktion.',
    `Separate amtliche Standortdistribution: ${STATIONS_URL}; SHA256 ${STATIONS_SHA256}; Lizenz DL-DE-Zero-2.0; Abruf ${opts.stationsRetrievedAt}; Distributionsänderung 2022-03-31.`,
    UNBOUND_SOURCE_NOTE,
  ]});
}

function confinedFile(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) fail('unsafe_path', 'Expected confined relative file path');
  const file = path.resolve(root, relative), rel = path.relative(root, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('unsafe_path', 'File escapes allowedRoot');
  let cursor = root;
  for (const part of rel.split(path.sep)) {cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) fail('unsafe_symlink', 'File path contains symlink');}
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 1000000) fail('invalid_distribution', 'Not a bounded regular file');
  return file;
}

function readPinned(file, expectedHash, expectedBytes) {
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== expectedHash) fail('distribution_hash_mismatch', 'Original distribution bytes changed');
  if (bytes.length !== expectedBytes) fail('distribution_size_mismatch', 'Original distribution size changed');
  return bytes;
}

function loadReviewedWay() {
  const responses = OSM_EVIDENCE.map(([type, id, version, bytes, contentHash, retrievedAt]) => {
    const filename = `${type}-${id}-v${version}.json`;
    const {elements} = JSON.parse(readPinned(path.join(OSM_EVIDENCE_ROOT, filename), contentHash, bytes));
    const element = elements?.[0];
    if (elements?.length !== 1 || element?.type !== type || element.id !== id || element.version !== version) {
      fail('unreviewed_cycleway', `Unexpected historical OSM element in ${filename}`);
    }
    return {
      element,
      source: Object.freeze({distributionUrl: `https://api.openstreetmap.org/api/0.6/${type}/${id}/${version}.json`,
        bytes, contentHash, retrievedAt}),
    };
  });
  const [{element: way}, ...nodes] = responses;
  if (way.tags?.highway !== 'cycleway' || way.tags.oneway !== 'no' ||
      way.nodes?.length !== nodes.length || nodes.some(({element}, index) => element.id !== way.nodes[index])) {
    fail('unreviewed_cycleway', 'The historical way must be the reviewed two-way cycleway in OSM node order');
  }
  const coordinates = Object.freeze(nodes.map(({element}) => Object.freeze([element.lon, element.lat])));
  if (coordinates.some(([, lat], index) => index > 0 && lat >= coordinates[index - 1][1])) {
    fail('unreviewed_direction', 'The reviewed way runs south in OSM node order');
  }
  return {
    way: Object.freeze({id: String(way.id), version: way.version,
      geometry: Object.freeze({type: 'LineString', coordinates})}),
    responses: Object.freeze(responses.map(({source}) => source)),
  };
}

function reviewedStationContext(rawObservations, station, descriptor, stationRetrievedAt, coverage) {
  const {way, responses} = loadReviewedWay();
  const counts = traffic.normalizeDescriptor({...descriptor,
    changeNotice: `Originale Fahrrad-Stundenwerte richtungsgetrennt normalisiert und dem geprüften OSM-Weg ${way.id} an der Zählstelle zugeordnet.`,
    qualityNotes: descriptor.qualityNotes.map(note => note === UNBOUND_SOURCE_NOTE ? REVIEWED_STATION_NOTE : note),
  });
  const observations = rawObservations.map((reading, index) => {
    const direction = REVIEWED_DIRECTIONS.find(item => item.direction === reading.direction);
    if (!direction) fail('unreviewed_direction', `Unknown Mannesmannufer count direction: ${reading.direction}`);
    return traffic.normalizeObservation({...reading, geometry: station.geometry, wayId: way.id,
      stationWayDirection: direction.stationWayDirection,
      qualityNotes: reading.qualityNotes.map(note => note === UNBOUND_STATION_NOTE ? REVIEWED_STATION_NOTE : note),
    }, counts, index);
  });
  // Only the reviewed way is a candidate. The generic matcher can fall back to
  // a nearest segment when an explicit way ID is missing from a larger network.
  const matched = traffic.matchObservationToRoads(observations[0],
    [{wayId: way.id, coordinates: way.geometry.coordinates}], {maxDistanceMeters: 10});
  if (!matched) fail('unreviewed_cycleway', 'The station lies outside the reviewed cycleway distance');
  return Object.freeze({
    station, way, directions: REVIEWED_DIRECTIONS, coverage,
    match: Object.freeze({distanceMeters: matched.distanceMeters, method: matched.matchMethod}),
    timeZone: null,
    intervalBoundary: null,
    observations: Object.freeze(observations),
    osmResponses: responses,
    sources: Object.freeze({
      counts,
      station: Object.freeze({
        sourceId: 'road-context.duesseldorf-bicycle-stations', role: 'road_context', publisher: PUBLISHER,
        datasetTitle: 'Standorte der Dauerzählstellen Radverkehr in Düsseldorf',
        datasetUrl: 'https://opendata.duesseldorf.de/dataset/standorte-der-dauerz%C3%A4hlstellen-radverkehr-d%C3%BCsseldorf',
        distributionUrl: STATIONS_URL, licenseId: 'DL-DE-Zero-2.0',
        licenseName: 'Datenlizenz Deutschland – Zero – Version 2.0', licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0',
        contentHash: STATIONS_SHA256, retrievedAt: stationRetrievedAt, versionOrPublicationDate: '2022-03-31',
        changedOrDerived: true, changeNotice: 'Amtliche Standortzeile Mannesmannufer aus der CSV ausgewählt.',
      }),
      osm: Object.freeze({
        sourceId: 'road-context.osm-mannesmannufer-cycleway', role: 'road_context', publisher: 'OpenStreetMap contributors',
        datasetTitle: 'OpenStreetMap – Radweg am Mannesmannufer, Weg 1219366607',
        datasetUrl: `https://www.openstreetmap.org/way/${way.id}`, distributionUrl: responses[0].distributionUrl,
        contentHash: responses[0].contentHash, retrievedAt: responses[0].retrievedAt, licenseId: 'ODbL-1.0',
        licenseName: 'Open Data Commons Open Database License 1.0', licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
        requiredAttribution: '© OpenStreetMap contributors', changedOrDerived: true,
        changeNotice: 'Liniengeometrie aus vier einzeln versionierten OSM-Knoten in Wegreihenfolge zusammengesetzt.',
      }),
    }),
  });
}

function createDuesseldorfBicycleHourlyProvider(options) {
  const opts = options || {};
  if (opts.expectedDistributionSha256 !== DISTRIBUTION_SHA256 || opts.expectedBytes !== DISTRIBUTION_BYTES ||
      opts.expectedStationsSha256 !== STATIONS_SHA256 || opts.expectedStationsBytes !== STATIONS_BYTES)
    fail('unreviewed_distribution', 'Both reviewed original hashes and byte sizes are required');
  const descriptor = createDescriptor(opts);
  if (typeof opts.allowedRoot !== 'string') fail('unsafe_path', 'Expected explicit local allowedRoot');
  const root = fs.realpathSync(opts.allowedRoot);
  const csvPath = confinedFile(root, opts.csvPath), stationsPath = confinedFile(root, opts.stationsPath);
  const parsed = parseHourlyCsv(readPinned(csvPath, DISTRIBUTION_SHA256, DISTRIBUTION_BYTES), readPinned(stationsPath, STATIONS_SHA256, STATIONS_BYTES));
  const station = Object.freeze({id: 'duesseldorf-mannesmannufer', sourceName: STATION_NAME,
    geometry: Object.freeze({type: 'Point', coordinates: Object.freeze([...parsed.observations[0].geometry.coordinates])})});
  const stationRetrievedAt = opts.stationsRetrievedAt;
  const provider = traffic.createProvider({descriptor, canProvide: context =>
    ['Düsseldorf', 'Duesseldorf'].includes(context.city) && context.mode === 'bicycle', loadObservations: async () => parsed.observations});
  const coverage = Object.freeze({rowCount: parsed.rowCount, missingCountCells: parsed.missingCountCells,
    gaps: parsed.gaps, observationCount: parsed.observations.length, stationCount: 1});
  const reviewedCoverage = Object.freeze({...coverage, gaps: Object.freeze(parsed.gaps.map(gap => Object.freeze({...gap})))});
  return Object.freeze({...provider, coverage,
    loadReviewedStationContext() {
      return reviewedStationContext(parsed.observations, station, descriptor, stationRetrievedAt, reviewedCoverage);
    },
  });
}

module.exports = Object.freeze({SOURCE_ID, DISTRIBUTION_URL, STATIONS_URL, DISTRIBUTION_SHA256, DISTRIBUTION_BYTES,
  STATIONS_SHA256, STATIONS_BYTES, DuesseldorfHourlyError, parseHourlyCsv, createDescriptor, createDuesseldorfBicycleHourlyProvider});
