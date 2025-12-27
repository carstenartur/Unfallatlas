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

  UA.loadCityData = async function loadCityData(ctx){
    const url = UA.buildDataUrl(ctx.CITY_RAW);
    ctx.DATA_URL = url;
    ctx.ui.dataSourceCode.textContent = url;

    const resp = await fetch(url, { cache:"no-store" });
    if (!resp.ok) throw new Error(`GeoJSON konnte nicht geladen werden (${resp.status}): ${url}`);
    const gj = await resp.json();
    ctx.allPts = UA.extractPoints(gj);
  };
})();