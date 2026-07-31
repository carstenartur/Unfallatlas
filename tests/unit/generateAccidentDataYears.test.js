'use strict';

const {
  parseArgs,
  resolveYears,
} = require('../../scripts/generate-accident-data');

describe('accident data generator year selection', () => {
  test('normalizes an explicit reproducible year override', () => {
    const args = parseArgs(['--years', '2025,2023 2024']);
    expect(args.years).toEqual([2023, 2024, 2025]);
  });

  test('does not contact the official index when years are explicit', async () => {
    const discover = jest.fn();
    await expect(
      resolveYears({ years: [2024, 2025], yearIndexUrl: 'https://example.invalid/' }, discover)
    ).resolves.toEqual([2024, 2025]);
    expect(discover).not.toHaveBeenCalled();
  });

  test('uses the configured official index when no override is supplied', async () => {
    const discover = jest.fn(async () => [2016, 2025]);
    await expect(
      resolveYears({ years: null, yearIndexUrl: 'https://example.test/index/' }, discover)
    ).resolves.toEqual([2016, 2025]);
    expect(discover).toHaveBeenCalledWith({
      indexUrl: 'https://example.test/index/',
    });
  });
});
