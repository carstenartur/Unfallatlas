'use strict';

/**
 * Bundesweiter Städte-/Regionen-Katalog der Unfallwerkbank.
 *
 * Zentrale, maschinenlesbare Registry, die je Stadt/Region transparent
 * macht, welche Support-Stufen verfügbar sind:
 *
 *   - **Level A** (Unfallanalyse)        – `accidentDataSupport`
 *   - **Level B** (Politische Recherche) – `politicalContextSupport`
 *   - **Level C** (Persistenz/Batch)     – `analysisServiceSupport`
 *
 * Jeder Stufenwert ist `'supported'`, `'partially_supported'` oder
 * `'unsupported'` (siehe `supportLevels.js`).  Damit kann Unfallatlas
 * ganz Deutschland strukturiert abbilden, ohne dass jede Stadt sofort
 * alle Features mitbringen muss.
 *
 * Die Registry-Daten liegen ausgelagert in `cityCatalogData.json`,
 * damit sie ohne Code-Änderung gepflegt werden können.  Dieses Modul
 *
 *   - lädt den Katalog,
 *   - validiert jeden Eintrag (Pflichtfelder, erlaubte Status-Werte),
 *   - indexiert nach `id`, normalisiertem Namen und Bundesland,
 *   - bietet Lookup-, Such- und Filter-Funktionen.
 *
 * **Reine Leseoperation, keine Seiteneffekte.**  Der Katalog wird beim
 * ersten Zugriff lazy geladen und danach gecached.  `reload()` erlaubt
 * das gezielte Neuladen in Tests.
 *
 * @module server/cities/cityRegistry
 */

const fs = require('fs');
const path = require('path');
const {
  SUPPORT_LEVELS,
  SUPPORT_STATUS,
  VALID_STATUSES,
  describeSupport,
  hasSupport,
  getStatus
} = require('./supportLevels.js');

/** Pfad zur ausgelagerten Katalog-Datei. */
const CATALOG_PATH = path.join(__dirname, 'cityCatalogData.json');

/**
 * Erlaubte Bundesland-Kürzel (ISO 3166-2:DE ohne Präfix `DE-`).
 * Wird zur Validierung der `state`-Eigenschaft genutzt.
 */
const VALID_STATES = Object.freeze([
  'BW', 'BY', 'BE', 'BB', 'HB', 'HH', 'HE', 'MV',
  'NI', 'NW', 'RP', 'SL', 'SN', 'ST', 'SH', 'TH'
]);

/** Erlaubte Werte für `populationClass` (oder `null`). */
const VALID_POPULATION_CLASSES = Object.freeze([
  'metropolis',  // > 500.000
  'large',       // 100.000 – 500.000
  'medium',      // 20.000 – 100.000
  'small',       // < 20.000
  null
]);

/** Erlaubte Werte für `knownPortalType` (oder `null`). */
const VALID_PORTAL_TYPES = Object.freeze([
  'allris', 'sim', 'parldok', 'sessionnet', 'ris', 'other', null
]);

/**
 * Normalisiert einen Stadtnamen auf einen Registry-Schlüssel
 * (identisch zur UA.normKey-Logik im Frontend, js/ua.core.js:54-62 und
 * zum bestehenden cityPortalRegistry.normalizeCity).
 *
 * Eingaben werden auf 200 Zeichen geclampt, bevor regex-Operationen
 * angewendet werden – damit ist die Laufzeit unabhängig von der
 * Aufrufer-Eingabe streng linear gebounded und kann auch bei
 * pathologischen Strings (sehr viele Sonderzeichen oder `_`) keinen
 * polynomialen ReDoS auslösen.
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeCityName(name) {
  if (!name || typeof name !== 'string') return '';
  // Schutz gegen polynomiale ReDoS: Eingabe hart deckeln, bevor wir
  // überhaupt regex-Replacements anstoßen.
  const safe = name.length > 200 ? name.slice(0, 200) : name;
  let s = safe
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_');
  // Anstelle einer einzelnen Alternation `/^_+|_+$/` zwei einfache,
  // anker-spezifische Replaces – beide sind deterministisch linear.
  if (s.startsWith('_')) s = s.replace(/^_+/, '');
  if (s.endsWith('_'))   s = s.replace(/_+$/, '');
  return s;
}

/**
 * Validiert einen einzelnen Katalog-Eintrag und wirft bei groben
 * Fehlern.  Liefert die normalisierte (eingefrorene) Repräsentation
 * mit defensiven Defaults zurück.
 *
 * @param {object} raw
 * @param {number} index – Position in der Eingabeliste (für Fehlermeldungen)
 * @returns {object}
 */
