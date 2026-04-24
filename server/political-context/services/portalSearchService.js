'use strict';

/**
 * Zentrale serverseitige Orchestrierung der politischen Kontextrecherche.
 *
 * Ablauf:
 *  1. Ermittelt den passenden Provider aus der Registry.
 *  2. Erzeugt aus den Suchbegriffen + Kontext zusätzliche Suchvarianten
 *     (Variantensuche – verbessert den Recall).
 *  3. Führt die Suche pro (erweitertem) Suchbegriff durch.
 *  4. Normalisiert alle Treffer ins einheitliche Referenzmodell.
 *  5. Dedupliziert (nach URL).
 *  6. Bewertet Relevanz und sortiert absteigend.
 *  7. Reichert jeden Treffer um die *Verkehrsrelevanz-Klassifikation* und
 *     die *KI-Gating-Entscheidung* an (rein additiv, keine Filterung).
 *  8. Gibt ein PoliticalReferenceSearchResult-Objekt zurück.
 *
 * Hinweis: die Suche bleibt bewusst breit; die fachliche Auswahl, welche
 * Treffer an die KI weitergereicht werden dürfen, übernimmt der
 * `aiGatingService` (siehe `shouldAllowForAiEvaluation`).
 *
 * @module server/political-context/services/portalSearchService
 */

const { getProviderForCity }   = require('../registry/cityPortalRegistry.js');
const { normalizeAll }         = require('./portalNormalizationService.js');
const { scoreAndSort }         = require('./portalRelevanceService.js');
const { buildSearchVariants }  = require('./searchVariantBuilder.js');
const { enrichAllWithTrafficRelevance } = require('./trafficRelevanceService.js');
const { enrichAllWithAiGating }         = require('./aiGatingService.js');
const { sharedCache: searchCache, buildKey: buildCacheKey } =
  require('./portalSearchCache.js');

/**
 * @typedef {object} SearchParams
 * @property {string}    city          – Stadtname (z. B. 'Hannover')
 * @property {string[]}  searchTerms   – Suchbegriffe (Straße, Kreuzung, Bezirk …)
 * @property {object}    [context]     – optionaler Kontext für Relevanzscoring
 * @property {string}    [context.gremium]   – bevorzugtes Gremium
 * @property {string}    [context.location]  – Ortshinweis
 * @property {string}    [context.street]    – expliziter Straßenname (optional)
 * @property {string}    [context.district]  – expliziter Stadtteil (optional)
 * @property {number}    [maxResults=10]     – maximale Trefferzahl
 * @property {boolean}   [expandVariants=true] – Variantensuche aktivieren?
 */

/**
 * Führt eine vollständige Recherche durch.
 *
 * @param {SearchParams} params
 * @returns {Promise<object>}  PoliticalReferenceSearchResult
 */
async function search(params) {
  const {
    city            = '',
    searchTerms     = [],
    context         = {},
    maxResults      = 10,
    expandVariants  = true,
    // Cache-Optionen (additiv; bestehende Aufrufer bleiben unverändert)
    useCache        = true,
    cache           = searchCache
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
        supported: false,
        cache: { hit: false, enabled: useCache }
      }
    };
  }

  // Provider-Kürzel: jeder Provider sollte sein _key exportieren.  Falls ein
  // Provider das (versehentlich) nicht tut, fallen wir auf einen neutralen
  // 'unknown'-Wert zurück – niemals auf einen konkreten Stadtnamen, der bei
  // anderen Städten zu falsch gelabelten `source`-Feldern führen würde.
  const providerKey = typeof provider._key === 'string' && provider._key
    ? provider._key
    : 'unknown';

  // ── 1b. Cache-Lookup (vor jeglichem Provider-Call) ─────────────────────
  const cacheKey = (useCache && cache && typeof cache.get === 'function')
    ? buildCacheKey({ city, searchTerms, context, maxResults, expandVariants })
    : null;
  if (cacheKey) {
    const cached = cache.get(cacheKey);
    if (cached) {
      // Frische Zeitstempel + Cache-Indikator, sonst originaler Inhalt
      return {
        references: cached.references,
        meta: {
          ...cached.meta,
          searchedAt,
          cache: { hit: true, enabled: true, key: cacheKey }
        }
      };
    }
  }

  // ── 2. Variantensuche ───────────────────────────────────────────────────
  // Erzeugt zusätzliche Suchbegriffe aus Karten-/Exportkontext.  Der Suche
  // wird die erweiterte Liste übergeben, damit der Recall steigt; in den
  // Meta-Daten geben wir aber weiterhin die Originalbegriffe zurück, damit
  // bestehende Frontend-Erwartungen unverändert bleiben.
  const effectiveTerms = expandVariants
    ? buildSearchVariants(searchTerms, context)
    : searchTerms;

  // ── 3. Rohsuche ─────────────────────────────────────────────────────────
  const rawResults = await provider.search({ city, searchTerms: effectiveTerms, context });

  // ── 4./5. Normalisierung + Deduplizierung (nach URL) ────────────────────
  const normalized = normalizeAll(rawResults, providerKey);

  // ── 6. Relevanzbewertung + Sortierung (gegen die ORIGINAL-Begriffe, damit
  //       die Variantenexpansion den Score nicht verwässert) ──────────────
  const scored = scoreAndSort(normalized, searchTerms, context);

  // ── 7. Verkehrsrelevanz + KI-Gating (additiv) ───────────────────────────
  const withTraffic = enrichAllWithTrafficRelevance(scored);
  const withGating  = enrichAllWithAiGating(withTraffic, context);

  // Auf maxResults begrenzen
  const trimmed = withGating.slice(0, Math.max(0, maxResults));

  const result = {
    references: trimmed,
    meta: {
      city,
      searchTerms,
      searchedAt,
      totalFound: normalized.length,
      providerKey,
      supported: true,
      cache: { hit: false, enabled: Boolean(cacheKey), ...(cacheKey ? { key: cacheKey } : {}) }
    }
  };

  // Cache schreiben (nach erfolgreicher Antwort)
  if (cacheKey) {
    try { cache.set(cacheKey, { references: result.references, meta: { ...result.meta, cache: undefined } }); }
    catch (_) { /* Cache-Fehler dürfen die Antwort nicht stören */ }
  }

  return result;
}

module.exports = { search };

