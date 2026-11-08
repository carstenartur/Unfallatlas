/** @jest-environment node */
'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {gunzipSync, gzipSync} = require('node:zlib');
const {createHash} = require('node:crypto');
const {writePartitionedSnapshot} = require('../../server/political-context/services/risPartitionedSnapshot');
const {readRisSnapshot, enumerateSnapshotAssets} = require('../../server/political-context/services/risSnapshot');
const {createCatalogue} = require('../../js/ua.ris-catalogue');
const grid = require('../../js/ua.spatial-grid');
const now = () => new Date('2026-11-08T00:00:00Z');
const source = 'https://example.org/ris/';
let directory;
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ris-spatial-')); });
afterEach(async () => { await fs.rm(directory, {recursive:true,force:true}); });
const record = (id, geometry) => ({id,title:`Ort ${id}`,number:id,date:null,gremium:null,type:'Antrag',url:source+id,source:'RIS',geometry,locationSource:'official'});
const publish = (records, options={}) => writePartitionedSnapshot(directory,'test',{records,sources:[source],coverage:{from:null,to:null,bodies:[],warnings:[],complete:true}},{now,...options});
function browser() {
  const requests=[];
  const catalogue=createCatalogue({base:'https://example.org/',now,fetch:async url=>{
    const file=path.basename(new URL(url).pathname);
    try {const data=await fs.readFile(path.join(directory,file));let bytes=data.length;try{if(file.endsWith('.gz'))bytes=gunzipSync(data).length;}catch(_){}requests.push({file,bytes});return new Response(data);}
    catch(error){if(error.code==='ENOENT')return new Response(null,{status:404});throw error;}
  }});
  return {catalogue,requests};
}
const tile=grid.tileBounds(...grid.tilesForBounds({west:13.4,south:52.5,east:13.4,north:52.5},12)[0],12);
const point = (x,y) => [tile[0]+(tile[2]-tile[0])*x,tile[1]+(tile[3]-tile[1])*y];
const boundsAt = (coordinates,radius=0.00001) => [coordinates[0]-radius,coordinates[1]-radius,coordinates[0]+radius,coordinates[1]+radius];

test('12,000 distinct points in one old grid cell remain detailed in a tiny and further narrowed viewport',async()=>{
  const rows=Array.from({length:12000},(_,i)=>record(`p-${i}`,{type:'Point',coordinates:point(0.1+(i%120)*0.8/120,0.1+Math.floor(i/120)*0.8/100)}));
  const manifest=await publish(rows);expect(manifest.spatialFormat).toBe('packed-bounds-v1');
  const wanted=rows[43*120+57].geometry.coordinates;
  for(const [zoom,radius]of [[18,0.00001],[22,0.000001]]){
    const {catalogue,requests}=browser();const result=await catalogue.loadMap('test',{bounds:boundsAt(wanted,radius),zoom});
    expect(result.overview).toBe(false);expect(result.coverage.complete).toBe(true);expect(result.features.features).toHaveLength(1);
    expect(result.features.features[0].geometry.coordinates).toEqual(wanted);
    expect(requests.filter(r=>r.file.endsWith('.geometry.json.gz'))).toHaveLength(0);
    expect(requests.length).toBeLessThan(12);expect(requests.reduce((sum,r)=>sum+r.bytes,0)).toBeLessThan(512*1024);
    expect(await catalogue.loadGeometry('test',result.features.features[0].properties.geometryId)).toEqual(result.features.features[0]);
  }
  expect((await browser().catalogue.loadMap('test',{bounds:tile,zoom:12})).overview).toBe(true);
},30000);

