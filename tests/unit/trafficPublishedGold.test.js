'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const crypto = require('node:crypto');
const traffic = require('../../js/ua.traffic_provider');
const snapshots = require('../../scripts/providers/traffic_snapshot_provider');
const root = path.resolve(__dirname, '../..');
const modelDir = path.join(root, 'tests/fixtures/traffic/hamburg-model');

function observations(city) {
  return JSON.parse(gunzipSync(fs.readFileSync(path.join(root, 'out', 'output_all_years_' + city + '.geojson.gz')))).features;
}

test.each(['hamburg', 'koeln'])('published numeric source in %s carries reproducible provenance', city => {
  const file = path.join(root, 'out', 'output_all_years_' + city + '.enrichment.meta.json.gz');
  const { source, coverage } = JSON.parse(gunzipSync(fs.readFileSync(file))).sources.trafficMatched;
  expect(source).toMatchObject({
    publisher: expect.stringMatching(/\S/), datasetUrl: expect.stringMatching(/^https:\/\//),
    distributionUrl: expect.stringMatching(/^https:\/\//), licenseUrl: expect.stringMatching(/^https:\/\//),
    licenseId: expect.stringMatching(/\S/), temporalCoverage: expect.stringMatching(/\d{4}/),
    retrievedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  if (city === 'koeln') {
    expect(coverage.excludedAmbiguousObservations).toBeGreaterThan(0);
    expect(coverage.publishedObservations + coverage.excludedAmbiguousObservations + coverage.excludedUnmatchedObservations)
      .toBe(coverage.totalObservations);
  } else {
    expect(coverage.ambiguousStations).toBeGreaterThan(0);
    expect(coverage.directionalContextFeatures).toBeLessThanOrEqual(coverage.appliedFeatures);
  }
});

test('the published Kollaustraße count remains distinct from its two station directions', () => {
  const row = observations('hamburg').find(({ properties: p }) => p.id === '9757' && p.year === 2023).properties;
  expect(traffic.hasUsableTypedEvidence(row, { referenceYear: 2026 })).toBe(true);
  expect(row.traffic_evidence).toMatchObject({ evidenceType: 'measured', observation: { value: 45865, year: 2023 } });
  expect(traffic.stationDirectionalObservations(row, row.traffic_evidence.observation).map(reading => reading.value).sort())
    .toEqual([22784, 23080]);
});

test('the published Bayenthalgürtel count keeps its stale warning; a road-only proxy stays qualitative', () => {
  const rows = observations('koeln');
  const byId = id => rows.find(({ properties: p }) => p.id === id && p.year === 2019).properties;
  const old = byId('96301');
  expect(traffic.hasUsableTypedEvidence(old, { referenceYear: 2026 })).toBe(true);
  expect(old.traffic_evidence).toMatchObject({ evidenceType: 'stale-measured',
    observation: { value: 5830, year: 2019 }, matchQuality: 'low', warning: expect.stringMatching(/älter/i) });
  const proxy = byId('95521');
  expect(proxy).toMatchObject({ traffic_measurement_type: 'proxy', traffic_proxy_class: 'high', traffic_proxy_basis: 'highway=secondary' });
  for (const key of ['traffic_volume_value', 'traffic_volume_unit', 'traffic_evidence']) expect(proxy).not.toHaveProperty(key);
});

test('the Hamburg model Golden reads the exact municipal feature and preserves its source line', async () => {
  const sourceId = 'traffic.model.hamburg-hvs-2019';
  const original = fs.readFileSync(path.join(modelDir, 'hvs-2019-feature-1.geojson'));
  const feature = JSON.parse(original);
  const registry = traffic.createRegistry();
  const provider = snapshots.createSnapshotProvider({ sourceId, allowedRoot: modelDir,
    snapshotPath: 'feature-1.snapshot.json', expectedSnapshotSha256: '6ad7ea7572ae2bcc90dcbf67dfa51808816614ec4447ddf93829b8a789aeb1fd' });
  registry.register(provider);
  expect(provider.descriptor.contentHash).toBe(crypto.createHash('sha256').update(original).digest('hex'));
  expect(provider.snapshot.distributionBytes).toBe(original.length);
  expect(provider.descriptor.distributionUrl).toBe(feature.links.find(link => link.rel === 'self').href);
  expect(provider.descriptor.requiredAttribution).toContain('Freie und Hansestadt Hamburg');
  const [observation] = await registry.collect({ city: 'Hamburg', mode: 'motor_vehicle', year: 2019, failOnProviderError: true });
  expect(observation).toMatchObject({ value: feature.properties.dtv, year: 2019, geometry: feature.geometry,
    unit: 'Kfz/24 h', measurementType: 'model', wayId: null });
  expect(traffic.selectTrafficEvidence([{ observation }], { referenceYear: 2019 })).toMatchObject({
    evidenceType: 'model', statement: expect.stringMatching(/Verkehrsmodell.*4\.000 Kfz\/24 h/),
  });
});
