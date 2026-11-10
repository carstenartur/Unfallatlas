/** @jest-environment node */
'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  writeRisSnapshot,
  readRisSnapshot,
  enumerateSnapshotAssets
} = require('../../server/political-context/services/risSnapshot');
const {
  createCatalogue
} = require('../../js/ua.ris-catalogue');
const now = () => new Date('2026-11-08T00:00:00Z');
const source = 'https://example.org/ris/';
const record = (id, extra = {}) => ({
  id,
  title: `Schulweg ${id}`,
  type: 'Antrag',
  number: id,
  date: '2020-01-01',
  gremium: null,
  url: source + id,
  source: 'RIS',
  ...extra
});
let dir;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-parts-'));
});
afterEach(async () => {
  await fs.rm(dir, {
    recursive: true,
    force: true
  });
});
const write = records => writeRisSnapshot(dir, 'test', {
  records,
  sources: [source],
  coverage: {
    from: '2014-01-01',
    to: '2026-11-08',
    bodies: [],
    warnings: [],
    complete: true
  }
}, {
  now,
  schemaVersion: 2
});
function browser(requests = []) {
  return createCatalogue({
    base: 'https://example.org/',
    now,
    fetch: async url => {
      const file = new URL(url).pathname.split('/').pop();
      requests.push(file);
      try {
        return new Response(await fs.readFile(path.join(dir, file)));
      } catch {
        return new Response(null, {
          status: 404
        });
      }
    }
  });
}
test('publishes exact level totals from unique documents, including those without geometry', async () => {
  const positions = [7, 7.1].map((longitude, i) => ({
    label: `Ort ${i}`, kind: 'place', evidence: { source: 'title', text: `Ort ${i}` },
    geometry: { type: 'Point', coordinates: [longitude, 51] },
  }));
  const manifest = await write([
    record('city-mapped', { source: 'hannover-sim', locations: positions }),
    record('city-unmapped', { source: 'hannover-sim' }),
    record('regional', { source: 'region-hannover-ris' }),
    record('state', { source: 'niedersachsen-landtag' }),
    record('unclassified'),
  ]);
  expect(manifest.levelCounts).toEqual({
    city: { records: 2, mapped: 1 },
    region: { records: 1, mapped: 0 },
    state: { records: 1, mapped: 0 },
    unknown: { records: 1, mapped: 0 },
  });
  const requests = [];
  await expect(browser(requests).loadManifest('test')).resolves.toMatchObject({ levelCounts: manifest.levelCounts });
  expect(requests).toEqual(['test.json']);

  const swapped = { ...manifest.levelCounts,
    city: { records: 1, mapped: 1 }, region: { records: 2, mapped: 0 } };
  await fs.writeFile(path.join(dir, 'test.json'), JSON.stringify({ ...manifest, levelCounts: swapped }));
  await expect(readRisSnapshot(dir, 'test')).rejects.toThrow(/level counts/i);
  await fs.writeFile(path.join(dir, 'test.json'), JSON.stringify({
    ...manifest, levelCounts: { ...swapped, city: { records: 1, mapped: 0 } },
  }));
  await expect(browser().loadManifest('test')).rejects.toMatchObject({ code: 'RIS_SNAPSHOT_INVALID' });
});

