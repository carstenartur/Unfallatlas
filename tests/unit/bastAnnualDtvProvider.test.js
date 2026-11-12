"use strict";

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {gunzipSync} = require('node:zlib');
const api = require('../../scripts/providers/bast_annual_dtv_provider');
const traffic = require('../../js/ua.traffic_provider');
const fixture = gunzipSync(fs.readFileSync(path.join(__dirname, '../fixtures/traffic/bast/jawe2023-original-excerpt.csv.gz')));
const receipt = require('../fixtures/traffic/bast/provenance.json');

function changed(field, value) {
  const lines = fixture.toString('latin1').split('\n');
  const headers = lines[0].trimEnd().split(';');
  const row = lines[2].trimEnd().split(';');
  row[headers.indexOf(field)] = value;
  lines[2] = row.join(';');
  return Buffer.from(lines.join('\n'), 'latin1');
}

test('retains original annual cross-section and directional counts, geographic coordinates and missing station evidence', () => {
  const result = api.parseAnnualCsv(fixture);
  expect(result.stationCount).toBe(3);
  expect(result.stationsWithoutCount).toBe(1);
  expect(result.observations).toHaveLength(6);
  expect(result.observations.slice(0, 3).map(row => [row.value, row.direction])).toEqual([
    [87412, 'Querschnitt – beide Fahrtrichtungen'],
    [44896, 'Ri. 1; Himmelsrichtung: N; Fernziel: Lübeck; Nahziel: AS Barsbüttel'],
    [42516, 'Ri. 2; Himmelsrichtung: S; Fernziel: Hamburg; Nahziel: AK Kreuz Hamburg-Ost (A24)'],
  ]);
  expect(result.observations[0]).toMatchObject({year: 2023, mode: 'motor_vehicle', unit: 'Kfz/24 h',
    geometry: {type: 'Point', coordinates: [10.18046539, 53.56327624]}});
  expect(result.observations[3]).toMatchObject({value: 12030, geometry: {type: 'Point', coordinates: [6.02934210, 50.76989182]}});
  expect(result.observations.some(row => row.observationId.includes('2218'))).toBe(false);
  expect(result.observations[0].wayId).toBeUndefined();
  expect(result.observations[0].qualityNotes.join(' ')).toContain('350');
  expect(result.observations[3].qualityNotes.join(' ')).toContain('Keine SV-Auswertung in 2023');
});

test.each(['-1', '87,412', '87.41', 'NaN', '1e5'])('rejects malformed count %s instead of fabricating a value', value => {
  expect(() => api.parseAnnualCsv(changed('DTV_Kfz_MobisSo_Q', value))).toThrow(/invalid_count/);
});

test('retains explicit zero and never reconstructs a missing total from directions', () => {
  expect(api.parseAnnualCsv(changed('DTV_Kfz_MobisSo_Q', '0')).observations[0].value).toBe(0);
  const result = api.parseAnnualCsv(changed('DTV_Kfz_MobisSo_Q', ''));
  expect(result.observations.filter(row => row.observationId.includes('1102'))).toHaveLength(2);
});

test.each([['Koor_WGS84_N', ''], ['Koor_WGS84_E', '999'], ['Koor_WGS84_N', '53.56327624'],
  ['DZ_Nr', '2218']])('rejects malformed/duplicate station identity or geometry %s=%s', (field, value) => {
  expect(() => api.parseAnnualCsv(changed(field, value))).toThrow(/invalid_coordinate|duplicate_station/);
});

test('rejects drifted headers, row widths and HTML rather than silently importing partial data', () => {
  expect(() => api.parseAnnualCsv(Buffer.from('<html>Service unavailable</html>'))).toThrow();
  expect(() => api.parseAnnualCsv(Buffer.from(fixture.toString('latin1').replace('DTV_Kfz_MobisSo_Q', 'invented'), 'latin1'))).toThrow(/header/);
  expect(() => api.parseAnnualCsv(Buffer.from(fixture.toString('latin1').replace('87.412;', '87.412;unexpected;'), 'latin1'))).toThrow(/row_width/);
});

