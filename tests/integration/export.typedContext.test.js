'use strict';
const fs=require('node:fs'),path=require('node:path');
const typed=require('../fixtures/typed-traffic-evidence');
const {parseCsv}=require('../../scripts/providers/koeln_kfz_link_csv_provider');
function setup() {
  jest.resetModules();
  window.UA={}; window.saveAs=jest.fn();
  for(const file of ['ua.utils.js','ua.filters.js','ua.accident_views.js','ua.export_v2.js']) {
    (function(window){eval(fs.readFileSync(path.join(__dirname,'../../js',file),'utf8'));})(window);
  }
  const UA=window.UA;
  UA.exportProvenance=require('../../js/ua.export_provenance');
  UA.trafficProvider=require('../../js/ua.traffic_provider');
  UA.exportProvenance.install(UA,window);
  const ctx={CITY_RAW:'Köln',allPts:[2024,2024].map((year,i)=>({lat:50.93+i/100,lon:6.95,props:{year:2024,ustunde:8,...typed('count',i?12000:0,year)}})),
    selectionBounds:{contains:()=>true,getSouth:()=>50,getWest:()=>6,getNorth:()=>51,getEast:()=>7},
    ui:{severityEl:{value:'all'},roadConditionEl:{value:'all'},dayTypeEl:{value:'all'},hFromEl:{value:'0'},hToEl:{value:'23'}}};
  return {UA,ctx};
}
afterEach(()=>{delete window.UA;delete window.saveAs;delete window.fetch;});
test('actual CSV exporter retains each row’s distinct validated traffic evidence, including zero and matching',async()=>{
  const {UA,ctx}=setup();
  const result=await UA.exportToCSV(ctx);
  const rows=parseCsv(result.packageEntries.entries.find(x=>x.name.endsWith('.csv')).content).rows;
  const column=rows[0].indexOf('traffic_evidence');
  expect(column).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(rows[1][column])).toMatchObject({distanceMeters:0,matchQuality:'high',observation:{observationId:'fixture',sourceId:'traffic.count.runtime-fixture',sourceContentHash:'a'.repeat(64)}});
  expect(rows[1][rows[0].indexOf('traffic_volume_value')]).toBe('0');
  expect(rows[2][rows[0].indexOf('traffic_volume_value')]).toBe('12000');
  expect(rows[1][rows[0].indexOf('traffic_volume_period')]).toBe('DTVw');
  expect(rows[1][column]).not.toContain('datasetTitle');
  expect(result.manifest.sources.some(source=>source.sourceId==='traffic.count.runtime-fixture')).toBe(true);
});
test('actual KML builder retains each Placemark’s distinct validated evidence and no invalid claimed count',()=>{
  const {UA,ctx}=setup();
  const api=require('../../js/ua.kml_export_provenance');
  const result=api.buildBaseKml(UA,ctx);
  const xml=new DOMParser().parseFromString(result.kml,'text/xml');
  const points=xml.querySelectorAll('Placemark');
  expect(points).toHaveLength(2);
  points.forEach((point,i)=>{
    expect(JSON.parse(point.querySelector('Data[name="traffic_evidence"] value')?.textContent||'null')).toMatchObject({distanceMeters:0,matchQuality:'high',observation:{sourceId:'traffic.count.runtime-fixture',sourceContentHash:'a'.repeat(64)}});
    expect(point.querySelector('Data[name="traffic_volume_value"] value').textContent).toBe(String(ctx.allPts[i].props.traffic_volume_value));
    expect(point.textContent).not.toContain('datasetTitle');
  });
  delete ctx.allPts[0].props.traffic_evidence;
  const invalid=new DOMParser().parseFromString(api.buildBaseKml(UA,ctx).kml,'text/xml');
  expect(invalid.querySelector('Placemark').querySelector('Data[name="traffic_volume_value"]')).toBeNull();
});
test('report note delegates to the same selected evidence projection used by data exports',()=>{
  const {UA,ctx}=setup();
  ctx.allPts[1].props={year:2024,ustunde:8,...typed('count',12000,2019)};
  ctx.contextCapabilities={hasAny:true};
  const note=UA._pickEnrichmentSourcesNote(ctx);
  expect(JSON.stringify(note)).toContain('Gemessene Verkehrsbelastung');
  expect(JSON.stringify(note)).toContain('Älterer gemessener Verkehrswert');
  expect(JSON.stringify(note)).not.toContain('keine gemessene Verkehrsdichte');
});
test('CSV keeps the exact projected point snapshot while the manifest is being hashed',async()=>{
  const {UA,ctx}=setup();
  // Trigger the real asynchronous window through the runtime build fingerprint.
  window.fetch=async()=>{ctx.allPts[0].props.traffic_volume_value=999;return {ok:false};};
  UA.BUILD='snapshot-race-'+Date.now();
  const result=await UA.exportToCSV(ctx);
  const rows=parseCsv(result.packageEntries.entries.find(x=>x.name.endsWith('.csv')).content).rows;
  expect(ctx.allPts[0].props.traffic_volume_value).toBe(999);
  const col=rows[0].indexOf('traffic_evidence');
  expect(col).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(rows[1][col]).observation.sourceContentHash).toBe('a'.repeat(64));
  expect(rows[1][rows[0].indexOf('traffic_volume_value')]).toBe('0');
  delete window.fetch;
});
test('document boundary binds the visible note and rows to its manifest before asynchronous library loading',async()=>{
  const {UA,ctx}=setup();
  const captured=[];
  UA.artifactProvenance=require('../../js/ua.artifact_provenance');
  UA.__documentProvenanceOriginals={exportToWord:async(bound,report)=>captured.push({bound,report}),exportToPDF:async()=>{}};
  UA.ensureExportLibraries=async()=>{ctx.allPts[0].props.traffic_volume_value=999;};
  window.docx=require('docx');
  require('../../js/ua.document_export_provenance').install(UA,window);
  const preview={structured:{enrichmentSourcesNote:{body:'stale preview'}}};
  const result=await UA.exportToWord(ctx,preview);
  expect(ctx.allPts[0].props.traffic_volume_value).toBe(999);
  expect(captured[0].bound.allPts[0].props.traffic_volume_value).toBe(0);
  expect(JSON.stringify(captured[0].report.structured.enrichmentSourcesNote)).toContain('Gemessene Verkehrsbelastung');
  expect(captured[0].bound.exportSourceManifest.dataFingerprint).toBe(result.manifest.dataFingerprint);
  expect(preview.structured.enrichmentSourcesNote.body).toBe('stale preview');
});
function involvementScope(UA,ctx) {
  Object.assign(ctx.ui,{incBikeEl:{checked:true},incPedEl:{checked:false},incCarEl:{checked:false},incMotoEl:{checked:false},incGkfzEl:{checked:false},incSonEl:{checked:false}});
  ctx.involvementMode='or';
  ctx.allPts[0].props={...ctx.allPts[0].props,istrad:1,istpkw:0};
  ctx.allPts[1].props={year:2024,ustunde:8,istrad:0,istpkw:1,...typed('model',999,2024)};
  (function(window){eval(fs.readFileSync(path.join(__dirname,'../../js/ua.analysis_scope.js'),'utf8'));})(window);
}
test('document note respects real AnalysisScope involvement while the underlying data export retains its own population',async()=>{
  const {UA,ctx}=setup();
  jest.useFakeTimers();
  try {
    involvementScope(UA,ctx);
    expect(UA.AnalysisScope.createScopedContext(ctx).allPts).toHaveLength(1);
    const note=UA._pickEnrichmentSourcesNote(ctx);
    expect(JSON.stringify(note)).toContain('Gemessene Verkehrsbelastung');
    expect(JSON.stringify(note)).not.toContain('Verkehrsmodell');
    expect(UA.exportProvenance.exportPoints(UA,ctx)).toHaveLength(2);
  } finally {jest.clearAllTimers();jest.useRealTimers();}
});
test('normal filtered exporter wrapper keeps its existing explicit active-population contract',async()=>{
  const {UA,ctx}=setup();
  jest.useFakeTimers();
  try {
    involvementScope(UA,ctx);
    (function(window){eval(fs.readFileSync(path.join(__dirname,'../../js/ua.filtered_export_provenance.js'),'utf8'));})(window);
    const scoped=await UA.filteredExportProvenance.scopedContextWithManifest(ctx);
    expect(scoped.allPts).toHaveLength(1);
    expect(scoped.exportSourceManifest.scenario.filters.dataExportInvolvementPolicy).toContain('ausschließlich');
    expect(JSON.stringify(UA._pickEnrichmentSourcesNote(scoped))).not.toContain('Verkehrsmodell');
  } finally {jest.clearAllTimers();jest.useRealTimers();}
});
test('original hourly bicycle value and source survive actual CSV, GeoJSON and KML without motor conversion',async()=>{
  const {UA,ctx}=setup();
  ctx.CITY_RAW='Düsseldorf';
  ctx.allPts=[{lat:51.22015,lon:6.76712,props:{year:2024,ustunde:8,...require('../fixtures/typed-hourly-traffic-evidence')()}}];
  const csv=await UA.exportToCSV(ctx);
  const rows=parseCsv(csv.packageEntries.entries.find(entry=>entry.name.endsWith('.csv')).content).rows;
  expect(rows[1][rows[0].indexOf('traffic_volume_value')]).toBe('1');
  expect(rows[1][rows[0].indexOf('traffic_volume_unit')]).toBe('Fahrräder/Stunde');
  expect(rows[1][rows[0].indexOf('traffic_volume_mode')]).toBe('bicycle');
  const geo=await UA.exportToGeoJSON(ctx);
  expect(geo.geojson.features[0].properties.traffic_evidence.observation.mode).toBe('bicycle');
  expect(geo.manifest.sources.some(source=>source.sourceId==='traffic.count.duesseldorf-mannesmannufer-hourly-2024')).toBe(true);
  const kml=require('../../js/ua.kml_export_provenance').buildBaseKml(UA,ctx);
  const xml=new DOMParser().parseFromString(kml.kml,'text/xml');
  expect(xml.querySelector('Data[name="traffic_volume_unit"] value').textContent).toBe('Fahrräder/Stunde');
  expect(JSON.parse(xml.querySelector('Data[name="traffic_evidence"] value').textContent)).toMatchObject({distanceMeters:null,observation:{mode:'bicycle',value:1}});
});
