'use strict';

/**
 * Enriched measure-library view for the Location Action Brief layer.
 *
 * The base measure catalog (`server/ai/catalog/measureCatalog.js`) is the
 * single source of truth for catalog content.  This module wraps each base
 * measure with the field names required by the product brief
 * (without modifying the base catalog), and computes a small set of
 * derived numeric scores (`quickWinScore`) so that the prioritization layer
 * has a consistent vocabulary to work with.
 *
 * Mapping from base catalog → enriched view:
 *   conflictPatterns          → applicableConflictPatterns
 *                                (PLUS the corresponding English aliasIds)
 *   targetAccidentTypes       → typicalTargetAccidentTypes
 *   useCases                  → typicalBenefits
 *   cautions                  → exclusionHints
 *   description               → notes (+ effectDirection appended if present)
 *   measureClass              → category mapping (see CATEGORY_MAP)
 *
 * Newly computed:
 *   quickWinScore       0..1  (1 = clear quick win)
 *   policyReadinessHints  string[] – derived hints about how easily a
 *                                    political body could pick this up
 *
 * Categories required by the brief and how they map to measureClass / id:
 *   marking, signaling, parking_management, loading_management,
 *   surface_improvement, crossing_upgrade, cycle_protection,
 *   junction_redesign, traffic_calming, stop_area_improvement,
 *   tram_crossing_treatment
 *
 * @module server/location-brief/measureLibrary
 */

const { MEASURE_CATALOG } = require('../ai/catalog/measureCatalog.js');
const { getCatalogForCity } = require('../ai/catalog/cityMeasureCatalog.js');
const { toEnglishId } = require('./conflictPatternAliases.js');

/**
 * Heuristic mapping from a base measure to a brief category.
 *
 * Order is significant: the first rule that matches wins.  Rules look at
 * the measure's id, measureClass and targetAccidentTypes to pick a category.
 *
 * @type {Array<{ test: (m: object) => boolean, category: string }>}
 */
const CATEGORY_RULES = [
  { test: (m) => /rail/.test(m.id) || (m.targetAccidentTypes || []).includes('rail'), category: 'tram_crossing_treatment' },
  { test: (m) => /surface/.test(m.id) || (m.targetAccidentTypes || []).includes('surface'),  category: 'surface_improvement' },
  { test: (m) => /parking/.test(m.id), category: 'parking_management' },
  { test: (m) => /truck/.test(m.id) || (m.targetAccidentTypes || []).includes('hgv'), category: 'loading_management' },
  { test: (m) => /bus_stop/.test(m.id) || (m.targetAccidentTypes || []).includes('transit'), category: 'stop_area_improvement' },
  { test: (m) => /protected_bike|protected_corner/.test(m.id), category: 'cycle_protection' },
  { test: (m) => /junction_redesign/.test(m.id), category: 'junction_redesign' },
  { test: (m) => /crossing|school_route|raised/.test(m.id), category: 'crossing_upgrade' },
  { test: (m) => /speed/.test(m.id), category: 'traffic_calming' },
  { test: (m) => m.measureClass === 'signal' || /advance_green|warning/.test(m.id), category: 'signaling' },
  { test: (m) => m.measureClass === 'marking' || /marking/.test(m.id), category: 'marking' }
];

function deriveCategory(m) {
  for (const rule of CATEGORY_RULES) {
    // Defensive: a buggy rule predicate must not break catalog enrichment –
    // skip it and fall back to the next rule. We don't expect this path in
    // practice (all rules are pure predicates over `m`), but the catalog is
    // user-extensible per city, and we'd rather degrade than crash.
    try { if (rule.test(m)) return rule.category; } catch (_) { /* skip rule */ }
  }
  return m.measureClass || m.category || 'other';
}

/**
 * Computes a quickWinScore in [0,1] based on effort/cost/duration and category.
 * High values: low effort, low cost, weeks duration, quick-win category.
 */
function computeQuickWinScore(m) {
  const effortMap = { low: 1.0, medium: 0.5, high: 0.0 };
  const costMap   = { low: 1.0, medium: 0.5, high: 0.0 };
  const durMap    = { weeks: 1.0, months: 0.5, year_plus: 0.0 };
  const e = effortMap[m.implementationEffort] ?? 0.5;
  const c = costMap[m.costBand] ?? 0.5;
  const d = durMap[m.implementationDuration] ?? 0.5;
  let score = (e * 0.4) + (c * 0.3) + (d * 0.3);
  if (m.category === 'quickWin')  score = Math.min(1, score + 0.1);
  if (m.category === 'monitoring') score = Math.max(0, score - 0.1);
  return Math.round(score * 100) / 100;
}

