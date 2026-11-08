/** @jest-environment node */
'use strict';
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {writeRisSnapshot,readRisSnapshot}=require('../../server/political-context/services/risSnapshot');
const {createCatalogue}=require('../../js/ua.ris-catalogue');
const P=require('../../js/ua.ris-partitions');
const source='https://e-government.hannover-stadt.de/lhhsimwebre.nsf/';
const now=new Date('2026-11-08T12:00:00.000Z');
const event=i=>({date:'2026-06-25',body:'Rat',outcome:i?'Vertagt':'Ohne Abstimmung',url:source+'TM/20260625_Rat',evidence:`25.06.2026 Rat öffentliche Beratung ${i}`});
const edge=i=>({type:'related',targetId:`hannover-sim:${i}-2026`,targetUrl:source+`DS/${i}-2026`,label:`Antwort ${i}/2026`,targetRole:'answer',evidence:`Amtliche verwandte Drucksache ${i}/2026`});
const context={level:'state',publisher:'Niedersächsischer Landtag',issuer:null,documentKind:'Drucksache',status:'answer',publicationDate:null,documentDate:'2026-06-01',meetingDate:null};
const statuses=[{source:'landtag',status:'available',url:'https://www.landtag-niedersachsen.de/',retrievedAt:now.toISOString(),from:null,to:null,recordCount:1,message:'Amtliche Drucksache'}];
const record={id:'hannover-sim:1-2026',title:'Schulweg',number:'1/2026',type:'Anfrage',date:null,gremium:null,url:source+'DS/1-2026',source:'hannover-sim'};
const catalogue=extra=>({sources:[source,'https://www.landtag-niedersachsen.de/'],coverage:{from:null,to:null,bodies:[],warnings:[],complete:false},records:[{...record,...extra}],sourceStatuses:statuses});
let dir;
beforeEach(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'ris-timeline-'));});
afterEach(async()=>{await fs.rm(dir,{recursive:true,force:true});});
function browser(requests=[]){return createCatalogue({base:'https://example.org/',now:()=>now,fetch:async url=>{const name=new URL(url).pathname.split('/').pop();requests.push(name);return new Response(await fs.readFile(path.join(dir,name)));}});}
test('v2 pages full direct history in existing links root without eager event/edge requests',async()=>{
 const events=Array.from({length:140},(_,i)=>event(i)),relationships=Array.from({length:131},(_,i)=>edge(i));
 const m=await writeRisSnapshot(dir,'hannover',catalogue({events,relationships,sourceContext:context,originalPdfUrl:'https://www.landtag-niedersachsen.de/Drucksachen.pdf'}),{now,schemaVersion:2});
 expect(Object.keys(m.roots)).toEqual(P.ROOTS);
 expect(m.sourceStatuses).toEqual(statuses);
 const requests=[],c=browser(requests),r=await c.loadRecord('hannover',record.id);
 expect(r).toMatchObject({eventCount:140,relationshipCount:131,sourceContext:context});expect(r).not.toHaveProperty('events');
 const initial=requests.length;
 const a=await c.loadRecordEvents('hannover',record.id,0,{snapshot:m});expect(a.events).toEqual(events.slice(0,64));expect(a.nextPage).toBe(1);
 expect(requests.length).toBeGreaterThanOrEqual(initial);expect((await c.loadRecordEvents('hannover',record.id,2)).events).toEqual(events.slice(128));
 expect((await c.loadRecordRelationships('hannover',record.id,2)).relationships).toEqual(relationships.slice(128));
 const full=await readRisSnapshot(dir,'hannover');expect(full.records[0]).toMatchObject({events,relationships,sourceContext:context});
 await expect(c.loadRecordEvents('hannover',record.id,0,{snapshot:{...m,generation:'b'.repeat(64)}})).rejects.toMatchObject({code:'RIS_SNAPSHOT_REFERENCE_MISMATCH'});
});
test.each([1,2])('known empty lists and absent legacy history remain different in schema %i',async schemaVersion=>{
 await writeRisSnapshot(dir,'hannover',catalogue({}),{now,schemaVersion});
 const c=browser();expect(await c.loadRecordEvents('hannover',record.id)).toMatchObject({known:false,total:null,events:[]});
 expect((await readRisSnapshot(dir,'hannover')).records[0]).not.toHaveProperty('events');
 await writeRisSnapshot(dir,'hannover',catalogue({events:[],relationships:[]}),{now,schemaVersion});
 expect(await browser().loadRecordEvents('hannover',record.id)).toMatchObject({known:true,total:0,events:[]});
});
test.each([1,2])('rejects malformed facts and untrusted cross-source URLs in schema %i',async schemaVersion=>{
 for(const extra of [{events:[{...event(0),date:'2026-02-30'}]},{events:[{...event(0),url:'https://evil.example/x'}]},
 {relationships:[{...edge(0),targetUrl:'javascript:alert(1)'}]},{sourceContext:{...context,level:'federal'}},{originalPdfUrl:'https://www.landtag-niedersachsen.de@evil.example/a.pdf'},
 {events:[event(0)],eventCount:7}])await expect(writeRisSnapshot(dir,'hannover',catalogue(extra),{now,schemaVersion})).rejects.toThrow(/metadata|history|event|source|count/i);
});
test('legacy v1 cannot silently truncate long histories',async()=>{
 await expect(writeRisSnapshot(dir,'hannover',catalogue({events:Array.from({length:65},(_,i)=>event(i))}),{now,schemaVersion:1})).rejects.toThrow(/metadata|history|event/i);
});

