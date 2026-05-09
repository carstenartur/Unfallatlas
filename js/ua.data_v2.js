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
      const detection = UA.contextLayers.detect(gj);
      const available = new Set(detection?.availableFields || []);
      ctx.contextLayerDetection = detection;
      ctx.contextCapabilities = {
        hasElevation: available.has('elevation_m'),
        hasSlope: available.has('slope_percent') || available.has('slope_class') || available.has('slope_source'),
        hasOsmContext: (
          available.has('matched_way_id') ||
          available.has('highway') ||
          available.has('maxspeed') ||
          available.has('lanes') ||
          available.has('surface') ||
          available.has('cycleway') ||
          available.has('osm_incline') ||
          available.has('road_slope_percent')
        ),
        hasTrafficProxy: available.has('traffic_proxy_class'),
      };
    } else {
      ctx.contextLayerDetection = null;
      ctx.contextCapabilities = null;
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
