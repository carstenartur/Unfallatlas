'use strict';

const JSZip = require('jszip');

function readBlob(blob, mode = 'text') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
    if (mode === 'arrayBuffer') reader.readAsArrayBuffer(blob);
    else reader.readAsText(blob);
  });
}

function validCustomManifest() {
  return {
    schemaVersion: 1,
    artifactId: 'custom-hannover-export',
    generatedAt: '2026-07-22T12:00:00Z',
    applicationVersion: 'test-build',
    buildFingerprint: 'a'.repeat(64),
    dataFingerprint: 'b'.repeat(64),
    scenario: { city: 'Hannover', filters: {}, years: [2024] },
    sources: [
      {
        sourceId: 'custom.accidents',
        role: 'accidents',
        publisher: 'Test publisher',
        datasetTitle: 'Custom accident data',
        datasetUrl: 'https://example.com/dataset',
        licenseId: 'CC0-1.0',
        licenseName: 'Creative Commons CC0 1.0 Universal',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        retrievedAt: '2026-07-22T11:00:00Z',
        changedOrDerived: false,
      },
    ],
    transformations: [],
  };
}

function testContext() {
  const bounds = {
    contains: ([lat, lon]) => lat >= 52 && lat <= 53 && lon >= 9 && lon <= 10,
    getSouth: () => 52,
    getWest: () => 9,
    getNorth: () => 53,
    getEast: () => 10,
  };
  return {
    CITY_RAW: 'Hannover',
    allPts: [
      {
        lat: 52.376,
        lon: 9.732,
        props: {
          year: '2024',
          ukategorie: '2',
          IstRad: '1',
          IstFuss: '0',
          IstPKW: '1',
          IstKrad: '0',
          IstGkfz: '0',
          IstSonstig: '0',
          ustunde: '8',
          uwochentag: '2',
          strzustand: '0',
        },
      },
      { lat: 48.1, lon: 11.5, props: { year: '2024', ukategorie: '3' } },
    ],
    selectionBounds: bounds,
    involvementMode: 'and',
    ui: {
      severityEl: { value: 'all' },
      roadConditionEl: { value: 'all' },
      incBikeEl: { checked: true },
      incPedEl: { checked: false },
      incCarEl: { checked: true },
      incMotoEl: { checked: false },
      incGkfzEl: { checked: false },
      incSonEl: { checked: false },
      hFromEl: { value: '0' },
      hToEl: { value: '23' },
      dayTypeEl: { value: 'all' },
    },
  };
}

function installRuntime() {
  jest.resetModules();
  const downloads = jest.fn();
  window.fetch = jest.fn().mockRejectedValue(new Error('offline test'));
  window.saveAs = downloads;
  window.UA = {
    BUILD: 'test-build',
    normKey: value => String(value).toLowerCase(),
    matchesNonInvolvementFilters: () => true,
    exportToCSV: () => {
      window.saveAs(
        new Blob(['lat,lon,year\n52.376,9.732,2024\n'], { type: 'text/csv;charset=utf-8' }),
        'Unfallatlas_hannover_2026-07-22.csv',
      );
    },
    exportToGeoJSON: () => {
      const document = {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [9.732, 52.376] },
            properties: { year: '2024' },
          },
        ],
      };
      window.saveAs(
        new Blob([JSON.stringify(document)], { type: 'application/geo+json' }),
        'Unfallatlas_hannover_2026-07-22.geojson',
      );
    },
    exportToKML: () => {
      const document = '<?xml version="1.0"?><kml><Document><name>Hannover</name>' +
        '<Placemark><Point><coordinates>9.732,52.376,0</coordinates></Point></Placemark>' +
        '</Document></kml>';
      window.saveAs(
        new Blob([document], { type: 'application/vnd.google-earth.kml+xml' }),
        'Unfallatlas_hannover_2026-07-22.kml',
      );
    },
  };

  const sourceManifest = require('../../js/ua.source_manifest');
  const artifactProvenance = require('../../js/ua.artifact_provenance');
  const zip = require('../../js/ua.zip');
  const exportProvenance = require('../../js/ua.export_provenance');
  return { downloads, sourceManifest, artifactProvenance, zip, exportProvenance };
}