/**
 * Derives short, deterministic policyReadiness hints – a list of plain-German
 * statements explaining how easily a political body / committee could pick
 * this measure up.  These are intentionally generic and should never be
 * confused with KI-generated text.
 *
 * @param {object} m – base measure
 * @returns {string[]}
 */
function derivePolicyReadinessHints(m) {
  const hints = [];
  if (m.implementationEffort === 'low' && m.costBand === 'low') {
    hints.push('Niedriger Aufwand und niedriges Kostenband: in der Regel im Rahmen der laufenden Verwaltung umsetzbar.');
  }
  if (m.category === 'quickWin') {
    hints.push('Quick-Win-Maßnahme: eignet sich für kurzfristige Beschlüsse (Verkehrsschau, Anordnung).');
  }
  if (m.category === 'organizational') {
    hints.push('Organisatorische Maßnahme: kann in der Regel ohne Investitionsbeschluss veranlasst werden.');
  }
  if (m.implementationDuration === 'year_plus' || m.costBand === 'high') {
    hints.push('Mittelfristige Investition: erfordert in der Regel Haushaltsbeschluss / Planungsphase.');
  }
  if ((m.targetAccidentTypes || []).includes('rail')) {
    hints.push('Schienenbezogene Maßnahme: Abstimmung mit Bahn-/ÖPNV-Träger erforderlich.');
  }
  if ((m.targetAccidentTypes || []).includes('hgv')) {
    hints.push('Logistik-/Wirtschaftsverkehr betroffen: Akzeptanzaufbau mit Wirtschaft empfohlen.');
  }
  return hints;
}

/**
 * Wraps a base catalog measure into the enriched library shape used by the
 * Location Action Brief.  The returned object is a new object; the input is
 * not mutated.
 *
 * @param {object} m
 * @returns {EnrichedLibraryMeasure}
 */
function enrich(m) {
  const applicable = Array.isArray(m.conflictPatterns) ? m.conflictPatterns.slice() : [];
  const aliases = applicable.map(toEnglishId).filter(Boolean);

  return Object.freeze({
    id: m.id,
    title: m.title,
    category: deriveCategory(m),
    sourceCategory: m.category,                       // base catalog category (quickWin/infrastructure/…)
    measureClass: m.measureClass,
    applicableConflictPatterns: Object.freeze(applicable.concat(aliases)),
    typicalTargetAccidentTypes: Object.freeze(Array.isArray(m.targetAccidentTypes) ? m.targetAccidentTypes.slice() : []),
    typicalBenefits: Object.freeze(Array.isArray(m.useCases) ? m.useCases.slice() : []),
    exclusionHints: Object.freeze(Array.isArray(m.cautions) ? m.cautions.slice() : []),
    implementationEffort: m.implementationEffort || 'medium',
    costBand:             m.costBand             || 'medium',
    implementationDuration: m.implementationDuration || undefined,
    quickWinScore: computeQuickWinScore(m),
    policyReadinessHints: Object.freeze(derivePolicyReadinessHints(m)),
    notes: [m.description, m.effectDirection ? `Wirkung: ${m.effectDirection}` : '']
      .filter(Boolean).join(' ').trim()
  });
}

/**
 * Returns the enriched measure library for the optionally given city slug.
 *
 * @param {string} [citySlug]
 * @returns {EnrichedLibraryMeasure[]}
 */
function getMeasureLibrary(citySlug) {
  const base = citySlug ? getCatalogForCity(citySlug) : MEASURE_CATALOG;
  return base.map(enrich);
}

/**
 * Lookup of enriched measures by id.  Cached for the default catalog only
 * (city-specific catalogs go through getMeasureLibrary).
 */
const ENRICHED_BY_ID = Object.freeze(
  MEASURE_CATALOG.reduce((acc, m) => {
    acc[m.id] = enrich(m);
    return acc;
  }, {})
);

module.exports = {
  enrich,
  getMeasureLibrary,
  ENRICHED_BY_ID,
  computeQuickWinScore,
  derivePolicyReadinessHints,
  deriveCategory
};

/**
 * @typedef {object} EnrichedLibraryMeasure
 * @property {string}   id
 * @property {string}   title
 * @property {string}   category
 * @property {string}   sourceCategory
 * @property {string}   measureClass
 * @property {string[]} applicableConflictPatterns
 * @property {string[]} typicalTargetAccidentTypes
 * @property {string[]} typicalBenefits
 * @property {string[]} exclusionHints
 * @property {string}   implementationEffort   – low | medium | high
 * @property {string}   costBand               – low | medium | high
 * @property {string|undefined} implementationDuration
 * @property {number}   quickWinScore          – 0..1
 * @property {string[]} policyReadinessHints
 * @property {string}   notes
 */
