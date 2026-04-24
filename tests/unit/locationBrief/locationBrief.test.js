'use strict';

/**
 * Golden / Szenario-Tests für den Location Action Brief.
 *
 * Geprüft wird die Mindestqualität – nicht der Wortlaut.  Jeder Fall
 * verlangt:
 *   - korrekt erkanntes Konfliktmuster (deutsche und englische ID),
 *   - plausible Maßnahmen-Vorselektion mit fitScore,
 *   - vollständige LocationActionBrief-Struktur,
 *   - klare Trennung deterministisch / KI / Unsicherheit,
 *   - aktive Bewertungsprofile vorhanden.
 *
 * Diese Tests dürfen ohne KI-Verfügbarkeit grün sein.
 */

const {
  buildLocationBrief,
  PROFILE_IDS,
  REQUIRED_ENGLISH_IDS,
  toEnglishId,
  toGermanId,
  computeLocationScores,
  scoreMeasures,
  applyProfile,
  applyAllProfiles,
  getMeasureLibrary,
  ENRICHED_BY_ID,
  summarizePoliticalContext,
  emptyPoliticalContextSummary,
  SCHEMA_VERSION,
  DEFAULT_PROFILE
} = require('../../../server/location-brief');

const { buildStructured, buildPoliticalContext, ref } = require('./fixtures.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function commonBriefAssertions(brief) {
  // top-level shape
  expect(brief.schemaVersion).toBe(SCHEMA_VERSION);
  expect(typeof brief.locationId).toBe('string');
  expect(brief.locationId.length).toBeGreaterThan(0);
  expect(typeof brief.title).toBe('string');
  expect(typeof brief.problemSummary).toBe('string');
  expect(brief.accidentProfile).toBeDefined();
  expect(Array.isArray(brief.dominantPatterns)).toBe(true);
  expect(Array.isArray(brief.conflictPatterns)).toBe(true);
  expect(brief.dataQuality).toBeDefined();
  expect(brief.politicalContext).toBeDefined();
  expect(Array.isArray(brief.candidateMeasures)).toBe(true);
  expect(Array.isArray(brief.recommendedMeasures)).toBe(true);
  expect(Array.isArray(brief.quickWins)).toBe(true);
  expect(Array.isArray(brief.infrastructureOptions)).toBe(true);
  expect(Array.isArray(brief.expectedEffects)).toBe(true);
  expect(typeof brief.implementationEffort).toBe('string');
  expect(Array.isArray(brief.costBands)).toBe(true);
  expect(brief.confidence).toBeDefined();
  expect(typeof brief.confidence.overall).toBe('string');
  expect(Array.isArray(brief.openChecks)).toBe(true);
  expect(Array.isArray(brief.suggestedNextSteps)).toBe(true);
  // separation of concerns
  expect(brief.deterministicFindings).toBeDefined();
  expect(brief.deterministicFindings.locationScores).toBeDefined();
  expect(brief.deterministicFindings.profileScores.length).toBe(PROFILE_IDS.length);
  expect(brief.uncertainties).toBeDefined();
  expect(brief.recommendedActions).toBeDefined();
  expect(Array.isArray(brief.recommendedActions.measures)).toBe(true);
  // model inferences must be null when no aiPolish was passed
  expect(brief.modelInferences).toBeNull();
  // Every recommended measure has fitScore + quickWinPotential + whyPreselected
  for (const m of brief.recommendedMeasures) {
    expect(typeof m.fitScore).toBe('number');
    expect(m.fitScore).toBeGreaterThanOrEqual(0);
    expect(m.fitScore).toBeLessThanOrEqual(1);
    expect(typeof m.quickWinPotential).toBe('number');
    expect(typeof m.whyPreselected).toBe('string');
    expect(m.whyPreselected.length).toBeGreaterThan(0);
  }
  // location scores: all 8 sub-scores in range
  const ls = brief.deterministicFindings.locationScores;
  for (const k of [
    'safetyImpactScore', 'severeAccidentReductionScore', 'bicycleSafetyScore',
    'quickWinScore', 'implementationFeasibilityScore', 'policyReadinessScore',
    'costEfficiencyScore', 'dataConfidenceScore'
  ]) {
    expect(typeof ls[k]).toBe('number');
    expect(ls[k]).toBeGreaterThanOrEqual(0);
    expect(ls[k]).toBeLessThanOrEqual(1);
  }
}

