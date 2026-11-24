/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');
const { SOURCE, REVISION } = require('../../server/political-context/providers/regionHannoverCatalogue');
const { summarizeRegionSourceAge } = require('../../scripts/audit-ris-source-age');

const now = new Date('2026-11-24T12:00:00.000Z');
const time = days => new Date(now.getTime() - days * 86400000).toISOString();
let directory, checkpoint;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'age-audit-'));
  checkpoint = createRisSourceCheckpoint({ directory });
});
afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

function row(id, listAge, detailAge) {
  const metadata = { id: SOURCE + ':vo:' + id, url: 'https://ris.hannit.de/public/vo020?VOLFDNR=' + id,
    source: SOURCE, title: 'Private-fixture-title', number: 'private-number', rawType: 'Anfrage',
    date: null, sourceContext: { level: 'region', publicationDate: null } };
  return { metadata, metadataVerifiedAt: time(listAge),
    ...(detailAge === undefined ? {} : { detail: { ...metadata, rawStatus: 'öffentlich', locationEvidence: ['private evidence'] },
      detailVerifiedAt: time(detailAge) }) };
}
function save(year, records) { return checkpoint.write(SOURCE, 'public-proposals', year, REVISION, { records }); }

test('counts each accepted visible ID once, separates metadata and detail age, and never emits record data', async () => {
  await save(2020, [row(1, 0, 0), row(2, 14, 0), row(3, 0, 14), row(4, 15, 16),
    { ...row(5, 18, 18), excludedAt: time(0), exclusionReason: 'not-public' }, row(6, 7)]);
  await save(2021, [row(1, 0, 7), { ...row(2, -1, 3) }, { ...row(7, 0, 1), detail: row(8, 0, 1).detail },
    { ...row(9, 0, 1), detailVerifiedAt: 'invalid' }, null]);
  const result = await summarizeRegionSourceAge(directory, now);
  expect(result).toMatchObject({ asOf: now.toISOString(), partitions: 2, duplicates: 1,
    invalidMetadataRows: 1, invalidMetadataClockRows: 1, withdrawn: 1, active: 7,
    noDetail: 1, invalidDetail: 2, metadata: { under7Days: 4, from7ToUnder14Days: 1, atLeast14Days: 2 },
    detail: { under7Days: 1, from7ToUnder14Days: 1, atLeast14Days: 2, oldest: time(16), newest: time(0) },
    effective: { under7Days: 2, from7ToUnder14Days: 2, atLeast14Days: 3 },
    expiredBy: { metadataOnly: 1, detailOnly: 1, both: 1 } });
  expect(JSON.stringify(result)).not.toMatch(/VOLFDNR|:vo:|Private-fixture|private-number|private evidence|https?:/);
});

test('an unsuccessful detail attempt cannot renew the detail clock', async () => {
  await save(2026, [{ ...row(1, 2, 14), lastAttemptedAt: time(0), detailUnavailable: true }]);
  const before = await checkpoint.read(SOURCE, 'public-proposals', 2026, REVISION);
  const operations = ['writeFile', 'mkdir', 'rename', 'rm'].map(method => jest.spyOn(fs, method));
  const request = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Unexpected request'));
  let result;
  try {
    result = await summarizeRegionSourceAge(directory, now);
    for (const operation of [...operations, request]) expect(operation).not.toHaveBeenCalled();
  } finally {
    for (const operation of [...operations, request]) operation.mockRestore();
  }
  expect(result.expiredBy).toEqual({ metadataOnly: 0, detailOnly: 1, both: 0 });
  expect(await checkpoint.read(SOURCE, 'public-proposals', 2026, REVISION)).toEqual(before);
});

test('an accepted withdrawal removes the final row from all age distributions', async () => {
  await save(2025, [row(1, 14, 14), { ...row(1, 16, 16), excludedAt: time(1), exclusionReason: 'not-public' }]);
  const result = await summarizeRegionSourceAge(directory, now);
  expect(result).toMatchObject({ duplicates: 1, withdrawn: 1, active: 0,
    effective: { under7Days: 0, from7ToUnder14Days: 0, atLeast14Days: 0, oldest: null, newest: null } });
});

test('rejects missing or unreadable partitions instead of reporting a fresh empty archive', async () => {
  await expect(summarizeRegionSourceAge(directory, now)).rejects.toThrow(/missing/i);
  await checkpoint.write(SOURCE, 'public-proposals', 2026, 'wrong-revision', { records: [row(1, 0)] });
  await expect(summarizeRegionSourceAge(directory, now)).rejects.toThrow(/invalid/i);
});
