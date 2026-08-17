'use strict';

const fs = require('fs');
const path = require('path');

function loadModule(windowValue) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../js/ua.ai_visual_research_ui.js'),
    'utf8'
  );
  (function evaluate(window) { eval(source); })(windowValue);
  return windowValue.UA.aiInvestigation;
}

function factsFixture() {
  return {
    city: 'Hannover',
    deterministicAnalysisDigest: {
      officialAccidentFacts: { total: 4, fatal: 0, serious: 1, slight: 3, other: 0 },
      yearlyTrend: { classification: 'stagnierend' },
    },
    structured: {
      meta: { city: 'Hannover' },
      patternDetection: {
        findings: [
          { patternId: 'bike-rail', status: 'detected', detector: { id: 'rail-detector' } },
          { patternId: 'surface', status: 'not-assessable', detector: { id: 'surface-detector' } },
        ],
      },
      politicalContextResearch: { status: 'results-found' },
    },
  };
}

function handoffFixture(facts = factsFixture()) {
  return {
    city: 'Hannover',
    createdAt: '2026-08-16T00:00:00.000Z',
    analysisUrl: 'https://example.test/werkbank_v2.html?city=Hannover',
    facts,
    visualInspectionViews: ['standard', 'hybrid', 'orthophoto', 'analysis'].map(mapMode => ({
      id: mapMode,
      label: mapMode,
      mapMode,
      url: `https://example.test/werkbank_v2.html?mapMode=${mapMode}`,
    })),
  };
}

function validResult(api) {
  return {
    schemaVersion: api.INVESTIGATION_RESULT_SCHEMA,
    investigationId: 'hannover-rail-case',
    verifiedOfficialAccidentFacts: { total: 4, fatal: 0, serious: 1, slight: 3, other: 0 },
    methodologyVerification: {
      patternCompositionMethodCorrect: true,
      yearlyTrendMethodCorrect: true,
    },
    accessedResources: ['standard', 'hybrid', 'orthophoto', 'analysis'].map(mapMode => ({
      id: `map-${mapMode}`,
      url: `https://example.test/werkbank_v2.html?mapMode=${mapMode}`,
      mapMode,
      status: 'opened',
    })),
    mapObservations: [1, 2, 3].map(index => ({
      id: `observation-${index}`,
      featureClass: 'rails-and-track-interface',
      locationDescription: `Schienensegment ${index}`,
      viewIdAndZoom: 'hybrid z18',
      visibleEvidence: 'Schiene und Unfallpunkt räumlich gemeinsam sichtbar',
      accidentSubset: 'bike-only-category',
      spatialRelationToAccidents: 'unmittelbar an derselben Schienenachse',
      proximityOrOverlap: 'overlap',
      mechanismHypothesis: 'flacher Querungswinkel oder Parallelfahrt',
      causalStatus: 'mechanism-plausible',
      confidence: 'medium',
      alternativeExplanation: 'Rinne oder Oberflächenwechsel',
      requiredVerification: ['Vor-Ort-Prüfung'],
      evidenceRefs: ['map-hybrid', 'bike-rail'],
    })),
    patternEvaluations: [
      { patternId: 'bike-rail', status: 'supported' },
      { patternId: 'surface', status: 'not-assessable' },
    ],
    accidentBackgroundResearch: {
      queries: [
        { query: 'Ort Unfall Schiene', sourceType: 'official-police' },
        { query: 'Ort Planung Gleis', sourceType: 'official-city' },
        { query: 'Ort Radverkehr', sourceType: 'operator' },
        { query: 'Ort Unfall', sourceType: 'local-journalism' },
      ],
      results: [],
      nullResults: [],
    },
    politicalAdministrativeResearch: {
      status: 'results-found', queries: [], proceedings: [], projects: [], gaps: [],
    },
    crossLayerInsights: [1, 2, 3].map(index => ({
      id: `insight-${index}`,
      statement: `Schichtenübergreifende Einsicht ${index}`,
      evidenceRefs: ['map-hybrid', 'bike-rail'],
      decisionRelevance: 'hoch',
      confidence: 'medium',
    })),
    competingHypotheses: [{
      claimOrPattern: 'Schienenbezug',
      hypotheses: ['Schiene/Querungswinkel', 'Rinne/Oberflächenwechsel'],
      discriminatingChecks: ['Unfallpunkte und Fahrlinie vor Ort vermessen'],
    }],
    candidateMeasures: [{
      findingRefs: ['bike-rail'],
      safetyObjective: 'sichere Schienenquerung',
      option: 'Fahrlinie und Querungswinkel verbessern',
      prerequisites: ['Vermessung'],
      tradeOffs: ['Flächenbedarf'],
      responsibleBody: 'zuständige Straßenverkehrs- und Tiefbaustelle',
      timeHorizon: '3 Monate',
      successIndicators: ['größerer Querungswinkel', 'eindeutige Führung'],
    }],
    unresolvedQuestions: [],
    deterministicVsAiDelta: { confirmed: [], clarified: [], added: [], rejected: [], open: [] },
    filingReadiness: { status: 'ready', blockers: [], conditions: [], rationale: 'vollständig' },
    application: null,
  };
}