function expectsPattern(brief, germanId) {
  const ids = brief.conflictPatterns.map(p => p.id);
  expect(ids).toContain(germanId);
  // English alias must accompany the German id
  const en = toEnglishId(germanId);
  expect(en).toBeTruthy();
  const aliasIds = brief.conflictPatterns.map(p => p.aliasId).filter(Boolean);
  expect(aliasIds).toContain(en);
}

function expectsMeasure(brief, measureId) {
  const ids = brief.candidateMeasures.map(m => m.id);
  expect(ids).toContain(measureId);
}

// ── Module sanity ─────────────────────────────────────────────────────────────

describe('Location Action Brief – module surface', () => {
  test('alle 10 erforderlichen englischen Pattern-IDs sind exportiert', () => {
    expect(REQUIRED_ENGLISH_IDS).toEqual([
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
    // Round-trip: every English id maps to a German id and back.
    for (const en of REQUIRED_ENGLISH_IDS) {
      const de = toGermanId(en);
      expect(typeof de).toBe('string');
      expect(toEnglishId(de)).toBe(en);
    }
  });

  test('5 Bewertungsprofile vorhanden', () => {
    expect(new Set(PROFILE_IDS)).toEqual(new Set([
      'low_hanging_fruit',
      'bicycle_safety_priority',
      'severe_accident_priority',
      'policy_ready',
      'cost_effective'
    ]));
    expect(PROFILE_IDS).toContain(DEFAULT_PROFILE);
  });

  test('Maßnahmenbibliothek hat alle Pflichtfelder pro Eintrag', () => {
    const lib = getMeasureLibrary();
    expect(lib.length).toBeGreaterThan(0);
    for (const m of lib) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.title).toBe('string');
      expect(typeof m.category).toBe('string');
      expect(Array.isArray(m.applicableConflictPatterns)).toBe(true);
      expect(Array.isArray(m.typicalTargetAccidentTypes)).toBe(true);
      expect(Array.isArray(m.typicalBenefits)).toBe(true);
      expect(Array.isArray(m.exclusionHints)).toBe(true);
      expect(['low','medium','high']).toContain(m.implementationEffort);
      expect(['low','medium','high']).toContain(m.costBand);
      expect(typeof m.quickWinScore).toBe('number');
      expect(m.quickWinScore).toBeGreaterThanOrEqual(0);
      expect(m.quickWinScore).toBeLessThanOrEqual(1);
      expect(Array.isArray(m.policyReadinessHints)).toBe(true);
      expect(typeof m.notes).toBe('string');
    }
    // Spot-check: at least one library measure references English alias for
    // bicycle_turning_conflict (it is paired automatically with the German id).
    const someBike = Object.values(ENRICHED_BY_ID).filter(m =>
      m.applicableConflictPatterns.includes('bicycle_turning_conflict')
    );
    expect(someBike.length).toBeGreaterThan(0);
  });
});

// ── 10 Realistic scenarios ───────────────────────────────────────────────────

