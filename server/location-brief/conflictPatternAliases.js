'use strict';

/**
 * English conflict-pattern aliases for the Location Action Brief layer.
 *
 * The deterministic conflict-pattern detection lives in
 * `server/ai/features/conflictPatterns.js` and uses German IDs
 * (e.g. `kfz_rad_abbiegekonflikt`).  Those IDs MUST stay stable because
 * they are referenced throughout the existing v2 schema, measure catalog,
 * fallback, prompt and tests.
 *
 * The new prioritization layer ("location action brief") additionally
 * exposes English IDs as required by the product brief, mapped 1:1 to the
 * existing German IDs.  The mapping is the only canonical place to translate
 * between the two namespaces – do not duplicate it elsewhere.
 *
 * Required English IDs:
 *   - bicycle_turning_conflict          ← kfz_rad_abbiegekonflikt
 *   - bicycle_single_accident_surface   ← rad_alleinunfall_oberflaeche
 *   - tram_track_angle_conflict         ← schienenquerung_spitzwinkel
 *   - school_route_crossing_conflict    ← schulumfeld_querungsdruck
 *   - pedestrian_crossing_conflict      ← fussverkehr_konflikt
 *   - truck_turning_conflict            ← lkw_lieferverkehr_kontext
 *   - parking_visibility_conflict       ← sicht_park_konflikt
 *   - stop_area_conflict                ← oepnv_haltestellenbereich
 *   - linear_corridor_deficiency        ← linearer_korridor_statt_punkt
 *   - severe_low_frequency_risk         ← schwere_unfaelle_geringe_haeufigkeit
 *
 * @module server/location-brief/conflictPatternAliases
 */

/** German → English ID mapping (canonical). */
const GERMAN_TO_ENGLISH = Object.freeze({
  kfz_rad_abbiegekonflikt:              'bicycle_turning_conflict',
  rad_alleinunfall_oberflaeche:         'bicycle_single_accident_surface',
  schienenquerung_spitzwinkel:          'tram_track_angle_conflict',
  schulumfeld_querungsdruck:            'school_route_crossing_conflict',
  fussverkehr_konflikt:                 'pedestrian_crossing_conflict',
  lkw_lieferverkehr_kontext:            'truck_turning_conflict',
  sicht_park_konflikt:                  'parking_visibility_conflict',
  oepnv_haltestellenbereich:            'stop_area_conflict',
  linearer_korridor_statt_punkt:        'linear_corridor_deficiency',
  schwere_unfaelle_geringe_haeufigkeit: 'severe_low_frequency_risk',
  // The detector also emits this informational fallback pattern.
  // It is kept untranslated; consumers may treat it as opaque.
  datenlage_unzureichend:               'insufficient_data'
});

/** English → German ID reverse mapping. */
const ENGLISH_TO_GERMAN = Object.freeze(
  Object.entries(GERMAN_TO_ENGLISH).reduce((acc, [de, en]) => {
    acc[en] = de;
    return acc;
  }, {})
);

/**
 * The 10 product-required English pattern IDs (excluding the informational
 * "insufficient_data" fallback). Used by tests and for documentation.
 */
const REQUIRED_ENGLISH_IDS = Object.freeze([
  'bicycle_turning_conflict',
  'bicycle_single_accident_surface',
  'tram_track_angle_conflict',
  'school_route_crossing_conflict',
  'pedestrian_crossing_conflict',
  'truck_turning_conflict',
  'parking_visibility_conflict',
  'stop_area_conflict',
  'linear_corridor_deficiency',
  'severe_low_frequency_risk'
]);

/**
 * @param {string} germanId
 * @returns {string|undefined}
 */
function toEnglishId(germanId) {
  if (typeof germanId !== 'string') return undefined;
  return GERMAN_TO_ENGLISH[germanId];
}

/**
 * @param {string} englishId
 * @returns {string|undefined}
 */
function toGermanId(englishId) {
  if (typeof englishId !== 'string') return undefined;
  return ENGLISH_TO_GERMAN[englishId];
}

/**
 * Annotates each detected ConflictPattern with an `aliasId` (English).
 *
 * Returns a NEW array of new objects; the input is not mutated.
 *
 * @param {Array<object>} patterns – output of `detectConflictPatterns`
 * @returns {Array<object>}
 */
function annotateWithAliases(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns.map(p => {
    if (!p || typeof p !== 'object') return p;
    const aliasId = toEnglishId(p.id);
    return aliasId ? { ...p, aliasId } : { ...p };
  });
}

module.exports = {
  GERMAN_TO_ENGLISH,
  ENGLISH_TO_GERMAN,
  REQUIRED_ENGLISH_IDS,
  toEnglishId,
  toGermanId,
  annotateWithAliases
};
