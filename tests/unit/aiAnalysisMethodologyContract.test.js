'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const {
  deriveFeatures,
  pickDominantPatterns,
  buildAnalysisMethodology
} = require('../../server/ai/features/deriveFeatures.js');
const { buildPrompt } = require('../../server/ai/prompts/exportAssessmentPrompt.v2.js');

const STRUCTURED_PRODUCTION_SHAPE = {
  meta: {
    city: 'Bonn',
    areaName: 'Adenauerallee',
    date: '16.08.2026',
    link: 'https://example.invalid/werkbank_v2.html?city=Bonn&export=1',
    filters: { severity: 'all', roadCondition: 'all' },
    involvementMode: 'and'
  },
  severity: {
    total: 37,
    bySev: { '1': 0, '2': 1, '3': 36, other: 0 }
  },
  deviations: {
    local: { total: 37 },
    baseline: { total: 1963 },
    focus: [
      {
        mask: 5,
        label: '🚲+🚗',
        textLabel: 'Rad + Pkw',
        locCnt: 8,
        baseCnt: 150,
        locR: 8 / 37,
        baseR: 150 / 1963,
        factor: (8 / 37) / (150 / 1963),
        ciLow: 0.112,
        ciHigh: 0.385,
        isSignificant: true
      },
      {
        mask: 1,
        label: '🚲',
        textLabel: 'Rad allein',
        locCnt: 4,
        baseCnt: 150,
        locR: 4 / 37,
        baseR: 150 / 1963,
        factor: (4 / 37) / (150 / 1963),
        ciLow: 0.043,
        ciHigh: 0.247,
        isSignificant: false
      }
    ],
    rows: []
  },
  yearTable: [
    { year: 2019, total: 6 },
    { year: 2020, total: 8 },
    { year: 2021, total: 5 },
    { year: 2022, total: 2 },
    { year: 2023, total: 2 },
    { year: 2024, total: 9 },
    { year: 2025, total: 5 }
  ],
  yearlyTrend: {
    years: [2019, 2020, 2021, 2022, 2023, 2024, 2025],
    counts: { total: [6, 8, 5, 2, 2, 9, 5] },
    slope: -0.1428571429,
    r2: 0.01,
    nYears: 7,
    classification: 'stagnierend'
  },
  crossTable: {
    rows: [
      { mask: 5, label: '🚲+🚗', total: 8 },
      { mask: 1, label: '🚲', total: 4 },
      { mask: 4, label: '🚗', total: 25 }
    ],
    totals: { total: 37 }
  },
  accidentDetails: {
    rows: Array.from({ length: 8 }, (_, i) => ({
      lat: 50.73 + i * 0.0001,
      lon: 7.09 + i * 0.0001
    })),
    total: 8,
    truncated: false
  }
};