describe('Location Action Brief – Szenarien', () => {

  test('1) Fahrradunfallhäufung an Knoten → bicycle_turning_conflict', () => {
    const structured = buildStructured({
      total: 18, fatal: 0, serious: 5, slight: 13,
      crossRows: [
        { mask: 5, label: '🚲+🚗', total: 12, sev1: 0, sev2: 4, sev3: 8 },
        { mask: 4, label: '🚗',     total: 6,  sev1: 0, sev2: 1, sev3: 5 }
      ]
    });
    const brief = buildLocationBrief({ structured });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'kfz_rad_abbiegekonflikt');
    // bike-specific measure should be present
    const ids = brief.candidateMeasures.map(m => m.id);
    expect(ids.some(id => ['inf_protected_bike_lane', 'inf_protected_corner', 'qw_marking_bike_lane', 'qw_advance_green_bike', 'inf_junction_redesign'].includes(id))).toBe(true);
    // bicycleSafetyScore should be elevated
    expect(brief.deterministicFindings.locationScores.bicycleSafetyScore).toBeGreaterThan(0.4);
  });

  test('2) Schienenquerung → tram_track_angle_conflict + Schienen-Maßnahme', () => {
    const structured = buildStructured({
      total: 12, fatal: 0, serious: 1, slight: 11,
      crossRows: [{ mask: 1, label: '🚲', total: 9, sev1: 0, sev2: 1, sev3: 8 }]
    });
    const ctx = { knownHazards: ['Schienenquerung im spitzen Winkel'] };
    const brief = buildLocationBrief({ structured, contextHints: ctx });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'schienenquerung_spitzwinkel');
    expectsMeasure(brief, 'inf_rail_crossing_realign');
  });

  test('3) Oberflächen-/Alleinunfallproblem → bicycle_single_accident_surface', () => {
    const structured = buildStructured({
      total: 14, fatal: 0, serious: 1, slight: 13,
      crossRows: [{ mask: 1, label: '🚲', total: 13, sev1: 0, sev2: 1, sev3: 12 }]
    });
    const ctx = { surfaceHints: ['Kopfsteinpflaster bei Nässe sehr rutschig'] };
    const brief = buildLocationBrief({ structured, contextHints: ctx });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'rad_alleinunfall_oberflaeche');
    expectsMeasure(brief, 'inf_surface_repair');
  });

  test('4) Schulwegquerung → school_route_crossing_conflict + Schulweg-Maßnahme', () => {
    const structured = buildStructured({
      total: 10, fatal: 0, serious: 1, slight: 9,
      crossRows: [
        { mask: 6, label: '🚶+🚗', total: 5, sev1: 0, sev2: 1, sev3: 4 },
        { mask: 4, label: '🚗',     total: 5, sev1: 0, sev2: 0, sev3: 5 }
      ],
      poiWithin: { Schule: 1, Kindergarten: 1 }
    });
    const brief = buildLocationBrief({ structured });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'schulumfeld_querungsdruck');
    expectsMeasure(brief, 'inf_school_route');
  });

  test('5) Lkw-Abbiegekonflikt → truck_turning_conflict', () => {
    const structured = buildStructured({
      total: 14, fatal: 1, serious: 3, slight: 10,
      crossRows: [
        { mask: 17, label: '🚲+🚛', total: 5, sev1: 1, sev2: 2, sev3: 2 }, // bike + truck
        { mask: 5,  label: '🚲+🚗', total: 6, sev1: 0, sev2: 1, sev3: 5 }
      ]
    });
    const ctx = { locationHints: ['Lkw-Liefer­verkehr zur Industriezone'] };
    const brief = buildLocationBrief({ structured, contextHints: ctx });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'lkw_lieferverkehr_kontext');
    const ids = brief.candidateMeasures.map(m => m.id);
    expect(ids.some(id => ['inf_truck_routing', 'inf_protected_corner', 'qw_advance_green_bike'].includes(id))).toBe(true);
  });

  test('6) Sicht-/Parkproblem → parking_visibility_conflict', () => {
    const structured = buildStructured({
      total: 12, fatal: 0, serious: 3, slight: 9,
      crossRows: [
        { mask: 6, label: '🚶+🚗', total: 5, sev1: 0, sev2: 2, sev3: 3 },
        { mask: 5, label: '🚲+🚗', total: 4, sev1: 0, sev2: 1, sev3: 3 }
      ]
    });
    const ctx = { knownHazards: ['Sichtbehinderung durch parkende Fahrzeuge'] };
    const brief = buildLocationBrief({ structured, contextHints: ctx });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'sicht_park_konflikt');
    const ids = brief.candidateMeasures.map(m => m.id);
    expect(ids.some(id => ['qw_parking_setback', 'qw_sight_clearance'].includes(id))).toBe(true);
  });

  test('7) ÖPNV-Haltestellenbereich → stop_area_conflict', () => {
    const structured = buildStructured({
      total: 9, fatal: 0, serious: 1, slight: 8,
      crossRows: [
        { mask: 6, label: '🚶+🚗', total: 4, sev1: 0, sev2: 1, sev3: 3 },
        { mask: 4, label: '🚗',     total: 5, sev1: 0, sev2: 0, sev3: 5 }
      ],
      poiWithin: { Haltestelle: 2 }
    });
    const brief = buildLocationBrief({ structured });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'oepnv_haltestellenbereich');
    expectsMeasure(brief, 'inf_bus_stop_redesign');
  });

  test('8) Linearer Korridor → linear_corridor_deficiency', () => {
    // Use spread of accident points to suggest distributed pattern
    const structured = buildStructured({
      total: 16, fatal: 0, serious: 1, slight: 15,
      accidentRows: 12,
      spread: 0.005, // ~500m span → "distributed"
      crossRows: [
        { mask: 5, label: '🚲+🚗', total: 8, sev1: 0, sev2: 1, sev3: 7 }
      ]
    });
    const brief = buildLocationBrief({ structured });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'linearer_korridor_statt_punkt');
  });

  test('9) Schwere, aber seltene Unfälle → severe_low_frequency_risk', () => {
    const structured = buildStructured({
      total: 6, fatal: 1, serious: 2, slight: 3,
      crossRows: [
        { mask: 5, label: '🚲+🚗', total: 4, sev1: 1, sev2: 2, sev3: 1 }
      ]
    });
    const brief = buildLocationBrief({ structured });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'schwere_unfaelle_geringe_haeufigkeit');
    // Data quality should reflect weakness
    expect(brief.dataQuality.weakDataBasis).toBe(true);
    expect(brief.uncertainties.weakDataBasis).toBe(true);
    // Severe accident reduction should still be elevated due to KSI volume
    expect(brief.deterministicFindings.locationScores.severeAccidentReductionScore).toBeGreaterThan(0.4);
  });

  test('10) Politisch vorbefasster Fall (pedestrian_crossing_conflict + recurring antrag)', () => {
    const structured = buildStructured({
      total: 11, fatal: 0, serious: 2, slight: 9,
      crossRows: [
        { mask: 6, label: '🚶+🚗', total: 6, sev1: 0, sev2: 2, sev3: 4 },
        { mask: 4, label: '🚗',     total: 5, sev1: 0, sev2: 0, sev3: 5 }
      ]
    });
    const politicalContext = buildPoliticalContext([
      ref({ title: 'Antrag: Sichere Querung für Fußgänger an der Hauptstraße', type: 'Antrag' }),
      ref({ title: 'Stellungnahme zur Fußgängersicherheit Hauptstraße',         type: 'Antwort' }),
      ref({ title: 'Antrag: Fußgängerampel an der Kreuzung',                    type: 'Antrag' }),
      ref({ title: 'Beschluss: Verkehrsschau angeordnet',                       type: 'Beschluss' })
    ]);
    const brief = buildLocationBrief({ structured, politicalContext });
    commonBriefAssertions(brief);
    expectsPattern(brief, 'fussverkehr_konflikt');
    expect(brief.politicalContext.previousPoliticalAttention).toBe('frequent');
    expect(brief.politicalContext.policyReadiness).toBeOneOf
      ? brief.politicalContext.policyReadiness
      : null;
    expect(['medium','high']).toContain(brief.politicalContext.policyReadiness);
    expect(brief.politicalContext.recurringRequests.length).toBeGreaterThan(0);
    expect(brief.politicalContext.administrativeMomentumHints.length).toBeGreaterThan(0);
    // Suggested next steps should mention the existing political activity
    const txt = brief.suggestedNextSteps.join(' ');
    expect(/Sachstand|laufenden Vorgängen/i.test(txt)).toBe(true);
    // policyReadinessScore should be elevated
    expect(brief.deterministicFindings.locationScores.policyReadinessScore).toBeGreaterThan(0.4);
  });
});

