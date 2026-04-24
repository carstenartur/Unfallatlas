'use strict';

/**
 * Multi-criteria scoring for the Location Action Brief.
 *
 * For a given derived `features` object (from `deriveFeatures`) and the
 * deterministically preselected measures (from `preselectMeasures` +
 * `enrich`), this module computes:
 *
 *   - `LocationScores`   – per-location aggregate sub-scores in [0,1]
 *   - `MeasureFit`       – per-measure scoring with `fitScore` and
 *                          `quickWinPotential`, plus the `whyPreselected`
 *                          natural-language reason.
 *
 * Sub-scores (per location):
 *   safetyImpactScore                   – wie groß ist die Sicherheitswirkung?
 *   severeAccidentReductionScore        – Fokus auf KSI-Reduktion
 *   bicycleSafetyScore                  – Fokus Radverkehr
 *   quickWinScore                       – Anteil schnell wirksamer Maßnahmen
 *   implementationFeasibilityScore      – wie umsetzbar (Aufwand)?
 *   policyReadinessScore                – politische Anschlussfähigkeit
 *   costEfficiencyScore                 – kleines Kostenband bei hoher Wirkung
 *   dataConfidenceScore                 – wie belastbar ist die Datenbasis?
 *
 * All scores are rounded to two decimals.  The model is intentionally
 * simple, deterministic and explainable: every score has a documented
 * formula here in code, no learned weights.
 *
 * @module server/location-brief/prioritization/scoring
 */

const PROFILES = require('./profiles.js');

const EFFORT_NUM = { low: 1.0, medium: 0.5, high: 0.0 };
const COST_NUM   = { low: 1.0, medium: 0.5, high: 0.0 };

/** Clamp to [0, 1] and round to 2 decimals. */
function s01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.round(Math.max(0, Math.min(1, x)) * 100) / 100;
}

/**
 * Compute the 8 sub-scores for a given location.
 *
 * @param {object} args
 * @param {object} args.features      – output of `deriveFeatures`
 * @param {Array<object>} args.preselected – output of `preselectMeasures`
 * @param {object} [args.policyContext]   – output of `summarizePoliticalContext`
 * @returns {LocationScores}
 */
