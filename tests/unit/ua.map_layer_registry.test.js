describe('map layer registry and map modes', () => {
  let UA;
  let win;

  function makeLeafletStub() {
    function makeLayer(kind, url, opts) {
      return {
        kind,
        url,
        opts,
        opacity: 1,
        events: {},
        addTo(map) { if (map && typeof map.addLayer === 'function') map.addLayer(this); return this; },
        remove() { if (this._map && typeof this._map.removeLayer === 'function') this._map.removeLayer(this); },
        setOpacity(value) { this.opacity = value; return this; },
        on(name, fn) { this.events[name] = fn; return this; }
      };
    }
    const tileLayer = (url, opts) => makeLayer('xyz', url, opts);
    tileLayer.wms = (url, opts) => makeLayer('wms', url, opts);
    return { tileLayer };
  }

  function load(rel) {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../js/' + rel), 'utf8');
    (function(window) { eval(src); })(win);
  }

  beforeEach(() => {
    win = { UA: {}, L: makeLeafletStub() };
    load('ua.map_layer_registry.js');
    load('ua.map_v2.js');
    UA = win.UA;
  });

  test('resolves supported map modes and falls back to standard', () => {
    expect(UA.resolveMapMode('hybrid')).toBe('hybrid');
    expect(UA.resolveMapMode('analysis')).toBe('analysis');
    expect(UA.resolveMapMode('unknown-mode')).toBe('standard');
  });

  test('returns Bonn-specific orthophoto fallback chain', () => {
    const ids = UA.resolveRegionalOrthophotoCandidates({ city: 'Bonn' }).map(def => def.id);
    expect(ids).toEqual([
      'bonn-orthophoto',
      'nrw-orthophoto',
      'bkg-orthophoto',
      'esri-world-imagery'
    ]);
  });

  test('applies hybrid mode with orthophoto and labels', () => {
    const map = {
      layers: [],
      addLayer(layer) { layer._map = this; if (!this.layers.includes(layer)) this.layers.push(layer); return this; },
      removeLayer(layer) { this.layers = this.layers.filter(entry => entry !== layer); return this; }
    };
    const ctx = { CITY_RAW: 'Bonn', map, mapMode: 'hybrid', orthophotoOpacity: 0.95 };

    UA.applyMapMode(ctx);

    expect(ctx.baseMapState.activeOrthophotoDef.id).toBe('bonn-orthophoto');
    expect(map.layers.map(layer => layer.url)).toEqual(expect.arrayContaining([
      'https://www.bonn.de/stadtplan-wms/services/orthofoto/MapServer/WMSServer',
      'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png'
    ]));
    expect(map.layers.map(layer => layer.url)).not.toContain('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
  });

  test('analysis mode clamps orthophoto opacity for overlay readability', () => {
    const map = {
      layers: [],
      addLayer(layer) { layer._map = this; if (!this.layers.includes(layer)) this.layers.push(layer); return this; },
      removeLayer(layer) { this.layers = this.layers.filter(entry => entry !== layer); return this; }
    };
    const ctx = { CITY_RAW: 'Hannover', map, mapMode: 'analysis', orthophotoOpacity: 1 };

    UA.applyMapMode(ctx);

    expect(ctx.baseMapState.activeOrthophotoDef.id).toBe('niedersachsen-orthophoto');
    expect(ctx.baseMapState.orthophotoLayer.opacity).toBeLessThanOrEqual(0.72);
    expect(UA.getActiveMapLayerInfo(ctx).modeLabel).toBe('Analyseansicht');
  });

  test('reports fallback source from latest fallback hop', () => {
    const map = {
      layers: [],
      addLayer(layer) { layer._map = this; if (!this.layers.includes(layer)) this.layers.push(layer); return this; },
      removeLayer(layer) { this.layers = this.layers.filter(entry => entry !== layer); return this; }
    };
    const ctx = { CITY_RAW: 'Bonn', map, mapMode: 'orthophoto', orthophotoOpacity: 0.9 };

    UA.applyMapMode(ctx);
    const firstLayer = ctx.baseMapState.orthophotoLayer;
    firstLayer.events.tileerror();
    firstLayer.events.tileerror();
    firstLayer.events.tileerror();

    const secondLayer = ctx.baseMapState.orthophotoLayer;
    secondLayer.events.tileerror();
    secondLayer.events.tileerror();
    secondLayer.events.tileerror();

    const info = UA.getActiveMapLayerInfo(ctx);
    expect(info.orthophoto.id).toBe('bkg-orthophoto');
    expect(info.orthophotoFallbackFrom.id).toBe('nrw-orthophoto');
  });

  test('uses standard mode label when orthophoto cannot be resolved', () => {
    const map = {
      layers: [],
      addLayer(layer) { layer._map = this; if (!this.layers.includes(layer)) this.layers.push(layer); return this; },
      removeLayer(layer) { this.layers = this.layers.filter(entry => entry !== layer); return this; }
    };
    const ctx = {
      CITY_RAW: 'Bonn',
      map,
      mapMode: 'orthophoto',
      orthophotoOpacity: 0.9,
      baseMapState: { orthophotoCandidates: [], candidateIndex: 0 }
    };

    UA.applyMapMode(ctx);

    const info = UA.getActiveMapLayerInfo(ctx);
    expect(info.mode).toBe('standard');
    expect(info.modeLabel).toBe('Standardkarte');
    expect(info.orthophoto).toBeNull();
  });
});
