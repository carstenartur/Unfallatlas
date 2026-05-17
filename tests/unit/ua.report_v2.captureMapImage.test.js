/**
 * Integration tests for UA.captureMapImage — exercises the timeout safety net
 * and the detach/restore-markers integration that prevent the Word/PDF
 * export pipeline from hanging on POI markers (see PR description).
 *
 * We stub leafletImage and a Leaflet-like map so we can drive the helper
 * deterministically with Jest fake timers.
 */

describe('UA.captureMapImage', () => {
  let UA;
  let mockWindow;

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
      live,
      eachLayer(fn) { for (const l of [...live]) fn(l); },
      removeLayer(l) {
        const idx = live.indexOf(l);
        if (idx >= 0) live.splice(idx, 1);
        removed.push(l);
      },
      addLayer(l) { live.push(l); added.push(l); }
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();

    mockWindow = {
      UA: {},
      L: { Marker: FakeMarker, Icon: FakeIcon, DivIcon: FakeDivIcon },
      location: { href: 'http://localhost/' }
    };
    FakeMarker.prototype.addTo = function (map) { map.addLayer(this); return this; };

    const fs = require('fs');
    const path = require('path');
    const utilsPath = path.resolve(__dirname, '../../js/ua.utils.js');
    (function (window) { eval(fs.readFileSync(utilsPath, 'utf8')); })(mockWindow);
    const reportPath = path.resolve(__dirname, '../../js/ua.report_v2.js');
    (function (window) { eval(fs.readFileSync(reportPath, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('rejects with a clear error when leaflet-image library is missing', async () => {
    delete mockWindow.leafletImage;
    await expect(UA.captureMapImage({ map: makeMap([]) }))
      .rejects.toThrow(/leaflet-image library not loaded/);
  });

  test('detaches DivIcon markers before invoking leafletImage and restores them on success', async () => {
    const divMarker = makeMarker(new FakeDivIcon());
    const map = makeMap([divMarker]);

    let leafletImageCallback = null;
    let mapPassedToLeafletImage = null;
    let liveLayersWhenInvoked = null;
    mockWindow.leafletImage = function (m, cb) {
      mapPassedToLeafletImage = m;
      liveLayersWhenInvoked = [...m.live];
      leafletImageCallback = cb;
    };

    const promise = UA.captureMapImage({ map });

    // Drive past MAP_CAPTURE_DELAY_MS so leafletImage gets invoked.
    await jest.advanceTimersByTimeAsync(200);

    expect(mapPassedToLeafletImage).toBe(map);
    // The DivIcon marker must be detached BEFORE leafletImage runs.
    expect(map.removed).toEqual([divMarker]);
    expect(liveLayersWhenInvoked).not.toContain(divMarker);

    // Simulate a successful capture.
    const fakeCanvas = { toDataURL: () => 'data:image/png;base64,AAA=' };
    leafletImageCallback(null, fakeCanvas);

    await expect(promise).resolves.toBe('data:image/png;base64,AAA=');
    // Restore put the marker back.
    expect(map.added).toEqual([divMarker]);
  });

  test('restores detached markers on the leaflet-image error path', async () => {
    const divMarker = makeMarker(new FakeDivIcon());
    const map = makeMap([divMarker]);

    let leafletImageCallback = null;
    mockWindow.leafletImage = function (m, cb) { leafletImageCallback = cb; };

    const promise = UA.captureMapImage({ map });
    await jest.advanceTimersByTimeAsync(200);

    expect(map.removed).toEqual([divMarker]);

    leafletImageCallback(new Error('boom'));

    await expect(promise).rejects.toThrow('boom');
    expect(map.added).toEqual([divMarker]);
  });

  test('rejects with timeout error when leaflet-image never invokes its callback', async () => {
    const divMarker = makeMarker(new FakeDivIcon());
    const map = makeMap([divMarker]);

    // leafletImage never calls its callback — this is exactly the production
    // hang scenario the safety timeout was added to recover from.
    let leafletImageCallback = null;
    mockWindow.leafletImage = function (m, cb) { leafletImageCallback = cb; };

    const promise = UA.captureMapImage({ map });
    // Attach a no-op catch so an "unhandled rejection" warning doesn't race
    // with the assertions while we still hold the same promise.
    promise.catch(() => {});

    await jest.advanceTimersByTimeAsync(200); // past MAP_CAPTURE_DELAY_MS
    // Marker is detached; not yet restored.
    expect(map.removed).toEqual([divMarker]);
    expect(map.added).toEqual([]);

    // Advance past MAP_CAPTURE_TIMEOUT_MS (30 000 ms).
    await jest.advanceTimersByTimeAsync(30_000);

    await expect(promise).rejects.toThrow(/Kartenaufnahme abgebrochen/);
    // Cleanup must run on the timeout path, restoring the detached marker.
    expect(map.added).toEqual([divMarker]);

    // A late callback after timeout must NOT change the settled rejection
    // and must NOT double-restore the marker.
    leafletImageCallback(null, { toDataURL: () => 'data:image/png;base64,LATE=' });
    expect(map.added).toEqual([divMarker]); // still exactly one re-add
  });
});
