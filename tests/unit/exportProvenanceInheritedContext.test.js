/** @jest-environment node */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const provenance = require('../../js/ua.export_provenance');
const accidentYear = require('../../js/ua.accident_year_provenance');
const documentProvenance = require('../../js/ua.document_export_provenance');
const { createVideoExportContextFixture } = require('../fixtures/videoExportContextFixture');

function runtime(root = {}) {
  const UA = {
    BUILD: 'video-fixture-provenance-regression',
    WEEKEND_SET: new Set(['1', '7']),
    artifactProvenance: require('../../js/ua.artifact_provenance'),
    exportProvenance: provenance,
    // The year adapter installs these boundaries; snapshot tests do not invoke
    // the data downloads or the unrelated scheduled UI refreshes.
    exportToCSV() {},
    exportToGeoJSON() {},
  };
  const sandbox = vm.createContext({ window: { UA }, setTimeout() {} });
  for (const filename of ['ua.filters.js', 'ua.analysis_scope.js']) {
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../js', filename), 'utf8'), sandbox, { filename });
  }
  UA.exportProvenanceRuntime = {
    createManifest: (ctx, environment) => provenance.createManifest(ctx, environment),
  };
  accidentYear.install(UA, root);
  return UA;
}

function videoContext() {
  const fixture = createVideoExportContextFixture();
  return {
    CITY_RAW: 'Bonn',
    allPts: fixture.geojson.features.map(feature => ({
      lat: feature.geometry.coordinates[1],
      lon: feature.geometry.coordinates[0],
      props: { ...feature.properties },
    })),
    involvementMode: 'or',
    selectionBounds: { south: 50.728, west: 7.098, north: 50.734, east: 7.106 },
    map: { getBounds: () => ({ south: 50.72, west: 7.09, north: 50.74, east: 7.11 }) },
    ui: {
      severityEl: { value: 'all' }, roadConditionEl: { value: 'all' },
      dayTypeEl: { value: 'all' }, hFromEl: { value: '0' }, hToEl: { value: '23' },
      incBikeEl: { checked: true }, incPedEl: { checked: true },
      incCarEl: { checked: true }, incMotoEl: { checked: false },
      incGkfzEl: { checked: false }, incSonEl: { checked: false },
    },
    contextFilters: {
      slopeClasses: new Set(['steep', 'very_steep']),
      trafficClasses: new Set(['high', 'very_high']),
      onlyMatchedWays: true,
    },
    contextCapabilities: { hasSlope: true, hasTrafficProxy: true, hasOsmContext: true },
    contextLayerState: { ...fixture.ways, meta: fixture.meta },
  };
}

