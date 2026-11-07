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
