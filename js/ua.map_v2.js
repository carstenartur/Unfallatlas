(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // Severity colors for accident markers
  // ----------------------------
  const SEVERITY_COLORS = {
    "1": "#e31a1c",  // Red for fatalities (Getötete)
    "2": "#ff7f00",  // Orange for serious injuries (Schwerverletzte)
    "3": "#ffff33",  // Yellow for minor injuries (Leichtverletzte)
    "default": "#999999"  // Gray for unknown
  };

  // Argumentationsansicht: Ring-Farbe und Standardradius (in Metern).
  // Bewusst kontraststark, druckfest – ein Bezirksverordneter soll in
  // <10 s sehen, wo das Problem liegt.
  const ARG_HOTSPOT_RING = "#d62728";
  const ARG_HOTSPOT_FILL = "#d62728";
  const ARG_HOTSPOT_RADIUS_M = 80;

  // ----------------------------
  // Argumentationsansicht – Top-N Hotspots ermitteln (Task 2)
  // ----------------------------
  // Reines Datenhelfer ohne Leaflet-Abhängigkeit: nimmt Punkte und eine
  // optionale `cellKeyFn(point) -> "cx:cy"` (im Browser via Leaflet
  // map.project bereitgestellt) und liefert die K Zellen mit den meisten
  // Unfällen inklusive Schwerpunkt-Lat/Lon und dominantem Beteiligungs-Mask.
  // Ohne `cellKeyFn` fällt der Helfer auf ein grobes Lat/Lon-Bin (~55 m bei
  // 52° N) zurück, damit Tests ohne Map laufen können.
  UA.computeTopHotspots = function computeTopHotspots(points, options) {
    const opts = options || {};
    const k = Math.max(1, Math.min(10, Number(opts.k) || 3));
    const minTotal = Math.max(1, Number(opts.minTotal) || 2);
    const cellKeyFn = typeof opts.cellKeyFn === "function" ? opts.cellKeyFn : null;
    const fallbackKey = (p) => {
      // ~0.0005° ≈ 55 m bei 52° N – ausreichend für Tests / Fallback.
      const cy = Math.floor((p.lat || 0) / 0.0005);
      const cx = Math.floor((p.lon || 0) / 0.0005);
      return cx + ":" + cy;
    };
    const keyFn = cellKeyFn || fallbackKey;
    const maskFn = (p) => {
      if (UA.maskFromProps) return UA.maskFromProps(p && p.props);
      return 0;
    };

    const cells = new Map(); // key -> {total, byMask, latSum, lonSum}
    if (!Array.isArray(points)) return [];
    for (const p of points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      const key = keyFn(p);
      let c = cells.get(key);
      if (!c) {
        c = { key, total: 0, byMask: {}, latSum: 0, lonSum: 0 };
        cells.set(key, c);
      }
      c.total++;
      c.latSum += p.lat;
      c.lonSum += p.lon;
      const m = maskFn(p);
      if (m) c.byMask[m] = (c.byMask[m] || 0) + 1;
    }

    const ranked = [];
    for (const c of cells.values()) {
      if (c.total < minTotal) continue;
      // Dominanter Beteiligungs-Mask (für Tooltip & Konsistenz mit dem Antragstext).
      let dominantMask = 0;
      let dominantCount = 0;
      for (const [m, cnt] of Object.entries(c.byMask)) {
        if (cnt > dominantCount) { dominantMask = Number(m); dominantCount = cnt; }
      }
      ranked.push({
        key: c.key,
        total: c.total,
        lat: c.latSum / c.total,
        lon: c.lonSum / c.total,
        dominantMask,
        dominantCount
      });
    }
    // Sortierung: Anzahl absteigend; Tie-Break über Schlüssel für Determinismus.
    ranked.sort((a, b) => (b.total - a.total) || String(a.key).localeCompare(String(b.key)));
    return ranked.slice(0, k);
  };

  // ----------------------------
  // Argumentationsansicht – Overlay (Task 2)
  // ----------------------------
  // Hebt die Top-1..3 Hotspots mit kontraststarken Ringen und nummerierten
  // Badges hervor; Tooltip zeigt Anzahl + dominantes Beteiligungsmuster, damit
  // die Karte sichtbar dasselbe Cluster benennt, das auch im Antragstext
  // (KURZBEWERTUNG / mapReferences) erwähnt wird.
  UA.renderArgumentationOverlay = function renderArgumentationOverlay(ctx) {
    if (ctx.argumentationLayer) {
      try { ctx.argumentationLayer.remove(); } catch {}
      ctx.argumentationLayer = null;
    }
    if (!ctx.showArgumentation) return;
    const map = ctx.map;
    if (!map || !window.L) return;
    const pts = ctx.viewportPts || [];
    if (pts.length < 3) return; // Bei sehr wenigen Punkten kein "Hotspot" sinnvoll.

    // Auf Leaflet-projizierte Pixel-Zellen aufsetzen, damit die Zell­größe
    // sich konsistent mit dem bereits bestehenden Hotspot-Raster verhält.
    let cellKeyFn = null;
    try {
      UA.updateHotspotCellPx(ctx);
      const z = map.getZoom();
      const px = (UA.HOTSPOT && UA.HOTSPOT.cellPx) || 110;
      cellKeyFn = (p) => {
        const pt = map.project(L.latLng(p.lat, p.lon), z);
        return Math.floor(pt.x / px) + ":" + Math.floor(pt.y / px);
      };
    } catch {
      cellKeyFn = null; // Fallback im Helper greift.
    }

    // Mindest-Schwelle: skaliert mit der Datenmenge, damit auf großen
    // Auswahlen ein Hotspot wirklich aussagekräftig ist (nicht jedes
    // einzelne Häufchen).
    const minTotal = Math.max(3, Math.round(pts.length * 0.04));
    const top = UA.computeTopHotspots(pts, { k: 3, minTotal, cellKeyFn });
    if (!top.length) return;

    const labelForMask = (m) => {
      if (UA.formatInvolvementCombo) return UA.formatInvolvementCombo(m, { format: "text" });
      return m ? "Mask " + m : "k. A.";
    };

    const layer = L.featureGroup();
    let rank = 1;
    for (const h of top) {
      // Großer, halbtransparenter Ring – druckfest und auch ohne Hover sichtbar.
      const ring = L.circle([h.lat, h.lon], {
        radius: ARG_HOTSPOT_RADIUS_M,
        color: ARG_HOTSPOT_RING,
        weight: 3,
        opacity: 0.95,
        fillColor: ARG_HOTSPOT_FILL,
        fillOpacity: 0.08,
        interactive: true
      });
      const tooltipText = `Hotspot ${rank}: ${h.total} Unfälle` +
        (h.dominantCount > 0 ? ` · dominantes Muster: ${labelForMask(h.dominantMask)} (${h.dominantCount})` : "");
      ring.bindTooltip(tooltipText, { direction: "top", sticky: true });
      ring.bindPopup(
        `<div style="font:13px/1.35 system-ui; min-width:200px;">` +
        `<div style="font-weight:900; margin-bottom:4px;">Hotspot ${rank}</div>` +
        `<div>Unfälle im Cluster: <strong>${h.total}</strong></div>` +
        (h.dominantCount > 0
          ? `<div>Dominantes Muster: <strong>${labelForMask(h.dominantMask)}</strong> (${h.dominantCount})</div>`
          : "") +
        `</div>`
      );
      layer.addLayer(ring);

      // Nummern-Badge als divIcon, damit auch im PDF-Snapshot eindeutig.
      const badge = L.marker([h.lat, h.lon], {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: "ua-arg-badge",
          html: `<div style="background:${ARG_HOTSPOT_RING};color:#fff;` +
                `font:900 13px/1 system-ui;width:22px;height:22px;border-radius:50%;` +
                `display:flex;align-items:center;justify-content:center;` +
                `border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,0.4);">` +
                `${rank}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        })
      });
      layer.addLayer(badge);
      rank++;
    }

    layer.addTo(map);
    ctx.argumentationLayer = layer;
  };

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

    const DEFAULT_COMBO_LABEL = {};
    (function() {
      const bits = [[1,"🚲"],[2,"🚶"],[4,"🚗"],[8,"🏍️"],[16,"🚛"],[32,"🚌"]];
      for (let m = 1; m <= 63; m++) {
        DEFAULT_COMBO_LABEL[m] = bits.filter(([b]) => m & b).map(([,e]) => e).join("+");
      }
    })();

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
      const isGkfz = String(pr?.istgkfz) === "1";
      const isSon = String(pr?.istsonstig) === "1";
      return (isBike ? 1 : 0) | (isPed ? 2 : 0) | (isCar ? 4 : 0) | (isMoto ? 8 : 0) | (isGkfz ? 16 : 0) | (isSon ? 32 : 0);
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
    window._uaMap = map;  // expose for E2E tests / debugging

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

    // Add layer legend control
    UA.addLayerLegend(ctx, map);
  };

  // ----------------------------
  // Layer Legend Control (bottom right)
  // ----------------------------
  UA.addLayerLegend = function addLayerLegend(ctx, map) {
    const LayerLegend = L.Control.extend({
      options: {
        position: 'bottomright'
      },

      onAdd: function(map) {
        const container = L.DomUtil.create('div', 'layer-legend-control');
        
        // Prevent map interactions when clicking on legend
        L.DomEvent.disableClickPropagation(container);
        L.DomEvent.disableScrollPropagation(container);

        // Use existing layer states from ctx (initialized in ua.app_v2.js)
        // Default to true if not set
        if (ctx.showSchools === undefined) ctx.showSchools = true;
        if (ctx.showKindergartens === undefined) ctx.showKindergartens = true;
        if (ctx.showCluster === undefined) ctx.showCluster = true;
        if (ctx.showHeatmap === undefined) ctx.showHeatmap = true;
        if (ctx.showArgumentation === undefined) ctx.showArgumentation = true;

        // Create legend items
        const items = [
          { id: 'argumentation', icon: '🎯', label: 'Argumentation (Top-Hotspots)', stateKey: 'showArgumentation' },
          { id: 'schools', icon: '🏫', label: 'Schulen', stateKey: 'showSchools' },
          { id: 'kindergartens', icon: '👶', label: 'Kindergärten', stateKey: 'showKindergartens' },
          { id: 'cluster', icon: '📍', label: 'Cluster', stateKey: 'showCluster' },
          { id: 'heatmap', icon: '🔥', label: 'Heatmap', stateKey: 'showHeatmap' }
        ];

        items.forEach(item => {
          const cls = ctx[item.stateKey] ? 'legend-item active' : 'legend-item';
          const btn = L.DomUtil.create('button', cls, container);
          btn.innerHTML = `<span class="legend-icon">${item.icon}</span>`;
          btn.title = item.label;
          btn.setAttribute('aria-label', item.label);
          btn.setAttribute('data-layer', item.id);

          btn.onclick = function(e) {
            e.preventDefault();
            e.stopPropagation();

            // Toggle state
            ctx[item.stateKey] = !ctx[item.stateKey];

            // Update button appearance
            if (ctx[item.stateKey]) {
              btn.classList.add('active');
            } else {
              btn.classList.remove('active');
            }

            // Sync panel buttons if they exist
            if (item.stateKey === 'showCluster' && ctx.ui?.btnCluster) {
              UA.setBtnState(ctx.ui.btnCluster, ctx[item.stateKey]);
            }
            if (item.stateKey === 'showHeatmap' && ctx.ui?.btnHeat) {
              UA.setBtnState(ctx.ui.btnHeat, ctx[item.stateKey]);
            }

            // Rebuild layers to reflect changes
            ctx._dataChanged = true;
            UA.syncAllToUrl(ctx);
            UA.renderLayers(ctx);
          };
        });

        return container;
      }
    });

    map.addControl(new LayerLegend());
  };

  // Sync legend button CSS classes from ctx state
  // Call after bindUi (URL restore) or after panel button toggles
  UA.syncLegendButtons = function syncLegendButtons(ctx) {
    const mapping = {
      showSchools: 'schools',
      showKindergartens: 'kindergartens',
      showCluster: 'cluster',
      showHeatmap: 'heatmap',
      showArgumentation: 'argumentation'
    };
    for (const [stateKey, layerId] of Object.entries(mapping)) {
      const btn = document.querySelector(`.layer-legend-control button[data-layer="${layerId}"]`);
      if (btn) {
        btn.classList.toggle('active', !!ctx[stateKey]);
      }
    }
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
    if (z === 17) return 50;
    if (z === 18) return 30; // Smaller radius at high zoom for better visibility
    return 20; // z >= 19: individual accidents should be clearly visible
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
    // Layer caching: rebuild on zoom change or data change
    const currentZoom = ctx.map.getZoom();
    const shouldRebuildCluster = !ctx.clusterLayer || ctx._lastClusterZoom !== currentZoom || ctx._dataChanged;
    const shouldRebuildHeat = !ctx.heatLayer || ctx._lastHeatZoom !== currentZoom || ctx._dataChanged;
    
    if ((shouldRebuildCluster || !ctx.showCluster) && ctx.clusterLayer) {
      ctx.clusterLayer.remove();
      ctx.clusterLayer = null;
    }
    if ((shouldRebuildHeat || !ctx.showHeatmap) && ctx.heatLayer) {
      ctx.heatLayer.remove();
      ctx.heatLayer = null;
    }
    if (ctx.poiLayer) {
      ctx.poiLayer.remove();
      ctx.poiLayer = null;
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

    // ---- Cluster (zoom-adaptiv, but only rebuild when needed)
    if (ctx.showCluster && shouldRebuildCluster) {
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

      // Batch operation: create all markers first, then add them all at once
      const markers = pts.map(p => {
        const ukategorie = String(p.props?.ukategorie || "");
        const color = SEVERITY_COLORS[ukategorie] || SEVERITY_COLORS["default"];
        const m = L.circleMarker([p.lat, p.lon], { 
          radius: 4,
          fillColor: color,
          color: color,
          weight: 1,
          opacity: 0.8,
          fillOpacity: 0.6
        });
        m._uaProps = p.props || {};
        m._uaPoint = p;
        return m;
      });
      
      // Use batch add for better performance
      if (markers.length > 0) {
        clusterLayer.addLayers(markers);
      }

      clusterLayer.addTo(ctx.map);
      UA.bindClusterPopup(ctx, clusterLayer);
      ctx.clusterLayer = clusterLayer;
      ctx._lastClusterZoom = currentZoom;
    }

    // ---- Heatmap (zoom-adaptiv + opacity per Canvas, only rebuild when needed)
    if (ctx.showHeatmap && shouldRebuildHeat) {
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
      ctx._lastHeatZoom = currentZoom;
    }

    // ---- POI Layer (schools, kindergartens)
    UA.renderPOILayer(ctx);

    // ---- Argumentationsansicht: Top-Hotspots hervorheben (Task 2).
    // Wird *nach* Cluster/Heatmap gerendert, damit die Ringe oben liegen.
    UA.renderArgumentationOverlay(ctx);

    // Update stats and store hotInfo in context
    ctx._lastHotInfo = hotInfo;
    UA.updateStats(ctx, hotInfo);
    
    // Reset data changed flag
    ctx._dataChanged = false;
  };
  
  // Separate stats update function for pan-only updates
  UA.updateStats = function updateStats(ctx, hotInfo) {
    // Use stored hotInfo if not provided (e.g., during pan-only updates)
    if (hotInfo === undefined) {
      hotInfo = ctx._lastHotInfo || "";
    }
    const statEl = ctx.ui.statEl;
    statEl.textContent =
      `Stadt: ${ctx.CITY_RAW} | geladen: ${(ctx.allPts?.length || 0).toLocaleString()} | ` +
      `nach Filtern: ${(ctx.filteredCapped?.length || 0).toLocaleString()} (uncapped: ${(ctx.filteredAll?.length || 0).toLocaleString()}) | ` +
      `im Viewport: ${(ctx.viewportPts?.length || 0).toLocaleString()}` +
      (ctx.selectionBounds ? " | Markierung: aktiv" : "") +
      (hotInfo ? ` | ${hotInfo}` : "");
  };

  // ----------------------------
  // POI Layer Rendering
  // ----------------------------
  UA.renderPOILayer = function renderPOILayer(ctx) {
    if (!ctx.poiData || !ctx.poiData.features) return;
    if (!ctx.showSchools && !ctx.showKindergartens) return;

    const z = ctx.map.getZoom();
    // Only show POIs at zoom level 14 and higher
    if (z < 14) return;

    // Get viewport bounds for filtering
    const bounds = ctx.map.getBounds();
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();

    const poiLayer = L.featureGroup();

    // Create custom icons for different POI types
    const schoolIcon = L.divIcon({
      html: '<div style="background-color:#2E86C1; color:white; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; border:2px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.3);">🏫</div>',
      className: 'poi-icon',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12]
    });

    const kindergartenIcon = L.divIcon({
      html: '<div style="background-color:#27AE60; color:white; width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:bold; border:2px solid white; box-shadow:0 2px 4px rgba(0,0,0,0.3);">🧒</div>',
      className: 'poi-icon',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12]
    });

    for (const feature of ctx.poiData.features) {
      if (!feature.geometry || feature.geometry.type !== "Point") continue;

      const coords = feature.geometry.coordinates;
      if (!Array.isArray(coords) || coords.length !== 2) continue;

      const [lon, lat] = coords;
      if (typeof lon !== "number" || typeof lat !== "number" || !isFinite(lon) || !isFinite(lat)) continue;
      
      // Viewport filtering for better performance
      if (lat < south || lat > north || lon < west || lon > east) continue;
      
      const props = feature.properties || {};
      const type = props.type || "unknown";
      const name = props.name || "Unbenannt";

      // Check if this POI type should be shown
      if (type === "school" && !ctx.showSchools) continue;
      if (type === "kindergarten" && !ctx.showKindergartens) continue;

      // Select icon based on type
      let icon = kindergartenIcon;
      if (type === "school") {
        icon = schoolIcon;
      }

      const marker = L.marker([lat, lon], { icon });
      
      // Create popup with POI information
      const popupContent = `
        <div style="font:13px/1.35 system-ui; min-width:200px;">
          <div style="font-weight:900; margin-bottom:4px;">${type === "school" ? "Schule" : "Kindergarten"}</div>
          <div style="color:#444;">${UA.escHtml(name)}</div>
        </div>
      `;
      marker.bindPopup(popupContent);

      poiLayer.addLayer(marker);
    }

    poiLayer.addTo(ctx.map);
    ctx.poiLayer = poiLayer;
  };
})();