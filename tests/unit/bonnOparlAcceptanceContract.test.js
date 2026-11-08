'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');
const xml=()=>new DOMParser().parseFromString(read('pom.xml'),'application/xml');
const own=(el,name)=>[...el.children].find(x=>x.localName===name);
const execution=(root,id)=>[...root.querySelectorAll('execution')].find(x=>own(x,'id')?.textContent===id);
function profile(){return [...xml().querySelectorAll('profiles > profile')].find(x=>own(x,'id')?.textContent==='bonn-oparl-live');}
test('Maven public OParl profile targets one live test and owns validated live flags',()=>{
 const p=profile();expect(p).toBeDefined();
 const unit=execution(p,'frontend-unit-tests'),config=own(unit,'configuration');
 expect(own(config,'arguments').textContent).toBe('test -- --runTestsByPath tests/unit/bonnPoliticalContextLive.test.js --runInBand');
 const env=own(config,'environmentVariables');
 expect(own(env,'BONN_OPARL_LIVE').textContent).toBe('1');
 expect(own(env,'BONN_OPARL_LIVE_SCOPE').textContent).toBe('${bonn.oparl.scope}');
 const rule=p.querySelector('requireProperty');
 expect(own(rule,'property').textContent).toBe('bonn.oparl.scope');
 const allowed=new RegExp(own(rule,'regex').textContent);
 expect(['snapshot','archive'].map(x=>allowed.test(x))).toEqual([true,true]);
 expect(['','all','solve','snapshot-extra',' archive'].every(x=>!allowed.test(x))).toBe(true);
});
test('normal full unit execution is unchanged and Bonn workflow invokes only the Maven profile',()=>{
 const doc=xml(),build=own(doc.documentElement,'build'),unit=execution(build,'frontend-unit-tests');
 expect(unit.querySelector('arguments').textContent).toBe('run test:unit -- --runInBand');
 expect(unit.querySelector('skip').textContent).toBe('${skipTests}');
 const w=read('.github/workflows/bonn-oparl-live.yml');
 expect(w).toMatch(/run: mvn -B -ntp -N test -Pbonn-oparl-live/);
 expect(w).toContain('-Dbonn.oparl.scope=${{ github.event_name');
 expect(w).not.toMatch(/^\s+BONN_OPARL_LIVE(?:_SCOPE)?:/m);
 expect(w).not.toMatch(/bonnPortalGate|bonn-portal-gate|bonn-portal-search-discovery|bonn-official-catalogue-discovery/);
 expect(w).toContain('out/qa/bonn-political-context-live.json');
 expect(w).toContain('out/qa/bonn-ris-snapshot-live.json');
});
