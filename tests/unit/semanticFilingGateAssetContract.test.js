'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

describe('semantic filing-gate asset contract', () => {
  test('loads the semantic gate after the central gate and before the application UI', () => {
    const source = fs.readFileSync(path.join(ROOT, 'js', 'ua.data_paths.js'), 'utf8');
    const filing = source.indexOf('const filingReadinessPromise');
    const semantic = source.indexOf('const semanticFilingGatePromise');
    const ui = source.indexOf('aiVisualResearchUi: semanticFilingGatePromise.then');

    expect(filing).toBeGreaterThan(-1);
    expect(semantic).toBeGreaterThan(filing);
    expect(ui).toBeGreaterThan(semantic);
    expect(source).toContain('js/ua.semantic_filing_gate.js?v=2026-08-20-1');
    expect(source).toContain('data-ua-semantic-filing-gate');
    expect(source).toContain('const semanticFilingGatePromise = filingReadinessPromise.then');
    expect(source).toContain('if (!loaded) return false;');
    expect(source).toContain('filingReadiness: semanticFilingGatePromise');
    expect(source).toContain('semanticFilingGate: semanticFilingGatePromise');
  });

  test('the shipped module is fail-closed and preserves evaluator-chain metadata', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'js', 'ua.semantic_filing_gate.js'),
      'utf8'
    );

    expect(source).toContain('unfallwerkbank.semanticFilingGate.v1');
    expect(source).toContain('semantic-official-hotspot-overclaim');
    expect(source).toContain('semantic-spatial-cluster-overclaim');
    expect(source).toContain('semantic-corridor-overclaim');
    expect(source).toContain('semantic-pattern-composition-overclaim');
    expect(source).toContain('semantic-static-summary-conflict');
    expect(source).toContain('semantic-filter-scope-tautology');
    expect(source).toContain('semantic-synthetic-map-concrete-measure');
    expect(source).toContain("wrappedEvaluate._original = originalEvaluate");
    expect(source).toContain("wrappedEvaluate._uaOriginal = originalEvaluate");
    expect(source).toContain('wrapped._uaSemanticReportAdapter = true');
    expect(source).toContain('normaliseReport');
    expect(source).toContain('errors: mergeMessages(options.errors, semantic.errors)');
  });

  test('publishes the semantic extension in the filing-readiness JSON schema', () => {
    const schema = JSON.parse(fs.readFileSync(
      path.join(ROOT, 'schemas', 'filing-readiness.schema.json'),
      'utf8'
    ));

    expect(schema.properties.semanticFilingGateSchemaVersion.const)
      .toBe('unfallwerkbank.semanticFilingGate.v1');
    expect(schema.properties.semanticAnalysisClassification.$ref)
      .toBe('#/$defs/semanticAnalysisClassification');
    expect(schema.$defs.semanticAnalysisClassification.properties.corridorProblem.enum)
      .toEqual(['supported', 'not-established']);
    expect(schema.$defs.semanticPreflight.properties.recommendedExecutiveSummary.minLength)
      .toBe(1);
  });
});
