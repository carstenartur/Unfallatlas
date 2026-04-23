'use strict';

/**
 * Zentrale serverseitige Orchestrierung der politischen Kontextrecherche.
 *
 * Ablauf:
 *  1. Ermittelt den passenden Provider aus der Registry.
 *  2. Führt die Suche pro Suchbegriff durch.
 *  3. Normalisiert alle Treffer ins einheitliche Referenzmodell.
 *  4. Dedupliziert (nach URL).
 *  5. Bewertet Relevanz und sortiert absteigend.
 *  6. Gibt ein PoliticalReferenceSearchResult-Objekt zurück.
 *
 * @module server/political-context/services/portalSearchService
 */

const { getProviderForCity } = require('../registry/cityPortalRegistry.js');
const { normalizeAll }       = require('./portalNormalizationService.js');
const { scoreAndSort }       = require('./portalRelevanceService.js');

/**
 * @typedef {object} SearchParams
 * @property {string}    city          – Stadtname (z. B. 'Hannover')
 * @property {string[]}  searchTerms   – Suchbegriffe (Straße, Kreuzung, Bezirk …)
 * @property {object}    [context]     – optionaler Kontext für Relevanzscoring
 * @property {string}    [context.gremium]   – bevorzugtes Gremium
 * @property {string}    [context.location]  – Ortshinweis
 * @property {number}    [maxResults=10]     – maximale Trefferzahl
 */

/**
 * Führt eine vollständige Recherche durch.
 *
 * @param {SearchParams} params
 * @returns {Promise<object>}  PoliticalReferenceSearchResult
 */
async function search(params) {
  const {
    city          = '',
    searchTerms   = [],
    context       = {},
    maxResults    = 10
  } = params || {};

  const searchedAt = new Date().toISOString();

  const provider = getProviderForCity(city);

  if (!provider) {
    return {
      references: [],
      meta: {
        city,
        searchTerms,
        searchedAt,
        totalFound: 0,
        providerKey: null,
        supported: false
      }
    };
  }

  // Provider-Kürzel aus dem Modulpfad ableiten (nur für Logging)
  const providerKey = typeof provider._key === 'string'
    ? provider._key
    : 'hannover-sim';

  // Rohsuche
  const rawResults = await provider.search({ city, searchTerms, context });

  // Normalisierung + Deduplizierung
  const normalized = normalizeAll(rawResults, providerKey);

  // Relevanzbewertung + Sortierung
  const scored = scoreAndSort(normalized, searchTerms, context);

  // Auf maxResults begrenzen
  const trimmed = scored.slice(0, Math.max(1, maxResults));

  return {
    references: trimmed,
    meta: {
      city,
      searchTerms,
      searchedAt,
      totalFound: normalized.length,
      providerKey,
      supported: true
    }
  };
}

module.exports = { search };