function validateAndNormalize(raw, index) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`cityCatalog: Eintrag ${index} ist kein Objekt.`);
  }
  const ctx = `cityCatalog[${index}] (${raw.id || raw.displayName || '???'})`;

  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    throw new Error(`${ctx}: Pflichtfeld "id" fehlt.`);
  }
  // id muss bereits in normalisierter Form vorliegen, damit Lookups
  // case-/diakritik-stabil sind.  Wir prüfen das streng, statt im
  // Loader stillschweigend umzubenennen.
  if (!/^[a-z0-9_]+$/.test(raw.id)) {
    throw new Error(`${ctx}: id "${raw.id}" enthält ungültige Zeichen (erlaubt: [a-z0-9_]).`);
  }
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim()) {
    throw new Error(`${ctx}: Pflichtfeld "displayName" fehlt.`);
  }
  if (!VALID_STATES.includes(raw.state)) {
    throw new Error(`${ctx}: state "${raw.state}" ist kein gültiges Bundesland-Kürzel.`);
  }

  const codes = (raw.officialCodes && typeof raw.officialCodes === 'object') ? raw.officialCodes : {};
  const officialCodes = Object.freeze({
    land:              typeof codes.land === 'string' ? codes.land : null,
    regierungsbezirk:  typeof codes.regierungsbezirk === 'string' ? codes.regierungsbezirk : null,
    kreis:             typeof codes.kreis === 'string' ? codes.kreis : null,
    gemeinde:          typeof codes.gemeinde === 'string' ? codes.gemeinde : null
  });

  if (raw.populationClass !== undefined &&
      !VALID_POPULATION_CLASSES.includes(raw.populationClass)) {
    throw new Error(`${ctx}: populationClass "${raw.populationClass}" ist nicht erlaubt.`);
  }

  // Support-Stufen prüfen (Pflichtfelder).
  for (const field of ['accidentDataSupport', 'politicalContextSupport', 'analysisServiceSupport']) {
    if (!VALID_STATUSES.includes(raw[field])) {
      throw new Error(`${ctx}: ${field} "${raw[field]}" ist kein gültiger Support-Status.`);
    }
  }
  // rankingSupport ist optional, defaultet auf analysisServiceSupport
  // (Batch-Rankings setzen Persistenz voraus).
  let rankingSupport = raw.rankingSupport;
  if (rankingSupport === undefined || rankingSupport === null) {
    rankingSupport = raw.analysisServiceSupport;
  }
  if (!VALID_STATUSES.includes(rankingSupport)) {
    throw new Error(`${ctx}: rankingSupport "${rankingSupport}" ist kein gültiger Support-Status.`);
  }

  if (raw.knownPortalType !== undefined &&
      !VALID_PORTAL_TYPES.includes(raw.knownPortalType)) {
    throw new Error(`${ctx}: knownPortalType "${raw.knownPortalType}" ist nicht erlaubt.`);
  }

  // portalBaseUrl: nur http(s) erlauben, wenn überhaupt gesetzt.
  let portalBaseUrl = null;
  if (raw.portalBaseUrl !== undefined && raw.portalBaseUrl !== null) {
    if (typeof raw.portalBaseUrl !== 'string' || !/^https?:\/\//i.test(raw.portalBaseUrl)) {
      throw new Error(`${ctx}: portalBaseUrl muss http(s)-URL oder null sein.`);
    }
    portalBaseUrl = raw.portalBaseUrl;
  }

  const qualityFlags = Array.isArray(raw.qualityFlags)
    ? Object.freeze(raw.qualityFlags.filter(f => typeof f === 'string'))
    : Object.freeze([]);

  return Object.freeze({
    id:                       raw.id,
    displayName:              raw.displayName,
    state:                    raw.state,
    officialCodes,
    populationClass:          raw.populationClass === undefined ? null : raw.populationClass,
    accidentDataSupport:      raw.accidentDataSupport,
    politicalContextSupport:  raw.politicalContextSupport,
    analysisServiceSupport:   raw.analysisServiceSupport,
    rankingSupport,
    knownPortalType:          raw.knownPortalType === undefined ? null : raw.knownPortalType,
    portalBaseUrl,
    qualityFlags
  });
}

