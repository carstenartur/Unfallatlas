"use strict";

// Optional local-file adapter for the independently inspected official 2023
// annual export. Station points are not OSM ways or a directional road match.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {TextDecoder} = require('node:util');
const traffic = require('../../js/ua.traffic_provider');
const {parseCsv} = require('./koeln_kfz_link_csv_provider');

const SOURCE_ID = 'traffic.count.bast-annual-dtv-2023';
const DISTRIBUTION_URL = 'https://www.bast.de/DE/Themen/Digitales/HF_1/Massnahmen/verkehrszaehlung/Daten/2023_1/Jawe2023.csv?view=renderTcDataExportCSV&strTyp=A';
const DATASET_URL = 'https://data.gov.de/suche/daten/automatische-zahlstellen-auf-autobahnen-und-bundesstrassen';
const REVIEWED_DISTRIBUTION_SHA256 = '5108764655cc3d75878a887d4631f787d8216c54bb3fc3b63460c1a7b0fcb550';
const REVIEWED_DISTRIBUTION_BYTES = 1878927;
const HEADER_SHA256 = '1d657318a3437c3b1ac27ad938026137232d6834a509c7c4a64c0cbd8d72174c';
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

class BastAnnualDtvError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = 'BastAnnualDtvError'; this.code = code; }
}
function fail(code, message) { throw new BastAnnualDtvError(code, message); }

function count(value) {
  if (value === '') return null;
  // The original export uses German grouping, not a decimal traffic count.
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(value)) fail('invalid_count', value);
  const result = Number(value.replace(/\./g, ''));
  if (!Number.isSafeInteger(result)) fail('invalid_count', value);
  return result;
}

function coordinate(value, minimum, maximum) {
  if (!/^\d{1,2},\d+$/.test(value)) fail('invalid_coordinate', value);
  const result = Number(value.replace(',', '.'));
  if (!Number.isFinite(result) || result < minimum || result > maximum) fail('invalid_coordinate', value);
  return result;
}

function parseAnnualCsv(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 2000000) fail('invalid_distribution', 'Expected bounded ISO-8859-15 CSV bytes');
  let parsed;
  try { parsed = parseCsv(new TextDecoder('iso-8859-15', {fatal: true}).decode(bytes)); }
  catch (error) { fail('invalid_csv', error.message); }
  const [header, ...rows] = parsed.rows;
  if (parsed.delimiter !== ';' || sha256(header.join(';')) !== HEADER_SHA256) fail('invalid_header', 'Official 2023 column layout changed');
  const observations = [];
  const ids = new Set();
  let stationsWithoutCount = 0;
  for (const row of rows) {
    if (row.length !== header.length) fail('row_width', 'Incomplete or extended station row');
    const fields = Object.fromEntries(header.map((name, i) => [name, row[i].trim()]));
    const id = fields.DZ_Nr;
    if (!/^\d{1,8}$/.test(id) || !fields.DZ_Name) fail('invalid_station', 'Missing official identity');
    if (ids.has(id)) fail('duplicate_station', id);
    ids.add(id);
    const geometry = {type: 'Point', coordinates: [coordinate(fields.Koor_WGS84_E, 5, 16), coordinate(fields.Koor_WGS84_N, 47, 56)]};
    const days = count(fields.vT_MobisSo);
    if (days !== null && days > 365) fail('invalid_count', 'Counted days exceed 2023');
    const qualityNotes = [
      `BASt-Zählstelle ${id}: ${fields.DZ_Name}; Straße ${fields.Str_Kl}${fields.Str_Nr}${fields.Str_Zus}; TK ${fields.TK_Nr}.`,
      'Amtlicher Stationspunkt in WGS84/EPSG:4326; keine OSM-Straßenzuordnung, Fahrstreifengeometrie oder belegte Lagegenauigkeit.',
      'Jahres-DTV 2023 aus Dauerzählungen; Q, Ri. 1 und Ri. 2 sind getrennte Originalwerte und dürfen nicht zusammenaddiert werden.',
      days === null ? 'Anzahl vollständig gezählter Tage unbekannt.' : `Vollständig gezählte Tage 2023: ${days} von 365.`,
      ...(fields.Anmerkungen ? [`Amtliche Anmerkungen: ${fields.Anmerkungen}`] : []),
    ];
    let available = 0;
    for (const [suffix, direction] of [['Q', 'Querschnitt – beide Fahrtrichtungen'], ['Ri1', 1], ['Ri2', 2]]) {
      const value = count(fields[`DTV_Kfz_MobisSo_${suffix}`]);
      if (value === null) continue;
      available += 1;
      const directionText = typeof direction === 'string' ? direction : [
        `Ri. ${direction}`,
        ...(fields[`Hi_Ri${direction}`] ? [`Himmelsrichtung: ${fields[`Hi_Ri${direction}`]}`] : []),
        ...(fields[`Fernziel_Ri${direction}`] ? [`Fernziel: ${fields[`Fernziel_Ri${direction}`]}`] : []),
        ...(fields[`Nahziel_Ri${direction}`] ? [`Nahziel: ${fields[`Nahziel_Ri${direction}`]}`] : []),
      ].join('; ');
      observations.push({observationId: `bast-dz${id}-2023-${suffix}`, measurementType: 'count', mode: 'motor_vehicle',
        year: 2023, period: 'Jahres-DTV 2023, alle Tage (Mo–So)', value, unit: 'Kfz/24 h', geometry,
        direction: directionText, qualityNotes: [...qualityNotes]});
    }
    if (!available) stationsWithoutCount += 1;
  }
  return {stationCount: ids.size, stationsWithoutCount, observations};
}

