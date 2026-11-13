'use strict';

/**
 * Server-side comparison and value-add contract for proposalBrief.v1.
 *
 * The browser workflow already asks an external model to compare its answer
 * against the deterministic analysis. This module makes the same contract a
 * fail-closed part of the Docker/server path. Missing or weak model output is
 * retained for inspection, but it can never be marked application-ready.
 */

const { PATTERN_COMPARISON_LIMITATIONS } = require('./features/deriveFeatures.js');
const { patternReferenceMethodology } = require('../../js/ua.stats.js');

const VALUE_ADD_CONTRACT_VERSION = 'unfallwerkbank.proposalBriefValueAdd.v1';
const DETERMINISTIC_DIGEST_VERSION = 'unfallwerkbank.deterministicAnalysisDigest.v1';
const AI_COMPARISON_CONTRACT_VERSION = 'unfallwerkbank.aiAnalysisComparisonContract.v1';

const DELTA_KEYS = Object.freeze(['bestaetigt', 'praezisiert', 'ergaenzt', 'verworfen', 'offen']);
const READINESS = new Set(['ready', 'conditional', 'blocked']);
const POLITICAL = new Set(['complete', 'conditional', 'blocked']);
const RIS_REFERENCE_LIMIT = 10;

const clean = value => String(value == null ? '' : value).trim();
const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const unique = values => [...new Set(list(values).map(clean).filter(Boolean))];

function normalizeResearchQuery(value, index) {
  if (typeof value === 'string') {
    return {
      query: clean(value),
      source: 'political-context-research',
      sourceType: 'unspecified',
      url: '',
    };
  }
  const query = object(value);
  return {
    query: clean(query.query || query.term || query.searchTerm || query.label)
      || `Dokumentierte Recherche ${index + 1}`,
    source: clean(query.source || query.portal || query.provider || query.providerKey)
      || 'political-context-research',
    sourceType: clean(query.sourceType || query.type) || 'unspecified',
    url: clean(query.url || query.sourceUrl || query.portalUrl),
  };
}

function normalizeResearchQueries(values) {
  return list(values).map(normalizeResearchQuery).filter(query => query.query);
}

function httpUrl(value) {
  try {
    const url = new URL(clean(value));
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) {
    return '';
  }
}

function referenceUrl(reference) {
  return httpUrl(reference?.url || reference?.sourceUrl);
}

function snapshotSearchDetails(research) {
  const details = object(research.details);
  if (details.sourceType !== 'ris-snapshot' && research.sourceType !== 'ris-snapshot') return null;
  return { ...research, ...details };
}

function snapshotResearchStatus(research) {
  return research.searchStatus === 'failed' || research.status === 'failed' ? 'failed' : 'incomplete';
}

const snapshotText = value => typeof value === 'string' ? value.trim().slice(0, 240) : '';
const snapshotList = (values, limit = 5) => unique(list(values).map(snapshotText)).slice(0, limit);
const snapshotFlag = value => typeof value === 'boolean' ? value : null;
const snapshotUrl = value => {
  const url = httpUrl(value);
  return url.length <= 1024 ? url : '';
};

function buildRisSnapshotContext(structured) {
  const research = object(structured?.politicalContextResearch);
  const details = snapshotSearchDetails(research);
  // An explicit empty selection must not resurrect references from older research state.
  const selected = (Array.isArray(structured?.politicalReferences)
    ? structured.politicalReferences : list(research.selectedReferences))
    .filter(reference => Object.keys(object(reference?.snapshot)).length);
  if (!details && !selected.length) return null;

  const selectedReferences = [];
  for (const reference of selected) {
    if (selectedReferences.length >= RIS_REFERENCE_LIMIT) break;
    const { snapshot } = reference;
    const url = snapshotUrl(reference.url || reference.sourceUrl);
    const title = snapshotText(reference.title);
    if (!url || !title) continue;
    selectedReferences.push({
      title, type: snapshotText(reference.type), date: snapshotText(reference.date),
      gremium: snapshotText(reference.gremium), number: snapshotText(reference.number),
      source: snapshotText(reference.source), url,
      snapshot: {
        city: snapshotText(snapshot.city), sha256: snapshotText(snapshot.sha256), generatedAt: snapshotText(snapshot.generatedAt),
        complete: snapshot.complete === true, stale: snapshotFlag(snapshot.stale), warnings: snapshotList(snapshot.warnings),
      },
    });
  }
  const omittedReferenceCount = selected.length - selectedReferences.length;
  const context = { selectedReferences, ...(omittedReferenceCount ? { omittedReferenceCount } : {}) };
  if (!details) return context;

  const coverage = object(details.coverage);
  const failure = object(details.refreshFailure);
  return {
    search: {
      status: snapshotResearchStatus(details), searchStatus: snapshotText(details.searchStatus), city: snapshotText(details.city),
      sourceType: 'ris-snapshot', sourceUrl: snapshotUrl(details.sourceUrl), sourceFingerprint: snapshotText(details.sourceFingerprint),
      generatedAt: snapshotText(details.generatedAt), searchedAt: snapshotText(details.searchedAt),
      stale: snapshotFlag(details.stale),
      searchTerms: snapshotList(details.searchTerms || research.searchTerms, 12), warnings: snapshotList(details.warnings),
      officialPortalUrl: snapshotUrl(research.officialPortalUrl),
      ...(Object.keys(coverage).length ? { coverage: {
        from: snapshotText(coverage.from), to: snapshotText(coverage.to), complete: coverage.complete === true,
        bodies: snapshotList(coverage.bodies, 10), warnings: snapshotList(coverage.warnings),
      } } : {}),
      ...(Object.keys(failure).length ? { refreshFailure: {
        attemptedAt: snapshotText(failure.attemptedAt), expiresAt: snapshotText(failure.expiresAt), reason: snapshotText(failure.reason),
      } } : {}),
    },
    ...context,
  };
}

