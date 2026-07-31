'use strict';

const {
  OFFICIAL_INDEX_URL,
  parseAvailableAccidentYears,
  validateAvailableAccidentYears,
  parseYearOverride,
  discoverAccidentYears,
} = require('../../scripts/lib/accident-year-discovery');

describe('official accident year discovery', () => {
  test('extracts unique CSV years, ignores Shape files and sorts ascending', () => {
    const html = `
      <a href="Unfallorte2025_EPSG25832_CSV.zip">2025 CSV</a>
      <a href="Unfallorte2024_EPSG25832_Shape.zip">2024 Shape</a>
      <a href="Unfallorte2023_EPSG25832_CSV.zip">2023 CSV</a>
      <a href="/archive/Unfallorte2025_EPSG25832_CSV.zip">duplicate</a>
      <a href="Unfallorte2024_EPSG25832_CSV.zip">2024 CSV</a>
    `;

    expect(parseAvailableAccidentYears(html)).toEqual([2023, 2024, 2025]);
  });

  test('returns every year from 2016 through the highest official distribution', () => {
    const years = Array.from({ length: 10 }, (_unused, index) => 2016 + index);
    expect(validateAvailableAccidentYears(years)).toEqual(years);
  });

  test('fails closed when an official year is missing below the maximum', () => {
    expect(() =>
      validateAvailableAccidentYears([2016, 2017, 2019])
    ).toThrow(/missing CSV years: 2018/);
  });

  test('discovers years from the official index with an injectable fetch implementation', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () =>
        Array.from(
          { length: 10 },
          (_unused, index) =>
            `<a href="Unfallorte${2016 + index}_EPSG25832_CSV.zip">CSV</a>`
        ).join('\n'),
    }));

    await expect(discoverAccidentYears({ fetchImpl })).resolves.toEqual(
      Array.from({ length: 10 }, (_unused, index) => 2016 + index)
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      OFFICIAL_INDEX_URL,
      expect.objectContaining({ redirect: 'follow' })
    );
  });

  test('normalizes explicit year overrides without forcing a contiguous range', () => {
    expect(parseYearOverride('2025, 2023 2024;2025')).toEqual([2023, 2024, 2025]);
  });
});
