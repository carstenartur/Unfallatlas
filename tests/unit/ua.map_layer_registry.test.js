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
    document.head.innerHTML = '';
    win = { UA: {}, L: makeLeafletStub(), document };
    load('ua.map_layer_registry.js');
    load('ua.map_v2.js');
    UA = win.UA;
  });

  test('resolves supported map modes and falls back to standard', () => {
    expect(UA.resolveMapMode('hybrid')).toBe('hybrid');
    expect(UA.resolveMapMode('analysis')).toBe('analysis');
    expect(UA.resolveMapMode('unknown-mode')).toBe('standard');
  });

  test('starts Bonn with the official NRW aerial imagery and keeps historical city-source metadata readable', () => {
    const ids = UA.resolveRegionalOrthophotoCandidates({ city: 'Bonn' }).map(def => def.id);
    const oldSource = UA.getMapLayerDefinition('bonn-orthophoto');
    expect(oldSource.provider).toBe('Bundesstadt Bonn');
    expect(UA.createMapLayer(oldSource)).toBeNull();
    expect(ids).toEqual([
      'nrw-orthophoto',
      'bkg-orthophoto',
      'esri-world-imagery'
    ]);
  });

  test.each(['Bonn', 'Koeln', 'Köln', 'Duesseldorf', 'Düsseldorf', 'Muenster', 'Münster', 'Bielefeld',
    'Dortmund', 'Essen', 'Duisburg', 'Bochum', 'Wuppertal'])('requests the NRW colour imagery for %s', city => {
    const [source] = UA.resolveRegionalOrthophotoCandidates(city);
    expect(source.id).toBe('nrw-orthophoto');
    expect(UA.createMapLayer(source).opts.layers).toBe('nw_dop_rgb');
  });

  test.each(['Hannover', 'Braunschweig', 'Wolfsburg'])('requests the LGLN imagery layer and credits the year of access in %s', city => {
    const [source] = UA.resolveRegionalOrthophotoCandidates(city);
    expect(source.id).toBe('niedersachsen-orthophoto');
    const layer = UA.createMapLayer(source);
    expect(layer.opts.layers).toBe('ni_dop20');
    expect(layer.opts.attribution).toContain('LGLN (' + new Date().getFullYear() + ')');
    expect(layer.opts.attribution).toContain('https://creativecommons.org/licenses/by/4.0/');
    expect(source.license).toContain('CC BY 4.0');
  });

  test('applies hybrid mode with orthophoto and labels', () => {
    const config = document.createElement('meta');
    config.name = 'unfallwerkbank-carto-basemaps-key';
    config.content = ' test+key&value ';
    document.head.appendChild(config);
    const map = {
      layers: [],
      addLayer(layer) { layer._map = this; if (!this.layers.includes(layer)) this.layers.push(layer); return this; },
      removeLayer(layer) { this.layers = this.layers.filter(entry => entry !== layer); return this; }
    };
    const ctx = { CITY_RAW: 'Bonn', map, mapMode: 'hybrid', orthophotoOpacity: 0.95 };

    UA.applyMapMode(ctx);

    expect(ctx.baseMapState.activeOrthophotoDef.id).toBe('nrw-orthophoto');
    expect(map.layers.map(layer => layer.url)).toEqual(expect.arrayContaining([
      'https://www.wms.nrw.de/geobasis/wms_nw_dop',
      'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png?key=test%2Bkey%26value'
    ]));
    expect(map.layers.map(layer => layer.url)).not.toContain('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png');
  });

  test.each(['hybrid', 'analysis'])('keeps the orthophoto in %s without requesting unauthenticated labels', mapMode => {
    const map = {
      layers: [],
      addLayer(layer) { this.layers.push(layer); }
    };
    const ctx = { CITY_RAW: 'Hannover', map, mapMode };

    UA.applyMapMode(ctx);

    expect(map.layers).toEqual([ctx.baseMapState.orthophotoLayer]);
    expect(UA.getActiveMapLayerInfo(ctx)).toMatchObject({
      mode: mapMode,
      warning: 'Straßenbeschriftungen sind für diese Installation nicht konfiguriert.',
    });
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

  describe('orthophoto fallback after a visible Leaflet grid finishes', () => {
    let ctx;
    let container;

    function openMap(tileOffsetX, tileOffsetY) {
      win.L = require('leaflet');
      container = document.createElement('div');
      document.body.appendChild(container);
      Object.defineProperty(container, 'clientWidth', { value: 128 });
      Object.defineProperty(container, 'clientHeight', { value: 128 });
      container.getBoundingClientRect = () => ({ left: 0, top: 0, right: 128, bottom: 128 });
      const map = win.L.map(container, { fadeAnimation: false, zoomAnimation: false });
      // Inside a tile, on its edge or at its corner, Leaflet requests one, two or four tiles.
      map.setView(map.unproject([138154 * 256 + tileOffsetX, 86155 * 256 + tileOffsetY], 18), 18);
      ctx = { CITY_RAW: 'Hannover', map, mapMode: 'orthophoto' };
      UA.applyMapMode(ctx);
    }

    function activeTiles() {
      const tiles = [...ctx.baseMapState.orthophotoLayer.getContainer().querySelectorAll('img.leaflet-tile')];
      // jsdom has no layout engine or image decoder. Leaflet itself dispatches all grid events.
      for (const tile of tiles) tile.getBoundingClientRect = container.getBoundingClientRect;
      return tiles;
    }

    function finishTile(tile, success) {
      Object.defineProperty(tile, 'complete', { configurable: true, value: true });
      tile.dispatchEvent(new Event(success ? 'load' : 'error'));
    }

    afterEach(() => {
      ctx?.map.remove();
      container?.remove();
    });

    test('keeps LGLN when three errors precede a successful tile', async () => {
      openMap(0, 0);
      const tiles = activeTiles();
      expect(tiles).toHaveLength(4);
      tiles.slice(0, 3).forEach(tile => finishTile(tile, false));
      expect(UA.getActiveMapLayerInfo(ctx).orthophoto.id).toBe('niedersachsen-orthophoto');
      finishTile(tiles[3], true);
      await Promise.resolve();
      expect(UA.getActiveMapLayerInfo(ctx).orthophoto.id).toBe('niedersachsen-orthophoto');
    });

    test('retries only an isolated missing tile, keeps the official source and clears the warning on recovery', async () => {
      openMap(0, 128);
      const [good, missing] = activeTiles();
      const goodWrite = jest.spyOn(good, 'setAttribute');
      const missingWrite = jest.spyOn(missing, 'setAttribute');
      finishTile(good, true);
      finishTile(missing, false);
      await Promise.resolve();
      expect(missingWrite.mock.calls.filter(([name]) => name === 'src')).toEqual([['src', missing.src]]);
      expect(goodWrite.mock.calls.filter(([name]) => name === 'src')).toHaveLength(0);
      finishTile(missing, false);
      await Promise.resolve();
      expect(missingWrite.mock.calls.filter(([name]) => name === 'src')).toHaveLength(1);
      expect(UA.getActiveMapLayerInfo(ctx).warning).toContain('1 von 2');
      finishTile(missing, true);
      await Promise.resolve();
      expect(UA.getActiveMapLayerInfo(ctx)).toMatchObject({ orthophoto: { id: 'niedersachsen-orthophoto' }, warning: '' });
    });

    test.each([[128, 1], [0, 2]])('falls back after all tiles fail at x offset %i (%i tiles)', async (x, count) => {
      openMap(x, 128);
      const originalLayer = ctx.baseMapState.orthophotoLayer;
      const tiles = activeTiles();
      expect(tiles).toHaveLength(count);
      tiles.forEach(tile => finishTile(tile, false));
      await Promise.resolve();
      expect(UA.getActiveMapLayerInfo(ctx).orthophoto.id).toBe('bkg-orthophoto');
      originalLayer.fire('load');
      await Promise.resolve();
      expect(UA.getActiveMapLayerInfo(ctx).orthophoto.id).toBe('bkg-orthophoto');
      activeTiles().forEach(tile => finishTile(tile, false));
      await Promise.resolve();
      expect(UA.getActiveMapLayerInfo(ctx)).toMatchObject({
        orthophoto: { id: 'esri-world-imagery' }, orthophotoFallbackFrom: { id: 'bkg-orthophoto' }
      });
    });

    test('ignores a completed failure after switching back to the standard map', async () => {
      openMap(128, 128);
      finishTile(activeTiles()[0], false);
      ctx.mapMode = 'standard';
      UA.applyMapMode(ctx);
      await Promise.resolve();
      expect(UA.getActiveMapLayerInfo(ctx).mode).toBe('standard');
      ctx.mapMode = 'orthophoto';
      UA.applyMapMode(ctx);
      expect(UA.getActiveMapLayerInfo(ctx).orthophoto.id).toBe('niedersachsen-orthophoto');
    });

    test('handles a later grid outage after a previously successful viewport', async () => {
      openMap(128, 128);
      finishTile(activeTiles()[0], true);
      await Promise.resolve();
      // Move beyond Leaflet's cached ring without animation, then complete the new grid.
      ctx.map.panBy([4096, 0], { animate: false });
      activeTiles().filter(tile => !tile.classList.contains('leaflet-tile-loaded'))
        .forEach(tile => finishTile(tile, false));
      await Promise.resolve();
      expect(UA.getActiveMapLayerInfo(ctx).orthophoto.id).toBe('bkg-orthophoto');
    });
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

    test('active official providers have officialForExport=true', () => {
      const officialIds = ['nrw-orthophoto', 'niedersachsen-orthophoto', 'bkg-orthophoto'];
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
      expect(suitableIds).not.toContain('bonn-orthophoto');
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
