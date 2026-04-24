'use strict';

/**
 * Location Action Brief – public module surface.
 *
 * Re-exports the deterministic Maßnahmen-Steckbrief facilities that other
 * server code (and tests) should rely on.  The internal implementation is
 * spread across siblings; consumers should import from this index only.
 *
 * @module server/location-brief
 */

const briefService     = require('./briefService.js');
const measureLibrary   = require('./measureLibrary.js');
const aliases          = require('./conflictPatternAliases.js');
const politicalSummary = require('./politicalContextSummary.js');
const profiles         = require('./prioritization/profiles.js');
const scoring          = require('./prioritization/scoring.js');

module.exports = {
  // Brief
  buildLocationBrief: briefService.buildLocationBrief,
  SCHEMA_VERSION:     briefService.SCHEMA_VERSION,
  DEFAULT_PROFILE:    briefService.DEFAULT_PROFILE,
  // Measure library
  getMeasureLibrary:  measureLibrary.getMeasureLibrary,
  ENRICHED_BY_ID:     measureLibrary.ENRICHED_BY_ID,
  // Aliases
  REQUIRED_ENGLISH_IDS: aliases.REQUIRED_ENGLISH_IDS,
  toEnglishId:        aliases.toEnglishId,
  toGermanId:         aliases.toGermanId,
  annotateWithAliases: aliases.annotateWithAliases,
  // Political context
  summarizePoliticalContext:    politicalSummary.summarizePoliticalContext,
  emptyPoliticalContextSummary: politicalSummary.emptyPoliticalContextSummary,
  // Scoring & profiles
  computeLocationScores: scoring.computeLocationScores,
  scoreMeasures:         scoring.scoreMeasures,
  applyProfile:          scoring.applyProfile,
  applyAllProfiles:      scoring.applyAllProfiles,
  PROFILE_IDS:           profiles.PROFILE_IDS,
  PROFILES:              profiles.PROFILES
};
