'use strict';

const {
  classifyProviderUrl,
  parseArgs,
  validateCartographyRecord
} = require('../../scripts/validate-live-cartography-evidence.cjs');

const URLS = Object.freeze({
  standard: 'https://a.tile.openstreetmap.org/15/17030/10954.png',
  orthophoto: 'https://www.wms.nrw.de/geobasis/wms_nw_dop?REQUEST=GetMap',
  labels: 'https://a.basemaps.cartocdn.com/light_only_labels/15/17030/10954.png'
});

function readyTile(kind, index) {
  return {
    kind,
    url: URLS[kind],
    ready: true,
    visible: true,
    intersectsMap: true,
    decoded: true,
    successful: true,
    loading: false,
    error: false,
    naturalWidth: 256,
    naturalHeight: 256,
    rectWidth: 256,
    rectHeight: 256,
    left: index * 256,
    top: 0,
    right: (index + 1) * 256,
    bottom: 256,
    layerKey: `layer-${index}`
  };
}

function validRecord(requiredKinds = ['standard']) {
  const visibleTiles = requiredKinds.map(readyTile);
  return {
    source: 'live',
    valid: true,
    error: null,
    requiredKinds: requiredKinds.slice(),
    requiredStableSamples: 3,
    stableSamples: 3,
    captureAttempts: 1,
    visibleTiles,
    observedTiles: visibleTiles.map(tile => ({ ...tile })),
    invalidTiles: [],
    coverageByKind: Object.fromEntries(requiredKinds.map(kind => [kind, {
      kind,
      complete: true,
      readyTiles: 1,
      invalidTiles: 0,
      samplePoints: 800,
      uncoveredCount: 0,
      uncovered: []
    }])),
    animationState: { active: false, zoom: false, pan: false, drag: false },
    mapRect: { left: 0, top: 0, right: 1280, bottom: 640, width: 1280, height: 640 },
    tileSignature: JSON.stringify({
      mapWidth: 1280,
      mapHeight: 640,
      tiles: visibleTiles.map(tile => ({
        kind: tile.kind,
        url: tile.url,
        layerKey: tile.layerKey,
        left: tile.left,
        top: tile.top,
        width: tile.rectWidth,
        height: tile.rectHeight
      }))
    }),
    successfulResponses: requiredKinds.map(kind => ({
      kind,
      status: 200,
      contentType: 'image/png',
      url: URLS[kind]
    }))
  };
}

function changed(mutator, requiredKinds = ['standard']) {
  const record = validRecord(requiredKinds);
  mutator(record);
  return record;
}

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

  test('accepts complete stable viewport coverage with matching successful raster responses', () => {
    expect(validateCartographyRecord(
      validRecord(['orthophoto', 'labels']),
      'docs/screenshots/23-mapmode-hybrid.png'
    )).toEqual([]);
  });

  test.each([
    [
      changed(record => { record.source = 'fixture'; }),
      'cartography source is not live'
    ],
    [
      changed(record => { record.valid = false; record.error = 'capture failed'; }),
      'cartography capture is not marked valid'
    ],
    [
      changed(record => { record.requiredStableSamples = 2; }),
      'requires fewer than 3 stable tile samples'
    ],
    [
      changed(record => { record.stableSamples = 2; }),
      'tile signature was not stable for the required samples'
    ],
    [
      changed(record => { record.captureAttempts = 4; }),
      'captureAttempts is outside the bounded retry contract'
    ],
    [
      changed(record => {
        record.invalidTiles.push({ kind: 'standard', url: URLS.standard });
      }),
      'contains invalid visible Leaflet tiles'
    ],
    [
      changed(record => {
        record.animationState = { active: true, zoom: true, pan: false, drag: false };
      }),
      'captured during a Leaflet animation'
    ],
    [
      changed(record => {
        record.coverageByKind.standard.complete = false;
        record.coverageByKind.standard.uncoveredCount = 1;
        record.coverageByKind.standard.uncovered = [{ x: 640, y: 320 }];
      }),
      'do not completely cover the visible map viewport'
    ],
    [
      changed(record => { record.visibleTiles[0].ready = false; }),
      'is not a decoded successful ready tile'
    ],
    [
      changed(record => { record.successfulResponses[0].contentType = 'image/svg+xml'; }),
      'not an allowed successful raster provider response'
    ],
    [
      changed(record => { record.successfulResponses = []; }),
      'no visible successful real standard tile is recorded'
    ],
    [
      changed(record => {
        record.visibleTiles = [];
        record.tileSignature = JSON.stringify({ mapWidth: 1280, mapHeight: 640, tiles: [] });
      }),
      'no visible successful real standard tile is recorded'
    ],
    [
      changed(record => { record.tileSignature = '{broken'; }),
      'tileSignature is not valid JSON'
    ],
    [
      changed(record => {
        const parsed = JSON.parse(record.tileSignature);
        parsed.tiles.push({
          kind: 'standard',
          url: URLS.standard,
          layerKey: 'layer-extra',
          left: 256,
          top: 0,
          width: 256,
          height: 256
        });
        record.tileSignature = JSON.stringify(parsed);
      }),
      'but 1 visible ready tiles are recorded'
    ]
  ])('rejects incomplete, moving, unstable or counterfeit cartography', (record, expected) => {
    expect(validateCartographyRecord(record, 'docs/screenshots/01-startansicht.png').join('\n'))
      .toContain(expected);
  });

  test('parses the optional report path fail-closed', () => {
    expect(parseArgs(['--report', 'out/qa/live-cartography.json'])).toEqual({
      report: 'out/qa/live-cartography.json'
    });
    expect(() => parseArgs(['--unknown'])).toThrow('Unknown argument');
  });
});
