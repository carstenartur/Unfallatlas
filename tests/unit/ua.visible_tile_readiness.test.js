'use strict';

const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../js/ua.visible_tile_readiness.js'),
  'utf8',
);

function rect(left, top, width, height) {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function createRuntime({ images = [], styles = new Map(), original } = {}) {
  const root = { parentElement: null };
  const mapContainer = {
    parentElement: root,
    getBoundingClientRect: () => rect(0, 0, 512, 512),
  };
  const document = {
    documentElement: root,
    querySelector(selector) {
      return selector === '.leaflet-container' ? mapContainer : null;
    },
    querySelectorAll(selector) {
      if (selector === '.leaflet-map-pane img.leaflet-tile') return images;
      if (selector === '.leaflet-tile-pane img') return [];
      return [];
    },
  };
  const initial = original === undefined ? jest.fn(async () => false) : original;
  const mockWindow = {
    document,
    requestAnimationFrame: callback => setTimeout(callback, 0),
    getComputedStyle: element => styles.get(element) || {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
    },
    UA: { waitForMapFullyRendered: initial },
  };
  (function evaluate(window) { eval(source); })(mockWindow);
  return mockWindow;
}

function tile({ complete = true, left = 0, top = 0, parentElement = null } = {}) {
  return {
    complete,
    naturalWidth: complete ? 256 : 0,
    naturalHeight: complete ? 256 : 0,
    className: complete ? 'leaflet-tile leaflet-tile-loaded' : 'leaflet-tile leaflet-tile-loading',
    parentElement,
    getBoundingClientRect: () => rect(left, top, 256, 256),
  };
}

describe('UA.visibleTileReadiness', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  test('resolves from visible decoded pixels even while legacy Leaflet bookkeeping stays pending', async () => {
    const visible = tile();
    const original = jest.fn(() => new Promise(() => {}));
    const { UA } = createRuntime({ images: [visible], original });

    await expect(UA.waitForMapFullyRendered({}, {
      minTileImages: 1,
      timeoutMs: 50,
      tileStableMs: 0,
    })).resolves.toBe(true);
    expect(original).toHaveBeenCalledTimes(1);
  });

  test('wraps a map readiness function assigned after the adapter was loaded', async () => {
    const lateOriginal = jest.fn(() => new Promise(() => {}));
    const { UA } = createRuntime({ images: [tile()], original: null });

    UA.waitForMapFullyRendered = lateOriginal;
    await expect(UA.waitForMapFullyRendered({}, {
      minTileImages: 1,
      timeoutMs: 50,
      tileStableMs: 0,
    })).resolves.toBe(true);
    expect(lateOriginal).toHaveBeenCalledTimes(1);
  });

  test('ignores hidden and off-map retired tiles but keeps the visible tile strict', () => {
    const root = { parentElement: null };
    const visibleParent = { parentElement: root };
    const hiddenParent = { parentElement: root };
    const visible = tile({ parentElement: visibleParent });
    const hiddenIncomplete = tile({ complete: false, parentElement: hiddenParent });
    const offMapIncomplete = tile({ complete: false, left: 900, top: 900, parentElement: visibleParent });
    const styles = new Map([[hiddenParent, {
      display: 'block', visibility: 'visible', opacity: '0',
    }]]);
    const { UA } = createRuntime({
      images: [visible, hiddenIncomplete, offMapIncomplete],
      styles,
    });

    expect(UA.visibleTileReadiness.visibleDecodedTiles(1)).toBe(true);
    visible.complete = false;
    visible.naturalWidth = 0;
    visible.naturalHeight = 0;
    visible.className = 'leaflet-tile leaflet-tile-loading';
    expect(UA.visibleTileReadiness.visibleDecodedTiles(1)).toBe(false);
  });

  test('preserves the legacy contract when no DOM tile proof is requested', async () => {
    const original = jest.fn(async () => false);
    const { UA } = createRuntime({ images: [tile()], original });

    await expect(UA.waitForMapFullyRendered({}, { minTileImages: 0 })).resolves.toBe(false);
    expect(original).toHaveBeenCalledTimes(1);
  });

  test('does not let an early legacy false suppress a later visible proof', async () => {
    const visible = tile({ complete: false });
    const original = jest.fn(async () => false);
    const { UA } = createRuntime({ images: [visible], original });
    const readiness = UA.waitForMapFullyRendered({}, {
      minTileImages: 1,
      timeoutMs: 100,
      tileStableMs: 0,
    });

    visible.complete = true;
    visible.naturalWidth = 256;
    visible.naturalHeight = 256;
    visible.className = 'leaflet-tile leaflet-tile-loaded';
    await jest.advanceTimersByTimeAsync(1);

    await expect(readiness).resolves.toBe(true);
  });
});
