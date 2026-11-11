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
    delete window.fetch;
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

  test('rejects an expected visible tile that is absent from the rendered Leaflet state without refetching it', async () => {
    const layer = new FakeTileLayer({});
    const originalLeafletImage = jest.fn();
    const fetchImpl = jest.fn();
    window.fetch = fetchImpl;
    loadModule(originalLeafletImage);
    const map = {
      eachLayer(callback) { callback(layer); },
      getZoom() { return 3; },
      getSize() { return { x: 256, y: 256 }; },
      getPixelBounds() { return { min: { x: 0, y: 0 }, max: { x: 256, y: 256 } }; },
    };

    await expect(capture(map)).rejects.toMatchObject({
      code: 'MAP_CAPTURE_TILE_COVERAGE_INCOMPLETE',
      details: {
        coords: '0:0:3',
        url: 'https://tiles.example/3/0/0.png',
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(originalLeafletImage).not.toHaveBeenCalled();
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
describe('official aerial image for a Word document', () => {
  const bounds = { south: 52.3755287, west: 9.7264805, north: 52.3759064, east: 9.7270992 };
  const area = { CITY_RAW: 'Hannover', mapMode: 'standard' };

  function initialise() {
    loadModule(jest.fn());
    window.L = require('leaflet');
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.map_layer_registry.js'), 'utf8'));
    const picture = { decode: jest.fn().mockResolvedValue(undefined), naturalWidth: 1500, naturalHeight: 900 };
    jest.spyOn(window, 'Image').mockImplementation(() => picture);
    const pixels = new Uint8ClampedArray([23, 37, 46, 255, 92, 114, 63, 255]);
    const drawing = { drawImage: jest.fn(), getImageData: jest.fn(() => ({ data: pixels })) };
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(drawing);
    return { picture, drawing };
  }

  afterEach(() => {
    delete window.fetch;
    delete window.UA;
    delete window.L;
    delete window.leafletImage;
    jest.restoreAllMocks();
  });

  test('fetches a print-size WMS frame containing the selected place regardless of live map mode', async () => {
    initialise();
    window.fetch = jest.fn(async () => ({ ok: true, blob: async () => new Blob(['image'], { type: 'image/png' }) }));
    const capture = await window.UA.fetchDocumentOrthophoto(area, bounds);
    expect(window.fetch).toHaveBeenCalledTimes(1);
    const url = new URL(capture.url);
    expect(url.hostname).toBe('opendata.lgln.niedersachsen.de');
    expect(url.searchParams.get('LAYERS')).toBe('ni_dop20');
    expect(url.searchParams.get('SRS')).toBe('EPSG:3857');
    expect(url.searchParams.get('WIDTH')).toBe('1500');
    expect(url.searchParams.get('HEIGHT')).toBe('900');
    const [left, bottom, right, top] = url.searchParams.get('BBOX').split(',').map(Number);
    expect((right - left) / (top - bottom)).toBeCloseTo(1500 / 900, 7);
    expect(capture.bounds.south).toBeLessThan(bounds.south);
    expect(capture.bounds.west).toBeLessThan(bounds.west);
    expect(capture.bounds.north).toBeGreaterThan(bounds.north);
    expect(capture.bounds.east).toBeGreaterThan(bounds.east);
    expect(capture.provider.officialForExport).toBe(true);
    expect(capture.provider.license).toBe('CC BY 4.0');
    expect(capture.image).toMatch(/^data:image\/png;base64,/);
  });

  test('skips placeholder or malformed rasters and never requests an unofficial fallback', async () => {
    const { picture, drawing } = initialise();
    picture.decode.mockImplementationOnce(async () => { throw new Error('decode'); });
    drawing.getImageData.mockReturnValue({ data: new Uint8ClampedArray([255, 255, 255, 255, 255, 255, 255, 255]) });
    window.fetch = jest.fn(async () => ({ ok: true, blob: async () => new Blob(['bad'], { type: 'image/png' }) }));
    expect(await window.UA.fetchDocumentOrthophoto(area, bounds)).toBeNull();
    expect(window.fetch.mock.calls.map(([url]) => new URL(url).hostname))
      .toEqual(['opendata.lgln.niedersachsen.de', 'sg.geodatenzentrum.de']);
  });

  test('does not request an image when no coordinates were selected', async () => {
    initialise();
    window.fetch = jest.fn();
    expect(await window.UA.fetchDocumentOrthophoto(area, null)).toBeNull();
    expect(await window.UA.fetchDocumentOrthophoto(area, { ...bounds, west: null })).toBeNull();
    expect(window.fetch).not.toHaveBeenCalled();
  });
});
