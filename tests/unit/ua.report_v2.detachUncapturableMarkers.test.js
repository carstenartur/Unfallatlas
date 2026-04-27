/**
 * Regression tests for UA._detachUncapturableMarkers — the helper that fixes
 * a hard-to-spot production bug where Word/PDF export would hang forever:
 *
 *   leaflet-image@0.4.0 cannot render markers backed by L.divIcon (no
 *   marker._icon.src). It throws inside an asynchronous image.onload, never
 *   invokes its callback, and the awaited capture promise hangs — taking
 *   down the entire Word/PDF export pipeline whenever the map shows POIs
 *   (school/kindergarten markers in werkbank_v2.html).
 *
 * The unit tests stub a Leaflet-like environment because we just need to
 * exercise the icon classification + detach/restore bookkeeping.
 */

describe('UA._detachUncapturableMarkers', () => {
  let UA;
  let mockWindow;

  // Minimal Leaflet-like stand-ins. We use real classes (not plain objects)
  // so that `instanceof` checks inside the helper behave correctly.
  class FakeMarker {}
  class FakeIcon {}
  class FakeDivIcon extends FakeIcon {}

  function makeMarker(icon) {
    const m = new FakeMarker();
    m.options = { icon };
    return m;
  }

  function makeMap(layers) {
    const removed = [];
    const added = [];
    const live = [...layers];
    return {
      removed,
      added,
      eachLayer(fn) {
        // Iterate a snapshot so handlers may mutate the live list safely.
        for (const l of [...live]) fn(l);
      },
      removeLayer(l) {
        const idx = live.indexOf(l);
        if (idx >= 0) live.splice(idx, 1);
        removed.push(l);
      },
      addLayer(l) {
        live.push(l);
        added.push(l);
      }
    };
  }

  beforeEach(() => {
    mockWindow = {
      UA: {},
      L: {
        Marker: FakeMarker,
        Icon: FakeIcon,
        DivIcon: FakeDivIcon
      },
      location: { href: 'http://localhost/' }
    };
    // FakeMarker.addTo is what the restore path calls.
    FakeMarker.prototype.addTo = function addTo(map) {
      map.addLayer(this);
      return this;
    };

    const fs = require('fs');
    const path = require('path');
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function (window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);
    const reportPath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    (function (window) { eval(fs.readFileSync(reportPath, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  test('exposes the helper for testing', () => {
    expect(typeof UA._detachUncapturableMarkers).toBe('function');
  });

  test('detaches DivIcon markers and re-attaches them on restore', () => {
    const divMarker = makeMarker(new FakeDivIcon());
    const imageMarker = makeMarker(Object.assign(new FakeIcon(), {
      options: { iconUrl: 'https://example.com/marker-icon.png' }
    }));
    const map = makeMap([divMarker, imageMarker]);

    const restore = UA._detachUncapturableMarkers(map);

    // Only the DivIcon marker was removed; the imageable one stayed.
    expect(map.removed).toEqual([divMarker]);
    expect(map.added).toEqual([]);

    restore();

    // The DivIcon marker is re-added via marker.addTo(map).
    expect(map.added).toEqual([divMarker]);
  });

  test('detaches markers whose icon has no iconUrl', () => {
    // E.g. a custom L.Icon subclass that forgot to set iconUrl.
    const noUrlMarker = makeMarker(Object.assign(new FakeIcon(), { options: {} }));
    const validMarker = makeMarker(Object.assign(new FakeIcon(), {
      options: { iconUrl: '/markers/x.png' }
    }));
    const map = makeMap([noUrlMarker, validMarker]);

    const restore = UA._detachUncapturableMarkers(map);
    expect(map.removed).toEqual([noUrlMarker]);

    restore();
    expect(map.added).toEqual([noUrlMarker]);
  });

  test('ignores non-marker layers and markers without an icon', () => {
    const bareMarker = new FakeMarker();
    bareMarker.options = {}; // no icon at all
    const tileLayer = { __pretendTileLayer: true }; // not a FakeMarker
    const map = makeMap([bareMarker, tileLayer]);

    const restore = UA._detachUncapturableMarkers(map);
    expect(map.removed).toEqual([]);
    restore();
    expect(map.added).toEqual([]);
  });

  test('returns a no-op restore function when the map is missing', () => {
    expect(() => {
      const restore = UA._detachUncapturableMarkers(null);
      expect(typeof restore).toBe('function');
      restore();
    }).not.toThrow();
  });
});
