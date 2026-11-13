/** @jest-environment node */
'use strict';
const qa = require('../../scripts/qa-bonn-hbf-ai-golden');
const { evaluateReplayEvidence, replayRequestSha256 } = require('../../scripts/bonn-hbf-model-replay');
test('semantic comparison excludes only the execution envelope and exposes exact fact/source/map drift', () => {
  const a = { facts: { total: 37, years: [6,8,5,2,2,9,5] }, inputs: { sourceHash: 'a', mapSceneHash: 'b' }, political: { searchedAt: null }, execution: { generatedAt: 'old' } };
  expect(qa.compareSnapshots(a, {...a, execution: {generatedAt:'new'}})).toEqual([]);
  for (const [key, value] of [['facts', {...a.facts,total:38}], ['inputs',{...a.inputs,sourceHash:'c'}], ['inputs',{...a.inputs,mapSceneHash:'c'}], ['political',{searchedAt:'2026-11-08'}]]) {
    expect(qa.compareSnapshots(a, {...a,[key]:value}).length).toBeGreaterThan(0);
  }
});
test('model evaluation stays blocked without a bound actual provider receipt or political/map completion', () => {
  expect(qa.reviewModelResponse({}, null, {inputSha256:'a',promptSha256:'b'})).toMatchObject({status:'blocked',providerReceiptVerified:false});
  expect(qa.reviewModelResponse({filingReadinessVerdict:{status:'ready'}}, {provider:'Gemini',model:'x',modelVersion:'x',executedAt:'2026-11-08T00:00:00Z',inputSha256:'WRONG',promptSha256:'b'}, {inputSha256:'a',promptSha256:'b'})).toMatchObject({status:'blocked',providerReceiptVerified:false});
});

test('matching receipt binding is distinguishable from missing evidence and cannot upgrade the blocked case', () => {
  const binding={requestedProvider:'gemini',requestedModel:'unit-fixture',promptVersion:'test-prompt-v1',inputSha256:'a'.repeat(64),promptSha256:'b'.repeat(64),schemaSha256:'c'.repeat(64),rubricSha256:'d'.repeat(64)};
  const receipt={provider:'gemini',model:'unit-fixture',modelVersion:'unit-fixture-v1',executedAt:'2026-11-08T00:00:00Z',responseSha256:require('node:crypto').createHash('sha256').update('{}\n').digest('hex'),...binding};
  const result=qa.reviewModelResponse({},receipt,binding);
  expect(result.providerReceiptVerified).toBe(true);
  expect(result.schemaValidation.valid).toBe(false);
  expect(qa.reviewModelResponse({altered:true},receipt,binding).providerReceiptVerified).toBe(false);
  expect(qa.reviewModelResponse({}, {...receipt,schemaSha256:'0'.repeat(64)}, binding).providerReceiptVerified).toBe(false);
  for (const mismatch of [{provider:'other-provider'}, {model:'different-model'}, {promptVersion:'obsolete-prompt'}]) {
    expect(qa.reviewModelResponse({}, {...receipt, ...mismatch}, binding).providerReceiptVerified).toBe(false);
  }
  expect(qa.reviewModelResponse({}, {...receipt, promptVersion:undefined}, binding).providerReceiptVerified).toBe(false);
  expect(result.status).toBe('blocked');
});

test('canonical public map URLs discard ephemeral local ports while retaining selection and layer state', () => {
  const first=qa.canonicalUrl('http://127.0.0.1:43001/werkbank_v2.html?selNorth=50.7355&mapMode=hybrid');
  expect(first).toBe('https://carstenartur.github.io/Unfallatlas/werkbank_v2.html?mapMode=hybrid&selNorth=50.7355');
  expect(qa.canonicalUrl('http://127.0.0.1:37331/werkbank_v2.html?mapMode=hybrid&selNorth=50.7355')).toBe(first);
});

test('actual production committee configuration survives the server model-input handoff', () => {
  const {buildAiInputV2}=require('../../server/ai/aiAssessmentServiceV2');
  for(const [name,type] of [['Bezirksvertretung Bonn','Bezirksvertretung'],['Stadtbezirksrat Mitte','Stadtbezirksrat']]) {
    expect(buildAiInputV2({meta:{gremium:{gremium:name,typ:type}}},{},[]).meta.gremium).toEqual({name,type});
  }
  expect(buildAiInputV2({meta:{gremium:{gremium:null,typ:'Bezirksvertretung'}}},{},[]).meta.gremium.name).toBe('');
});