test('publishes >50k records with bounded directories and loads local geometry without record partitions', async () => {
  const rows = Array.from({
    length: 50001
  }, (_, i) => record(`id-${i}`, i === 0 ? {
    geometry: {
      type: 'Point',
      coordinates: [7, 51]
    },
    locationSource: 'official'
  } : {}));
  const manifest = await write(rows);
  expect(manifest.schemaVersion).toBe(2);
  expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(16384);
  const assets = await enumerateSnapshotAssets(dir, manifest);
  expect(assets.length).toBeGreaterThan(100);
  expect(assets.every(a => a.bytes <= 262144)).toBe(true);
  const requests = [];
  const catalogue = browser(requests);
  const map = await catalogue.loadMap('test', {
    bounds: [6.9, 50.9, 7.1, 51.1],
    zoom: 14
  });
  expect(map.features.features).toHaveLength(1);
  expect(map.partitioned).toBe(true);
  expect(requests.some(p => p.includes('.records.'))).toBe(false);
  expect((await catalogue.loadFeatureRecords('test', map.features.features[0].properties.geometryId)).records[0].id).toBe('id-0');
  expect((await catalogue.search({
    city: 'test',
    searchTerms: ['id 50000']
  })).references.some(r => r.id === 'id-50000')).toBe(true);
}, 120000);
test('preserves paged locations and cross-year unmapped reverse relations', async () => {
  const locations = Array.from({
    length: 90
  }, (_, i) => ({
    label: `Ort ${i}`,
    kind: 'place',
    evidence: {
      source: 'title',
      text: `Ort ${i}`
    },
    geometry: {
      type: 'Point',
      coordinates: [7 + i / 1000, 51]
    }
  }));
  await write([record('parent', {
    locations
  }), record('child', {
    date: '2026-01-01',
    relatedTo: 'parent'
  })]);
  const c = browser();
  const first = await c.loadRecordLocations('test', 'parent');
  expect(first.total).toBe(90);
  expect(first.nextPage).toBe(1);
  expect((await c.loadRecordLocations('test', 'parent', 1)).locations).toHaveLength(26);
  expect((await c.loadRelatedRecords('test', 'parent')).records[0].id).toBe('child');
  const full = await readRisSnapshot(dir, 'test');
  expect(full.records.find(r => r.id === 'parent').locations).toHaveLength(90);
  expect(full.features.features).toHaveLength(90);
});
test('corrupt or missing parts never yield a complete empty result', async () => {
  const m = await write([record('one')]);
  await fs.unlink(path.join(dir, m.roots.records.path));
  await expect(browser().loadRecord('test', 'one')).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_ASSET_MISSING'
  });
  await expect(enumerateSnapshotAssets(dir, m)).rejects.toThrow();
});
test('popular official geometries have bounded links, crossing multipart geometry is retained, and generations cannot mix', async () => {
  const geometry = {
    type: 'MultiLineString',
    coordinates: [[[6, 51], [8, 51]], [[7, 50], [7, 52]]]
  };
  await write(Array.from({
    length: 140
  }, (_, i) => record(`r-${i}`, {
    geometry,
    locationSource: 'official',
    locationLabel: 'Straße'
  })));
  const c = browser(),
    m = await c.loadMap('test', {
      bounds: [6.99, 50.99, 7.01, 51.01]
    });
  expect(m.features.features).toHaveLength(1);
  const feature = m.features.features[0];
  expect(feature.geometry).toEqual(geometry);
  expect(feature.properties.recordCount).toBe(140);
  const first = await c.loadFeatureRecords('test', feature.properties.geometryId, 0, {
    snapshot: m.manifest
  });
  expect(first.records).toHaveLength(64);
  expect(first.nextPage).toBe(1);
  expect(first.links[0].locationId).toMatch(/^location:/);
  expect(first.records[0].geometryIds).toEqual([feature.properties.geometryId]);
  const selected = first.records[0];
  await write([record('replacement')]);
  await expect(c.resolveReferences('test', [selected])).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH'
  });
  await expect(c.loadFeatureRecords('test', feature.properties.geometryId, 0, {
    snapshot: m.manifest
  })).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH'
  });
});
test('corrupt immutable payload and oversized geometry fail without replacing the published manifest', async () => {
  const m = await write([record('one')]);
  await fs.writeFile(path.join(dir, m.roots.records.path), Buffer.from('corrupt gzip'));
  await expect(browser().loadRecord('test', 'one')).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_INVALID'
  });
  const before = await fs.readFile(path.join(dir, 'test.json'), 'utf8');
  const geometry = {
    type: 'LineString',
    coordinates: Array.from({
      length: 20000
    }, (_, i) => [7 + i / 100000, 51 + i / 100000])
  };
  await expect(write([record('large', {
    geometry,
    locationSource: 'official'
  })])).rejects.toThrow(/bounded partition size/);
  expect(await fs.readFile(path.join(dir, 'test.json'), 'utf8')).toBe(before);
});
test('migrates official geometry without locations, preserving original source age and fallback provenance', async () => {
  const generatedAt = '2026-11-01T00:00:00.000Z',
    refreshFailure = {
      attemptedAt: '2026-11-07T00:00:00.000Z',
      expiresAt: '2026-11-15T00:00:00.000Z',
      reason: 'Source unavailable'
    };
  const input = {
    records: [record('official')],
    sources: [source],
    coverage: {
      from: '2014-01-01',
      to: '2026-11-01',
      bodies: [],
      warnings: [],
      complete: false
    },
    generatedAt,
    refreshFailure,
    features: {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [7, 51]
        },
        properties: {
          recordId: 'official',
          accuracy: 'official'
        }
      }]
    }
  };
  const m = await writeRisSnapshot(dir, 'test', input, {
    schemaVersion: 2,
    now
  });
  expect(m.generatedAt).toBe(generatedAt);
  expect(m.refreshFailure).toEqual(refreshFailure);
  const loaded = await readRisSnapshot(dir, 'test');
  expect(loaded.records).toEqual(input.records);
  expect(loaded.features).toEqual(input.features);
});
test('deduplicates geometry across labels/provenance, provides coarse cells and traverses whole cross-year families', async () => {
  const geometry = {
    type: 'Point',
    coordinates: [7, 51]
  };
  const m = await write([record('a', {
    geometry,
    locationSource: 'official',
    locationLabel: 'Amtlich'
  }), record('b', {
    relatedTo: 'a',
    date: '2021-01-01',
    geometry,
    locationSource: 'derived',
    locationLabel: 'Abgeleitet'
  }), record('c', {
    relatedTo: 'b',
    date: '2022-01-01'
  }), record('d', {
    relatedTo: 'c',
    date: '2023-01-01'
  })]);
  expect(m.mappedRecordCount).toBe(2);
  expect(m.geometryCount).toBe(1);
  const c = browser(),
    local = await c.loadMap('test', {
      bounds: [6.99, 50.99, 7.01, 51.01]
    });
  expect(local.features.features[0].properties.accuracy).toBe('mixed');
  const records = await c.loadFeatureRecords('test', local.features.features[0].properties.geometryId);
  expect(new Set(records.links.map(l => l.accuracy))).toEqual(new Set(['official', 'derived']));
  expect((await c.loadRelatedRecords('test', 'a')).records.map(r => r.id)).toEqual(['b', 'c', 'd']);
  const overview = await c.loadMap('test', {
    bounds: [-180, -80, 180, 80]
  });
  expect(overview.overview).toBe(true);
  expect(overview.features.features.length).toBeGreaterThan(0);
  expect(overview.features.features.every(f => f.geometry.type === 'Polygon' && f.properties.overview && f.properties.count === 2)).toBe(true);
});
test('map query byte budget falls back to bounded summary cells before reading all large geometries', async () => {
  const rows = Array.from({
    length: 32
  }, (_, j) => record(`long-${j}`, {
    geometry: {
      type: 'LineString',
      coordinates: Array.from({
        length: 7000
      }, (_, i) => [7 + i / 1000000, 51 + j / 100000 + i / 1000000])
    },
    locationSource: 'official'
  }));
  await write(rows);
  const requests = [];
  const result = await browser(requests).loadMap('test', {
    bounds: [6.99, 50.99, 7.02, 51.02]
  });
  expect(result.overview).toBe(true);
  expect(result.features.features.every(f => f.properties.overview)).toBe(true);
  expect(requests.filter(file => file.endsWith('.geometry.json.gz')).length).toBeLessThan(32);
});
test('v2 returned references remain schema-valid and never emit an unbounded location list', async () => {
  const referenceSchema = require('../../server/political-context/schemas/politicalReference.schema.json');
  const resultSchema = require('../../server/political-context/schemas/politicalReferenceSearchResult.schema.json');
  const locations = Array.from({
    length: 90
  }, (_, i) => ({
    label: `Ort ${i}`,
    kind: 'place',
    evidence: {
      source: 'title',
      text: `Ort ${i}`
    }
  }));
  await write([record('many', {
    locations
  })]);
  const result = await browser().search({
    city: 'test',
    searchTerms: ['Ort 89']
  });
  expect(result.references).toHaveLength(1);
  expect(result.references[0].locations).toHaveLength(64);
  expect(result.references[0].locationCount).toBe(90);
  expect(Object.keys(result.references[0]).filter(key => !Object.hasOwn(referenceSchema.properties, key))).toEqual([]);
  expect(Object.keys(result.meta).filter(key => !Object.hasOwn(resultSchema.properties.meta.properties, key))).toEqual([]);
  expect(referenceSchema.properties.locations.maxItems).toBe(64);
  for (const location of result.references[0].locations) expect(Object.keys(location).filter(key => !Object.hasOwn(referenceSchema.properties.locations.items.properties, key))).toEqual([]);
});
test('valid hashes do not excuse record-key mismatches or inconsistent location page totals', async () => {
  const {
      createHash
    } = require('node:crypto'),
    {
      gzipSync,
      gunzipSync
    } = require('node:zlib');
  const hash = raw => createHash('sha256').update(raw).digest('hex');
  async function rewrite(kind, change) {
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'test.json'), 'utf8'));
    const ref = manifest.roots[kind];
    const leaf = JSON.parse(gunzipSync(await fs.readFile(path.join(dir, ref.path))));
    change(leaf);
    const raw = Buffer.from(JSON.stringify(leaf));
    ref.sha256 = hash(raw);
    ref.bytes = raw.length;
    ref.path = `test.${ref.sha256}.${kind}.json.gz`;
    await fs.writeFile(path.join(dir, ref.path), gzipSync(raw));
    manifest.generation = hash(Buffer.from(JSON.stringify(manifest.roots)));
    await fs.writeFile(path.join(dir, 'test.json'), JSON.stringify(manifest));
  }
  const locations = Array.from({
    length: 90
  }, (_, i) => ({
    label: `Ort ${i}`,
    kind: 'place',
    evidence: {
      source: 'title',
      text: `Ort ${i}`
    }
  }));
  await write([record('one', {
    locations
  })]);
  await rewrite('records', leaf => {
    leaf.entries[0][1].id = 'two';
  });
  await expect(browser().loadRecord('test', 'one')).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_INVALID'
  });
  await rewrite('locations', leaf => {
    leaf.entries[1][1].total = 100;
  });
  await expect(browser().loadRecordLocations('test', 'one', 1)).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_INVALID'
  });
});
async function rewriteRootForTest(kind, change) {
  const {
      createHash
    } = require('node:crypto'),
    {
      gzipSync,
      gunzipSync
    } = require('node:zlib');
  const hash = raw => createHash('sha256').update(raw).digest('hex');
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'test.json'), 'utf8'));
  const ref = manifest.roots[kind];
  const leaf = JSON.parse(gunzipSync(await fs.readFile(path.join(dir, ref.path))));
  change(leaf);
  const raw = Buffer.from(JSON.stringify(leaf));
  ref.count = leaf.entries.length;
  ref.sha256 = hash(raw);
  ref.bytes = raw.length;
  ref.path = `test.${ref.sha256}.${kind}.json.gz`;
  await fs.writeFile(path.join(dir, ref.path), gzipSync(raw));
  manifest.generation = hash(Buffer.from(JSON.stringify(manifest.roots)));
  await fs.writeFile(path.join(dir, 'test.json'), JSON.stringify(manifest));
}
test('offline reconstruction rejects absent and shortened first location pages even for unmapped evidence', async () => {
  const locations = [{
    label: 'Unkartierter Ort',
    kind: 'place',
    evidence: {
      source: 'title',
      text: 'Unkartierter Ort'
    }
  }];
  await write([record('unmapped', {
    locations
  })]);
  await rewriteRootForTest('locations', leaf => {
    leaf.entries = [];
  });
  await expect(readRisSnapshot(dir, 'test')).rejects.toThrow(/location/i);
  await write([record('unmapped', {
    locations: [...locations, {
      ...locations[0],
      label: 'Anderer Ort'
    }]
  })]);
  await rewriteRootForTest('locations', leaf => {
    leaf.entries[0][1].items.pop();
    leaf.entries[0][1].total = 1;
  });
  await expect(readRisSnapshot(dir, 'test')).rejects.toThrow(/location/i);
  await write([record('metadata', { locations })]);
  await rewriteRootForTest('records', leaf => { delete leaf.entries[0][1].hasLocations; });
  await expect(readRisSnapshot(dir, 'test')).rejects.toThrow(/location/i);
});
test.each(['id-000', 'id-065', 'id-129'])('related offsets account for self at any component position: %s', async id => {
  await write(Array.from({
    length: 130
  }, (_, i) => record(`id-${String(i).padStart(3, '0')}`, i ? {
    relatedTo: 'id-000'
  } : {})));
  const c = browser();
  let page = 0,
    end = 0;
  const all = [];
  do {
    const result = await c.loadRelatedRecords('test', id, page);
    expect(result.start).toBe(end);
    expect(result.total).toBe(129);
    end += result.records.length;
    all.push(...result.records);
    page = result.nextPage;
  } while (page !== null);
  expect(end).toBe(129);
  expect(all.some(r => r.id === id)).toBe(false);
});
test('all >500 popular-term matches are reachable through query and generation bound continuations', async () => {
  await write(Array.from({
    length: 621
  }, (_, i) => record(`r-${i}`)));
  const c = browser(),
    params = {
      city: 'test',
      searchTerms: ['Schulweg'],
      maxResults: 30
    };
  let result = await c.search(params),
    first = result;
  const found = new Set(result.references.map(r => r.id));
  let pages = 1;
  expect(typeof result.meta.nextPage).toBe('string');
  expect(result.meta.snapshot.sha256).toBeDefined();
  while (result.meta.nextPage !== null) {
    expect(++pages).toBeLessThan(30);
    result = await c.search({
      ...params,
      page: result.meta.nextPage,
      snapshot: result.meta.snapshot
    });
    result.references.forEach(r => found.add(r.id));
  }
  expect(found.size).toBe(621);
  const continuation = {
    ...params,
    page: first.meta.nextPage,
    snapshot: first.meta.snapshot
  };
  await expect(c.search({
    ...continuation,
    searchTerms: ['Anders']
  })).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_CURSOR_INVALID'
  });
  await expect(c.search({
    ...continuation,
    page: first.meta.nextPage + 'x'
  })).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_CURSOR_INVALID'
  });
  await expect(c.search({
    ...continuation,
    snapshot: {
      ...first.meta.snapshot,
      sha256: '0'.repeat(64)
    }
  })).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH'
  });
  await write([record('changed')]);
  await expect(c.search(continuation)).rejects.toMatchObject({
    code: 'RIS_SNAPSHOT_REFERENCE_MISMATCH'
  });
}, 30000);
test('location scan can resume after an empty bounded search page without losing late evidence', async () => {
  const locations = Array.from({
    length: 9000
  }, (_, i) => ({
    label: i === 8999 ? 'Letzter Spezialort' : `Ort ${i}`,
    kind: 'place',
    evidence: {
      source: 'title',
      text: `Ort ${i}`
    }
  }));
  await write([record('long-evidence', {
    locations
  })]);
  const c = browser(),
    params = {
      city: 'test',
      searchTerms: ['Letzter Spezialort'],
      maxResults: 15
    };
  let result = await c.search(params);
  expect(result.references).toEqual([]);
  expect(result.meta.nextPage).toMatch(/^ris2\./);
  expect(result.meta.searchStatus).toBe('incomplete');
  let attempts = 0;
  while (!result.references.length && result.meta.nextPage !== null) {
    expect(++attempts).toBeLessThan(10);
    result = await c.search({
      ...params,
      page: result.meta.nextPage,
      snapshot: result.meta.snapshot
    });
  }
  expect(result.references[0].id).toBe('long-evidence');
  expect(result.references[0].locations.length).toBeLessThanOrEqual(64);
  expect(result.references[0].locationCount).toBe(9000);
  expect((await readRisSnapshot(dir, 'test')).records[0].locations).toHaveLength(9000);
}, 30000);
test('overlapping search phrases do not inflate the page match count', async () => {
  await write([record('a', {
    title: 'Schulweg Radverkehr'
  }), record('b', {
    title: 'Schulweg Radverkehr'
  })]);
  const c = browser(),
    result = await c.search({
      city: 'test',
      searchTerms: ['Schulweg', 'Radverkehr'],
      maxResults: 30
    });
  expect(result.references).toHaveLength(2);
  expect(result.meta.totalFound).toBe(2);
  expect(result.meta.nextPage).toBeNull();
  expect(await c.loadRelatedRecords('test', 'a')).toMatchObject({
    start: 0,
    total: 0,
    records: []
  });
  expect(await c.loadRecordGeometries('test', 'a')).toMatchObject({
    start: 0,
    total: 0,
    geometryIds: []
  });
});
