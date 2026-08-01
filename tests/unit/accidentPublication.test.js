'use strict';

const {
  AccidentPublicationError,
  auditRegression,
  countCsvRows,
  stableJson,
  validatePolicy,
} = require('../../scripts/validate-accident-publication');

function policy() {
  return validatePolicy({
    schemaVersion: 1,
    contract: 'unfallwerkbank-accident-data-policy/v1',
    source: {
      publisher: 'Publisher',
      datasetTitle: 'Dataset',
      officialIndexUrl: 'https://example.test/index',
      officialStatusUrl: 'https://example.test/status',
      licenseId: 'DL-DE-BY-2.0',
      licenseUrl: 'https://example.test/license',
    },
    firstYear: 2016,
    expectedLatestYear: 2025,
    officialReleaseDate: '2026-07-07',
    minimumConfiguredCities: 1,
    regressionPolicy: {
      minimumRetainedCityFeatureFraction: 0.8,
      minimumRetainedScenarioFraction: 0.8,
    },
    canonicalScenarioMinimums: {
      scenario: 1,
    },
  });
}

function manifest({ cityCount = 100, scenarioCount = 50, latestYear = 2025 } = {}) {
  return {
    contract: 'unfallwerkbank-accident-data-release/v1',
    latestYear,
    cities: [{ slug: 'bonn', featureCount: cityCount }],
    canonicalScenarios: [{ id: 'scenario', matches: scenarioCount }],
  };
}

describe('accident publication contract', () => {
  test('counts CSV rows with CRLF, quoted commas, escaped quotes and quoted newlines', () => {
    const csv = [
      'id,text',
      '1,plain',
      '2,"comma, inside"',
      '3,"escaped ""quote"""',
      '4,"line one',
      'line two"',
      '',
    ].join('\r\n');
    expect(countCsvRows(Buffer.from(csv), 'fixture.csv')).toBe(4);
  });

  test('rejects malformed quoted CSV instead of silently miscounting', () => {
    expect(() => countCsvRows(Buffer.from('id,text\n1,"unterminated\n'), 'bad.csv'))
      .toThrow(AccidentPublicationError);
  });

  test('stable JSON is independent of object insertion order', () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(stableJson({ a: { c: 3, d: 4 }, b: 2 }));
  });

  test('policy binds the exact official latest year', () => {
    expect(policy().expectedLatestYear).toBe(2025);
    expect(() => validatePolicy({
      ...policy(),
      expectedLatestYear: 2015,
    })).toThrow(/expectedLatestYear is before firstYear/);
  });

  test('candidate release may grow but cannot lose more than the reviewed fraction', () => {
    expect(() => auditRegression(
      manifest({ cityCount: 100, scenarioCount: 50 }),
      manifest({ cityCount: 100, scenarioCount: 50 }),
      policy()
    )).not.toThrow();

    expect(() => auditRegression(
      manifest({ cityCount: 79, scenarioCount: 50 }),
      manifest({ cityCount: 100, scenarioCount: 50 }),
      policy()
    )).toThrow(/city_feature_regression/);

    expect(() => auditRegression(
      manifest({ cityCount: 100, scenarioCount: 39 }),
      manifest({ cityCount: 100, scenarioCount: 50 }),
      policy()
    )).toThrow(/scenario_regression/);
  });

  test('candidate release cannot remove a city or move the latest year backwards', () => {
    expect(() => auditRegression(
      { ...manifest(), cities: [] },
      manifest(),
      policy()
    )).toThrow(/city_removed/);

    expect(() => auditRegression(
      manifest({ latestYear: 2024 }),
      manifest({ latestYear: 2025 }),
      policy()
    )).toThrow(/latest_year_regression/);
  });
});
