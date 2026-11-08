'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {
  gzipSync
} = require('node:zlib');
const P = require('../../../js/ua.ris-partitions');
const grid = require('../../../js/ua.spatial-grid');
const {
  partitionInternals: I
} = require('./risSnapshot');
const {
  snapshotFormat: F
} = require('../../../js/ua.ris-catalogue');
function chunks(entries, limit = P.FANOUT, budget = P.MAX_BYTES - 1024) {
  const out = [];
  let batch = [],
    size = 40;
  for (const entry of entries) {
    const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > budget) throw new Error('RIS entry exceeds bounded partition size; geometry must be simplified by its verified source');
    if (batch.length && (batch.length >= limit || size + bytes > budget)) {
      out.push(batch);
      batch = [];
      size = 40;
    }
    batch.push(entry);
    size += bytes;
  }
  if (batch.length) out.push(batch);
  return out;
}
function pages(target, id, items) {
  const batches = chunks(items, P.PAGE_SIZE, 120000);
  let start = 0;
  batches.forEach((batch, i) => {
    target.push([P.key(id, i), {
      items: batch,
      start,
      total: items.length,
      nextPage: i + 1 < batches.length ? i + 1 : null
    }]);
    start += batch.length;
  });
}
async function tree(directory, city, kind, entries) {
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  for (let i = 1; i < entries.length; i++) if (entries[i][0] === entries[i - 1][0]) throw new Error('Duplicate RIS index key');
  async function put(type, rows) {
    const raw = Buffer.from(JSON.stringify({
      type,
      entries: rows
    }));
    if (raw.length > P.MAX_BYTES) throw new Error('RIS partition exceeds size limit');
    const sha256 = I.digest(raw),
      reference = {
        path: `${city}.${sha256}.${kind}.json.gz`,
        sha256,
        bytes: raw.length,
        count: rows.length,
        kind
      };
    await I.installAsset(directory, {
      bytes: gzipSync(raw),
      reference
    }, kind);
    return reference;
  }
  let level = [];
  for (const batch of entries.length ? chunks(entries) : [[]]) level.push([batch.at(-1)?.[0] || '', await put('leaf', batch)]);
  while (level.length > 1) {
    const next = [];
    for (const batch of chunks(level)) next.push([batch.at(-1)[0], await put('branch', batch)]);
    level = next;
  }
  return level[0][1];
}
function tileKeys(bounds) {
  try {
    return grid.tilesForBounds({
      west: bounds[0],
      south: bounds[1],
      east: bounds[2],
      north: bounds[3]
    }, 12, {
      maxTiles: 64
    }).map(tile => typeof tile === 'string' ? tile : `${tile[0]}/${tile[1]}`);
  } catch (error) {
    if (error.code === 'SPATIAL_TILE_LIMIT') return ['global'];
    throw error;
  }
}
async function writePartitionedSnapshot(directory, city, catalogue, {
  now = Date.now
} = {}) {
  I.assertCity(city);
  const {
      sources,
      hosts
    } = I.normalizeSources(catalogue.sources, city),
    coverage = I.normalizeCoverage(catalogue.coverage);
  const features = [];
  const migrated = catalogue.features?.features;
  const {
    records,
    byId
  } = I.normalizeRecords(catalogue.records, hosts, undefined, migrated ? undefined : (r, id) => I.collectSourceLocations(r, id, features, Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (migrated) features.push(...migrated);
  if (!F.validMap({
    type: 'FeatureCollection',
    features
  }, byId, features.length, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid RIS partition map');
  if (!I.validLocationRevision(catalogue.locationRevision)) throw new Error('Invalid RIS location revision');
  const generatedAt = I.timestamp(catalogue.generatedAt || new Date(typeof now === 'function' ? now() : now).toISOString());
  const refreshFailure = catalogue.refreshFailure ? I.normalizeRefreshFailure(catalogue.refreshFailure, generatedAt) : undefined;
  const indices = Object.fromEntries(P.ROOTS.map(k => [k, []]));
  const locationLists = new Map(),
    relationLists = new Map(),
    terms = new Map(),
    geometries = new Map(),
    links = new Map(),
    tiles = new Map(),
    recordGeometry = new Map();
  const add = (map, k, v) => {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  };
  for (const r of records) {
    const locations = (r.locations || []).map(l => ({
      ...l,
      id: `location:${I.digest(Buffer.from(JSON.stringify([r.id, l.kind, l.label, l.evidence])))}`
    }));
    locationLists.set(r.id, locations);
    const {
      locations: ignored,
      ...compact
    } = r;
    indices.records.push([r.id, {
      ...compact,
      locationCount: locations.length,
      ...(r.locations === undefined ? {} : {
        hasLocations: true
      })
    }]);
    if (r.relatedTo) {
      add(relationLists, r.id, r.relatedTo);
      add(relationLists, r.relatedTo, r.id);
    }
    const words = new Set(P.fold([r.title, r.number, ...locations.map(l => l.label)].join(' ')).split(' ').filter(Boolean));
    for (const word of words) add(terms, word, r.id);
  }
  for (const f of features) {
    const p = f.properties,
      location = locationLists.get(p.recordId)?.[p.locationIndex];
    // Geometry identity excludes the record and paging/year partition.
    const geometryId = `geometry:${I.digest(Buffer.from(JSON.stringify(f.geometry)))}`;
    if (location) location.geometryId = geometryId;
    add(recordGeometry, p.recordId, geometryId);
    if (!geometries.has(geometryId)) geometries.set(geometryId, {
      type: 'Feature',
      geometry: f.geometry,
      properties: {
        geometryId,
        accuracy: p.accuracy,
        label: p.label || '',
        recordCount: 0
      },
      bounds: grid.geometryBounds(f.geometry)
    });else if (geometries.get(geometryId).properties.accuracy !== p.accuracy) geometries.get(geometryId).properties.accuracy = 'mixed';
    add(links, geometryId, {
      recordId: p.recordId,
      locationId: location?.id || `location:${I.digest(Buffer.from(JSON.stringify([p.recordId, geometryId])))}`,
      ...(p.locationIndex === undefined ? {} : {
        locationIndex: p.locationIndex
      }),
      accuracy: p.accuracy,
      label: p.label || ''
    });
  }
  for (const [id, geometry] of geometries) {
    geometry.properties.recordCount = new Set(links.get(id).map(l => l.recordId)).size;
    indices.geometry.push([id, geometry]);
    for (const tile of tileKeys(geometry.bounds)) add(tiles, tile, id);
  }
  for (const [id, items] of locationLists) pages(indices.locations, id, items);
  // Store each connected family once, plus a tiny per-record membership entry.
  const visited = new Set();
  for (const first of relationLists.keys()) {
    if (visited.has(first)) continue;
    const members = [],
      queue = [first];
    visited.add(first);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      members.push(id);
      for (const neighbor of relationLists.get(id) || []) if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
    members.sort();
    const component = `component:${I.digest(Buffer.from(members[0]))}`;
    members.forEach((id, position) => indices.relations.push([`member:${id}`, {component, position}]));
    pages(indices.relations, component, members);
  }
  for (const [word, items] of terms) pages(indices.search, word, items);
  for (const [id, items] of links) pages(indices.links, id, items);
  for (const [id, items] of recordGeometry) pages(indices.links, `record:${id}`, [...new Set(items)]);
  for (const [tile, items] of tiles) pages(indices.spatial, tile, [...new Set(items)]);
  const levels = [0, 4, 6, 8];
  let overviewZoom = 8;
  for (const feature of geometries.values()) {
    while (overviewZoom && grid.tileRange({
      west: feature.bounds[0],
      south: feature.bounds[1],
      east: feature.bounds[2],
      north: feature.bounds[3]
    }, overviewZoom).count > 256) overviewZoom = levels[levels.indexOf(overviewZoom) - 1];
  }
  for (const zoom of levels.filter(z => z <= overviewZoom)) {
    const cells = new Map();
    for (const [id, feature] of geometries) {
      const b = feature.bounds;
      for (const [x, y] of grid.tilesForBounds({
        west: b[0],
        south: b[1],
        east: b[2],
        north: b[3]
      }, zoom, {
        maxTiles: 256
      })) {
        const key = `overview:${zoom}/${x}/${y}`;
        if (!cells.has(key)) cells.set(key, {
          bounds: grid.tileBounds(x, y, zoom),
          records: new Set(),
          geometryCount: 0
        });
        const cell = cells.get(key);
        cell.geometryCount++;
        for (const link of links.get(id)) cell.records.add(link.recordId);
      }
    }
    for (const [key, cell] of cells) indices.spatial.push([key, {
      bounds: cell.bounds,
      count: cell.records.size,
      geometryCount: cell.geometryCount
    }]);
  }
  await fs.mkdir(directory, {
    recursive: true
  });
  const roots = {};
  for (const kind of P.ROOTS) roots[kind] = await tree(directory, city, kind, indices[kind]);
  const generation = I.digest(Buffer.from(JSON.stringify(roots)));
  const locationAssessment = I.summarizeLocationAssessments(records);
  const manifest = {
    schemaVersion: 2,
    city,
    generatedAt,
    sources,
    coverage,
    generation,
    gridZoom: 12,
    recordCount: records.length,
    mappedRecordCount: recordGeometry.size,
    geometryCount: geometries.size,
    overviewZoom,
    roots,
    ...(catalogue.locationRevision === undefined ? {} : {
      locationRevision: catalogue.locationRevision
    }),
    ...(locationAssessment ? {
      locationAssessment
    } : {}),
    ...(refreshFailure ? {
      refreshFailure
    } : {})
  };
  const raw = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  if (raw.length > 262144) throw new Error('RIS manifest exceeds size limit');
  await I.withTemporaryFile(directory, `${city}.json`, raw, fs.rename);
  return manifest;
}
async function checkedManifest(directory, value) {
  const m = typeof value === 'string' ? I.decodeJson(await I.readBounded(path.join(directory, `${value}.json`), 262144, 'manifest'), 'manifest') : value;
  if (m.schemaVersion === 1) return m;
  P.manifest(m, m.city);
  I.assertCity(m.city);
  I.normalizeSources(m.sources, m.city);
  I.normalizeCoverage(m.coverage);
  I.timestamp(m.generatedAt);
  if (m.refreshFailure) I.normalizeRefreshFailure(m.refreshFailure, m.generatedAt);
  if (!I.validLocationRevision(m.locationRevision)
      || !I.validLocationAssessmentSummary(m.locationAssessment, m.recordCount)) throw new Error('Invalid RIS partition metadata');
  if (I.digest(Buffer.from(JSON.stringify(m.roots))) !== m.generation) throw new Error('RIS generation integrity check failed');
  return m;
}
async function enumerateSnapshotAssets(directory, value, {
  loadAsset
} = {}) {
  const m = await checkedManifest(directory, value);
  if (m.schemaVersion === 1) {
    I.assertCity(m.city);
    I.normalizeSources(m.sources, m.city);
    I.normalizeCoverage(m.coverage);
    I.timestamp(m.generatedAt);
    const refs = [I.normalizeDescriptor(m.records, m.city, 'records', 1, 50000), I.normalizeDescriptor(m.map, m.city, 'map', 0, m.records.count * 8)];
    for (let i = 0; i < refs.length; i++) {
      if (loadAsset) await loadAsset(refs[i]);
      await I.readAsset(directory, refs[i], i ? 'map' : 'records');
    }
    return refs;
  }
  const reader = P.createReader({
      manifest: m,
      load: async ref => {
        if (loadAsset) await loadAsset(ref);
        return I.readAsset(directory, ref, ref.kind);
      }
    }),
    assets = new Map();
  for (const kind of P.ROOTS) await reader.walk(kind, ref => {
    assets.set(ref.path, ref);
  });
  return [...assets.values()];
}
async function readPartitionedSnapshot(directory, city, value) {
  I.assertCity(city);
  const m = await checkedManifest(directory, value || city);
  if (m.city !== city) throw new Error('RIS snapshot city mismatch');
  const reader = P.createReader({
      manifest: m,
      load: ref => I.readAsset(directory, ref, ref.kind)
    }),
    records = [],
    features = [];
  let geometryCount = 0;
  const all = async (kind, id) => {
    const items = [];
    let page = 0;
    do {
      const result = await reader.page(kind, id, page);
      items.push(...result.items);
      page = result.nextPage;
    } while (page !== null);
    return items;
  };
  for (const kind of P.ROOTS) await reader.walk(kind, async (ref, node) => {
    if (node.type !== 'leaf') return;
    if (kind === 'records') for (const [, record] of node.entries) {
      const locations = await all('locations', record.id);
      if(locations.length!==record.locationCount || (record.hasLocations!==undefined && record.hasLocations!==true) || (record.locationCount>0 && record.hasLocations!==true))throw new Error('RIS location count or presence metadata mismatch');
      const {
        locationCount,
        hasLocations,
        ...plain
      } = record;
      records.push({
        ...plain,
        ...(hasLocations ? {
          locations: locations.map(({
            id,
            geometryId,
            ...l
          }) => l)
        } : {})
      });
    }
    if (kind === 'geometry') geometryCount += node.entries.length;
    if (kind === 'geometry') for (const [id, feature] of node.entries) for (const link of await all('links', id)) features.push({
      type: 'Feature',
      geometry: feature.geometry,
      properties: {
        recordId: link.recordId,
        accuracy: link.accuracy,
        ...(link.label ? {
          label: link.label
        } : {}),
        ...(link.locationIndex === undefined ? {} : {
          locationIndex: link.locationIndex
        })
      }
    });
  });
  if (geometryCount !== m.geometryCount
      || new Set(features.map(f => f.properties.recordId)).size !== m.mappedRecordCount) throw new Error('RIS map count mismatch');
  const {
      hosts
    } = I.normalizeSources(m.sources, city),
    normalized = I.normalizeRecords(records, hosts, m.recordCount, undefined, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (!F.validMap({
    type: 'FeatureCollection',
    features
  }, normalized.byId, features.length, Number.MAX_SAFE_INTEGER)
      || !I.validLocationAssessmentSummary(m.locationAssessment, records.length, records)) throw new Error('Invalid RIS partition records/map');
  return {
    manifest: m,
    records: normalized.records,
    features: {
      type: 'FeatureCollection',
      features
    }
  };
}
module.exports = {
  writePartitionedSnapshot,
  readPartitionedSnapshot,
  enumerateSnapshotAssets
};
