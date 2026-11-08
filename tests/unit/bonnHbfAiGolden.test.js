/** @jest-environment node */
'use strict';
const qa = require('../../scripts/qa-bonn-hbf-ai-golden');
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
  const binding={inputSha256:'a',promptSha256:'b'};
  const receipt={provider:'gemini',model:'unit-fixture',modelVersion:'unit-fixture-v1',executedAt:'2026-11-08T00:00:00Z',...binding};
  const result=qa.reviewModelResponse({},receipt,binding);
  expect(result.providerReceiptVerified).toBe(true);
  expect(result.schemaValidation.valid).toBe(false);
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
