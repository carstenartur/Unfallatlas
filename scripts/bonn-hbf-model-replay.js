'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const service = require('../server/ai/aiAssessmentServiceV2');
const { canonicalize } = require('../server/ai/cache/aiAssessmentCache');
const { evaluateProposalValueAdd } = require('../server/ai/proposalBriefValueAdd');

const FIXTURES = path.resolve(__dirname, '../tests/fixtures/bonn-hbf-model-replay');
const json = value => JSON.stringify(canonicalize(value), null, 2) + '\n';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const write = (directory, file, value) => fs.writeFileSync(path.join(directory, file), json(value));
const list = value => Array.isArray(value) ? value : [];
const normalize = value => String(value ?? '').toLowerCase().replace(/[−–]/g, '-').replace(/[\u00a0\u202f]/g, ' ');
const integer = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '[. ]?');

function replayRequestSha256(request) {
  // The export clock changes between otherwise identical browser runs.
  const user = request.user.replace(/^Datum des Exports: \d{1,2}\.\d{1,2}\.\d{4}$/m, 'Datum des Exports: <Laufzeitdatum>');
  return sha256(json({ ...request, user }));
}

function officialFactsMatch(response, input) {
  const digest = input.deterministicAnalysisDigest;
  const facts = digest.officialAccidentFacts;
  const counts = input.evidenceCohortCounts;
  const years = digest.yearlyTrend.years;
  const factChecks = [
    new RegExp(`\\b${facts.total} ausgewählte rad-pkw-unfälle mit personenschaden`),
    new RegExp(`\\b${facts.fatal} unfälle mit getöteten`),
    new RegExp(`\\b${facts.serious} unfall mit schwerverletzten`),
    new RegExp(`\\b${facts.slight} unfälle mit leichtverletzten`),
    new RegExp(`\\b${years[0]}(?: bis |-)${years.at(-1)}\\b`),
  ];
  const body = normalize(response.sachverhalt);
  const area = normalize(digest.meta.areaName);
  return facts.total === counts.discovery && facts.total === facts.fatal + facts.serious + facts.slight
    && [body, normalize(response.longVersion)].every(text =>
      text.includes(area) && factChecks.every(check => check.test(text)))
    && json(response.evidenceCohortCounts) === json(counts)
    && new RegExp(`vollständige[sn]? gebiet.{0,24}\\b${integer(counts.completeArea)} unfälle vor anwendung des beteiligungsfilters`).test(body)
    && new RegExp(`referenz im übrigen bonner stadtgebiet.{0,24}\\b${integer(counts.reference)} unfälle unter denselben aktiven filtern`).test(body);
}

function methodMatches(response, digest) {
  const comparison = digest.patternCompositionComparison;
  const row = comparison.allRows.find(item => item.mask === 5);
  const trend = digest.yearlyTrend;
  const method = normalize(response.begruendung);
  const points = value => (value * 100).toFixed(1).replace('.', ',');
  return comparison.reference?.method === 'newcombe-wilson-95' && row?.isSignificant === false
    && row.differenceCiLow < 0 && row.differenceCiHigh > 0
    && new RegExp(`\\b${integer(row.locCnt)}/${integer(row.localTotal)}\\b.{0,60}\\b${integer(row.baseCnt)}/${integer(row.baselineTotal)}\\b`).test(method)
    && method.includes('beteiligungsanteile unter denselben aktiven filtern')
    && method.includes(`+${points(row.difference)} prozentpunkte`)
    && method.includes(`newcombe-95-%-intervall aus beiden stichproben reicht von ${points(row.differenceCiLow)} bis +${points(row.differenceCiHigh)} prozentpunkten und umfasst null`)
    && method.includes('überrepräsentation ist damit nicht belegt')
    && method.includes('explorativ und unbereinigt')
    && method.includes('für absolute unfallraten oder risiko je verkehrsleistung fehlen expositionsdaten')
    && method.includes(trend.totals.join(', ') + ' und ist als ' + normalize(trend.classification) + ' klassifiziert');
}

