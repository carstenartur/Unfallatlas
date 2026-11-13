'use strict';

const { createHash } = require('node:crypto');
const { reviewModelResponse } = require('../../scripts/qa-bonn-hbf-ai-golden.js');
const proposalSchema = require('../../server/ai/schema/proposalBrief.v1.schema.json');
const service = require('../../server/ai/aiAssessmentServiceV2.js');
const valueAdd = require('../../server/ai/proposalBriefValueAdd.js');
const { deriveFeatures } = require('../../server/ai/features/deriveFeatures.js');
const { AiAssessmentCache } = require('../../server/ai/cache/aiAssessmentCache.js');

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

test.each([
  ['honest blocker', {}, true],
  ['completed research', {
    status: 'complete',
    documentedQueries: [{ query: 'Bonn Hauptbahnhof', source: 'Bonn RIS' }],
    evidenceRefs: ['https://example.test/proceeding'],
  }, false],
  ['completed source status', { sourceStatus: 'complete' }, false],
  ['unsupported reference', { evidenceRefs: ['https://example.test/proceeding'] }, false],
  ['unsupported query', { documentedQueries: [{ query: 'Bonn Hauptbahnhof', source: 'Bonn RIS' }] }, false],
])('Bonn Hbf Golden checks the political record for %s', (_name, research, expected) => {
  const proposal = completeValueAddProposal();
  proposal.politicalResearchLog = {
    status: 'blocked',
    sourceStatus: 'not-searched',
    documentedQueries: [],
    evidenceRefs: [],
    comparisonToExistingActivity: 'Die politische Vorbefassung muss noch geprüft werden.',
    remainingChecks: ['Das zuständige Ratsinformationssystem prüfen.'],
    ...research,
  };
  proposal.filingReadinessVerdict = {
    status: 'blocked',
    analysisQaStatus: 'blocked',
    politicalResearchStatus: proposal.politicalResearchLog.status,
    reasoning: 'Die Kartenevidenz fehlt.',
    blockingReasons: ['Vier Kartenmodi sind noch nicht geprüft.'],
  };

  const canonical = JSON.stringify(proposal, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  }, 2) + '\n';
  const binding = Object.fromEntries(['inputSha256', 'promptSha256', 'schemaSha256', 'rubricSha256']
    .map(key => [key, 'a'.repeat(64)]));
  Object.assign(binding, {requestedProvider:'gemini', requestedModel:'test-model', promptVersion:'test-prompt-v1'});
  const receipt = {
    ...binding,
    provider: 'gemini',
    model: 'test-model',
    modelVersion: 'test-version',
    executedAt: '2026-11-13T00:00:00Z',
    responseSha256: createHash('sha256').update(canonical).digest('hex'),
  };

  expect(reviewModelResponse(proposal, receipt, binding)).toMatchObject({
    providerReceiptVerified: true,
    schemaValidation: { valid: true },
    rubric: { valid: true },
    blockerCasePassed: expected,
  });
});

const snapshotUrl = 'https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=456';
const snapshotHash = 'b'.repeat(64);
const generatedAt = '2026-10-29T09:00:00Z';
const searchedAt = '2026-11-07T12:00:00Z';

function snapshotStructured() {
  const structured = structuredFixture('incomplete');
  const selection = {
    title: 'Prüfauftrag zur Adenauerallee', type: 'Antrag', date: '2026-05-08',
    gremium: 'Verkehrsausschuss', number: '26-0123', url: snapshotUrl, source: 'bonn-allris',
    snapshot: { city: 'bonn', sha256: snapshotHash, generatedAt,
      complete: false, stale: true, warnings: ['Warnung zur ausgewählten Quelle.'] },
  };
  structured.politicalReferences = [selection];
  structured.politicalContextResearch = {
    status: 'incomplete', city: 'Bonn', searchedAt, searchTerms: ['Adenauerallee'],
    officialPortalUrl: 'https://www.bonn.sitzung-online.de/public/',
    details: {
      city: 'Bonn', sourceType: 'ris-snapshot', sourceFingerprint: snapshotHash,
      sourceUrl: 'https://www.bonn.sitzung-online.de/oparl/system',
      generatedAt, searchedAt, searchStatus: 'partial-results', stale: true,
      coverage: { from: '2025-01-01', to: '2026-10-29', complete: false,
        bodies: ['Verkehrsausschuss'], warnings: ['Räumlich begrenzt.'] },
      warnings: ['Begrenzter Datenstand.'],
      refreshFailure: { attemptedAt: '2026-11-06T09:00:00Z', expiresAt: '2026-11-10T09:00:00Z',
        reason: 'Letzte Aktualisierung fehlgeschlagen.' },
    },
    selectedReferences: [selection],
  };
  // The browser supplies a prebuilt digest that omits snapshot metadata on its references.
  const { snapshot, ...referenceWithoutSnapshot } = selection;
  structured.deterministicAnalysisDigest = {
    schemaVersion: valueAdd.DETERMINISTIC_DIGEST_VERSION,
    officialAccidentFacts: { total: 37, fatal: 0, serious: 1, slight: 36 },
    politicalResearch: { status: 'incomplete', references: [referenceWithoutSnapshot] },
  };
  structured.aiAnalysisComparisonContract = {
    schemaVersion: valueAdd.AI_COMPARISON_CONTRACT_VERSION,
    deterministicDigest: structured.deterministicAnalysisDigest,
  };
  return structured;
}

