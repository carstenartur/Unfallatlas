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

  test('accepts visible tiles with matching successful raster responses', () => {
    const orthophotoUrl = 'https://www.wms.nrw.de/geobasis/wms_nw_dop?REQUEST=GetMap';
    const labelsUrl = 'https://a.basemaps.cartocdn.com/light_only_labels/15/17030/10954.png';
    expect(validateCartographyRecord({
      source: 'live',
      requiredKinds: ['orthophoto', 'labels'],
      visibleTiles: [
        { kind: 'orthophoto', url: orthophotoUrl },
        { kind: 'labels', url: labelsUrl }
      ],
      successfulResponses: [
        {
          kind: 'orthophoto',
          status: 200,
          contentType: 'image/png',
          url: orthophotoUrl
        },
        {
          kind: 'labels',
          status: 200,
          contentType: 'image/png; charset=binary',
          url: labelsUrl
        }
      ]
    }, 'docs/screenshots/23-mapmode-hybrid.png')).toEqual([]);
  });

  test.each([
    [
      { source: 'fixture', requiredKinds: ['standard'], visibleTiles: [], successfulResponses: [] },
      'cartography source is not live'
    ],
    [
      {
        source: 'live',
        requiredKinds: ['standard'],
        visibleTiles: [{
          kind: 'standard', url: 'https://a.tile.openstreetmap.org/15/17030/10954.png'
        }],
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
        visibleTiles: [{
          kind: 'standard', url: 'http://a.tile.openstreetmap.org/15/17030/10954.png'
        }],
        successfulResponses: [{
          kind: 'standard', status: 200, contentType: 'image/png',
          url: 'http://a.tile.openstreetmap.org/15/17030/10954.png'
        }]
      },
      'no visible successful real standard tile is recorded'
    ],
    [
      {
        source: 'live',
        requiredKinds: ['standard'],
        visibleTiles: [{
          kind: 'standard', url: 'https://a.tile.openstreetmap.org/15/17030/10954.png'
        }],
        successfulResponses: []
      },
      'no visible successful real standard tile is recorded'
    ],
    [
      {
        source: 'live',
        requiredKinds: ['standard'],
        visibleTiles: [],
        successfulResponses: [{
          kind: 'standard', status: 200, contentType: 'image/png',
          url: 'https://a.tile.openstreetmap.org/15/17030/10954.png'
        }]
      },
      'no visible successful real standard tile is recorded'
    ],
    [
      {
        source: 'live',
        requiredKinds: ['standard'],
        visibleTiles: [{
          kind: 'standard', url: 'https://example.invalid/fake.png'
        }],
        successfulResponses: [{
          kind: 'standard', status: 200, contentType: 'image/png',
          url: 'https://example.invalid/fake.png'
        }]
      },
      'no visible successful real standard tile is recorded'
    ]
  ])('rejects non-live, invisible or counterfeit cartography', (record, expected) => {
    expect(validateCartographyRecord(record, 'docs/screenshots/01-startansicht.png').join('\n')).toContain(expected);
  });

  test('parses the optional report path fail-closed', () => {
    expect(parseArgs(['--report', 'out/qa/live-cartography.json'])).toEqual({
      report: 'out/qa/live-cartography.json'
    });
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
  });
});