function snapshotAwarePoliticalResearch(structured, features, existing) {
  const research = object(structured?.politicalContextResearch);
  const snapshotSearch = snapshotSearchDetails(research);
  const manualUrls = new Set([...list(structured?.politicalReferences), ...list(research.selectedReferences)]
    .filter(reference => reference?.snapshot).map(referenceUrl).filter(Boolean));
  const separateSearch = !snapshotSearch && ['complete', 'results-found'].includes(research.status);
  const liveReferences = separateSearch && manualUrls.size ? list(research.references).filter(reference =>
    !reference?.snapshot && referenceUrl(reference) && clean(reference?.title)
    && reference?.aiGating?.allowed !== false && reference?.trafficCategory !== 'non_traffic'
    && reference?.isTrafficRelevant !== false
  ) : [];
  const direct = structured?.politicalReferences ?? existing?.references ?? features?.references;
  const withoutSnapshot = list(direct).filter(reference => !reference?.snapshot && !manualUrls.has(referenceUrl(reference)));
  const directUrls = new Set(withoutSnapshot.map(referenceUrl));
  const references = [...withoutSnapshot, ...liveReferences.filter(reference => !directUrls.has(referenceUrl(reference)))];
  return {
    status: snapshotSearch ? snapshotResearchStatus(snapshotSearch) : research.status || existing?.status || 'not-searched',
    queries: snapshotSearch ? [] : normalizeResearchQueries(research.queries || existing?.queries),
    references: references.map(reference => ({
      title: clean(reference?.title),
      type: clean(reference?.type || reference?.referenceType) || 'unknown',
      date: reference?.date || null,
      gremium: reference?.gremium || null,
      number: reference?.number || null,
      url: clean(reference?.url || reference?.sourceUrl),
      source: reference?.source || null,
      ...(reference?.snippet ? { snippet: snapshotText(reference.snippet) } : {}),
    })).filter(reference => reference.title || reference.url),
  };
}

function patternRow(row, localTotal, baselineTotal, reference) {
  const significant = row?.isSignificant === true;
  return {
    mask: finite(row?.mask),
    label: clean(row?.textLabel || row?.label) || null,
    locCnt: finite(row?.locCnt ?? row?.localCnt ?? row?.localCount),
    baseCnt: finite(row?.baseCnt ?? row?.baselineCnt ?? row?.baselineCount),
    localTotal: finite(localTotal),
    baselineTotal: finite(baselineTotal),
    locR: finite(row?.locR ?? row?.localShare),
    baseR: finite(row?.baseR ?? row?.baselineShare),
    factor: finite(row?.factor),
    ciLow: finite(row?.ciLow),
    ciHigh: finite(row?.ciHigh),
    ...(reference ? { difference: finite(row?.difference), differenceCiLow: finite(row?.differenceCiLow),
      differenceCiHigh: finite(row?.differenceCiHigh) } : {}),
    isSignificant: significant,
    interpretation: significant
      ? (reference ? 'unadjusted-exploratory-overrepresentation' : 'statistically-supported-pattern-overrepresentation')
      : 'exploratory-pattern-difference',
  };
}

