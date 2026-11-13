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
  expect(api.buildContextNote(environment.UA, ctx).sources[0].url).toBe('https://registry.opendata.aws/terrain-tiles/');
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
    contextLayerState:{ways:{'23101052':{road_slope_percent:-4.4,road_slope_source_id:'hannover.dgm1',road_slope_source:'DGM1',road_slope_resolution_m:1,road_slope_direction:'downhill_along_geometry',road_slope_reliable_for_road:true,road_slope_manifest_sha256:'a'.repeat(64),road_slope_uncertainty_reasons:[]}},
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

describe('visible typed context sources use the exported evidence population', () => {
  const UA = { BUILD: 'context-note-regression', trafficProvider: require('../../js/ua.traffic_provider') };
  test.each([['count',2024,'Gemessene Verkehrsbelastung'],['model',2025,'Verkehrsmodell'],['count',2019,'Älterer gemessener Verkehrswert']])('%s/%s preserves type, source, unit, period and matching facts', (type,year,label) => {
    const ctx = context(typedTraffic(type,0,year));
    const note = api.buildContextNote(UA,ctx);
    const text = [note.body,...note.sources.map(source=>source.label)].join(' ');
    expect(text).toContain(label);
    expect(text).toContain('Kfz/24 h');
    expect(text).toContain('DTVw');
    expect(text).toContain(String(year));
    expect(text).toContain('A nach B');
    expect(text).toContain('high');
    expect(text).toContain('0 m');
    expect(text).not.toContain('keine gemessene Verkehrsdichte');
    expect(note.sources.some(source=>source.url==='https://example.org/traffic.csv')).toBe(true);
  });
  test('proxy has no invented numeric unit, measurement or source timestamp', () => {
    const note=api.buildContextNote(UA,context({traffic_measurement_type:'proxy',traffic_proxy_class:'high',traffic_proxy_basis:'highway=primary'}));
    expect(note.body+' '+note.sources.map(s=>s.label).join(' ')).toMatch(/Proxy.*keine (Verkehrs)?zählung/i);
    expect(JSON.stringify(note)).not.toMatch(/Kfz\/24 h|2026-11-01/);
  });
  test('selected DGM Way source replaces generic SRTM attribution and preserves unknown clock/quality', () => {
    const {ctx,env}=selectedDgmContext();
    delete ctx.allPts[0].props.slope_source;
    delete ctx.allPts[0].props.slope_percent;
    Object.assign(ctx.contextLayerState.meta.sources.roadSlope,{retrievedAt:null,datasetUrl:'https://example.org/dgm1'});
    const note=api.buildContextNote(env.UA,ctx);
    const text=JSON.stringify(note);
    expect(text).toContain('hannover.dgm1');
    expect(text).toContain('DGM1');
    expect(text).toContain('1 m');
    expect(text).toContain('Abruf unbekannt');
    expect(text).not.toContain('SRTM');
    expect(note.sources.some(source=>source.url==='https://example.org/dgm1')).toBe(true);
  });
  test('documents show a signed, identified road profile once for repeated accidents on the same way', () => {
    const {ctx, env} = selectedDgmContext();
    Object.assign(ctx.contextLayerState.ways['23101052'], {
      road_slope_quality: 'high', road_slope_profile_window_m: 50, road_slope_sample_count: 35,
    });
    ctx.allPts.push({...ctx.allPts[0], lat: 52.3631});
    const labels = api.buildContextNote(env.UA, ctx).sources.map(source => source.label);
    const profiles = labels.filter(label => label.includes('OSM-Weg 23101052'));
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatch(/-4,4 %.*bergab entlang der Way-Geometrie/);
    expect(profiles[0]).toContain('Profilqualität hoch');
    expect(profiles[0]).toContain('Profilfenster 50 m');
    expect(profiles[0]).toContain('35 Stützstellen');
  });

  test('mixed signs across ways report only the absolute range, without a mean travel direction', () => {
    const {ctx, env} = selectedDgmContext();
    ctx.allPts.push({...ctx.allPts[0], props: {...ctx.allPts[0].props, matched_way_id: '2'}});
    ctx.contextLayerState.ways['2'] = {...ctx.contextLayerState.ways['23101052'],
      road_slope_percent: 0, road_slope_direction: 'approximately_flat'};
    const sources = api.buildContextNote(env.UA, ctx).sources.map(source => source.label);
    const ranges = sources.filter(label => label.includes('Neigungsbeträge'));
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toContain('2 Straßenprofile');
    expect(ranges[0]).toContain('0,0 bis 4,4 %');
    expect(ranges[0]).not.toMatch(/bergauf|bergab/);
  });

  test('excludes out-of-scope evidence and rejects unsupported count labels', () => {
    const ctx=context(typedTraffic('count',0,2024));
    ctx.selectionBounds={contains:()=>false};
    expect(api.buildContextNote(UA,ctx)).toBeNull();
    ctx.selectionBounds={contains:()=>true};
    delete ctx.allPts[0].props.traffic_evidence;
    const note=api.buildContextNote(UA,ctx);
    expect(note===null || !JSON.stringify(note).includes('Gemessene Verkehrsbelastung')).toBe(true);
  });
});

test('an unbound road source cannot borrow the terrain source clock or link',()=>{
  const {ctx,env}=selectedDgmContext();
  ctx.contextLayerState.meta.sources={dem:{retrievedAt:'2026-11-01T00:00:00Z',datasetUrl:'https://example.org/unrelated-srtm'},roadSlope:{sourceId:'different.dgm',retrievedAt:'2026-11-02T00:00:00Z',datasetUrl:'https://example.org/unrelated-dgm'}};
  const note=api.buildContextNote(env.UA,ctx);
  expect(JSON.stringify(note)).toContain('Abruf unbekannt');
  expect(JSON.stringify(note)).not.toContain('unrelated');
  expect(JSON.stringify(note)).not.toContain('2026-11-0');
});

test('a legacy SRTM way row links its known terrain dataset without borrowing its snapshot clock', () => {
  const ctx = context({
    road_slope_percent: 0.2,
    road_slope_source: 'SRTM Local Tiles',
    road_slope_source_id: 'global.srtm30',
    road_slope_resolution_m: 30,
    road_slope_reliable_for_road: false,
    road_slope_method: 'median_segments',
  });
  ctx.contextLayerState = { meta: { sources: { roadSlope: {
    sourceId: 'global.srtm30',
    retrievedAt: '2026-11-02T00:00:00Z',
    datasetUrl: 'https://example.org/unrelated-snapshot',
  } } } };

  const { sources } = api.buildContextNote({}, ctx);
  expect(sources).toHaveLength(1);
  expect(sources[0].label).toMatch(/Geländekontext.*Auflösung 30 m.*Abruf unbekannt/);
  expect(sources[0].label).not.toContain('Methode');
  expect(sources[0].url).toBe('https://registry.opendata.aws/terrain-tiles/');
});

test('visible source grouping retains observation-specific coverage limits',()=>{
  const ctx=context(JSON.parse(JSON.stringify(typedTraffic('count',0,2024))));
  ctx.allPts[0].props.traffic_evidence.observation={...ctx.allPts[0].props.traffic_evidence.observation,qualityNotes:['Nur 350 vollständige Zähltage im geprüften Testfall.']};
  expect(JSON.stringify(api.buildContextNote({},ctx))).toContain('350 vollständige Zähltage');
});

test('original bicycle hourly evidence retains its explicit mode, original unit/value and unknown matching',()=>{
  const row=require('../fixtures/typed-hourly-traffic-evidence')();
  expect(require('../../js/ua.traffic_provider').hasUsableTypedEvidence(row,{mode:'bicycle'})).toBe(true);
  expect(api.contextProperties(row).traffic_volume_unit).toBe('Fahrräder/Stunde');
  const note=api.buildContextNote({},context(row));
  expect(JSON.stringify(note)).toContain('1 Fahrräder/Stunde');
  expect(JSON.stringify(note)).toContain('bicycle');
  expect(JSON.stringify(note)).toContain('Entfernung unbekannt');
  expect(JSON.stringify(note)).not.toContain('Kfz/24 h');
  const invalid=JSON.parse(JSON.stringify(row));
  invalid.traffic_evidence.observation.mode='invented-mode';
  expect(api.contextProperties(invalid).traffic_evidence).toBeUndefined();
  expect(api.buildContextNote({},context(invalid))).toBeNull();
});
test('visible count notes preserve zero and original18504 as a qualified range without summation',()=>{
  const ctx=context(typedTraffic('count',0,2024));
  ctx.allPts.push({lat:50.94,lon:6.95,props:{year:2024,...typedTraffic('count',18504,2024)}});
  const text=JSON.stringify(api.buildContextNote({},ctx));
  expect(text).toContain('Spanne ausgewählter Originalwerte: 0–18.504 Kfz/24 h');
  expect(text).toContain('keine Summe oder Zeitumrechnung');
});

test('document note deduplicates only exact bound source notes while standalone context preserves them', async()=>{
  const row=require('../fixtures/typed-hourly-traffic-evidence')();
  const ctx=context(row);
  const manifest=await api.createManifest(ctx,environment);
  const bound=api.bindExportContext({},ctx,manifest);
  const sourceNote=row.traffic_evidence.observation.source.qualityNotes[0];
  const observationNote=row.traffic_evidence.observation.qualityNotes[0];
  const standalone=JSON.stringify(api.buildContextNote({},bound));
  expect(standalone).toContain(sourceNote);
  const document=JSON.stringify(api.buildContextNote({},bound,{sourceDetailsIncluded:true}));
  expect(document).not.toContain(sourceNote);
  expect(document).toContain(observationNote);
  expect(document).toContain('Detaillierte Quellenhinweise');
  expect(manifest.sources.find(s=>s.sourceId===row.traffic_evidence.observation.source.sourceId).qualityNotes).toContain(sourceNote);
  // A caller lacking the actual bound matching source cannot suppress evidence.
  expect(JSON.stringify(api.buildContextNote({},ctx,{sourceDetailsIncluded:true}))).toContain(sourceNote);
  const missing={...bound,exportSourceManifest:{...manifest,sources:manifest.sources.map(s=>({...s,qualityNotes:[]}))}};
  expect(JSON.stringify(api.buildContextNote({},missing,{sourceDetailsIncluded:true}))).toContain(sourceNote);
  const different={...bound,exportSourceManifest:{...manifest,sources:manifest.sources.map(s=>({...s,contentHash:'f'.repeat(64)}))}};
  expect(JSON.stringify(api.buildContextNote({},different,{sourceDetailsIncluded:true}))).toContain(sourceNote);
});

test.each(['manifest','distribution','missing-meta-pin','missing-row-pin'])('same source ID cannot lend clock/link to a road profile with %s mismatch',async mismatch=>{
  const {ctx,env}=selectedDgmContext();
  const good=ctx.contextLayerState.ways['23101052'];
  Object.assign(good,{road_slope_manifest_sha256:'a'.repeat(64),road_slope_distribution_sha256:'b'.repeat(64)});
  const bad={...good,road_slope_resolution_m:2};
  ctx.contextLayerState.ways.bad=bad;
  ctx.allPts.push({lat:52.364,lon:9.706,props:{year:2024,matched_way_id:'bad'}});
  const source = ctx.contextLayerState.meta.sources.roadSlope;
  Object.assign(source,{distributionSha256:'b'.repeat(64),datasetUrl:'https://example.org/exact-dgm'});
  if (mismatch === 'manifest') bad.road_slope_manifest_sha256 = 'c'.repeat(64);
  if (mismatch === 'distribution') bad.road_slope_distribution_sha256 = 'c'.repeat(64);
  if (mismatch === 'missing-meta-pin') { delete good.road_slope_distribution_sha256; delete source.distributionSha256; }
  if (mismatch === 'missing-row-pin') delete bad.road_slope_distribution_sha256;
  const manifest=await api.createManifest(ctx,env);
  const note=api.buildContextNote(env.UA,api.bindExportContext(env.UA,ctx,manifest));
  const matching=note.sources.find(s=>s.label.includes('Auflösung 1 m'));
  const different=note.sources.find(s=>s.label.includes('Auflösung 2 m'));
  expect(matching.label).toContain('2026-11-08T16:41:39.000Z');expect(matching.url).toBe('https://example.org/exact-dgm');
  expect(different.label).toContain('Abruf unbekannt');expect(different.url).toBeNull();
});

test('a matching malformed pin cannot bind road profile source metadata', async () => {
  const { ctx, env } = selectedDgmContext();
  ctx.contextLayerState.ways['23101052'].road_slope_manifest_sha256 = 'malformed';
  ctx.contextLayerState.meta.sources.roadSlope.manifestSha256 = 'malformed';

  const manifest = await api.createManifest(ctx, env);
  expect(manifest.transformations.find(item => item.transformationId === 'context-evidence').parameters.sources)
    .not.toHaveProperty('roadSlope');
});

test.each([false, true])('a pinless road grade keeps its value without borrowing source provenance (metadata pinned: %s)', async metadataPinned => {
  const { ctx, env } = selectedDgmContext();
  const row = ctx.contextLayerState.ways['23101052'];
  delete row.road_slope_manifest_sha256;
  const source = ctx.contextLayerState.meta.sources.roadSlope;
  if (!metadataPinned) delete source.manifestSha256;
  Object.assign(source, {
    datasetUrl: 'https://example.org/another-dgm',
    licenseUrl: 'https://example.org/another-license',
    requiredAttribution: 'Nicht zugeordnete Quelle',
    acquisitionPeriod: 'Andere Befliegung',
  });

  const manifest = await api.createManifest(ctx, env);
  const bound = api.bindExportContext(env.UA, ctx, manifest);
  expect(bound.allPts[0].props).toMatchObject({ road_slope_percent: -4.4, road_slope_reliable_for_road: true });
  expect(manifest.transformations.find(item => item.transformationId === 'context-evidence').parameters.sources)
    .not.toHaveProperty('roadSlope');
  const { sources } = api.buildContextNote(env.UA, bound);
  expect(sources).toHaveLength(1);
  expect(sources[0].label).toMatch(/Straßenprofil.*DGM1.*Abruf unbekannt/);
  expect(sources[0].url).toBeNull();
});
