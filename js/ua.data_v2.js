(() => {
  const UA = (window.UA = window.UA || {});

  function resources() {
    if (!UA.DataResources) {
      throw new Error('UA.DataResources must be loaded before ua.data_v2.js');
    }
    return UA.DataResources;
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

  async function fetchAccidentGeoJson(cityRaw) {
    const registry = UA.AccidentProvider && UA.AccidentProvider.ProviderRegistry;
    const provider = registry
      ? (typeof registry.resolveAsync === 'function'
          ? await registry.resolveAsync(cityRaw)
          : registry.resolve(cityRaw))
      : null;
    const staticType = UA.AccidentProvider
      && UA.AccidentProvider.PROVIDER_TYPES
      && UA.AccidentProvider.PROVIDER_TYPES.STATIC_GEOJSON;

    // Full-city static files are a first-party DataResources concern. Provider
    // implementations remain available for tiled and genuinely custom sources.
    if (provider
        && typeof provider.fetchForCity === 'function'
        && provider.type !== staticType) {
      return provider.fetchForCity(cityRaw);
    }
    return resources().fetchJson('accidentGeoJson', { city: cityRaw });
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

  UA.loadCityData = async function loadCityData(ctx){
    const url = UA.buildDataUrl(ctx.CITY_RAW);
    ctx.DATA_URL = url;
    ctx.ui.dataSourceCode.textContent = url;

    let geojson;
    try {
      geojson = await fetchAccidentGeoJson(ctx.CITY_RAW);
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      throw new Error(`GeoJSON konnte nicht geladen werden: ${message}`);
    }

    refreshContextState(ctx, geojson);
    ctx.allPts = UA.extractPoints(geojson);
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
})();