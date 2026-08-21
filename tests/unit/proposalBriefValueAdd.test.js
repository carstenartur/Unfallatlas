'use strict';

const proposalSchema = require('../../server/ai/schema/proposalBrief.v1.schema.json');
const service = require('../../server/ai/aiAssessmentServiceV2.js');
const valueAdd = require('../../server/ai/proposalBriefValueAdd.js');

function structuredFixture(politicalStatus = 'complete') {
  return {
    meta: {
      city: 'Bonn',
      areaName: 'Bonn Hauptbahnhof und angrenzende Innenstadtstraßen',
      date: '21.08.2026',
      link: 'https://example.test/werkbank_v2.html?city=Bonn',
      involvementMode: 'and',
      filters: { involvement: 'Radverkehr + PKW' },
    },
    severity: {
      total: 37,
      bySev: { '1': 0, '2': 1, '3': 36, other: 0 },
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
        isSignificant: true,
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
        isSignificant: false,
      }],
      rows: [],
    },
    yearlyTrend: {
      years: [2019, 2020, 2021, 2022, 2023, 2024, 2025],
      counts: { total: [6, 8, 5, 2, 2, 9, 5] },
      slope: -0.142857,
      r2: 0.01,
      nYears: 7,
      classification: 'stagnierend',
    },
    accidentDetails: { total: 37, rows: [], truncated: true },
    politicalContextResearch: {
      status: politicalStatus,
      queries: [{
        query: 'Bonn Hauptbahnhof Verkehrssicherheit',
        source: 'Bonn RIS/OParl',
        url: 'https://www.bonn.sitzung-online.de/public/oparl/system',
      }],
    },
    politicalReferences: [{
      title: 'Verkehrssicherheitsvorgang',
      type: 'Antrag',
      url: 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123',
      source: 'Bonn RIS',
    }],
  };
}

function featuresFixture() {
  return {
    counts: { total: 37, fatal: 0, serious: 1, slight: 36, other: 0 },
    analysisMethodology: {
      schemaVersion: 'unfallwerkbank.analysisMethodology.v1',
      patternComparison: { comparisonType: 'composition-share-ratio' },
    },
    tags: ['bike_car', 'junction'],
    conflictPatterns: [{
      id: 'kfz_rad_abbiegekonflikt',
      label: 'Möglicher Abbiegekonflikt Rad/Kfz',
      classification: 'primary',
      confidence: 'medium',
      rationale: 'Beteiligungsmuster und Knotenbezug sind gemeinsam zu prüfen.',
      requiresOnSiteCheck: ['Abbiegebeziehungen und Sichtachsen prüfen'],
    }],
  };
}

function aiInputFixture(politicalStatus = 'complete') {
  const structured = structuredFixture(politicalStatus);
  const features = featuresFixture();
  return {
    schemaVersion: 'aiInput.v2',
    meta: structured.meta,
    features,
    ...valueAdd.buildProposalEvidenceContracts(structured, features),
    preselectedMeasures: [{
      id: 'qw_marking_bike_lane',
      title: 'Markierung und Führung prüfen',
      category: 'quickWin',
      reasonForPreselection: 'Rad/Kfz-Muster und Knotenbezug',
      matchedRiskFactors: ['bike_car'],
      matchedConflictPatterns: ['kfz_rad_abbiegekonflikt'],
      cautions: ['Lokale Geometrie und Regelkonformität prüfen'],
    }],
  };
}

function legacyProposal() {
  return {
    schemaVersion: 'proposalBrief.v1',
    title: 'Verkehrssicherheit prüfen',
    shortVersion: 'Kurzfassung',
    longVersion: 'Langfassung',
    sachverhalt: '37 dokumentierte Unfälle.',
    begruendung: 'Fachprüfung erforderlich.',
    beschlussvorschlag: 'Die Verwaltung wird um Prüfung gebeten.',
    pruefauftrag: 'Unfalltypen, Lage und Infrastruktur prüfen.',
    measureSummary: [{
      id: 'qw_marking_bike_lane',
      title: 'Markierung und Führung prüfen',
      category: 'quickWin',
      rationale: 'Katalogbasierte Prüfoption',
    }],
    confidence: { overall: 'medium', rationale: 'Deterministische Basis.' },
    caveats: [],
  };
}

