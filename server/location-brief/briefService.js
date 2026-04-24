'use strict';

/**
 * Location Action Brief Service.
 *
 * Erzeugt für eine einzelne Stelle einen strukturierten Maßnahmen-Steckbrief
 * (`LocationActionBrief`) auf Basis:
 *   - eines `structured`-Exports (aus `computeExportReport()` im Frontend),
 *   - optionaler manueller `contextHints`,
 *   - optional eines bereits durchgeführten politischen Kontextergebnisses,
 *   - eines Bewertungsprofils (Default: `low_hanging_fruit`).
 *
 * Der Steckbrief ist deterministisch – KI ist nur eine optionale
 * Veredelung (`aiPolish`-Hook).  Wenn keine KI verfügbar ist, ist der
 * Steckbrief ohne weiteres Zutun einsetzbar.
 *
 * Klare Trennung der Ausgabe:
 *   - `deterministicFindings` – alles, was aus den Daten ableitbar ist
 *   - `modelInferences`       – nur befüllt, wenn `aiPolish` ausgeführt wurde
 *   - `uncertainties`         – ehrlich ausgewiesene Lücken & Schwächen
 *   - `recommendedActions`    – priorisierte Maßnahmenliste
 *
 * @module server/location-brief/briefService
 */

const { deriveFeatures }     = require('../ai/features/deriveFeatures.js');
const { preselectMeasures }  = require('../ai/scoring/preselectMeasures.js');
const { normalizeSlug: normalizeCitySlug } = require('../ai/catalog/cityMeasureCatalog.js');
const { ENRICHED_BY_ID, getMeasureLibrary } = require('./measureLibrary.js');
const { annotateWithAliases, REQUIRED_ENGLISH_IDS } = require('./conflictPatternAliases.js');
const {
  summarizePoliticalContext,
  emptyPoliticalContextSummary
} = require('./politicalContextSummary.js');
const {
  computeLocationScores,
  scoreMeasures,
  applyAllProfiles,
  applyProfile
} = require('./prioritization/scoring.js');
const PROFILES = require('./prioritization/profiles.js');

const SCHEMA_VERSION = 'locationActionBrief.v1';
const DEFAULT_PROFILE = 'low_hanging_fruit';

/**
 * Build a structured Location Action Brief.
 *
 * @param {object} args
 * @param {object} args.structured              – aus computeExportReport()
 * @param {object} [args.contextHints]
 * @param {object} [args.politicalContext]      – Suchergebnis aus politicalContextSearch
 * @param {string} [args.locationId]            – frei wählbare ID der Stelle
 * @param {string} [args.profile]               – Default: low_hanging_fruit
 * @param {object} [args.aiPolish]              – { recommendedMeasures?, narrative?, …}
 *                                                bereits ausgeführte KI-Ausgabe
 *                                                (additiv, niemals ersetzend)
 * @returns {LocationActionBrief}
 */
