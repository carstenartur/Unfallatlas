'use strict';

/**
 * Golden / Szenario-Tests für die fachliche Vertiefung der v2-AI-Pipeline.
 *
 * Geprüft wird **Mindestqualität**, nicht Wortlaut. Jeder Fall:
 *   - liefert plausible `conflictPatterns`
 *   - bekommt zur Pattern passende vorselektierte Maßnahmen
 *   - der deterministische Fallback enthält antragstaugliche Felder
 *     (shortAdministrativeSummary, fieldInspectionChecklist, …)
 *   - Unsicherheit wird ehrlich gekennzeichnet (uncertainty)
 *   - Provenance trennt deterministisch von vermutet
 *
 * Diese Tests müssen ohne KI-Verfügbarkeit grün sein.
 */

const { deriveFeatures } = require('../../server/ai/features/deriveFeatures.js');
const { detectConflictPatterns } = require('../../server/ai/features/conflictPatterns.js');
const { preselectMeasures } = require('../../server/ai/scoring/preselectMeasures.js');
const v2 = require('../../server/ai/aiAssessmentServiceV2.js');
const schemaAssessmentV2 = require('../../server/ai/schema/exportAssessment.v2.schema.json');
const schemaProposalV1   = require('../../server/ai/schema/proposalBrief.v1.schema.json');

// ── Fixture-Builder ───────────────────────────────────────────────────────────

/**
 * Erstellt ein minimales `structured`-Objekt mit gut steuerbaren Anteilen.
 * @param {object} opts
 */
function buildStructured(opts) {
  const o = Object.assign({
    city: 'Hannover',
    areaName: 'Testbereich',
    total: 20,
    fatal: 0,
    serious: 2,
    slight: 18,
    crossRows: [],
    poiWithin: {},
    poiNear: {},
    yearTable: [
      { year: 2020, total: 4 },
      { year: 2021, total: 5 },
      { year: 2022, total: 5 },
      { year: 2023, total: 6 }
    ],
    accidentRows: 6
  }, opts || {});

  return {
    meta: {
      city: o.city, areaName: o.areaName, date: '01.01.2025',
      filters: { severity: 'all', roadCondition: 'all' }
    },
    severity: { total: o.total, bySev: { '1': o.fatal, '2': o.serious, '3': o.slight, other: 0 } },
    deviations: { focus: o.crossRows.map(r => ({ mask: r.mask, label: r.label, localCount: r.total, baselineCount: 1, relativeDiff: 1.0 })), rows: [] },
    yearTable: o.yearTable,
    poi: {
      withinByType: o.poiWithin,
      nearByType:   o.poiNear,
      totalWithin:  Object.values(o.poiWithin).reduce((s, x) => s + x, 0),
      totalNear:    Object.values(o.poiNear).reduce((s, x) => s + x, 0)
    },
    references: [],
    crossTable: {
      rows: o.crossRows,
      totals: { sev1: o.fatal, sev2: o.serious, sev3: o.slight, total: o.total }
    },
    accidentDetails: {
      rows: Array.from({ length: o.accidentRows }, (_, i) => ({
        year: 2022, sevLabel: 'leicht', involved: 'Rad+PKW',
        hour: 16,
        lat: 52.375 + (o.spread || 0.0001) * i,
        lon: 9.730  + (o.spread || 0.0001) * i
      })),
      total: o.accidentRows,
      truncated: false
    }
  };
}

function commonFallbackAssertions(result) {
  expect(result.shortAdministrativeSummary).toEqual(expect.any(String));
  expect(result.shortAdministrativeSummary.length).toBeGreaterThan(0);
  expect(Array.isArray(result.fieldInspectionChecklist)).toBe(true);
  expect(result.fieldInspectionChecklist.length).toBeGreaterThan(0);
  expect(result.uncertainty).toBeDefined();
  expect(typeof result.uncertainty.weakDataBasis).toBe('boolean');
  expect(Array.isArray(result.uncertainty.missingData)).toBe(true);
  expect(result.provenance).toBeDefined();
  expect(Array.isArray(result.provenance.derivedFromDeterministicFeatures)).toBe(true);
  expect(result.provenance.derivedFromDeterministicFeatures.length).toBeGreaterThan(0);
  expect(Array.isArray(result.detectedConflictPatterns)).toBe(true);
  expect(result.policyContext).toBeDefined();
}

