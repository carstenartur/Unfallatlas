/** @jest-environment node */
'use strict';

const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { createCatalogue, searchSnapshot } = require('../../js/ua.ris-catalogue.js');

const base = 'https://example.org/Unfallatlas/werkbank_v2.html';
const source = 'https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
const now = () => new Date('2026-11-07T10:00:00Z');
const records = [
  {
    id: '1047-2026', title: 'Radwegeausbau am Lindener Stichkanal',
    number: '1047/2026', type: 'Anfrage', date: null, gremium: 'Ratsversammlung',
    url: source + 'DS/1047-2026', source: 'hannover-sim'
  },
  {
    id: '1047-2026F1', title: 'Antwort der Verwaltung', relatedTo: '1047-2026',
    number: '1047/2026 F1', type: 'Verwaltungsantwort', date: null, gremium: null,
    url: source + 'DS/1047-2026F1', source: 'hannover-sim'
  }
];
const geo = {
  type: 'FeatureCollection',
  features: [{
    type: 'Feature',
    geometry: { type: 'LineString', coordinates: [[9.68, 52.36], [9.69, 52.37]] },
    properties: { recordId: '1047-2026', accuracy: 'derived' }
  }]
};

function asset(data, kind, count) {
  const raw = Buffer.from(JSON.stringify(data));
  const sha256 = createHash('sha256').update(raw).digest('hex');
  return {
    entry: { path: `hannover.${sha256}.${kind}.json.gz`, sha256, bytes: raw.length, count },
    gzip: gzipSync(raw)
  };
}

function fixture() {
  const index = asset(records, 'records', 2);
  const map = asset(geo, 'map', 1);
  const manifest = {
    schemaVersion: 1, city: 'hannover', generatedAt: '2026-11-06T10:00:00Z',
    sources: [source],
    coverage: { from: '2025-01-01', to: '2026-11-06', bodies: ['Ratsversammlung'], complete: false, warnings: ['Auswahl'] },
    records: index.entry, map: map.entry
  };
  const requests = [];
  const fetch = async (url) => {
    requests.push(url);
    const file = new URL(url).pathname.split('/').pop();
    if (file === 'hannover.json') return Response.json(manifest);
    if (file === index.entry.path) return new Response(index.gzip);
    if (file === map.entry.path) return new Response(map.gzip);
    return new Response(null, { status: 404 });
  };
  return { manifest, index, map, requests, catalogue: createCatalogue({ base, fetch, now }) };
}

test('searches the selected same-origin city and loads its map only on demand', async () => {
  const { catalogue, requests, index, map } = fixture();
  const result = await catalogue.search({ city: 'Hannover', searchTerms: ['Hannover', 'Lindener Stichkanal'] });
  expect(result.references.map(({ number }) => number)).toEqual(['1047/2026', '1047/2026 F1']);
  expect(result.meta).toMatchObject({ searchStatus: 'partial-results', sourceFingerprint: index.entry.sha256 });
  expect(result.references[0]).toMatchObject({
    snapshot: { city: 'hannover', generatedAt: '2026-11-06T10:00:00Z', sha256: index.entry.sha256 },
    aiGating: { allowed: false }
  });
  expect(requests).toEqual([
    'https://example.org/Unfallatlas/data/ris/hannover.json',
    `https://example.org/Unfallatlas/data/ris/${index.entry.path}`
  ]);
  expect((await catalogue.loadMap('Hannover')).features).toEqual(geo);
  expect(requests[2]).toBe(`https://example.org/Unfallatlas/data/ris/${map.entry.path}`);
});

test('cannot turn incomplete or stale coverage into a completed zero result', () => {
  const { manifest } = fixture();
  const params = { city: 'Hannover', searchTerms: ['Oxfordstraße'] };
  expect(searchSnapshot({ manifest, records }, params, now()).meta.searchStatus).toBe('incomplete');
  manifest.coverage.complete = true;
  expect(searchSnapshot({ manifest, records }, params, now()).meta.searchStatus).toBe('searched-no-results');
  manifest.generatedAt = '2026-10-15T10:00:00Z';
  expect(searchSnapshot({ manifest, records }, params, now()).meta).toMatchObject({
    searchStatus: 'incomplete', stale: true
  });
});

test('explains why a browser without secure-context hashing cannot load a map', async () => {
  const { catalogue } = fixture();
  const crypto = jest.spyOn(globalThis.crypto, 'subtle', 'get').mockReturnValue(undefined);
  try {
    await expect(catalogue.loadMap('Hannover')).rejects.toMatchObject({ code: 'RIS_SECURE_CONTEXT_REQUIRED' });
  } finally {
    crypto.mockRestore();
  }
});

test('rejects a swapped city and an inconsistent payload without following a foreign path', async () => {
  const swapped = fixture();
  swapped.manifest.city = 'bonn';
  await expect(swapped.catalogue.loadManifest('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
  expect(swapped.requests).toHaveLength(1);

  const tampered = fixture();
  tampered.manifest.records.bytes += 1;
  await expect(tampered.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] }))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });

  const foreign = fixture();
  foreign.manifest.records.path = 'https://evil.example/catalogue.json.gz';
  await expect(foreign.catalogue.loadManifest('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
  expect(foreign.requests).toHaveLength(1);
});

test('reloads the whole city bundle if a deployment removes a cached asset', async () => {
  const { manifest } = fixture();
  const updated = asset([...records, {
    ...records[0], id: 'new', number: '1234/2026', url: source + 'DS/1234-2026'
  }], 'records', 3);
  const map = asset(geo, 'map', 1);
  let rotated = false;
  const catalogue = createCatalogue({ base, now, fetch: async url => {
    const file = new URL(url).pathname.split('/').pop();
    if (file === 'hannover.json') {
      return Response.json(rotated ? { ...manifest, records: updated.entry } : manifest);
    }
    if (file === updated.entry.path) return new Response(updated.gzip);
    if (file === map.entry.path) return new Response(map.gzip);
    return new Response(null, { status: 404 });
  } });
  await catalogue.loadManifest('Hannover');
  rotated = true;
  const data = await catalogue.loadMap('Hannover');
  expect(data.manifest.records.sha256).toBe(updated.entry.sha256);
  expect(data.records).toHaveLength(3);
  expect(data.features).toEqual(geo);
});
