'use strict';

// Both modules are browser-capable UMD integrations and therefore install
// themselves when Jest provides JSDOM's window. Reproduce the application's
// dependency order instead of loading ua.export_provenance without the legacy
// exporters it deliberately requires.
const previousUA = window.UA;
window.UA = {
  exportToCSV: jest.fn(),
  exportToGeoJSON: jest.fn(),
  exportToKML: jest.fn(),
};
const baseProvenance = require('../../js/ua.export_provenance');
const adapter = require('../../js/ua.accident_year_provenance');
window.UA = previousUA || {};

function context(properties = {}) {
  return {
    CITY_RAW: 'Bonn',
    allPts: [{
      lat: 50.7315,
      lon: 7.1025,
      props: {
        ukategorie: '3',
        istrad: '1',
        istpkw: '1',
        ...properties,
      },
    }],
  };
}

const environment = {
  UA: {
    BUILD: 'test-build',
    normKey: value => String(value).toLowerCase(),
  },
  root: {},
};

describe('accident year provenance adapter', () => {
  test.each([
    [{ year: 2024 }, 2024],
    [{ year: '2024' }, 2024],
    [{ ujahr: '2024' }, 2024],
    [{ UJAHR: 2024 }, 2024],
    [{ Jahr: '2024' }, 2024],
  ])('normalizes supported year vocabulary %p', (properties, expected) => {
    expect(adapter.accidentYear(properties)).toBe(expected);
    expect(adapter.adaptPoint(context(properties).allPts[0]).props.year).toBe(expected);
  });

  test.each([null, undefined, '', ' ', 0, '0', 1899, 2101, 'not-a-year'])
    ('does not coerce missing or invalid year %p to zero', value => {
      expect(adapter.normalizedYear(value)).toBeNull();
    });

  test('builds a valid SourceManifest from the legacy ujahr field', async () => {
    const original = context({ ujahr: '2024' });
    const adapted = adapter.adaptContext(original);

    expect(adapted).not.toBe(original);
    expect(adapted.allPts[0].props.year).toBe(2024);
    expect(original.allPts[0].props.year).toBeUndefined();

    const manifest = await baseProvenance.createManifest(adapted, environment);
    expect(manifest.scenario.years).toEqual([2024]);
    expect(manifest.sources[0].temporalCoverage).toBe('2024–2024');
  });

  test('omits scenario years when no trustworthy accident year exists', async () => {
    const original = context({ ujahr: '' });
    const adapted = adapter.adaptContext(original);
    expect(adapted.allPts[0].props.year).toBe(adapter.UNKNOWN_YEAR_SENTINEL);

    const manifest = await baseProvenance.createManifest(adapted, environment);
    expect(manifest.scenario).not.toHaveProperty('years');
    expect(manifest.sources[0]).not.toHaveProperty('temporalCoverage');
  });

  test('installs one shared manifest adapter for runtime and data exporters', async () => {
    const createManifest = jest.fn(async adapted => ({
      schemaVersion: 1,
      scenario: { years: [adapted.allPts[0].props.year] },
    }));
    const csv = jest.fn(async ctx => ctx.exportSourceManifest);
    const geojson = jest.fn(async ctx => ctx.exportSourceManifest);
    const UA = {
      exportProvenanceRuntime: Object.freeze({ createManifest }),
      exportProvenance: Object.freeze({ marker: true }),
      exportToCSV: csv,
      exportToGeoJSON: geojson,
    };
    const root = {};
    const runtime = adapter.install(UA, root);
    const ctx = context({ ujahr: '2024' });

    const csvResult = await UA.exportToCSV(ctx);
    const geoJsonResult = await UA.exportToGeoJSON(ctx);

    expect(runtime.createManifest).toBe(UA.exportProvenanceRuntime.createManifest);
    expect(createManifest).toHaveBeenCalledTimes(2);
    for (const [adapted] of createManifest.mock.calls) {
      expect(adapted.allPts[0].props.year).toBe(2024);
    }
    expect(csvResult.scenario.years).toEqual([2024]);
    expect(geoJsonResult.scenario.years).toEqual([2024]);
    expect(csv).toHaveBeenCalledTimes(1);
    expect(geojson).toHaveBeenCalledTimes(1);
    expect(ctx).not.toHaveProperty('exportSourceManifest');
  });

  test('preserves an explicitly supplied manifest and restores previous bindings', async () => {
    const createManifest = jest.fn(async () => { throw new Error('must not run'); });
    const existingManifest = { schemaVersion: 1, scenario: { city: 'Bonn' } };
    const csv = jest.fn(async ctx => ctx.exportSourceManifest);
    const UA = {
      exportProvenanceRuntime: Object.freeze({ createManifest }),
      exportToCSV: csv,
      exportToGeoJSON: jest.fn(),
    };
    adapter.install(UA, {});
    const ctx = { ...context({ ujahr: '2024' }), exportSourceManifest: existingManifest };

    await expect(UA.exportToCSV(ctx)).resolves.toBe(existingManifest);
    expect(createManifest).not.toHaveBeenCalled();
    expect(ctx.exportSourceManifest).toBe(existingManifest);
  });
});
