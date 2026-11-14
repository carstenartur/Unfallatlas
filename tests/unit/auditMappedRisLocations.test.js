/** @jest-environment node */
'use strict';

const { rankedSample, summarizeReviews } = require('../../scripts/audit-mapped-ris-locations');

test('the sample is deterministic across record order and distinguishes IDs in different city catalogues', () => {
  const candidates = Array.from({ length: 25 }, (_, i) => ({ city: i % 2 ? 'bonn' : 'hannover', id: String(Math.trunc(i / 2)) }));
  expect(rankedSample(candidates, 20, 'runde-1')).toEqual(rankedSample([...candidates].reverse(), 20, 'runde-1'));
  expect(rankedSample(candidates, 20, 'runde-1')).not.toEqual(rankedSample(candidates, 20, 'runde-2'));
  expect(new Set(rankedSample(candidates, 25, 'alle').map(r=>r.city + '/' + r.id)).size).toBe(25);
  expect(() => rankedSample([...candidates, candidates[0]], 20, 'runde')).toThrow(/doppelt/);
});

test('reports topical relevance and mapping quality separately, with pending/unclear outside the denominator', () => {
  const sample = ['a', 'b', 'c','d'].map(id=>({city:'bonn',id}));
  const review = (id, relevance, location) => ({city:'bonn',id,relevance,location, note:'Fundstelle und Reichweite geprüft', sourceUrl:'https://example.org/amtliches-dokument'});
  const result = summarizeReviews(sample, [review('a','yes','correct'), review('b','yes','incorrect'), review('c','no','unclear')]);
  expect(result).toMatchObject({sampleSize:4, pending:1, relevance:{yes:2,no:1,unclear:0}, location:{correct:1,incorrect:1,unclear:1},
    relevantLocationPrecision:{correct:1,judged:2,share:0.5}});
  expect(summarizeReviews(sample, []).relevantLocationPrecision.share).toBeNull();
  expect(() => summarizeReviews(sample,[review('x','yes','correct')])).toThrow(/Stichprobe/);
  expect(() => summarizeReviews(sample,[review('a','yes','correct'),review('a','yes','correct')])).toThrow(/doppelt/);
});

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { writeRisSnapshot } = require('../../server/political-context/services/risSnapshot');
const { audit } = require('../../scripts/audit-mapped-ris-locations');

test('reads a hashed partition set, keeps house-number evidence and rejects reviews from another round', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mapped-ris-audit-'));
  const source = 'https://example.org/', date = '2026-01-01';
  const record = (id, extra) => ({id, title: 'Antrag ' + id, url: source + id, date, type:'Antrag', source:'RIS', ...extra});
  try {
    await writeRisSnapshot(dir, 'test', {sources: [source], records: [
      record('1', {locationAssessment:{status:'mapped', sources:['document'], reasons:[], truncated:false},
        locations:[{kind:'address', label:'Beispielstraße 42a', evidence:{source:'document', text:'Querung vor Beispielstraße 42a'},
          geometry:{type:'Point', coordinates:[7,51]}}]}),
      record('2', {locationAssessment:{status:'unresolved', sources:['title'], reasons:['no_specific_location'], truncated:false}}),
    ], coverage:{from:date, to:date, complete:true, bodies:[], warnings:[]}}, {schemaVersion:2, now:() => new Date(date + 'T12:00:00Z')});
    const files = [path.join(dir,'test.json')];
    const first = await audit(files, 20, 'runde');
    expect(first.cities[0]).toMatchObject({recordCount:2, mappedRecordCount:1, review:{pending:1}, sample:[{
      id:'1', url:source + '1', locations:[{kind:'address', label:'Beispielstraße 42a', evidence:{source:'document'}}],
      geometries:[{geometry:{type:'Point', coordinates:[7,51]}, references:[{accuracy:'derived'}]}],
    }]});
    await expect(audit(files, 20, 'andere-runde', {sampleId:first.sampleId, decisions:[]})).rejects.toThrow(/anderen Stichprobe/);
  } finally {
    await fs.rm(dir, {recursive:true, force:true});
  }
});
