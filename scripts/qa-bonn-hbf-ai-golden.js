#!/usr/bin/env node
'use strict';
// Actual production runtime facts. No statistical formula is implemented here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { configuredModel } = require('../server/ai/providers/geminiApi');
const { runModelReplay } = require('./bonn-hbf-model-replay');
const zlib = require('zlib');
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_ORIGIN = 'https://carstenartur.github.io';
const AREA = 'Bonn Hauptbahnhof / Münsterplatz / Maximilianstraße / Thomas-Mann-Straße';
const PLACES = ['Münsterplatz', 'Maximilianstraße', 'Thomas-Mann-Straße'];
const BOUNDS = Object.freeze({south:50.73,west:7.091,north:50.7355,east:7.101});
// Replay the recorded map state, including its original aerial opacity.
const CASE_QUERY = 'city=Bonn&includeCyclist=1&includePedestrian=0&includeCar=1&includeMotorcycle=0&involvementMode=and&showCluster=0&showHeatmap=0&showOnlyAboveAverage=0&severity=all&dayType=all&roadCondition=all&hourFrom=0&hourTo=23&centerLat=50.732211&centerLon=7.095119&zoom=16&selSouth=50.730000&selWest=7.091000&selNorth=50.735500&selEast=7.101000&maxPoints=100000&viewportPaddingPct=20&heatRadius=25&includeGkfz=0&includeSonstig=0&showSchools=1&showKindergartens=1&showArgumentation=1&orthophotoOpacity=92';
const SOURCES = ['out/output_all_years_bonn.geojson.gz','out/poi_bonn.geojson.gz','out/output_all_years_bonn.enrichment.meta.json.gz','templates/gremien_bonn.json'];
const RUNTIME = ['ua.export_v2.js','ua.filters.js','ua.stats.js','ua.trend.js','ua.heatmap.js','ua.analysis_scope.js','ua.evidence_safe_semantics.js','ua.evidence_safe_semantics_hardening.js','ua.ai_political_reference_bridge.js','ua.ai_political_evidence.js','ua.area_name_control.js','ua.export_template_defaults.js'];
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));
  return value;
}
const json = value => JSON.stringify(stable(value), null, 2) + '\n';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => hash(fs.readFileSync(path.join(ROOT,file)));
function write(file, value) { fs.mkdirSync(path.dirname(file), {recursive:true}); fs.writeFileSync(file,json(value)); }
function compareSnapshots(expected, actual) {
  const differences=[];
  function visit(a,b,p) {
    if (p === 'execution') return; // Only execution envelope: never ignore source/search dates generically.
    if (JSON.stringify(stable(a)) === JSON.stringify(stable(b))) return;
    if (a && b && typeof a==='object' && typeof b==='object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const k of new Set([...Object.keys(a),...Object.keys(b)])) visit(a[k],b[k],p?p+'.'+k:k);
    } else differences.push({path:p,expected:a,actual:b});
  }
  visit(expected,actual,'');return differences;
}
function canonicalUrl(raw) {
  const url=new URL(raw);url.protocol='https:';url.host='carstenartur.github.io';url.port='';url.pathname='/Unfallatlas/werkbank_v2.html';url.searchParams.delete('export');url.searchParams.sort();return url.href;
}
function reviewModelResponse(response, receipt, binding, councilEvidence) {
  const digestFields = ['inputSha256', 'promptSha256', 'schemaSha256', 'rubricSha256'];
  const verified = Boolean(receipt && ['provider', 'model', 'modelVersion', 'promptVersion', 'executedAt'].every(
    key => typeof receipt[key] === 'string' && receipt[key].trim()
  ) && receipt.provider === binding.requestedProvider
    && receipt.model === binding.requestedModel
    && receipt.promptVersion === binding.promptVersion
    && Number.isFinite(Date.parse(receipt.executedAt))
    && digestFields.every(key => /^[a-f0-9]{64}$/.test(receipt[key]) && receipt[key] === binding[key])
    && receipt.responseSha256 === hash(json(response)));
  const {evaluateProposalValueAdd}=require('../server/ai/proposalBriefValueAdd');
  const rubric=evaluateProposalValueAdd(response);
  const schemaValidation=require('../server/ai/aiAssessmentServiceV2').validateAgainstMode(response,'proposal-brief',{normalizeProposal:false});
  if (councilEvidence) {
    const log = response?.politicalResearchLog;
    const expectedUrls = councilEvidence.references.map(ref => ref.url).sort();
    const actualUrls = [...new Set(Array.isArray(log?.evidenceRefs) ? log.evidenceRefs : [])].sort();
    const queryKey = entry => JSON.stringify([entry?.query, entry?.source, entry?.url]);
    const expectedQueries = councilEvidence.queries.map(queryKey).sort();
    const actualQueries = [...new Set((Array.isArray(log?.documentedQueries) ? log.documentedQueries : []).map(queryKey))].sort();
    const sourcesMatch = log?.status === 'complete' && log.sourceStatus === 'results-found'
      && json(actualUrls) === json(expectedUrls) && json(actualQueries) === json(expectedQueries);
    const local = binding.localEvidenceGate;
    const evidenceReady = local?.passed === true && local.analysisQaStatus === 'ready'
      && local.politicalResearchStatus === 'complete' && local.filingReadinessStatus === 'ready';
    const verdict = response?.filingReadinessVerdict;
    const counts = binding.candidateCohorts;
    const numbers = (response?.sachverhalt?.match(/\d+(?:[.\u00a0\u202f]\d{3})*/g) || [])
      .map(value => Number(value.replace(/[^0-9]/g, '')));
    const scopesReported = Boolean(counts && ['discovery','completeArea','reference'].every(role =>
      Number.isSafeInteger(counts[role]) && response?.evidenceCohortCounts?.[role] === counts[role]
      && numbers.includes(counts[role])));
    const conforms = verified && schemaValidation.valid && rubric.valid && sourcesMatch;
    const positiveDraftCandidate = Boolean(conforms && evidenceReady && scopesReported
      && verdict?.status === 'ready' && verdict.analysisQaStatus === 'ready');
    const councilEvidenceCasePassed = local ? positiveDraftCandidate : conforms && verdict?.status === 'blocked';
    return {status:'blocked', providerReceiptVerified:verified, councilEvidenceCasePassed, positiveDraftCandidate,
      sourcesMatch, scopesReported, schemaValidation, rubric, independentReview:'pending',
      blockingReasons:['Independent review of the proposal, its claims and its cited evidence is pending.']};
  }
  // The captured Bonn baseline has neither executed searches nor verified proceedings.
  const politicalResearch = response?.politicalResearchLog;
  const politicalBlockerMaintained = politicalResearch?.status === 'blocked'
    && politicalResearch.sourceStatus === 'not-searched'
    && Array.isArray(politicalResearch.documentedQueries) && politicalResearch.documentedQueries.length === 0
    && Array.isArray(politicalResearch.evidenceRefs) && politicalResearch.evidenceRefs.length === 0;
  const blockerCasePassed = verified && schemaValidation.valid && rubric.valid
    && response?.filingReadinessVerdict?.status === 'blocked' && politicalBlockerMaintained;
  return {status:'blocked',providerReceiptVerified:verified,blockerCasePassed,schemaValidation,rubric,
    blockingReasons:[...(!verified?['Missing or mismatched actual provider receipt']:[]),
      ...(!politicalBlockerMaintained ? ['The unsearched Golden requires blocked political research, an empty query log and no political evidence references.'] : []),
      'This case has no completed political research or four-mode live map inspection; it cannot establish positive release approval.'],
    receiptTrust:'Locally supplied receipt claims; provider execution is not independently authenticated by this offline harness.'};
}
async function captureRuntime(options={}) {
  if (!options.skipBuild) require('./build-site-with-vendor-lock').main([]);
  // A prebuilt run must still execute this checkout's exact production code.
  for (const file of [...RUNTIME.map(f=>'js/'+f),'js/ua.app_v2.js','js/ua.state.js','werkbank_v2.html']) {
    if (fileHash(file)!==hash(fs.readFileSync(path.join(ROOT,'_site',file)))) throw new Error(`Stale built runtime: ${file}; rebuild the canonical site`);
  }
  const inputSourceFiles={};
  for(const file of SOURCES) {
    const input=fs.readFileSync(path.join(ROOT,file)),served=fs.readFileSync(path.join(ROOT,'_site',file));
    const payload=bytes=>file.endsWith('.gz')?zlib.gunzipSync(bytes):bytes;
    if(json(JSON.parse(payload(input)))!==json(JSON.parse(payload(served)))) throw new Error(`Stale built source: ${file}; rebuild canonical site`);
    inputSourceFiles[file]=hash(input);
  }
  const sourceAcquisition={kind:'local-published-file-read',acquiredAt:new Date().toISOString(),upstreamRetrievedAt:null};
  process.env.PORT='0';
  const server=require('./serve-site').startServer({build:false});
  await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const {chromium}=require('playwright');
  let browser;
  try {
    browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    const page=await browser.newPage();
    await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort('blockedbyclient'));
    // Regression adversary: the historical midpoint is wrong for the area.
    await page.route('https://nominatim.openstreetmap.org/**',r=>r.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*'},body:fs.readFileSync(path.join(ROOT,'tests/e2e/fixtures/network/nominatim-reverse-bonn.json'))}));
    // Exercise canonical offline defaults rather than merely comparing source strings.
    await page.route('**/templates/**/*.txt',r=>r.abort('blockedbyclient'));
    await page.goto(origin+'/werkbank_v2.html?'+CASE_QUERY,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.UA?.getRuntimeContext?.()?.allPts?.length && window.UA?.AnalysisScope && window.UA?.aiPoliticalReferenceBridge && window.UA?.aiVisualResearch && window.UA?.filingReadiness && window.UA?.exportProvenanceRuntime,null,{timeout:90000});
    for (const id of ['cbIncludeOsmContext','cbIncludeCosts','cbIncludeMeasures']) await page.locator('#'+id).evaluate(el=>{el.checked=false;});
    await page.locator('#btnOpenExport').click();
    await page.locator('#areaNameInput').fill(AREA);
    await page.locator('#areaSearchTermsInput').fill(PLACES.join('; '));
    await page.locator('#btnConfirmAreaName').click();
    await page.waitForFunction(name=>document.getElementById('exportProgress')?.textContent==='Fertig.' && document.getElementById('exportHtml')?.textContent.includes(name),AREA,{timeout:60000});
    const out=await page.evaluate(async()=>{
      const U=window.UA,c=U.getRuntimeContext();
      // Bind the actual unexecuted state; do not trigger or invent research.
      c.politicalContextResearch=U.aiPoliticalEvidence.currentState(c);
      U.aiPoliticalEvidence.install(); U.aiPoliticalReferenceBridge.install(); U.aiVisualResearch.install();
      const report=await U.computeExportReport(c),s=report.structured;
      const facts=U.aiProposal._internal.buildExternalAiFactsPackage({structured:s,deterministicReportText:report.text,mapUrl:window.location.href,generatedAt:new Date().toISOString(),city:c.CITY_RAW});
      const manifest=await U.exportProvenanceRuntime.createManifest(c,{UA:U,root:window});
      const scene=U.MapScene.fromCtx(c);
      const declarativeScene={city:scene.city,center:scene.center,zoom:scene.zoom,selection:scene.selection,filters:scene.filters,layers:scene.layers,accidentView:scene.accidentView};
      const gate=U.filingReadiness.evaluate({facts,result:{}});
      return {structured:s,reportText:report.text,facts,externalPrompt:U.aiProposal._internal.buildExternalAiPrompt(facts),scene:declarativeScene,
        searchTerms:U.PoliticalContext.buildSearchTerms(c),plannedQueries:U.PoliticalContext.buildSearchTerms(c).map(term=>({term,url:U.aiPoliticalEvidence.OFFICIAL_PORTALS.bonn.searchUrl(term),status:'planned-not-executed'})),manifest,gate,selected:U.AnalysisScope.refreshScopePoints(c).selected.length};
    });
    if(out.selected!==out.structured.severity.total) throw new Error(`Runtime scope/report population mismatch: ${out.selected} versus ${out.structured.severity.total}`);
    if(!out.reportText.includes('Bezirksvertretung Bonn') || /Bezirksrat/.test(out.reportText)) throw new Error('Bonn recipient/template path mismatch');
    if(out.structured.meta.areaName!==AREA || out.structured.meta.activeFilterScope.areaName!==AREA) throw new Error('Confirmed area name did not reach the real report scopes');
    if(PLACES.some(t=>!out.searchTerms.includes(t)) || out.searchTerms.includes('Adenauerallee')) throw new Error('Confirmed multi-place search terms mismatch: '+JSON.stringify(out.searchTerms));
    if(out.gate.filingReadinessStatus!=='blocked') throw new Error('Missing-evidence case must stay blocked');
    // Actual reload path must preserve the explicit name through URL cleanup and hydration.
    const unchangedShare=new URL(page.url()); unchangedShare.searchParams.delete('export');
    await page.goto(unchangedShare.href,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(name=>window.UA?.getRuntimeContext?.()?.selectionBounds && window.UA?.getRuntimeContext?.()?.areaNameOverride===name && !window.UA?.isHydrating?.(),AREA,{timeout:90000});
    if(await page.locator('#areaNameInput').inputValue()!==AREA) throw new Error('Shared name did not restore');
    // Actual Leaflet drawing gesture, then share/reload without report/search.
    const drag=await page.evaluate(()=>{
      const U=window.UA,c=U.getRuntimeContext();
      U.setQS({export:null});
      window.__areaNameDrawReportCalls=0;
      const original=U.computeExportReport;
      U.computeExportReport=function(...args){window.__areaNameDrawReportCalls++;return original.apply(this,args);};
      const box=c.map.getContainer().getBoundingClientRect();
      // Draw in the unobscured right half, away from the left filter panel.
      return {from:{x:box.left+box.width*.60,y:box.top+box.height*.30},
        to:{x:box.left+box.width*.80,y:box.top+box.height*.60}};
    });
    await page.locator('.leaflet-draw-draw-rectangle').click();
    await page.mouse.move(drag.from.x,drag.from.y);await page.mouse.down();
    await page.mouse.move(drag.to.x,drag.to.y,{steps:8});await page.mouse.up();
    const shared=await page.evaluate(()=>({url:window.location.href,reportCalls:window.__areaNameDrawReportCalls,
      north:window.UA.getRuntimeContext().selectionBounds.getNorth()}));
    if(shared.reportCalls!==0 || Math.abs(shared.north-BOUNDS.north)<1e-6) throw new Error('Draw/share regression did not exercise a new area before reporting: '+JSON.stringify(shared));
    await page.goto(shared.url,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.UA?.getRuntimeContext?.()?.allPts?.length && window.UA?.getRuntimeContext?.()?.selectionBounds && !window.UA?.isHydrating?.(),null,{timeout:90000});
    const afterReload=await page.evaluate(()=>({name:window.UA.getRuntimeContext().areaNameOverride||null,
      queryName:new URL(window.location.href).searchParams.get('areaName')}));
    if(afterReload.name || afterReload.queryName) throw new Error('Draw/share/reload inherited the old confirmed area: '+JSON.stringify(afterReload));
    const newReport=await page.evaluate(async()=>{const c=window.UA.getRuntimeContext();c.exportOptions={includeOsmContext:false,includeCosts:false,includeMeasures:false};const r=await window.UA.computeExportReport(c);return r.structured.meta.areaName;});
    if(newReport===AREA) throw new Error('New geometry report retained the old area name');
    const drawShareRegression={reportCallsBeforeSharing:shared.reportCalls,newNorth:shared.north,restoredName:afterReload.name,reportAreaName:newReport};
    // A viewport-only confirmation must survive normal view hydration too.
    const viewportUrl=new URL(page.url());
    for(const key of ['selSouth','selWest','selNorth','selEast','areaName','areaSearchTerms','areaNameGeometry','export']) viewportUrl.searchParams.delete(key);
    await page.goto(viewportUrl.href,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.UA?.getRuntimeContext?.()?.allPts?.length && !window.UA?.isHydrating?.(),null,{timeout:90000});
    for(const id of ['cbIncludeOsmContext','cbIncludeCosts','cbIncludeMeasures']) await page.locator('#'+id).evaluate(el=>{el.checked=false;});
    await page.locator('#btnOpenExport').click();
    const viewportName='Bestätigter Kartenausschnitt Bonn Hbf';
    await page.locator('#areaNameInput').fill(viewportName);await page.locator('#btnConfirmAreaName').click();
    await page.waitForFunction(name=>window.UA?.getRuntimeContext?.()?.areaNameOverride===name,viewportName);
    const viewportShare=new URL(page.url());viewportShare.searchParams.delete('export');
    await page.goto(viewportShare.href,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.UA?.getRuntimeContext?.()?.allPts?.length && !window.UA?.isHydrating?.(),null,{timeout:90000});
    const viewportRestored=await page.evaluate(()=>({name:window.UA.getRuntimeContext().areaNameOverride||null,
      selection:!!window.UA.getRuntimeContext().selectionBounds}));
    if(viewportRestored.name!==viewportName || viewportRestored.selection) throw new Error('Viewport-only name lost during hydration: '+JSON.stringify(viewportRestored));
    const raw = {...out,inputSourceFiles,sourceAcquisition,drawShareRegression,viewportReloadRegression:viewportRestored};
    const snapshot = snapshotFromRuntime(raw);
    const council = require('../tests/fixtures/bonn-hbf-political-research.json');
    if (council.caseId !== snapshot.case.id) throw new Error('Council research belongs to a different case.');
    const maps = reviewedMapHints(snapshot);
    // Use the public counterpart of each exact URL in the local facts package.
    const facts = {...out.facts, visualSceneAnalysisContract: {...out.facts.visualSceneAnalysisContract,
      inspectionViews: out.facts.visualSceneAnalysisContract.inspectionViews.map(view => ({...view, url:canonicalUrl(view.url)}))}};
    const result = {
      accessedResources: maps.views.map(view => ({mapMode:view.mode, url:view.url, status:'opened'})),
      politicalAdministrativeResearch: {status:'results-found', queries:council.queries, proceedings:council.references},
    };
    raw.councilGate = await page.evaluate(data => window.UA.filingReadiness.evaluate(data), {facts,result});
    if (!raw.councilGate.filingReady) throw new Error('Local evidence does not support the researched case: '
      + JSON.stringify(raw.councilGate.errors));
    return raw;
  } finally {if(browser) await browser.close();await new Promise(r=>server.close(r));}
}
function snapshotFromRuntime(raw) {
  const s=raw.structured,d=structuredClone(s.deterministicAnalysisDigest);
  delete d.meta.date;d.meta.link=canonicalUrl(d.meta.link);
  const rows=s.evidenceCohorts.completeEvidenceCohort.rows.filter(r=>s.evidenceCohorts.discoveryCohort.accidentIds.includes(r.displayId)).map(({mapDeepLink,...row})=>row);
  const sources=raw.inputSourceFiles;
  const runtime=Object.fromEntries(RUNTIME.map(f=>['js/'+f,fileHash('js/'+f)]));
  const scene=raw.scene;
  const views=s.visualInspectionViews.map(view=>({id:view.id,mapMode:view.mapMode,url:canonicalUrl(view.url)}));
  return {schemaVersion:'unfallwerkbank.bonnHbfAiGolden.v1',case:{id:'bonn-hbf-37-rad-pkw-2019-2025',areaName:AREA,formerlyMislabelled:'Adenauerallee (unconfirmed midpoint; not the case name)',bounds:BOUNDS,analysisUrl:canonicalUrl(s.meta.link),filters:s.meta.filters},
    inputs:{sourceFiles:sources,runtimeFiles:runtime,sourceDataFingerprint:raw.manifest.dataFingerprint,
      mapScene:scene,mapSceneFingerprint:hash(json(scene)),mapInputsFingerprint:hash(json({scene,views,rows})),
      mapViews:views,mapImageEvidence:{status:'not-captured',imageSha256:null,reason:'Hermetic generation blocks external tiles. Scene/input fingerprints are not live image verification.'}},
    facts:{totalAccidents:s.totalAccidents,severity:s.severity,yearTable:s.yearTable,yearlyTrend:s.yearlyTrend,deviations:s.deviations,scopeCounts:s.scopeCounts,heatmap:s.heatmap,poi:s.poi,
      discoveryRows:rows,completeAreaCount:s.evidenceCohorts.completeEvidenceCohort.count,digest:d,methodology:s.analysisMethodology,
      methodLimits:{referencePopulation:s.meta.baselineScope,multiplePatternSearch:'exploratory; individual isSignificant values are unadjusted, not family-wise significance',exposureRates:'unavailable without suitable traffic-performance denominators',comparisonMethod:s.deviations.reference?.method || 'legacy-local-wilson'}},
    politicalResearch:{status:s.politicalContextResearch.status,executed:false,attempts:[],searchTerms:raw.searchTerms,
      officialPortalUrl:s.politicalContextResearch.officialPortalUrl,plannedQueries:raw.plannedQueries,
      verifiedDirectProceedings:[],positiveCaseEvidence:'blocked: real motions, resolutions, administrative answers, trials and plans have not been verified'},
    modelRelease:{status:'blocked',actualProviderRun:false,providerReceipt:null,positiveAcceptance:false,required:['Configured provider run on exact facts/prompt','Exact model version and timestamp','Production schema and value-add rubric evaluation','Completed source-linked political research','Four-mode live map inspection']}};
}
function reviewedMapHints(snapshot) {
  const directory = 'tests/fixtures/bonn-hbf-map-views';
  const capture = require('../tests/fixtures/bonn-hbf-map-views/capture.json');
  if (capture.caseId !== snapshot.case.id || capture.mapInputsFingerprint !== snapshot.inputs.mapInputsFingerprint
      || capture.views.length !== snapshot.inputs.mapViews.length) throw new Error('Map observation case or inputs changed.');
  for (const expected of snapshot.inputs.mapViews) {
    const view = capture.views.find(entry => entry.mode === expected.mapMode);
    if (!view || view.url !== expected.url || json(view.bounds) !== json(snapshot.case.bounds)
        || view.selected !== snapshot.facts.totalAccidents || fileHash(path.join(directory, view.file)) !== view.fileSha256) {
      throw new Error('Map observation or preview changed for ' + expected.mapMode);
    }
  }
  return {sourceType:'visual_context', source:{layerName:'Öffentliche Bonner Kartenansichten',
    provider:'© OpenStreetMap-Mitwirkende und Geobasis NRW', mapModeLabel:'Standard, Hybrid, Orthofoto, Analyse'},
    hints:capture.observations, recommendation:capture.limits, views:capture.views, build:capture.build};
}
function prepareModelReview(raw,outDir,councilEvidence,mapHints) {
  const {deriveFeatures}=require('../server/ai/features/deriveFeatures');
  const {preselectMeasures}=require('../server/ai/scoring/preselectMeasures');
  const service=require('../server/ai/aiAssessmentServiceV2');
  const {PROMPT_VERSION}=require('../server/ai/prompts/exportAssessmentPrompt.v2');
  const structured = councilEvidence ? {...raw.structured,
    politicalContextResearch: {status:'results-found', queries:councilEvidence.queries},
    politicalReferences: councilEvidence.references,
    visualContextHints: mapHints,
  } : raw.structured;
  const contextHints = councilEvidence ? {notes:[...councilEvidence.authorities,
    'Auftrag: Erstelle einen konkreten Prüf- und Berichtsauftrag mit Frist und überprüfbaren Kriterien. Ungeklärte Unfallursachen, Verkehrsmengen und Bauausführung bleiben Prüfgegenstand.',
    'Die nummerierte Beweisanlage gehört zum Entwurf. Der Haupttext muss die geprüften Unfallgruppen auseinanderhalten. Eine unabhängige Fachprüfung der Antwort steht aus.',
  ]} : undefined;
  const features=deriveFeatures(structured, contextHints),preselected=preselectMeasures(features,{citySlug:'bonn'});
  const input=service.buildAiInputV2(structured,features,preselected,contextHints);
  // Only the reference harness uses localhost. The provider and reviewers need the public case URL.
  input.meta.link = canonicalUrl(input.meta.link);
  input.deterministicAnalysisDigest.meta = {...input.deterministicAnalysisDigest.meta, link:input.meta.link};
  const comparisonDigest = input.aiAnalysisComparisonContract.deterministicDigest;
  comparisonDigest.meta = {...comparisonDigest.meta, link:input.meta.link};
  const prompt = service.buildProviderPrompt(input, 'proposal-brief');
  if (JSON.stringify([input, prompt]).includes('127.0.0.1')) throw new Error('The provider evidence contains a loopback URL.');
  const binding={inputSha256:hash(json(input)),promptSha256:hash(json(prompt))};
  const schema='server/ai/schema/proposalBrief.v1.schema.json',rubric='server/ai/proposalBriefValueAddCore.js';
  const receipt={status:'blocked',executedAt:null,providerConfigured:service.isAvailable(),requestedProvider:service.activeProviderName(),requestedModel:configuredModel(),actualModelVersion:null,responseSha256:null,...binding,promptVersion:PROMPT_VERSION,schemaSha256:fileHash(schema),rubricSha256:fileHash(rubric),
    rubricDimensions:['Methodentreue','Erhalt amtlicher Fakten','Zusätzlicher Erkenntniswert','Politische Anschlussfähigkeit','Maßnahmenqualität','Quellenauflösbarkeit'],
    requiredProviderReceiptFields:['provider','model','modelVersion','promptVersion','executedAt','inputSha256','promptSha256','schemaSha256','rubricSha256','responseSha256'],
    blockingReasons:['This input receipt precedes provider execution.', councilEvidence
      ? 'The researched draft requires an actual provider response and independent subject review.'
      : 'No real positive political/map evidence exists for this generation.']};
  if (councilEvidence) {
    receipt.candidateCohorts = input.evidenceCohortCounts;
    receipt.localEvidenceGate = raw.councilGate;
    if (!receipt.localEvidenceGate?.filingReady || !receipt.candidateCohorts) {
      throw new Error('The positive case requires the local readiness gate and the three cohort counts.');
    }
    const appendix = structured.evidenceCohorts.completeEvidenceCohort.rows.map(
      ({displayId, year, severityLabel, involvementLabel, mapRef, mapDeepLink, discoveryMatch}) =>
        ({displayId, year, severityLabel, involvementLabel, mapRef, mapDeepLink:canonicalUrl(mapDeepLink), discoveryMatch}));
    if (appendix.length !== receipt.candidateCohorts.completeArea
        || new Set(appendix.map(row => row.displayId)).size !== appendix.length
        || appendix.filter(row => row.discoveryMatch).length !== receipt.candidateCohorts.discovery) {
      throw new Error('Numbered appendix no longer matches the disjointly reported cohort roles.');
    }
    receipt.appendixSha256 = hash(json(appendix));
    write(path.join(outDir,'numbered-evidence-appendix.json'), appendix);
    write(path.join(outDir,'local-evidence-gate.json'), raw.councilGate);
  }
  write(path.join(outDir,'production-model-input.json'),input);write(path.join(outDir,'production-model-prompt.json'),prompt);
  if (councilEvidence) write(path.join(outDir,'council-research.json'),councilEvidence);
  else {
    write(path.join(outDir,'external-facts.json'),raw.facts);
    fs.writeFileSync(path.join(outDir,'external-prompt.md'),raw.externalPrompt);
  }
  write(path.join(outDir,'model-review-receipt.json'),receipt);return {receipt, prompt, input};
}
async function runBoundModelReview(prompt, binding, outDir, councilEvidence) {
  const service = require('../server/ai/aiAssessmentServiceV2');
  if (service.activeProviderName() !== 'gemini' || !service.isAvailable()) {
    throw new Error('A live model review requires AI_PROVIDER=gemini and GEMINI_API_KEY.');
  }
  const { callStructuredGeminiWithMetadata } = require('../server/ai/providers/geminiStructuredProvider');
  const schema = require('../server/ai/schema/proposalBrief.v1.schema.json');
  const capture = await callStructuredGeminiWithMetadata({ ...prompt, responseSchema: service.toGeminiSchema(schema) });
  const executedAt = new Date().toISOString();
  const runDir = fs.mkdtempSync(path.join(outDir, 'provider-run-'));
  fs.writeFileSync(path.join(runDir, 'raw-response.txt'), capture.text);
  const response = service.parseJsonLoose(capture.text);
  const receipt = {
    provider: 'gemini', model: capture.model, modelVersion: capture.modelVersion, executedAt,
    inputSha256: binding.inputSha256, promptSha256: binding.promptSha256,
    schemaSha256: binding.schemaSha256, rubricSha256: binding.rubricSha256,
    promptVersion: binding.promptVersion, responseSha256: hash(json(response)), rawResponseSha256: hash(capture.text),
  };
  write(path.join(runDir, 'response.json'), response);
  write(path.join(runDir, 'receipt.json'), receipt);
  const review = reviewModelResponse(response, receipt, binding, councilEvidence);
  write(path.join(runDir, 'review.json'), review);
  if (!review.providerReceiptVerified) throw new Error('Provider returned incomplete execution evidence: ' + runDir);
  if (councilEvidence && !review.councilEvidenceCasePassed) throw new Error('Live model failed the council-source comparison: ' + runDir);
  if (!councilEvidence && !review.blockerCasePassed) throw new Error('Live model failed the blocked case; inspect review.json in ' + runDir);
  console.log('[bonn-hbf-ai] Live provider response and review: ' + runDir);
}
async function main(args=process.argv.slice(2)) {
  const runModel = args.includes('--run-model');
  const replayModel = args.includes('--replay-model');
  if ((runModel && replayModel)
      || ((runModel || replayModel) && (args.includes('--model-response') || args.includes('--update')))) {
    throw new Error('Live and fixture replay runs are separate and require comparison with the existing Golden.');
  }
  const outDir=path.join(ROOT,'out/qa/bonn-hbf-ai'),fixture=path.join(ROOT,'tests/fixtures/bonn-hbf-ai-golden.v1.json');
  fs.mkdirSync(outDir,{recursive:true});
  const raw=await captureRuntime({skipBuild:args.includes('--skip-build')});
  const snapshot=snapshotFromRuntime(raw);
  const baseline=prepareModelReview(raw,outDir);
  const { receipt:review } = baseline;
  write(path.join(outDir,'current-snapshot.json'),snapshot);write(path.join(outDir,'source-manifest.json'),raw.manifest);
  fs.writeFileSync(path.join(outDir,'deterministic-report.txt'),raw.reportText);
  const execution={generatedAt:new Date().toISOString(),sourceAcquisition:raw.sourceAcquisition,node:process.version,templatePath:'canonical-generated-offline-defaults',...review,
    localFilingGate:raw.gate,drawShareRegression:raw.drawShareRegression,viewportReloadRegression:raw.viewportReloadRegression};write(path.join(outDir,'execution-receipt.json'),execution);
  if(args.includes('--model-response')) {
    const i=args.indexOf('--model-response'),j=args.indexOf('--provider-receipt');
    const response=JSON.parse(fs.readFileSync(args[i+1]));const provider=j<0?null:JSON.parse(fs.readFileSync(args[j+1]));
    write(path.join(outDir,'imported-model-review.json'),reviewModelResponse(response,provider,review));
  }
  if(args.includes('--update')) write(fixture,snapshot);
  else {
    const differences=compareSnapshots(JSON.parse(fs.readFileSync(fixture)),snapshot);
    write(path.join(outDir,'golden-drift.json'),differences);
    if(differences.length) throw new Error(`Golden drift (${differences.length} paths). Inspect out/qa/bonn-hbf-ai/golden-drift.json; source/runtime hashes distinguish input/code drift from changed facts. Update only after review.`);
  }
  const councilEvidence = require('../tests/fixtures/bonn-hbf-political-research.json');
  if (councilEvidence.caseId !== snapshot.case.id) throw new Error('Council research belongs to a different case.');
  const councilDir = path.join(outDir, 'council-research');
  const council = prepareModelReview(raw, councilDir, councilEvidence, reviewedMapHints(snapshot));
  if (runModel || replayModel) {
    // Each case must retain its own response even if the other one fails its rubric.
    const errors = [];
    const cases = [
      { candidate: baseline, directory: outDir, localGate: raw.gate },
      { candidate: council, directory: councilDir, localGate: raw.councilGate, evidence: councilEvidence },
    ];
    for (const { candidate, directory, localGate, evidence } of cases) {
      try {
        if (replayModel) {
          const result = await runModelReplay({ input: candidate.input, binding: candidate.receipt, outDir: directory,
            caseId: snapshot.case.id, councilEvidence: evidence, localGate });
          if (!result.passed) throw new Error('Model fixture failed review: ' + result.directory);
        } else {
          await runBoundModelReview(candidate.prompt, candidate.receipt, directory, evidence);
        }
      } catch (error) { errors.push(error.message); }
    }
    if (errors.length) throw new Error([...new Set(errors)].join('\n'));
    if (replayModel) console.log('[bonn-hbf-ai] PASS: both ChatGPT-authored fixture responses passed the production model handoff and Bonn evidence checks.');
  }
  console.log(`[bonn-hbf-ai] PASS: ${snapshot.facts.totalAccidents} selected / ${snapshot.facts.completeAreaCount} complete area; reproducible facts, model/political/map release remains blocked.`);
}
if(require.main===module)main().catch(e=>{console.error(e.stack);process.exitCode=1;});
module.exports={BOUNDS,AREA,PLACES,canonicalUrl,compareSnapshots,snapshotFromRuntime,reviewModelResponse,runBoundModelReview,captureRuntime,reviewedMapHints,main};
