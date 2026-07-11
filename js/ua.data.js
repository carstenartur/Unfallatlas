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
    // Delegate to the central path registry when available (ua.data_paths.js).
    if (UA.DataPaths && typeof UA.DataPaths.accidentGeoJson === 'function') {
      return UA.DataPaths.accidentGeoJson(cityRaw);
    }
    const suffix = UA.normKey(cityRaw);
    return `out/output_all_years_${suffix}.geojson`;
  };

  function _isGzipOnlyMode() {
    try {
      const mode = window.document
        ?.querySelector('meta[name="unfallatlas:data-mode"]')
        ?.getAttribute('content');
      return mode === 'gzip-only';
    } catch (_) {
      return false;
    }
  }

  function _gzipSupportError(url) {
    return new Error(
      `Daten konnten nicht geladen werden: gzip-Daten konnten nicht dekomprimiert werden. ` +
      `Bitte modernen Browser verwenden oder Deployment prüfen. (${url}.gz)`
    );
  }

  UA.loadCityData = async function loadCityData(ctx){
    const url = UA.buildDataUrl(ctx.CITY_RAW);
    ctx.DATA_URL = url;
    ctx.ui.dataSourceCode.textContent = url;

    let gj;
    if (typeof UA.fetchJsonCompressed === 'function') {
      try {
        gj = await UA.fetchJsonCompressed(url);
      } catch (err) {
        const msg = String(err && err.message ? err.message : err || '');
        if (msg.includes('DecompressionStream is not available')) throw _gzipSupportError(url);
        throw new Error(`GeoJSON konnte nicht geladen werden: ${msg}`);
      }
    } else if (_isGzipOnlyMode()) {
      throw _gzipSupportError(url);
    } else {
      const resp = await fetch(url, { cache:"no-store" });
      if (!resp.ok) throw new Error(`GeoJSON konnte nicht geladen werden (${resp.status}): ${url}`);
      gj = await resp.json();
    }

    ctx.allPts = UA.extractPoints(gj);
  };
})();