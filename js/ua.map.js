(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // Cluster Popup (mit "zu grob, bitte reinzoomen" bei kleinen Zoomstufen)
  // ----------------------------
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

    const labelForMask = (m) => {
      const map = UA.COMBO_LABEL || UA.COMBO_LABELS || DEFAULT_COMBO_LABEL;
      return map[m] || "Mask " + m;
    };

    const maskFromProps = (pr) => {
      if (UA.maskFromProps) return UA.maskFromProps(pr);
      const isBike = String(pr?.istrad) === "1";
      const isPed = String(pr?.istfuss) === "1";
      const isCar = String(pr?.istpkw) === "1";
      const isMoto = String(pr?.istkrad) === "1";
      return (isBike ? 1 : 0) | (isPed ? 2 : 0) | (isCar ? 4 : 0) | (isMoto ? 8 : 0);
    };

    function computeClusterCounts(markers) {
      const lc = { total: 0, byMask: {} };
      for (const mk of markers) {
        const pr =
          mk._uaProps ||
          mk.__uaProps ||
          (mk.options ? mk.options.__uaProps : null) ||
          mk.feature?.properties ||
          {};
        const m = maskFromProps(pr);
        if (!m) continue;
        lc.total++;
        lc.byMask[m] = (lc.byMask[m] || 0) + 1;
      }
      return lc;
    }

    function sortedMasks(byMask) {
      return Object.entries(byMask || {})
        .map(([m, c]) => ({ m: Number(m), c: Number(c) || 0 }))
        .filter((x) => x.c > 0)
        .sort((a, b) => b.c - a.c);
    }

    function buildPopupHtml(lc, ev) {
      const z = ctx.map ? ctx.map.getZoom() : 0;

      // Bei weitem Zoom: bewusst degradieren (Cluster ist "Stadtteil-Klumpen")
      if (z <= 13) {
        const b = ev?.layer?.getBounds?.();
        const sw = b?.getSouthWest?.();
        const ne = b?.getNorthEast?.();

        let html =
          `<div style="font:13px/1.35 system-ui; min-width:240px;">` +
          `<div style="font-weight:900; margin-bottom:6px;">Cluster (Übersicht)</div>` +
          `<div style="color:#444; margin-bottom:8px;">` +
          `Zoom <strong>${z}</strong>: Dieser Cluster umfasst sehr viele Straßen/Strukturen. ` +
          `Für eine belastbare Analyse bitte näher heranzoomen.</div>` +
          `<div style="color:#444; margin-bottom:8px;">Cluster: <strong>${lc.total}</strong> Unfälle</div>`;

        if (sw && ne) {
          html +=
            `<div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">` +
            `<button type="button" style="padding:6px 10px; border:1px solid #ddd; border-radius:10px; background:#fff; font-weight:800; cursor:pointer;" ` +
            `onclick="uaZoomToBounds(${sw.lat},${sw.lng},${ne.lat},${ne.lng})">🔍 Zoom auf Cluster</button>` +
            `</div>`;
        }

        html += `</div>`;
        return html;
      }

      // Nah genug: Muster/Verteilung anzeigen
      const topMasks = sortedMasks(lc.byMask).slice(0, 6);

      const baseline = ctx.baselineCounts;
      let devRows = [];
      if (baseline && baseline.total && baseline.byMask && lc.total) {
        devRows = topMasks
          .map((x) => {
            const baseCnt = Number(baseline.byMask[x.m] || 0);
            const locR = x.c / lc.total;
            const baseR = baseline.total ? baseCnt / baseline.total : 0;
            const f = baseR > 0 ? locR / baseR : null;
            return { ...x, locR, baseR, f };
          })
          .sort((a, b) => (b.f ?? -1) - (a.f ?? -1));
      }

      let html =
        `<div style="font:13px/1.35 system-ui; min-width:240px;">` +
        `<div style="font-weight:900; margin-bottom:6px;">Cluster-Analyse</div>` +
        `<div style="color:#444; margin-bottom:6px;">Cluster: <strong>${lc.total}</strong> Unfälle</div>`;

      if (!topMasks.length) {
        html += `<div style="color:#666;">Keine auswertbaren Unfallklassen im Cluster.</div></div>`;
        return html;
      }

      html += `<div style="font-weight:800; margin:6px 0 4px;">Top-Klassen im Cluster</div>`;
      html +=
        `<table style="width:100%; border-collapse:collapse; font-size:12px;">` +
        `<tr style="border-bottom:1px solid rgba(0,0,0,.15);">` +
        `<th style="text-align:left;">Muster</th>` +
        `<th style="text-align:right;">Anzahl</th>` +
        `<th style="text-align:right;">Anteil</th>` +
        `</tr>`;

      for (const x of topMasks) {
        html +=
          `<tr style="border-bottom:1px solid rgba(0,0,0,.06);">` +
          `<td>${esc(labelForMask(x.m))}</td>` +
          `<td style="text-align:right;">${x.c}</td>` +
          `<td style="text-align:right;">${fmtPct(x.c / lc.total)}</td>` +
          `</tr>`;
      }
      html += `</table>`;

      if (devRows.length) {
        const topDev = devRows.slice(0, 5);
        html += `<div style="font-weight:800; margin:10px 0 4px;">Vergleich vs. Stadt (Baseline)</div>`;
        html +=
          `<table style="width:100%; border-collapse:collapse; font-size:12px;">` +
          `<tr style="border-bottom:1px solid rgba(0,0,0,.15);">` +
          `<th style="text-align:left;">Muster</th>` +
          `<th style="text-align:right;">Cluster</th>` +
          `<th style="text-align:right;">Stadt</th>` +
          `<th style="text-align:right;">Faktor</th>` +
          `</tr>`;

        for (const r of topDev) {
          html +=
            `<tr style="border-bottom:1px solid rgba(0,0,0,.06);">` +
            `<td>${esc(labelForMask(r.m))}</td>` +
            `<td style="text-align:right;">${fmtPct(r.locR)}</td>` +
            `<td style="text-align:right;">${fmtPct(r.baseR)}</td>` +
            `<td style="text-align:right; font-weight:800;">${r.f == null ? "—" : r.f.toFixed(2) + "×"}</td>` +
            `</tr>`;
        }

        html += `</table>`;
        html +=
          `<div style="margin-top:6px; color:#666; font-size:11px;">` +
          `Hinweis: Baseline basiert auf Nicht-Beteiligungs-Filtern (Schwere/Zeit/Zustand), sofern ctx.baselineCounts so berechnet wird.` +
          `</div>`;
      }

      // Zoom-Button auch hier
      const b = ev?.layer?.getBounds?.();
      const sw = b?.getSouthWest?.();
      const ne = b?.getNorthEast?.();
      if (sw && ne) {
        html +=
          `<div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap;">` +
          `<button type="button" style="padding:6px 10px; border:1px solid #ddd; border-radius:10px; background:#fff; font-weight:800; cursor:pointer;" ` +
          `onclick="uaZoomToBounds(${sw.lat},${sw.lng},${ne.lat},${ne.lng})">🔍 Zoom auf Cluster</button>` +
          `</div>`;
      }

      html += `</div>`;
      return html;
    }

    clusterLayer.on("clusterclick", (ev) => {
      try {
        if (ev?.originalEvent) L.DomEvent.stop(ev.originalEvent);
      } catch {}

      try {
        const markers = ev.layer.getAllChildMarkers ? ev.layer.getAllChildMarkers() : [];
        const lc = computeClusterCounts(markers);
        const html = buildPopupHtml(lc, ev);
        ev.layer.bindPopup(html, { maxWidth: 360 }).openPopup();
      } catch (e) {
        console.warn("Cluster popup failed:", e);
      }
    });
  };

  // ----------------------------
  // Leaflet init
  // ----------------------------
  UA.initLeaflet = function initLeaflet(ctx) {
    if (!window.L) throw new Error("Leaflet fehlt.");

    const map = L.map("map", { preferCanvas: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap-Mitwirkende",
    }).addTo(map);

    map.setView([52.3759, 9.732], 12);
    ctx.map = map;

    // draw layer
    ctx.drawnItems = new L.FeatureGroup().addTo(map);
    ctx.selectionBounds = null;

    const drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polygon: false,
        polyline: false,
        circle: false,
        marker: false,
        circlemarker: false,
        rectangle: { shapeOptions: { color: "#2b7cff", weight: 2 } },
      },
      edit: { featureGroup: ctx.drawnItems, edit: false, remove: false },
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
    window.uaZoomToBounds = function (s, w, n, e) {
      try {
        map.fitBounds(
          [
            [s, w],
            [n, e],
          ],
          { padding: [20, 20] }
        );
      } catch (err) {
        console.warn(err);
      }
    };
  };

  UA.fitToAllPoints = function fitToAllPoints(ctx) {
    const points = ctx.allPts || [];
    if (!points.length) return;

    let minLat = 90,
      maxLat = -90,
      minLon = 180,
      maxLon = -180;

    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
    ctx.map.fitBounds(L.latLngBounds([minLat, minLon], [maxLat, maxLon]), { padding: [20, 20] });
  };

  // ----------------------------
  // Zoom-adaptive Cluster/Heatmap
  // ----------------------------

  // Weniger "Stadtteil-Klumpen" beim Zoom-out => kleiner Radius (weniger Agglomeration)
  UA.clusterRadiusForZoom = function clusterRadiusForZoom(z) {
    if (z <= 11) return 14;
    if (z === 12) return 18;
    if (z === 13) return 22;
    if (z === 14) return 28;
    if (z === 15) return 36;
    if (z === 16) return 46;
    return 60; // nah dran: Performance/Lesbarkeit
  };

  // Heatmap-Radius zoom-abhängig (UI-Wert ist "Basis")
  UA.heatRadiusForZoom = function heatRadiusForZoom(z, uiBase) {
    const base = Math.max(5, Math.min(60, Number(uiBase) || 25));
    if (z <= 11) return Math.max(5, Math.round(base * 0.45));
    if (z === 12) return Math.max(5, Math.round(base * 0.55));
    if (z === 13) return Math.max(6, Math.round(base * 0.70));
    if (z === 14) return Math.max(7, Math.round(base * 0.85));
    if (z === 15) return Math.max(8, Math.round(base * 1.00));
    if (z === 16) return Math.max(10, Math.round(base * 1.10));
    if (z === 17) return Math.max(12, Math.round(base * 1.20));
    return Math.max(14, Math.round(base * 1.30)); // sehr nah: etwas breiter, aber sehr transparent
  };

  // Heatmap-Transparenz: bei hohem Zoom stark durchsichtig, aber nie ganz weg
  UA.heatOpacityForZoom = function heatOpacityForZoom(z) {
    if (z <= 11) return 0.75;
    if (z === 12) return 0.65;
    if (z === 13) return 0.55;
    if (z === 14) return 0.40;
    if (z === 15) return 0.28;
    if (z === 16) return 0.20;
    if (z === 17) return 0.14;
    if (z === 18) return 0.10;
    return 0.08; // z>=19: sichtbar, aber Marker bleiben gut erkennbar
  };

  UA.heatBlurForZoom = function heatBlurForZoom(z) {
    if (z <= 12) return 20;
    if (z <= 14) return 18;
    if (z <= 16) return 14;
    return 10;
  };

  function applyHeatOpacity(layer, opacity) {
    // leaflet.heat rendert in eine Canvas: opacity per style setzen (Option "opacity" ist nicht zuverlässig)
    try {
      const c = layer && (layer._canvas || (layer._renderer && layer._renderer._container));
      if (c && c.style) c.style.opacity = String(opacity);
    } catch {}
  }

  UA.renderLayers = function renderLayers(ctx) {
    if (ctx.clusterLayer) {
      ctx.clusterLayer.remove();
      ctx.clusterLayer = null;
    }
    if (ctx.heatLayer) {
      ctx.heatLayer.remove();
      ctx.heatLayer = null;
    }

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
        hotInfo = " (keine Hotspots bei aktueller Rastergröße/Schwelle)";
      }
    }

    // ---- Cluster (zoom-adaptiv, aber NICHT bei Zoom 19 deaktivieren!)
    if (ctx.showCluster) {
      const clusterLayer = L.markerClusterGroup({
        chunkedLoading: true,
        chunkInterval: 250,
        spiderfyOnMaxZoom: true,
        zoomToBoundsOnClick: false,
        showCoverageOnHover: false,
        maxClusterRadius: (zoom) => UA.clusterRadiusForZoom(zoom),

        // WICHTIG: NICHT disableClusteringAtZoom: 18
        // Sonst gibt es bei Zoom 19 keine Cluster für Punkte gleicher Koordinate.
      });

      for (const p of pts) {
        const m = L.circleMarker([p.lat, p.lon], { radius: 4 });
        m._uaProps = p.props || {};
        m._uaPoint = p;
        clusterLayer.addLayer(m);
      }

      clusterLayer.addTo(ctx.map);
      UA.bindClusterPopup(ctx, clusterLayer);
      ctx.clusterLayer = clusterLayer;
    }

    // ---- Heatmap (zoom-adaptiv + opacity per Canvas)
    if (ctx.showHeatmap) {
      const z = ctx.map.getZoom();
      const uiBase = ctx.ui?.heatRadiusEl?.value ?? "25";

      const radius = UA.heatRadiusForZoom(z, uiBase);
      const blur = UA.heatBlurForZoom(z);
      const opacity = UA.heatOpacityForZoom(z);

      const heatPts = pts.map((p) => {
        const k = String(p.props?.ukategorie || "");
        const w = k === "1" ? 1.0 : k === "2" ? 0.7 : k === "3" ? 0.4 : 0.5;
        return [p.lat, p.lon, w];
      });

      ctx.heatLayer = L.heatLayer(heatPts, {
        radius,
        blur,
        maxZoom: 17,
      }).addTo(ctx.map);

      applyHeatOpacity(ctx.heatLayer, opacity);
    }

    const statEl = ctx.ui.statEl;
    statEl.textContent =
      `Stadt: ${ctx.CITY_RAW} | geladen: ${(ctx.allPts?.length || 0).toLocaleString()} | ` +
      `nach Filtern: ${(ctx.filteredCapped?.length || 0).toLocaleString()} (uncapped: ${(ctx.filteredAll?.length || 0).toLocaleString()}) | ` +
      `im Viewport: ${(ctx.viewportPts?.length || 0).toLocaleString()}` +
      (ctx.selectionBounds ? " | Markierung: aktiv" : "") +
      (hotInfo ? ` | ${hotInfo}` : "");
  };
})();