'use strict';

const {
  validateFeatureCollection,
} = require('../../scripts/lib/static-data-validation');

function collection(years) {
  return {
    type: 'FeatureCollection',
    features: years.map((year) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [7, 51] },
      properties: { year },
    })),
  };
}

describe('static accident data year validation', () => {
  test('accepts an artifact containing the required newest year', () => {
    expect(
      validateFeatureCollection(collection([2023, 2024, 2025]), {
        requiredYears: [2025],
      }).ok
    ).toBe(true);
  });

  test('marks an otherwise valid artifact stale when the newest year is absent', () => {
    const validation = validateFeatureCollection(collection([2023, 2024]), {
      requiredYears: [2025],
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain('GeoJSON is missing required accident years: 2025');
  });
});