function politicalFitMatches(response, councilEvidence, localGate) {
  const log = response.politicalResearchLog;
  const verdict = response.filingReadinessVerdict;
  const political = normalize(log.comparisonToExistingActivity);
  if (!councilEvidence) {
    return localGate?.filingReady === false && verdict.status === 'blocked' && verdict.politicalResearchStatus === 'blocked'
      && log.status === 'blocked' && log.sourceStatus === 'not-searched'
      && log.documentedQueries.length === 0 && log.evidenceRefs.length === 0
      && political.includes('keine ausgeführte recherche') && verdict.blockingReasons.length > 0;
  }
  const amendmentClaims = [political, ...['sachverhalt', 'begruendung', 'longVersion', 'shortVersion', 'beschlussvorschlag', 'pruefauftrag']
    .map(field => normalize(response[field]))].flatMap(text => text.split(/(?<=[.!?])\s+/))
    .filter(sentence => sentence.includes('232044-02 aa'));
  const separateVote = /(?:separat(?:e[rsn]?)?|gesondert(?:e[rsn]?)?|eigenständig(?:e[rsn]?)?)\b.{0,45}\b(?:beschlossen|angenommen|verabschiedet|abgestimmt|abstimmung fand statt|abstimmung erfolgte)/;
  return localGate?.filingReady === true && localGate.passed === true && localGate.filingReadinessStatus === 'ready'
    && verdict.status === 'ready' && verdict.analysisQaStatus === 'ready' && verdict.politicalResearchStatus === 'complete'
    && log.status === 'complete' && log.sourceStatus === 'results-found'
    && amendmentClaims.every(sentence => !separateVote.test(sentence))
    && [
      /ratsbeschluss 232044 beauftragte die planung.{0,65}gesonderten baubeschluss/,
      /stellungnahme 232044-01 st wurde zur kenntnis genommen/,
      /232044-02 aa entfiel die separate abstimmung/,
      /mindestens drei meter breite\w* gehfläche nördlich des radstreifens/,
      /verkehrsversuch 2019\/2020.{0,90}belegt aber keine unfallwirkung/,
      /planungsstand vom mai 2025.{0,90}prüfung von querungshilfen und reduzierten geschwindigkeiten/,
      /swb-aufsichtsrat fordert einen ablaufplan.{0,55}2027/,
      /umsetzungsstand und ein baubeginn bleiben zu klären/,
    ].every(check => check.test(political));
}

function sourcesResolve(response, input, councilEvidence) {
  const log = response.politicalResearchLog;
  const expectedRefs = list(councilEvidence?.references).map(ref => ref.url).sort();
  const queryKeys = queries => queries.map(({ query, source, sourceType, url }) => json([query, source, sourceType, url])).sort();
  const cited = [response.deterministicVsAiComparison, response.prioritisedFindings, response.crossLayerInsights,
    response.measureDecisionMatrix].flatMap(section => list(section).flatMap(item => list(item.evidenceRefs)));
  const knownPaths = [
    'deterministicAnalysisDigest.officialAccidentFacts', 'evidenceCohortCounts',
    'deterministicAnalysisDigest.patternCompositionComparison', 'deterministicAnalysisDigest.yearlyTrend',
    'features.spatialDensity', 'features.visualContextHints', 'deterministicAnalysisDigest.politicalResearch',
  ];
  return json([...log.evidenceRefs].sort()) === json(expectedRefs)
    && json(queryKeys(log.documentedQueries)) === json(queryKeys(list(councilEvidence?.queries)))
    && expectedRefs.every(url => cited.includes(url))
    && cited.every(ref => expectedRefs.includes(ref) || (knownPaths.includes(ref)
      && ref.split('.').reduce((value, key) => value?.[key], input) != null));
}

function addedValuePresent(response) {
  const priorities = response.prioritisedFindings;
  const insights = response.crossLayerInsights;
  return new Set(priorities.map(item => item.rank)).size >= 3
    && new Set(insights.map(item => normalize(item.insight))).size >= 3
    && insights.every(item => normalize(item.decisionValue).length > 0)
    && response.competingHypotheses.every(item =>
      new Set(item.hypotheses.map(normalize).filter(Boolean)).size >= 2
      && item.discriminatingChecks.some(check => /abschnitt|unfalltyp|orts- und ablaufbeschreibung/.test(normalize(check))))
    && response.aiDelta.ergaenzt.some(item => /berichtstabelle|zuordnungsstatus|nachprüfung/.test(normalize(item)));
}