function makeWindow() {
  return { UA: {}, setTimeout, navigator: { clipboard: { writeText: jest.fn() } } };
}

describe('two-stage AI investigation and application workflow', () => {
  test('phase one explicitly forbids an application and asks for structured evidence', () => {
    const api = loadModule(makeWindow());
    const prompt = api.buildInvestigationPrompt(handoffFixture());

    expect(prompt).toContain('Erstelle in dieser Phase keinen Antrag');
    expect(prompt).toContain(api.INVESTIGATION_RESULT_SCHEMA);
    expect(prompt).toContain('standard, hybrid, orthophoto, analysis');
    expect(prompt).toContain('politische und administrative Vorbefassung');
    expect(prompt).toContain('bike-rail');
  });

  test('validates official facts, all map modes, pattern coverage and research before phase two', () => {
    const api = loadModule(makeWindow());
    const facts = factsFixture();
    const result = validResult(api);
    const validation = api.validateInvestigationResult(result, facts);

    expect(validation).toMatchObject({
      passed: true,
      readyForApplication: true,
      filingReady: true,
      filingReadinessStatus: 'ready',
    });
    expect(validation.expectedPatternIds).toEqual(['bike-rail', 'surface']);

    const applicationPrompt = api.buildApplicationPrompt(handoffFixture(facts), result, validation);
    expect(applicationPrompt).toContain(api.APPLICATION_REQUEST_SCHEMA);
    expect(applicationPrompt).toContain('keine austauschbare Überschrift');
    expect(applicationPrompt).toContain('Befund, Sicherheitsziel, Voraussetzung, Zielkonflikt');
  });

  test('blocks drafting when official facts are changed or map/political coverage is incomplete', () => {
    const api = loadModule(makeWindow());
    const result = validResult(api);
    result.verifiedOfficialAccidentFacts.total = 5;
    result.accessedResources = result.accessedResources.filter(resource => resource.mapMode !== 'orthophoto');
    result.politicalAdministrativeResearch.status = 'failed';
    result.filingReadiness.status = 'ready';

    const validation = api.validateInvestigationResult(result, factsFixture());
    expect(validation.passed).toBe(false);
    expect(validation.readyForApplication).toBe(false);
    expect(validation.errors.map(error => error.code)).toEqual(expect.arrayContaining([
      'official-fact-total', 'map-mode-orthophoto', 'political-readiness-conflict',
    ]));
    expect(() => api.buildApplicationPrompt(handoffFixture(), result, validation))
      .toThrow(/nicht validiert/i);
  });

  test('repairs the pre-involvement count from the original runtime context', () => {
    const windowValue = makeWindow();
    windowValue.UA.AnalysisScope = {
      getContextAreaPoints: jest.fn(() => new Array(312).fill({})),
    };
    const api = loadModule(windowValue);
    const original = { selectionBounds: { south: 1, west: 1, north: 2, east: 2 } };
    const scoped = { __analysisScopeOriginalCtx: original };
    const report = {
      text: 'Gebietsbestand vor Beteiligungsfilter: 37 Unfälle im selben Gebiet',
      html: 'Vor dem Beteiligungsfilter liegen im selben Gebiet <strong>37 Unfälle</strong>',
      structured: {
        severity: { total: 37 },
        scopeCounts: { activeInArea: 37, areaBeforeInvolvementFilter: 37 },
        meta: { countScope: { areaBeforeInvolvementFilter: 37 } },
        methodikScope: { lines: ['', 'Gebietsbestand vor Beteiligungsfilter: 37 Unfälle im selben Gebiet'] },
      },
    };

    api.correctCountScopeReport(report, scoped);
    expect(report.structured.scopeCounts.areaBeforeInvolvementFilter).toBe(312);
    expect(report.text).toContain('312 Unfälle');
    expect(report.html).toContain('<strong>312 Unfälle</strong>');
  });
});