function buildDeterministicDigest(structured, features) {
  const selectedSiteMotion = structured?.motion?.discoveryEvidence || structured?.motion?.priorWork?.length ? structured.motion : null;
  const deviations = object(structured?.deviations);
  const reference = patternReferenceMethodology(deviations);
  let existing = object(
    structured?.deterministicAnalysisDigest
    || structured?.aiResearchHandoff?.deterministicAnalysisDigest
  );
  if (existing.schemaVersion === DETERMINISTIC_DIGEST_VERSION && (!reference ||
      (existing.patternCompositionComparison?.reference?.method === deviations.reference.method &&
       existing.patternCompositionComparison.reference.status === deviations.reference.status))) {
    if (selectedSiteMotion && existing.selectedSiteMotion !== selectedSiteMotion) existing = { ...existing, selectedSiteMotion };
    const research = object(structured?.politicalContextResearch);
    const documentedSearch = ['complete', 'results-found'].includes(research.status) && list(research.queries).length;
    const changedStatus = research.status && research.status !== existing.politicalResearch?.status;
    if (!documentedSearch && !changedStatus && !snapshotSearchDetails(research)
      && ![...list(structured?.politicalReferences), ...list(research.selectedReferences)]
        .some(reference => reference?.snapshot)) return existing;
    return { ...existing, politicalResearch: snapshotAwarePoliticalResearch(structured, features, existing.politicalResearch) };
  }

  const meta = object(structured?.meta);
  const severity = object(structured?.severity);
  const bySeverity = object(severity.bySev);
  const localTotal = deviations?.local?.total;
  const baselineTotal = deviations?.baseline?.total;
  const counts = object(features?.counts);
  const yearlyTrend = structured?.yearlyTrend || features?.yearlyTrend || null;
  return {
    schemaVersion: DETERMINISTIC_DIGEST_VERSION,
    role: 'verified-reproducible-baseline',
    ...(selectedSiteMotion ? { selectedSiteMotion } : {}),
    meta: {
      city: meta.city || meta.cityRaw || null,
      areaName: meta.areaName || null,
      areaNameQuality: meta.areaNameQuality || null,
      date: meta.date || null,
      link: meta.link || null,
      filters: meta.filters || null,
      involvementMode: meta.involvementMode || null,
    },
    officialAccidentFacts: {
      total: finite(severity.total ?? counts.total),
      fatal: finite(bySeverity['1'] ?? counts.fatal),
      serious: finite(bySeverity['2'] ?? counts.serious),
      slight: finite(bySeverity['3'] ?? counts.slight),
      other: finite(bySeverity.other ?? counts.other),
    },
    patternCompositionComparison: {
      method: reference ? Object.values(reference.formulas).join('; ')
        : 'locR=locCnt/local.total; baseR=baseCnt/baseline.total; factor=locR/baseR; isSignificant iff Wilson-95%-CI lower bound exceeds baseR',
      ...(reference ? { reference: deviations.reference } : {}),
      localSampleSize: finite(localTotal),
      baselineSampleSize: finite(baselineTotal),
      focus: list(deviations.focus).map(row => patternRow(row, localTotal, baselineTotal, reference)),
      allRows: list(deviations.rows).map(row => patternRow(row, localTotal, baselineTotal, reference)),
      scopeNote: 'Compares accident-pattern composition, not an absolute accident rate per area, road length or traffic exposure. '
        + (reference?.limitations.note || PATTERN_COMPARISON_LIMITATIONS.note),
    },
    yearlyTrend,
    spatialEvidence: {
      accidentDetailTotal: finite(structured?.accidentDetails?.total),
      truncated: structured?.accidentDetails?.truncated === true,
      clusterMaps: structured?.clusterMaps || null,
      spatialArgumentation: structured?.spatialArgumentation || null,
    },
    contextEvidence: {
      poi: structured?.poi || features?.poiSummary || null,
      osm: structured?.osmContext || features?.osmContext || null,
      visual: structured?.visualContextHints || features?.visualContextHints || null,
    },
    politicalResearch: snapshotAwarePoliticalResearch(structured, features),
  };
}