function buildLocationBrief(args) {
  const {
    structured,
    contextHints,
    politicalContext,
    locationId,
    profile = DEFAULT_PROFILE,
    aiPolish
  } = args || {};

  if (!structured || typeof structured !== 'object') {
    throw new Error('buildLocationBrief: "structured" fehlt oder ist kein Objekt.');
  }
  if (!PROFILES.PROFILE_IDS.includes(profile)) {
    throw new Error(`buildLocationBrief: unbekanntes Profil "${profile}". Erlaubt: ${PROFILES.PROFILE_IDS.join(', ')}`);
  }

  // Step 1: deterministic features
  const features = deriveFeatures(structured, contextHints);
  const patterns = annotateWithAliases(features.conflictPatterns || []);

  // Step 2: deterministic preselection (existing module)
  const citySlug = normalizeCitySlug(structured?.meta?.city);
  const preselectedRaw = preselectMeasures(features, { citySlug });

  // Step 3: enrich preselected measures with library info
  const enrichedById = citySlug
    ? indexById(getMeasureLibrary(citySlug))
    : ENRICHED_BY_ID;

  const preselected = preselectedRaw.map(m => {
    const lib = enrichedById[m.id];
    return {
      ...m,
      // Take normative fields from enriched library where available
      libraryQuickWinScore: lib?.quickWinScore,
      category:             lib?.category || m.category,
      sourceCategory:       lib?.sourceCategory || m.category,
      typicalTargetAccidentTypes: lib?.typicalTargetAccidentTypes || m.targetAccidentTypes || [],
      typicalBenefits:      lib?.typicalBenefits || m.useCases || [],
      exclusionHints:       lib?.exclusionHints  || m.cautions || [],
      policyReadinessHints: lib?.policyReadinessHints || []
    };
  });

  // Step 4: political context summary
  const politicalSummary = politicalContext
    ? summarizePoliticalContext(politicalContext)
    : emptyPoliticalContextSummary();

  // Step 5: multi-criteria scoring
  const locationScores = computeLocationScores({
    features, preselected, policyContext: politicalSummary
  });
  const scoredMeasures = scoreMeasures(preselected, locationScores);

  const profileScores = applyAllProfiles(locationScores);
  const activeProfileScore = applyProfile(locationScores, profile);

  // Step 6: assemble brief
  const meta = structured.meta || {};
  const counts = features.counts || {};
  const cityKey = normalizeForId(meta.city);
  const areaKey = normalizeForId(meta.areaName);
  const derivedId = (cityKey && areaKey) ? `${cityKey}::${areaKey}` : '';
  const locId = locationId || derivedId || 'unknown';

  const accidentProfile = {
    total: counts.total || 0,
    fatal: counts.fatal || 0,
    serious: counts.serious || 0,
    slight: counts.slight || 0,
    ksiShare: features.ksiShare || 0,
    involvement: features.involvement || {},
    trend: features.trend || {}
  };

  const dominantPatterns = patterns.filter(p => p.classification === 'primary')
    .map(p => ({ id: p.id, aliasId: p.aliasId, label: p.label, confidence: p.confidence }));

  const conflictPatterns = patterns.map(p => ({
    id: p.id,
    aliasId: p.aliasId,
    label: p.label,
    classification: p.classification,
    confidence: p.confidence,
    evidence: p.evidence || [],
    rationale: p.rationale,
    requiresOnSiteCheck: p.requiresOnSiteCheck || []
  }));

  const dataQuality = {
    sampleSize:        counts.total || 0,
    weakDataBasis:     (counts.total || 0) < 10,
    dataConfidenceScore: locationScores.dataConfidenceScore,
    spatialDensity:    features.spatialDensity || {},
    notes: [
      'Genaue Unfallhergänge sind nicht im offiziellen Datensatz enthalten.',
      'Verkehrsstärken/Geschwindigkeiten liegen nicht vor.',
      ((counts.total || 0) === 0)
        ? 'Im Auswertungszeitraum keine Unfälle erfasst – ggf. Zeitraum erweitern.'
        : ''
    ].filter(Boolean)
  };

  const candidateMeasures = scoredMeasures;
  const recommendedMeasures = recommend(scoredMeasures, aiPolish);
  const quickWins = scoredMeasures
    .filter(m => m.quickWinPotential >= 0.6 || m.category === 'quickWin' || m.sourceCategory === 'quickWin')
    .slice(0, 5)
    .map(m => ({ id: m.id, title: m.title, quickWinPotential: m.quickWinPotential }));
  const infrastructureOptions = scoredMeasures
    .filter(m => m.sourceCategory === 'infrastructure')
    .slice(0, 5)
    .map(m => ({ id: m.id, title: m.title, category: m.category, costBand: m.costBand }));

  const expectedEffects = recommendedMeasures.map(m => ({
    id: m.id,
    targetAccidentTypes: m.expectedTargetAccidentTypes || [],
    direction: 'reduziert Konflikte / Schwere abhängig von Maßnahmenklasse'
  }));
  const implementationEffort = aggregateBand(recommendedMeasures.map(m => m.implementationEffort));
  const costBands             = recommendedMeasures.map(m => ({ id: m.id, costBand: m.costBand }));

  const confidence = deriveOverallConfidence(locationScores, dataQuality, patterns);

  const openChecks = uniq([
    'Vor-Ort-Begehung mit Polizei und Verwaltung',
    ...patterns.flatMap(p => p.requiresOnSiteCheck || [])
  ]).slice(0, 8);

  const suggestedNextSteps = buildSuggestedNextSteps({
    politicalSummary, recommendedMeasures, dataQuality
  });

  const deterministicFindings = {
    accidentProfile,
    dominantPatterns,
    conflictPatterns,
    dataQuality,
    locationScores,
    profileScores,
    activeProfileScore
  };

  const modelInferences = aiPolish && typeof aiPolish === 'object'
    ? sanitizeModelInferences(aiPolish, scoredMeasures)
    : null;

  const uncertainties = {
    weakDataBasis:           dataQuality.weakDataBasis,
    lowConfidencePatterns:   patterns.filter(p => p.confidence === 'low').map(p => p.id),
    secondaryHypotheses:     patterns.filter(p => p.classification === 'secondary').map(p => p.label),
    requiresOnSiteCheck:     patterns.flatMap(p => p.requiresOnSiteCheck || []).slice(0, 8),
    politicalContextMissing: !politicalContext,
    notes: dataQuality.notes
  };

  const recommendedActions = {
    measures:    recommendedMeasures.map(m => publicMeasure(m)),
    quickWins,
    infrastructureOptions,
    suggestedNextSteps
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    locationId: locId,
    title: meta.areaName
      ? `Maßnahmensteckbrief: ${meta.areaName}${meta.city ? ' (' + meta.city + ')' : ''}`
      : `Maßnahmensteckbrief: ${meta.city || 'unbekannte Stelle'}`,
    problemSummary: buildProblemSummary(accidentProfile, dominantPatterns),
    accidentProfile,
    dominantPatterns,
    conflictPatterns,
    dataQuality,
    politicalContext: politicalSummary,
    candidateMeasures: candidateMeasures.map(publicMeasure),
    recommendedMeasures: recommendedMeasures.map(publicMeasure),
    quickWins,
    infrastructureOptions,
    expectedEffects,
    implementationEffort,
    costBands,
    confidence,
    openChecks,
    suggestedNextSteps,
    // Output sections required by the brief
    deterministicFindings,
    modelInferences,
    uncertainties,
    recommendedActions,
    // Helpful metadata
    meta: {
      schemaVersion: SCHEMA_VERSION,
      profile,
      availableProfiles: PROFILES.PROFILE_IDS.slice(),
      requiredConflictPatternIds: REQUIRED_ENGLISH_IDS.slice(),
      generatedWithAi: Boolean(aiPolish),
      city: meta.city || '',
      areaName: meta.areaName || ''
    }
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function indexById(list) {
  return list.reduce((acc, m) => { acc[m.id] = m; return acc; }, {});
}

function normalizeForId(s) {
  // Bound the input length first to defuse any quadratic regex pathological
  // inputs (CodeQL js/polynomial-redos): a locationId derived from city/area
  // names never legitimately exceeds a few hundred characters.
  const bounded = String(s || '').slice(0, 200).trim().toLowerCase();
  // Replace non-alnum with single underscore, then strip leading/trailing
  // underscores via slice (avoids the polynomial ^_+|_+$ pattern entirely).
  let out = bounded.replace(/[^a-z0-9]+/g, '_');
  let start = 0;
  let end = out.length;
  while (start < end && out.charCodeAt(start) === 95) start++;     // '_'
  while (end > start && out.charCodeAt(end - 1) === 95) end--;
  return out.slice(start, end);
}

function recommend(scoredMeasures, aiPolish) {
  // The default order is already by fitScore desc.  AI polish (if any) may
  // re-rank within the preselected set – never adds new measures.
  let list = scoredMeasures.slice();

  if (aiPolish && Array.isArray(aiPolish.preferredMeasureIds) && aiPolish.preferredMeasureIds.length) {
    const allowed = new Set(scoredMeasures.map(m => m.id));
    const idsSet  = new Set(aiPolish.preferredMeasureIds.filter(id => allowed.has(id)));
    list = scoredMeasures.slice().sort((a, b) => {
      const ai = idsSet.has(a.id) ? 0 : 1;
      const bi = idsSet.has(b.id) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      return b.fitScore - a.fitScore;
    });
  }

  // Top-5 with at least one quick win when available
  const top = list.slice(0, 5);
  const hasQw = top.some(m => m.quickWinPotential >= 0.6 || m.sourceCategory === 'quickWin');
  if (!hasQw) {
    const qw = list.find(m => m.quickWinPotential >= 0.6 || m.sourceCategory === 'quickWin');
    if (qw && !top.some(m => m.id === qw.id)) {
      top[top.length - 1] = qw;
    }
  }
  return top;
}

function publicMeasure(m) {
  return {
    id: m.id,
    title: m.title,
    category: m.category,
    sourceCategory: m.sourceCategory,
    fitScore: m.fitScore,
    quickWinPotential: m.quickWinPotential,
    matchedConflictPatterns: m.matchedConflictPatterns || [],
    matchedRiskFactors:      m.matchedRiskFactors      || [],
    expectedTargetAccidentTypes: m.expectedTargetAccidentTypes || [],
    implementationEffort: m.implementationEffort,
    costBand: m.costBand,
    implementationDuration: m.implementationDuration,
    whyPreselected: m.whyPreselected
  };
}

function aggregateBand(values) {
  if (!Array.isArray(values) || values.length === 0) return 'unknown';
  const order = { low: 0, medium: 1, high: 2 };
  const known = values.filter(v => order[v] !== undefined);
  if (known.length === 0) return 'unknown';
  const sum = known.reduce((s, v) => s + order[v], 0);
  const avg = sum / known.length;
  if (avg < 0.5) return 'low';
  if (avg < 1.5) return 'medium';
  return 'high';
}

function deriveOverallConfidence(scores, dataQuality, patterns) {
  const numericConfidence = (scores.dataConfidenceScore + scores.safetyImpactScore) / 2;
  let level = 'medium';
  if (numericConfidence < 0.25 || dataQuality.weakDataBasis) level = 'low';
  if (numericConfidence > 0.6 && patterns.some(p => p.confidence === 'high')) level = 'high';
  return {
    overall: level,
    numeric: scores.dataConfidenceScore,
    rationale: 'Aggregiert aus Datenkonfidenz und Sicherheits-Impact-Score; in der Regel low bei < 10 Unfällen.'
  };
}

function buildProblemSummary(accidentProfile, dominantPatterns) {
  const parts = [
    `Im Bereich wurden ${accidentProfile.total} Unfälle erfasst (${accidentProfile.fatal} getötet, ${accidentProfile.serious} schwer, ${accidentProfile.slight} leicht).`
  ];
  if (dominantPatterns.length > 0) {
    parts.push('Dominante Konfliktmuster: ' + dominantPatterns.map(p => p.label).join('; ') + '.');
  } else {
    parts.push('Keine eindeutigen Konfliktmuster identifizierbar – Vor-Ort-Bestätigung empfohlen.');
  }
  return parts.join(' ');
}

function buildSuggestedNextSteps({ politicalSummary, recommendedMeasures, dataQuality }) {
  const steps = [];
  if (dataQuality.weakDataBasis) {
    steps.push('Datenbasis erweitern (längerer Auswertungszeitraum, ggf. Polizeidaten).');
  }
  steps.push('Verkehrsschau / Ortstermin mit Polizei und Verwaltung anberaumen.');
  if (politicalSummary.previousPoliticalAttention === 'frequent') {
    steps.push('Sachstand zu bereits laufenden Vorgängen einholen, bevor neue Anträge gestellt werden.');
  } else if (politicalSummary.previousPoliticalAttention === 'none') {
    steps.push('Politische Befassung anregen (zuständiges Gremium / Bezirksrat).');
  }
  const firstQw = recommendedMeasures.find(m => m.quickWinPotential >= 0.6 || m.sourceCategory === 'quickWin');
  if (firstQw) {
    steps.push(`Quick-Win prüfen: „${firstQw.title}“.`);
  }
  return steps.slice(0, 6);
}

function sanitizeModelInferences(aiPolish, allowedMeasures) {
  // Never let AI introduce new measure ids into the brief; only IDs that
  // were already part of the deterministic preselection are accepted.
  const allowed = new Set(allowedMeasures.map(m => m.id));
  const safe = {};
  if (typeof aiPolish.narrative === 'string') {
    safe.narrative = aiPolish.narrative.slice(0, 4000);
  }
  if (typeof aiPolish.councilRequestText === 'string') {
    safe.councilRequestText = aiPolish.councilRequestText.slice(0, 4000);
  }
  if (Array.isArray(aiPolish.preferredMeasureIds)) {
    safe.preferredMeasureIds = aiPolish.preferredMeasureIds
      .filter(id => allowed.has(id))
      .slice(0, 10);
  }
  if (Array.isArray(aiPolish.refinedMeasureRationales)) {
    safe.refinedMeasureRationales = aiPolish.refinedMeasureRationales
      .filter(r => r && allowed.has(r.id))
      .slice(0, 10)
      .map(r => ({ id: r.id, rationale: String(r.rationale || '').slice(0, 1000) }));
  }
  safe.disclaimer = 'KI-veredelte Felder sind ergänzend zu lesen; sie ersetzen die deterministischen Befunde nicht.';
  return safe;
}

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) if (x && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

module.exports = {
  buildLocationBrief,
  SCHEMA_VERSION,
  DEFAULT_PROFILE
};

/**
 * @typedef {object} LocationActionBrief
 * @property {string} schemaVersion
 * @property {string} locationId
 * @property {string} title
 * @property {string} problemSummary
 * @property {object} accidentProfile
 * @property {Array}  dominantPatterns
 * @property {Array}  conflictPatterns
 * @property {object} dataQuality
 * @property {object} politicalContext
 * @property {Array}  candidateMeasures
 * @property {Array}  recommendedMeasures
 * @property {Array}  quickWins
 * @property {Array}  infrastructureOptions
 * @property {Array}  expectedEffects
 * @property {string} implementationEffort
 * @property {Array}  costBands
 * @property {object} confidence
 * @property {Array}  openChecks
 * @property {Array}  suggestedNextSteps
 * @property {object} deterministicFindings
 * @property {object|null} modelInferences
 * @property {object} uncertainties
 * @property {object} recommendedActions
 */
