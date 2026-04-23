'use strict';

/**
 * Deterministische Vorselektion plausibler Maßnahmen aus dem
 * `measureCatalog` anhand der berechneten Merkmal-Tags.
 *
 * Damit erhält die KI nicht den vollen Katalog, sondern eine bereits gefilterte
 * und priorisierte Vorauswahl.  Die KI darf daraus auswählen, sortieren und
 * begründen – aber im Regelfall keine völlig fremden Maßnahmen erfinden.
 *
 * Scoring-Logik:
 *   +2 für jeden Treffer in tags ∩ measure.targetAccidentTypes
 *   +1 für jeden Hint, der textuell zur Maßnahme passt (z. B. „Belag“ → surface)
 *   -1 für category=monitoring, wenn keine andere Monitoring-Maßnahme nötig
 *   monitoring-Maßnahme wird IMMER mit aufgenommen (Wirkungskontrolle)
 *
 * @module server/ai/scoring/preselectMeasures
 */

const { MEASURE_CATALOG } = require('../catalog/measureCatalog.js');
const { getCatalogForCity } = require('../catalog/cityMeasureCatalog.js');

const DEFAULT_MAX = 8;

/**
 * @param {string[]} tags                   – aus deriveFeatures().tags
 * @param {object}   [opts]
 * @param {number}   [opts.max]             – maximale Anzahl Maßnahmen
 * @param {string}   [opts.citySlug]        – z. B. "hannover"; lädt
 *                                            stadt-spezifische Erweiterungen
 *                                            (`templates/measures_<slug>.json`)
 * @param {Array<object>} [opts.catalog]    – Override für Tests
 * @returns {Array<CatalogMeasure & { score: number }>}
 */
function preselectMeasures(tags, opts) {
  const max = (opts && Number.isFinite(opts.max) && opts.max > 0) ? opts.max : DEFAULT_MAX;
  const tagSet = new Set(Array.isArray(tags) ? tags : []);

  const catalog = (opts && Array.isArray(opts.catalog))
    ? opts.catalog
    : (opts && opts.citySlug)
      ? getCatalogForCity(opts.citySlug)
      : MEASURE_CATALOG;

  const scored = catalog.map(m => {
    let score = 0;
    for (const t of m.targetAccidentTypes) {
      if (tagSet.has(t)) score += 2;
    }
    return { ...m, score };
  });

  // Always include monitoring at the end
  const monitoring = scored.filter(m => m.category === 'monitoring');
  const nonMonitoring = scored
    .filter(m => m.category !== 'monitoring' && m.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // Tie-break by category preference: quickWin > infrastructure > organizational
      const order = ['quickWin', 'infrastructure', 'organizational'];
      return order.indexOf(a.category) - order.indexOf(b.category);
    });

  let result = nonMonitoring.slice(0, max - monitoring.length);

  // Fallback: if no tags matched, return a small generic set so the LLM still has
  // something to work with rather than hallucinating from scratch.
  if (result.length === 0) {
    result = catalog
      .filter(m => m.category === 'organizational' || m.id === 'qw_sight_clearance')
      .map(m => ({ ...m, score: 0 }));
  }

  // Append monitoring entries
  for (const m of monitoring) result.push(m);

  return result.slice(0, max);
}

module.exports = { preselectMeasures };

/**
 * @typedef {import('../catalog/measureCatalog').CatalogMeasure} CatalogMeasure
 */