function buildComparisonContract(structured, features, digest) {
  const existing = object(
    structured?.aiAnalysisComparisonContract
    || structured?.aiResearchHandoff?.aiAnalysisComparisonContract
  );
  if (existing.schemaVersion === AI_COMPARISON_CONTRACT_VERSION) {
    const original = structured?.deterministicAnalysisDigest || structured?.aiResearchHandoff?.deterministicAnalysisDigest;
    return original?.schemaVersion === DETERMINISTIC_DIGEST_VERSION && original !== digest
      ? { ...existing, deterministicDigest: digest } : existing;
  }

  return {
    schemaVersion: AI_COMPARISON_CONTRACT_VERSION,
    purpose: 'Both analyses must be correct; AI must add traceable decision value rather than rewrite the baseline.',
    baselineAuthority: 'Preserve official facts and deterministic calculations unless reproducible recalculation proves a mismatch.',
    mandatoryComparisonColumns: [
      'deterministic finding',
      'AI verification',
      'AI-added synthesis/context',
      'evidence/source',
      'uncertainty/check',
    ],
    requiredAiAddedValue: [
      { id: 'cross-layer-synthesis', requirement: 'At least three insights combining at least two evidence layers.' },
      { id: 'prioritisation', requirement: 'Rank decision-relevant findings and explain urgency.' },
      { id: 'competing-explanations', requirement: 'Name alternatives and discriminating checks for causal claims.' },
      { id: 'political-administrative-fit', requirement: 'Research motions, decisions, responses, projects and implementation windows.' },
      { id: 'measure-decision-matrix', requirement: 'Link evidence, objective, prerequisites, trade-offs, responsibility, time and success indicators.' },
      { id: 'application-improvement-delta', requirement: 'List confirmed, clarified, added, rejected and unresolved content.' },
    ],
    prohibitedShortcuts: [
      'Merely rewriting or paraphrasing tables.',
      'Treating pattern composition as an absolute accident-rate comparison.',
      'Calling non-significant differences statistically proven.',
      'Inventing crash causes or political proceedings.',
      'Returning generic measures without evidence and prerequisites.',
      'Treating failed or empty political search as no prior activity.',
    ],
    minimumOutput: {
      deterministicVsAiComparison: true,
      prioritisedFindings: 3,
      crossLayerInsights: 3,
      competingHypothesesPerCausalClaim: 1,
      measureDecisionMatrix: true,
      politicalResearchLog: true,
      explicitAiDelta: true,
      filingReadinessVerdict: true,
    },
    acceptanceRubric: {
      methodologicalCorrectness: 30,
      preservationOfOfficialEvidence: 15,
      additionalSynthesis: 15,
      politicalAndAdministrativeContext: 15,
      measureSpecificityAndTradeoffs: 15,
      sourceTraceability: 10,
      passScore: 80,
      automaticFailure: [
        'methodology misrepresented',
        'official facts altered without reproducible evidence',
        'no substantive added value beyond paraphrase',
        'invented source',
      ],
    },
    deterministicDigest: digest,
  };
}

function buildProposalEvidenceContracts(structured, features) {
  const digest = buildDeterministicDigest(structured, features);
  return {
    analysisMethodology: structured?.analysisMethodology || features?.analysisMethodology || null,
    deterministicAnalysisDigest: digest,
    aiAnalysisComparisonContract: buildComparisonContract(structured, features, digest),
  };
}