function measuresAreVerifiable(response, input, researched) {
  const cases = input.evidenceCohortCounts.discovery;
  const proposal = normalize(response.beschlussvorschlag);
  return proposal.includes('bezirksvertretung bonn') && proposal.includes('stadtverwaltung')
    && (!researched || /innerhalb von \d+ wochen nach beschluss/.test(proposal))
    && response.measureDecisionMatrix.some(item => {
      const checks = normalize(item.requiredVerification.join(' '));
      const criteria = normalize(item.successCriteria.join(' '));
      return normalize(item.responsibility).includes('stadtverwaltung bonn')
        && /\b\d+ wochen\b/.test(normalize(item.deadline))
        && checks.includes('fallnummer') && checks.includes('verkehrsregime')
        && (!researched || /geh(?:breite|fläche) nördlich des radstreifens/.test(checks))
        && criteria.includes(`alle ${cases} ausgewählten fälle`) && criteria.includes('zuordnungsstatus')
        && criteria.includes('erhebungszeitraum') && criteria.includes('termin zur nachprüfung');
    });
}

function evaluateReplayEvidence(response, input, councilEvidence, localGate) {
  const checks = {
    officialFacts: officialFactsMatch(response, input),
    method: methodMatches(response, input.deterministicAnalysisDigest),
    politicalFit: politicalFitMatches(response, councilEvidence, localGate),
    sourceResolution: sourcesResolve(response, input, councilEvidence),
    measureQuality: measuresAreVerifiable(response, input, Boolean(councilEvidence)),
    addedValue: addedValuePresent(response),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

async function runModelReplay({ input, binding, outDir, caseId, councilEvidence, localGate }) {
  const manifest = require('../tests/fixtures/bonn-hbf-model-replay/manifest.json');
  const name = councilEvidence ? 'council-research' : 'unsearched';
  const expected = manifest.cases[name];
  const directory = path.join(outDir, 'model-replay');
  fs.mkdirSync(directory, { recursive: true });
  for (const file of ['response.json', 'provider-request.json']) fs.rmSync(path.join(directory, file), { force: true });
  const rawText = fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8');
  fs.writeFileSync(path.join(directory, 'raw-response.txt'), rawText);
  const receipt = {
    kind: 'fixture-replay', actualProviderRun: false, origin: manifest.origin, authoredOn: manifest.authoredOn,
    caseId, case: name, promptVersion: binding.promptVersion, inputSha256: binding.inputSha256,
    promptSha256: binding.promptSha256, schemaSha256: binding.schemaSha256, rubricSha256: binding.rubricSha256,
    caseRubricSha256: sha256(fs.readFileSync(__filename)),
    appendixSha256: binding.appendixSha256, expectedRequestSha256: expected.requestSha256,
    requestSha256: null, rawResponseSha256: sha256(rawText), providerCalls: 0,
  };
  try {
    if (manifest.caseId !== caseId || manifest.promptVersion !== binding.promptVersion
        || sha256(json(input)) !== binding.inputSha256
        || receipt.rawResponseSha256 !== expected.rawResponseSha256) {
      throw new Error('The replay response, input binding, case ID or prompt version differs from its receipt.');
    }
    const assessment = await service.requestAssessmentV2({ aiInput: input, mode: 'proposal-brief',
      providerCall: async request => {
        receipt.providerCalls++;
        const requestSha256 = replayRequestSha256(request);
        if (receipt.providerCalls === 1) {
          receipt.requestSha256 = requestSha256;
          write(directory, 'provider-request.json', request);
        }
        const { system, user } = request;
        if (receipt.providerCalls !== 1 || requestSha256 !== expected.requestSha256
            || sha256(json({ system, user })) !== binding.promptSha256) {
          throw new Error(`Provider request does not match the recorded ${name} prompt and schema (${requestSha256}).`);
        }
        return rawText;
      },
    });
    const response = service.parseJsonLoose(rawText);
    receipt.responseSha256 = sha256(json(response));
    const schema = service.validateAgainstMode(response, 'proposal-brief', { normalizeProposal: false });
    const valueAdd = evaluateProposalValueAdd(response);
    const evidence = schema.valid ? evaluateReplayEvidence(response, input, councilEvidence, localGate) : null;
    const acceptedUnchanged = receipt.providerCalls === 1 && assessment.source === 'ai' && json(assessment.result) === json(response);
    const passed = acceptedUnchanged && schema.valid && valueAdd.valid && evidence?.passed === true;
    write(directory, 'response.json', assessment.result);
    write(directory, 'review.json', { passed, schema, valueAdd, evidence, acceptedUnchanged,
      serviceSource: assessment.source, modelVerdict: assessment.result.filingReadinessVerdict?.status,
      releaseApproval: false });
    return { passed, directory };
  } catch (error) {
    write(directory, 'review.json', { passed: false, error: error.message, releaseApproval: false });
    throw error;
  } finally {
    write(directory, 'receipt.json', receipt);
  }
}

module.exports = { evaluateReplayEvidence, replayRequestSha256, runModelReplay };