test('spatial packing avoids unrelated complex-line payloads and retains a long crossing multipart geometry',async()=>{
  const center=point(0.5,0.5);
  const crossing={type:'MultiLineString',coordinates:[[point(0.01,0.5),point(0.99,0.5)],[point(0.49,0.49),point(0.51,0.51)]]};
  const rows=[record('point',{type:'Point',coordinates:center}),record('crossing',crossing),...Array.from({length:320},(_,i)=>record(`offscreen-${i}`,{type:'LineString',coordinates:Array.from({length:1000},(_,j)=>point(0.05+(i%20)*0.04+j/1000000,0.65+Math.floor(i/20)*0.015+j/2000000))}))];
  await publish(rows);const {catalogue,requests}=browser();
  const result=await catalogue.loadMap('test',{bounds:boundsAt(center),zoom:20});
  expect(result.overview).toBe(false);expect(result.features.features).toHaveLength(2);
  expect(result.features.features.some(f=>JSON.stringify(f.geometry)===JSON.stringify(crossing))).toBe(true);
  expect(requests.filter(r=>r.file.endsWith('.geometry.json.gz'))).toHaveLength(0);
  expect(requests.reduce((sum,r)=>sum+r.bytes,0)).toBeLessThan(1024*1024);
  const full=await readRisSnapshot(directory,'test');expect(full.features.features).toHaveLength(rows.length);
  expect(full.features.features.find(f=>f.properties.recordId==='crossing').geometry).toEqual(crossing);
},30000);

test('existing grid-v2 snapshots without the new spatial format remain readable through the same facade',async()=>{
  const geometry={type:'LineString',coordinates:[point(0.1,0.5),point(0.9,0.5)]};
  const manifest=await publish([record('legacy',geometry)],{spatialFormat:'grid-v1'});
  expect(manifest.spatialFormat).toBeUndefined();
  const map=await browser().catalogue.loadMap('test',{bounds:boundsAt(point(0.5,0.5)),zoom:20});
  expect(map.overview).toBe(false);expect(map.features.features[0].geometry).toEqual(geometry);
  expect((await readRisSnapshot(directory,'test')).features.features[0].geometry).toEqual(geometry);
  expect((await enumerateSnapshotAssets(directory,manifest)).length).toBeGreaterThan(0);
});

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function decoded(reference) { return JSON.parse(gunzipSync(await fs.readFile(path.join(directory,reference.path)))); }
async function replaceAsset(reference, value) {
  const raw=Buffer.from(JSON.stringify(value)),sha256=hash(raw);
  const next={...reference,path:`test.${sha256}.${reference.kind}.json.gz`,sha256,bytes:raw.length,count:value.entries.length};
  await fs.writeFile(path.join(directory,next.path),gzipSync(raw));return next;
}
async function saveManifest(manifest) {
  manifest.generation=hash(Buffer.from(JSON.stringify(manifest.roots)));
  await fs.writeFile(path.join(directory,'test.json'),JSON.stringify(manifest));
}
test('missing or corrupt selected spatial leaves fail explicitly instead of producing a complete empty map',async()=>{
  const rows=Array.from({length:160},(_,i)=>record(`p-${i}`,{type:'Point',coordinates:point(0.1+(i%10)*0.08,0.1+Math.floor(i/10)*0.05)}));
  const manifest=await publish(rows),root=await decoded(manifest.roots.spatial);
  expect(root.type).toBe('branch');const leafRef=root.entries.find(([,ref])=>ref.featureCount>0)[1],leaf=await decoded(leafRef);
  const wanted=leaf.entries.find(([key])=>key.startsWith('feature:'))[1];
  const original=await fs.readFile(path.join(directory,leafRef.path));
  await fs.unlink(path.join(directory,leafRef.path));
  await expect(browser().catalogue.loadMap('test',{bounds:wanted.bounds,zoom:22})).rejects.toMatchObject({code:'RIS_SNAPSHOT_ASSET_MISSING'});
  await expect(enumerateSnapshotAssets(directory,manifest)).rejects.toThrow(/Missing/);
  await fs.writeFile(path.join(directory,leafRef.path),Buffer.from('corrupt'));
  await expect(browser().catalogue.loadMap('test',{bounds:wanted.bounds,zoom:22})).rejects.toMatchObject({code:'RIS_SNAPSHOT_INVALID'});
  await fs.writeFile(path.join(directory,leafRef.path),original);
  expect((await browser().catalogue.loadMap('test',{bounds:wanted.bounds,zoom:22})).overview).toBe(false);
});
test('offline validation rejects a correctly hashed off-tree geometry pointer and spatial bounds inconsistent with leaf contents',async()=>{
  const manifest=await publish([record('one',{type:'Point',coordinates:point(0.5,0.5)})]);
  const spatial=await decoded(manifest.roots.spatial), altered=structuredClone(spatial);
  altered.entries.find(([key])=>key.startsWith('feature:'))[1].properties.label='Orphan asset';
  const orphan=await replaceAsset(manifest.roots.spatial,altered);
  const geometry=await decoded(manifest.roots.geometry),id=geometry.entries[0][0];
  geometry.entries[0][1].asset=orphan;
  manifest.roots.geometry=await replaceAsset(manifest.roots.geometry,geometry);await saveManifest(manifest);
  await expect(enumerateSnapshotAssets(directory,manifest)).rejects.toThrow(/spatial leaf/);
  await expect(readRisSnapshot(directory,'test')).rejects.toThrow(/spatial leaf/);
  await expect(browser().catalogue.loadGeometry('test',id)).rejects.toMatchObject({code:'RIS_SNAPSHOT_INVALID'});
  const valid=await publish([record('one',{type:'Point',coordinates:point(0.5,0.5)})]);
  valid.roots.spatial.bounds=[0,0,0,0];await saveManifest(valid);
  await expect(enumerateSnapshotAssets(directory,valid)).rejects.toThrow(/bounds/);
  await expect(readRisSnapshot(directory,'test')).rejects.toThrow(/bounds/);
  await expect(browser().catalogue.loadMap('test',{bounds:boundsAt(point(0.5,0.5)),zoom:22})).rejects.toMatchObject({code:'RIS_SNAPSHOT_INVALID'});
});
test('packed assets store geometry once and offline reconstruction preserves all records and features',async()=>{
  const same={type:'Point',coordinates:point(0.5,0.5)};
  const rows=[record('a',same),record('b',same),record('c',{type:'LineString',coordinates:[point(0.1,0.1),point(0.9,0.9)]})];
  const manifest=await publish(rows),assets=await enumerateSnapshotAssets(directory,manifest);let featurePayloads=0;
  for(const ref of assets){expect(ref.bytes).toBeLessThanOrEqual(262144);expect(ref.count).toBeLessThanOrEqual(64);const node=await decoded(ref);if(node.type==='leaf')for(const [,value]of node.entries){if(value?.type==='Feature')featurePayloads++;if(ref.kind==='geometry')expect(value.geometry).toBeUndefined();}}
  expect(featurePayloads).toBe(2);expect(manifest.geometryCount).toBe(2);expect(Object.keys(manifest.roots)).toHaveLength(7);
  const snapshot=await readRisSnapshot(directory,'test');expect(snapshot.records).toHaveLength(3);expect(snapshot.features.features).toHaveLength(3);
  for(const row of rows)expect(snapshot.features.features.find(f=>f.properties.recordId===row.id).geometry).toEqual(row.geometry);
});