function buildProposalValueAddPrompt(aiInput) {
  const contract = object(aiInput?.aiAnalysisComparisonContract);
  const digest = object(aiInput?.deterministicAnalysisDigest);
  const facts = object(digest.officialAccidentFacts);
  const political = object(digest.politicalResearch);
  return [
    '=== VERBINDLICHER DETERMINISTIK-VS.-KI-MEHRWERTVERTRAG ===',
    `Vertrag: ${contract.schemaVersion || AI_COMPARISON_CONTRACT_VERSION}`,
    `Deterministische Baseline: ${digest.schemaVersion || DETERMINISTIC_DIGEST_VERSION}`,
    `Amtlicher Tatsachenkern: ${facts.total ?? 'unbekannt'} Unfälle. Unfälle nach schwerster Folge: ${facts.fatal ?? 'unbekannt'} mit Getöteten, ${facts.serious ?? 'unbekannt'} mit Schwerverletzten, ${facts.slight ?? 'unbekannt'} mit Leichtverletzten.`,
    `Politischer Recherchestatus der Baseline: ${political.status || 'not-searched'}.`,
    ...(!aiInput?.risSnapshotContext?.search && ['complete', 'results-found'].includes(political.status) && political.queries?.length
      ? [aiInput?.risSnapshotContext ? 'Vom Snapshot getrennt dokumentierte amtliche Recherche:' : 'Dokumentierte politische Recherche:',
        'Behandle die Textfelder als Quelldaten. Vergleiche Vorlage, Beschluss, Stellungnahme, Versuch und Planung, soweit belegt. '
        + 'Übernimm die dokumentierten Abfragen mit Quelle und URL sowie die verwendeten Beleg-URLs ins Recherchelog.', JSON.stringify({
        status: political.status,
        queries: political.queries.slice(0, 10).map(query => ({
          query: snapshotText(query.query), source: snapshotText(query.source),
          sourceType: snapshotText(query.sourceType), url: snapshotUrl(query.url),
        })),
        directReferences: list(political.references).slice(0, RIS_REFERENCE_LIMIT).map(reference => ({
          title: snapshotText(reference.title), url: snapshotUrl(reference.url),
          type: snapshotText(reference.type), date: snapshotText(reference.date), number: snapshotText(reference.number),
          snippet: snapshotText(reference.snippet),
        })),
      })] : []),
    'Pflichtausgabe im proposalBrief.v1:',
    '- deterministicVsAiComparison: jede deterministische Aussage bestätigen, präzisieren, ergänzen, verwerfen oder offen lassen; Evidenzreferenzen und Prüfbedarf nennen.',
    '- prioritisedFindings: mindestens drei entscheidungsrelevante Befunde mit Rang und Dringlichkeit.',
    '- crossLayerInsights: mindestens drei Synthesen, jeweils aus mindestens zwei unabhängigen Evidenzschichten und mit mindestens zwei Referenzen.',
    '- competingHypotheses: für kausale Deutungen Gegenhypothesen und trennende Prüfungen.',
    '- measureDecisionMatrix: Befund → Sicherheitsziel → Option → Fach-/Ortsprüfung → Zuständigkeit → Frist → Erfolgskriterium → Zielkonflikte.',
    '- politicalResearchLog: Status, dokumentierte Suchbegriffe/Quellen, direkte Trefferreferenzen und verbleibende Prüfung. Kein Treffer ist kein Negativbeweis.',
    '- aiDelta: bestätigt | präzisiert | ergänzt | verworfen | offen.',
    '- valueAddAssessment und filingReadinessVerdict: ohne substanziellen Mehrwert, belastbare politische Recherche und vollständige Evidenz niemals ready.',
    'Bloße Paraphrase, erfundene Quellen, methodische Fehlinterpretation oder unbelegte konkrete Umsetzung sind automatische Sperrgründe.',
  ].join('\n');
}

function defaultComparisonRows(aiInput) {
  const digest = object(aiInput?.deterministicAnalysisDigest);
  const facts = object(digest.officialAccidentFacts);
  const rows = [];
  if (facts.total !== null && facts.total !== undefined) {
    rows.push({
      deterministicFinding: `Amtlich dokumentierte Unfälle im Untersuchungsbereich: ${facts.total}.`,
      deltaStatus: 'offen',
      aiVerification: 'Keine KI-Bewertung verfügbar; deterministischer Fallback.',
      aiAddedValue: 'Kein zusätzlicher Entscheidungswert erzeugt.',
      evidenceRefs: ['severity.bySev'],
      uncertaintyOrCheck: 'Unfallhergänge, Geometrie und Konfliktmechanismen fachlich und vor Ort prüfen.',
    });
  }
  const focus = list(digest?.patternCompositionComparison?.focus);
  focus.slice(0, 3).forEach((row, index) => {
    rows.push({
      deterministicFinding: `${row.label || `Beteiligungsmuster ${index + 1}`}: Faktor ${row.factor ?? 'unbekannt'}; ${row.isSignificant ? 'explorativer Hinweis nach unbereinigter Einzelregel' : 'explorativ'}.`,
      deltaStatus: 'offen',
      aiVerification: 'Keine KI-Bewertung verfügbar; deterministischer Fallback.',
      aiAddedValue: 'Kein zusätzlicher Entscheidungswert erzeugt.',
      evidenceRefs: [`deviations.focus[${index}]`],
      uncertaintyOrCheck: row.isSignificant
        ? 'Die Mustersuche ist explorativ und ohne Mehrfachtestkorrektur. Räumliche Lage und Konfliktmechanismus gesondert prüfen.'
        : 'Nicht als statistisch gesicherten oder räumlichen Schwerpunkt formulieren.',
    });
  });
  return rows;
}

function defaultMeasureDecisionMatrix(aiInput) {
  return list(aiInput?.preselectedMeasures).slice(0, 5).map((measure, index) => ({
    rank: index + 1,
    finding: clean(measure.reasonForPreselection) || 'Katalogbasierte Vorauswahl; lokale Passung ist noch zu prüfen.',
    safetyObjective: clean(measure.title) || 'Verkehrssicherheit verbessern',
    option: clean(measure.title) || clean(measure.id) || 'Prüfoption',
    requiredVerification: unique([
      ...list(measure.cautions),
      'Reale Ortsbegehung und fachliche Prüfung der Geometrie sowie des Konfliktmechanismus',
    ]),
    responsibility: 'Zuständige Straßenverkehrs-/Tiefbauverwaltung und Unfallkommission; konkret festzulegen.',
    deadline: 'Prüf- und Berichtstermin durch das zuständige Gremium festzulegen.',
    successCriteria: ['Messbarer Rückgang relevanter Konflikte; Indikator und Ausgangswert vor Umsetzung festlegen.'],
    tradeoffs: list(measure.cautions),
    evidenceRefs: unique([
      ...list(measure.matchedRiskFactors),
      ...list(measure.matchedConflictPatterns),
      clean(measure.id),
    ]),
  }));
}

