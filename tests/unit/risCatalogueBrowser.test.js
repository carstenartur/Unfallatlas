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

function replaceAsset({ manifest, assets }, kind, payload, count) {
  const replacement = asset(payload, kind, count);
  manifest[kind] = replacement.entry;
  assets.set(replacement.entry.path, replacement.gzip);
}

test('searches the selected same-origin city and loads its map only on demand', async () => {
  const { catalogue, requests, index, map } = fixture();
  const result = await catalogue.search({ city: 'Hannover', searchTerms: ['Hannover', 'Lindener Stichkanal'] });
  expect(result.references.map(({ number }) => number)).toEqual(['1047/2026', '1047/2026 F1']);
  expect(result.meta).toMatchObject({ searchStatus: 'partial-results', sourceFingerprint: index.entry.sha256 });
  expect(result.references[0]).toMatchObject({
    snapshot: {
      city: 'hannover', generatedAt: '2026-11-06T10:00:00Z', sha256: index.entry.sha256, mapSha256: map.entry.sha256,
    },
    aiGating: { allowed: false }
  });
  expect(requests).toEqual([
    'https://example.org/Unfallatlas/data/ris/hannover.json',
    `https://example.org/Unfallatlas/data/ris/${index.entry.path}`
  ]);
  expect((await catalogue.loadMap('Hannover')).features).toEqual(geo);
  expect(requests[2]).toBe(`https://example.org/Unfallatlas/data/ris/${map.entry.path}`);
});

test('reloads the map manifest on request even when the cached manifest is fresh', async () => {
  const data = fixture();
  expect((await data.catalogue.loadMap('Hannover')).features).toEqual(geo);
  const next = { ...geo, features: [{ ...geo.features[0], geometry: {
    type: 'LineString', coordinates: [[9.70, 52.36], [9.71, 52.37]],
  } }] };
  replaceAsset(data, 'map', next, 1);
  expect((await data.catalogue.loadMap('Hannover')).features).toEqual(geo);
  const result = await data.catalogue.loadMap('Hannover', { revalidate: true });
  expect(result.features).toEqual(next);
  expect(result.records[0].snapshot.mapSha256).toBe(data.manifest.map.sha256);
  expect(data.requests.filter(url => url.endsWith('/hannover.json'))).toHaveLength(2);
  expect(data.requests.filter(url => url.endsWith(data.index.entry.path))).toHaveLength(1);
});

test('rejects a non-string map hash before returning search references', async () => {
  const data = fixture();
  data.manifest.map.sha256 = [data.manifest.map.sha256];
  await expect(data.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] }))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('finds named locations with or without mapped geometry after direct title matches', async () => {
  const data = fixture();
  const locations = [
    { label: 'Schneiderberg', kind: 'street', evidence: { source: 'document', text: 'am Schneiderberg' }, mapped: true },
    { label: 'Nienburger Straße', kind: 'street', evidence: { source: 'document', text: 'an der Nienburger Straße' }, mapped: false },
  ];
  replaceAsset(data, 'records', [
    { ...records[0], locations },
    { ...records[1], relatedTo: undefined, title: 'Verkehr am Schneiderberg' },
  ], 2);
  const search = searchTerms => data.catalogue.search({ city: 'Hannover', searchTerms });
  expect((await search(['Schneiderberg'])).references.map(({ id }) => id)).toEqual(['1047-2026F1', '1047-2026']);
  expect((await search(['Nienburger Strasse'])).references).toMatchObject([{ id: '1047-2026', locations }]);
  expect(data.requests).toHaveLength(2);
});

test('loads more than one indexed map feature from a single record', async () => {
  const data = fixture();
  const locations = [
    { label: 'Schneiderberg', kind: 'street', evidence: { source: 'document', text: 'am Schneiderberg' }, mapped: true },
    { label: 'Nienburger Straße', kind: 'street', evidence: { source: 'document', text: 'an der Nienburger Straße' }, mapped: true },
  ];
  replaceAsset(data, 'records', [{ ...records[0], locations }], 1);
  const features = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[9.71, 52.38], [9.72, 52.39]] },
      properties: { recordId: records[0].id, accuracy: 'derived', locationIndex: 0, label: 'Schneiderberg' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[9.70, 52.38], [9.71, 52.39]] },
      properties: { recordId: records[0].id, accuracy: 'derived', locationIndex: 1, label: 'Nienburger Straße' } },
  ] };
  replaceAsset(data, 'map', features, 2);
  const result = await data.catalogue.loadMap('Hannover');
  expect(result.records).toMatchObject([{ id: records[0].id, locations }]);
  expect(result.features).toEqual(features);
});