describe('AI methodology contract – production deviation fields', () => {
  test('preserves locCnt/baseCnt/locR/baseR/factor/CI/significance instead of dropping the real export fields', () => {
    const patterns = pickDominantPatterns(
      STRUCTURED_PRODUCTION_SHAPE.deviations,
      STRUCTURED_PRODUCTION_SHAPE.crossTable
    );

    expect(patterns).toHaveLength(2);
    expect(patterns[0]).toMatchObject({
      label: 'Rad + Pkw',
      localCount: 8,
      baselineCount: 150,
      localSampleSize: 37,
      baselineSampleSize: 1963,
      comparisonAvailable: true,
      isSignificant: true,
      source: 'deviations.focus'
    });
    expect(patterns[0].localShare).toBeCloseTo(8 / 37, 4);
    expect(patterns[0].baselineShare).toBeCloseTo(150 / 1963, 4);
    expect(patterns[0].factor).toBeCloseTo((8 / 37) / (150 / 1963), 3);
    expect(patterns[0].ciLow).toBeCloseTo(0.112, 3);
    expect(patterns[0].ciHigh).toBeCloseTo(0.385, 3);
  });

  test('states that the pattern analysis compares composition shares, not absolute accident rates', () => {
    const methodology = buildAnalysisMethodology(
      STRUCTURED_PRODUCTION_SHAPE.deviations,
      STRUCTURED_PRODUCTION_SHAPE.yearlyTrend
    );

    expect(methodology.patternComparison.comparisonType).toBe('composition-share-ratio');
    expect(methodology.patternComparison.formulas.localShare).toContain('locCnt / local.total');
    expect(methodology.patternComparison.formulas.referenceShare).toContain('baseCnt / baseline.total');
    expect(methodology.patternComparison.formulas.factor).toContain('locR / baseR');
    expect(methodology.patternComparison.formulas.uncertainty).toContain('Wilson');
    expect(methodology.patternComparison.exposureRequirement).toMatch(/keine Normierung.*Verkehrsleistung.*erforderlich/is);
    expect(methodology.patternComparison.exposureRequirement).toMatch(/absolutes Unfallrisiko.*Unfallraten/is);
  });

  test('expresses the multi-year trend through relative slope and R² within the same area', () => {
    const methodology = buildAnalysisMethodology(
      STRUCTURED_PRODUCTION_SHAPE.deviations,
      STRUCTURED_PRODUCTION_SHAPE.yearlyTrend
    );

    expect(methodology.yearlyTrend.comparisonType).toBe('within-area-relative-linear-trend');
    expect(methodology.yearlyTrend.formula).toContain('slope / mean');
    expect(methodology.yearlyTrend.meanAnnualCount).toBeCloseTo(37 / 7, 4);
    expect(methodology.yearlyTrend.relativeSlope).toBeCloseTo((-0.1428571429) / (37 / 7), 4);
    expect(methodology.yearlyTrend.r2).toBe(0.01);
    expect(methodology.yearlyTrend.classification).toBe('stagnierend');
  });

  test('server prompt renders the full method and distinguishes significant from exploratory patterns', () => {
    const features = deriveFeatures(STRUCTURED_PRODUCTION_SHAPE);
    const { system, user } = buildPrompt({
      meta: STRUCTURED_PRODUCTION_SHAPE.meta,
      features,
      preselectedMeasures: []
    }, 'assessment');

    expect(system).toMatch(/Mustervergleich.*Anteilen/is);
    expect(system).toMatch(/Verlange.*nicht pauschal Expositionsdaten/is);
    expect(user).toContain('=== METHODENVERTRAG – VOR JEDER STATISTISCHEN KRITIK BEACHTEN ===');
    expect(user).toContain('locR = locCnt / local.total');
    expect(user).toContain('baseR = baseCnt / baseline.total');
    expect(user).toContain('factor = locR / baseR');
    expect(user).toContain('Wilson-Score-Konfidenzintervall');
    expect(user).toMatch(/Rad \+ Pkw: lokal .*Faktor .*statistisch über dem Referenzanteil/is);
    expect(user).toMatch(/Rad allein: lokal .*explorative Abweichung/is);
    expect(user).toMatch(/relative Steigung .*R²=0,01/is);
    expect(user).not.toMatch(/Flächen.*Nenner erforderlich/is);
  });
});

describe('frontend AI handoff methodology bridge', () => {
  function loadBridge() {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.ai_political_reference_bridge.js'),
      'utf8'
    );
    const structured = JSON.parse(JSON.stringify(STRUCTURED_PRODUCTION_SHAPE));
    const root = {
      UA: {
        aiPoliticalEvidence: {
          currentState: () => ({
            status: 'searched-no-results',
            references: [],
            officialPortalUrl: 'https://example.invalid/ris',
            qaInstruction: 'Amtliche Recherche manuell verifizieren.'
          }),
          _internal: { isSuitableForAutomaticHandoff: () => true }
        },
        aiProposal: {
          _internal: {
            buildExternalAiFactsPackage: input => ({
              schemaVersion: 'unfallwerkbank.externalAiPromptFacts.v1',
              structured: input.structured
            })
          }
        },
        computeExportReport: async () => ({ structured })
      },
      setTimeout,
      clearTimeout
    };
    root.window = root;
    const context = vm.createContext(root);
    vm.runInContext(source, context, { filename: 'ua.ai_political_reference_bridge.js' });
    return { root, structured };
  }

  test('adds the method contract to structured reports used by both AI paths', async () => {
    const { root, structured } = loadBridge();
    const report = await root.UA.computeExportReport({
      __uaPoliticalResearchPromise: Promise.resolve()
    });

    expect(report.structured).toBe(structured);
    expect(structured.analysisMethodology.patternComparison.comparisonType).toBe('composition-share-ratio');
    expect(structured.analysisMethodology.mandatoryInterpretationBeforeQa.join(' ')).toMatch(/Anteile von Beteiligungskombinationen/);
    expect(structured.analysisMethodology.forbiddenMisinterpretation).toMatch(/nicht.*Unfallraten/is);
  });

  test('promotes the method contract to the top-level user-owned facts package with a rejection gate', () => {
    const { root, structured } = loadBridge();
    const facts = root.UA.aiProposal._internal.buildExternalAiFactsPackage({ structured });

    expect(facts.analysisMethodology.patternComparison.formulas.factor).toBe('factor = locR / baseR');
    expect(facts.methodologyQaGate.required).toMatch(/vor jeder statistischen Kritik/i);
    expect(facts.methodologyQaGate.rejectIf).toMatch(/direkten Vergleich absoluter Unfallraten/i);
  });
});
