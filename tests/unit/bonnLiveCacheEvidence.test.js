/** @jest-environment node */
'use strict';
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const https=require('node:https');
const {runCatalogueReuse}=require('../../scripts/lib/bonn-live-cache-evidence');
const BASE='https://www.bonn.sitzung-online.de';
const parameters={city:'Bonn',context:{street:'Adenauerallee'},maxResults:20,expandVariants:false,useCache:false,now:'2026-11-08T12:00:00.000Z',maxPages:3};
function fixtureSearch({differentScope=false,alter}={}){
 jest.resetModules();const client=require('../../server/political-context/providers/bonnOparlClient');
 const requests=[];
 jest.spyOn(https,'get').mockImplementation((url,_options,callback)=>{
  requests.push(String(url));const request=new EventEmitter();
  setImmediate(()=>{const u=new URL(url),response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};
   const data=u.pathname==='/oparl/system'?{body:BASE+'/oparl/bodies'}:u.pathname==='/oparl/bodies'?{data:[{id:BASE+'/oparl/bodies/1',name:'Bundesstadt Bonn',ags:'05314000',paper:BASE+'/oparl/bodies/1/papers'}]}:{data:[{id:BASE+'/oparl/papers/1',type:'https://schema.oparl.org/1.1/Paper',web:BASE+'/public/VO020?VOLFDNR=1',name:'Radverkehr Adenauerallee',date:'2026-06-01',reference:'26-1'}]};
   callback(response);response.end(JSON.stringify(data));});return request;
 });
 const calls=[];
 const search=async p=>{calls.push(p);const v=await client.searchOparl({...p,...(differentScope&&p.searchTerms[0]==='Oxfordstraße'?{pageLimit:50}:{})});
  const result={references:v.results,meta:{...v.meta,searchStatus:v.meta.status}};return alter?alter(result,p):result;};
 return {search,calls,requests};
}
afterEach(()=>jest.restoreAllMocks());
test('different concurrent and warm terms reuse one actual production catalogue with zero additional transport',async()=>{
 const f=fixtureSearch();const originalTransport=https.get;const r=await runCatalogueReuse({search:f.search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(https.get).toBe(originalTransport);
 expect(r.validationErrors).toEqual([]);expect(r.passed).toBe(true);expect(f.requests).toHaveLength(3);
 expect([r.cold,r.coalesced,r.warm].map(x=>x.result.meta.catalogueCache.status)).toEqual(['miss','coalesced','hit']);
 expect([r.cold,r.coalesced,r.warm].map(x=>x.networkRequests)).toEqual([3,0,0]);
 expect([r.cold,r.coalesced,r.warm].map(x=>x.result.meta.catalogueCache.refreshedAt)).toEqual(Array(3).fill(parameters.now));
 expect(new Set(f.calls.map(x=>JSON.stringify(x.searchTerms))).size).toBe(3);
 expect(f.calls.every(x=>x.useCache===false)).toBe(true);
 for(const x of [r.cold,r.coalesced,r.warm]){expect(x.elapsedMs).toBeGreaterThanOrEqual(0);expect(Number.isFinite(Date.parse(x.startedAt))).toBe(true);expect(x.blockedNetworkRequests).toBe(0);}
 expect(r.coalesced.result.meta.searchStatus).toBe('searched-no-results');
});
test('a cache-key mismatch cannot start a second crawl and remains failed evidence',async()=>{
 const f=fixtureSearch({differentScope:true});const r=await runCatalogueReuse({search:f.search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(r.passed).toBe(false);expect(f.requests).toHaveLength(3);expect(r.coalesced.blockedNetworkRequests).toBeGreaterThan(0);
 expect(r.validationErrors.join(' ')).toMatch(/coalesced|network/i);expect(r.warm.status).toBe('not-run');
});
test.each(['clock','requests','truncated'])('rejects %s drift instead of manufacturing warm acceptance',async kind=>{
 const f=fixtureSearch({alter:(v,p)=>{if(p.searchTerms.length===1&&p.searchTerms[0]==='Adenauerallee'){
  if(kind==='clock')v.meta.catalogueCache.refreshedAt='2026-11-09T12:00:00.000Z';
  if(kind==='requests')v.meta.catalogueCache.networkRequests=1;
  if(kind==='truncated')v.meta.truncated=true;
 }return v;}});
 const r=await runCatalogueReuse({search:f.search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(r.passed).toBe(false);expect(r.validationErrors.join(' ')).toMatch(/warm/);expect(f.requests).toHaveLength(3);
});
test('single-term custom input still gets different joined and warm queries',async()=>{
 const f=fixtureSearch();await runCatalogueReuse({search:f.search,parameters,terms:['Oxfordstraße']});
 expect(new Set(f.calls.map(x=>JSON.stringify(x.searchTerms))).size).toBe(3);
});

test.each([false,true])('actual QA CLI retains public OParl evidence and blocks HTML fallback (source failure=%s)',failOparl=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bonn-live-cli-'));
 try{
  const hook=path.join(dir,'transport.cjs'),output=path.join(dir,'evidence.json'),transmissions=path.join(dir,'unexpected-http.txt');
  fs.writeFileSync(hook,`const https=require('node:https'),http=require('node:http'),fs=require('node:fs'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
for(const transport of [http,https])transport.request=()=>{fs.writeFileSync(${JSON.stringify(transmissions)},'request attempted');throw new Error('No external fixture traffic');};
http.get=()=>{fs.writeFileSync(${JSON.stringify(transmissions)},'get attempted');throw new Error('No external fixture traffic');};
https.get=(url,options,callback)=>{const u=new URL(url),base='https://www.bonn.sitzung-online.de';let payload;
if(u.origin!==base)throw new Error('No live network allowed');
if(u.pathname==='/oparl/system')payload={body:base+'/oparl/bodies'};
else if(u.pathname==='/oparl/bodies')payload={data:[{id:base+'/oparl/bodies/1',name:'Bundesstadt Bonn',ags:'05314000',paper:base+'/oparl/bodies/1/papers'}]};
else if(u.pathname==='/oparl/bodies/1/papers')payload={data:[{id:base+'/oparl/papers/1',type:'https://schema.oparl.org/1.1/Paper',web:base+'/public/VO020?VOLFDNR=1',name:'Radverkehr Adenauerallee Oxfordstraße',date:'2026-06-01',reference:'26-1'}]};
else throw new Error('Unexpected fixture path');
const request=new EventEmitter();setImmediate(()=>{if(${JSON.stringify(failOparl)}){request.emit('error',new Error('Official fixture unavailable'));return;}const response=new PassThrough();response.statusCode=200;response.headers={'content-type':'application/json'};callback(response);response.end(JSON.stringify(payload));});return request;};`);
  const run=spawnSync(process.execPath,['--require',hook,'scripts/qa-bonn-political-context-live.js','--attempts','1','--output',output],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8',timeout:15000});
  expect({status:run.status,stderr:run.stderr}).toMatchObject({status:failOparl?1:0});
  expect(fs.existsSync(transmissions)).toBe(false);
  const evidence=JSON.parse(fs.readFileSync(output,'utf8')),attempt=evidence.attempts[0],reuse=attempt.catalogueReuse;
  if(failOparl){
   expect(evidence.passed).toBe(false);expect(evidence.finalError).toBeDefined();
   expect(attempt.result?.meta.searchStatus).not.toBe('searched-no-results');
   expect(reuse.validationErrors.length).toBeGreaterThan(0);
   expect(reuse.cold.blockedNetworkRequests).toBeGreaterThan(0);return;
  }
  expect(evidence.passed).toBe(true);expect(attempt.validationErrors).toEqual([]);
  expect(attempt.result.meta.queryLog.map(x=>x.query)).toEqual(['Adenauerallee','Radverkehr']);
  expect(reuse.passed).toBe(true);expect(reuse.validationErrors).toEqual([]);
  expect([reuse.cold,reuse.coalesced,reuse.warm].map(x=>x.networkRequests)).toEqual([3,0,0]);
  expect([reuse.cold,reuse.coalesced,reuse.warm].map(x=>x.result.meta.catalogueCache.status)).toEqual(['miss','coalesced','hit']);
  expect([reuse.cold,reuse.coalesced,reuse.warm].every(x=>x.result.meta.cache.enabled===false&&x.result.meta.cache.hit===false)).toBe(true);
  expect(reuse.warm.result.meta.catalogueCache.refreshedAt).toBe(reuse.cold.result.meta.catalogueCache.refreshedAt);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('unknown catalogue counts cannot pass just because every probe omits the same field',async()=>{
 const f=fixtureSearch({alter:v=>{delete v.meta.catalogueCache.items;return v;}});
 const r=await runCatalogueReuse({search:f.search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(r.passed).toBe(false);expect(r.validationErrors.join(' ')).toMatch(/count|unknown/);
});

test.each(['coalesced','warm'].flatMap(label=>['http','https'].map(protocol=>[label,protocol])))('%s direct %s request fallback is blocked before transmission and hooks are restored',async(label,protocol)=>{
 const http=require('node:http'),f=fixtureSearch();let transmitted=0;
 for(const transport of [http,https])jest.spyOn(transport,'request').mockImplementation(()=>{transmitted++;return {end(){}};});
 const originalSearch=f.search;
 const search=async p=>{const result=await originalSearch(p);
  const phase=p.searchTerms[0]==='Oxfordstraße'?'coalesced':p.searchTerms.length===1?'warm':'cold';
  if(phase===label)(protocol==='http'?http:https).request(protocol+'://www.bonn.sitzung-online.de/public/tr010').end();
  return result;};
 const before=[http.get,http.request,https.get,https.request];
 const r=await runCatalogueReuse({search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(transmitted).toBe(0);expect(r.passed).toBe(false);expect(r[label].blockedNetworkRequests).toBeGreaterThan(0);
 expect([http.get,http.request,https.get,https.request]).toEqual(before);expect(f.requests).toHaveLength(3);
});

test('a GET delegating synchronously to REQUEST counts one physical acquisition and restores both entry points',async()=>{
 const f=fixtureSearch(),serve=https.get.getMockImplementation();
 jest.spyOn(https,'request').mockImplementation(serve);
 https.get.mockImplementation((...args)=>https.request(...args));
 const before=[https.get,https.request];
 const r=await runCatalogueReuse({search:f.search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(r.passed).toBe(true);expect(r.cold.networkRequests).toBe(3);expect(f.requests).toHaveLength(3);
 expect([https.get,https.request]).toEqual(before);
});

test.each([
 ['https','get','https://www.bonn.sitzung-online.de/public/tr010'],
 ['https','request','https://www.bonn.sitzung-online.de/public/_gate/challenge'],
 ['https','request','https://evil.example/oparl/system'],
 ['http','request','http://www.bonn.sitzung-online.de/oparl/system'],
 ['https','request',{hostname:'evil.example',path:'/oparl/system'}],
 ['https','request',BASE+'/oparl/system',{hostname:'evil.example'}],
 ['https','request',BASE+'/oparl/system',{path:'/public/_gate/verify'}],
 ['https','request',BASE+'/oparl/%2f..%2fpublic/_gate/challenge'],
 ['https','request',{hostname:'www.bonn.sitzung-online.de',path:'/oparl//../public/_gate/challenge'}],
 ['https','request',{hostname:'www.bonn.sitzung-online.de',path:'/public/../oparl/system'}],
])('cold %s.%s rejects non-public-OParl targets before transmission',async(protocol,method,target,extra={})=>{
 const http=require('node:http'),f=fixtureSearch();let transmitted=0;
 for(const transport of [http,https])jest.spyOn(transport,'request').mockImplementation(()=>{transmitted++;return {end(){}};});
 const search=async p=>{const result=await f.search(p);
  if(p.searchTerms.length===2)(protocol==='http'?http:https)[method](target,extra,()=>{}).end?.();
  return result;};
 const r=await runCatalogueReuse({search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(transmitted).toBe(0);expect(r.passed).toBe(false);expect(r.cold.blockedNetworkRequests).toBeGreaterThan(0);
 expect(f.requests).toHaveLength(3);
});


test('cold GET delegation cannot bypass the OParl path boundary through a nested request',async()=>{
 const f=fixtureSearch(),serve=https.get.getMockImplementation();let transmitted=0;
 jest.spyOn(https,'request').mockImplementation(()=>{transmitted++;return {end(){}};});
 https.get.mockImplementation((url,options,callback)=>options.simulateHtmlFallback
  ?https.request(BASE+'/public/_gate/challenge',{},callback):serve(url,options,callback));
 const search=async p=>{const result=await f.search(p);if(p.searchTerms.length===2)https.get(BASE+'/oparl/system',{simulateHtmlFallback:true},()=>{});return result;};
 const r=await runCatalogueReuse({search,parameters,terms:['Adenauerallee','Radverkehr']});
 expect(transmitted).toBe(0);expect(r.passed).toBe(false);expect(r.cold.blockedNetworkRequests).toBe(1);expect(f.requests).toHaveLength(3);
});

test.each(['public','redirect','retry-redirect'])('actual snapshot collection protects %s acquisition and restores every transport hook',async(mode)=>{
 const http=require('node:http');
 jest.resetModules();
 const {collectSnapshotEvidence}=require('../../scripts/lib/bonn-live-cache-evidence');
 const collect=jest.spyOn(require('../../server/political-context/providers/bonnOparlClient'),'collectBonnCatalogue');
 const requests=[];let systems=0,unexpected=0;
 for(const transport of [http,https])jest.spyOn(transport,'request').mockImplementation(()=>{unexpected++;throw new Error('No network in fixture');});
 jest.spyOn(http,'get').mockImplementation(()=>{unexpected++;throw new Error('No network in fixture');});
 jest.spyOn(https,'get').mockImplementation((url,_options,callback)=>{
  requests.push(String(url));const u=new URL(url),request=new EventEmitter();
  if(u.pathname==='/oparl/system')systems++;
  if(u.origin!==BASE||!u.pathname.startsWith('/oparl/'))unexpected++;
  setImmediate(()=>{const response=new PassThrough();response.headers={'content-type':'application/json'};
   const empty=mode==='retry-redirect'&&systems===1;
   const redirect=mode!=='public'&&!empty&&u.pathname==='/oparl/system';
   response.statusCode=empty?503:redirect?302:200;
   if(redirect)response.headers.location='/public/_gate/challenge';
   const payload=u.pathname==='/oparl/system'?{body:BASE+'/oparl/bodies'}
    :u.pathname==='/oparl/bodies'?{data:[{id:BASE+'/oparl/bodies/1',name:'Bundesstadt Bonn',ags:'05314000',paper:BASE+'/oparl/bodies/1/papers'}]}
    :{data:[{id:BASE+'/oparl/papers/1',type:'https://schema.oparl.org/1.1/Paper',web:BASE+'/public/VO020?VOLFDNR=1',name:'Radverkehr Adenauerallee',date:'2026-06-01',reference:'26-1'}]};
   callback(response);response.end(empty||redirect?'':JSON.stringify(payload));
  });return request;
 });
 const before=[http.get,http.request,https.get,https.request],onRetry=jest.fn();
 let result,error;
 try{result=await collectSnapshotEvidence({options:{maxPages:2,requestOptions:{timeoutMs:35000}},retryDelayMs:0,onRetry});}catch(e){error=e;}
 expect([http.get,http.request,https.get,https.request]).toEqual(before);
 expect(unexpected).toBe(0);expect(requests.every(url=>new URL(url).pathname.startsWith('/oparl/'))).toBe(true);
 expect(onRetry).toHaveBeenCalledTimes(mode==='retry-redirect'?1:0);
 if(mode==='public'){
  expect(error).toBeUndefined();expect(result.catalogue.records).toHaveLength(1);
  expect(result.transport).toEqual({networkRequests:3,blockedNetworkRequests:0});
 }else{
  expect(result).toBeUndefined();expect(error).toMatchObject({code:'QA_OPARL_BOUNDARY',transport:{blockedNetworkRequests:1}});
  // The real collector recovered a valid paper through its direct OParl fallback;
  // that cannot erase the earlier forbidden redirect and turn acceptance green.
  expect(requests.some(url=>url.includes('/oparl/bodies/1/papers'))).toBe(true);
  expect((await collect.mock.results.at(-1).value).records).toHaveLength(1);
  expect(error.message).toMatch(/blocked/i);
 }
});
