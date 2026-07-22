'use strict';

const fs = require('fs');
const path = require('path');

function loadApi() {
  jest.resetModules();
  window.UA = {};
  return require('../../js/ua.kml_export_provenance');
}

describe('direct live KML provenance exporter', () => {
  afterEach(() => {
    delete window.UA;
    jest.restoreAllMocks();
  });

  test('builds the legacy-compatible KML fields in one base string', () => {
    const api = loadApi();
    const points = [
      {
        lat: 52.376,
        lon: 9.732,
        props: {
          year: '2024',
          ukategorie: '2',
          IstRad: '1',
          IstPKW: '1',
          ustunde: '8',
          uwochentag: '2',
          strzustand: '0',
        },
      },
    ];
    const UA = {
      normKey: value => String(value).toLowerCase().replace('ö', 'oe').replace(/[^a-z0-9]+/g, '_'),
      exportProvenance: { exportPoints: jest.fn(() => points) },
    };

    const result = api.buildBaseKml(UA, { CITY_RAW: 'Köln & Test' }, '2026-07-22');

    expect(UA.exportProvenance.exportPoints).toHaveBeenCalledTimes(1);
    expect(result.filename).toBe('Unfallatlas_koeln_test_2026-07-22.kml');
    expect(result.pointCount).toBe(1);
    expect(result.kml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(result.kml).toContain('<name>Unfallatlas Köln &amp; Test 2026-07-22</name>');
    expect(result.kml).toContain('2024 Schwerverletzt (Rad+PKW)');
    expect(result.kml).toContain('<Data name="ustunde"><value>8</value></Data>');
    expect(result.kml).toContain('<coordinates>9.732,52.376,0</coordinates>');
  });

  test('keeps manifest metadata and placemarks in separate Blob parts', () => {
    const api = loadApi();
    const UA = {
      normKey: () => 'hannover',
      exportProvenance: {
        exportPoints: jest.fn(() => [
          { lat: 52.376, lon: 9.732, props: { year: '2024', ukategorie: '3' } },
          { lat: 52.38, lon: 9.74, props: { year: '2023', ukategorie: '2' } },
        ]),
      },
    };

    const result = api.buildKmlParts(
      UA,
      { CITY_RAW: 'Hannover' },
      '2026-07-22',
      '<ExtendedData><Data name="manifest"/></ExtendedData>',
    );

    expect(result.parts).toHaveLength(4);
    expect(result.parts[0]).toContain('<Data name="manifest"/>');
    expect(result.parts[1]).toContain('2024 Leichtverletzt');
    expect(result.parts[2]).toContain('2023 Schwerverletzt');
    expect(result.parts[3]).toBe('</Document></kml>');
    expect(result.pointCount).toBe(2);
  });

  test('installs a provenanced exporter without invoking the legacy Blob exporter', async () => {
    const api = loadApi();
    const legacyExporter = jest.fn();
    const manifest = { schemaVersion: 1, artifactId: 'test' };
    const anchor = {
      click: jest.fn(),
      remove: jest.fn(),
      hidden: false,
      href: '',
      download: '',
    };
    const root = {
      Blob,
      URL: {
        createObjectURL: jest.fn(() => 'blob:direct-kml'),
        revokeObjectURL: jest.fn(),
      },
      document: {
        createElement: jest.fn(() => anchor),
        body: { appendChild: jest.fn() },
      },
      setTimeout: jest.fn(callback => callback()),
      CustomEvent,
      dispatchEvent: jest.fn(),
      console: { error: jest.fn() },
    };
    const UA = {
      exportToKML: legacyExporter,
      normKey: () => 'hannover',
      exportProvenance: {
        exportPoints: jest.fn(() => [
          { lat: 52.376, lon: 9.732, props: { year: '2024', ukategorie: '3' } },
        ]),
      },
      exportProvenanceRuntime: {
        createManifest: jest.fn(async () => manifest),
      },
      artifactProvenance: {
        buildKmlExtendedData: jest.fn(async suppliedManifest => ({
          xml: '<ExtendedData><Data name="manifest"/></ExtendedData>',
          sourceManifestSha256: 'a'.repeat(64),
          suppliedManifest,
        })),
      },
    };

    api.install(UA, root);
    const result = await UA.exportToKML({ CITY_RAW: 'Hannover', ui: {}, allPts: [] });

    expect(legacyExporter).not.toHaveBeenCalled();
    expect(UA.exportProvenanceRuntime.createManifest).toHaveBeenCalledTimes(1);
    expect(UA.artifactProvenance.buildKmlExtendedData).toHaveBeenCalledWith(manifest);
    expect(root.URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.download).toMatch(/^Unfallatlas_hannover_.*\.kml$/);
    expect(result.pointCount).toBe(1);
    expect(result.manifest).toBe(manifest);
    expect(result.sourceManifestSha256).toBe('a'.repeat(64));
    expect(result).not.toHaveProperty('kml');
  });

  test('does not contain the legacy Blob capture and readback helpers', () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.kml_export_provenance.js'),
      'utf8',
    );
    expect(source).not.toContain('captureOriginalExport');
    expect(source).not.toContain('readBlobText');
    expect(source).not.toContain('saveAs');
    expect(source).not.toContain('injectKmlProvenance');
  });
});
