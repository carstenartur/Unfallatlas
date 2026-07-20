'use strict';

const FIXTURE_CITY = 'Bonn';

const VIDEO_EXPORT_CONTEXT_PARAMS = Object.freeze({
  city: FIXTURE_CITY,
  ctxSlope: 'steep,very_steep',
  ctxTraffic: 'high,very_high',
  ctxOnlyMatched: '1',
  mapLayer: 'slope,traffic',
  centerLat: '50.731500',
  centerLon: '7.102500',
  zoom: '15',
});

function createVideoExportContextFixture() {
  const ways = [
    {
      id: 'W1', slopeClass: 'steep', slopePercent: 8.0,
      trafficClass: 'high', trafficVolume: 12000,
      geometry: [50.7285, 7.0985, 50.7300, 7.1000, 50.7315, 7.1015],
      highway: 0,
    },
    {
      id: 'W2', slopeClass: 'very_steep', slopePercent: 12.5,
      trafficClass: 'very_high', trafficVolume: 22000,
      geometry: [50.7300, 7.1045, 50.7315, 7.1030, 50.7330, 7.1015],
      highway: 1,
    },
    {
      id: 'W3', slopeClass: 'steep', slopePercent: 7.2,
      trafficClass: 'very_high', trafficVolume: 18000,
      geometry: [50.7290, 7.1050, 50.7310, 7.1050, 50.7330, 7.1050],
      highway: 1,
    },
    {
      id: 'W4', slopeClass: 'very_steep', slopePercent: 11.0,
      trafficClass: 'high', trafficVolume: 9000,
      geometry: [50.7330, 7.0990, 50.7310, 7.0990, 50.7290, 7.0990],
      highway: 0,
    },
  ];
  const pointCoordinates = [
    [7.1000, 50.7300, 'W1'], [7.1006, 50.7306, 'W1'], [7.1012, 50.7312, 'W1'],
    [7.1039, 50.7306, 'W2'], [7.1030, 50.7315, 'W2'], [7.1021, 50.7324, 'W2'],
    [7.1050, 50.7296, 'W3'], [7.1050, 50.7310, 'W3'], [7.1050, 50.7324, 'W3'],
    [7.0990, 50.7296, 'W4'], [7.0990, 50.7310, 'W4'], [7.0990, 50.7324, 'W4'],
  ];
  const wayById = new Map(ways.map(way => [way.id, way]));
  const common = {
    uart: '1', utyp1: '1', ulichtverh: '0', ustrzustand: '0',
    uwochentag: '2', umonat: '6', ujahr: '2024',
    istrad: '1', istpkw: '1', istfuss: '0', istkrad: '0',
    istgkfz: '0', istsonstig: '0',
  };
  const features = pointCoordinates.map(([lon, lat, wayId], index) => {
    const way = wayById.get(wayId);
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        id: `bonn-video-e2e-${index + 1}`,
        ...common,
        ukategorie: String(index % 3 === 0 ? 2 : 3),
        ustunde: String(7 + (index % 11)),
        matched_way_id: way.id,
        road_context_source: 'deterministic-integration-fixture',
        elevation_m: 100 + index,
        slope_percent: way.slopePercent,
        slope_abs_percent: Math.abs(way.slopePercent),
        slope_class: way.slopeClass,
        slope_source: 'deterministic-integration-fixture',
        slope_confidence: 'high',
        traffic_proxy_class: way.trafficClass,
      },
    };
  });

  return {
    geojson: {
      type: 'FeatureCollection',
      properties: {
        fixture: 'video-export-context-v1',
        enrichmentDicts: {
          highway: ['residential', 'primary'],
          surface: ['asphalt'],
          cycleway: ['lane'],
        },
      },
      features,
    },
    ways: {
      schemaVersion: 2,
      ways: Object.fromEntries(ways.map(way => [way.id, {
        highway: way.highway,
        maxspeed: way.highway === 1 ? 50 : 30,
        lanes: way.highway === 1 ? 4 : 2,
        surface: 0,
        cycleway: 0,
        road_slope_percent: way.slopePercent,
        road_slope_class: way.slopeClass,
        road_slope_method: 'deterministic_fixture',
        road_slope_sample_count: 8,
        road_slope_confidence: 'high',
        traffic_volume_value: way.trafficVolume,
        traffic_volume_unit: 'DTV',
        traffic_volume_year: 2026,
        traffic_volume_source: 'deterministic-integration-fixture',
        traffic_volume_confidence: 'high',
      }])),
      geometries: Object.fromEntries(ways.map(way => [way.id, way.geometry])),
    },
    meta: {
      schemaVersion: 2,
      enrichmentScriptVersion: 'video-export-context-v1',
      citySlug: 'bonn',
      generatedAt: '2026-07-19T00:00:00.000Z',
      sources: {
        osm: { source: 'deterministic-integration-fixture', producerVersion: '1.0.0', coverage: 'fixture' },
        dem: { source: 'deterministic-integration-fixture', producerVersion: '1.0.0', resolutionM: 1 },
        traffic: { source: 'deterministic-integration-fixture', producerVersion: '1.0.0', datasetVersion: '1.0.0' },
      },
      slope: { withSlope: features.length },
      counts: {
        features: features.length,
        matchedToWay: features.length,
        withElevation: features.length,
        withTrafficProxy: features.length,
        ways: ways.length,
        wayGeometries: ways.length,
        fullWays: ways.length,
      },
    },
  };
}

module.exports = {
  FIXTURE_CITY,
  VIDEO_EXPORT_CONTEXT_PARAMS,
  createVideoExportContextFixture,
};
