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

/**
 * Normalisiert ein rohes Provider-Ergebnis zu einem PoliticalReference-Objekt.
 *
 * @param {object} raw        – rohes Ergebnis vom Provider
 * @param {string} sourceKey  – Provider-Kürzel (z. B. 'hannover-sim')
 * @returns {object}          – normalisiertes PoliticalReference-Objekt
 */
function normalizeOne(raw, sourceKey) {
  const title  = (raw.title  || '').trim();
  const url    = (raw.url    || '').trim();
  const rawType = (raw.rawType || '');

  const type = VALID_TYPES.includes(raw.type)
    ? raw.type
    : inferType(title, rawType);

  return {
    id:             makeId(url),
    title:          title || '(kein Titel)',
    type,
    date:           raw.date   ? String(raw.date).trim()   : null,
    gremium:        raw.gremium ? String(raw.gremium).trim() : null,
    number:         raw.number  ? String(raw.number).trim()  : null,
    snippet:        raw.snippet ? String(raw.snippet).substring(0, 400) : null,
    url,
    source:         sourceKey || 'unknown',
    relevanceScore: null   // wird vom portalRelevanceService befüllt
  };
}

/**
 * Normalisiert eine Liste von rohen Provider-Ergebnissen.
 * Entfernt Einträge ohne URL und dedupliziert nach URL.
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
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(normalizeOne(raw, sourceKey));
  }

  return normalized;
}

module.exports = { normalizeAll, normalizeOne, makeId, inferType };