/** Laufzeit-Cache. */
let _state = null;

/**
 * Lädt und indexiert den Katalog beim ersten Zugriff.
 *
 * @returns {{cities: object[], byId: Map<string,object>, byState: Map<string,object[]>, byNormName: Map<string,object>, byGemeindeCode: Map<string,object>, schemaVersion: string}}
 */
function _ensureLoaded() {
  if (_state) return _state;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(`cityRegistry: Konnte Katalog ${CATALOG_PATH} nicht lesen: ${err.message}`);
  }
  if (!raw || !Array.isArray(raw.cities)) {
    throw new Error('cityRegistry: Katalog enthält kein "cities"-Array.');
  }

  const cities         = [];
  const byId           = new Map();
  const byState        = new Map();
  const byNormName     = new Map();
  const byGemeindeCode = new Map();

  raw.cities.forEach((entry, i) => {
    const city = validateAndNormalize(entry, i);
    if (byId.has(city.id)) {
      throw new Error(`cityRegistry: doppelte id "${city.id}".`);
    }
    cities.push(city);
    byId.set(city.id, city);

    const normName = normalizeCityName(city.displayName);
    if (normName) byNormName.set(normName, city);
    // id ist bereits normalisiert – auch unter id ablegen, falls
    // displayName nicht 1:1 zur id passt (z. B. „Frankfurt am Main").
    byNormName.set(city.id, city);

    if (city.officialCodes.gemeinde) {
      byGemeindeCode.set(city.officialCodes.gemeinde, city);
    }

    if (!byState.has(city.state)) byState.set(city.state, []);
    byState.get(city.state).push(city);
  });

  // Listen einfrieren, damit Aufrufer sie nicht versehentlich mutieren.
  for (const arr of byState.values()) Object.freeze(arr);

  _state = {
    cities:        Object.freeze(cities),
    byId,
    byState,
    byNormName,
    byGemeindeCode,
    schemaVersion: typeof raw.$schemaVersion === 'string' ? raw.$schemaVersion : '0.0.0'
  };
  return _state;
}

/** Erzwingt Neuladen (für Tests, die den Katalog mocken). */
function reload() {
  _state = null;
  return _ensureLoaded();
}

/**
 * @returns {object[]} Alle Städte/Regionen (eingefroren).
 */
function listCities() {
  return _ensureLoaded().cities;
}

/**
 * @param {string} id
 * @returns {object|null}
 */
function getCityById(id) {
  if (typeof id !== 'string') return null;
  return _ensureLoaded().byId.get(id) || null;
}

/**
 * Lookup über mehrere Schreibweisen: id, normalisierter displayName,
 * amtlicher Gemeindeschlüssel.  Bevorzugt id, fällt dann auf
 * normalisierten Namen, dann auf den Gemeindecode zurück.
 *
 * @param {string} key
 * @returns {object|null}
 */
function findCity(key) {
  if (typeof key !== 'string' || !key.trim()) return null;
  const state = _ensureLoaded();
  const trimmed = key.trim();
  if (state.byId.has(trimmed)) return state.byId.get(trimmed);
  const norm = normalizeCityName(trimmed);
  if (norm && state.byNormName.has(norm)) return state.byNormName.get(norm);
  if (state.byGemeindeCode.has(trimmed)) return state.byGemeindeCode.get(trimmed);
  return null;
}

