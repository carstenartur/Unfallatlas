/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {gunzipSync} = require('node:zlib');
const {buildOsmDataset, parseOverpassResponse} = require('../../scripts/producers/osm_producer');
const source = require('../../scripts/providers/bast_annual_dtv_provider');
const {applyBastAnnualDtv, shouldStageBastTraffic} = require('../../scripts/providers/bast_traffic_application');
const {fingerprintJsonArtifact} = require('../../scripts/check-enrichment-inputs');
const traffic = require('../../js/ua.traffic_provider');
const fixture = require('../fixtures/traffic/bast/muenster-st-mauritz-gold.json');
const hamburg = require('../fixtures/traffic/bast/hamburg-kollaustrasse-gold.json');
const receipt = require('../fixtures/traffic/bast/provenance.json');

const WAY = '1370981346';
const STATION = 'bast-dz5506-2023-Q';
const original = gunzipSync(fs.readFileSync(path.join(__dirname, '../fixtures/traffic/bast/jawe2023-original.csv.gz')));

function accident(properties = {}) {
  const feature = structuredClone(fixture.accident.feature);
  // Technical positive point at the official B 481 station, away from junctions.
  feature.geometry.coordinates = [7.67980698, 52.01308056];
  Object.assign(feature.properties, {
    id: 'technical-b481-2023',
    traffic_measurement_type: 'proxy', traffic_proxy_class: 'high',
    traffic_volume_source: 'OSM-highway-class-proxy', traffic_proxy_basis: 'highway=primary',
  }, properties);
  return feature;
}

function osmDataset(elements = fixture.osm.elements, provenance = fixture.osm) {
  return buildOsmDataset(null, parseOverpassResponse({elements}), {
    includeTrafficRouteTags: true, extractDate: provenance.retrievedAt.slice(0, 10),
    routeDistributionUrl: provenance.distributionUrl,
  });
}

