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

function selectedDgmContext() {
  const ctx={CITY_RAW:'Hannover',allPts:[{lat:52.3630532,lon:9.7059495,props:{year:2024,matched_way_id:'23101052',slope_percent:3.2,slope_source:'SRTM Local Tiles'}}],
    contextLayerState:{ways:{'23101052':{road_slope_percent:-4.4,road_slope_source_id:'hannover.dgm1',road_slope_source:'DGM1',road_slope_resolution_m:1,road_slope_direction:'downhill_along_geometry',road_slope_reliable_for_road:true,road_slope_uncertainty_reasons:[]}},
      meta:{sources:{roadSlope:{sourceId:'hannover.dgm1',manifestSha256:'a'.repeat(64),retrievedAt:'2026-11-08T16:41:39.000Z'}}}}};
  const UA={BUILD:'selected-way-review',contextLayers:{resolveWayAcrossTiles:(state,id)=>state.ways[id]}};
  return {ctx,env:{UA,root:{}}};
}

test('selected loaded DGM way evidence reaches GeoJSON and changes the hashed export snapshot when its profile changes',async()=>{
  const {ctx,env}=selectedDgmContext();
  const first=await api.createManifest(ctx,env);
  const points=api.exportPoints(env.UA,ctx);
  const collection={type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[ctx.allPts[0].lon,ctx.allPts[0].lat]},properties:{year:2024}}]};
  api.attachContextProperties(collection,points);
  expect(collection.features[0].properties).toMatchObject({matched_way_id:'23101052',road_slope_percent:-4.4,road_slope_source_id:'hannover.dgm1',road_slope_direction:'downhill_along_geometry',slope_source:'SRTM Local Tiles'});
  expect(ctx.allPts[0].props).not.toHaveProperty('road_slope_percent');
  expect(first.transformations.find(t=>t.transformationId==='context-evidence').parameters.sources.roadSlope.manifestSha256).toBe('a'.repeat(64));
  ctx.contextLayerState.ways['23101052'].road_slope_percent=-4;
  const second=await api.createManifest(ctx,env);
  expect(second.dataFingerprint).not.toBe(first.dataFingerprint);
  const hash=m=>m.transformations.find(t=>t.transformationId==='context-evidence').parameters.contextDataSha256;
  expect(hash(second)).not.toBe(hash(first));
});

test('projected selected-way evidence is frozen for later attachment instead of sharing mutable loaded rows',()=>{
  const {ctx,env}=selectedDgmContext();const points=api.exportPoints(env.UA,ctx);
  ctx.contextLayerState.ways['23101052'].road_slope_uncertainty_reasons.push('later-change');
  ctx.contextLayerState.ways['23101052'].road_slope_percent=-9;
  expect(points[0].props.road_slope_percent).toBe(-4.4);
  expect(points[0].props.road_slope_uncertainty_reasons).toEqual([]);
});

test('unused or differently pinned Way source facts are not attributed to a protected feature profile',async()=>{
  const {ctx,env}=selectedDgmContext();
  Object.assign(ctx.allPts[0].props,{road_slope_percent:null,road_slope_source_id:'pinned.other',road_slope_missing_reason:'bridge',road_slope_reliable_for_road:false});
  const manifest=await api.createManifest(ctx,env);
  const facts=manifest.transformations.find(t=>t.transformationId==='context-evidence').parameters.sources;
  expect(facts).not.toHaveProperty('roadSlope');
  expect(api.exportPoints(env.UA,ctx)[0].props).toMatchObject({road_slope_source_id:'pinned.other',road_slope_percent:null,road_slope_reliable_for_road:false});
});

