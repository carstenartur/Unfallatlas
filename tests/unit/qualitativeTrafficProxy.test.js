'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const {
  applyQualitativeTrafficProxy,
  normalizeProxyRow,
} = require('../../scripts/apply-qualitative-traffic-proxy');

function writeGzipJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9, mtime: 0 }));
}

function readGzipJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
}

describe('qualitative traffic proxy final-artifact adapter', () => {
  test('removes all numeric traffic fields from a way row', () => {
    const row = {
      traffic_volume_value: 18000,
      traffic_volume_unit: 'DTV',
      traffic_volume_year: 2026,
    };
    expect(normalizeProxyRow(row, {
      proxyClass: 'high',
      highwayClass: 'primary',
      confidence: 'low',
    })).toBe(true);
    expect(row).toEqual({
      traffic_measurement_type: 'proxy',
      traffic_proxy_class: 'high',
      traffic_volume_source: 'OSM-highway-class-proxy',
      traffic_volume_confidence: 'low',
      traffic_proxy_basis: 'highway=primary',
    });
  });

  test('updates GeoJSON, matched-way payload, full-network tiles and provenance', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-qualitative-traffic-'));
    try {
      writeGzipJson(path.join(root, '.enrichment-cache/traffic/traffic_bonn.json.gz'), {
        schemaVersion: 2,
        measurementType: 'proxy',
        source: 'OSM-highway-class-proxy',
        producerVersion: '2.0.0',
        datasetVersion: '2.0.0',
        extractDate: '2026-07-28',
        provenance: { sourceId: 'traffic.proxy.osm-highway-class' },
        ways: {
          '100': {
            measurementType: 'proxy',
            proxyClass: 'high',
            highwayClass: 'primary',
            confidence: 'low',
          },
        },
      });
      writeGzipJson(path.join(root, 'out/output_all_years_bonn.geojson.gz'), {
        type: 'FeatureCollection',
        features: [{
          type: 'Feature',
          geometry: null,
          properties: {
            matched_way_id: '100',
            traffic_volume_value: 18000,
            traffic_volume_unit: 'DTV',
          },
        }],
      });
      writeGzipJson(path.join(root, 'out/ways_bonn.json.gz'), {
        schemaVersion: 2,
        ways: {
          '100': {
            highway: 'primary',
            traffic_volume_value: 18000,
            traffic_volume_unit: 'DTV',
            traffic_volume_year: 2026,
          },
        },
      });
      writeGzipJson(path.join(root, 'out/ctxtiles/bonn/index.json.gz'), {
        schemaVersion: 3,
        tiles: [{ x: 1, y: 2 }],
        wayIndex: { '100': [1, 2] },
        dicts: {},
      });
      writeGzipJson(path.join(root, 'out/ctxtiles/bonn/1/2.json.gz'), {
        ways: {
          '100': {
            highway: 'primary',
            traffic_volume_value: 18000,
            traffic_volume_unit: 'DTV',
          },
        },
        geometries: { '100': [50.7, 7.0, 50.71, 7.01] },
      });
      writeGzipJson(path.join(root, 'out/output_all_years_bonn.enrichment.meta.json.gz'), {
        schemaVersion: 3,
        sources: { traffic: { source: 'legacy numeric proxy' } },
        counts: { withTrafficProxy: 1 },
      });

      const result = applyQualitativeTrafficProxy({ root, city: 'Bonn' });
      expect(result).toEqual(expect.objectContaining({
        slug: 'bonn',
        featureRows: 1,
        providerWays: 1,
      }));

      const feature = readGzipJson(path.join(root, 'out/output_all_years_bonn.geojson.gz'))
        .features[0].properties;
      expect(feature.traffic_proxy_class).toBe('high');
      expect(feature.traffic_measurement_type).toBe('proxy');
      expect(feature).not.toHaveProperty('traffic_volume_value');
      expect(feature).not.toHaveProperty('traffic_volume_unit');

      for (const file of [
        path.join(root, 'out/ways_bonn.json.gz'),
        path.join(root, 'out/ctxtiles/bonn/1/2.json.gz'),
      ]) {
        const row = readGzipJson(file).ways['100'];
        expect(row.traffic_proxy_class).toBe('high');
        expect(row.traffic_measurement_type).toBe('proxy');
        expect(row.traffic_proxy_basis).toBe('highway=primary');
        expect(row).not.toHaveProperty('traffic_volume_value');
        expect(row).not.toHaveProperty('traffic_volume_unit');
        expect(row).not.toHaveProperty('traffic_volume_year');
      }

      const meta = readGzipJson(path.join(root, 'out/output_all_years_bonn.enrichment.meta.json.gz'));
      expect(meta.sources.traffic).toEqual(expect.objectContaining({
        measurementType: 'proxy',
        semantics: 'qualitative-osm-highway-class-no-numeric-volume',
      }));
      expect(meta.traffic).toEqual(expect.objectContaining({
        measurementType: 'proxy',
        numericValuesPresent: false,
      }));
      expect(JSON.stringify(meta)).not.toContain('legacy numeric proxy');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test.each([
    ['value', 18000],
    ['unit', 'vehicles/day'],
    ['year', 2026],
  ])('fails closed when a proxy provider contains forbidden field %s', (field, value) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ua-invalid-traffic-'));
    try {
      writeGzipJson(path.join(root, '.enrichment-cache/traffic/traffic_bonn.json.gz'), {
        measurementType: 'proxy',
        ways: {
          '100': {
            measurementType: 'proxy',
            proxyClass: 'high',
            highwayClass: 'primary',
            [field]: value,
          },
        },
      });
      expect(() => applyQualitativeTrafficProxy({ root, city: 'Bonn' }))
        .toThrow(new RegExp(`forbidden field ${field}$`));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
