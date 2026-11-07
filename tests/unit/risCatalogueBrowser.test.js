/** @jest-environment node */
'use strict';

const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { createCatalogue, searchSnapshot } = require('../../js/ua.ris-catalogue.js');
const referenceSchema = require('../../server/political-context/schemas/politicalReference.schema.json');
const resultSchema = require('../../server/political-context/schemas/politicalReferenceSearchResult.schema.json');

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

function fixture(clock = now) {
  const index = asset(records, 'records', 2);
  const map = asset(geo, 'map', 1);
  const manifest = {
    schemaVersion: 1, city: 'hannover', generatedAt: '2026-11-06T10:00:00Z',
    sources: [source],
    coverage: { from: '2025-01-01', to: '2026-11-06', bodies: ['Ratsversammlung'], complete: false, warnings: ['Auswahl'] },
    records: index.entry, map: map.entry
  };
  const requests = [];
  const assets = new Map([[index.entry.path, index.gzip], [map.entry.path, map.gzip]]);
  const fetch = async (url) => {
    requests.push(url);
    const file = new URL(url).pathname.split('/').pop();
    if (file === 'hannover.json') return Response.json(manifest);
    if (assets.has(file)) return new Response(assets.get(file));
    return new Response(null, { status: 404 });
  };
  return { manifest, index, map, requests, assets, catalogue: createCatalogue({ base, fetch, now: clock }) };
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
  manifest.generatedAt = '2026-10-29T10:00:00Z';
  expect(searchSnapshot({ manifest, records }, params, now()).meta).toMatchObject({
    searchStatus: 'incomplete', stale: true
  });
});

test('rejects an inverted coverage interval before using the data to report an empty search', async () => {
  const { manifest, catalogue, requests } = fixture();
  Object.assign(manifest.coverage, { complete: true, from: '2026-12-31', to: '2026-01-01' });
  await expect(catalogue.search({ city: 'Hannover', searchTerms: ['Oxfordstraße'] }))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
  expect(requests).toHaveLength(1);
});

test('rejects malformed coverage labels and impossible dates even when the payload hash matches', async () => {
  const invalidCoverage = fixture();
  invalidCoverage.manifest.coverage.bodies = [{}];
  await expect(invalidCoverage.catalogue.loadManifest('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });

  const { manifest, assets, catalogue } = fixture();
  const invalid = asset([{ ...records[0], date: '2026-02-31' }, records[1]], 'records', 2);
  manifest.records = invalid.entry;
  assets.set(invalid.entry.path, invalid.gzip);
  await expect(catalogue.search({ city: 'Hannover', searchTerms: ['Oxfordstraße'] }))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('checks a refreshed descriptor even when the asset path was cached', async () => {
  let clock = now();
  const { manifest, catalogue } = fixture(() => clock);
  const params = { city: 'Hannover', searchTerms: ['Stichkanal'] };
  expect((await catalogue.search(params)).references).toHaveLength(2);
  clock = new Date(clock.getTime() + 6 * 60_000);
  manifest.records.bytes += 1;
  await expect(catalogue.search(params)).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('marks a recent failed refresh incomplete and expires the fallback from search and map', async () => {
  let clock = now();
  const { manifest, catalogue } = fixture(() => clock);
  const reason = 'Die letzte Aktualisierung der amtlichen Ratsdaten ist fehlgeschlagen.';
  manifest.coverage.complete = true;
  manifest.refreshFailure = {
    attemptedAt: '2026-11-07T09:00:00.000Z', reason, expiresAt: '2026-11-20T10:00:00.000Z'
  };
  const params = { city: 'Hannover', searchTerms: ['Oxfordstraße'] };
  expect((await catalogue.search(params)).meta).toMatchObject({
    searchStatus: 'incomplete', stale: false, warnings: expect.arrayContaining([expect.stringContaining(reason)])
  });
  expect((await catalogue.loadMap('Hannover')).records[0].snapshot).toMatchObject({
    complete: false, stale: false, warnings: expect.arrayContaining([expect.stringContaining(reason)])
  });
  clock = new Date(manifest.refreshFailure.expiresAt);
  await expect(catalogue.search(params)).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_EXPIRED' });
  await expect(catalogue.loadMap('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_EXPIRED' });
});

test('expires a catalogue even if no failed-refresh manifest reached the browser', async () => {
  let clock = new Date('2026-11-20T09:59:59Z');
  const { catalogue } = fixture(() => clock);
  expect((await catalogue.loadMap('Hannover')).records).toHaveLength(2);
  clock = new Date('2026-11-20T10:00:00Z');
  expect(catalogue.hasManifest('Hannover')).toBe(false);
  await expect(catalogue.loadMap('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_EXPIRED' });
});

test('documents the provenance fields emitted in a fallback search response', () => {
  const { manifest } = fixture();
  manifest.refreshFailure = {
    attemptedAt: '2026-11-07T09:00:00.000Z', reason: 'Aktualisierung fehlgeschlagen.',
    expiresAt: '2026-11-20T10:00:00.000Z'
  };
  const result = searchSnapshot({ manifest, records }, { city: 'Hannover', searchTerms: ['Stichkanal'] }, now());
  const metaProperties = resultSchema.properties.meta.properties;
  const referenceProperties = referenceSchema.properties.snapshot.properties;
  expect(Object.keys(result.meta).filter(field => !Object.hasOwn(metaProperties, field))).toEqual([]);
  expect(Object.keys(result.meta.refreshFailure).sort()).toEqual(metaProperties.refreshFailure.required.slice().sort());
  expect(Object.keys(result.references[0].snapshot).filter(field => !Object.hasOwn(referenceProperties, field))).toEqual([]);
});

test('checks the current verified catalogue before adopting a reference', async () => {
  const { manifest, catalogue, requests, assets } = fixture();
  const { references: [reference] } = await catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] });
  expect(typeof catalogue.resolveReferences).toBe('function');
  const forged = { ...reference, title: 'Ungeprüfter Titel' };
  await expect(catalogue.resolveReferences('Hannover', [forged])).resolves.toEqual([reference]);
  expect(requests.filter(url => url.endsWith('/hannover.json'))).toHaveLength(2);
  await expect(catalogue.resolveReferences('Hannover', [{ ...reference, id: 'not-in-catalogue' }]))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH' });
  const next = asset([...records, { ...records[0], id: 'new', url: source + 'DS/4321-2026' }], 'records', 3);
  manifest.records = next.entry;
  assets.set(next.entry.path, next.gzip);
  await expect(catalogue.resolveReferences('Hannover', [reference])).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH'
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
