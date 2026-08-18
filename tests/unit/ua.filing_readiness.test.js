'use strict';

const fs = require('fs');
const path = require('path');

function loadApi() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../js/ua.filing_readiness.js'),
    'utf8'
  );
  const windowValue = { UA: {} };
  (function evaluate(window) { eval(source); })(windowValue);
  return windowValue.UA.filingReadiness;
}

function factsFixture() {
  return {
    visualSceneAnalysisContract: {
      inspectionViews: ['standard', 'hybrid', 'orthophoto', 'analysis'].map(mapMode => ({
        mapMode,
        url: `https://example.test/werkbank_v2.html?city=Hannover&mapMode=${mapMode}`,
      })),
    },
    structured: {
      patternDetection: {
        findings: [
          { patternId: 'bike-rail', status: 'detected' },
          { patternId: 'surface-gap', status: 'not-assessable' },
          { patternId: 'crossing-observed', status: 'observed' },
          { patternId: 'data-warning', status: 'warning' },
          { patternId: 'irrelevant', status: 'not-detected' },
        ],
      },
    },
  };
}

function resultFixture() {
  return {
    accessedResources: ['standard', 'hybrid', 'orthophoto', 'analysis'].map(mapMode => ({
      id: `map-${mapMode}`,
      mapMode,
      status: 'opened',
      url: `https://example.test/werkbank_v2.html?mapMode=${mapMode}&city=Hannover`,
    })),
    mapObservations: [{
      id: 'observation-1',
      evidenceRefs: ['map-hybrid', 'bike-rail'],
    }],
    patternEvaluations: [
      { patternId: 'bike-rail', status: 'supported' },
      { patternId: 'surface-gap', status: 'not-assessable' },
      { patternId: 'crossing-observed', status: 'supported' },
      { patternId: 'data-warning', status: 'not-assessable' },
    ],
    accidentBackgroundResearch: { results: [] },
    politicalAdministrativeResearch: {
      status: 'results-found',
      proceedings: [{
        id: 'political-1',
        sourceUrl: 'https://example.test/ris/political-1',
      }],
      projects: [],
    },
    crossLayerInsights: [{
      evidenceRefs: ['map-hybrid', 'bike-rail'],
    }],
    candidateMeasures: [{
      findingRefs: ['bike-rail'],
    }],
    filingReadiness: { status: 'ready' },
  };
}