function buildBlockedFallbackContract(aiInput, reason) {
  const politicalStatus = clean(aiInput?.deterministicAnalysisDigest?.politicalResearch?.status).toLowerCase();
  const blockingReasons = unique([
    'Keine schema- und rubrikkonforme KI-Mehrwertanalyse verfügbar.',
    'Mindestens drei quellengebundene Mehrschicht-Synthesen fehlen.',
    politicalStatus === 'complete' || politicalStatus === 'results-found'
      ? ''
      : 'Politische/administrative Vorbefassung ist nicht belastbar abgeschlossen.',
    reason ? `Technischer Grund: ${reason}` : '',
  ]);
  return {
    valueAddContractVersion: VALUE_ADD_CONTRACT_VERSION,
    deterministicVsAiComparison: defaultComparisonRows(aiInput),
    prioritisedFindings: [],
    crossLayerInsights: [],
    competingHypotheses: [],
    measureDecisionMatrix: defaultMeasureDecisionMatrix(aiInput),
    politicalResearchLog: {
      status: politicalStatus === 'complete' || politicalStatus === 'results-found'
        ? 'complete'
        : (politicalStatus === 'searched-no-results' || politicalStatus === 'results-found-unusable'
          ? 'conditional' : 'blocked'),
      sourceStatus: politicalStatus || 'not-searched',
      documentedQueries: normalizeResearchQueries(
        aiInput?.deterministicAnalysisDigest?.politicalResearch?.queries
      ),
      evidenceRefs: list(aiInput?.deterministicAnalysisDigest?.politicalResearch?.references)
        .map(reference => clean(reference?.url || reference?.title)).filter(Boolean),
      comparisonToExistingActivity: 'Ohne KI-Mehrwertanalyse nicht belastbar gegenübergestellt.',
      remainingChecks: ['Amtliches RIS/OParl beziehungsweise zuständiges Portal nachvollziehbar prüfen.'],
    },
    aiDelta: {
      bestaetigt: [],
      praezisiert: [],
      ergaenzt: [],
      verworfen: [],
      offen: ['Keine KI-Mehrwertanalyse verfügbar; nur deterministische Baseline ausgegeben.'],
    },
    valueAddAssessment: {
      status: 'failed',
      score: 0,
      automaticFailureReasons: blockingReasons,
    },
    filingReadinessVerdict: {
      status: 'blocked',
      analysisQaStatus: 'conditional',
      politicalResearchStatus: politicalStatus === 'complete' || politicalStatus === 'results-found'
        ? 'complete'
        : (politicalStatus === 'searched-no-results' || politicalStatus === 'results-found-unusable'
          ? 'conditional' : 'blocked'),
      reasoning: 'Deterministischer Fallback ist prüfbares Arbeitsmaterial, aber keine einreichungsreife KI-Antragsschrift.',
      blockingReasons,
    },
  };
}

