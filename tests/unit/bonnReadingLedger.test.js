/** @jest-environment node */
'use strict';

const reading = require('../../docs/qa/2026-11-15-bonn-lesestapel-001.json');
const history = require('../../docs/qa/2026-11-14-ris-stichproben-ids.json');
const identity = row => row.city + '\n' + row.id;

test('the fixed Bonn reading ledger keeps reviews, source versions and outstanding cases distinct', () => {
  expect(reading.sample).toHaveLength(98);
  expect(reading.pending).toHaveLength(10);
  const reviewed = new Set(reading.sample.map(identity));
  const pending = new Set(reading.pending.map(identity));
  const historical = new Set(history.sample.map(identity));
  expect(reviewed.size).toBe(reading.sample.length);
  expect(pending.size).toBe(reading.pending.length);
  expect(history.sample).toHaveLength(140);
  for (const key of reviewed) {
    expect(pending.has(key)).toBe(false);
    expect(historical.has(key)).toBe(false);
  }

  const positions = [];
  const preliminary = [];
  for (const row of reading.sample) {
    expect(row.city).toBe('bonn');
    expect(row.id).toMatch(/^https:\/\/www\.bonn\.sitzung-online\.de\/oparl\/papers\/\d+$/);
    expect(row.file).toMatch(/^https:\/\/www\.bonn\.sitzung-online\.de\/oparl\/files\/\d+$/);
    expect(row.mirrorVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(row.textSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row.note).toEqual(expect.any(String));
    expect(row.note.trim().length).toBeGreaterThan(10);
    // Extracted text is not proof of completed semantic review.
    expect(row.assessment).toEqual(expect.any(String));
    expect(row.assessment.trim().length).toBeGreaterThan(6);
    if (row.position === undefined) {
      preliminary.push(row);
      expect(row.scope).toContain('Vorprüfung');
      expect(row.assessment).toMatch(/^(Vorprüfung|Teilprüfung):/);
    } else {
      expect(Number.isInteger(row.position)).toBe(true);
      positions.push(row.position);
    }
  }
  expect(preliminary).toHaveLength(8);

  for (const row of reading.pending) {
    expect(row.city).toBe('bonn');
    expect(row.status).toBe('not_cached');
    expect(row).not.toHaveProperty('textSha256');
    expect(row).not.toHaveProperty('assessment');
    expect(row.file).toMatch(/^https:\/\/www\.bonn\.sitzung-online\.de\/oparl\/files\/\d+$/);
    positions.push(row.position);
  }
  expect(new Set(positions).size).toBe(100);
  expect(positions.sort((a,b) => a-b)).toEqual(Array.from({length:100},(_,i)=>i+1));
  expect(reading.pending.map(x=>x.position)).toEqual([91,92,93,94,95,96,97,98,99,100]);
  expect(reading.sample.filter(x=>x.newlyMappedInRevision7)).toHaveLength(17);
});
