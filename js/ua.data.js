(() => {
  const UA = (window.UA = window.UA || {});

  function resources() {
    if (!UA.DataResources) {
      throw new Error('UA.DataResources must be loaded before ua.data.js');
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

  UA.loadCityData = async function loadCityData(ctx){
    const url = UA.buildDataUrl(ctx.CITY_RAW);
    ctx.DATA_URL = url;
    ctx.ui.dataSourceCode.textContent = url;

    let geojson;
    try {
      geojson = await resources().fetchJson('accidentGeoJson', {
        city: ctx.CITY_RAW,
      });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      throw new Error(`GeoJSON konnte nicht geladen werden: ${message}`);
    }
    ctx.allPts = UA.extractPoints(geojson);
  };
})();