test('the production spatial assembly retains 150,001 distinct geometries without function-argument limits',()=>{
  const {partitionFormat:{buildSpatialEntries}}=require('../../server/political-context/services/risPartitionedSnapshot');
  const geometries=new Map();
  for(let i=0;i<150001;i++){
    const coordinates=[7+(i%1000)/1000000,51+Math.floor(i/1000)/1000000],geometry={type:'Point',coordinates};
    const geometryId=`geometry:${hash(Buffer.from(JSON.stringify(geometry)))}`;
    geometries.set(geometryId,{type:'Feature',geometry,bounds:[...coordinates,...coordinates],properties:{geometryId,accuracy:'official',label:'',recordCount:1}});
  }
  const summary=['overview:0/0/0',{bounds:[-180,-85,180,85],count:150001,geometryCount:150001}];
  const entries=buildSpatialEntries(geometries,[summary]);
  expect(entries).toHaveLength(150002);expect(entries.at(-1)).toBe(summary);
  const featureEntries=entries.slice(0,-1);
  expect(new Set(featureEntries.map(([,feature])=>feature.properties.geometryId)).size).toBe(150001);
  expect(featureEntries.every(([key,feature],index)=>key===`feature:${String(index).padStart(16,'0')}:${feature.properties.geometryId}`&&geometries.get(feature.properties.geometryId)===feature)).toBe(true);
},30000);