test('live QA saves the original provider response and rejects an unsupported ready verdict', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ua-live-model-'));
  const service = require('../../server/ai/aiAssessmentServiceV2');
  const provider = require('../../server/ai/providers/geminiStructuredProvider');
  const response = '{"filingReadinessVerdict":{"status":"ready"}}';
  jest.spyOn(service, 'isAvailable').mockReturnValue(true);
  jest.spyOn(service, 'activeProviderName').mockReturnValue('gemini');
  const call = jest.spyOn(provider, 'callStructuredGeminiWithMetadata').mockResolvedValue({
    text: response, model: 'test', modelVersion: 'test-001'
  });
  const binding = Object.fromEntries(['inputSha256','promptSha256','schemaSha256','rubricSha256'].map(key => [key,'a'.repeat(64)]));
  Object.assign(binding, {requestedProvider:'gemini', requestedModel:'test', promptVersion:'test-prompt-v1'});
  try {
    await expect(qa.runBoundModelReview({system:'s',user:'u'},binding,dir)).rejects.toThrow(/failed the blocked case/);
    expect(call).toHaveBeenCalledWith({ system:'s', user:'u', responseSchema: expect.any(Object) });
    const [name] = fs.readdirSync(dir);
    const read = file => fs.readFileSync(path.join(dir, name, file), 'utf8');
    expect(read('raw-response.txt')).toBe(response);
    expect(JSON.parse(read('receipt.json')).modelVersion).toBe('test-001');
    expect(JSON.parse(read('review.json'))).toMatchObject({ providerReceiptVerified:true, blockerCasePassed:false });
  } finally {
    jest.restoreAllMocks();
    fs.rmSync(dir,{ recursive:true, force:true });
  }
});

test('a documented council search reaches the model with its queries and differentiated outcomes', () => {
  const evidence = require('../fixtures/bonn-hbf-political-research.json');
  const baseline = require('../fixtures/bonn-hbf-ai-golden.v1.json');
  const service = require('../../server/ai/aiAssessmentServiceV2');
  const structured = {
    meta: { city: 'Bonn' },
    deterministicAnalysisDigest: baseline.facts.digest,
    politicalReferences: evidence.references,
    politicalContextResearch: { status: 'results-found', queries: evidence.queries },
  };
  structured.evidenceCohorts = {
    discoveryCohort: { count: 37 }, completeEvidenceCohort: { count: 312 }, referenceCohort: { count: 1926 }
  };
  const input = service.buildAiInputV2(structured, {}, []);
  const research = input.deterministicAnalysisDigest.politicalResearch;
  expect(research.status).toBe('results-found');
  expect(research.queries).toEqual(evidence.queries);
  const { user } = service.buildProviderPrompt(input, 'proposal-brief');
  expect(user).toContain('Unfälle nach schwerster Folge: 0 mit Getöteten, 1 mit Schwerverletzten, 36 mit Leichtverletzten');
  expect(user).toContain('37 ausgewählte Unfälle, 312 Unfälle im vollständigen Gebiet, 1926 Fälle in der Referenz');
  expect(user).toContain('Untersuchungszeitraum: 2019–2025.');
  expect(user).toContain('2019: 6, 2020: 8, 2021: 5, 2022: 2, 2023: 2, 2024: 9, 2025: 5');
  for (const ref of evidence.references) {
    expect(user).toContain(ref.url);
    expect(user).toContain(ref.snippet);
  }
  expect(baseline.facts.digest.politicalResearch.status).toBe('not-searched');
});