test('rejects indexed features that refer to the wrong location in a verified records asset', async () => {
  const data = fixture();
  replaceAsset(data, 'records', [{ ...records[0], locations: [
    { label: 'Schneiderberg', kind: 'street', evidence: { source: 'document', text: 'am Schneiderberg' }, mapped: false },
  ] }, records[1]], 2);
  const indexed = { ...geo.features[0], properties: {
    recordId: records[0].id, accuracy: 'derived', locationIndex: 0, label: 'Schneiderberg',
  } };
  replaceAsset(data, 'map', { type: 'FeatureCollection', features: [indexed] }, 1);
  await expect(data.catalogue.loadMap('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('rejects a hashed search asset that includes geometry in its location metadata', async () => {
  const data = fixture();
  replaceAsset(data, 'records', [{ ...records[0], locations: [
    { label: 'Schneiderberg', kind: 'street', evidence: { source: 'title', text: 'am Schneiderberg' },
      mapped: true, geometry: geo.features[0].geometry },
  ] }, records[1]], 2);
  await expect(data.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] }))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test.each(['citywide', 'selected-bodies'])('accepts the shared %s coverage scope in the browser', async scope => {
  const data = fixture();
  data.manifest.coverage.scope = scope;
  const result = await data.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] });
  expect(result.meta.coverage.scope).toBe(scope);
});

test('rejects an unknown coverage scope in the browser', async () => {
  const data = fixture();
  data.manifest.coverage.scope = 'probably-everywhere';
  await expect(data.catalogue.loadMap('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('preserves an unresolved assessment through search without sharing mutable cached state', async () => {
  const data = fixture();
  const locationAssessment = {
    status: 'unresolved', sources: ['title'], reasons: ['no_specific_location'], truncated: false,
  };
  replaceAsset(data, 'records', [{ ...records[0], locationAssessment }], 1);
  data.manifest.locationAssessment = { attempted: 1, mapped: 0, partial: 0, unresolved: 1, unavailable: 0, truncated: 0 };
  const params = { city: 'Hannover', searchTerms: ['Stichkanal'] };
  const result = await data.catalogue.search(params);
  expect(result.references[0].locationAssessment).toEqual(locationAssessment);
  result.references[0].locationAssessment.sources.push('official');
  result.references[0].locationAssessment.reasons.length = 0;
  expect((await data.catalogue.search(params)).references[0].locationAssessment).toEqual({
    status: 'unresolved', sources: ['title'], reasons: ['no_specific_location'], truncated: false,
  });
});

test.each([
  { status: 'invented', sources: ['title'], reasons: ['no_specific_location'], truncated: false },
  { status: 'unresolved', sources: ['meeting'], reasons: ['no_specific_location'], truncated: false },
  { status: 'unresolved', sources: ['title'], reasons: ['<img src=x>'], truncated: false },
  { status: 'mapped', sources: ['title'], reasons: [], truncated: false },
])('rejects an unsupported or inconsistent assessment in a hashed record %j', async locationAssessment => {
  const data = fixture();
  replaceAsset(data, 'records', [{ ...records[0], locationAssessment }], 1);
  await expect(data.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] }))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('rejects manifest assessment totals that disagree with the verified record asset', async () => {
  const data = fixture();
  replaceAsset(data, 'records', [{ ...records[0], locationAssessment: {
    status: 'unresolved', sources: ['title'], reasons: ['no_specific_location'], truncated: false,
  } }], 1);
  data.manifest.locationAssessment = { attempted: 1, mapped: 1, partial: 0, unresolved: 0, unavailable: 0, truncated: 0 };
  await expect(data.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] }))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('loads an official feature and an indexed derived feature from the same assessed record', async () => {
  const data = fixture();
  replaceAsset(data, 'records', [{ ...records[0],
    locations: [{ kind: 'street', label: 'Schneiderberg', mapped: true,
      evidence: { source: 'document', text: 'auf dem Schneiderberg' } }],
    locationAssessment: { status: 'mapped', sources: ['title', 'document', 'official'], reasons: [], truncated: false },
  }], 1);
  const features = { type: 'FeatureCollection', features: [
    { ...geo.features[0], properties: { recordId: records[0].id, accuracy: 'official' } },
    { ...geo.features[0], properties: { recordId: records[0].id, accuracy: 'derived', locationIndex: 0, label: 'Schneiderberg' } },
  ] };
  replaceAsset(data, 'map', features, 2);
  expect((await data.catalogue.loadMap('Hannover')).features).toEqual(features);
});

