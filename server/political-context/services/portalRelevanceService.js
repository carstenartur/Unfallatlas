'use strict';

/**
 * Relevanzbewertung für normalisierte politische Vorgänge.
 *
 * Bewertet jeden Treffer anhand der Suchbegriffe und optionaler
 * Kontextinformationen (Straßenname, Gremium, Stadtbezirk).
 * Der Score liegt zwischen 0 und 100.
 *
 * Scoring-Faktoren:
 *   - Titelübereinstimmung mit Suchbegriffen      (bis 50 Punkte)
 *   - Snippet-Übereinstimmung                     (bis 20 Punkte)
 *   - Vorgangstyp-Relevanz (Anträge > Protokolle) (bis 15 Punkte)
 *   - Gremium-Übereinstimmung                     (bis 10 Punkte)
 *   - Aktualität (neuere Vorgänge bevorzugt)       (bis  5 Punkte)
 *
 * @module server/political-context/services/portalRelevanceService
 */

/** Typ-Basisscores */
const TYPE_SCORES = {
  'Antrag':              15,
  'Änderungsantrag':     14,
  'Anfrage':             13,
  'Beschluss':           12,
  'Verwaltungsantwort':  10,
  'Protokoll':            6,
  'Sonstige':             3
};

/**
 * Zählt, wie viele der Suchbegriffe im Text vorkommen (case-insensitive).
 *
 * @param {string}   text
 * @param {string[]} terms
 * @returns {number}  Anzahl gefundener Begriffe
 */
function countMatches(text, terms) {
  if (!text || !terms || !terms.length) return 0;
  const lower = text.toLowerCase();
  return terms.filter(t => t && lower.includes(t.toLowerCase())).length;
}

/**
 * Berechnet einen Score basierend auf Aktualität.
 * Vorgänge der letzten 3 Jahre erhalten die vollen 5 Punkte.
 *
 * @param {string|null} dateStr
 * @returns {number}
 */
function recencyScore(dateStr) {
  if (!dateStr) return 0;
  const now = new Date();
  let d = null;

  // Deutsches Format: DD.MM.YYYY
  const deMatch = dateStr.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (deMatch) {
    d = new Date(`${deMatch[3]}-${deMatch[2]}-${deMatch[1]}`);
  } else {
    d = new Date(dateStr);
  }

  if (isNaN(d.getTime())) return 0;

  const ageYears = (now - d) / (1000 * 60 * 60 * 24 * 365.25);
  if (ageYears <= 1) return 5;
  if (ageYears <= 3) return 4;
  if (ageYears <= 5) return 2;
  return 1;
}

/**
 * Bewertet einen einzelnen Treffer.
 *
 * @param {object}   ref          – normalisiertes PoliticalReference-Objekt
 * @param {string[]} searchTerms  – verwendete Suchbegriffe
 * @param {object}   [context]    – optionaler Kontext (gremium, location)
 * @returns {number}  Score 0–100
 */
function scoreOne(ref, searchTerms, context) {
  const terms = Array.isArray(searchTerms) ? searchTerms : [];
  let score = 0;

  // Titelübereinstimmung (max. 50)
  if (terms.length > 0) {
    const titleMatches = countMatches(ref.title || '', terms);
    score += Math.min(50, Math.round((titleMatches / terms.length) * 50));
  }

  // Snippet-Übereinstimmung (max. 20)
  if (ref.snippet && terms.length > 0) {
    const snippetMatches = countMatches(ref.snippet, terms);
    score += Math.min(20, Math.round((snippetMatches / terms.length) * 20));
  }

  // Vorgangstyp (max. 15)
  score += TYPE_SCORES[ref.type] || 0;

  // Gremium-Übereinstimmung (max. 10)
  if (context && context.gremium && ref.gremium) {
    if (ref.gremium.toLowerCase().includes(context.gremium.toLowerCase())) {
      score += 10;
    }
  }

  // Aktualität (max. 5)
  score += recencyScore(ref.date);

  return Math.min(100, Math.max(0, score));
}

/**
 * Bewertet alle Treffer und sortiert sie absteigend nach Score.
 *
 * @param {object[]} refs         – normalisierte Treffer
 * @param {string[]} searchTerms
 * @param {object}   [context]    – optionaler Kontext
 * @returns {object[]}  Treffer mit befülltem relevanceScore, absteigend sortiert
 */
function scoreAndSort(refs, searchTerms, context) {
  if (!Array.isArray(refs)) return [];
  return refs
    .map(ref => ({ ...ref, relevanceScore: scoreOne(ref, searchTerms, context) }))
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0));
}

module.exports = { scoreAndSort, scoreOne, recencyScore, countMatches };