test('the production video fixture reaches a bound document snapshot through the real year and filter adapters', async () => {
  const UA = runtime();
  const ctx = videoContext();
  const snapshot = await documentProvenance.createSnapshot(ctx, UA, {});

  expect(snapshot.manifest.scenario).toMatchObject({ city: 'Bonn', years: [2024], filters: {
    contextSlopeClasses: ['steep', 'very_steep'], contextTrafficClasses: ['high', 'very_high'], onlyMatchedWays: true,
  } });
  expect(snapshot.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(UA.AnalysisScope.getActiveFilteredPoints(snapshot.boundContext)).toHaveLength(12);
  expect(snapshot.boundContext.allPts.every(point => point.props.year === 2024)).toBe(true);
  expect(ctx.allPts.every(point => point.props.year === undefined)).toBe(true);
  expect(provenance.buildContextNote(UA, snapshot.boundContext).sources.some(source => /Verkehrsproxy/.test(source.label))).toBe(true);
});

test.each(['or', 'and', 'solo'])('a standalone adapted preview preserves the real %s involvement filter', mode => {
  const UA = runtime();
  const ctx = videoContext();
  ctx.involvementMode = mode;
  ctx.ui.incPedEl.checked = false;
  const note = provenance.buildContextNote(UA, accidentYear.adaptContext(ctx));
  if (mode === 'solo') expect(note).toBeNull();
  else expect(note.sources.some(source => /Verkehrsproxy/.test(source.label))).toBe(true);
});

test('binding an adapted context without a cached manifest preserves its inherited city, bounds and capabilities', async () => {
  const UA = runtime();
  const ctx = videoContext();
  const canonical = { ...ctx, allPts: accidentYear.adaptContext(ctx).allPts };
  const originalManifest = await provenance.createManifest(canonical, { UA, root: {} });
  const transferredManifest = JSON.parse(JSON.stringify(originalManifest));
  const bound = provenance.bindExportContext(UA, accidentYear.adaptContext(ctx), transferredManifest);

  expect(bound.CITY_RAW).toBe('Bonn');
  expect(bound.selectionBounds).toEqual({ south: 50.728, west: 7.098, north: 50.734, east: 7.106 });
  expect(bound.contextCapabilities).toEqual({ hasSlope: true, hasTrafficProxy: true, hasOsmContext: true });
  expect(bound.map).toBe(ctx.map);
  expect(UA.AnalysisScope.getActiveFilteredPoints(bound)).toHaveLength(12);
  ctx.CITY_RAW = 'changed-after-binding';
  ctx.selectionBounds = null;
  expect(bound.CITY_RAW).toBe('Bonn');
  expect(bound.selectionBounds).not.toBeNull();
});

test('parallel video snapshots freeze inherited severity, context filters and selection before asynchronous hashing', async () => {
  let releaseBuild;
  let startedBuild;
  const started = new Promise(resolve => { startedBuild = resolve; });
  const root = { fetch: () => {
    startedBuild();
    return new Promise(resolve => { releaseBuild = () => resolve({ ok: false }); });
  } };
  const UA = runtime(root);
  const ctx = videoContext();
  ctx.selectionBounds = { south: 50.728, west: 7.098, north: 50.734, east: 7.0995 };
  ctx.contextFilters.slopeClasses = new Set(['very_steep']);
  ctx.contextFilters.trafficClasses = new Set(['high']);
  ctx.ui.severityEl.value = '2';
  const firstPending = documentProvenance.createSnapshot(ctx, UA, root);
  await Promise.race([started, firstPending]);
  ctx.ui.severityEl.value = '3';
  const secondPending = documentProvenance.createSnapshot(ctx, UA, root);
  ctx.ui.severityEl.value = 'all';
  ctx.ui.incBikeEl.checked = false;
  ctx.ui.incPedEl.checked = false;
  ctx.ui.incCarEl.checked = false;
  ctx.contextFilters.trafficClasses.clear();
  ctx.contextFilters.trafficClasses.add('low');
  ctx.selectionBounds = null;
  releaseBuild();

  const [first, second] = await Promise.all([firstPending, secondPending]);
  expect(first.boundContext.allPts.map(point => point.props.id)).toEqual(['bonn-video-e2e-10']);
  expect(second.boundContext.allPts.map(point => point.props.id)).toEqual(['bonn-video-e2e-11', 'bonn-video-e2e-12']);
  expect(first.manifest.scenario.filters.severity).toBe('2');
  expect(second.manifest.scenario.filters.severity).toBe('3');
  expect(first.manifest.scenario.bounds).toEqual({ south: 50.728, west: 7.098, north: 50.734, east: 7.0995 });
  expect(first.manifest.dataFingerprint).not.toBe(second.manifest.dataFingerprint);
  expect(UA.AnalysisScope.getActiveFilteredPoints(first.boundContext)).toHaveLength(1);
  expect(UA.AnalysisScope.getActiveFilteredPoints(second.boundContext)).toHaveLength(2);
  expect(provenance.buildContextNote(UA, first.boundContext)).not.toBeNull();
  expect(provenance.buildContextNote(UA, second.boundContext)).not.toBeNull();
  expect(provenance.buildContextNote(UA, ctx)).toBeNull();
});