describe('live data exports use one fail-closed SourceManifest', () => {
  afterEach(() => {
    delete window.fetch;
    delete window.saveAs;
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('packages CSV with the exported data and complete linked provenance', async () => {
    const { downloads } = installRuntime();
    const result = await window.UA.exportToCSV(testContext());

    expect(downloads).toHaveBeenCalledTimes(1);
    const [blob, filename] = downloads.mock.calls[0];
    expect(filename).toBe('Unfallatlas_hannover_2026-07-22.zip');
    expect(blob.type).toBe('application/zip');

    const archive = await JSZip.loadAsync(new Uint8Array(await readBlob(blob, 'arrayBuffer')));
    expect(Object.keys(archive.files).sort()).toEqual([
      'README.txt',
      'Unfallatlas_hannover_2026-07-22.csv',
      'sources.json',
    ]);
    expect(await archive.file('Unfallatlas_hannover_2026-07-22.csv').async('string')).toContain(
      '52.376,9.732,2024',
    );
    const manifest = JSON.parse(await archive.file('sources.json').async('string'));
    expect(manifest.sources[0].sourceId).toBe('accidents.de.unfallatlas');
    expect(manifest.sources[0].datasetUrl).toContain('statistikportal.de');
    expect(manifest.sources[0].licenseUrl).toContain('dl-de/by-2-0');
    expect(manifest.scenario.years).toEqual([2024]);
    expect(manifest.scenario.filters.involvementMode).toBe('and');
    expect(manifest.scenario.filters.dataExportInvolvementPolicy).toContain('alle Kombinationen');
    expect(await archive.file('README.txt').async('string')).toContain(
      result.packageEntries.sourceManifestSha256,
    );
  });

  test('embeds the same cached manifest in GeoJSON and KML', async () => {
    const { downloads } = installRuntime();
    const ctx = testContext();

    const geoResult = await window.UA.exportToGeoJSON(ctx);
    const geoDownload = downloads.mock.calls[0];
    const geojson = JSON.parse(await readBlob(geoDownload[0]));
    expect(geoDownload[1]).toMatch(/\.geojson$/);
    expect(geojson.metadata.sourceManifest).toEqual(geoResult.manifest);
    expect(geojson.metadata['unfallatlas:sourceManifestSha256']).toMatch(/^[a-f0-9]{64}$/);
    expect(geojson.features[0].properties['unfallatlas:sourceIds']).toEqual([
      'accidents.de.unfallatlas',
    ]);

    downloads.mockClear();
    const kmlResult = await window.UA.exportToKML(ctx);
    const kmlDownload = downloads.mock.calls[0];
    const kml = await readBlob(kmlDownload[0]);
    expect(kmlDownload[1]).toMatch(/\.kml$/);
    expect(kml).toContain('unfallatlas:sourceManifestSha256');
    expect(kml).toContain('unfallatlas:sourceManifestJson');
    expect(kml).toContain('accidents.de.unfallatlas');
    expect(kmlResult.manifest).toBe(geoResult.manifest);
  });

  test('supports a strict custom manifest without inventing default Source-IDs', async () => {
    const { downloads } = installRuntime();
    const ctx = testContext();
    ctx.exportSourceManifest = validCustomManifest();

    await window.UA.exportToGeoJSON(ctx);
    const geojson = JSON.parse(await readBlob(downloads.mock.calls[0][0]));
    expect(geojson.features[0].properties['unfallatlas:sourceIds']).toEqual([
      'custom.accidents',
    ]);
    expect(geojson.metadata.sourceManifest.sources[0].sourceId).toBe('custom.accidents');
  });

  test('fails closed before any legacy file escapes when provenance is invalid', async () => {
    const { downloads } = installRuntime();
    const ctx = testContext();
    ctx.exportSourceManifest = { schemaVersion: 1, sources: [] };

    await expect(window.UA.exportToCSV(ctx)).rejects.toThrow(/missing_sources|unknown_field/);
    expect(downloads).not.toHaveBeenCalled();
  });

  test('serializes simultaneous exports so saveAs interception cannot cross streams', async () => {
    const { downloads } = installRuntime();
    const ctx = testContext();

    const [csv, geojson, kml] = await Promise.all([
      window.UA.exportToCSV(ctx),
      window.UA.exportToGeoJSON(ctx),
      window.UA.exportToKML(ctx),
    ]);

    expect(downloads).toHaveBeenCalledTimes(3);
    expect(downloads.mock.calls.map(call => call[1]).sort()).toEqual([
      csv.filename,
      geojson.filename,
      kml.filename,
    ].sort());
    expect(csv.manifest).toBe(geojson.manifest);
    expect(geojson.manifest).toBe(kml.manifest);
  });
});
