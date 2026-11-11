const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const read = file => fs.readFileSync(path.join(__dirname, '../..', file));
const dataset = () => JSON.parse(zlib.gunzipSync(read('data/mobility/road-labels/bonn.json.gz')));

describe('local street labels', () => {
  function setup(city, payload) {
    const L = require('leaflet');
    const win = { L, document, UA: { DataResources: { fetchJsonUrl: jest.fn().mockResolvedValue(payload) } } };
    Function('window', read('js/ua.local_road_labels.js').toString())(win);
    const host = document.createElement('div');
    Object.defineProperties(host, { clientWidth: { value: 800 }, clientHeight: { value: 600 } });
    document.body.appendChild(host);
    const map = L.map(host).setView([50.732, 7.098], 17);
    const layer = win.UA.createLocalRoadLabels(city, () => {});
    return { layer, map, host, win, fetch: win.UA.DataResources.fetchJsonUrl };
  }

  test('downloaded named Bonn ways originate from the published network and carry their source', () => {
    const data = dataset();
    const index = JSON.parse(zlib.gunzipSync(read('out/ctxtiles/bonn/index.json.gz')));
    expect(data).toMatchObject({ city: 'bonn', schemaVersion: 1, source: { timestamp: '2026-11-07T00:00:00Z', license: 'ODbL 1.0' } });
    expect(data.names).toContain('Am Hauptbahnhof');
    expect(data.labels.length).toBeGreaterThan(1000);
    const tiles = new Map();
    for (const [id, name, latE5, lonE5] of data.labels) {
      if (!(id in index.wayIndex) || !data.names[name]) throw Error('Invalid local label: ' + id);
      const tile = index.wayIndex[id].join('/');
      if (!tiles.has(tile)) {
        tiles.set(tile, JSON.parse(zlib.gunzipSync(read('out/ctxtiles/bonn/' + tile + '.json.gz'))).geometries);
      }
      const geometry = tiles.get(tile)[id];
      const lat = latE5 / 1e5, lon = lonE5 / 1e5;
      const lonScale = 111195 * Math.cos(lat * Math.PI / 180);
      let distance = Infinity;
      for (let i = 0; i < geometry.length - 2; i += 2) {
        const x = (geometry[i + 1] - lon) * lonScale, y = (geometry[i] - lat) * 111195;
        const dx = (geometry[i + 3] - geometry[i + 1]) * lonScale;
        const dy = (geometry[i + 2] - geometry[i]) * 111195;
        const squaredLength = dx * dx + dy * dy;
        const t = squaredLength ? Math.max(0, Math.min(1, -(x * dx + y * dy) / squaredLength)) : 0;
        distance = Math.min(distance, Math.hypot(x + t * dx, y + t * dy));
      }
      if (distance > 10) throw Error('Label anchor has left local OSM way ' + id + ': ' + distance + ' m');
    }
  });

  test('paints local street names on their own geometry and clears them when removed', async () => {
    const data = dataset();
    const { map, layer, host, fetch } = setup('Bonn', data);
    try {
      expect(fetch).not.toHaveBeenCalled();
      expect(layer.getAttribution()).toContain('Straßennamen: &copy;');
      layer.addTo(map);
      await Promise.resolve();
      expect(host.querySelectorAll('.ua-local-road-label').length).toBeGreaterThan(2);
      expect(host.textContent).toMatch(/Am Hauptbahnhof|Maximilianstraße|Thomas-Mann-Straße|Quantiusstraße/);
      map.setView([52.375, 9.73], 17, { animate: false });
      expect(host.querySelector('.ua-local-road-label')).toBeNull();
      layer.remove();
      expect(layer.getLayers()).toHaveLength(0);
    } finally { map.remove(); host.remove(); }
  });

  test.each([false, true])('map modes add only the appropriate label provider with CARTO configured=%s', async configured => {
    const { map, host, fetch, win } = setup('Bonn', dataset());
    const key = document.createElement('meta');
    key.name = 'unfallwerkbank-carto-basemaps-key';
    key.content = 'fixture';
    if (configured) document.head.appendChild(key);
    for (const file of ['ua.map_layer_registry.js', 'ua.map_v2.js']) {
      Function('window', 'L', read('js/' + file).toString())(win, win.L);
    }
    const ctx = { map, CITY_RAW: 'Bonn', city: 'Bonn', mapMode: 'standard' };
    try {
      win.UA.applyMapMode(ctx);
      expect(fetch).not.toHaveBeenCalled();
      ctx.mapMode = 'hybrid';
      win.UA.applyMapMode(ctx);
      await Promise.resolve();
      expect(map.hasLayer(ctx.baseMapState.labelLayer)).toBe(true);
      if (configured) {
        expect(ctx.baseMapState.labelLayer._url).toMatch(/cartocdn/);
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(host.querySelector('.ua-local-road-label')).not.toBeNull();
      }
      ctx.mapMode = 'orthophoto';
      win.UA.applyMapMode(ctx);
      expect(map.hasLayer(ctx.baseMapState.labelLayer)).toBe(false);
      ctx.mapMode = 'analysis';
      win.UA.applyMapMode(ctx);
      expect(map.hasLayer(ctx.baseMapState.labelLayer)).toBe(true);
      ctx.mapMode = 'standard';
      win.UA.applyMapMode(ctx);
      expect(host.querySelector('.ua-local-road-label')).toBeNull();
    } finally { key.remove(); map.remove(); host.remove(); }
  });

  test('unsupported cities and a mismatched city payload never draw Bonn streets', async () => {
    const unsupported = setup('Köln', dataset());
    expect(unsupported.layer).toBeNull();
    expect(unsupported.fetch).not.toHaveBeenCalled();
    unsupported.map.remove();
    unsupported.host.remove();

    const { map, layer, host } = setup('Bonn', { ...dataset(), city: 'koeln' });
    try {
      layer.addTo(map);
      await Promise.resolve();
      expect(layer.localLabelStatus).toBe('unavailable');
      expect(host.querySelector('.ua-local-road-label')).toBeNull();
    } finally { map.remove(); host.remove(); }
  });
});
