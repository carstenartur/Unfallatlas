'use strict';

/**
 * Deterministische Vorselektion plausibler Maßnahmen aus dem
 * `measureCatalog` anhand der berechneten Merkmal-Tags und
 * der erkannten Konfliktmuster.
 *
 * Damit erhält die KI nicht den vollen Katalog, sondern eine bereits gefilterte
 * und priorisierte Vorauswahl.  Die KI darf daraus auswählen, sortieren und
 * begründen – aber im Regelfall keine völlig fremden Maßnahmen erfinden.
 *
 * Zu jedem Kandidaten wird zusätzlich maschinenlesbar mitgegeben:
 *   - matchedRiskFactors          – Tags aus features.tags, die zur Maßnahme passen
 *   - matchedConflictPatterns     – IDs der Muster, die die Maßnahme adressiert
 *   - reasonForPreselection       – kurze deutsche Begründung
 *   - expectedTargetAccidentTypes – targetAccidentTypes der Maßnahme
 *
 * Scoring-Logik (deterministisch):
 *   +2 für jeden Treffer in tags ∩ measure.targetAccidentTypes
 *   +3 für jeden Treffer in conflictPatterns.id ∩ measure.conflictPatterns
 *   +1 für jeden Hint, der textuell zur Maßnahme passt (über Tags abgebildet)
 *   monitoring-Maßnahme wird IMMER mit aufgenommen (Wirkungskontrolle)
 *
 * @module server/ai/scoring/preselectMeasures
 */

const { MEASURE_CATALOG } = require('../catalog/measureCatalog.js');
const { getCatalogForCity } = require('../catalog/cityMeasureCatalog.js');

const DEFAULT_MAX = 8;

/**
 * @param {string[]|object} tagsOrFeatures
 *        Entweder das klassische String-Tag-Array (Backward-Kompat) ODER ein
 *        komplettes `features`-Objekt (`deriveFeatures()`) mit `.tags` und
 *        optional `.conflictPatterns`.
 * @param {object}   [opts]
 * @param {number}   [opts.max]
 * @param {string}   [opts.citySlug]
 * @param {Array<object>} [opts.catalog]
 * @param {Array<object>} [opts.conflictPatterns] – wenn nicht in tagsOrFeatures
 * @returns {Array<EnrichedMeasure>}
 */
function preselectMeasures(tagsOrFeatures, opts) {
  const max = (opts && Number.isFinite(opts.max) && opts.max > 0) ? opts.max : DEFAULT_MAX;

  // Normalize input
  let tags, patterns;
  if (Array.isArray(tagsOrFeatures)) {
    tags = tagsOrFeatures;
    patterns = (opts && Array.isArray(opts.conflictPatterns)) ? opts.conflictPatterns : [];
  } else if (tagsOrFeatures && typeof tagsOrFeatures === 'object') {
    tags = Array.isArray(tagsOrFeatures.tags) ? tagsOrFeatures.tags : [];
    patterns = Array.isArray(tagsOrFeatures.conflictPatterns)
      ? tagsOrFeatures.conflictPatterns
      : (opts && Array.isArray(opts.conflictPatterns) ? opts.conflictPatterns : []);
  } else {
    tags = [];
    patterns = (opts && Array.isArray(opts.conflictPatterns)) ? opts.conflictPatterns : [];
  }

  const tagSet = new Set(tags);
  const patternIds = new Set(patterns.map(p => p && p.id).filter(Boolean));

  const catalog = (opts && Array.isArray(opts.catalog))
    ? opts.catalog
    : (opts && opts.citySlug)
      ? getCatalogForCity(opts.citySlug)
      : MEASURE_CATALOG;

  const scored = catalog.map(m => {
    const matchedRiskFactors = (m.targetAccidentTypes || []).filter(t => tagSet.has(t));
    const matchedConflictPatterns = (m.conflictPatterns || []).filter(p => patternIds.has(p));
    let score = matchedRiskFactors.length * 2 + matchedConflictPatterns.length * 3;
    return {
      ...m,
      score,
      matchedRiskFactors,
      matchedConflictPatterns,
      expectedTargetAccidentTypes: Array.isArray(m.targetAccidentTypes) ? m.targetAccidentTypes : [],
      reasonForPreselection: buildReason({
        m, matchedRiskFactors, matchedConflictPatterns
      })
    };
  });

  // Always include monitoring at the end – aber höchstens *einen* Slot dafür
  // reservieren (sonst könnte `max - monitoring.length` negativ werden und
  // `slice(0, negative)` würde unerwartet viele Einträge liefern, während
  // das abschließende `slice(0, max)` Monitoring komplett abschneidet).
  const monitoringAll = scored.filter(m => m.category === 'monitoring');
  const monitoringSlots = Math.min(1, monitoringAll.length, max);
  const monitoring = monitoringAll.slice(0, monitoringSlots);
  const nonMonitoring = scored
    .filter(m => m.category !== 'monitoring' && m.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break by category preference: quickWin > infrastructure > organizational
      const order = ['quickWin', 'infrastructure', 'organizational'];
      return order.indexOf(a.category) - order.indexOf(b.category);
    });

  const nonMonitoringSlots = Math.max(0, max - monitoringSlots);
  let result = nonMonitoring.slice(0, nonMonitoringSlots);

  // Fallback: if no tags matched, return a small generic set so the LLM still has
  // something to work with rather than hallucinating from scratch.
  if (result.length === 0) {
    result = catalog
      .filter(m => m.category === 'organizational' || m.id === 'qw_sight_clearance')
      .map(m => ({
        ...m,
        score: 0,
        matchedRiskFactors: [],
        matchedConflictPatterns: [],
        expectedTargetAccidentTypes: Array.isArray(m.targetAccidentTypes) ? m.targetAccidentTypes : [],
        reasonForPreselection: 'Generischer Fallback: keine spezifischen Tags/Konfliktmuster passten – generelle Verfahrensschritte.'
      }));
  }

  // Append monitoring entries (also enriched)
  for (const m of monitoring) {
    result.push({
      ...m,
      matchedRiskFactors: m.matchedRiskFactors || [],
      matchedConflictPatterns: m.matchedConflictPatterns || [],
      expectedTargetAccidentTypes: Array.isArray(m.targetAccidentTypes) ? m.targetAccidentTypes : [],
      reasonForPreselection: m.reasonForPreselection
        || 'Monitoring wird grundsätzlich begleitend empfohlen, um Wirkung umgesetzter Maßnahmen zu prüfen.'
    });
  }

  return result.slice(0, max);
}

function buildReason({ m, matchedRiskFactors, matchedConflictPatterns }) {
  if (matchedConflictPatterns.length === 0 && matchedRiskFactors.length === 0) {
    return `Generelle Maßnahme aus Kategorie ${m.category}, keine spezifischen Treffer.`;
  }
  const parts = [];
  if (matchedConflictPatterns.length) {
    parts.push(`adressiert Konfliktmuster: ${matchedConflictPatterns.join(', ')}`);
  }
  if (matchedRiskFactors.length) {
    parts.push(`passt zu Risikofaktoren: ${matchedRiskFactors.join(', ')}`);
  }
  return parts.join('; ');
}

module.exports = { preselectMeasures };

/**
 * @typedef {object} EnrichedMeasure
 * @property {string}   id
 * @property {string}   title
 * @property {string}   category
 * @property {string[]} targetAccidentTypes
 * @property {number}   score
 * @property {string[]} matchedRiskFactors
 * @property {string[]} matchedConflictPatterns
 * @property {string[]} expectedTargetAccidentTypes
 * @property {string}   reasonForPreselection
 */
