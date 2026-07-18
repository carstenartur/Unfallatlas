(() => {
  const UA = (window.UA = window.UA || {});

  function resources(required = true) {
    if (!UA.DataResources && required) {
      throw new Error('UA.DataResources must be loaded before ua.data_v2.js');
    }
    return UA.DataResources || null;
  }

  UA.extractPoints = function extractPoints(geojson){
    const pts = [];
    const feats = geojson?.features || [];
    for (const f of feats){
      const g = f?.geometry;
      if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
      const [lon, lat] = g.coordinates;
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) < 1 && Math.abs(lon) < 1) continue;
      if (lat < 46 || lat > 56 || lon < 4 || lon > 17) continue;
      pts.push({ lat, lon, props: f.properties || {} });
    }
    return pts;
  };

  UA.buildDataUrl = function buildDataUrl(cityRaw){
    return resources().url('accidentGeoJson', { city: cityRaw });
  };

  UA.buildPOIUrl = function buildPOIUrl(cityRaw){
    return resources().url('poiGeoJson', { city: cityRaw });
  };

  function normalizeAccidentDataMode(value) {
    return String(value || '').toLowerCase() === 'viewport' ? 'viewport' : 'full';
  }

  function requestedAccidentDataMode(ctx) {
    if (ctx && ctx.accidentDataMode) return normalizeAccidentDataMode(ctx.accidentDataMode);
    if (typeof UA.qGet === 'function') {
      return normalizeAccidentDataMode(UA.qGet('accidentDataMode', 'full'));
    }
    return 'full';
  }

  function plainBounds(bounds) {
    if (!bounds) return null;
    if (UA.AccidentViewportController
        && typeof UA.AccidentViewportController.normalizeBounds === 'function') {
      return UA.AccidentViewportController.normalizeBounds(bounds);
    }
    if (typeof bounds.getSouth === 'function') {
      return {
        south: bounds.getSouth(), west: bounds.getWest(),
        north: bounds.getNorth(), east: bounds.getEast(),
      };
    }
    if (Array.isArray(bounds) && bounds.length === 4) {
      return { south: bounds[0], west: bounds[1], north: bounds[2], east: bounds[3] };
    }
    if (typeof bounds === 'object') {
      const result = {
        south: bounds.south, west: bounds.west,
        north: bounds.north, east: bounds.east,
      };
      return Object.values(result).every(Number.isFinite) ? result : null;
    }
    return null;
  }

  function applyRequestedAccidentViewport(ctx) {
    if (!ctx || !ctx.map || typeof ctx.map.setView !== 'function') return false;
    if (typeof UA.viewParamsPresent !== 'function' || !UA.viewParamsPresent()) return false;
    if (typeof UA.qNum !== 'function') return false;

    const lat = UA.qNum('centerLat', null);
    const lon = UA.qNum('centerLon', null);
    const zoom = UA.qNum('zoom', null);
    if (![lat, lon, zoom].every(Number.isFinite)) return false;
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;

    ctx.map.setView([lat, lon], zoom);
    return true;
  }

  function customProviderForCity() {
    const registry = UA.AccidentProvider && UA.AccidentProvider.ProviderRegistry;
    const types = UA.AccidentProvider && UA.AccidentProvider.PROVIDER_TYPES;
    if (!registry || !types || typeof registry.get !== 'function') return null;
    const provider = registry.get('custom');
    return provider && provider.type === types.CUSTOM ? provider : null;
  }

  function coverageSuffix(coverage) {
    if (!coverage || coverage.complete) return '';
    if (coverage.status === 'loading') return ' (Kartenausschnitt wird geladen…)';
    if (coverage.status === 'degraded') {
      return ' (Kartenausschnitt teilweise geladen; Stadt unvollständig)';
    }
    if (coverage.status === 'complete-for-viewport') {
      return ' (Kartenausschnitt vollständig; Stadt unvollständig)';
    }
    return ' (nur aktueller Kartenausschnitt)';
  }

  function setAccidentCoverage(ctx, coverage) {
    ctx.accidentDataCoverage = coverage && Object.isFrozen(coverage)
      ? coverage
      : Object.freeze({ ...(coverage || {}) });
    if (ctx.ui?.dataSourceCode) {
      ctx.ui.dataSourceCode.textContent = `${ctx.DATA_URL || ''}${coverageSuffix(ctx.accidentDataCoverage)}`;
    }
  }

  async function loadFullCity(cityRaw) {
    const custom = customProviderForCity();
    const geojson = custom && typeof custom.fetchForCity === 'function'
      ? await custom.fetchForCity(cityRaw)
      : await resources().fetchJson('accidentGeoJson', { city: cityRaw });
    return {
      geojson,
      dataUrl: custom ? 'AccidentProvider:custom' : resources().url('accidentGeoJson', { city: cityRaw }),
      coverage: {
        mode: 'full-city',
        complete: true,
        provider: custom ? 'custom' : 'static',
        city: cityRaw,
        loadedFeatureCount: Array.isArray(geojson?.features) ? geojson.features.length : 0,
      },
    };
  }

  async function loadViewport(ctx) {
    applyRequestedAccidentViewport(ctx);
    const registry = UA.AccidentProvider && UA.AccidentProvider.ProviderRegistry;
    const tiled = registry && registry.get('tiled');
    const bounds = ctx && ctx.map && typeof ctx.map.getBounds === 'function'
      ? ctx.map.getBounds()
      : null;
    if (!tiled || !bounds || typeof tiled.fetchForBbox !== 'function') {
      const fallback = await loadFullCity(ctx.CITY_RAW);
      fallback.coverage.fallbackReason = 'tiled provider or map bounds unavailable';
      return fallback;
    }

    let available = false;
    try { available = await Promise.resolve(tiled.canProvideForCity(ctx.CITY_RAW)); }
    catch (_) { available = false; }
    if (!available) {
      const fallback = await loadFullCity(ctx.CITY_RAW);
      fallback.coverage.fallbackReason = 'accident tile manifest unavailable';
      return fallback;
    }

    const dataUrl = resources().url('accidentTileIndex', { city: ctx.CITY_RAW });
    if (UA.AccidentViewportController
        && typeof UA.AccidentViewportController.create === 'function'
        && typeof tiled.fetchTileSetForBbox === 'function') {
      ctx.accidentViewportController = UA.AccidentViewportController.create({ provider: tiled });
      ctx.DATA_URL = dataUrl;
      const pending = ctx.accidentViewportController.load(ctx.CITY_RAW, bounds);
      setAccidentCoverage(ctx, ctx.accidentViewportController.getSnapshot().coverage);
      const result = await pending;
      if (!result.committed) throw new Error('initial accident viewport request became stale');
      return { geojson: result.geojson, dataUrl, coverage: result.coverage };
    }

    const capabilities = typeof tiled.getCapabilities === 'function'
      ? await tiled.getCapabilities(ctx.CITY_RAW)
      : {};
    const geojson = await tiled.fetchForBbox(ctx.CITY_RAW, bounds);
    return {
      geojson,
      dataUrl,
      coverage: {
        mode: 'viewport-partial',
        complete: false,
        viewportComplete: true,
        status: 'complete-for-viewport',
        provider: 'tiled',
        city: ctx.CITY_RAW,
        bounds: plainBounds(bounds),
        tileZoom: capabilities.tileZoom || null,
        sourceTotalCount: capabilities.totalCount || null,
        sourceFingerprint: capabilities.sourceFingerprint || null,
        loadedFeatureCount: Array.isArray(geojson?.features) ? geojson.features.length : 0,
      },
    };
  }

  async function fetchAccidentGeoJson(ctx) {
    const mode = requestedAccidentDataMode(ctx);
    ctx.accidentDataMode = mode;
    return mode === 'viewport' ? loadViewport(ctx) : loadFullCity(ctx.CITY_RAW);
  }

  function refreshContextState(ctx, geojson) {
    ctx.geojsonProps = geojson?.properties || null;
    if (!UA.contextLayers || typeof UA.contextLayers.detect !== 'function') {
      ctx.contextLayerDetection = null;
      ctx.contextCapabilities = null;
      ctx.contextLayerState = null;
      if (typeof UA.updateEnrichmentProvenance === 'function') {
        try { UA.updateEnrichmentProvenance(ctx); } catch (_) {}
      }
      return;
    }

    const detection = UA.contextLayers.detect(geojson);
    ctx.contextLayerDetection = detection;
    ctx.contextCapabilities = typeof UA.contextLayers.capabilitiesFromDetection === 'function'
      ? UA.contextLayers.capabilitiesFromDetection(detection)
      : null;
    ctx.contextLayerState = null;

    if (typeof UA.updateEnrichmentProvenance === 'function') {
      try { UA.updateEnrichmentProvenance(ctx); } catch (_) {}
    }

    if (!ctx.contextCapabilities?.hasOsmContext
        || typeof UA.contextLayers.loadAtIdle !== 'function') return;

    const expectedSlug = UA.normKey
      ? UA.normKey(ctx.CITY_RAW)
      : String(ctx.CITY_RAW || '').toLowerCase();
    try {
      Promise.resolve(UA.contextLayers.loadAtIdle(ctx, ctx.CITY_RAW))
        .then(state => {
          const currentSlug = UA.normKey
            ? UA.normKey(ctx.CITY_RAW)
            : String(ctx.CITY_RAW || '').toLowerCase();
          if (currentSlug !== expectedSlug) return;
          ctx.contextLayerState = state || null;
          const hasBuiltLayer = !!(ctx.clusterLayer || ctx.heatLayer);
          if (hasBuiltLayer && typeof UA.renderLayers === 'function' && ctx.map) {
            ctx._dataChanged = true;
            try { UA.renderLayers(ctx); } catch (_) {}
          }
          if (typeof UA.refreshContextOverlays === 'function' && ctx.map) {
            try { UA.refreshContextOverlays(ctx); } catch (_) {}
          }
          if (typeof UA.updateEnrichmentProvenance === 'function') {
            try { UA.updateEnrichmentProvenance(ctx); } catch (_) {}
          }
        })
        .catch(() => {});
    } catch (_) {}
  }

  async function requestAccidentViewport(ctx) {
    if (!ctx || ctx.accidentDataMode !== 'viewport'
        || !ctx.accidentViewportController
        || !ctx.map || typeof ctx.map.getBounds !== 'function') return null;
    const pending = ctx.accidentViewportController.load(ctx.CITY_RAW, ctx.map.getBounds());
    setAccidentCoverage(ctx, ctx.accidentViewportController.getSnapshot().coverage);
    return pending;
  }

  function commitAccidentViewportResult(ctx, result) {
    if (!ctx || !result || !result.committed) return false;
    setAccidentCoverage(ctx, result.coverage);
    if (result.geojson) ctx.allPts = UA.extractPoints(result.geojson);
    return result.changed !== false;
  }

  UA.loadCityData = async function loadCityData(ctx){
    let loaded;
    try {
      loaded = await fetchAccidentGeoJson(ctx);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      throw new Error(`GeoJSON konnte nicht geladen werden: ${message}`);
    }

    ctx.DATA_URL = loaded.dataUrl;
    setAccidentCoverage(ctx, loaded.coverage);
    refreshContextState(ctx, loaded.geojson);
    ctx.allPts = UA.extractPoints(loaded.geojson);
  };

  UA.loadPOIData = async function loadPOIData(ctx){
    try {
      const geojson = await resources().fetchJson('poiGeoJson', {
        city: ctx.CITY_RAW,
      }, { optional: true });
      if (!geojson) {
        console.info(`POI data not available for ${ctx.CITY_RAW}`);
        ctx.poiData = null;
        return;
      }
      ctx.poiData = geojson;
      console.info(`Loaded ${geojson?.features?.length || 0} POIs for ${ctx.CITY_RAW}`);
    } catch (error) {
      console.warn(`Failed to load POI data for ${ctx.CITY_RAW}:`, error);
      ctx.poiData = null;
    }
  };

  UA.normalizeAccidentDataMode = normalizeAccidentDataMode;
  UA.applyRequestedAccidentViewport = applyRequestedAccidentViewport;
  UA.fetchAccidentGeoJson = fetchAccidentGeoJson;
  UA.setAccidentCoverage = setAccidentCoverage;
  UA.requestAccidentViewport = requestAccidentViewport;
  UA.commitAccidentViewportResult = commitAccidentViewportResult;
})();
