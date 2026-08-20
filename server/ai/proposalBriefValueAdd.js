'use strict';

/**
 * Evidence hardening facade around the proposal value-add core.
 *
 * A model-provided political status is not evidence by itself. `complete`
 * requires a documented query and at least one direct HTTP(S) reference;
 * a no-result search may remain conditional only when its query/source is
 * reproducible. Missing evidence is preserved for inspection but can never
 * produce an application-ready proposal.
 */

const core = require('./proposalBriefValueAddCore.js');

const READINESS = new Set(['ready', 'conditional', 'blocked']);
const POLITICAL = new Set(['complete', 'conditional', 'blocked']);
const clean = value => String(value == null ? '' : value).trim();
const list = value => Array.isArray(value) ? value : [];
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const unique = values => [...new Set(list(values).map(clean).filter(Boolean))];

function absoluteHttpUrl(value) {
  const raw = clean(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function normalizeResearchQuery(value) {
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
    query: clean(query.query || query.term || query.searchTerm || query.label),
    source: clean(query.source || query.portal || query.provider || query.providerKey)
      || 'political-context-research',
    sourceType: clean(query.sourceType || query.type) || 'unspecified',
    url: absoluteHttpUrl(query.url || query.sourceUrl || query.portalUrl),
  };
}

function documentedPoliticalQueries(values) {
  return list(values).map(normalizeResearchQuery).filter(query => {
    const source = query.source.toLowerCase();
    const sourceType = query.sourceType.toLowerCase();
    const namedSource = source
      && source !== 'political-context-research'
      && source !== 'unspecified';
    const namedType = sourceType && sourceType !== 'unspecified';
    return Boolean(query.query && (namedSource || namedType || query.url));
  });
}

function politicalEvidence(researchValue) {
  const research = object(researchValue);
  const requestedStatus = clean(research.status).toLowerCase();
  const queries = documentedPoliticalQueries(research.documentedQueries);
  const references = list(research.evidenceRefs).map(absoluteHttpUrl).filter(Boolean);
  const complete = requestedStatus === 'complete'
    && queries.length > 0
    && references.length > 0;
  const conditional = requestedStatus === 'conditional' && queries.length > 0;
  return {
    requestedStatus,
    status: complete ? 'complete' : (conditional ? 'conditional' : 'blocked'),
    queries,
    references,
    complete,
  };
}

function politicalEvidenceErrors(proposal) {
  const research = object(proposal?.politicalResearchLog);
  const evidence = politicalEvidence(research);
  const errors = [];
  const warnings = [];

  if (!POLITICAL.has(evidence.requestedStatus)) {
    errors.push('politicalResearchLog.status ist ungültig.');
  }
  if (evidence.requestedStatus !== 'blocked' && !evidence.queries.length) {
    errors.push(
      'Politische Recherche benötigt ein nachvollziehbares Suchprotokoll mit Suchbegriff und benannter Quelle, Quellentyp oder Portal-URL.'
    );
  }
  if (evidence.requestedStatus === 'complete' && !evidence.references.length) {
    errors.push(
      'politicalResearchLog.status=complete erfordert mindestens eine direkte HTTP(S)-Evidenzreferenz.'
    );
  }
  if (list(research.documentedQueries).length > evidence.queries.length) {
    warnings.push('Mindestens ein Eintrag im politischen Suchprotokoll ist unvollständig.');
  }
  return { evidence, errors, warnings };
}

function buildBlockedFallbackContract(aiInput, reason) {
  const output = core.buildBlockedFallbackContract(aiInput, reason);
  const political = politicalEvidence(output.politicalResearchLog);
  const evidenceMissing = !political.complete;
  const blocker = 'Politische/administrative Vorbefassung ist nicht durch Suchprotokoll und direkte HTTP(S)-Evidenz belastbar abgeschlossen.';

  output.politicalResearchLog = {
    ...object(output.politicalResearchLog),
    status: political.status,
    documentedQueries: political.queries,
    evidenceRefs: political.references,
  };
  output.valueAddAssessment = {
    ...object(output.valueAddAssessment),
    status: 'failed',
    score: 0,
    automaticFailureReasons: unique([
      ...list(output.valueAddAssessment?.automaticFailureReasons),
      evidenceMissing ? blocker : '',
    ]),
  };
  output.filingReadinessVerdict = {
    ...object(output.filingReadinessVerdict),
    status: 'blocked',
    politicalResearchStatus: political.status,
    blockingReasons: unique([
      ...list(output.filingReadinessVerdict?.blockingReasons),
      evidenceMissing ? blocker : '',
    ]),
  };
  return output;
}

function evaluateProposalValueAdd(proposal) {
  const base = core.evaluateProposalValueAdd(proposal);
  const political = politicalEvidenceErrors(proposal);
  return {
    valid: base.valid && political.errors.length === 0,
    errors: unique([...list(base.errors), ...political.errors]),
    warnings: unique([...list(base.warnings), ...political.warnings]),
  };
}

function ensureProposalValueAdd(proposal, aiInput, reason) {
  const output = core.ensureProposalValueAdd(proposal, aiInput, reason);
  if (!output || typeof output !== 'object' || Array.isArray(output)) return output;

  const evaluation = evaluateProposalValueAdd(output);
  if (evaluation.valid) return output;

  const research = politicalEvidence(output.politicalResearchLog);
  const assessment = object(output.valueAddAssessment);
  const verdict = object(output.filingReadinessVerdict);
  output.politicalResearchLog = {
    ...object(output.politicalResearchLog),
    status: research.status,
    documentedQueries: research.queries,
    evidenceRefs: research.references,
  };
  output.valueAddAssessment = {
    ...assessment,
    status: 'failed',
    score: Number.isInteger(assessment.score)
      ? Math.max(0, Math.min(assessment.score, 79))
      : 0,
    automaticFailureReasons: unique([
      ...list(assessment.automaticFailureReasons),
      ...evaluation.errors,
    ]),
  };
  output.filingReadinessVerdict = {
    ...verdict,
    status: 'blocked',
    analysisQaStatus: READINESS.has(clean(verdict.analysisQaStatus).toLowerCase())
      ? clean(verdict.analysisQaStatus).toLowerCase()
      : 'conditional',
    politicalResearchStatus: research.status,
    reasoning: clean(verdict.reasoning)
      || 'Die politische/administrative Evidenz oder der serverseitige Mehrwertvertrag ist unvollständig.',
    blockingReasons: unique([
      ...list(verdict.blockingReasons),
      ...evaluation.errors,
      ...evaluation.warnings,
    ]),
  };
  return output;
}

module.exports = Object.freeze({
  ...core,
  absoluteHttpUrl,
  documentedPoliticalQueries,
  politicalEvidence,
  buildBlockedFallbackContract,
  evaluateProposalValueAdd,
  ensureProposalValueAdd,
});