test('the original excerpt uses the common source/observation contract without an invented OSM match', async () => {
  const parsed = api.parseAnnualCsv(fixture);
  const provider = traffic.createProvider({descriptor: api.createDescriptor(receipt.retrievedAt), loadObservations: async () => parsed.observations});
  const registry = traffic.createRegistry(); registry.register(provider);
  const result = await registry.collect({country: 'DE', failOnProviderError: true});
  expect(result).toHaveLength(6);
  expect(result[0].source).toMatchObject({licenseId: 'CC-BY-4.0', contentHash: receipt.sha256,
    requiredAttribution: 'Bundesanstalt für Straßen- und Verkehrswesen (BASt)', retrievedAt: receipt.retrievedAt});
  expect(result.every(row => row.wayId === null && !row.match)).toBe(true);
});

test('production file loading rejects excerpt substitution, pin drift, traversal and symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bast-dtv-'));
  try {
    fs.writeFileSync(path.join(root, 'excerpt.csv'), fixture);
    fs.symlinkSync(path.join(root, 'excerpt.csv'), path.join(root, 'linked.csv'));
    const options = {allowedRoot: root, csvPath: 'excerpt.csv', expectedDistributionSha256: receipt.sha256,
      expectedBytes: receipt.bytes, retrievedAt: receipt.retrievedAt};
    expect(() => api.createBastAnnualDtvProvider(options)).toThrow(/distribution_hash_mismatch/);
    expect(() => api.createBastAnnualDtvProvider({...options, expectedDistributionSha256: 'b'.repeat(64)})).toThrow(/unreviewed_distribution/);
    expect(() => api.createBastAnnualDtvProvider({...options, csvPath: '../escape.csv'})).toThrow(/unsafe_path/);
    expect(() => api.createBastAnnualDtvProvider({...options, csvPath: 'linked.csv'})).toThrow(/symlink/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('the real pinned factory only participates after the explicit Germany query opt-in', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bast-dtv-original-'));
  try {
    const original = gunzipSync(fs.readFileSync(path.join(__dirname, '../fixtures/traffic/bast/jawe2023-original.csv.gz')));
    fs.writeFileSync(path.join(root, 'original.csv'), original);
    const provider = api.createBastAnnualDtvProvider({allowedRoot: root, csvPath: 'original.csv',
      expectedDistributionSha256: receipt.sha256, expectedBytes: receipt.bytes, retrievedAt: receipt.retrievedAt});
    const registry = traffic.createRegistry(); registry.register(provider);
    for (const query of [{}, {city: 'Hannover'}, {country: 'de'}, {country: 'NL'}]) {
      expect((await registry.collect({...query, failOnProviderError: true})).length).toBe(0);
    }
    const rows = await registry.collect({country: 'DE', failOnProviderError: true});
    expect(rows).toHaveLength(4671);
    expect(provider.coverage).toEqual({stationCount: 2116, stationsWithoutCount: 559, observationCount: 4671});
    expect(provider.crossSectionRoutes['bast-dz2201-2023-Q']).toEqual({
      ref: 'B 447', laneCount: 7, directionLaneCounts: {Ri1: 4, Ri2: 3},
    });
    expect(rows.every(row => row.mode === 'motor_vehicle' && row.unit === 'Kfz/24 h' && row.wayId === null && !row.match)).toBe(true);
    expect(rows[0].source).toMatchObject({contentHash: receipt.sha256, retrievedAt: receipt.retrievedAt, licenseId: 'CC-BY-4.0'});
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test.each([undefined, '2026-11-08', '2026-02-30T12:00:00Z'])('requires an actual valid retrieval timestamp rather than a date or unknown clock: %s', value => {
  expect(() => api.createDescriptor(value)).toThrow(/invalid_date|retrievedAt/);
});
