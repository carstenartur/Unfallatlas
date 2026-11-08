/** @jest-environment node */
'use strict';
const api = require('../../js/ua.export_provenance');
const typedTraffic = require('../fixtures/typed-traffic-evidence');
const environment = { UA: { BUILD: 'context-test' }, root: {} };
const context = props => ({ CITY_RAW: 'Köln', allPts: [{ lat: 50.93, lon: 6.95, props: { year: 2024, ...props } }] });

test('export source manifest binds actual typed source and changes when context evidence changes', async () => {
  const ctx = context(typedTraffic('count', 18504));
  const first = await api.createManifest(ctx, environment);
  expect(first.sources).toEqual(expect.arrayContaining([expect.objectContaining({
    sourceId: 'traffic.count.runtime-fixture', contentHash: 'a'.repeat(64), retrievedAt: '2026-11-01T00:00:00Z' })]));
  expect(first.transformations.find(item => item.transformationId === 'context-evidence').parameters.observations[0].direction).toBe('A → B');
  Object.assign(ctx.allPts[0].props, typedTraffic('count', 22153));
  const second = await api.createManifest(ctx, environment);
  expect(second.dataFingerprint).not.toBe(first.dataFingerprint);
});

test('coarse terrain source facts remain explicit and an unknown retrieval time is never invented', async () => {
  const ctx = context({ elevation_m: 0, slope_percent: 0, slope_source: 'SRTM Local Tiles', slope_resolution_m: 30 });
  ctx.contextLayerState = { meta: { sources: { dem: { source: 'SRTM Local Tiles', retrievedAt: null, processedAt: '2026-07-01' } } } };
  const manifest = await api.createManifest(ctx, environment);
  const provenance = manifest.transformations.find(item => item.transformationId === 'context-evidence').parameters;
  expect(provenance.sources.dem.retrievedAt).toBeNull();
  expect(provenance.fieldCounts.elevation_m).toEqual({ present: 1, null: 0 });
  expect(provenance.contextDataSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(manifest.sources).toHaveLength(1); // incomplete source facts cannot become a complete licensed source record
});

test('GeoJSON context binding preserves typed evidence and fails closed for a different population', () => {
  const points = context(typedTraffic('model', 0)).allPts;
  const collection = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point',
    coordinates: [6.95, 50.93] }, properties: { year: 2024 } }] };
  api.attachContextProperties(collection, points);
  expect(collection.features[0].properties.traffic_volume_value).toBe(0);
  expect(collection.features[0].properties.traffic_evidence.observation.source.contentHash).toBe('a'.repeat(64));
  expect(() => api.attachContextProperties({ ...collection, features: [] }, points)).toThrow(/population/);
});

test('an accident-only document snapshot can explicitly omit unused context fields', async () => {
  const ctx = context(typedTraffic('count', 18504));
  ctx.exportContextEvidence = false;
  const first = await api.createManifest(ctx, environment);
  expect(first.sources).toHaveLength(1);
  expect(first.transformations.some(item => item.transformationId === 'context-evidence')).toBe(false);
  Object.assign(ctx.allPts[0].props, typedTraffic('count', 22153));
  expect((await api.createManifest(ctx, environment)).dataFingerprint).toBe(first.dataFingerprint);
});

test('10,000 same-source points retain a small manifest instead of repeated context payloads', async () => {
  const props = { year: 2024, ...typedTraffic('count', 18504), traffic_artifact: {
    sha256: 'a'.repeat(64), artifactFingerprint: 'b'.repeat(64),
    matcher: { algorithm: 'directional-fixture' }, sources: { osm: { sha256: 'c'.repeat(64) } },
  } };
  const ctx = { CITY_RAW: 'Köln', allPts: Array.from({ length: 10000 }, (_, index) => ({
    lat: 50.93 + index / 1000000, lon: 6.95, props,
  })) };
  const manifest = await api.createManifest(ctx, environment);
  const bytes = Buffer.byteLength(JSON.stringify(manifest));
  expect(bytes < 16000).toBe(true);
  const provenance = manifest.transformations.find(item => item.transformationId === 'context-evidence').parameters;
  expect(provenance).not.toHaveProperty('points');
  expect(provenance.pointCount).toBe(10000);
  expect(provenance.contextDataSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(provenance.observations).toHaveLength(1);
  expect(provenance.artifacts).toHaveLength(1);
  expect(provenance.fieldCounts.traffic_volume_value.present).toBe(10000);
  const exported = { type: 'FeatureCollection', features: ctx.allPts.map(point => ({ type: 'Feature',
    geometry: { type: 'Point', coordinates: [point.lon, point.lat] }, properties: { year: 2024 } })) };
  api.attachContextProperties(exported, ctx.allPts);
  const roundTrip = JSON.parse(JSON.stringify(exported));
  expect(roundTrip.features).toHaveLength(10000);
  expect(roundTrip.features[9999].properties.traffic_evidence).toEqual(props.traffic_evidence);
  expect(roundTrip.features[9999].properties.traffic_artifact).toEqual(props.traffic_artifact);
}, 60000);

test.each(['observationId', 'direction', 'year', 'value', 'source', 'match'])('context %s changes invalidate both compact context hash and data fingerprint', async field => {
  const ctx = context(typedTraffic('count', 18504));
  const first = await api.createManifest(ctx, environment);
  const changed = JSON.parse(JSON.stringify(ctx.allPts[0].props));
  const observation = changed.traffic_evidence.observation;
  if (field === 'year') { observation.year = 2018; changed.traffic_volume_year = 2018; }
  else if (field === 'value') { observation.value = 22153; changed.traffic_volume_value = 22153; }
  else if (field === 'source') observation.source.contentHash = 'b'.repeat(64);
  else if (field === 'match') changed.traffic_evidence.distanceMeters = 17;
  else observation[field] += '-changed';
  ctx.allPts[0].props = changed;
  const second = await api.createManifest(ctx, environment);
  const hash = manifest => manifest.transformations.find(item => item.transformationId === 'context-evidence').parameters.contextDataSha256;
  expect(second.dataFingerprint).not.toBe(first.dataFingerprint);
  expect(hash(second)).not.toBe(hash(first));
});

test('compact terrain summary keeps null distinct from zero and binds that change', async () => {
  const ctx = context({ elevation_m: 0, slope_percent: 0, slope_source: 'SRTM Local Tiles' });
  ctx.contextLayerState = { meta: { sources: { dem: { retrievedAt: null } } } };
  const first = await api.createManifest(ctx, environment);
  ctx.allPts[0].props.elevation_m = null;
  const second = await api.createManifest(ctx, environment);
  const params = manifest => manifest.transformations.find(item => item.transformationId === 'context-evidence').parameters;
  expect(params(first).fieldCounts.elevation_m).toEqual({ present: 1, null: 0 });
  expect(params(second).fieldCounts.elevation_m).toEqual({ present: 0, null: 1 });
  expect(params(second).sources.dem.retrievedAt).toBeNull();
  expect(params(first).contextDataSha256).not.toBe(params(second).contextDataSha256);
  expect(first.dataFingerprint).not.toBe(second.dataFingerprint);
});
