"use strict";

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {gunzipSync} = require('node:zlib');
const api = require('../../scripts/providers/duesseldorf_bicycle_hourly_provider');
const traffic = require('../../js/ua.traffic_provider');
const root = path.join(__dirname, '../fixtures/traffic/duesseldorf');
const counts = gunzipSync(fs.readFileSync(path.join(root, 'mannesmannufer2024-original-excerpt.csv.gz')));
const stations = gunzipSync(fs.readFileSync(path.join(root, 'stations-original.csv.gz')));
const evidence = require('../fixtures/traffic/duesseldorf/provenance.json');
const clocks = {retrievedAt: evidence.countDistribution.retrievedAt, stationsRetrievedAt: evidence.stationDistribution.retrievedAt};

function changed(field, value) {
  const lines = counts.toString('utf8').split('\r\n');
  const headers = lines[0].replace(/^\uFEFF/, '').split(';');
  const row = lines[1].split(';'); row[headers.indexOf(field)] = value;
  lines[1] = row.join(';'); return Buffer.from(lines.join('\r\n'));
}

test('preserves genuine original hourly direction counts and zero, using the official named station point', () => {
  const result = api.parseHourlyCsv(counts, stations);
  expect(result.rowCount).toBe(6);
  expect(result.observations).toHaveLength(12);
  expect(result.observations.slice(0, 4).map(row => [row.value, row.direction])).toEqual([
    [1, 'Mannesmann Ufer Stadteinwaerts (Ri. Sueden)'], [0, 'Mannesmann Ufer Stadtauswaerts (Ri. Norden)'],
    [5, 'Mannesmann Ufer Stadteinwaerts (Ri. Sueden)'], [14, 'Mannesmann Ufer Stadtauswaerts (Ri. Norden)'],
  ]);
  expect(result.observations[0]).toMatchObject({year: 2024, mode: 'bicycle', unit: 'Fahrräder/Stunde',
    geometry: {type: 'Point', coordinates: [6.76712, 51.22015]}});
  expect(result.observations[0].period).toContain('01-01-2024 00:00:00');
  expect(result.observations[0].qualityNotes.join(' ')).toContain('Zeitzone');
  expect(result.observations[0].wayId).toBeUndefined();
  expect(result.gaps).toContainEqual({previous: '31-03-2024 01:00:00', next: '31-03-2024 03:00:00', labelHours: 2});
  expect(result.observations.some(row => row.period.includes('31-03-2024 02:00:00'))).toBe(false);
  expect(result.observations.filter(row => row.period.includes('27-10-2024 02:00:00'))).toHaveLength(2);
});

test('an absent directional value remains absent without turning into zero or a total', () => {
  const result = api.parseHourlyCsv(changed('Mannesmann Ufer Stadteinwaerts (Ri. Sueden)', ''), stations);
  expect(result.observations).toHaveLength(11);
  expect(result.missingCountCells).toBe(1);
  expect(result.observations[0].value).toBe(0);
});

test.each(['-1', '1.5', '1,5', 'NaN', '9007199254740992'])('rejects invalid hourly count %s', value => {
  expect(() => api.parseHourlyCsv(changed('Mannesmann Ufer Stadteinwaerts (Ri. Sueden)', value), stations)).toThrow(/invalid_count/);
});

test.each(['30-02-2024 00:00:00', '01-01-2023 00:00:00', '01-01-2024 24:00:00', '01-01-2024 00:30:00',
  '01-01-2024T00:00:00Z', '01-01-2024 01:00:00'])('rejects impossible, drifted or duplicate source labels %s', value => {
  expect(() => api.parseHourlyCsv(changed('Zeit', value), stations)).toThrow(/invalid_time|duplicate_time|unordered_time/);
});