function completeValueAddProposal() {
  const proposal = legacyProposal();
  return {
    ...proposal,
    valueAddContractVersion: valueAdd.VALUE_ADD_CONTRACT_VERSION,
    deterministicVsAiComparison: [{
      deterministicFinding: '37 amtlich dokumentierte Unfälle.',
      deltaStatus: 'praezisiert',
      aiVerification: 'Tatsachenkern bestätigt.',
      aiAddedValue: 'Schwere, Lage und Prüfbedarf priorisiert.',
      evidenceRefs: ['severity.bySev'],
      uncertaintyOrCheck: 'Unfalltypen und räumliche Teilbereiche prüfen.',
    }],
    prioritisedFindings: [1, 2, 3].map(rank => ({
      rank,
      finding: `Priorisierter Befund ${rank}`,
      urgency: rank === 1 ? 'high' : 'medium',
      evidenceRefs: [`finding-${rank}`],
      decisionRelevance: 'Bestimmt Reihenfolge und Prüfauftrag.',
    })),
    crossLayerInsights: [1, 2, 3].map(index => ({
      insight: `Mehrschicht-Synthese ${index}`,
      evidenceLayers: [
        'official-accident-data',
        index === 1 ? 'map' : 'political-administrative',
      ],
      evidenceRefs: [`severity-${index}`, `context-${index}`],
      decisionValue: 'Verknüpft Tatsachenkern mit zusätzlichem Entscheidungskontext.',
    })),
    competingHypotheses: [{
      claim: 'Ein Abbiegekonflikt könnte relevant sein.',
      hypotheses: ['Sichtbeziehung/Abbiegegeometrie', 'Verkehrsführung oder Führungswechsel'],
      discriminatingChecks: ['Unfalltypensteckkarte und Vor-Ort-Beobachtung vergleichen'],
    }],
    measureDecisionMatrix: [{
      rank: 1,
      finding: 'Rad/Kfz-Konfliktmuster mit Knotenbezug',
      safetyObjective: 'Konfliktpunkte und Sichtbeziehungen reduzieren',
      option: 'Markierung und Führung fachlich prüfen',
      requiredVerification: ['Geometrie, Regelkonformität und Unfalltypen vor Ort prüfen'],
      responsibility: 'Straßenverkehrsbehörde, Tiefbauamt und Unfallkommission',
      deadline: 'Bericht im nächsten zuständigen Gremium',
      successCriteria: ['Ausgangswert und relevanten Konfliktindikator vor Umsetzung festlegen'],
      tradeoffs: ['Flächenbedarf und ÖPNV-/Lieferverkehr berücksichtigen'],
      evidenceRefs: ['severity.bySev', 'deviations.focus[0]'],
    }],
    politicalResearchLog: {
      status: 'complete',
      sourceStatus: 'complete',
      documentedQueries: [{
        query: 'Bonn Hauptbahnhof Verkehrssicherheit',
        source: 'Bonn RIS/OParl',
        url: 'https://www.bonn.sitzung-online.de/public/oparl/system',
      }],
      evidenceRefs: ['https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123'],
      comparisonToExistingActivity: 'Der Antrag ergänzt den vorhandenen Vorgang um konkrete Evidenz- und Berichtskriterien.',
      remainingChecks: [],
    },
    aiDelta: {
      bestaetigt: ['Amtlicher Tatsachenkern'],
      praezisiert: ['Mustervergleich als Anteilsvergleich eingeordnet'],
      ergaenzt: ['Mehrschicht-Synthesen und Entscheidungsmatrix'],
      verworfen: [],
      offen: ['Exakter Konfliktmechanismus bis zur Fachprüfung'],
    },
    valueAddAssessment: {
      status: 'passed',
      score: 90,
      automaticFailureReasons: [],
    },
    filingReadinessVerdict: {
      status: 'ready',
      analysisQaStatus: 'ready',
      politicalResearchStatus: 'complete',
      reasoning: 'Methodik, Mehrwert, Quellen und politische Recherche sind nachvollziehbar.',
      blockingReasons: [],
    },
  };
}

