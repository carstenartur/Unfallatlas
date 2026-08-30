/** @jest-environment jsdom */
'use strict';

const fs = require('fs');
const path = require('path');

const MODULE = path.resolve(__dirname, '../../js/ua.map_capture_tile_integrity.js');
const RED_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

class FakeTileLayer {
  constructor(tiles = {}) {
    this._tiles = tiles;
    this._tileZoom = 3;
    this.options = { minZoom: 0, maxZoom: 20, opacity: 1, tileSize: 256 };
  }

  getTileUrl(coords) {
    return `https://tiles.example/${coords.z ?? this._tileZoom}/${coords.x}/${coords.y}.png`;
  }
}

function tile(x, y, z = 3) {
  return {
    current: true,
    coords: { x, y, z },
    el: {
      tagName: 'IMG',
      complete: true,
      naturalWidth: 1,
      naturalHeight: 1,
      src: RED_TILE,
      currentSrc: '',
    },
  };
}

function mapFor(layer) {
  return {
    eachLayer(callback) { callback(layer); },
    getZoom() { return 3; },
    getSize() { return { x: 256, y: 256 }; },
  };
}

function loadModule(originalLeafletImage) {
  jest.resetModules();
  window.UA = {};
  window.L = { TileLayer: FakeTileLayer };
  window.leafletImage = originalLeafletImage;
  eval(fs.readFileSync(MODULE, 'utf8'));
  return window.UA.MapCaptureTileIntegrity;
}

function capture(map) {
  return new Promise((resolve, reject) => {
    window.leafletImage(map, (error, canvas) => error ? reject(error) : resolve(canvas));
  });
}

describe('map capture tile integrity wrapper', () => {
  afterEach(() => {
    delete window.UA;
    delete window.L;
    delete window.leafletImage;
    jest.restoreAllMocks();
  });

  test('feeds leaflet-image local data URLs instead of refetching visible raster tiles', async () => {
    const layer = new FakeTileLayer({ '1:2:3': tile(1, 2, 3) });
    const originalGetTileUrl = layer.getTileUrl;
    const originalLeafletImage = jest.fn((map, callback) => {
      expect(layer.getTileUrl({ x: 1, y: 2, z: 3 })).toBe(RED_TILE);
      callback(null, { width: 256, height: 256 });
    });
    loadModule(originalLeafletImage);

    await expect(capture(mapFor(layer))).resolves.toMatchObject({ width: 256, height: 256 });
    expect(originalLeafletImage).toHaveBeenCalledTimes(1);
    expect(layer.getTileUrl).toBe(originalGetTileUrl);
  });

  test('fails closed when leaflet-image asks for a tile absent from the rendered map', async () => {
    const layer = new FakeTileLayer({ '1:2:3': tile(1, 2, 3) });
    const originalGetTileUrl = layer.getTileUrl;
    loadModule((map, callback) => {
      expect(layer.getTileUrl({ x: 9, y: 9, z: 3 })).toMatch(/^data:image\/png/);
      callback(null, { width: 256, height: 256 });
    });

    await expect(capture(mapFor(layer))).rejects.toMatchObject({
      code: 'MAP_CAPTURE_TILE_COVERAGE_INCOMPLETE',
      message: expect.stringMatching(/Dokumentexport wurde abgebrochen/i),
    });
    expect(layer.getTileUrl).toBe(originalGetTileUrl);
  });

  test('fails before capture when an active raster layer has no tile range', async () => {
    const layer = new FakeTileLayer({});
    const originalLeafletImage = jest.fn();
    loadModule(originalLeafletImage);

    await expect(capture(mapFor(layer))).rejects.toMatchObject({
      code: 'MAP_CAPTURE_TILE_SET_EMPTY',
    });
    expect(originalLeafletImage).not.toHaveBeenCalled();
  });

  test('restores getTileUrl when the underlying leaflet-image call fails', async () => {
    const layer = new FakeTileLayer({ '1:2:3': tile(1, 2, 3) });
    const originalGetTileUrl = layer.getTileUrl;
    const captureFailure = new Error('capture failed');
    loadModule((map, callback) => callback(captureFailure));

    await expect(capture(mapFor(layer))).rejects.toBe(captureFailure);
    expect(layer.getTileUrl).toBe(originalGetTileUrl);
  });

  test('ignores leaflet-image boundary tiles that have no overlap with the canvas', async () => {
    const layer = new FakeTileLayer({ '0:0:0': tile(0, 0, 0) });
    layer._tileZoom = 0;
    const map = {
      eachLayer(callback) { callback(layer); },
      getZoom() { return 0; },
      getSize() { return { x: 256, y: 256 }; },
      getPixelBounds() { return { min: { x: 0, y: 0 }, max: { x: 256, y: 256 } }; },
    };
    loadModule((m, callback) => {
      // leaflet-image includes x=1/y=1 at an exact boundary, but drawing it
      // starts outside the 256×256 output and must not make a sound export fail.
      expect(layer.getTileUrl({ x: 1, y: 1, z: 0 })).toMatch(/^data:image\/png/);
      callback(null, { width: 256, height: 256 });
    });

    await expect(capture(map)).resolves.toMatchObject({ width: 256, height: 256 });
  });

  test('bootstrap loads the integrity module exactly once', () => {
    const bootstrap = fs.readFileSync(path.resolve(__dirname, '../../js/ua.bootstrap.js'), 'utf8');
    const matches = bootstrap.match(/ua\.map_capture_tile_integrity\.js/g) || [];
    expect(matches).toHaveLength(1);
  });
});