function createDescriptor(retrievedAt) {
  if (typeof retrievedAt !== 'string' || !retrievedAt.includes('T')) fail('invalid_date', 'retrievedAt requires an actual ISO timestamp');
  return traffic.normalizeDescriptor({id: SOURCE_ID,
    publisher: 'Bundesanstalt für Straßen- und Verkehrswesen (BASt)',
    datasetTitle: 'Automatische Zählstellen auf Autobahnen und Bundesstraßen – Jahres-DTV 2023',
    datasetUrl: DATASET_URL, distributionUrl: DISTRIBUTION_URL,
    licenseId: 'CC-BY-4.0', licenseName: 'Creative Commons Attribution 4.0 International',
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    requiredAttribution: 'Bundesanstalt für Straßen- und Verkehrswesen (BASt)',
    temporalCoverage: '2023-01-01/2023-12-31', spatialCoverage: 'Deutschland – Autobahnen und außerörtliche Bundesstraßen',
    retrievedAt, contentHash: REVIEWED_DISTRIBUTION_SHA256, changedOrDerived: true,
    changeNotice: 'Amtliche ISO-8859-15-CSV nach typisierten Stationsbeobachtungen normalisiert; WGS84 und originale Jahres-DTV je Querschnitt/Richtung erhalten. Leere Werte ausgelassen, keine OSM-Zuordnung oder Summierung.',
    permissions: {permitsRedistribution: true, permitsDerivatives: true, commercialUseAllowed: true},
    qualityNotes: ['Stationspunkte ohne belegte Lagegenauigkeit oder Straßenmatching; vollständige gezählte Tage und amtliche Anmerkungen je Beobachtung beachten.'],
    measurementType: 'count', modes: ['motor_vehicle'], unit: 'Kfz/24 h', priority: 1});
}

function createBastAnnualDtvProvider(options) {
  const opts = options || {};
  if (opts.expectedDistributionSha256 !== REVIEWED_DISTRIBUTION_SHA256 || opts.expectedBytes !== REVIEWED_DISTRIBUTION_BYTES)
    fail('unreviewed_distribution', 'Explicit reviewed original hash and byte size required');
  if (opts.distributionUrl !== undefined && opts.distributionUrl !== DISTRIBUTION_URL)
    fail('unreviewed_distribution', 'Different distribution URL');
  if (typeof opts.allowedRoot !== 'string' || typeof opts.csvPath !== 'string' || !opts.csvPath || path.isAbsolute(opts.csvPath))
    fail('unsafe_path', 'A confined relative CSV path is required');
  const root = fs.realpathSync(opts.allowedRoot);
  const file = path.resolve(root, opts.csvPath);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) fail('unsafe_path', 'CSV escapes root');
  let cursor = root;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('unsafe_symlink', 'CSV path contains symlink');
  }
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 2000000) fail('invalid_distribution', 'Not a bounded regular file');
  const bytes = fs.readFileSync(file);
  if (sha256(bytes) !== REVIEWED_DISTRIBUTION_SHA256) fail('distribution_hash_mismatch', 'Original CSV bytes changed');
  if (bytes.length !== REVIEWED_DISTRIBUTION_BYTES) fail('distribution_size_mismatch', 'Original CSV size changed');
  const loaded = parseAnnualCsv(bytes);
  const provider = traffic.createProvider({descriptor: createDescriptor(opts.retrievedAt),
    canProvide: context => context.country === 'DE', loadObservations: async () => loaded.observations});
  return Object.freeze({...provider, coverage: Object.freeze({stationCount: loaded.stationCount,
    stationsWithoutCount: loaded.stationsWithoutCount, observationCount: loaded.observations.length})});
}

module.exports = Object.freeze({SOURCE_ID, DISTRIBUTION_URL, DATASET_URL, REVIEWED_DISTRIBUTION_SHA256,
  REVIEWED_DISTRIBUTION_BYTES, BastAnnualDtvError, parseAnnualCsv, createDescriptor, createBastAnnualDtvProvider});
