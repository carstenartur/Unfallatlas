'use strict';
const traffic = require('../../js/ua.traffic_provider');
module.exports = function typedTraffic(type = 'count', value = 0, year = 2019) {
  const source = traffic.normalizeDescriptor({ id: `traffic.${type}.runtime-fixture`, measurementType: type,
    modes: ['motor_vehicle'], unit: 'Kfz/24 h', priority: 1, publisher: 'Stadt Köln',
    datasetTitle: 'Runtime-Vertragstest', datasetUrl: 'https://example.org/traffic',
    distributionUrl: 'https://example.org/traffic.csv', licenseId: 'DL-DE-Zero-2.0', licenseName: 'Datenlizenz Deutschland – Zero – Version 2.0',
    licenseUrl: 'https://www.govdata.de/dl-de/zero-2-0', requiredAttribution: 'Stadt Köln',
    temporalCoverage: String(year), spatialCoverage: 'Köln', versionOrPublicationDate: `${year}-12-31`,
    retrievedAt: '2026-11-01T00:00:00Z', contentHash: 'a'.repeat(64), changedOrDerived: true,
    changeNotice: 'Testfixture, keine Produktionsdaten.', permissions: { permitsRedistribution: true,
      permitsDerivatives: true, commercialUseAllowed: true }, qualityNotes: [] });
  const observation = traffic.normalizeObservation({ observationId: 'fixture', measurementType: type,
    mode: 'motor_vehicle', year, period: 'DTVw', value, unit: 'Kfz/24 h', wayId: '10', direction: 'A → B' }, source, 0);
  const evidence = traffic.selectTrafficEvidence([{ observation, wayId: '10', distanceMeters: 0,
    matchQuality: 'high', matchMethod: 'explicit-way-id' }], { referenceYear: 2026, mode: 'motor_vehicle' });
  const row = {};
  require('../../scripts/apply-matched-traffic').applyRow(row, { evidence, observations: [observation] });
  return row;
};
