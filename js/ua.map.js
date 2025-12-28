(() => {
  const UA = (window.UA = window.UA || {});

  // ============================================================
  // Cluster Popup
  // ============================================================
  UA.bindClusterPopup = function bindClusterPopup(ctx, clusterLayer) {
    if (!clusterLayer || clusterLayer.__uaPopupBound) return;
    clusterLayer.__uaPopupBound = true;

    const esc = (s) =>
      (UA.escHtml
        ? UA.escHtml(s)
        : String(s ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;"));

    const fmtPct = (x) => ((x * 100).toFixed(1)).replace(".", ",") + " %";

    const DEFAULT_COMBO_LABEL = {
      1: "🚲",
      2: "🚶",
      4: "🚗",
      8: "🏍️",
      3: "🚲+🚶",
      5: "🚲+🚗",
      6: "🚗+🚶",
      7: "🚲+🚗+🚶",
      9: "🚲+🏍️",
      10: "🚶+🏍️",
      12: "🚗+🏍️",
      11: "🚲+🚶+🏍️",
      13: "🚲+🚗+🏍️",
      14: "🚶+🚗+🏍️",
      15: "🚲+🚶+🚗+🏍️",
    };

    const labelForMask = (m) =>
      (UA.COMBO_LABEL || DEFAULT_COMBO_LABEL)[m] || "Mask " + m;

    const maskFromProps = (pr) =>
      UA.maskFromProps ? UA.maskFromProps(pr) : 0;

    function computeClusterCounts(markers) {
      const lc = { total: 0, byMask: {} };
      for (const mk of markers) {
        const pr = mk._uaProps || mk.feature?.properties || {};
        const m = maskFromProps(pr);
        if (!m) continue;
        lc.total++;
        lc.byMask[m] = (lc.byMask[m] || 0) + 1;
      }
      return lc;
    }

    function sortedMasks(byMask) {
      return Object.entries(byMask || {})
        .map(([m, c]) => ({ m: Number(m), c }))
        .sort((a, b) => b.c - a.c);
    }

    function buildPopupHtml(lc, ev) {
      const z = ctx.map.getZoom();

      // Übersicht → bewusst vereinfachen
      if (z <= 13) {
        const b = ev.layer.getBounds();
        const sw = b.getSouthWest();
        const ne = b.getNorthEast();

        return `
          <div style="font:13px/1.35 system-ui; min-width:240px;">
            <div style="font-weight:900;">Cluster (Übersicht)</div>
            <div style="margin:6px 0;">
              ${lc.total} Unfälle – für Detailanalyse bitte näher zoomen.
            </div>
            <button style="padding:6px 10px;border-radius:10px;font-weight:800"
              onclick="uaZoomToBounds(${sw.lat},${sw.lng},${ne.lat},${ne.lng})">
              🔍 Zoom auf Cluster
            </button>
          </div>`;
      }

      const top = sortedMasks(lc.byMask).slice(0, 6);

      let html = `
        <div style="font:13px/1.35 system-ui; min-width:240px;">
        <div style="font-weight:900;">Cluster-Analyse</div>
        <div>${lc.total} Unfälle</div>
        <table style="width:100%;font-size:12px;margin-top:6px">
          <tr><th align="left">Muster</th><th align="right">Anzahl</th><th align="right">Anteil</th></tr>`;

      for (const x of top) {
        html += `
          <tr>
            <td>${esc(labelForMask(x.m))}</td>
            <td align="right">${x.c}</td>
            <td align="right">${fmtPct(x.c / lc.total)}</td>
          </tr>`;
      }

      html += `</table></div>`;
      return html;
    }

    clusterLayer.on("clusterclick", (ev) => {
      if (ev.originalEvent) L.DomEvent.stop(ev.originalEvent);
      const markers = ev.layer.getAllChildMarkers();
      const lc = computeClusterCounts(markers);
      ev.layer.bindPopup(buildPopupHtml(lc, ev), { maxWidth: 360 }).openPopup();
    });
  };

  // ============================================================
  // Leaflet Init
  // ============================================================
  UA.initLeaflet = function initLeaflet(ctx) {
    const map = L.map("map", { preferCanvas: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap-Mitwirkende",
    }).addTo(map);

    map.setView([52.3759, 9.732], 12);
    ctx.map = map;

    ctx.drawnItems = new L.FeatureGroup().addTo(map);
  };

  // ============================================================
  // Zoom-adaptive Parameter
  // ============================================================
  UA.clusterRadiusForZoom = function (z) {
    if (z <= 11) return 90;
    if (z <= 13) return 60;
    if (z <= 15) return 40;
    if (z <= 17) return 26;
    return 18; // Zoom 18–19 → identische Punkte bleiben Cluster
  };

  UA.heatOpacityForZoom = function (z) {
    if (z <= 12) return 0.65;
    if (z <= 14) return 0.50;
    if (z <= 16) return 0.35;
    if (z <= 18) return 0.25;
    return 0.20; // NIE 0
  };

  UA.heatRadiusForZoom = function (z, base) {
    base = Math.max(5, Math.min(60, Number(base) || 25));
    if (z <= 12) return base * 1.4;
    if (z <= 15) return base * 1.1;
    if (z <= 17) return base * 0.9;
    return base * 0.75;
  };

  UA.heatBlurForZoom = function (z) {
    if (z <= 13) return 20;
    if (z <= 16) return 16;
    return 12;
  };

  // ============================================================
  // Render
  // ============================================================
  UA.renderLayers = function renderLayers(ctx) {
    if (ctx.clusterLayer) ctx.clusterLayer.remove();
    if (ctx.heatLayer) ctx.heatLayer.remove();

    let pts = ctx.viewportPts || [];

    // Heatmap zuerst (Hintergrund!)
    if (ctx.showHeatmap) {
      const z = ctx.map.getZoom();
      const r = UA.heatRadiusForZoom(z, ctx.ui.heatRadiusEl.value);
      const o = UA.heatOpacityForZoom(z);
      const b = UA.heatBlurForZoom(z);

      ctx.heatLayer = L.heatLayer(
        pts.map((p) => {
          const k = String(p.props?.ukategorie || "");
          const w = k === "1" ? 1 : k === "2" ? 0.7 : 0.4;
          return [p.lat, p.lon, w];
        }),
        { radius: r, blur: b, opacity: o }
      ).addTo(ctx.map);
    }

    // Cluster darüber
    if (ctx.showCluster) {
      const cl = L.markerClusterGroup({
        maxClusterRadius: (z) => UA.clusterRadiusForZoom(z),
        disableClusteringAtZoom: 99,
        zoomToBoundsOnClick: false,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
      });

      for (const p of pts) {
        const m = L.circleMarker([p.lat, p.lon], { radius: 4 });
        m._uaProps = p.props;
        cl.addLayer(m);
      }

      cl.addTo(ctx.map);
      UA.bindClusterPopup(ctx, cl);
      ctx.clusterLayer = cl;
    }
  };
})();