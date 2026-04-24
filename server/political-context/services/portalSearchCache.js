'use strict';

/**
 * Optionaler in-memory Cache für Treffer der politischen Kontextrecherche.
 *
 * Identische Recherche-Anfragen (gleiche Stadt, gleiche Suchbegriffe, gleicher
 * Kontext, gleiches Limit) liefern aus dem Cache, statt erneut alle Provider
 * (SIM/Allris/Parldok) zu kontaktieren.  Damit reduzieren wir
 *   - Last auf den Stadt-Portalen (Höflichkeit, Stabilität),
 *   - Latenz für die UI bei Wiederholungen.
 *
 * Eigenschaften:
 *   - TTL standardmäßig 10 min (überschreibbar via `POLITICAL_CONTEXT_CACHE_TTL_MS`)
 *   - LRU-Verdrängung (Standard-Größe 100)
 *   - optional persistenter Disk-Speicher via `POLITICAL_CONTEXT_CACHE_PATH`
 *
 * Bewusst getrennt vom AI-Cache: andere Lebensdauer, andere Inhalte, andere
 * Sensibilität.  Die Schnittstelle entspricht der minimalen
 * `KeyValueStore`-Form aus `server/lib/keyValueStore.js` und ist damit einer
 * späteren Persistenz-Implementierung (Redis/SQLite) bereits abstrahiert.
 *
 * @module server/political-context/services/portalSearchCache
 */

const crypto = require('crypto');
const { KeyValueStore } = require('../../lib/keyValueStore.js');

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 min
const DEFAULT_MAX    = 100;

const envTtl = parseInt(process.env.POLITICAL_CONTEXT_CACHE_TTL_MS, 10);
const envMax = parseInt(process.env.POLITICAL_CONTEXT_CACHE_MAX,   10);

const sharedCache = new KeyValueStore({
  name:        'political-context',
  ttlMs:       Number.isFinite(envTtl) && envTtl > 0 ? envTtl : DEFAULT_TTL_MS,
  max:         Number.isFinite(envMax) && envMax > 0 ? envMax : DEFAULT_MAX,
  persistPath: (process.env.POLITICAL_CONTEXT_CACHE_PATH || '').trim() || null
});

/**
 * Erzeugt einen deterministischen Cache-Key für eine Suchanfrage.
 *
 * @param {object}   args
 * @param {string}   args.city
 * @param {string[]} args.searchTerms
 * @param {object}   [args.context]
 * @param {number}   [args.maxResults]
 * @param {boolean}  [args.expandVariants]
 * @returns {string}
 */
function buildKey({ city, searchTerms, context, maxResults, expandVariants }) {
  const canonical = JSON.stringify({
    city: String(city || '').trim().toLowerCase(),
    terms: Array.isArray(searchTerms)
      ? [...searchTerms].map(t => String(t || '').trim().toLowerCase()).sort()
      : [],
    context: canonicalize(context || {}),
    maxResults: Number.isFinite(maxResults) ? maxResults : null,
    expandVariants: expandVariants !== false
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Stable, recursive object→canonical form (sorted keys, drops undefined).
 *
 * @param {unknown} obj
 * @returns {unknown}
 */
function canonicalize(obj) {
  if (obj === null) return null;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj).sort()) {
      const v = obj[k];
      if (v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  return typeof obj === 'string' ? obj.toLowerCase() : obj;
}

module.exports = {
  sharedCache,
  buildKey,
  // exportiert für Tests + spätere Custom-Stores
  KeyValueStore
};