test('map observations belong to the captured facts, exact views and downloadable images', () => {
  const baseline = require('../fixtures/bonn-hbf-ai-golden.v1.json');
  const observed = require('../fixtures/bonn-hbf-map-views/capture.json');
  const hints = qa.reviewedMapHints(baseline);
  expect(hints.sourceType).toBe('visual_context');
  expect(hints.views).toHaveLength(4);
  for (const view of observed.views) {
    expect(hints.views).toContainEqual(expect.objectContaining({ mode: view.mode, url: view.url, fileSha256: view.fileSha256 }));
  }
  const changed = structuredClone(baseline);
  changed.inputs.mapViews[1].url = changed.inputs.mapViews[0].url;
  expect(() => qa.reviewedMapHints(changed)).toThrow(/map/i);
  changed.inputs.mapViews = baseline.inputs.mapViews;
  changed.inputs.mapInputsFingerprint = '0'.repeat(64);
  expect(() => qa.reviewedMapHints(changed)).toThrow(/map/i);
});

test('the credential-free replay fingerprint ignores only the generated export date', () => {
  const request = {
    system: 'System instruction',
    user: '=== KONTEXT ===\nDatum des Exports: 13.11.2026\nBelegdatum: 14.03.2024\n37 ausgewählte Unfälle',
    responseSchema: { type: 'object', required: ['sachverhalt'] },
  };
  const digest = replayRequestSha256(request);
  expect(replayRequestSha256({ ...request, user: request.user.replace('13.11.2026', '14.11.2026') })).toBe(digest);
  expect(replayRequestSha256({ ...request, user: request.user.replace('14.03.2024', '15.03.2024') })).not.toBe(digest);
  expect(replayRequestSha256({ ...request, user: request.user.replace('37', '38') })).not.toBe(digest);
  expect(replayRequestSha256({ ...request, responseSchema: { ...request.responseSchema, required: [] } })).not.toBe(digest);
});

const replayFixture = require('../fixtures/bonn-hbf-model-replay/council-research.json');
const council = require('../fixtures/bonn-hbf-political-research.json');
const snapshot = require('../fixtures/bonn-hbf-ai-golden.v1.json');
const replayInput = {
  evidenceCohortCounts: { discovery: 37, completeArea: 312, reference: 1926 },
  deterministicAnalysisDigest: snapshot.facts.digest,
  features: { spatialDensity: {}, visualContextHints: {} },
};
const evidenceGate = {
  filingReady: true,
  passed: true,
  analysisQaStatus: 'ready',
  politicalResearchStatus: 'complete',
  filingReadinessStatus: 'ready',
};

test('scores the researched and unsearched answers against their own evidence', () => {
  expect(evaluateReplayEvidence(replayFixture, replayInput, council, evidenceGate).passed).toBe(true);
  const blocked = require('../fixtures/bonn-hbf-model-replay/unsearched.json');
  expect(evaluateReplayEvidence(blocked, replayInput, null, { filingReady: false }).passed).toBe(true);
  expect(evaluateReplayEvidence(replayFixture, replayInput, null, { filingReady: false }).checks.politicalFit).toBe(false);
  expect(evaluateReplayEvidence(replayFixture, replayInput, council, { ...evidenceGate, filingReady: false }).checks.politicalFit).toBe(false);
});

test.each([
  ['officialFacts', proposal => { proposal.sachverhalt = proposal.sachverhalt.replace('312 Unfälle', '1.926 Unfälle').replace('1.926 Unfälle unter', '312 Unfälle unter'); }],
  ['method', proposal => { proposal.begruendung = proposal.begruendung.replace('−6,8', '+0,8'); }],
  ['politicalFit', proposal => { proposal.politicalResearchLog.comparisonToExistingActivity = proposal.politicalResearchLog.comparisonToExistingActivity.replace('entfiel die separate Abstimmung', 'fand die separate Abstimmung statt'); }],
  ['sourceResolution', proposal => { proposal.crossLayerInsights[0].evidenceRefs[0] = 'https://www.bonn.de/falscher-vorgang'; }],
  ['measureQuality', proposal => { proposal.measureDecisionMatrix[0].successCriteria = ['Sicherheit verbessern']; }],
  ['addedValue', proposal => { proposal.competingHypotheses[0].hypotheses[1] = proposal.competingHypotheses[0].hypotheses[0]; }],
])('rejects a substantive %s regression even when the answer still claims a high score', (check, mutate) => {
  const proposal = structuredClone(replayFixture);
  mutate(proposal);
  expect(evaluateReplayEvidence(proposal, replayInput, council, evidenceGate)).toMatchObject({
    passed: false, checks: { [check]: false },
  });
});
