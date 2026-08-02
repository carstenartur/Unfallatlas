#!/usr/bin/env node
'use strict';

const SCENARIO_SCHEMA = 'unfallwerkbank.document-golden-scenario/v1';

class DocumentGoldenScenarioError extends Error {
  constructor(code, message, details) {
    super(`${code}: ${message}`);
    this.name = 'DocumentGoldenScenarioError';
    this.code = code;
    this.details = details || null;
  }
}

function fail(code, message, details) {
  throw new DocumentGoldenScenarioError(code, message, details);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function exactKeys(value, required, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_object', `${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail('invalid_fields', `${label} must contain exactly the declared fields`, {
      actual,
      expected,
    });
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    fail('invalid_string', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    fail('invalid_integer', `${label} must be a positive integer`, { value });
  }
  return number;
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail('invalid_number', `${label} must be finite`, { value });
  }
  return number;
}

function normalizeScenario(value) {
  exactKeys(value, [
    'schemaVersion',
    'id',
    'city',
    'areaName',
    'description',
    'bounds',
    'center',
    'zoom',
    'accidentCount',
    'involvement',
    'context',
    'narrativeParagraphs',
    'clusterCount',
    'exportOptions',
    'expectations',
  ], 'scenario');
  if (value.schemaVersion !== SCENARIO_SCHEMA) {
    fail('unsupported_schema', `Expected ${SCENARIO_SCHEMA}`, {
      value: value.schemaVersion,
    });
  }
  const id = nonEmptyString(value.id, 'scenario.id');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    fail('invalid_id', 'scenario.id must be a lower-case kebab-case identifier', { id });
  }

  exactKeys(value.bounds, ['south', 'west', 'north', 'east'], 'scenario.bounds');
  const bounds = {
    south: finiteNumber(value.bounds.south, 'scenario.bounds.south'),
    west: finiteNumber(value.bounds.west, 'scenario.bounds.west'),
    north: finiteNumber(value.bounds.north, 'scenario.bounds.north'),
    east: finiteNumber(value.bounds.east, 'scenario.bounds.east'),
  };
  if (bounds.south >= bounds.north || bounds.west >= bounds.east) {
    fail('invalid_bounds', 'scenario bounds must be ordered', { bounds });
  }

  exactKeys(value.center, ['lat', 'lon'], 'scenario.center');
  const center = {
    lat: finiteNumber(value.center.lat, 'scenario.center.lat'),
    lon: finiteNumber(value.center.lon, 'scenario.center.lon'),
  };
  if (
    center.lat < bounds.south || center.lat > bounds.north ||
    center.lon < bounds.west || center.lon > bounds.east
  ) {
    fail('center_outside_bounds', 'scenario center must lie inside its bounds', {
      center,
      bounds,
    });
  }

  exactKeys(value.involvement, [
    'cyclist',
    'pedestrian',
    'car',
    'motorcycle',
    'heavyGoods',
    'other',
  ], 'scenario.involvement');
  const involvement = {};
  for (const [key, enabled] of Object.entries(value.involvement)) {
    if (typeof enabled !== 'boolean') {
      fail('invalid_boolean', `scenario.involvement.${key} must be boolean`);
    }
    involvement[key] = enabled;
  }
  if (!Object.values(involvement).some(Boolean)) {
    fail('empty_involvement', 'at least one involvement mode must be enabled');
  }

  exactKeys(value.context, ['status', 'summary'], 'scenario.context');
  const contextStatus = nonEmptyString(value.context.status, 'scenario.context.status');
  if (!['available', 'uncertain', 'missing'].includes(contextStatus)) {
    fail('invalid_context_status', 'context status must be available, uncertain or missing');
  }

  if (!Array.isArray(value.narrativeParagraphs)) {
    fail('invalid_array', 'scenario.narrativeParagraphs must be an array');
  }
  const narrativeParagraphs = value.narrativeParagraphs.map((paragraph, index) =>
    nonEmptyString(paragraph, `scenario.narrativeParagraphs[${index}]`));

  exactKeys(value.exportOptions, [
    'includeMap',
    'includePOIs',
    'includeReferences',
  ], 'scenario.exportOptions');
  const exportOptions = {};
  for (const [key, enabled] of Object.entries(value.exportOptions)) {
    if (typeof enabled !== 'boolean') {
      fail('invalid_boolean', `scenario.exportOptions.${key} must be boolean`);
    }
    exportOptions[key] = enabled;
  }

  exactKeys(value.expectations, [
    'minimumDocxBytes',
    'minimumRenderedPages',
    'requiredMapKinds',
    'requiredTables',
    'manualWordEvidenceRequired',
  ], 'scenario.expectations');
  if (!Array.isArray(value.expectations.requiredMapKinds) ||
      !Array.isArray(value.expectations.requiredTables)) {
    fail('invalid_array', 'scenario expected maps and tables must be arrays');
  }
  if (typeof value.expectations.manualWordEvidenceRequired !== 'boolean') {
    fail('invalid_boolean', 'manualWordEvidenceRequired must be boolean');
  }

  return deepFreeze({
    schemaVersion: SCENARIO_SCHEMA,
    id,
    city: nonEmptyString(value.city, 'scenario.city'),
    areaName: nonEmptyString(value.areaName, 'scenario.areaName'),
    description: nonEmptyString(value.description, 'scenario.description'),
    bounds,
    center,
    zoom: positiveInteger(value.zoom, 'scenario.zoom'),
    accidentCount: positiveInteger(value.accidentCount, 'scenario.accidentCount'),
    involvement,
    context: {
      status: contextStatus,
      summary: nonEmptyString(value.context.summary, 'scenario.context.summary'),
    },
    narrativeParagraphs,
    clusterCount: positiveInteger(value.clusterCount, 'scenario.clusterCount'),
    exportOptions,
    expectations: {
      minimumDocxBytes: positiveInteger(
        value.expectations.minimumDocxBytes,
        'scenario.expectations.minimumDocxBytes',
      ),
      minimumRenderedPages: positiveInteger(
        value.expectations.minimumRenderedPages,
        'scenario.expectations.minimumRenderedPages',
      ),
      requiredMapKinds: [...new Set(value.expectations.requiredMapKinds.map((item, index) =>
        nonEmptyString(item, `scenario.expectations.requiredMapKinds[${index}]`)))].sort(),
      requiredTables: [...new Set(value.expectations.requiredTables.map((item, index) =>
        nonEmptyString(item, `scenario.expectations.requiredTables[${index}]`)))].sort(),
      manualWordEvidenceRequired: value.expectations.manualWordEvidenceRequired,
    },
  });
}