describe('server-side proposalBrief value-add contract', () => {
  test('builds the deterministic digest with significant and exploratory rows separated', () => {
    const contracts = valueAdd.buildProposalEvidenceContracts(
      structuredFixture(),
      featuresFixture()
    );

    expect(contracts.deterministicAnalysisDigest.schemaVersion)
      .toBe(valueAdd.DETERMINISTIC_DIGEST_VERSION);
    expect(contracts.aiAnalysisComparisonContract.schemaVersion)
      .toBe(valueAdd.AI_COMPARISON_CONTRACT_VERSION);
    expect(contracts.deterministicAnalysisDigest.officialAccidentFacts.total).toBe(37);
    expect(contracts.deterministicAnalysisDigest.patternCompositionComparison.focus[0])
      .toMatchObject({
        isSignificant: true,
        interpretation: 'statistically-supported-pattern-overrepresentation',
      });
    expect(contracts.deterministicAnalysisDigest.patternCompositionComparison.focus[1])
      .toMatchObject({
        isSignificant: false,
        interpretation: 'exploratory-pattern-difference',
      });
  });

  test('renders all mandatory comparison and delta sections into the proposal prompt', () => {
    const prompt = valueAdd.buildProposalValueAddPrompt(aiInputFixture());
    expect(prompt).toContain(valueAdd.AI_COMPARISON_CONTRACT_VERSION);
    expect(prompt).toContain('deterministicVsAiComparison');
    expect(prompt).toContain('crossLayerInsights');
    expect(prompt).toContain('measureDecisionMatrix');
    expect(prompt).toContain('politicalResearchLog');
    expect(prompt).toContain('bestätigt | präzisiert | ergänzt | verworfen | offen');
  });

  test('the raw schema rejects a legacy proposal without value-add evidence', () => {
    const validation = service.validateBySchema(legacyProposal(), proposalSchema);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join(' ')).toMatch(/valueAddContractVersion/);
    expect(validation.errors.join(' ')).toMatch(/deterministicVsAiComparison/);
    expect(validation.errors.join(' ')).toMatch(/filingReadinessVerdict/);
  });

  test('missing model value is retained only as blocked, schema-valid working material', () => {
    const normalised = valueAdd.ensureProposalValueAdd(
      legacyProposal(),
      aiInputFixture('searched-no-results'),
      'Modell lieferte nur eine Paraphrase.'
    );

    expect(service.validateBySchema(normalised, proposalSchema).valid).toBe(true);
    expect(normalised.valueAddAssessment.status).toBe('failed');
    expect(normalised.filingReadinessVerdict.status).toBe('blocked');
    expect(normalised.politicalResearchLog.status).toBe('conditional');
    expect(normalised.filingReadinessVerdict.blockingReasons.join(' '))
      .toMatch(/Mehrwert|Synthesen|Paraphrase/i);
  });

  test('a complete multi-layer comparison can pass and become ready', () => {
    const proposal = completeValueAddProposal();
    const semantic = valueAdd.evaluateProposalValueAdd(proposal);
    const structural = service.validateBySchema(proposal, proposalSchema);

    expect(structural.valid).toBe(true);
    expect(semantic).toEqual({ valid: true, errors: [], warnings: [] });
    expect(proposal.filingReadinessVerdict.status).toBe('ready');
  });

  test('ready is downgraded when the political research is only conditional', () => {
    const proposal = completeValueAddProposal();
    proposal.politicalResearchLog.status = 'conditional';
    proposal.politicalResearchLog.sourceStatus = 'searched-no-results';
    proposal.filingReadinessVerdict.politicalResearchStatus = 'conditional';

    const normalised = valueAdd.ensureProposalValueAdd(proposal, aiInputFixture());
    expect(normalised.valueAddAssessment.status).toBe('failed');
    expect(normalised.filingReadinessVerdict.status).toBe('blocked');
    expect(normalised.filingReadinessVerdict.blockingReasons.join(' '))
      .toMatch(/ready.*politicalResearchLog|politicalResearchLog.*complete/i);
  });

  test('deterministic proposal fallback is neutral, schema-valid and never application-ready', () => {
    const proposal = service.buildDeterministicFallback({
      aiInput: aiInputFixture('searched-no-results'),
      mode: 'proposal-brief',
      reason: 'Provider nicht erreichbar',
    });

    expect(service.validateBySchema(proposal, proposalSchema).valid).toBe(true);
    expect(proposal.valueAddAssessment.status).toBe('failed');
    expect(proposal.filingReadinessVerdict.status).toBe('blocked');
    expect(JSON.stringify(proposal))
      .not.toMatch(/auffällige? Unfallhäufung|liegt eine Unfallhäufung vor/i);
    expect(proposal.beschlussvorschlag).not.toMatch(/umsetzen/i);
    expect(proposal.longVersion)
      .toMatch(/weder eine amtliche Einstufung.*noch.*räumlichen Cluster/i);
  });
});