function computeLocationScores({ features, preselected, policyContext }) {
  const f = features || {};
  const counts = f.counts || {};
  const inv = f.involvement || {};
  const total = Number(counts.total || 0);
  const ksi = (Number(counts.fatal || 0) + Number(counts.serious || 0));
  const ksiShare = Number(f.ksiShare || 0);
  const patterns = Array.isArray(f.conflictPatterns) ? f.conflictPatterns : [];
  const primaryPatterns = patterns.filter(p => p.classification === 'primary');
  const pre = Array.isArray(preselected) ? preselected : [];

  // ── safetyImpactScore ─────────────────────────────────────────────────────
  // Combination of total volume (saturating at 25 accidents) and the share of
  // confidently identified primary conflict patterns.
  const volumeFactor = Math.min(1, total / 25);
  const patternFactor = Math.min(1, primaryPatterns.length / 3);
  const safetyImpactScore = s01(0.6 * volumeFactor + 0.4 * patternFactor);

  // ── severeAccidentReductionScore ─────────────────────────────────────────
  // Driven by KSI count (saturating at 5) and KSI share.
  const ksiVolume = Math.min(1, ksi / 5);
  const severeAccidentReductionScore = s01(0.6 * ksiVolume + 0.4 * Math.min(1, ksiShare / 0.4));

  // ── bicycleSafetyScore ───────────────────────────────────────────────────
  // Bike involvement share, boosted if bike-truck or bike+junction patterns present.
  let bikeBoost = 0;
  if (patterns.some(p => p.id === 'kfz_rad_abbiegekonflikt')) bikeBoost += 0.15;
  if (patterns.some(p => p.id === 'lkw_lieferverkehr_kontext')) bikeBoost += 0.10;
  if (patterns.some(p => p.id === 'rad_alleinunfall_oberflaeche')) bikeBoost += 0.10;
  const bicycleSafetyScore = s01(Math.min(1, Number(inv.bike || 0)) + bikeBoost);

  // ── quickWinScore (location level) ───────────────────────────────────────
  // Average quickWinScore across preselected, weighted by preselection score.
  const qwSum = pre.reduce((acc, m) => acc + (Number(m.libraryQuickWinScore || m.quickWinScore || 0)), 0);
  const quickWinScore = pre.length > 0 ? s01(qwSum / pre.length) : 0;

  // ── implementationFeasibilityScore ───────────────────────────────────────
  // Inverse of average implementation effort across preselected measures.
  const effortAvg = pre.length > 0
    ? pre.reduce((acc, m) => acc + (EFFORT_NUM[m.implementationEffort] ?? 0.5), 0) / pre.length
    : 0.5;
  const implementationFeasibilityScore = s01(effortAvg);

  // ── policyReadinessScore ─────────────────────────────────────────────────
  // From summarized political context (if any) and the share of measures with
  // policyReadinessHints. Conservative default 0.3 when nothing is known.
  const ctxReadiness = readinessToNumber(policyContext?.policyReadiness);
  const measureReadiness = pre.length > 0
    ? pre.filter(m => Array.isArray(m.policyReadinessHints) && m.policyReadinessHints.length > 0).length / pre.length
    : 0;
  const policyReadinessScore = s01(0.6 * ctxReadiness + 0.4 * measureReadiness);

  // ── costEfficiencyScore ──────────────────────────────────────────────────
  // Average inverted cost band, weighted by impact: cheap measures with
  // expected effect score high.
  const costAvg = pre.length > 0
    ? pre.reduce((acc, m) => acc + (COST_NUM[m.costBand] ?? 0.5), 0) / pre.length
    : 0.5;
  const costEfficiencyScore = s01(0.6 * costAvg + 0.4 * safetyImpactScore);

  // ── dataConfidenceScore ──────────────────────────────────────────────────
  // Saturates with total accidents and is reduced if many patterns are
  // marked low-confidence or dataIssue.
  let confBase = Math.min(1, total / 15);
  const lowConfPatterns = patterns.filter(p => p.confidence === 'low' || p.dataIssue);
  if (patterns.length > 0) {
    confBase -= 0.3 * (lowConfPatterns.length / patterns.length);
  }
  const dataConfidenceScore = s01(confBase);

  return {
    safetyImpactScore,
    severeAccidentReductionScore,
    bicycleSafetyScore,
    quickWinScore,
    implementationFeasibilityScore,
    policyReadinessScore,
    costEfficiencyScore,
    dataConfidenceScore
  };
}

function readinessToNumber(level) {
  switch (level) {
    case 'high':   return 1.0;
    case 'medium': return 0.6;
    case 'low':    return 0.2;
    default:       return 0.3;
  }
}

/**
 * Compute per-measure scoring based on enriched library entry, the location
 * scores and the deterministic preselection match information.
 *
 * @param {object} m – preselected measure (already enriched-by-id where possible)
 * @param {object} locationScores
 * @returns {{ fitScore:number, quickWinPotential:number, whyPreselected:string }}
 */
function scoreMeasure(m, locationScores) {
  const matchedConflict = (m.matchedConflictPatterns || []).length;
  const matchedRisk     = (m.matchedRiskFactors || []).length;
  // Same weighting as in preselectMeasures (3 per pattern, 2 per risk),
  // normalised: 3 conflict patterns + 2 risk factors  ≈ saturation.
  const raw = matchedConflict * 3 + matchedRisk * 2;
  const fit = Math.min(1, raw / 10);
  const fitScore = s01(0.7 * fit + 0.3 * (locationScores?.safetyImpactScore || 0));

  // Quick-win potential: blend the library quickWin score (per-measure) with
  // the location-level quickWin readiness. Falls back to library only if the
  // location-level signal is missing.
  const libQw = Number(m.libraryQuickWinScore ?? m.quickWinScore ?? 0);
  const locQw = Number(locationScores?.quickWinScore ?? 0);
  const quickWinPotential = s01(0.7 * libQw + 0.3 * locQw);

  const why = buildWhy(m, fitScore, quickWinPotential);
  return { fitScore, quickWinPotential, whyPreselected: why };
}

