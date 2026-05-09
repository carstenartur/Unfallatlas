(() => {
  const UA = (window.UA = window.UA || {});

  UA.extractPoints = function extractPoints(geojson){
    const pts = [];
    const feats = geojson?.features || [];
    for (const f of feats){
      const g = f?.geometry;
      if (!g || g.type !== "Point" || !Array.isArray(g.coordinates)) continue;
      const [lon, lat] = g.coordinates;
      if (typeof lat !== "number" || typeof lon !== "number") continue;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      if (Math.abs(lat) < 1 && Math.abs(lon) < 1) continue;
      if (lat < 46 || lat > 56 || lon < 4 || lon > 17) continue;
      pts.push({ lat, lon, props: f.properties || {} });
    }
    return pts;
  };

  UA.buildDataUrl = function buildDataUrl(cityRaw){
    const suffix = UA.normKey(cityRaw);
    return `out/output_all_years_${suffix}.geojson`;
  };

  UA.buildPOIUrl = function buildPOIUrl(cityRaw){
    const suffix = UA.normKey(cityRaw);
    return `out/poi_${suffix}.geojson`;
  };

  UA.loadCityData = async function loadCityData(ctx){
    const url = UA.buildDataUrl(ctx.CITY_RAW);
    ctx.DATA_URL = url;
    ctx.ui.dataSourceCode.textContent = url;

    const resp = await fetch(url, { cache:"no-store" });
    if (!resp.ok) throw new Error(`GeoJSON konnte nicht geladen werden (${resp.status}): ${url}`);
    const gj = await resp.json();
    ctx.geojsonProps = gj?.properties || null;
    if (UA.contextLayers && typeof UA.contextLayers.detect === 'function') {
      // Detect once per GeoJSON load; capability flags are derived via
      // the central helper so loader/UI/tests cannot drift out of
      // sync. The detection result itself is also cached on `ctx` for
      // future panels/legends/exports that want the raw field list.
      const detection = UA.contextLayers.detect(gj);
      ctx.contextLayerDetection = detection;
      ctx.contextCapabilities = (typeof UA.contextLayers.capabilitiesFromDetection === 'function')
        ? UA.contextLayers.capabilitiesFromDetection(detection)
        : null;

      // Lazy-load ways_<city>.json + sidecar meta in the background as
      // soon as we know the FeatureCollection carries OSM context. The
      // resolved state is stashed on ctx.contextLayerState so popup
      // composition (UA.composeAccidentPopupHtml) can hydrate per-way
      // attributes (highway/maxspeed/lanes/surface/cycleway/osm_incline/
      // road_slope_percent) onto the per-feature props at render time.
      // This is fire-and-forget: if the state is not yet ready when a
      // popup opens, the renderer simply falls back to per-feature data
      // (no waiting, no spinner — see plan PR-C "Race-tolerant").
      //
      // Two follow-up safeguards from PR-C review:
      //   1. Capture the city slug at scheduling time and only stash
      //      the resolved state if `ctx.CITY_RAW` still matches when
      //      the promise resolves. Otherwise an in-place city switch
      //      (Tour mode, citySel.change without page reload) could
      //      overwrite the new city's state with the previous city's.
      //   2. Trigger a lightweight rebuild (`renderLayers` with
      //      `_dataChanged = true`) once the state arrives, so already
      //      bound markers gain popups without requiring a zoom/data
      //      change. Guarded behind feature detection — the loader
      //      stays usable in test environments without a full UI.
      ctx.contextLayerState = null;
      if (ctx.contextCapabilities && ctx.contextCapabilities.hasOsmContext
          && typeof UA.contextLayers.loadAtIdle === 'function') {
        const expectedSlug = (UA.normKey ? UA.normKey(ctx.CITY_RAW) : String(ctx.CITY_RAW || '').toLowerCase());
        try {
          Promise.resolve(UA.contextLayers.loadAtIdle(ctx, ctx.CITY_RAW))
            .then((state) => {
              const currentSlug = (UA.normKey ? UA.normKey(ctx.CITY_RAW) : String(ctx.CITY_RAW || '').toLowerCase());
              if (currentSlug !== expectedSlug) return; // city switched while loading
              ctx.contextLayerState = state || null;
              // Re-render so already-bound markers pick up hydrated
              // way attrs in their popups. Pure best-effort: ignored
              // when the map renderer is not available (e.g. unit
              // tests, headless contexts).
              //
              // QA hardening: skip the rebuild entirely when no marker
              // layer has been built yet — the imminent first
              // renderLayers() will already see ctx.contextLayerState
              // and there is no stale popup to refresh. This avoids a
              // duplicate full marker rebuild on large GeoJSON files
              // (city loads with 100k+ accidents) where the cluster
              // construction dominates the frame budget.
              const hasBuiltLayer = !!(ctx.clusterLayer || ctx.heatLayer);
              if (hasBuiltLayer && typeof UA.renderLayers === 'function' && ctx.map) {
                ctx._dataChanged = true;
                try { UA.renderLayers(ctx); } catch (_) { /* keep going */ }
              }
              // First-class context map overlays: now that the per-way
              // geometry table is hydrated, (re-)wire the slope /
              // traffic Leaflet controls. Idempotent — refresh tears
              // down any prior controls before rebuilding.
              if (typeof UA.refreshContextOverlays === 'function' && ctx.map) {
                try { UA.refreshContextOverlays(ctx); } catch (_) { /* keep going */ }
              }
              // Item 10: surface enrichment provenance (generatedAt,
              // enrichmentScriptVersion, per-source extractDate /
              // producerVersion) in the city-header "ⓘ Datenstand"
              // tooltip. Best-effort — function is a no-op when the
              // metaInfoBox / tip element is absent (e.g. tests).
              if (typeof UA.updateEnrichmentProvenance === 'function') {
                try { UA.updateEnrichmentProvenance(ctx); } catch (_) { /* keep going */ }
              }
            })
            .catch(() => { /* optional file: stay null, popup degrades gracefully */ });
        } catch (_) { /* idle-callback unavailable: ignore */ }
      }
    } else {
      ctx.contextLayerDetection = null;
      ctx.contextCapabilities = null;
      ctx.contextLayerState = null;
      // Make sure stale provenance from a previously loaded city
      // doesn't bleed into a city without enrichment.
      if (typeof UA.updateEnrichmentProvenance === 'function') {
        try { UA.updateEnrichmentProvenance(ctx); } catch (_) { /* keep going */ }
      }
    }
    ctx.allPts = UA.extractPoints(gj);
  };

  UA.loadPOIData = async function loadPOIData(ctx){
    const url = UA.buildPOIUrl(ctx.CITY_RAW);
    try {
      const resp = await fetch(url, { cache:"no-store" });
      if (!resp.ok) {
        console.info(`POI data not available for ${ctx.CITY_RAW}`);
        ctx.poiData = null;
        return;
      }
      const gj = await resp.json();
      ctx.poiData = gj;
      console.info(`Loaded ${gj?.features?.length || 0} POIs for ${ctx.CITY_RAW}`);
    } catch(e) {
      console.warn(`Failed to load POI data for ${ctx.CITY_RAW}:`, e);
      ctx.poiData = null;
    }
  };
})();
