'use strict';

/**
 * Normalisierungsservice für politische Vorgänge.
 *
 * Nimmt rohe Provider-Ergebnisse entgegen und überführt sie in das
 * einheitliche interne PoliticalReference-Datenmodell.
 * Export- und KI-Logik konsumieren ausschließlich dieses normalisierte Format.
 *
 * @module server/political-context/services/portalNormalizationService
 */

const crypto = require('crypto');
const { normalizeSourceContext, httpsUrl } = require('./politicalSourceContext');
const facts = require('../../../js/ua.ris-partitions');

/** Erlaubte Vorgangstypen aus dem Schema */
const VALID_TYPES = ['Antrag', 'Anfrage', 'Änderungsantrag', 'Beschluss', 'Verwaltungsantwort', 'Protokoll', 'Sonstige'];

/**
 * Leitet aus Titel und rawType den normalisierten Vorgangstyp ab.
 *
 * @param {string} title
 * @param {string} rawType
 * @returns {string}
 */
function inferType(title, rawType) {
  const s = ((title || '') + ' ' + (rawType || '')).toLowerCase();
  if (s.includes('änderungsantrag')) return 'Änderungsantrag';
  if (s.includes('antrag')) return 'Antrag';
  if (s.includes('anfrage')) return 'Anfrage';
  if (s.includes('beschluss') || s.includes('beschlüsse')) return 'Beschluss';
  if (s.includes('antwort') || s.includes('stellungnahme') || s.includes('bericht')) return 'Verwaltungsantwort';
  if (s.includes('protokoll') || s.includes('niederschrift')) return 'Protokoll';
  return 'Sonstige';
}

/**
 * Erstellt eine stabile ID aus der URL (sha256-Präfix).
 *
 * @param {string} url
 * @returns {string}
 */
function makeId(url) {
  return crypto.createHash('sha256').update(url || '').digest('hex').substring(0, 16);
}

/** Erlaubte Werte für `referenceType` (siehe schemas/politicalReference.schema.json) */
const VALID_REFERENCE_TYPES = ['Antrag', 'Anfrage', 'Beschluss', 'Verwaltungsantwort', 'Protokollnotiz', 'verwandtes Thema'];

/** Erlaubte Werte für `locationMatch` */
const VALID_LOCATION_MATCH = ['street', 'district', 'bbox', 'topic-only'];

/**
 * Reicht ein vom Provider geliefertes Feld als String-Array unverändert
 * durch (defensive Defaults: nicht-Arrays werden zu []).
 *
 * @param {*} value
 * @returns {string[]}
 */
function coerceStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim());
}

/**
 * Normalisiert ein rohes Provider-Ergebnis zu einem PoliticalReference-Objekt.
 *
 * @param {object} raw        – rohes Ergebnis vom Provider
 * @param {string} sourceKey  – Provider-Kürzel (z. B. 'hannover-sim')
 * @returns {object}          – normalisiertes PoliticalReference-Objekt
 */
function identityKey(raw, url) {
  // Several public agenda items share a genuine notice URL. Their adapter IDs
  // distinguish source rows without inventing navigable fragment targets.
  return raw.source === 'region-hannover-bekanntmachungen' && /^[a-f0-9]{16}$/.test(raw.id || '')
    ? `${url}\n${raw.id}` : url;
}

function normalizeOne(raw, sourceKey) {
  const title  = (raw.title  || '').trim();
  const url    = (raw.url    || '').trim();
  const rawType = (raw.rawType || '');

  const type = VALID_TYPES.includes(raw.type)
    ? raw.type
    : inferType(title, rawType);

  // ── Reicheres Referenzmodell (Folge-PR A) ────────────────────────────────
  // Werte vom Provider werden NICHT erneut gemappt – nur defensive Defaults
  // und Typvalidierung gegen das Schema.
  const referenceType = VALID_REFERENCE_TYPES.includes(raw.referenceType)
    ? raw.referenceType
    : null;
  const locationMatch = VALID_LOCATION_MATCH.includes(raw.locationMatch)
    ? raw.locationMatch
    : null;
  const reason = (typeof raw.reason === 'string' && raw.reason.trim())
    ? raw.reason.trim().substring(0, 240)
    : null;
  const topicMatch  = Array.isArray(raw.topicMatch)  ? coerceStringArray(raw.topicMatch)  : null;
  const streetHints = coerceStringArray(raw.streetHints);
  const areaHints   = coerceStringArray(raw.areaHints);
  const history = {};
  for (const [field, count] of Object.entries(facts.HISTORY_FIELDS)) {
    const candidate = { ...(raw[field] === undefined ? {} : { [field]: raw[field] }),
      ...(raw[count] === undefined ? {} : { [count]: raw[count] }) };
    // Counts remain source supplied; unknown target IDs and absent lists stay
    // unknown. Directory counts do not cause an inline-history expansion.
    if (facts.validRecordFacts(candidate, undefined, { directory: raw[field] === undefined }))
      Object.assign(history, JSON.parse(JSON.stringify(candidate)));
  }
  const sourceContext = normalizeSourceContext(raw.sourceContext);
  const originalPdfUrl = httpsUrl(raw.originalPdfUrl, true);

  return {
    id:             makeId(identityKey(raw, url)),
    title:          title || '(kein Titel)',
    type,
    date:           raw.date   ? String(raw.date).trim()   : null,
    gremium:        raw.gremium ? String(raw.gremium).trim() : null,
    number:         raw.number  ? String(raw.number).trim()  : null,
    snippet:        raw.snippet ? String(raw.snippet).substring(0, 400) : null,
    url,
    source:         typeof raw.source === 'string' && /^[a-z0-9][a-z0-9_.-]{0,119}$/.test(raw.source) ? raw.source : sourceKey || 'unknown',
    ...history,
    ...(sourceContext ? { sourceContext } : {}),
    ...(originalPdfUrl ? { originalPdfUrl } : {}),
    relevanceScore: null,   // wird vom portalRelevanceService befüllt
    referenceType,
    reason,
    locationMatch,
    topicMatch,
    streetHints,
    areaHints
  };
}

/**
 * Normalisiert eine Liste von rohen Provider-Ergebnissen.
 * Entfernt Einträge ohne URL und dedupliziert nach offizieller Quellenidentität.
 *
 * @param {object[]} rawResults
 * @param {string}   sourceKey
 * @returns {object[]}
 */
function normalizeAll(rawResults, sourceKey) {
  if (!Array.isArray(rawResults)) return [];

  const seen = new Set();
  const normalized = [];

  for (const raw of rawResults) {
    if (!raw || !raw.url) continue;
    const url = String(raw.url).trim();
    const key = identityKey(raw, url);
    if (!url || seen.has(key)) continue;
    seen.add(key);
    normalized.push(normalizeOne(raw, sourceKey));
  }

  return normalized;
}

module.exports = { normalizeAll, normalizeOne, makeId, inferType };