// ── Profile behaviour ────────────────────────────────────────────────────────

describe('Location Action Brief – Profile beeinflussen Priorisierung', () => {
  function build(profile) {
    const structured = buildStructured({
      total: 18, fatal: 1, serious: 4, slight: 13,
      crossRows: [
        { mask: 5, label: '🚲+🚗', total: 12, sev1: 1, sev2: 4, sev3: 7 }
      ]
    });
    return buildLocationBrief({ structured, profile });
  }

  test('low_hanging_fruit favorisiert quickWin-Maßnahmen', () => {
    const brief = build('low_hanging_fruit');
    const top = brief.recommendedMeasures[0];
    // We should at least have one quick win in the top 3
    const top3 = brief.recommendedMeasures.slice(0, 3);
    expect(top3.some(m => m.sourceCategory === 'quickWin' || m.quickWinPotential >= 0.6)).toBe(true);
    expect(top).toBeDefined();
  });

  test('alle Profile liefern einen total in [0,1]', () => {
    const brief = build('bicycle_safety_priority');
    for (const p of brief.deterministicFindings.profileScores) {
      expect(typeof p.total).toBe('number');
      expect(p.total).toBeGreaterThanOrEqual(0);
      expect(p.total).toBeLessThanOrEqual(1);
      expect(typeof p.profile).toBe('string');
    }
  });

  test('unbekanntes Profil → Fehler', () => {
    const structured = buildStructured({});
    expect(() => buildLocationBrief({ structured, profile: 'does_not_exist' }))
      .toThrow(/unbekanntes Profil/i);
  });
});

