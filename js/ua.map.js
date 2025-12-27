(() => {
  const UA = window.UA;

  UA.initLeaflet = function initLeaflet(ctx){
    if (!window.L) throw new Error("Leaflet fehlt.");

    const map = L.map('map', { preferCanvas: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap-Mitwirkende'
    }).addTo(map);

    map.setView([52.3759, 9.7320], 12);

    ctx.map = map;

    // draw layer
    ctx.drawnItems = new L.FeatureGroup().addTo(map);
    ctx.selectionBounds = null;

    const drawControl = new L.Control.Draw({
      position: 'topright',
      draw: {
        polygon:false, polyline:false, circle:false, marker:false, circlemarker:false,
        rectangle: { shapeOptions: { color: "#2b7cff", weight: 2 } }
      },
      edit: { featureGroup: ctx.drawnItems, edit:false, remove:false }
    });
    map.addControl(drawControl);

    ctx.drawControl = drawControl;

    map.on(L.Draw.Event.CREATED, (e) => {
      ctx.drawnItems.clearLayers();
      ctx.drawnItems.addLayer(e.layer);
      ctx.selectionBounds = e.layer.getBounds();
      UA.syncViewToUrl(ctx);
      UA.recomputeAndRender(ctx);
    });

    // helper for popup buttons
    window.uaZoomToBounds = function(s,w,n,e){
      try { map.fitBounds([[s,w],[n,e]], { padding: [20,20] }); } catch(err) { console.warn(err); }
    };
  };

  UA.fitToAllPoints = function fitToAllPoints(ctx){
    const points = ctx.allPts || [];
    if (!points.length) return;
    let minLat=  90, maxLat=-90, minLon= 180, maxLon=-180;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    ctx.map.fitBounds(L.latLngBounds([minLat, minLon], [maxLat, maxLon]), { padding:[20,20] });
  };

  UA.renderLayers = function renderLayers(ctx){
    if (ctx.clusterLayer) { ctx.clusterLayer.remove(); ctx.clusterLayer = null; }
    if (ctx.heatLayer) { ctx.heatLayer.remove(); ctx.heatLayer = null; }

    let pts = ctx.viewportPts || [];
    const ptsBeforeHot = pts;

    ctx.lastHotGrid = null;
    let hotInfo = "";

    if (ctx.showOnlyAboveAverage) {
      UA.updateHotspotCellPx(ctx);
      const r = UA.hotFilter(ctx, pts);
      const hotPts = r.pts || [];
      ctx.lastHotGrid = r.grid;
      if (hotPts.length > 0) pts = hotPts;
      else {
        pts = ptsBeforeHot;
        hotInfo = " (keine Hotspots bei aktueller Rastergroesse/Schwelle)";
      }
    }

    if (ctx.showCluster) {
      const clusterLayer = L.markerClusterGroup({
        chunkedLoading: true,
        chunkInterval: 250,
        spiderfyOnMaxZoom: true,
        zoomToBoundsOnClick: false,
        showCoverageOnHover: false
      });

      for (const p of pts) {
        const m = L.circleMarker([p.lat, p.lon], { radius: 4 });
        m._uaProps = p.props || {};
        m._uaPoint = p;
        clusterLayer.addLayer(m);
      }

      clusterLayer.addTo(ctx.map);
      ctx.clusterLayer = clusterLayer;
    }

    if (ctx.showHeatmap) {
      const r = Math.max(5, Math.min(60, parseInt(ctx.ui.heatRadiusEl.value || "25", 10)));
      const heatPts = pts.map(p => {
        const k = String(p.props?.ukategorie || "");
        const w = (k === "1") ? 1.0 : (k === "2") ? 0.7 : (k === "3") ? 0.4 : 0.5;
        return [p.lat, p.lon, w];
      });
      ctx.heatLayer = L.heatLayer(heatPts, { radius: r, blur: 18, maxZoom: 17 }).addTo(ctx.map);
    }

    const statEl = ctx.ui.statEl;
    statEl.textContent =
      `Stadt: ${ctx.CITY_RAW} | geladen: ${(ctx.allPts?.length||0).toLocaleString()} | nach Filtern: ${(ctx.filteredCapped?.length||0).toLocaleString()} (uncapped: ${(ctx.filteredAll?.length||0).toLocaleString()}) | im Viewport: ${(ctx.viewportPts?.length||0).toLocaleString()}` +
      (ctx.selectionBounds ? " | Markierung: aktiv" : "") +
      (hotInfo ? ` | ${hotInfo}` : "");
  };

})();