const COMMON_MAPS = ['overview', 'selection', 'detail', 'cluster'];
const COMMON_TABLES = ['severity', 'year-trend'];

const RAW_SCENARIOS = [
  {
    schemaVersion: SCENARIO_SCHEMA,
    id: 'bonn-urban-junction',
    city: 'Bonn',
    areaName: 'Innerstädtischer Knoten Bonn-Zentrum',
    description: 'Referenzfall mit Rad- und Pkw-Beteiligung sowie vollständigem Kontext.',
    bounds: { south: 50.728, west: 7.087, north: 50.739, east: 7.105 },
    center: { lat: 50.7335, lon: 7.096 },
    zoom: 15,
    accidentCount: 24,
    involvement: {
      cyclist: true,
      pedestrian: false,
      car: true,
      motorcycle: false,
      heavyGoods: false,
      other: false,
    },
    context: {
      status: 'available',
      summary: 'Kommunaler Kontext und Unfallatlas-Quelle sind verfügbar.',
    },
    narrativeParagraphs: [],
    clusterCount: 11,
    exportOptions: { includeMap: true, includePOIs: false, includeReferences: true },
    expectations: {
      minimumDocxBytes: 1024,
      minimumRenderedPages: 5,
      requiredMapKinds: COMMON_MAPS,
      requiredTables: COMMON_TABLES,
      manualWordEvidenceRequired: true,
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA,
    id: 'hannover-arterial',
    city: 'Hannover',
    areaName: 'Hauptverkehrsstraße Hannover-Mitte',
    description: 'Zweiter Stadtraum mit mehr Fällen und zusätzlicher Motorrad-Beteiligung.',
    bounds: { south: 52.365, west: 9.72, north: 52.382, east: 9.755 },
    center: { lat: 52.3735, lon: 9.7375 },
    zoom: 14,
    accidentCount: 36,
    involvement: {
      cyclist: true,
      pedestrian: false,
      car: true,
      motorcycle: true,
      heavyGoods: false,
      other: false,
    },
    context: {
      status: 'available',
      summary: 'Städtischer Kontext und mehrere Verkehrsbeteiligungen sind vorhanden.',
    },
    narrativeParagraphs: [
      'Die Hauptverkehrsstraße wird als eigener Stadtraum geprüft, damit Ortsnamen, Koordinaten und Filter nicht unbemerkt auf Bonn fest verdrahtet bleiben.',
    ],
    clusterCount: 16,
    exportOptions: { includeMap: true, includePOIs: true, includeReferences: true },
    expectations: {
      minimumDocxBytes: 1024,
      minimumRenderedPages: 5,
      requiredMapKinds: COMMON_MAPS,
      requiredTables: COMMON_TABLES,
      manualWordEvidenceRequired: true,
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA,
    id: 'long-multi-section-report',
    city: 'Bonn',
    areaName: 'Ausgedehnter Untersuchungsraum Bonn',
    description: 'Langer Bericht für Seitenumbrüche, Tabellenfortsetzungen und Kartenbindung.',
    bounds: { south: 50.70, west: 7.04, north: 50.77, east: 7.16 },
    center: { lat: 50.735, lon: 7.10 },
    zoom: 12,
    accidentCount: 64,
    involvement: {
      cyclist: true,
      pedestrian: true,
      car: true,
      motorcycle: true,
      heavyGoods: true,
      other: false,
    },
    context: {
      status: 'available',
      summary: 'Mehrere Kontextquellen sind vorhanden und müssen über viele Abschnitte konsistent bleiben.',
    },
    narrativeParagraphs: Array.from({ length: 32 }, (_, index) =>
      `Prüfabschnitt ${index + 1}: Dieser deterministische Langtext belastet Seitenumbrüche, Überschriftenbindung, Tabellenfortsetzungen und die Zuordnung von Kartenunterschriften, ohne neue Tatsachen zu behaupten.`),
    clusterCount: 24,
    exportOptions: { includeMap: true, includePOIs: true, includeReferences: true },
    expectations: {
      minimumDocxBytes: 1024,
      minimumRenderedPages: 8,
      requiredMapKinds: COMMON_MAPS,
      requiredTables: ['severity', 'year-trend', 'deviations'],
      manualWordEvidenceRequired: true,
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA,
    id: 'few-cases',
    city: 'Hannover',
    areaName: 'Kleiner Auswahlbereich Hannover',
    description: 'Kleinstfall mit nur drei Unfällen und ohne erzwungene statistische Überdeutung.',
    bounds: { south: 52.371, west: 9.731, north: 52.375, east: 9.739 },
    center: { lat: 52.373, lon: 9.735 },
    zoom: 17,
    accidentCount: 3,
    involvement: {
      cyclist: true,
      pedestrian: true,
      car: false,
      motorcycle: false,
      heavyGoods: false,
      other: false,
    },
    context: {
      status: 'available',
      summary: 'Kontext ist vorhanden, die Fallzahl bleibt jedoch ausdrücklich klein.',
    },
    narrativeParagraphs: [
      'Wegen der kleinen Fallzahl werden keine stabilen Häufigkeitsmuster oder Kausalitäten behauptet.',
    ],
    clusterCount: 3,
    exportOptions: { includeMap: true, includePOIs: false, includeReferences: true },
    expectations: {
      minimumDocxBytes: 1024,
      minimumRenderedPages: 4,
      requiredMapKinds: COMMON_MAPS,
      requiredTables: COMMON_TABLES,
      manualWordEvidenceRequired: true,
    },
  },
  {
    schemaVersion: SCENARIO_SCHEMA,
    id: 'uncertain-context',
    city: 'Bonn',
    areaName: 'Auswahlbereich mit unsicherem Kontext',
    description: 'Kontextdaten fehlen teilweise und müssen sichtbar als unsicher behandelt werden.',
    bounds: { south: 50.72, west: 7.08, north: 50.74, east: 7.11 },
    center: { lat: 50.73, lon: 7.095 },
    zoom: 14,
    accidentCount: 12,
    involvement: {
      cyclist: true,
      pedestrian: false,
      car: true,
      motorcycle: false,
      heavyGoods: false,
      other: false,
    },
    context: {
      status: 'uncertain',
      summary: 'Ergänzende Kontextdaten sind nicht vollständig verfügbar; dies ist kein Nullwert und kein Kausalnachweis.',
    },
    narrativeParagraphs: [
      'Nicht verfügbare oder unsichere Kontextwerte werden als Datenlücke ausgewiesen und nicht durch Schätzwerte ersetzt.',
    ],
    clusterCount: 6,
    exportOptions: { includeMap: true, includePOIs: true, includeReferences: true },
    expectations: {
      minimumDocxBytes: 1024,
      minimumRenderedPages: 5,
      requiredMapKinds: COMMON_MAPS,
      requiredTables: COMMON_TABLES,
      manualWordEvidenceRequired: true,
    },
  },
];

const SCENARIOS = deepFreeze(Object.fromEntries(
  RAW_SCENARIOS.map((scenario) => {
    const normalized = normalizeScenario(scenario);
    return [normalized.id, normalized];
  }),
));

function listScenarioIds() {
  return Object.keys(SCENARIOS).sort();
}

function getScenario(id) {
  const key = nonEmptyString(id, 'scenario id');
  const scenario = SCENARIOS[key];
  if (!scenario) {
    fail('unknown_scenario', `Unknown document Golden scenario ${key}`, {
      available: listScenarioIds(),
    });
  }
  return scenario;
}

module.exports = Object.freeze({
  SCENARIO_SCHEMA,
  DocumentGoldenScenarioError,
  deepFreeze,
  normalizeScenario,
  SCENARIOS,
  listScenarioIds,
  getScenario,
});
