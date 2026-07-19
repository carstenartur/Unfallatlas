'use strict';

const fs = require('fs');
const path = require('path');

function loadMapModule() {
  const markers = [];
  let clusterOptions = null;
  const clusterLayer = {
    on: jest.fn(),
    off: jest.fn(),
    addTo: jest.fn(function () { return this; }),
    addLayers: jest.fn(function (items) {
      markers.push(...items);
      if (clusterOptions && typeof clusterOptions.chunkProgress === 'function') {
        clusterOptions.chunkProgress(items.length, items.length, 0);
      }
      return this;
    }),
    getLayers: jest.fn(() => markers),
  };
  const win = {
    UA: {},
    location: { href: 'http://localhost/' },
    L: {
      circleMarker: jest.fn(() => {
        const marker = {
          on: jest.fn(),
          off: jest.fn(),
          bindPopup: jest.fn(function (html, options) {
            this.popupHtml = html;
            this.popupOptions = options;
            this._popup = { html, options };
            return this;
          }),
          getPopup: jest.fn(function () { return this._popup || null; }),
          openPopup: jest.fn(),
        };
        return marker;
      }),
      markerClusterGroup: jest.fn((options) => {
        clusterOptions = options;
        return clusterLayer;
      }),
    },
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../js/ua.map_v2.js'), 'utf8');
  (function (window, L) { eval(source); })(win, win.L);
  win.UA.refreshContextOverlayZOrder = jest.fn();
  return { win, UA: win.UA, markers, clusterLayer };
}

describe('UA.renderLayers lazy accident popups', () => {
  test('does not render popup HTML until a marker click and shares one handler', () => {
    const { UA, markers, clusterLayer } = loadMapModule();
    UA.renderAccidentBasePopupHtml = jest.fn(() => '<section>base</section>');
    UA.composeAccidentPopupHtml = jest.fn((_ctx, _props, { baseHtml }) => `${baseHtml}<section>context</section>`);

    const points = [
      { lat: 50.70, lon: 7.10, props: { ukategorie: '1', id: 'A' } },
      { lat: 50.71, lon: 7.11, props: { ukategorie: '2', id: 'B' } },
    ];
    const ctx = {
      CITY_RAW: 'Bonn',
      lifecyclePrimary: false,
      map: { getZoom: () => 15 },
      allPts: points,
      filteredAll: points,
      filteredCapped: points,
      viewportPts: points,
      accidentDataCoverage: { mode: 'full-city', complete: true },
      showCluster: true,
      showHeatmap: false,
      showOnlyAboveAverage: false,
      showSchools: false,
      showKindergartens: false,
      showArgumentation: false,
      ui: { statEl: { textContent: '' } },
      _dataChanged: true,
    };

    UA.renderLayers(ctx);
    expect(markers).toHaveLength(2);
    expect(UA.renderAccidentBasePopupHtml).not.toHaveBeenCalled();
    expect(UA.composeAccidentPopupHtml).not.toHaveBeenCalled();
    expect(markers.every(marker => marker.bindPopup.mock.calls.length === 0)).toBe(true);

    expect(markers[0].on).not.toHaveBeenCalled();
    expect(markers[1].on).not.toHaveBeenCalled();
    const markerClickBindings = clusterLayer.on.mock.calls.filter(([event]) => event === 'click');
    expect(markerClickBindings).toHaveLength(1);
    const delegatedHandler = markerClickBindings[0][1];
    expect(delegatedHandler).toBe(UA.materializeAccidentPopup);
    expect(markers[0]._uaPopupCtx).toBeUndefined();
    expect(markers[1]._uaPopupCtx).toBeUndefined();
    expect(clusterLayer._uaPopupCtx).toBe(ctx);

    delegatedHandler.call(clusterLayer, { target: clusterLayer, layer: markers[0] });
    expect(UA.renderAccidentBasePopupHtml).toHaveBeenCalledTimes(1);
    expect(UA.composeAccidentPopupHtml).toHaveBeenCalledTimes(1);
    expect(markers[0].bindPopup).toHaveBeenCalledWith(
      '<section>base</section><section>context</section>',
      { maxWidth: 360 }
    );
    expect(markers[0].openPopup).not.toHaveBeenCalled();
    expect(markers[0]._uaPoint).toBeNull();

    // Repeated propagation uses the bound popup and never re-renders HTML.
    delegatedHandler.call(clusterLayer, { target: clusterLayer, layer: markers[0] });
    expect(UA.renderAccidentBasePopupHtml).toHaveBeenCalledTimes(1);
    expect(UA.composeAccidentPopupHtml).toHaveBeenCalledTimes(1);

    // The untouched second marker still has no popup allocation.
    expect(markers[1].bindPopup).not.toHaveBeenCalled();
  });
});
