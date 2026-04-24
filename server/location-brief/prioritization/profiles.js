'use strict';

/**
 * Bewertungsprofile für die Multi-Kriterien-Priorisierung.
 *
 * Jedes Profil weist den 8 Sub-Scores aus
 * `prioritization/scoring.js#computeLocationScores` Gewichte zu.  Die Gewichte
 * sind nicht normiert; das Scoring übernimmt die Normalisierung.
 *
 * Profile:
 *   - low_hanging_fruit         – schnell wirksame, günstige Maßnahmen
 *   - bicycle_safety_priority   – Radverkehrssicherheit zuerst
 *   - severe_accident_priority  – KSI-Reduktion zuerst
 *   - policy_ready              – politisch / verwaltungstechnisch anschlussfähig
 *   - cost_effective            – kostengünstige Wirkung pro Euro
 *
 * Architektur-Hinweis (gem. Aufgabenstellung):
 *   Die Profile sind reine Gewichtsvektoren.  Die Prioritätenlogik selbst
 *   ist in `scoring.js` gekapselt, damit zukünftige stadtweite Pipelines
 *   ohne Codeänderung an dieser Stelle weitere Profile registrieren können.
 *
 * @module server/location-brief/prioritization/profiles
 */

const PROFILES = Object.freeze({
  low_hanging_fruit: Object.freeze({
    safetyImpactScore:               1,
    quickWinScore:                   3,
    implementationFeasibilityScore:  2,
    costEfficiencyScore:             2,
    dataConfidenceScore:             1
  }),
  bicycle_safety_priority: Object.freeze({
    bicycleSafetyScore:              3,
    safetyImpactScore:               2,
    severeAccidentReductionScore:    2,
    implementationFeasibilityScore:  1,
    dataConfidenceScore:             1
  }),
  severe_accident_priority: Object.freeze({
    severeAccidentReductionScore:    3,
    safetyImpactScore:               2,
    policyReadinessScore:            1,
    dataConfidenceScore:             1
  }),
  policy_ready: Object.freeze({
    policyReadinessScore:            3,
    quickWinScore:                   2,
    safetyImpactScore:               1,
    implementationFeasibilityScore:  1
  }),
  cost_effective: Object.freeze({
    costEfficiencyScore:             3,
    quickWinScore:                   2,
    implementationFeasibilityScore:  1,
    safetyImpactScore:               1
  })
});

const PROFILE_IDS = Object.freeze(Object.keys(PROFILES));

/**
 * Returns the weight vector for a profile.  Throws on unknown profile.
 *
 * @param {string} id
 * @returns {Object<string, number>}
 */
function getProfile(id) {
  if (!Object.prototype.hasOwnProperty.call(PROFILES, id)) {
    throw new Error(`Unbekanntes Bewertungsprofil "${id}". Erlaubt: ${PROFILE_IDS.join(', ')}`);
  }
  return PROFILES[id];
}

module.exports = {
  PROFILES,
  PROFILE_IDS,
  getProfile
};