function buildWhy(m, fitScore, quickWinPotential) {
  const parts = [];
  if (m.matchedConflictPatterns && m.matchedConflictPatterns.length) {
    parts.push(`adressiert Konfliktmuster: ${m.matchedConflictPatterns.join(', ')}`);
  }
  if (m.matchedRiskFactors && m.matchedRiskFactors.length) {
    parts.push(`passt zu Risikofaktoren: ${m.matchedRiskFactors.join(', ')}`);
  }
  if (parts.length === 0) {
    parts.push(`generelle Maßnahme aus Kategorie ${m.category || m.sourceCategory || 'sonstige'}`);
  }
  parts.push(`fitScore=${fitScore.toFixed(2)}, quickWinPotential=${quickWinPotential.toFixed(2)}`);
  return parts.join('; ');
}

/**
 * Compute per-measure full scoring and attach to a copy of each preselected
 * measure.  The returned list is sorted descending by `fitScore`.
 *
 * @param {Array<object>} preselected
 * @param {LocationScores} locationScores
 * @returns {Array<ScoredMeasure>}
 */
function scoreMeasures(preselected, locationScores) {
  if (!Array.isArray(preselected)) return [];
  return preselected
    .map(m => {
      const s = scoreMeasure(m, locationScores);
      return {
        id: m.id,
        title: m.title,
        category: m.category,
        sourceCategory: m.sourceCategory,
        matchedConflictPatterns: m.matchedConflictPatterns || [],
        matchedRiskFactors:      m.matchedRiskFactors      || [],
        expectedTargetAccidentTypes: m.expectedTargetAccidentTypes
          || m.typicalTargetAccidentTypes
          || m.targetAccidentTypes
          || [],
        implementationEffort: m.implementationEffort,
        costBand: m.costBand,
        implementationDuration: m.implementationDuration,
        ...s
      };
    })
    .sort((a, b) => b.fitScore - a.fitScore);
}

/**
 * Apply a profile (set of weights) to the location sub-scores to produce a
 * single weighted total.
 *
 * @param {LocationScores} scores
 * @param {string} profileId – one of PROFILES.PROFILE_IDS
 * @returns {{ profile: string, total: number, weights: object }}
 */
function applyProfile(scores, profileId) {
  const weights = PROFILES.getProfile(profileId);
  let total = 0;
  let weightSum = 0;
  for (const [k, w] of Object.entries(weights)) {
    if (typeof scores[k] !== 'number') continue;
    total += scores[k] * w;
    weightSum += w;
  }
  const norm = weightSum > 0 ? total / weightSum : 0;
  return { profile: profileId, total: s01(norm), weights };
}

/**
 * For convenience: apply *all* known profiles to a scores object.
 *
 * @param {LocationScores} scores
 * @returns {Array<{ profile:string, total:number, weights:object }>}
 */
function applyAllProfiles(scores) {
  return PROFILES.PROFILE_IDS.map(p => applyProfile(scores, p));
}

module.exports = {
  computeLocationScores,
  scoreMeasure,
  scoreMeasures,
  applyProfile,
  applyAllProfiles
};

/**
 * @typedef {object} LocationScores
 * @property {number} safetyImpactScore
 * @property {number} severeAccidentReductionScore
 * @property {number} bicycleSafetyScore
 * @property {number} quickWinScore
 * @property {number} implementationFeasibilityScore
 * @property {number} policyReadinessScore
 * @property {number} costEfficiencyScore
 * @property {number} dataConfidenceScore
 */

/**
 * @typedef {object} ScoredMeasure
 * @property {string}   id
 * @property {string}   title
 * @property {string}   category
 * @property {string[]} matchedConflictPatterns
 * @property {string[]} matchedRiskFactors
 * @property {string[]} expectedTargetAccidentTypes
 * @property {string}   implementationEffort
 * @property {string}   costBand
 * @property {number}   fitScore
 * @property {number}   quickWinPotential
 * @property {string}   whyPreselected
 */
