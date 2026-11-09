'use strict';
// Original hourly source fixture with no claimed road association. This proves
// export fidelity, not a production station-to-road match or exposure model.
const fs = require('node:fs');
const path = require('node:path');
const { gunzipSync } = require('node:zlib');
const provider = require('../../scripts/providers/duesseldorf_bicycle_hourly_provider');
const traffic = require('../../js/ua.traffic_provider');
module.exports = function hourlyTraffic(index = 0) {
  const root = path.join(__dirname, 'traffic/duesseldorf');
  const receipt = require('./traffic/duesseldorf/provenance.json');
  const parsed = provider.parseHourlyCsv(
    gunzipSync(fs.readFileSync(path.join(root, 'mannesmannufer2024-original-excerpt.csv.gz'))),
    gunzipSync(fs.readFileSync(path.join(root, 'stations-original.csv.gz'))));
  const source = provider.createDescriptor({ retrievedAt: receipt.countDistribution.retrievedAt,
    stationsRetrievedAt: receipt.stationDistribution.retrievedAt });
  const observation = traffic.normalizeObservation(parsed.observations[index], source, index);
  const evidence = traffic.selectTrafficEvidence([{ observation, wayId: null,
    distanceMeters: null, matchQuality: null, matchMethod: null }], { referenceYear: 2026, mode: 'bicycle' });
  return { traffic_measurement_type: 'count', traffic_volume_value: observation.value,
    traffic_volume_unit: observation.unit, traffic_volume_year: observation.year,
    traffic_volume_source: source.sourceId, traffic_evidence: evidence, traffic_observations: [observation] };
};
