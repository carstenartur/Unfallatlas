'use strict';

const {
  classifyProviderUrl,
  parseArgs,
  validateCartographyRecord
} = require('../../scripts/validate-live-cartography-evidence.cjs');

describe('live cartography evidence validator', () => {
  test.each([
    ['https://a.tile.openstreetmap.org/15/17030/10954.png', 'standard'],
    ['https://b.basemaps.cartocdn.com/light_only_labels/15/17030/10954.png', 'labels'],
    ['https://b.basemaps.cartocdn.com/light_only_labels/15/17030/10954@2x.png', 'labels'],
    ['https://www.bonn.de/stadtplan-wms/services/orthofoto/MapServer/WMSServer?REQUEST=GetMap', 'orthophoto'],
    ['https://www.wms.nrw.de/geobasis/wms_nw_dop?REQUEST=GetMap', 'orthophoto'],
    ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/15/10954/17030', 'orthophoto']
  ])('classifies an allowed provider URL', (url, kind) => {
    expect(classifyProviderUrl(url)).toBe(kind);
  });

  test.each([
    'http://a.tile.openstreetmap.org/15/17030/10954.png',
    'https://a.tile.openstreetmap.org/',
    'https://a.tile.openstreetmap.org/unexpected',
    'https://a.tile.openstreetmap.org/15/17030/10954.svg',
    'https://a.basemaps.cartocdn.com/light_only_labels/unexpected.png',
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/not/a/tile'
  ])('rejects non-HTTPS or unexpected provider paths', url => {
    expect(classifyProviderUrl(url)).toBeNull();
  });

  test('accepts complete live raster evidence', () => {
    expect(validateCartographyRecord({
      source: 'live',
      requiredKinds: ['orthophoto', 'labels'],
      successfulResponses: [
        {
          kind: 'orthophoto',
          status: 200,
          contentType: 'image/png',
          url: 'https://www.wms.nrw.de/geobasis/wms_nw_dop?REQUEST=GetMap'
        },
        {
          kind: 'labels',
          status: 200,
          contentType: 'image/png; charset=binary',
          url: 'https://a.basemaps.cartocdn.com/light_only_labels/15/17030/10954.png'
        }
      ]
    }, 'docs/screenshots/23-mapmode-hybrid.png')).toEqual([]);
  });

  test.each([
    [
      { source: 'fixture', requiredKinds: ['standard'], successfulResponses: [] },
      'cartography source is not live'
    ],
    [
      {
        source: 'live',
        requiredKinds: ['standard'],
        successfulResponses: [{
          kind: 'standard', status: 200, contentType: 'image/svg+xml',
          url: 'https://a.tile.openstreetmap.org/15/17030/10954.png'
        }]
      },
      'not an allowed successful raster provider response'
    ],
    [
      {
        source: 'live',
        requiredKinds: ['standard'],
        successfulResponses: [{
          kind: 'standard', status: 200, contentType: 'image/png',
          url: 'http://a.tile.openstreetmap.org/15/17030/10954.png'
        }]
      },
      'no successful real standard response is recorded'
    ],
    [
      {
        source: 'live',
        requiredKinds: ['standard'],
        successfulResponses: [{
          kind: 'standard', status: 200, contentType: 'image/png',
          url: 'https://example.invalid/fake.png'
        }]
      },
      'no successful real standard response is recorded'
    ]
  ])('rejects non-live or counterfeit cartography', (record, expected) => {
    expect(validateCartographyRecord(record, 'docs/screenshots/01-startansicht.png').join('\n')).toContain(expected);
  });

  test('parses the optional report path fail-closed', () => {
    expect(parseArgs(['--report', 'out/qa/live-cartography.json'])).toEqual({
      report: 'out/qa/live-cartography.json'
    });
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
  });
});