test('rejects an official assessment without an official feature when loading the map', async () => {
  const data = fixture();
  replaceAsset(data, 'records', [{ ...records[0],
    locationAssessment: { status: 'mapped', sources: ['title', 'official'], reasons: [], truncated: false },
  }], 1);
  await expect(data.catalogue.loadMap('Hannover')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
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

test.each([
  ['mapped', 'citywide', [], false],
  ['partial', 'selected-bodies', ['document_text_unavailable', 'evidence_truncated', 'location_limit'], true],
  ['unresolved', 'citywide', ['unverified_name', 'unmapped_location', 'non_traffic_address'], false],
  ['unavailable', 'selected-bodies', ['gazetteer_unavailable'], false],
])('the JSON schema contract covers a %s search reference and its coverage scope', async (status, scope, reasons, truncated) => {
  const data = fixture();
  const locations = status === 'mapped' || status === 'partial' ? [{
    kind: 'street', label: 'Lindener Stichkanal', mapped: true, evidence: { source: 'title', text: records[0].title },
  }] : [];
  replaceAsset(data, 'records', [{ ...records[0], locations,
    locationAssessment: { status, sources: ['title'], reasons, truncated },
  }], 1);
  data.manifest.coverage.scope = scope;
  const result = await data.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] });
  const reference = result.references[0];
  expect(Object.keys(reference).filter(field => !Object.hasOwn(referenceSchema.properties, field))).toEqual([]);
  const assessment = referenceSchema.properties.locationAssessment;
  expect(Object.keys(reference.locationAssessment).sort()).toEqual(assessment.required.slice().sort());
  expect(assessment.properties.status.enum).toContain(reference.locationAssessment.status);
  for (const source of reference.locationAssessment.sources) expect(assessment.properties.sources.items.enum).toContain(source);
  for (const reason of reference.locationAssessment.reasons) expect(assessment.properties.reasons.items.enum).toContain(reason);
  const coverageProperties = resultSchema.properties.meta.properties.coverage.properties;
  expect(Object.keys(result.meta.coverage).filter(field => !Object.hasOwn(coverageProperties, field))).toEqual([]);
  expect(coverageProperties.scope.enum).toContain(result.meta.coverage.scope);
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

test('rejects adoption from a changed map and still accepts a legacy reference without a map hash', async () => {
  const data = fixture();
  const { references: [reference] } = await data.catalogue.search({ city: 'Hannover', searchTerms: ['Stichkanal'] });
  const legacySnapshot = { ...reference.snapshot };
  delete legacySnapshot.mapSha256;
  const previous = { ...reference, snapshot: { ...legacySnapshot, mapSha256: data.map.entry.sha256 } };
  replaceAsset(data, 'map', { type: 'FeatureCollection', features: [] }, 0);
  await expect(data.catalogue.resolveReferences('Hannover', [previous]))
    .rejects.toMatchObject({ code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH' });
  await expect(data.catalogue.resolveReferences('Hannover', [{ ...reference, snapshot: legacySnapshot }]))
    .resolves.toMatchObject([{ id: reference.id, snapshot: { mapSha256: data.manifest.map.sha256 } }]);
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
