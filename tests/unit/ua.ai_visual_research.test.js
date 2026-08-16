/** @jest-environment jsdom */
'use strict';

const fs = require('fs');
const path = require('path');

function loadModule() {
  jest.resetModules();
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../js/ua.ai_visual_research.js'),
    'utf8'
  );
  window.UA = {};
  // Do not run the retry loop in pure contract tests.
  const originalTimeout = window.setTimeout;
  window.setTimeout = jest.fn();
  (function evaluate(window) { eval(source); })(window);
  window.setTimeout = originalTimeout;
  return window.UA.aiVisualResearch;
}

function baseFacts() {
  return {
    city: 'Bonn',
    mapUrl: 'https://example.test/werkbank_v2.html?city=Bonn&mapMode=standard&includeCyclist=1&includeCar=1&involvementMode=and&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010&export=1',
    structured: {
      meta: {
        city: 'Bonn',
        areaName: 'Bonn Hauptbahnhof',
        filters: { involvement: 'Radverkehr UND Pkw' },
      },
    },
    aiAnalysisComparisonContract: {
      requiredAiAddedValue: [{ id: 'cross-layer-synthesis', requirement: 'Bestehender Vertrag' }],
      prohibitedShortcuts: ['Merely rewriting tables.'],
      minimumOutput: { crossLayerInsights: 3 },
    },
  };
}

describe('UA.aiVisualResearch – semantic scene and incident research contracts', () => {
  afterEach(() => {
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('builds four same-state inspection views and removes export mode', () => {
    const api = loadModule();
    const views = api.buildInspectionViews(baseFacts().mapUrl);

    expect(views).toHaveLength(4);
    expect(views.map(view => view.mapMode)).toEqual([
      'standard', 'hybrid', 'orthophoto', 'analysis',
    ]);
    for (const view of views) {
      const url = new URL(view.url);
      expect(url.searchParams.get('city')).toBe('Bonn');
      expect(url.searchParams.get('includeCyclist')).toBe('1');
      expect(url.searchParams.get('includeCar')).toBe('1');
      expect(url.searchParams.get('involvementMode')).toBe('and');
      expect(url.searchParams.get('selSouth')).toBe('50.7300');
      expect(url.searchParams.get('selEast')).toBe('7.1010');
      expect(url.searchParams.has('export')).toBe(false);
    }
    expect(new URL(views[3].url).searchParams.get('showCluster')).toBe('1');
    expect(new URL(views[3].url).searchParams.get('showHeatmap')).toBe('1');
  });

  test('requires rails, curves, multimodal crossings and conservative surface language', () => {
    const api = loadModule();
    const contract = api.buildVisualSceneAnalysisContract(
      api.buildInspectionViews(baseFacts().mapUrl)
    );
    const classes = contract.requiredFeatureClasses.map(item => item.id);
    const text = JSON.stringify(contract);

    expect(classes).toEqual(expect.arrayContaining([
      'rails-and-track-interface',
      'curvature-and-deflection',
      'walking-cycling-motor-crossings',
      'cycle-facility-continuity',
      'surface-and-drainage',
    ]));
    expect(text).toMatch(/Hauptbahntrasse.*nicht automatisch.*Schienensturzgefahr/i);
    expect(text).toMatch(/Kopfsteinpflaster.*zweite Quelle.*nicht sicher beurteilbar/i);
    expect(contract.minimumOutput.openedMapModes).toBeGreaterThanOrEqual(3);
    expect(contract.automaticFailure.join(' ')).toMatch(/Bildbeobachtung.*Unfallursache/i);
  });

  test('prioritises official crash reports and separates exact, adjacent and analogue events', () => {
    const api = loadModule();
    const contract = api.buildAccidentBackgroundResearchContract(baseFacts());

    expect(contract.sourcePriority[0].sourceType).toBe('official-police-or-fire-service');
    expect(contract.spatialMatchClasses.map(item => item.id)).toEqual([
      'inside-selection',
      'immediate-adjacency',
      'citywide-analogue',
      'unknown-or-unrelated',
    ]);
    expect(contract.searchSeeds).toMatchObject({
      city: 'Bonn',
      area: 'Bonn Hauptbahnhof',
      involvement: 'Radverkehr UND Pkw',
    });
    expect(contract.interpretationRules.join(' '))
      .toMatch(/Ein einzelner Pressebericht.*keine Ursache für die gesamte Häufung/i);
    expect(contract.minimumOutput.noHitLog).toBe(true);
  });

  test('extends the AI value-add contract instead of merely adding prose', () => {
    const api = loadModule();
    const facts = api.enhanceFactsPackage(baseFacts(), baseFacts().mapUrl);
    const ids = facts.aiAnalysisComparisonContract.requiredAiAddedValue
      .map(item => item.id);

    expect(ids).toEqual(expect.arrayContaining([
      'cross-layer-synthesis',
      'semantic-visual-scene-analysis',
      'accident-background-research',
    ]));
    expect(facts.aiAnalysisComparisonContract.minimumOutput)
      .toMatchObject({
        semanticVisualSceneAnalysis: true,
        accidentBackgroundResearchLog: true,
        locatedVisualObservations: 3,
      });
    expect(facts.visualAndResearchReadiness.filingReady).toBe(false);
  });

  test('enhances the generated handoff with auditable prompt markers and contracts', () => {
    const api = loadModule();
    const base = {
      schemaVersion: 'unfallwerkbank.aiResearchHandoff.v2',
      city: 'Bonn',
      analysisUrl: baseFacts().mapUrl,
      facts: baseFacts(),
      promptAudit: { passed: true, missingMarkers: [] },
      prompt: '# Basisauftrag\nQA-Urteil und Evidenzmatrix',
    };

    const enhanced = api.enhanceHandoff(base);

    expect(enhanced.schemaVersion).toBe('unfallwerkbank.aiResearchHandoff.v3');
    expect(enhanced.visualInspectionViews).toHaveLength(4);
    expect(enhanced.prompt).toContain('SEMANTISCHE KARTENINTERPRETATION');
    expect(enhanced.prompt).toContain('Schienen/Gleise');
    expect(enhanced.prompt).toContain('Kopfsteinpflaster');
    expect(enhanced.prompt).toContain('UNFALLHINTERGRUNDRECHERCHE');
    expect(enhanced.prompt).toContain('amtlichen Polizeimeldungen');
    expect(enhanced.visualResearchPromptAudit.passed).toBe(true);
    expect(enhanced.promptAudit.passed).toBe(true);
  });

  test('rejects a generic visual prompt that does not require semantic reading', () => {
    const api = loadModule();
    const audit = api.auditEnhancedPrompt('Prüfe bitte, ob die Karte gut aussieht.');

    expect(audit.passed).toBe(false);
    expect(audit.missingMarkers).toContain('Schienen/Gleise');
    expect(audit.missingMarkers).toContain('UNFALLHINTERGRUNDRECHERCHE');
  });
});
