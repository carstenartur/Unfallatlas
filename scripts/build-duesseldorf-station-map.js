'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { createDuesseldorfBicycleHourlyProvider } = require('./providers/duesseldorf_bicycle_hourly_provider');

function buildStationMap(archive, target) {
  const provenance = JSON.parse(fs.readFileSync(path.join(archive, 'provenance.json'), 'utf8'));
  const counts = provenance.countDistribution, station = provenance.stationDistribution;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-station-map-'));
  try {
    for (const [name, file] of [['counts.csv', 'mannesmannufer2024-original.csv.gz'], ['station.csv', 'stations-original.csv.gz']])
      fs.writeFileSync(path.join(temp, name), gunzipSync(fs.readFileSync(path.join(archive, file))));

    const provider = createDuesseldorfBicycleHourlyProvider({ allowedRoot: temp, csvPath: 'counts.csv', stationsPath: 'station.csv',
      expectedDistributionSha256: counts.sha256, expectedBytes: counts.bytes, retrievedAt: counts.retrievedAt,
      expectedStationsSha256: station.sha256, expectedStationsBytes: station.bytes, stationsRetrievedAt: station.retrievedAt });
    const context = provider.loadReviewedStationContext();
    const { observations, ...metadata } = context;
    const hours = {};
    for (const reading of observations) {
      const label = reading.period.match(/^Stundenwert, Quellzeit: (.+)$/)?.[1];
      const direction = context.directions.findIndex(channel => channel.direction === reading.direction);
      if (!label || direction < 0) throw new Error('Unbekanntes Zeitlabel oder Zählrichtung');
      const pair = hours[label] ||= [null, null];
      if (pair[direction] !== null) throw new Error('Doppelter Stundenwert einer Richtung');
      pair[direction] = reading.value;
    }
    fs.writeFileSync(target, gzipSync(JSON.stringify({ ...metadata, hours }), { level: 9 }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  buildStationMap(path.join(root, 'tests/fixtures/traffic/duesseldorf'),
    path.join(root, 'data/mobility/duesseldorf-mannesmannufer-2024.json.gz'));
}