/**
 * @param {string} state – ISO-Kürzel ohne `DE-`
 * @returns {object[]}
 */
function listCitiesByState(state) {
  return _ensureLoaded().byState.get(state) || [];
}

/**
 * Liefert alle Städte, die für eine bestimmte Support-Stufe (mindestens
 * `partially_supported`) geeignet sind.
 *
 * @param {string} level
 * @returns {object[]}
 */
function listCitiesWithSupport(level) {
  return _ensureLoaded().cities.filter(c => hasSupport(c, level));
}

/**
 * Sehr leichtgewichtige Suche: Substring-Match (case- und
 * diakritik-insensitiv) in `displayName`, `id`, Bundesland-Kürzel und
 * dem Gemeindecode.  Bewusst keine Fuzzy-/Levenshtein-Logik – das
 * Frontend kann die Treffermenge clientseitig sortieren oder filtern.
 *
 * @param {string} query
 * @param {{limit?: number}} [options]
 * @returns {object[]}
 */
function searchCities(query, options = {}) {
  if (typeof query !== 'string') return [];
  const q = normalizeCityName(query);
  if (!q) return [];
  const limit = Math.max(1, Math.min(200, parseInt(options.limit, 10) || 50));
  const out = [];
  for (const city of _ensureLoaded().cities) {
    const haystack = [
      city.id,
      normalizeCityName(city.displayName),
      normalizeCityName(city.state),
      city.officialCodes.gemeinde || '',
      city.officialCodes.kreis || ''
    ].join(' ');
    if (haystack.includes(q)) {
      out.push(city);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Anreicherung eines Stadt-Eintrags um eine kompakte
 * Capability-Übersicht.  Nützlich für API-Antworten.
 *
 * @param {object} city
 * @returns {object|null}
 */
function describeCity(city) {
  if (!city) return null;
  // ranking ist nur dann nutzbar, wenn sowohl Stufe C als auch das
  // explizite rankingSupport-Flag mindestens „partially_supported" sind.
  // Wir benutzen denselben hasSupport-Helper wie für die übrigen
  // Capability-Booleans, damit das Verhalten konsistent bleibt.
  const rankingAvailable =
    hasSupport(city, SUPPORT_LEVELS.C)
    && city.rankingSupport !== SUPPORT_STATUS.UNSUPPORTED;
  return Object.assign({}, city, {
    supportLevels: describeSupport(city),
    capabilities: {
      accidentAnalysis: hasSupport(city, SUPPORT_LEVELS.A),
      politicalContext: hasSupport(city, SUPPORT_LEVELS.B),
      analysisService:  hasSupport(city, SUPPORT_LEVELS.C),
      ranking:          rankingAvailable
    }
  });
}

/**
 * Gesamt-Statistik über alle Support-Stufen.
 *
 * @returns {{total:number, byLevel:object}}
 */
function summarize() {
  const cities = listCities();
  const counts = (level) => {
    const c = { supported: 0, partially_supported: 0, unsupported: 0 };
    for (const city of cities) c[getStatus(city, level)]++;
    return c;
  };
  return {
    total: cities.length,
    byLevel: {
      [SUPPORT_LEVELS.A]: counts(SUPPORT_LEVELS.A),
      [SUPPORT_LEVELS.B]: counts(SUPPORT_LEVELS.B),
      [SUPPORT_LEVELS.C]: counts(SUPPORT_LEVELS.C)
    }
  };
}

module.exports = {
  // Daten
  listCities,
  listCitiesByState,
  listCitiesWithSupport,
  getCityById,
  findCity,
  searchCities,
  describeCity,
  summarize,
  // Helpers / Konstanten
  normalizeCityName,
  VALID_STATES,
  VALID_POPULATION_CLASSES,
  VALID_PORTAL_TYPES,
  // Test-Hooks
  reload,
  CATALOG_PATH
};
