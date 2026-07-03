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

  test('createMapLayer sets maxNativeZoom and interactive maxZoom above native level', () => {
    const osm = UA.createMapLayer(UA.getMapLayerDefinition('standard-osm'));
    expect(osm.opts.maxNativeZoom).toBe(19);
    expect(osm.opts.maxZoom).toBeGreaterThanOrEqual(22);

    const dop = UA.createMapLayer(UA.getMapLayerDefinition('niedersachsen-orthophoto'));
    expect(dop.opts.maxNativeZoom).toBe(20);
    expect(dop.opts.maxZoom).toBeGreaterThanOrEqual(22);
  });

  // ---------------------------------------------------------------
  // Provider metadata validation
  // ---------------------------------------------------------------
  describe('provider metadata', () => {
    let orthophotoProviders;

    beforeEach(() => {
      orthophotoProviders = UA.getMapLayerRegistry().filter(def => def.layerType === 'orthophoto');
    });

    test('every orthophoto provider has a non-empty metadataUrl', () => {
      for (const def of orthophotoProviders) {
        expect(typeof def.metadataUrl).toBe('string');
        expect(def.metadataUrl.length).toBeGreaterThan(0);
      }
    });

    test('every orthophoto provider has a defined officialForExport flag', () => {
      for (const def of orthophotoProviders) {
        expect(typeof def.officialForExport).toBe('boolean');
      }
    });

    test('every orthophoto provider has a non-empty usageConstraint', () => {
      for (const def of orthophotoProviders) {
        expect(typeof def.usageConstraint).toBe('string');
        expect(def.usageConstraint.length).toBeGreaterThan(0);
      }
    });

    test('official providers (Bonn, NRW, Niedersachsen, BKG) have officialForExport=true', () => {
      const officialIds = ['bonn-orthophoto', 'nrw-orthophoto', 'niedersachsen-orthophoto', 'bkg-orthophoto'];
      for (const id of officialIds) {
        const def = UA.getMapLayerDefinition(id);
        expect(def).not.toBeNull();
        expect(def.officialForExport).toBe(true);
      }
    });

    test('esri-world-imagery has officialForExport=false (preview-only)', () => {
      const def = UA.getMapLayerDefinition('esri-world-imagery');
      expect(def).not.toBeNull();
      expect(def.officialForExport).toBe(false);
    });

    test('getExportSuitableOrthophotoProviders returns only official providers', () => {
      const suitable = UA.getExportSuitableOrthophotoProviders();
      expect(suitable.length).toBeGreaterThan(0);
      for (const def of suitable) {
        expect(def.officialForExport).toBe(true);
        expect(def.layerType).toBe('orthophoto');
      }
      const suitableIds = suitable.map(def => def.id);
      expect(suitableIds).toContain('bonn-orthophoto');
      expect(suitableIds).toContain('nrw-orthophoto');
      expect(suitableIds).toContain('niedersachsen-orthophoto');
      expect(suitableIds).toContain('bkg-orthophoto');
      expect(suitableIds).not.toContain('esri-world-imagery');
    });

    test('esri usageConstraint mentions preview-only restriction', () => {
      const def = UA.getMapLayerDefinition('esri-world-imagery');
      expect(def.usageConstraint).toMatch(/vorschau|interaktiv/i);
    });

    test('bkg usageConstraint mentions Nutzungsbedingungen', () => {
      const def = UA.getMapLayerDefinition('bkg-orthophoto');
      expect(def.usageConstraint).toMatch(/nutzungsbedingungen/i);
    });

    test('each WMS provider has a GetCapabilities URL as metadataUrl', () => {
      const wmsProviders = orthophotoProviders.filter(def => def.technicalType === 'WMS');
      for (const def of wmsProviders) {
        expect(def.metadataUrl).toBeTruthy();
        expect(def.metadataUrl.startsWith('https://')).toBe(true);
        const parsed = new URL(def.metadataUrl);
        const service = parsed.searchParams.get('SERVICE') || parsed.searchParams.get('service');
        const request = parsed.searchParams.get('REQUEST') || parsed.searchParams.get('request');
        expect((service || '').toUpperCase()).toBe('WMS');
        expect((request || '').toLowerCase()).toBe('getcapabilities');
      }
    });
  });
});