function runFallback(structured, contextHints, mode = 'assessment') {
  const features = deriveFeatures(structured, contextHints);
  const preselected = preselectMeasures(features, {});
  const aiInput = v2.buildAiInputV2(structured, features, preselected, contextHints);
  const fb = v2.buildDeterministicFallback({ aiInput, mode });
  const validation = v2.validateBySchema(fb, mode === 'proposal-brief' ? schemaProposalV1 : schemaAssessmentV2);
  return { features, preselected, aiInput, fb, validation };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Golden Cases – fachliche Mindestqualität der v2-Pipeline', () => {

  test('1) Fahrradunfallhäufung an Kreuzung → kfz_rad_abbiegekonflikt, passende Maßnahmen', () => {
    const structured = buildStructured({
      total: 18, fatal: 0, serious: 5, slight: 13,
      crossRows: [
        { mask: 5,  label: '🚲+🚗', sev1: 0, sev2: 4, sev3: 8, total: 12 }, // bike+car high
        { mask: 4,  label: '🚗',     sev1: 0, sev2: 1, sev3: 5, total: 6  }
      ]
    });
    const { features, preselected, fb, validation } = runFallback(structured);
    const ids = features.conflictPatterns.map(p => p.id);
    expect(ids).toContain('kfz_rad_abbiegekonflikt');
    expect(preselected.map(m => m.id)).toEqual(expect.arrayContaining(['qw_marking_bike_lane']));
    // Mindestens eine speziell auf Kfz-Rad-Abbiegekonflikt zugeschnittene Maßnahme:
    const ids2 = preselected.map(m => m.id);
    expect(ids2.some(id => ['inf_protected_corner', 'qw_advance_green_bike', 'inf_junction_redesign', 'inf_protected_bike_lane'].includes(id))).toBe(true);
    // Eine der knotenpunktspezifischen Maßnahmen muss das Pattern als matchedConflictPattern führen
    const matched = preselected.find(m => Array.isArray(m.matchedConflictPatterns) && m.matchedConflictPatterns.includes('kfz_rad_abbiegekonflikt'));
    expect(matched).toBeTruthy();
    expect(matched.reasonForPreselection).toMatch(/kfz_rad_abbiegekonflikt/);
    // Fallback ist schemakonform und enthält Antragsbausteine
    expect(validation.valid).toBe(true);
    commonFallbackAssertions(fb);
  });

  test('2) Schienenquerung → schienenquerung_spitzwinkel + inf_rail_crossing_realign', () => {
    const structured = buildStructured({
      total: 12, fatal: 0, serious: 1, slight: 11,
      crossRows: [
        { mask: 1, label: '🚲', sev1: 0, sev2: 1, sev3: 8, total: 9 }
      ]
    });
    const ctx = { knownHazards: ['Schienenquerung im spitzen Winkel an der Tramhaltestelle'] };
    const { features, preselected, fb, validation } = runFallback(structured, ctx);
    expect(features.conflictPatterns.map(p => p.id)).toContain('schienenquerung_spitzwinkel');
    expect(preselected.map(m => m.id)).toEqual(expect.arrayContaining(['inf_rail_crossing_realign']));
    expect(validation.valid).toBe(true);
    commonFallbackAssertions(fb);
  });

  test('3) Oberflächen-/Alleinunfallproblem (Rad ohne Kfz, Belag-Hint)', () => {
    const structured = buildStructured({
      total: 14, fatal: 0, serious: 1, slight: 13,
      crossRows: [
        { mask: 1, label: '🚲', sev1: 0, sev2: 1, sev3: 12, total: 13 } // bike alone dominates
      ]
    });
    const ctx = { surfaceHints: ['Kopfsteinpflaster bei Nässe sehr rutschig'] };
    const { features, preselected, fb, validation } = runFallback(structured, ctx);
    const ids = features.conflictPatterns.map(p => p.id);
    expect(ids).toContain('rad_alleinunfall_oberflaeche');
    expect(preselected.map(m => m.id)).toEqual(expect.arrayContaining(['inf_surface_repair']));
    expect(validation.valid).toBe(true);
    // Belags-Hint muss als Evidenz auftauchen
    const surface = features.conflictPatterns.find(p => p.id === 'rad_alleinunfall_oberflaeche');
    expect(surface.evidence.some(e => /pflaster|belag|nässe|rutsch/i.test(e))).toBe(true);
    commonFallbackAssertions(fb);
  });

  test('4) Schulumfeld / Querungsdruck → schulumfeld_querungsdruck + Schulwegmaßnahmen', () => {
    const structured = buildStructured({
      total: 10, fatal: 0, serious: 1, slight: 9,
      crossRows: [
        { mask: 6, label: '🚶+🚗', sev1: 0, sev2: 1, sev3: 4, total: 5 },
        { mask: 4, label: '🚗',     sev1: 0, sev2: 0, sev3: 5, total: 5 }
      ],
      poiWithin: { Schule: 1, Kindergarten: 1 }
    });
    const { features, preselected, fb, validation } = runFallback(structured);
    expect(features.conflictPatterns.map(p => p.id)).toContain('schulumfeld_querungsdruck');
    expect(preselected.map(m => m.id)).toEqual(expect.arrayContaining(['inf_school_route']));
    expect(validation.valid).toBe(true);
    commonFallbackAssertions(fb);
  });

  test('5) Lkw-Abbiegekonflikt → lkw_lieferverkehr_kontext + inf_truck_routing', () => {
    const structured = buildStructured({
      total: 16, fatal: 1, serious: 3, slight: 12,
      crossRows: [
        { mask: 17, label: '🚲+🚛', sev1: 1, sev2: 2, sev3: 1, total: 4 },  // bike+truck heavy
        { mask: 5,  label: '🚲+🚗', sev1: 0, sev2: 1, sev3: 5, total: 6 },
        { mask: 4,  label: '🚗',     sev1: 0, sev2: 0, sev3: 6, total: 6 }
      ]
    });
    const { features, preselected, fb, validation } = runFallback(structured);
    const ids = features.conflictPatterns.map(p => p.id);
    expect(ids).toContain('lkw_lieferverkehr_kontext');
    expect(preselected.map(m => m.id)).toEqual(expect.arrayContaining(['inf_truck_routing']));
    expect(validation.valid).toBe(true);
    commonFallbackAssertions(fb);
  });

  test('6) Lineares Korridorproblem (Unfälle weit verteilt)', () => {
    const structured = buildStructured({
      total: 12, fatal: 0, serious: 1, slight: 11,
      crossRows: [
        { mask: 5, label: '🚲+🚗', sev1: 0, sev2: 1, sev3: 6, total: 7 }
      ],
      spread: 0.005, // ~ >500m span over 6 points
      accidentRows: 8
    });
    const { features, preselected, fb, validation } = runFallback(structured);
    expect(features.spatialDensity.hint).toBe('distributed');
    expect(features.conflictPatterns.map(p => p.id)).toContain('linearer_korridor_statt_punkt');
    // org_site_inspection sollte enthalten sein (passt zu linearer_korridor_statt_punkt)
    expect(preselected.map(m => m.id)).toEqual(expect.arrayContaining(['org_site_inspection']));
    expect(validation.valid).toBe(true);
    commonFallbackAssertions(fb);
  });

  test('7) Fall mit schwacher Datenlage → uncertainty.weakDataBasis=true + dataGap-Hinweis', () => {
    const structured = buildStructured({
      total: 3, fatal: 0, serious: 1, slight: 2,
      crossRows: [
        { mask: 5, label: '🚲+🚗', sev1: 0, sev2: 1, sev3: 1, total: 2 }
      ],
      yearTable: [{ year: 2023, total: 3 }],
      accidentRows: 3
    });
    const { fb, validation } = runFallback(structured);
    expect(validation.valid).toBe(true);
    expect(fb.uncertainty.weakDataBasis).toBe(true);
    expect(fb.uncertainty.missingData.some(s => /Fallzahl/i.test(s))).toBe(true);
    expect(fb.confidence.overall).toBe('low');
    expect(fb.whyEvidenceIsLimitedIfApplicable).toMatch(/Fallzahl|Vor-Ort/i);
    commonFallbackAssertions(fb);
  });

  test('8) Fall, der vorsichtige Ausgabe erfordert: Schwere Unfälle bei kleiner Stichprobe', () => {
    const structured = buildStructured({
      total: 4, fatal: 1, serious: 2, slight: 1,
      crossRows: [
        { mask: 5, label: '🚲+🚗', sev1: 1, sev2: 1, sev3: 0, total: 2 }
      ],
      yearTable: [{ year: 2023, total: 4 }],
      accidentRows: 4
    });
    const { features, fb, validation } = runFallback(structured);
    expect(features.conflictPatterns.map(p => p.id)).toContain('schwere_unfaelle_geringe_haeufigkeit');
    expect(validation.valid).toBe(true);
    // Confidence der Maßnahmen darf nicht „high" sein
    for (const m of fb.recommendedMeasures || []) {
      expect(['low', 'medium']).toContain(m.confidence);
    }
    expect(fb.confidence.overall).toBe('low');
    // Pattern muss als „dataIssue" markiert sein
    const sa = features.conflictPatterns.find(p => p.id === 'schwere_unfaelle_geringe_haeufigkeit');
    expect(sa.dataIssue).toBe(true);
    commonFallbackAssertions(fb);
  });

  // Zusatz: detectConflictPatterns alleinstehend testen (Edge Cases)
  describe('detectConflictPatterns – Edge Cases', () => {
    test('Total=0 → datenlage_unzureichend mit dataIssue', () => {
      const f = deriveFeatures({
        meta: {}, severity: { total: 0, bySev: {} }, deviations: { focus: [], rows: [] },
        yearTable: [], crossTable: { rows: [], totals: {} }, accidentDetails: { rows: [], total: 0 }
      });
      const ps = detectConflictPatterns(f, {});
      expect(ps[0].id).toBe('datenlage_unzureichend');
      expect(ps[0].dataIssue).toBe(true);
    });

    test('keine Hints, neutrale Daten → keine erfundenen Hochkonfidenzen', () => {
      const f = deriveFeatures({
        meta: {},
        severity: { total: 8, bySev: { '1': 0, '2': 0, '3': 8 } },
        deviations: { focus: [], rows: [] },
        yearTable: [{ year: 2023, total: 8 }],
        crossTable: { rows: [{ mask: 4, label: '🚗', total: 8 }], totals: { total: 8 } },
        accidentDetails: { rows: [], total: 0 }
      });
      const ps = detectConflictPatterns(f);
      // Bei niedriger KSI und nur PKW-Konflikten dürfen wir trotzdem keine Phantasie-Patterns sehen
      for (const p of ps) {
        if (p.id !== 'datenlage_unzureichend') {
          expect(['high', 'medium', 'low']).toContain(p.confidence);
          // bei <10 Unfällen niemals high
          expect(p.confidence).not.toBe('high');
        }
      }
    });

    test('Jedes Pattern enthält ≥1 Evidenzfeld (kein Pattern ohne Datengrund)', () => {
      const structured = buildStructured({
        total: 25, fatal: 1, serious: 4, slight: 20,
        crossRows: [
          { mask: 5, label: '🚲+🚗', total: 12 },
          { mask: 6, label: '🚶+🚗', total: 4 },
          { mask: 17, label: '🚲+🚛', total: 2 }
        ],
        poiWithin: { Schule: 1, Haltestelle: 2 }
      });
      const ctx = { knownHazards: ['Schienen quer'], surfaceHints: ['Belag schlecht'], locationHints: ['Sicht durch parkende Lkw verdeckt'] };
      const features = deriveFeatures(structured, ctx);
      for (const p of features.conflictPatterns) {
        expect(Array.isArray(p.evidence)).toBe(true);
        expect(p.evidence.length).toBeGreaterThan(0);
      }
    });
  });
});