async function apply(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bast-application-'));
  try {
    const slug = options.slug || 'muenster';
    const osmFile = path.join(root, `osm_${slug}.json`);
    const geojsonFile = path.join(root, `output_all_years_${slug}.geojson`);
    const metadataFile = path.join(root, `output_all_years_${slug}.enrichment.meta.json`);
    fs.writeFileSync(osmFile, JSON.stringify(options.osm || osmDataset()));
    fs.writeFileSync(geojsonFile, JSON.stringify({type: 'FeatureCollection', features: options.features || [accident()]}));
    fs.writeFileSync(metadataFile, JSON.stringify({sources: {traffic: {measurementType: 'proxy'}}, counts: {}, traffic: {}}));
    const initialFingerprint = fingerprintJsonArtifact(geojsonFile);
    const result = await applyBastAnnualDtv({slug, outputDir: root, workDir: root, osmFile,
      referenceYear: options.referenceYear || 2026, request: async () => new Response(options.sourceBytes || original)});
    expect(fingerprintJsonArtifact(geojsonFile)).toBe(initialFingerprint);
    return {result, features: JSON.parse(fs.readFileSync(geojsonFile)).features,
      meta: JSON.parse(fs.readFileSync(metadataFile))};
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('applies station 2201 to the real nearby 2023 Hamburg accident on the B 447 cross-section', async () => {
  const feature = structuredClone(hamburg.accident.feature);
  const {result, features} = await apply({slug: 'hamburg', osm: osmDataset(hamburg.osm.elements, hamburg.osm), features: [feature]});
  expect(result).toMatchObject({appliedFeatures: 1, matchedStations: 1});
  expect(features[0].properties).toMatchObject({id: '9757', matched_way_id: '1561698173', traffic_measurement_type: 'count',
    traffic_volume_value: 45865, traffic_volume_year: 2023, traffic_evidence: {distanceMeters: 3.7, observation: {
      observationId: 'bast-dz2201-2023-Q', wayId: '1561698173', direction: 'Querschnitt – beide Fahrtrichtungen',
    }}});
});

test('reports per-accident distance separately from the common station-to-road fit', async () => {
  const farther = structuredClone(hamburg.accident.feature);
  farther.geometry.coordinates = [9.95247865, 53.613335775];
  farther.properties.id = 'technical-b447-2023';
  const {result, features} = await apply({slug: 'hamburg', osm: osmDataset(hamburg.osm.elements, hamburg.osm),
    features: [hamburg.accident.feature, farther]});
  expect(result).toMatchObject({appliedFeatures: 2, matchedStations: 1});
  const [nearEvidence, farEvidence] = features.map(feature => feature.properties.traffic_evidence);
  expect(nearEvidence.statement).toContain('4 m entfernt');
  expect(farEvidence.distanceMeters).toBe(14.5);
  expect(farEvidence.statement).toContain('15 m entfernt');
  expect(farEvidence.observation).toEqual(nearEvidence.observation);
  expect(farEvidence.observation.qualityNotes).toEqual(expect.arrayContaining([
    expect.stringMatching(/^Abstand zwischen Zählstelle und OSM-Way: \d+,\d m\.$/),
  ]));
});

test.each(['1', undefined, '?'])('retains proxy when other participation is %s', async other => {
  const feature = structuredClone(hamburg.accident.feature);
  Object.assign(feature.properties, {istsonstig: other, traffic_measurement_type: 'proxy', traffic_proxy_class: 'high'});
  const {result, features} = await apply({slug: 'hamburg', osm: osmDataset(hamburg.osm.elements, hamburg.osm), features: [feature]});
  expect(result).toMatchObject({appliedFeatures: 0, matchedStations: 1});
  expect(features[0].properties).toMatchObject({traffic_measurement_type: 'proxy', traffic_proxy_class: 'high'});
  expect(features[0].properties.traffic_evidence).toBeUndefined();
});

test('requires agreeing lane totals when the two OSM direction tags establish bidirectionality', async () => {
  const elements = structuredClone(hamburg.osm.elements);
  elements.find(way => way.id === 1561698173).tags['lanes:backward'] = '3';
  const {result, features} = await apply({slug: 'hamburg', osm: osmDataset(elements, hamburg.osm), features: [hamburg.accident.feature]});
  expect(result.appliedFeatures).toBe(0);
  expect(features[0].properties.traffic_evidence).toBeUndefined();
});

test('applies the pinned St. Mauritz 2023 cross-section to a technical motor-vehicle point on the genuine B 481', async () => {
  const {result, features, meta} = await apply();
  const row = features[0].properties;
  expect(row).toMatchObject({id: 'technical-b481-2023', matched_way_id: WAY, traffic_measurement_type: 'count',
    traffic_volume_value: 12244, traffic_volume_unit: 'Kfz/24 h', traffic_volume_year: 2023,
    traffic_volume_source: source.SOURCE_ID, traffic_evidence: {evidenceType: 'measured', wayId: WAY,
      matchQuality: 'medium', observation: {observationId: STATION, wayId: WAY, mode: 'motor_vehicle',
        geometry: {type: 'Point', coordinates: [7.67980698, 52.01308056]}, direction: 'Querschnitt – beide Fahrtrichtungen',
        source: {licenseId: 'CC-BY-4.0', distributionUrl: receipt.url, contentHash: receipt.sha256}}}});
  expect(row.traffic_observations.map(item => item.observationId)).toEqual([STATION]);
  expect(row.traffic_proxy_class).toBeUndefined();
  expect(row.traffic_evidence.distanceMeters).toBeLessThan(3);
  expect(traffic.hasUsableTypedEvidence(row, {referenceYear: 2026, mode: 'motor_vehicle'})).toBe(true);
  expect(result).toMatchObject({appliedFeatures: 1, matchedStations: 1});
  expect(meta.sources.trafficMatched).toMatchObject({source: {datasetUrl: source.DATASET_URL, distributionUrl: receipt.url,
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/', publisher: expect.any(String),
    temporalCoverage: '2023-01-01/2023-12-31', retrievedAt: expect.any(String)},
  osm: {distributionUrl: fixture.osm.distributionUrl, licenseUrl: 'https://opendatacommons.org/licenses/odbl/1-0/',
    inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/)}});
  expect(meta.counts).toMatchObject({withTrafficProxy: 0, withTypedTraffic: 1});
});

test('retains proxy for the real Münster accident because another motor way meets B 481 at the point', async () => {
  const actual = structuredClone(fixture.accident.feature);
  Object.assign(actual.properties, {traffic_measurement_type: 'proxy', traffic_proxy_class: 'high'});
  const {result, features} = await apply({features: [actual]});
  expect(result).toMatchObject({appliedFeatures: 0, matchedStations: 1});
  expect(features[0].properties).toMatchObject({id: '62075', traffic_measurement_type: 'proxy', traffic_proxy_class: 'high'});
});

test('keeps explicit proxy for other years, non-motor modes, another way and a distant point', async () => {
  const far = accident();
  far.geometry.coordinates[1] += 0.003;
  const {features, meta} = await apply({features: [accident({year: 2024}), accident({istpkw: '0', istrad: '1'}),
    accident({istrad: '1'}), accident({matched_way_id: '160424445'}), far]});
  for (const {properties} of features) {
    expect(properties).toMatchObject({traffic_measurement_type: 'proxy', traffic_proxy_class: 'high'});
    expect(properties.traffic_evidence).toBeUndefined();
  }
  expect(meta.counts).toMatchObject({withTrafficProxy: 5, withTypedTraffic: 0});
});

test.each(['wrong route', 'oneway', 'parallel', 'tunnel'])('retains proxy for %s', async failure => {
  const elements = structuredClone(fixture.osm.elements);
  const way = elements.find(w => String(w.id) === WAY);
  if (failure === 'wrong route') way.tags.ref = 'B 481a; B 54';
  if (failure === 'oneway') way.tags.oneway = 'yes';
  if (failure === 'tunnel') way.tags.tunnel = 'yes';
  if (failure === 'parallel') elements.push({...way, id: 90000000001,
    geometry: way.geometry.map(p => ({lat: p.lat, lon: p.lon + 0.0001}))});
  const {features} = await apply({osm: osmDataset(elements)});
  expect(features[0].properties).toMatchObject({traffic_measurement_type: 'proxy', traffic_proxy_class: 'high'});
});

test('keeps a real local measurement distinct from stale context', async () => {
  const {features} = await apply({referenceYear: 2030});
  expect(features[0].properties.traffic_evidence).toMatchObject({evidenceType: 'stale-measured', ageYears: 7});
});

test('fails closed for modified official bytes and a cache missing route metadata', async () => {
  await expect(apply({sourceBytes: Buffer.alloc(original.length)})).rejects.toThrow(/SHA-256/);
  const osm = osmDataset();
  delete osm.trafficRouteTags;
  await expect(apply({osm})).rejects.toThrow(/route tags/);
});

test('scopes the production opt-in to the configured city and protects the Köln path', () => {
  const enabled = {CONTEXT_BAST_ANNUAL_COUNTS_CITY: 'Münster'};
  expect(shouldStageBastTraffic('muenster', enabled)).toBe(true);
  expect(shouldStageBastTraffic('bonn', enabled)).toBe(false);
  expect(shouldStageBastTraffic('muenster', {})).toBe(false);
  expect(shouldStageBastTraffic('koeln', {CONTEXT_BAST_ANNUAL_COUNTS_CITY: 'Köln'})).toBe(false);
});