test('rejects missing, duplicated and invalid station geometry instead of choosing a nearby site', () => {
  const text = stations.toString('utf8');
  expect(() => api.parseHourlyCsv(counts, Buffer.from(text.replace('mannesmann ufer-totem 01', 'unknown station')))).toThrow(/missing_station/);
  const row = text.split('\n').find(line => line.startsWith('mannesmann ufer-totem 01;'));
  expect(() => api.parseHourlyCsv(counts, Buffer.from(text + '\n' + row + '\n'))).toThrow(/duplicate_station/);
  expect(() => api.parseHourlyCsv(counts, Buffer.from(text.replace('51.22015', '')))).toThrow(/invalid_coordinate/);
});

test('fails closed on header, CSV width, invalid UTF8 and HTML drift', () => {
  expect(() => api.parseHourlyCsv(Buffer.from('<html>Error</html>'), stations)).toThrow();
  expect(() => api.parseHourlyCsv(Buffer.from(counts.toString('utf8').replace('Zeit;', 'Date;')), stations)).toThrow(/header/);
  expect(() => api.parseHourlyCsv(Buffer.from(counts.toString('utf8').replace(';1;0;', ';1;0;extra;')), stations)).toThrow(/row_width/);
  expect(() => api.parseHourlyCsv(Buffer.concat([Buffer.from([255]), counts]), stations)).toThrow(/invalid_utf8/);
});

test('normalization preserves separate count license, geometry source pin and both real acquisition clocks', async () => {
  const parsed = api.parseHourlyCsv(counts, stations);
  const registry = traffic.createRegistry();
  registry.register(traffic.createProvider({descriptor: api.createDescriptor(clocks), loadObservations: async () => parsed.observations}));
  const rows = await registry.collect({city: 'Düsseldorf', mode: 'bicycle', failOnProviderError: true});
  expect(rows).toHaveLength(12);
  expect(rows[0].source).toMatchObject({licenseId: 'DL-DE-BY-2.0', requiredAttribution: 'Landeshauptstadt Düsseldorf',
    retrievedAt: clocks.retrievedAt, contentHash: evidence.countDistribution.sha256});
  const quality = rows[0].source.qualityNotes.join(' ');
  expect(quality).toContain(evidence.stationDistribution.sha256);
  expect(quality).toContain('DL-DE-Zero-2.0');
  expect(quality).toContain(clocks.stationsRetrievedAt);
  expect(rows.every(row => row.wayId === null && !row.match)).toBe(true);
});

test.each(['retrievedAt', 'stationsRetrievedAt'])('rejects unknown/date-only/impossible %s', field => {
  for (const value of [undefined, '2026-11-08', '2026-02-30T12:00:00Z'])
    expect(() => api.createDescriptor({...clocks, [field]: value})).toThrow(/invalid_date|retrievedAt/);
});

test('file loader rejects excerpt substitution, either pin drift, path escape and symlinks', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'duesseldorf-hourly-'));
  try {
    fs.writeFileSync(path.join(temp, 'counts.csv'), counts); fs.writeFileSync(path.join(temp, 'stations.csv'), stations);
    fs.symlinkSync(path.join(temp, 'stations.csv'), path.join(temp, 'link.csv'));
    const options = {...clocks, allowedRoot: temp, csvPath: 'counts.csv', stationsPath: 'stations.csv',
      expectedDistributionSha256: evidence.countDistribution.sha256, expectedBytes: evidence.countDistribution.bytes,
      expectedStationsSha256: evidence.stationDistribution.sha256, expectedStationsBytes: evidence.stationDistribution.bytes};
    expect(() => api.createDuesseldorfBicycleHourlyProvider(options)).toThrow(/distribution_hash_mismatch/);
    expect(() => api.createDuesseldorfBicycleHourlyProvider({...options, expectedStationsSha256: 'b'.repeat(64)})).toThrow(/unreviewed_distribution/);
    expect(() => api.createDuesseldorfBicycleHourlyProvider({...options, csvPath: '../escape'})).toThrow(/unsafe_path/);
    expect(() => api.createDuesseldorfBicycleHourlyProvider({...options, csvPath: 'stations.csv', stationsPath: 'link.csv'})).toThrow(/symlink/);
  } finally {fs.rmSync(temp, {recursive: true, force: true});}
});
