/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRisSnapshotSearch } = require('../../server/political-context/services/risSnapshotSearch.js');
const { writeRisSnapshot } = require('../../server/political-context/services/risSnapshot.js');

test('queries a published Hannover catalogue and notices replacement of its manifest', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-search-'));
  const source = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/Termine.xsp';
  const coverage = {
    from: '2026-01-01', to: '2026-11-07', bodies: ['Ratsversammlung'],
    complete: false, warnings: ['Archiv der Ratsversammlung']
  };
  const params = { city: 'Hannover', searchTerms: ['Lindener Stichkanal'] };
  const search = createRisSnapshotSearch(directory);
  async function publish(number) {
    return writeRisSnapshot(directory, 'hannover', {
      sources: [source], coverage,
      records: [{
        id: number, number, title: 'Radwegeausbau am Lindener Stichkanal',
        url: `https://e-government.hannover-stadt.de/lhhsimwebre.nsf/DS/${number}`,
        type: 'Anfrage', date: null, gremium: 'Ratsversammlung', source: 'hannover-sim'
      }]
    });
  }
  try {
    await expect(search(params)).resolves.toBeNull();
    await publish('1047-2026');
    await expect(search(params)).resolves.toMatchObject({
      references: [{ number: '1047-2026' }], meta: { searchStatus: 'partial-results' }
    });
    await publish('1047-2026F1');
    await expect(search(params)).resolves.toMatchObject({
      references: [{ number: '1047-2026F1' }]
    });
    await expect(search({ ...params, city: 'Bonn' })).resolves.toBeNull();
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('v2 search continuation survives a fresh server reader and keeps generation/query binding', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-search-page-'));
  const source = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
  try {
    await writeRisSnapshot(directory, 'hannover', {
      sources: [source], coverage: { from: '2020-01-01', to: null, bodies: [], warnings: [], complete: true },
      records: Array.from({ length: 75 }, (_, i) => ({ id: `record-${i}`, title: 'Radverkehr am Kanal', number: null,
        date: null, gremium: null, type: 'Anfrage', url: source + `DS/${i}`, source: 'hannover-sim' }))
    }, { schemaVersion: 2 });
    const params = { city: 'Hannover', searchTerms: ['Radverkehr'], maxResults: 10 };
    const first = await createRisSnapshotSearch(directory)(params);
    const next = await createRisSnapshotSearch(directory)({ ...params, page: first.meta.nextPage, snapshot: first.meta.snapshot });
    expect(first.references).toHaveLength(10);
    expect(next.references).toHaveLength(10);
    expect(new Set([...first.references, ...next.references].map(record => record.id)).size).toBe(20);
    await expect(createRisSnapshotSearch(directory)({ ...params, searchTerms: ['Kanal'], page: first.meta.nextPage, snapshot: first.meta.snapshot }))
      .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_CURSOR_INVALID' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
