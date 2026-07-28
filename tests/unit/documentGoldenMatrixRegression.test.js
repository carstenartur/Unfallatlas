'use strict';

const scenarios = require('../../scripts/document-golden-scenarios');
const sampleDocx = require('../../scripts/generate-sample-docx');

describe('document Golden matrix regression boundaries', () => {
  test('preserves the established Bonn map fixture and detail-map contract', () => {
    const scenario = scenarios.getScenario(sampleDocx.DEFAULT_SCENARIO_ID);
    expect(sampleDocx.mapFixtureMetadata(scenario)).toEqual({
      title: 'Bonn road-safety golden fixture',
      scenario:
        '24 synthetic accidents, severity table, year trend and two report maps.',
    });
    expect(sampleDocx.clusterBounds(scenario)).toEqual({
      south: 50.73,
      west: 7.091,
      north: 50.735,
      east: 7.101,
    });
    expect(sampleDocx.clusterLabel(scenario)).toBe('Detailkarte Bonn-Zentrum');
  });

  test('does not emit a seemingly precise comparative ratio for only three cases', () => {
    const scenario = scenarios.getScenario('few-cases');
    const report = sampleDocx.createReportData(scenario);
    expect(report.structured.severity.total).toBe(3);
    expect(report.structured.deviations.focus).toEqual([]);
    expect(report.text).toContain(
      'Wegen der kleinen Fallzahl werden keine stabilen Häufigkeitsmuster oder Kausalitäten behauptet.',
    );
  });
});