function evaluateProposalValueAdd(proposal) {
  const errors = [];
  const warnings = [];
  const comparisons = list(proposal?.deterministicVsAiComparison);
  const priorities = list(proposal?.prioritisedFindings);
  const insights = list(proposal?.crossLayerInsights);
  const hypotheses = list(proposal?.competingHypotheses);
  const matrix = list(proposal?.measureDecisionMatrix);
  const research = object(proposal?.politicalResearchLog);
  const delta = object(proposal?.aiDelta);
  const assessment = object(proposal?.valueAddAssessment);
  const verdict = object(proposal?.filingReadinessVerdict);

  if (proposal?.valueAddContractVersion !== VALUE_ADD_CONTRACT_VERSION) {
    errors.push('valueAddContractVersion fehlt oder ist unbekannt.');
  }
  if (!comparisons.length) errors.push('deterministicVsAiComparison enthält keinen Vergleich.');
  if (priorities.length < 3) errors.push('prioritisedFindings muss mindestens drei priorisierte Befunde enthalten.');
  if (insights.length < 3) errors.push('crossLayerInsights muss mindestens drei Synthesen enthalten.');
  insights.forEach((insight, index) => {
    if (unique(insight?.evidenceLayers).length < 2) {
      errors.push(`crossLayerInsights[${index}] verwendet weniger als zwei Evidenzschichten.`);
    }
    if (unique(insight?.evidenceRefs).length < 2) {
      errors.push(`crossLayerInsights[${index}] enthält weniger als zwei Evidenzreferenzen.`);
    }
  });
  if (!hypotheses.length) errors.push('competingHypotheses fehlt.');
  hypotheses.forEach((item, index) => {
    if (list(item?.hypotheses).length < 2) {
      errors.push(`competingHypotheses[${index}] benötigt mindestens zwei Erklärungen.`);
    }
    if (!list(item?.discriminatingChecks).length) {
      errors.push(`competingHypotheses[${index}] benötigt mindestens eine trennende Prüfung.`);
    }
  });
  if (!matrix.length) errors.push('measureDecisionMatrix enthält keine Maßnahme oder Prüfoption.');
  matrix.forEach((item, index) => {
    for (const key of ['finding', 'safetyObjective', 'option', 'responsibility', 'deadline']) {
      if (!clean(item?.[key])) errors.push(`measureDecisionMatrix[${index}].${key} fehlt.`);
    }
    if (!list(item?.requiredVerification).length) {
      errors.push(`measureDecisionMatrix[${index}].requiredVerification fehlt.`);
    }
    if (!list(item?.successCriteria).length) {
      errors.push(`measureDecisionMatrix[${index}].successCriteria fehlt.`);
    }
    if (!list(item?.evidenceRefs).length) {
      errors.push(`measureDecisionMatrix[${index}].evidenceRefs fehlt.`);
    }
  });
  if (!POLITICAL.has(clean(research.status).toLowerCase())) {
    errors.push('politicalResearchLog.status ist ungültig.');
  }
  if (!list(research.documentedQueries).length) {
    warnings.push('Politische Recherche enthält kein nachvollziehbares Suchprotokoll.');
  }
  const deltaCount = DELTA_KEYS.reduce((sum, key) => sum + list(delta[key]).length, 0);
  if (!deltaCount) errors.push('aiDelta enthält keine explizite Änderung gegenüber der Baseline.');
  if (!list(delta.praezisiert).length && !list(delta.ergaenzt).length) {
    errors.push('Kein substanzieller Mehrwert: weder präzisiert noch ergänzt.');
  }
  const assessmentStatus = clean(assessment.status).toLowerCase();
  const assessmentScore = finite(assessment.score);
  if (!['passed', 'failed'].includes(assessmentStatus)) {
    errors.push('valueAddAssessment.status ist ungültig.');
  }
  if (assessmentScore === null || !Number.isInteger(assessmentScore)
      || assessmentScore < 0 || assessmentScore > 100) {
    errors.push('valueAddAssessment.score muss eine ganze Zahl zwischen 0 und 100 sein.');
  }
  if (assessmentStatus === 'passed' && assessmentScore !== null && assessmentScore < 80) {
    errors.push('valueAddAssessment=passed erfordert mindestens 80 Punkte.');
  }
  if (!READINESS.has(clean(verdict.status).toLowerCase())) {
    errors.push('filingReadinessVerdict.status ist ungültig.');
  }
  const verdictStatus = clean(verdict.status).toLowerCase();
  const researchStatus = clean(research.status).toLowerCase();
  const verdictPoliticalStatus = clean(verdict.politicalResearchStatus).toLowerCase();
  const analysisQaStatus = clean(verdict.analysisQaStatus).toLowerCase();
  if (verdictPoliticalStatus && verdictPoliticalStatus !== researchStatus) {
    errors.push('filingReadinessVerdict.politicalResearchStatus widerspricht politicalResearchLog.status.');
  }
  if ((researchStatus === 'blocked' || analysisQaStatus === 'blocked')
      && verdictStatus !== 'blocked') {
    errors.push('Ein blockierter Teilstatus erfordert filingReadinessVerdict=blocked.');
  }
  if (verdictStatus === 'ready') {
    if (researchStatus !== 'complete') {
      errors.push('filingReadinessVerdict=ready erfordert politicalResearchLog.status=complete.');
    }
    if (assessmentStatus !== 'passed' || assessmentScore < 80) {
      errors.push('filingReadinessVerdict=ready erfordert einen bestandenen Mehrwertscore von mindestens 80.');
    }
    if (list(verdict.blockingReasons).length) {
      errors.push('filingReadinessVerdict=ready darf keine blockingReasons enthalten.');
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function mergeMissing(target, fallback, keys) {
  const out = { ...object(target) };
  for (const key of keys) {
    if (!(key in out)) out[key] = fallback[key];
  }
  return out;
}

function applyRisSnapshotReadiness(proposal, aiInput, blocked) {
  const snapshot = aiInput?.risSnapshotContext;
  if (!snapshot) return;

  const baseline = object(aiInput?.deterministicAnalysisDigest?.politicalResearch);
  const liveUrls = new Set(list(baseline.references).map(referenceUrl).filter(Boolean));
  const research = object(proposal.politicalResearchLog);
  const evidenceRefs = list(research.evidenceRefs).filter(url => liveUrls.has(httpUrl(url)));
  const separateSearch = !snapshot.search && ['complete', 'results-found'].includes(baseline.status)
    && list(baseline.queries).length > 0 && liveUrls.size > 0;
  if (separateSearch && (clean(research.status).toLowerCase() !== 'complete' || evidenceRefs.length)) {
    proposal.politicalResearchLog = { ...research, evidenceRefs };
    return;
  }

  // A model response cannot turn a published catalogue or a selected hint into a live search.
  const reason = 'Der veröffentlichte RIS-Datenstand und ausgewählte Hinweise ersetzen keine getrennt dokumentierte amtliche Recherche.';
  const verdict = object(proposal.filingReadinessVerdict);
  proposal.politicalResearchLog = {
    ...blocked.politicalResearchLog,
    status: 'blocked',
    evidenceRefs: [],
    comparisonToExistingActivity: 'Die politische/administrative Vorbefassung bleibt offen.',
    remainingChecks: unique([...blocked.politicalResearchLog.remainingChecks, ...list(research.remainingChecks)]),
  };
  proposal.filingReadinessVerdict = {
    ...blocked.filingReadinessVerdict,
    ...verdict,
    status: blocked.filingReadinessVerdict.status,
    politicalResearchStatus: 'blocked',
    reasoning: reason,
    blockingReasons: unique([...list(verdict.blockingReasons), reason]),
  };
}

function ensureProposalValueAdd(proposal, aiInput, reason) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  const blocked = buildBlockedFallbackContract(aiInput, reason);
  const out = mergeMissing(proposal, blocked, [
    'valueAddContractVersion',
    'deterministicVsAiComparison',
    'prioritisedFindings',
    'crossLayerInsights',
    'competingHypotheses',
    'measureDecisionMatrix',
    'politicalResearchLog',
    'aiDelta',
    'valueAddAssessment',
    'filingReadinessVerdict',
  ]);
  applyRisSnapshotReadiness(out, aiInput, blocked);

  const evaluation = evaluateProposalValueAdd(out);
  if (!evaluation.valid) {
    const existingAssessment = object(out.valueAddAssessment);
    const existingVerdict = object(out.filingReadinessVerdict);
    out.valueAddAssessment = {
      ...existingAssessment,
      status: 'failed',
      score: Number.isInteger(existingAssessment.score)
        ? Math.max(0, Math.min(existingAssessment.score, 79))
        : 0,
      automaticFailureReasons: unique([
        ...list(existingAssessment.automaticFailureReasons),
        ...evaluation.errors,
      ]),
    };
    out.filingReadinessVerdict = {
      ...existingVerdict,
      status: 'blocked',
      analysisQaStatus: READINESS.has(clean(existingVerdict.analysisQaStatus).toLowerCase())
        ? clean(existingVerdict.analysisQaStatus).toLowerCase()
        : 'conditional',
      politicalResearchStatus: POLITICAL.has(clean(existingVerdict.politicalResearchStatus).toLowerCase())
        ? clean(existingVerdict.politicalResearchStatus).toLowerCase()
        : clean(out.politicalResearchLog?.status).toLowerCase() || 'blocked',
      reasoning: clean(existingVerdict.reasoning)
        || 'Der serverseitige Mehrwertvertrag wurde nicht erfüllt.',
      blockingReasons: unique([
        ...list(existingVerdict.blockingReasons),
        ...evaluation.errors,
        ...evaluation.warnings,
      ]),
    };
  }
  return out;
}

module.exports = Object.freeze({
  VALUE_ADD_CONTRACT_VERSION,
  DETERMINISTIC_DIGEST_VERSION,
  AI_COMPARISON_CONTRACT_VERSION,
  buildRisSnapshotContext,
  DELTA_KEYS,
  buildDeterministicDigest,
  buildComparisonContract,
  buildProposalEvidenceContracts,
  buildProposalValueAddPrompt,
  buildBlockedFallbackContract,
  evaluateProposalValueAdd,
  ensureProposalValueAdd,
});
