'use strict';

const valueAdd = require('../../server/ai/proposalBriefValueAdd.js');

function proposal(research) {
  return {
    valueAddContractVersion: valueAdd.VALUE_ADD_CONTRACT_VERSION,
    deterministicVsAiComparison: [{ deterministicFinding: '37 Unfälle' }],
    prioritisedFindings: [{ rank: 1 }, { rank: 2 }, { rank: 3 }],
    crossLayerInsights: [1, 2, 3].map(index => ({
      insight: `Synthese ${index}`,
      evidenceLayers: ['official-accident-data', 'political-administrative'],
      evidenceRefs: [`accident-${index}`, `political-${index}`],
      decisionValue: 'Verknüpft unabhängige Evidenzschichten.',
    })),
    competingHypotheses: [{
      claim: 'Möglicher Konfliktmechanismus',
      hypotheses: ['Geometrie', 'Verkehrsführung'],
      discriminatingChecks: ['Unfalltypen und Vor-Ort-Beobachtung vergleichen'],
    }],
    measureDecisionMatrix: [{
      finding: 'Rad/Kfz-Prüfmuster',
      safetyObjective: 'Konflikte reduzieren',
      option: 'Führung und Markierung prüfen',
      requiredVerification: ['Geometrie und Regelkonformität vor Ort prüfen'],
      responsibility: 'Verwaltung und Unfallkommission',
      deadline: 'Bericht im zuständigen Gremium',
      successCriteria: ['Ausgangswert und Konfliktindikator festlegen'],
      evidenceRefs: ['deviations.focus[0]'],
    }],
    politicalResearchLog: research,
    aiDelta: {
      bestaetigt: [],
      praezisiert: ['Mustervergleich methodisch eingeordnet'],
      ergaenzt: ['Politischen Kontext mit Unfallbefund verbunden'],
      verworfen: [],
      offen: [],
    },
    valueAddAssessment: {
      status: 'passed',
      score: 90,
      automaticFailureReasons: [],
    },
    filingReadinessVerdict: {
      status: 'ready',
      analysisQaStatus: 'ready',
      politicalResearchStatus: research.status,
      reasoning: 'Mehrwert und politische Recherche sind belegt.',
      blockingReasons: [],
    },
  };
}

function completeResearch() {
  return {
    status: 'complete',
    sourceStatus: 'results-found',
    documentedQueries: [{
      query: 'Bonn Hauptbahnhof Verkehrssicherheit',
      source: 'Bonn RIS/OParl',
      sourceType: 'ris-oparl',
      url: 'https://www.bonn.sitzung-online.de/public/oparl/system',
    }],
    evidenceRefs: [
      'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123',
    ],
    comparisonToExistingActivity: 'Der neue Prüfauftrag ergänzt den vorhandenen Vorgang.',
    remainingChecks: [],
  };
}

describe('proposal political evidence gate', () => {
  test('accepts complete political research only with reproducible query and direct evidence', () => {
    const result = valueAdd.evaluateProposalValueAdd(proposal(completeResearch()));
    expect(result).toEqual({ valid: true, errors: [], warnings: [] });
  });

  test('blocks a claimed complete search without named source and direct HTTP evidence', () => {
    const research = completeResearch();
    research.documentedQueries = [{
      query: 'Bonn Hauptbahnhof Verkehrssicherheit',
      source: 'unspecified',
      sourceType: 'unspecified',
      url: '',
    }];
    research.evidenceRefs = ['opaque-reference-id'];

    const result = valueAdd.evaluateProposalValueAdd(proposal(research));
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Suchprotokoll/);
    expect(result.errors.join(' ')).toMatch(/HTTP\(S\)-Evidenzreferenz/);

    const hardened = valueAdd.ensureProposalValueAdd(proposal(research), {}, 'test');
    expect(hardened.valueAddAssessment.status).toBe('failed');
    expect(hardened.filingReadinessVerdict.status).toBe('blocked');
    expect(hardened.politicalResearchLog.status).toBe('blocked');
  });

  test('downgrades a fallback complete status when deterministic evidence has no links', () => {
    const fallback = valueAdd.buildBlockedFallbackContract({
      deterministicAnalysisDigest: {
        politicalResearch: {
          status: 'complete',
          queries: [],
          references: [],
        },
      },
    }, 'Provider nicht erreichbar');

    expect(fallback.politicalResearchLog.status).toBe('blocked');
    expect(fallback.filingReadinessVerdict.politicalResearchStatus).toBe('blocked');
    expect(fallback.filingReadinessVerdict.blockingReasons.join(' '))
      .toMatch(/Suchprotokoll.*HTTP\(S\)-Evidenz/i);
  });

  test('keeps a documented no-result search conditional rather than treating it as no prior activity', () => {
    const fallback = valueAdd.buildBlockedFallbackContract({
      deterministicAnalysisDigest: {
        politicalResearch: {
          status: 'searched-no-results',
          queries: [{
            query: 'Bonn Hauptbahnhof Verkehrssicherheit',
            source: 'Bonn RIS/OParl',
            sourceType: 'ris-oparl',
            url: 'https://www.bonn.sitzung-online.de/public/oparl/system',
          }],
          references: [],
        },
      },
    });

    expect(fallback.politicalResearchLog.status).toBe('conditional');
    expect(fallback.politicalResearchLog.documentedQueries).toHaveLength(1);
    expect(fallback.filingReadinessVerdict.status).toBe('blocked');
  });
});