test('long original row evidence uses byte-aware pages without dropping the rest of the history',async()=>{
 const events=Array.from({length:20},(_,i)=>({...event(i),evidence:`Originalzeile ${i} ${'a'.repeat(15000)}`}));
 const m=await writeRisSnapshot(dir,'hannover',catalogue({events}),{now,schemaVersion:2});
 const c=browser(),all=[];let page=0;
 do{const result=await c.loadRecordEvents('hannover',record.id,page,{snapshot:m});expect(result.events.length).toBeLessThan(20);all.push(...result.events);page=result.nextPage;}while(page!==null);
 expect(all).toEqual(events);expect((await readRisSnapshot(dir,'hannover')).records[0].events).toEqual(events);
});
test.each([1,2])('rejects malformed optional source statuses in writer and browser validation (schema %i)',async schemaVersion=>{
 for(const change of [{recordCount:-1},{recordCount:1.5},{retrievedAt:'2026-11-08'},{from:'2026-02-30'},{from:'2026-11-09',to:'2026-11-08'},{url:'https://evil.example/'},{url:'https://www.landtag-niedersachsen.de:8443/'},{message:'a'.repeat(513)}]){
  const value=catalogue({});value.sourceStatuses=[{...statuses[0],...change}];
  await expect(writeRisSnapshot(dir,'hannover',value,{now,schemaVersion})).rejects.toThrow(/source statuses/i);
  expect(P.validSourceStatuses(value.sourceStatuses,value.sources)).toBe(false);
 }
});
test('shared browser leaf validation rejects malformed directory counts and untrusted event pages',()=>{
 const ref={kind:'records',count:1};
 for(const change of [{eventCount:-1},{relationshipCount:1.2},{events:[event(0)]},{sourceContext:{...context,documentDate:'2026-02-30'}}])
  expect(()=>P.node({type:'leaf',entries:[[record.id,{...record,locationCount:0,...change}]]},ref,'hannover',undefined,[source])).toThrow();
 const page={items:[{...event(0),url:'https://evil.example/'}],start:0,total:1,nextPage:null};
 expect(()=>P.node({type:'leaf',entries:[[P.key(`events:${record.id}`,0),page]]},{kind:'links',count:1},'hannover',undefined,[source])).toThrow();
});

test.each([1,2])('ordinary published search preserves independently qualified source statuses and source identity (schema %i)',async schemaVersion=>{
 await writeRisSnapshot(dir,'hannover',catalogue({sourceContext:context,originalPdfUrl:'https://www.landtag-niedersachsen.de/original.pdf',events:[event(0)]}),{now,schemaVersion});
 const result=await browser().search({city:'hannover',searchTerms:['Schulweg'],context:{},maxResults:10});
 expect(result.meta.sourceStatuses).toEqual(statuses);
 expect(result.references[0]).toMatchObject({sourceContext:context,originalPdfUrl:'https://www.landtag-niedersachsen.de/original.pdf'});
 if(schemaVersion===2)expect(result.references[0]).not.toHaveProperty('events');
});

test('provider normalization preserves bounded direct history and source IDs without inventing counts',()=>{
 const {normalizeOne}=require('../../server/political-context/services/portalNormalizationService');
 const input={...record,events:[event(0)],relationships:[edge(0),{...edge(1),targetId:null}],sourceContext:context};
 const output=normalizeOne(input,'hannover-sim');
 expect(output).toMatchObject({events:input.events,relationships:input.relationships,sourceContext:context});
 expect(output).not.toHaveProperty('eventCount');expect(output).not.toHaveProperty('relationshipCount');
 expect(output.relationships[0].targetId).toBe('hannover-sim:0-2026');expect(output.relationships[1].targetId).toBeNull();
 expect(normalizeOne({...record,eventCount:140,relationshipCount:0},'hannover-sim')).toMatchObject({eventCount:140,relationshipCount:0});
 for(const invalid of [{events:[event(0)],eventCount:7},{relationships:[{...edge(0),targetUrl:'https://evil.example/'}]},{events:Array.from({length:65},(_,i)=>event(i))},{eventCount:-1}]){
  const safe=normalizeOne({...record,...invalid},'hannover-sim');
  for(const key of Object.keys(invalid))expect(safe).not.toHaveProperty(key);
 }
 expect(normalizeOne(record,'hannover-sim')).not.toHaveProperty('events');
});
test('provider source sanitization uses shared strict facts while conservatively discarding unknown extra fields',()=>{
 const {normalizeSourceContext,normalizeSourceStatuses,httpsUrl}=require('../../server/political-context/services/politicalSourceContext');
 expect(normalizeSourceContext({...context,legacyUnknown:'ignored'})).toEqual(context);
 expect(normalizeSourceContext({...context,publisher:'Land\u200btag'})).toBeNull();
 expect(normalizeSourceContext({...context,publisher:'<Landtag>'})).toBeNull();
 expect(normalizeSourceStatuses([{...statuses[0],legacyUnknown:'ignored'}])).toEqual(statuses);
 expect(normalizeSourceStatuses([{...statuses[0],url:'https://evil.example/'}])).toEqual([]);
 expect(normalizeSourceStatuses([{...statuses[0],source:'a'.repeat(129)}])).toEqual([]);
 expect(normalizeSourceStatuses([{...statuses[0],message:'<script>'}])).toEqual([]);
 expect(httpsUrl('https://WWW.LANDTAG-NIEDERSACHSEN.DE/original.pdf',true)).toBeNull();
 expect(httpsUrl('https://www.landtag-niedersachsen.de/original.pdf',true)).toBe('https://www.landtag-niedersachsen.de/original.pdf');
});
