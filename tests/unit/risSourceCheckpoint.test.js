/** @jest-environment node */
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRisSourceCheckpoint } = require('../../server/political-context/services/risSourceCheckpoint');

test('persisted work is isolated by source, scope, year and parser revision', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-work-'));
  try {
    const first = createRisSourceCheckpoint({ directory });
    await first.write('hannover-sim', 'public-year-search', 2014, 'v1', { cursor: 2, failedDetails: ['0003-2014'] });
    await first.write('hannover-sim', 'public-year-search', 2015, 'v1', { cursor: 5 });
    const restored = createRisSourceCheckpoint({ directory });
    expect(await restored.read('hannover-sim', 'public-year-search', 2014, 'v1')).toEqual({ cursor: 2, failedDetails: ['0003-2014'] });
    expect(await restored.read('hannover-sim', 'public-year-search', 2014, 'v2')).toBeNull();
    expect(await restored.read('bonn-oparl', 'public-year-search', 2014, 'v1')).toBeNull();
    expect(await restored.read('hannover-sim', 'selected-councils', 2014, 'v1')).toBeNull();
    expect(await restored.years('hannover-sim', 'public-year-search')).toEqual([2014, 2015]);
    expect(await restored.years('bonn-oparl', 'public-year-search')).toEqual([]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