describe('central filing-readiness gate', () => {
  test('derives ready only from locally bound maps, patterns, sources and political evidence', () => {
    const api = loadApi();
    const gate = api.evaluate({ result: resultFixture(), facts: factsFixture() });

    expect(gate).toMatchObject({
      passed: true,
      readyForApplication: true,
      filingReady: true,
      analysisQaStatus: 'ready',
      politicalResearchStatus: 'complete',
      filingReadinessStatus: 'ready',
      modelFilingReadinessStatus: 'ready',
    });
    expect(gate.expectedPatternIds).toEqual([
      'bike-rail', 'surface-gap', 'crossing-observed', 'data-warning',
    ]);
  });

  test('downgrades political null results to conditional and never trusts a model upgrade', () => {
    const api = loadApi();
    const result = resultFixture();
    result.politicalAdministrativeResearch = {
      status: 'searched-no-results', proceedings: [], projects: [],
    };

    const gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate).toMatchObject({
      passed: true,
      readyForApplication: true,
      filingReady: false,
      politicalResearchStatus: 'conditional',
      filingReadinessStatus: 'conditional',
      modelFilingReadinessStatus: 'ready',
    });
    expect(gate.warnings.map(item => item.code)).toEqual(expect.arrayContaining([
      'political-research-conditional', 'model-readiness-overstated',
    ]));
  });

  test('blocks failed political research and unlinked claimed results', () => {
    const api = loadApi();
    const failed = resultFixture();
    failed.politicalAdministrativeResearch = { status: 'failed' };
    expect(api.evaluate({ result: failed, facts: factsFixture() })).toMatchObject({
      passed: false,
      readyForApplication: false,
      politicalResearchStatus: 'blocked',
      filingReadinessStatus: 'blocked',
    });

    const unlinked = resultFixture();
    unlinked.politicalAdministrativeResearch = {
      status: 'results-found', proceedings: [], projects: [],
    };
    const gate = api.evaluate({ result: unlinked, facts: factsFixture() });
    expect(gate.errors.map(item => item.code)).toContain('political-research-blocked');
  });

  test('does not accept self-declared manual verification without linked political evidence', () => {
    const api = loadApi();
    const result = resultFixture();
    result.politicalAdministrativeResearch = {
      status: 'completed',
      proceedings: [],
      projects: [],
      manualVerificationCompleted: true,
      alternativeVerificationCompleted: true,
    };

    const gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate).toMatchObject({
      passed: false,
      readyForApplication: false,
      politicalResearchStatus: 'blocked',
      filingReadinessStatus: 'blocked',
    });
    expect(gate.errors.map(item => item.code)).toContain('political-research-blocked');
    expect(gate.errors.find(item => item.code === 'political-research-blocked')?.message)
      .toMatch(/nur behauptet/i);
  });

  test('binds each opened map mode to the exact snapshot URL', () => {
    const api = loadApi();
    const result = resultFixture();
    result.accessedResources.find(item => item.mapMode === 'hybrid').url =
      'https://example.test/werkbank_v2.html?city=Other&mapMode=hybrid';

    const gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate.passed).toBe(false);
    expect(gate.errors.map(item => item.code)).toContain('map-url-hybrid');
  });

  test('requires observed, warning and not-assessable findings to be evaluated', () => {
    const api = loadApi();
    const result = resultFixture();
    result.patternEvaluations = [{ patternId: 'bike-rail', status: 'supported' }];

    const gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate.errors.map(item => item.code)).toEqual(expect.arrayContaining([
      'pattern-surface-gap', 'pattern-crossing-observed', 'pattern-data-warning',
    ]));
    expect(gate.errors.map(item => item.code)).not.toContain('pattern-irrelevant');
  });

  test('rejects invented evidence references in observations, synthesis and measures', () => {
    const api = loadApi();
    const result = resultFixture();
    result.mapObservations[0].evidenceRefs = ['map-hybrid', 'invented-map-source'];
    result.crossLayerInsights[0].evidenceRefs = ['bike-rail', 'invented-research-source'];
    result.candidateMeasures[0].findingRefs = ['invented-pattern'];

    const gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate.errors.map(item => item.code)).toEqual(expect.arrayContaining([
      'map-observation-evidence-1', 'cross-layer-evidence-1', 'measure-evidence-1',
    ]));
  });

  test('rejects self-references and observation-only evidence cycles', () => {
    const api = loadApi();
    const result = resultFixture();
    result.mapObservations = [
      { id: 'observation-1', evidenceRefs: ['observation-1'] },
      { id: 'observation-2', evidenceRefs: ['observation-1'] },
    ];

    const gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate.errors.map(item => item.code)).toEqual(expect.arrayContaining([
      'map-observation-evidence-1', 'map-observation-evidence-2',
    ]));
  });

  test('enforces minimum evidence cardinality independently of schema validation', () => {
    const api = loadApi();
    const result = resultFixture();
    result.mapObservations[0].evidenceRefs = [];
    result.crossLayerInsights[0].evidenceRefs = ['bike-rail'];
    result.candidateMeasures[0].findingRefs = [];

    const gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate.errors.map(item => item.code)).toEqual(expect.arrayContaining([
      'map-observation-evidence-1', 'cross-layer-evidence-1', 'measure-evidence-1',
    ]));
  });

  test('allows the model to downgrade a local ready result, never to upgrade it', () => {
    const api = loadApi();
    const result = resultFixture();
    result.filingReadiness.status = 'conditional';
    let gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate.filingReadinessStatus).toBe('conditional');
    expect(gate.filingReady).toBe(false);

    result.filingReadiness.status = 'blocked';
    gate = api.evaluate({ result, facts: factsFixture() });
    expect(gate.filingReadinessStatus).toBe('blocked');
    expect(gate.readyForApplication).toBe(false);
  });
});