async function runWithStubProvider(structured, proposal) {
  const originalKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'local-stub';
  try {
    const providerCall = jest.fn(async () => JSON.stringify(proposal));
    const output = await service.runAssessmentV2({ structured, providerCall,
      cache: new AiAssessmentCache(), mode: 'proposal-brief', withFallback: false });
    return { output, prompt: providerCall.mock.calls[0][0].user };
  } finally {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = originalKey;
  }
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

  test('retains snapshot provenance in the AI input separately from the prebuilt baseline evidence', () => {
    const structured = snapshotStructured();
    const input = service.buildAiInputV2(structured, deriveFeatures(structured), []);
    expect(input.risSnapshotContext).toMatchObject({
      search: {
        sourceType: 'ris-snapshot', sourceFingerprint: snapshotHash,
        sourceUrl: 'https://www.bonn.sitzung-online.de/oparl/system', generatedAt, searchedAt,
        status: 'incomplete', searchStatus: 'partial-results', stale: true,
        coverage: { from: '2025-01-01', complete: false, warnings: ['Räumlich begrenzt.'] },
        warnings: ['Begrenzter Datenstand.'], searchTerms: ['Adenauerallee'],
        refreshFailure: { attemptedAt: '2026-11-06T09:00:00Z', reason: 'Letzte Aktualisierung fehlgeschlagen.' },
      },
      selectedReferences: [{ url: snapshotUrl, number: '26-0123', date: '2026-05-08', snapshot: {
        sha256: snapshotHash, generatedAt, complete: false, stale: true,
        warnings: ['Warnung zur ausgewählten Quelle.'],
      } }],
    });
    expect(input.deterministicAnalysisDigest.politicalResearch)
      .toMatchObject({ status: 'incomplete', queries: [], references: [] });
    expect(input.aiAnalysisComparisonContract.deterministicDigest.politicalResearch.references).toEqual([]);
  });

  test('bounds the snapshot selection and warning text sent to the AI provider', () => {
    const structured = snapshotStructured();
    const warning = 'Hinweis: ' + 'A'.repeat(300);
    const warnings = [warning, ...Array.from({ length: 7 }, (_, index) => `Zusatz ${index}`)];
    const [reference] = structured.politicalReferences;
    structured.politicalReferences = Array.from({ length: 12 }, (_, index) => ({
      ...reference, url: `https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=${500 + index}`,
      snapshot: { ...reference.snapshot, warnings },
    }));
    structured.politicalContextResearch.details.warnings = warnings;

    const { risSnapshotContext } = service.buildAiInputV2(structured, deriveFeatures(structured), []);
    expect(risSnapshotContext.selectedReferences).toHaveLength(10);
    expect(risSnapshotContext.omittedReferenceCount).toBe(2);
    for (const included of [risSnapshotContext.search.warnings, risSnapshotContext.selectedReferences[0].snapshot.warnings]) {
      expect(included).toHaveLength(5);
      expect(included[0]).toBe(warning.slice(0, 240));
    }
  });

  test('the proposal provider receives the snapshot warnings and cannot mark snapshot-only evidence ready', async () => {
    const proposal = completeValueAddProposal();
    proposal.politicalResearchLog.evidenceRefs = [snapshotUrl];
    const { output, prompt } = await runWithStubProvider(snapshotStructured(), proposal);

    expect(prompt).toMatch(/manuell.*prüf/i);
    for (const value of [snapshotUrl, snapshotHash, generatedAt, searchedAt, 'partial-results',
      'Adenauerallee', 'Begrenzter Datenstand.', 'Warnung zur ausgewählten Quelle.',
      'Letzte Aktualisierung fehlgeschlagen.']) expect(prompt).toContain(value);
    expect(output.source).toBe('ai');
    expect(output.result.politicalResearchLog)
      .toMatchObject({ status: 'blocked', sourceStatus: 'incomplete', evidenceRefs: [] });
    expect(output.result.filingReadinessVerdict)
      .toMatchObject({ status: 'blocked', politicalResearchStatus: 'blocked' });
  });

  test('a separate live search can still satisfy the unchanged political gate when the model uses its evidence', async () => {
    const structured = snapshotStructured();
    const live = structuredFixture();
    structured.politicalContextResearch = {
      status: 'results-found', city: 'Bonn', providerKey: 'bonn-allris',
      searchTerms: ['Adenauerallee'], references: live.politicalReferences,
    };
    const proposal = completeValueAddProposal();
    proposal.politicalResearchLog.evidenceRefs.push(snapshotUrl);
    const { output, prompt } = await runWithStubProvider(structured, proposal);

    expect(prompt).toContain(snapshotUrl);
    expect(output.result.politicalResearchLog.evidenceRefs)
      .toEqual(['https://www.bonn.sitzung-online.de/public/vo020?VOLFDNR=123']);
    expect(output.result.filingReadinessVerdict.status).toBe('ready');
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

test('review of researched Hbf evidence requires the bound sources and search trace, with open map review', () => {
  const evidence = require('../fixtures/bonn-hbf-political-research.json');
  const proposal = completeValueAddProposal();
  const log = proposal.politicalResearchLog;
  Object.assign(log, { status: 'complete', sourceStatus: 'results-found', documentedQueries: evidence.queries,
    evidenceRefs: evidence.references.map(ref => ref.url) });
  Object.assign(proposal.filingReadinessVerdict, { status: 'blocked', politicalResearchStatus: 'complete' });
  const binding = Object.fromEntries(['inputSha256', 'promptSha256', 'schemaSha256', 'rubricSha256']
    .map(key => [key, 'a'.repeat(64)]));
  Object.assign(binding, {requestedProvider:'gemini', requestedModel:'unit-fixture', promptVersion:'test-prompt-v1'});
  const review = (candidateBinding = binding) => {
    const canonical = JSON.stringify(proposal, (_key, value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    }, 2) + '\n';
    return reviewModelResponse(proposal, { ...binding, provider: 'gemini', model: 'unit-fixture',
      modelVersion: 'unit-fixture-v1', executedAt: '2026-11-13T08:00:00Z',
      responseSha256: createHash('sha256').update(canonical).digest('hex') }, candidateBinding, evidence);
  };
  expect(review()).toMatchObject({ councilEvidenceCasePassed: true, status: 'blocked', rubric: { valid: true } });
  proposal.filingReadinessVerdict.status = 'ready';
  expect(review().councilEvidenceCasePassed).toBe(false);
  const positiveBinding = { ...binding, localEvidenceGate: { passed: true, analysisQaStatus: 'ready',
    politicalResearchStatus: 'complete', filingReadinessStatus: 'ready' },
    candidateCohorts: { discovery: 37, completeArea: 312, reference: 1926 } };
  expect(review(positiveBinding).positiveDraftCandidate).toBe(false);
  proposal.sachverhalt = '37 ausgewählte Rad-Pkw-Unfälle unter 312 Gebietsunfällen, die Vergleichsgruppe umfasst 1.926 Fälle.';
  proposal.evidenceCohortCounts = {discovery:312, completeArea:37, reference:1926};
  expect(review(positiveBinding).positiveDraftCandidate).toBe(false);
  proposal.evidenceCohortCounts = {discovery:37, completeArea:312, reference:1926};
  expect(review(positiveBinding)).toMatchObject({councilEvidenceCasePassed: true, positiveDraftCandidate: true,
    independentReview: 'pending', status: 'blocked'});
  expect(review({...positiveBinding, localEvidenceGate: {...positiveBinding.localEvidenceGate, passed: false}})
    .positiveDraftCandidate).toBe(false);
  proposal.filingReadinessVerdict.status = 'blocked';
  expect(review(positiveBinding).positiveDraftCandidate).toBe(false);
  log.evidenceRefs = [...log.evidenceRefs, 'https://example.invalid/invented'];
  expect(review().councilEvidenceCasePassed).toBe(false);
  log.evidenceRefs = evidence.references.slice(1).map(ref => ref.url);
  expect(review().councilEvidenceCasePassed).toBe(false);
  log.evidenceRefs = evidence.references.map(ref => ref.url);
  log.documentedQueries = [{ ...evidence.queries[0], query: 'Andere Abfrage' }];
  expect(review().councilEvidenceCasePassed).toBe(false);
});