test('GeoJSON wrapper binds one selected-way snapshot even if the loaded Way changes while the legacy exporter runs',async()=>{
  const {ctx,env}=selectedDgmContext();
  const sourceFacts=JSON.parse(JSON.stringify(ctx.contextLayerState.meta));
  const root={Blob,saveAs:jest.fn()};
  const UA={...env.UA,exportToCSV:jest.fn(),exportToKML:jest.fn(),exportToGeoJSON:async()=>{
    ctx.contextLayerState.ways['23101052'].road_slope_percent=-9;
    ctx.contextLayerState.ways['23101052'].road_slope_uncertainty_reasons.push('later-state');
    ctx.contextLayerState.meta.sources.roadSlope.manifestSha256='b'.repeat(64);
    const point=ctx.allPts[0];root.saveAs(new Blob([JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[point.lon,point.lat]},properties:{year:2024}}]})]),'selected.geojson');
  }};
  api.install(UA,root);
  const result=await UA.exportToGeoJSON(ctx);
  expect(result.geojson.features[0].properties).toMatchObject({road_slope_percent:-4.4,road_slope_uncertainty_reasons:[]});
  const attached=result.geojson.features[0];
  const roundTrip={CITY_RAW:ctx.CITY_RAW,allPts:[{lat:attached.geometry.coordinates[1],lon:attached.geometry.coordinates[0],props:attached.properties}],contextLayerState:{meta:sourceFacts}};
  const repeated=await api.createManifest(roundTrip,{UA:{BUILD:UA.BUILD},root:{}});
  expect(repeated.dataFingerprint).toBe(result.manifest.dataFingerprint);
});

test('a feature-specific manifest pin is protected even when a loaded Way uses a newer snapshot of the same source',async()=>{
  const {ctx,env}=selectedDgmContext();
  Object.assign(ctx.allPts[0].props,{road_slope_percent:0,road_slope_source_id:'hannover.dgm1',road_slope_manifest_sha256:'c'.repeat(64),road_slope_reliable_for_road:true});
  const first=await api.createManifest(ctx,env);
  const properties=api.exportPoints(env.UA,ctx)[0].props;
  expect(properties).toMatchObject({road_slope_percent:0,road_slope_manifest_sha256:'c'.repeat(64)});
  expect(properties).not.toHaveProperty('road_slope_direction');
  const facts=first.transformations.find(t=>t.transformationId==='context-evidence').parameters.sources;
  expect(facts).not.toHaveProperty('roadSlope');
  ctx.contextLayerState.ways['23101052'].road_slope_percent=99;
  ctx.contextLayerState.meta.sources.roadSlope.manifestSha256='b'.repeat(64);
  expect((await api.createManifest(ctx,env)).dataFingerprint).toBe(first.dataFingerprint);
});

test('a null-only legacy placeholder without any selected profile cannot borrow global DGM source facts',async()=>{
  const {ctx,env}=selectedDgmContext();
  ctx.contextLayerState.ways={};ctx.allPts[0].props.road_slope_percent=null;
  const manifest=await api.createManifest(ctx,env);
  expect(manifest.transformations.find(t=>t.transformationId==='context-evidence').parameters.sources).not.toHaveProperty('roadSlope');
});

test('a manifest prebound by an outer export wrapper retains its original selected-way snapshot',async()=>{
  const {ctx,env}=selectedDgmContext();const bound=await api.createManifest(ctx,env);ctx.exportSourceManifest=bound;
  ctx.contextLayerState.ways['23101052'].road_slope_percent=-9;
  const root={Blob,saveAs:jest.fn()};
  const UA={...env.UA,exportToCSV:jest.fn(),exportToKML:jest.fn(),exportToGeoJSON:async()=>{
    const point=ctx.allPts[0];root.saveAs(new Blob([JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',geometry:{type:'Point',coordinates:[point.lon,point.lat]},properties:{year:2024}}]})]),'bound.geojson');
  }};
  api.install(UA,root);const result=await UA.exportToGeoJSON(ctx);
  expect(result.manifest.dataFingerprint).toBe(bound.dataFingerprint);
  expect(result.geojson.features[0].properties.road_slope_percent).toBe(-4.4);
});
