'use strict';

const fs = require('fs');
const path = require('path');

function loadBridge(mockWindow) {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../js/ua.ai_political_reference_bridge.js'),
    'utf8'
  );
  (function evaluateInWindow(window) { eval(source); })(mockWindow);
  return mockWindow.UA.aiPoliticalReferenceBridge;
}

function structuredFixture() {
  return {
    meta: {
      city: 'Bonn',
      areaName: 'Adenauerallee, 53113, Bonn, Südstadt',
      involvementMode: 'and',
      filters: { involvement: 'Radverkehr + PKW' }
    },
    severity: {
      total: 37,
      bySev: { '1': 0, '2': 1, '3': 36, other: 0 }
    },
    deviations: {
      local: { total: 37 },
      baseline: { total: 1963 },
      focus: [{
        mask: 5,
        textLabel: 'Radverkehr + PKW',
        locCnt: 8,
        baseCnt: 150,
        locR: 8 / 37,
        baseR: 150 / 1963,
        factor: (8 / 37) / (150 / 1963),
        ciLow: 0.11,
        ciHigh: 0.37,
        isSignificant: true
      }, {
        mask: 1,
        textLabel: 'Radverkehr allein',
        locCnt: 4,
        baseCnt: 150,
        locR: 4 / 37,
        baseR: 150 / 1963,
        factor: (4 / 37) / (150 / 1963),
        ciLow: 0.04,
        ciHigh: 0.25,
        isSignificant: false
      }],
      rows: []
    },
    yearlyTrend: {
      years: [2019, 2020, 2021, 2022, 2023, 2024, 2025],
      counts: { total: [6, 8, 5, 2, 2, 9, 5] },
      slope: -0.142857,
      r2: 0.01,
      nYears: 7,
      classification: 'stagnierend'
    },
    heatmap: {
      total: 37,
      colTotals: [32, 5],
      hours: [0, 1],
      matrix: [[0, 0], [0, 0]]
    },
    accidentDetails: { total: 37, rows: [], truncated: true }
  };
}

function makeWindow() {
  const structured = structuredFixture();
  return {
    location: {
      href: 'https://example.test/werkbank_v2.html?city=Bonn&selSouth=50.7300&selWest=7.0910&selNorth=50.7355&selEast=7.1010'
    },
    setTimeout: jest.fn(),
    UA: {
      aiPoliticalEvidence: {
        currentState: () => ({
          status: 'searched-no-results',
          officialPortalUrl: 'https://www.bonn.sitzung-online.de/public/oparl/system'
        }),
        _internal: { isSuitableForAutomaticHandoff: () => true }
      },
      aiProposal: {
        _internal: {
          buildExternalAiFactsPackage: input => ({
            structured: input.structured,
            deterministicReportText: input.deterministicReportText,
            intendedUse: 'legacy'
          })
        }
      },
      computeExportReport: async () => ({
        text: 'Bereich Adenauerallee, 53113, Bonn, Südstadt',
        html: '<p>Adenauerallee, 53113, Bonn, Südstadt</p>',
        structured
      })
    }
  };
}

describe('AI analysis comparison contract', () => {
  test('preserves production pattern fields and separates significant from exploratory findings', () => {
    const mockWindow = makeWindow();
    const bridge = loadBridge(mockWindow);
    const digest = bridge.buildDeterministicAnalysisDigest(structuredFixture());

    expect(digest.patternCompositionComparison.method).toContain('locR=locCnt/local.total');
    expect(digest.patternCompositionComparison.scopeNote).toMatch(/composition, not an absolute accident rate/i);
    expect(digest.patternCompositionComparison.focus).toHaveLength(2);
    expect(digest.patternCompositionComparison.focus[0]).toMatchObject({
      locCnt: 8,
      baseCnt: 150,
      isSignificant: true,
      interpretation: 'statistically-supported-pattern-overrepresentation'
    });
    expect(digest.patternCompositionComparison.focus[1]).toMatchObject({
      locCnt: 4,
      baseCnt: 150,
      isSignificant: false,
      interpretation: 'exploratory-pattern-difference'
    });
  });

  test('requires substantive AI value beyond a paraphrase', () => {
    const mockWindow = makeWindow();
    const bridge = loadBridge(mockWindow);
    const contract = bridge.buildAiValueAddContract(structuredFixture());

    expect(contract.requiredAiAddedValue.map(item => item.id)).toEqual(expect.arrayContaining([
      'cross-layer-synthesis',
      'prioritisation',
      'competing-explanations',
      'political-administrative-fit',
      'measure-decision-matrix',
      'application-improvement-delta'
    ]));
    expect(contract.prohibitedShortcuts.join(' ')).toMatch(/rewrite|paraphras/i);
    expect(contract.acceptanceRubric.automaticFailure).toContain('no substantive added value beyond paraphrase');
    expect(contract.minimumOutput.crossLayerInsights).toBe(3);
  });

  test('neutralises an unconfirmed midpoint address and enriches the user-owned AI facts package', async () => {
    const mockWindow = makeWindow();
    loadBridge(mockWindow);

    const report = await mockWindow.UA.computeExportReport({
      __uaPoliticalResearchPromise: Promise.resolve()
    });

    expect(report.structured.meta.areaName).toMatch(/Markierter Untersuchungsbereich in Bonn/);
    expect(report.structured.meta.areaName).not.toMatch(/Adenauerallee/);
    expect(report.structured.meta.reverseGeocodedMidpointLabel).toMatch(/Adenauerallee/);
    expect(report.text).not.toMatch(/Adenauerallee/);
    expect(report.structured.politicalContextResearch.status).toBe('searched-no-results');

    const facts = mockWindow.UA.aiProposal._internal.buildExternalAiFactsPackage({
      structured: report.structured,
      deterministicReportText: 'DETERMINISTISCHE ANALYSE'
    });

    expect(facts.deterministicAnalysisDigest.officialAccidentFacts.total).toBe(37);
    expect(facts.aiAnalysisComparisonContract.schemaVersion).toBe(
      'unfallwerkbank.aiAnalysisComparisonContract.v1'
    );
    expect(facts.deterministicReportText).toContain('VERBINDLICHER VERGLEICHS- UND MEHRWERTAUFTRAG');
    expect(facts.intendedUse).toMatch(/höherwertigen KI-Aufbereitung/);
  });

  test('uses an explicitly confirmed area name without neutralising it', async () => {
    const mockWindow = makeWindow();
    mockWindow.location.href += '&areaName=Bonn%20Hauptbahnhof%20und%20angrenzende%20Innenstadtstra%C3%9Fen';
    loadBridge(mockWindow);

    const report = await mockWindow.UA.computeExportReport({});
    expect(report.structured.meta.areaName).toBe('Bonn Hauptbahnhof und angrenzende Innenstadtstraßen');
    expect(report.structured.meta.areaNameQuality).toMatchObject({
      quality: 'confirmed',
      source: 'explicit'
    });
  });
});