// ── KI-Veredelung (optional) ─────────────────────────────────────────────────

describe('Location Action Brief – KI-Veredelung ist additiv und sicher', () => {
  test('aiPolish.preferredMeasureIds re-rankt nur innerhalb der Vorselektion', () => {
    const structured = buildStructured({
      total: 18, serious: 3, slight: 15,
      crossRows: [{ mask: 5, label: '🚲+🚗', total: 10, sev1: 0, sev2: 3, sev3: 7 }]
    });
    const noAi = buildLocationBrief({ structured });
    const candidateIds = noAi.candidateMeasures.map(m => m.id);
    // Pick the *last* candidate id and ask AI to prefer it
    const desired = candidateIds[candidateIds.length - 1];
    const polished = buildLocationBrief({
      structured,
      aiPolish: {
        preferredMeasureIds: [desired, 'evil_invented_id_that_must_be_dropped'],
        narrative: 'KI-Text X'.repeat(50),
        refinedMeasureRationales: [
          { id: desired, rationale: 'KI: passt aus städtebaulicher Sicht.' },
          { id: 'evil_invented_id', rationale: 'wird verworfen' }
        ]
      }
    });
    expect(polished.recommendedMeasures[0].id).toBe(desired);
    // No invented id leaks into recommendedMeasures
    for (const m of polished.recommendedMeasures) {
      expect(candidateIds).toContain(m.id);
    }
    expect(polished.modelInferences).toBeTruthy();
    expect(polished.modelInferences.preferredMeasureIds).toEqual([desired]);
    expect(polished.modelInferences.refinedMeasureRationales.length).toBe(1);
    expect(polished.meta.generatedWithAi).toBe(true);
  });

  test('ohne aiPolish: modelInferences = null und generatedWithAi = false', () => {
    const brief = buildLocationBrief({ structured: buildStructured({}) });
    expect(brief.modelInferences).toBeNull();
    expect(brief.meta.generatedWithAi).toBe(false);
  });
});

// ── Direct units ─────────────────────────────────────────────────────────────

describe('computeLocationScores / scoreMeasures', () => {
  test('scoreMeasures sortiert absteigend nach fitScore und enthält whyPreselected', () => {
    const structured = buildStructured({
      total: 15, serious: 2, slight: 13,
      crossRows: [{ mask: 5, label: '🚲+🚗', total: 10, sev1: 0, sev2: 2, sev3: 8 }]
    });
    const brief = buildLocationBrief({ structured });
    const scored = brief.candidateMeasures;
    for (let i = 1; i < scored.length; i++) {
      expect(scored[i - 1].fitScore).toBeGreaterThanOrEqual(scored[i].fitScore);
    }
  });

  test('applyProfile + applyAllProfiles arbeiten mit denselben Sub-Scores', () => {
    const structured = buildStructured({ total: 5, fatal: 0, serious: 1, slight: 4 });
    const brief = buildLocationBrief({ structured });
    const ls = brief.deterministicFindings.locationScores;
    const all = applyAllProfiles(ls);
    expect(all.length).toBe(PROFILE_IDS.length);
    const single = applyProfile(ls, 'cost_effective');
    expect(single.profile).toBe('cost_effective');
    expect(typeof single.total).toBe('number');
  });
});

describe('summarizePoliticalContext', () => {
  test('leerer Input → leere, gültige Struktur', () => {
    const s = emptyPoliticalContextSummary();
    expect(s.previousPoliticalAttention).toBe('none');
    expect(s.policyReadiness).toBe('low');
    expect(s.relatedReferences).toEqual([]);
    expect(s.recurringRequests).toEqual([]);
    expect(s.administrativeMomentumHints).toEqual([]);
  });

  test('nicht verkehrsrelevante Treffer werden ignoriert (kein Straßennamen-Falsch­positiv)', () => {
    const fake = buildPoliticalContext([
      // Same street name but not classified as traffic-relevant → ignored
      { title: 'Kulturveranstaltung in der Hauptstraße', type: 'Mitteilung', url: 'https://x', relevanceScore: 0.0,
        trafficRelevance: { classification: 'unrelated', isRelevant: false, score: 0 } },
      ref({ title: 'Antrag: Querung sicherer machen', type: 'Antrag' })
    ]);
    const s = summarizePoliticalContext(fake);
    expect(s.relatedReferences.length).toBe(1);
    expect(s.relatedReferences[0].title).toMatch(/Querung/);
  });
});
