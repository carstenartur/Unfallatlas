'use strict';

const fs = require('fs');
const path = require('path');

function loadAdapter(extraWin) {
  const win = Object.assign({ UA: {}, location: { href: 'http://localhost/' } }, extraWin || {});
  (function (window) {
    eval(fs.readFileSync(
      path.resolve(__dirname, '../../js/ua.leaflet_map_adapter.js'), 'utf8'
    ));
  })(win);
  return win.UA;
}

function makeMap() {
  const added = [];
  const removed = [];
  return {
    added,
    removed,
    addLayer: jest.fn(),
    removeLayer: jest.fn()
  };
}

function makeLayer(name) {
  const layer = {
    _name: name,
    _map: null,
    addTo: jest.fn(function (map) { layer._map = map; return layer; }),
    remove: jest.fn(function () { layer._map = null; }),
    bringToFront: jest.fn()
  };
  return layer;
}

describe('UA.LeafletMapAdapter', () => {
  let UA;
  beforeEach(() => { UA = loadAdapter(); });

  test('create() returns an adapter object', () => {
    const adapter = UA.LeafletMapAdapter.create(makeMap());
    expect(typeof adapter.replaceLayer).toBe('function');
    expect(typeof adapter.removeLayer).toBe('function');
    expect(typeof adapter.bringLayerToFront).toBe('function');
    expect(typeof adapter.setView).toBe('function');
    expect(typeof adapter.fitBounds).toBe('function');
    expect(typeof adapter.waitUntilStable).toBe('function');
  });

  describe('replaceLayer', () => {
    test('removes current and adds next', () => {
      const map = makeMap();
      const adapter = UA.LeafletMapAdapter.create(map);
      const current = makeLayer('current');
      const next = makeLayer('next');
      const result = adapter.replaceLayer(current, next);
      expect(current.remove).toHaveBeenCalledTimes(1);
      expect(next.addTo).toHaveBeenCalledWith(map);
      expect(result).toBe(next);
    });

    test('handles null current gracefully', () => {
      const map = makeMap();
      const adapter = UA.LeafletMapAdapter.create(map);
      const next = makeLayer('next');
      expect(() => adapter.replaceLayer(null, next)).not.toThrow();
      expect(next.addTo).toHaveBeenCalledWith(map);
    });

    test('handles null next — returns null', () => {
      const map = makeMap();
      const adapter = UA.LeafletMapAdapter.create(map);
      const current = makeLayer('current');
      const result = adapter.replaceLayer(current, null);
      expect(current.remove).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    test('handles both null gracefully', () => {
      const adapter = UA.LeafletMapAdapter.create(makeMap());
      expect(() => adapter.replaceLayer(null, null)).not.toThrow();
    });
  });

  describe('removeLayer', () => {
    test('calls remove() and returns null', () => {
      const adapter = UA.LeafletMapAdapter.create(makeMap());
      const layer = makeLayer('l');
      const result = adapter.removeLayer(layer);
      expect(layer.remove).toHaveBeenCalledTimes(1);
      expect(result).toBeNull();
    });

    test('handles null layer gracefully', () => {
      const adapter = UA.LeafletMapAdapter.create(makeMap());
      expect(() => adapter.removeLayer(null)).not.toThrow();
    });
  });

  describe('bringLayerToFront', () => {
    test('calls bringToFront() when available', () => {
      const adapter = UA.LeafletMapAdapter.create(makeMap());
      const layer = makeLayer('l');
      adapter.bringLayerToFront(layer);
      expect(layer.bringToFront).toHaveBeenCalledTimes(1);
    });

    test('does nothing when layer has no bringToFront', () => {
      const adapter = UA.LeafletMapAdapter.create(makeMap());
      expect(() => adapter.bringLayerToFront({ _name: 'no-bringToFront' })).not.toThrow();
    });

    test('handles null layer gracefully', () => {
      const adapter = UA.LeafletMapAdapter.create(makeMap());
      expect(() => adapter.bringLayerToFront(null)).not.toThrow();
    });
  });

  describe('setView', () => {
    test('calls map.setView with [lat, lon] and zoom', () => {
      const map = { setView: jest.fn() };
      const adapter = UA.LeafletMapAdapter.create(map);
      adapter.setView({ lat: 52.37, lon: 9.73 }, 12);
      expect(map.setView).toHaveBeenCalledWith([52.37, 9.73], 12);
    });

    test('accepts lng as alias for lon', () => {
      const map = { setView: jest.fn() };
      const adapter = UA.LeafletMapAdapter.create(map);
      adapter.setView({ lat: 52.37, lng: 9.73 }, 12);
      expect(map.setView).toHaveBeenCalledWith([52.37, 9.73], 12);
    });

    test('does nothing for null center', () => {
      const map = { setView: jest.fn() };
      const adapter = UA.LeafletMapAdapter.create(map);
      expect(() => adapter.setView(null, 12)).not.toThrow();
      expect(map.setView).not.toHaveBeenCalled();
    });

    test('does nothing for non-finite coordinates', () => {
      const map = { setView: jest.fn() };
      const adapter = UA.LeafletMapAdapter.create(map);
      adapter.setView({ lat: NaN, lon: 9 }, 12);
      expect(map.setView).not.toHaveBeenCalled();
    });
  });

  describe('waitUntilStable', () => {
    test('returns a Promise resolving to true when UA.waitForMapFullyRendered is unavailable', async () => {
      const adapter = UA.LeafletMapAdapter.create(makeMap());
      const result = await adapter.waitUntilStable();
      expect(result).toBe(true);
    });

    test('delegates to UA.waitForMapFullyRendered when available', async () => {
      const UA2 = loadAdapter();
      UA2.waitForMapFullyRendered = jest.fn(() => Promise.resolve('stable'));
      const map = makeMap();
      const adapter = UA2.LeafletMapAdapter.create(map);
      const result = await adapter.waitUntilStable({ timeoutMs: 5000 });
      expect(UA2.waitForMapFullyRendered).toHaveBeenCalledWith(map, { timeoutMs: 5000 });
      expect(result).toBe('stable');
    });
  });
});
