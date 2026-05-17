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
  // Ohne `cellKeyFn` fällt der Helfer auf ein grobes, ungewichtetes Lat/Lon-Bin
  // zurück (siehe `fallbackKey`), das nur für Tests / headless-Aufrufe gedacht
  // ist – im Browser wird immer `cellKeyFn` aus `renderArgumentationOverlay`
  // übergeben, der die echten Pixel-Zellen aus `HOTSPOT.cellPx` benutzt.
  UA.computeTopHotspots = function computeTopHotspots(points, options) {
    const opts = options || {};
    const k = Math.max(1, Math.min(10, Number(opts.k) || 3));
    const minTotal = Math.max(1, Number(opts.minTotal) || 2);
    const cellKeyFn = typeof opts.cellKeyFn === "function" ? opts.cellKeyFn : null;
    const fallbackKey = (p) => {
      // Quadrat in Grad-Einheiten – bewusst ungleich in Metern: bei 52° N
      // entspricht 0,0005° Latitude ≈ 56 m, 0,0005° Longitude ≈ 34 m. Das
      // reicht für Tests / Fallback (Cluster-Erkennung in einer Stadt), nicht
      // für produktive Hotspot-Analyse – dort liefert `renderArgumentationOverlay`
      // einen pixel-basierten `cellKeyFn`.
      const cy = Math.floor((p.lat || 0) / 0.0005);
      const cx = Math.floor((p.lon || 0) / 0.0005);
      return cx + ":" + cy;
    };
    const keyFn = cellKeyFn || fallbackKey;
    const maskFn = (p) => {
      if (UA.maskFromProps) return UA.maskFromProps(p && p.props);
      return 0;
    };

    // Pass 1: Aggregation ohne Per-Cell-Point-Sammlung. Für sehr große
    // Datensätze (z. B. mehrere Jahre Stadtdaten) würde das Speichern aller
    // Punkt-Referenzen pro Zelle den Speicherbedarf von O(#cells) auf
    // O(#points) heben — die Top-k-Hotspots, die downstream genutzt werden
    // (Cluster-Maps + Argumentation-Overlay), brauchen das aber nur für
    // wenige Zellen. Daher: erst Aggregate (total/bbox/dominantMask) und
    // anschließend in Pass 2 die Punkt-Listen nur für die gewinnenden
    // Schlüssel sammeln.
    const cells = new Map(); // key -> {total, byMask, latSum, lonSum, bbox}
    if (!Array.isArray(points)) return [];
    for (const p of points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      const key = keyFn(p);
      let c = cells.get(key);
      if (!c) {
        c = {
          key, total: 0, byMask: {}, latSum: 0, lonSum: 0,
          minLat: Infinity, maxLat: -Infinity,
          minLon: Infinity, maxLon: -Infinity
        };
        cells.set(key, c);
      }
      c.total++;
      c.latSum += p.lat;
      c.lonSum += p.lon;
      // Track per-cell bbox so downstream consumers (export cluster maps)
      // can fitBounds exactly — guaranteeing table↔map consistency
      // (Tasks 1, 4, 5, 7).
      if (p.lat < c.minLat) c.minLat = p.lat;
      if (p.lat > c.maxLat) c.maxLat = p.lat;
      if (p.lon < c.minLon) c.minLon = p.lon;
      if (p.lon > c.maxLon) c.maxLon = p.lon;
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
        dominantCount,
        bounds: {
          south: c.minLat,
          west: c.minLon,
          north: c.maxLat,
          east: c.maxLon
        }
        // points: filled in pass 2 below for top-k only.
      });
    }
    // Sortierung: Anzahl absteigend; Tie-Break über Schlüssel für Determinismus.
    ranked.sort((a, b) => (b.total - a.total) || String(a.key).localeCompare(String(b.key)));
    const topK = ranked.slice(0, k);

    // Pass 2: Punkt-Listen nur für die Top-k-Zellen sammeln. Die Export-
    // Cluster-Karten brauchen die Original-Punktreferenzen (`exportPoints`)
    // damit fitBounds + visibleN === total halten (siehe captureClusterMaps).
    if (topK.length > 0) {
      const wantedKeys = new Set(topK.map(c => c.key));
      const buckets = new Map();
      for (const k0 of wantedKeys) buckets.set(k0, []);
      for (const p of points) {
        if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
        const key = keyFn(p);
        const bucket = buckets.get(key);
        if (bucket) bucket.push(p);
      }
      for (const c of topK) c.points = buckets.get(c.key) || [];
    }
    return topK;
  };

  // Severity colors are also used by the export map overlay – expose them.
  UA.SEVERITY_COLORS = SEVERITY_COLORS;

  // ----------------------------
  // PDF/DOCX export – Kartenoptimierung
  // ----------------------------
  // Ziel (Aufgabenstellung):
  //   Im Export sollen einzelne Unfallorte deutlich erkennbar sein
  //   (Knotenpunkt vs. Korridor), nicht nur die Heatmap-Dichte. Wir
  //   ergänzen die Karte deshalb vor jeder Aufnahme um eine zusätzliche
  //   Schicht hochkontraster, severity-farbiger Punkte mit weißem Rand
  //   und reduzieren parallel die Heatmap-Deckkraft.
  // Wirkung ist bewusst auf den Export-Pfad beschränkt – die interaktive
  // Karte bleibt unverändert.
  // ----------------------------

  // Marker-Größen / -Stile für den Export. Bewusst nur leicht größer als
  // die interaktiven Marker (radius 4) – wir wollen Sichtbarkeit, aber
  // weder Überlappung verstärken noch die Karte „verstopfen" (Task 5/7).
  const EXPORT_MARKER_RADIUS = 6;
  const EXPORT_MARKER_BORDER = "#ffffff";
  const EXPORT_MARKER_BORDER_W = 1.5;
  const EXPORT_HEAT_OPACITY_MAX = 0.35;

  /**
   * Aktiviert den Export-Stil auf der Karte:
   *  - dimmt die Heatmap (CSS-Opacity ≤ 0.35), damit Punkte sichtbar bleiben.
   *  - überlagert die aktuellen Punkte (`ctx.viewportPts`) mit hochkontrast­
   *    farbigen Severity-Punkten (rot/orange/gelb, weißer Rand).
   * Liefert ein Token, das `endExportMapMode` zum Wiederherstellen braucht.
   * Idempotent: ein doppelter Aufruf legt keine zweite Overlay-Schicht an.
   *
   * @param {object} ctx
   * @param {object} [opts]
   * @param {Array}  [opts.points]   Override für die Punkte (Default: ctx.viewportPts)
   * @param {number} [opts.radius]   Override für den Marker-Radius (Default 6)
   * @returns {{layer:object|null, prevHeatOpacity:string|null, active:boolean}}
   */
  UA.beginExportMapMode = function beginExportMapMode(ctx, opts) {
    const token = { layer: null, prevHeatOpacity: null, active: false };
    if (!ctx || !ctx.map || typeof window === "undefined" || !window.L) return token;
    if (ctx._exportMapToken) return ctx._exportMapToken; // idempotent

    // 1) Heatmap dimmen (nur CSS – wird von leaflet-image via bake-helper im
    //    Report-Modul ohnehin in die Pixel gebrannt; wir setzen hier nur das
    //    sichtbare CSS, damit die Punkte auch beim Live-Capture nicht
    //    optisch überdeckt werden).
    if (ctx.heatLayer) {
      try {
        const c = ctx.heatLayer._canvas
          || (ctx.heatLayer._renderer && ctx.heatLayer._renderer._container);
        if (c && c.style) {
          token.prevHeatOpacity = c.style.opacity;
          const cur = parseFloat(c.style.opacity);
          if (!Number.isFinite(cur) || cur > EXPORT_HEAT_OPACITY_MAX) {
            c.style.opacity = String(EXPORT_HEAT_OPACITY_MAX);
          }
        }
      } catch { /* keep going – heatmap dimming is a nice-to-have */ }
    }

    // 2) Severity-Overlay aufbauen.
    const pts = (opts && Array.isArray(opts.points)) ? opts.points : (ctx.viewportPts || []);
    const radius = (opts && Number.isFinite(opts.radius)) ? opts.radius : EXPORT_MARKER_RADIUS;
    const layer = window.L.layerGroup();
    for (const p of pts) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      const k = String((p.props && p.props.ukategorie) || "");
      const fill = SEVERITY_COLORS[k] || SEVERITY_COLORS["default"];
      try {
        window.L.circleMarker([p.lat, p.lon], {
          radius,
          color: EXPORT_MARKER_BORDER,
          weight: EXPORT_MARKER_BORDER_W,
          opacity: 1.0,
          fillColor: fill,
          fillOpacity: 0.95,
          // Ohne Interaktion → leaflet-image rendert nur Geometrie.
          interactive: false
        }).addTo(layer);
      } catch { /* skip malformed point */ }
    }
    try { layer.addTo(ctx.map); } catch { /* tolerate stub maps in tests */ }
    token.layer = layer;
    token.active = true;
    ctx._exportMapToken = token;
    return token;
  };

  /**
   * Hebt den Export-Stil wieder auf. Sicher gegen doppelte Aufrufe und
   * gegen abgebrochene Begin-Pfade (token kann undefined/leer sein).
   */
  UA.endExportMapMode = function endExportMapMode(ctx, token) {
    if (!ctx) return;
    const t = token || ctx._exportMapToken;
    if (!t) return;
    if (t.layer) {
      try { t.layer.remove(); } catch { /* noop */ }
      t.layer = null;
    }
    if (ctx.heatLayer && t.prevHeatOpacity !== null) {
      try {
        const c = ctx.heatLayer._canvas
          || (ctx.heatLayer._renderer && ctx.heatLayer._renderer._container);
        if (c && c.style) c.style.opacity = t.prevHeatOpacity;
      } catch { /* noop */ }
      t.prevHeatOpacity = null;
    }
    t.active = false;
    if (ctx._exportMapToken === t) ctx._exportMapToken = null;
  };

  /**
   * Ermittelt zusätzliche, zentrierte Detail-Karten aus den Hotspot-Zellen
   * (siehe `computeTopHotspots`). Liefert pro Karte:
   *   { lat, lon, total, zoom, label }
   * – `zoom` wird aus der Punktdichte abgeleitet (mehr Punkte → näher dran),
   * – `label` ist ein deutscher Titel für die Bildunterschrift.
   *
   * Heuristik (Task 2/3/4):
   *  - Mindestens 5 Punkte pro Hotspot, sonst nicht eigenständig zeigen.
   *  - Top-1: Hauptcluster (immer Map B).
   *  - Top-2: Sekundärcluster (Map C) – nur wenn ≥ 5 Punkte UND vom Top-1
   *    räumlich getrennt (≥ 200 m), damit nicht zwei nahezu identische
   *    Karten produziert werden.
   *  - Zoom-Stufen:
   *      ≥ 20 Punkte → 19 (Knotenpunkt-Detail)
   *      ≥ 10 Punkte → 18
   *      sonst       → 17
   *
   * Reine Funktion: keine Leaflet-Abhängigkeit, deterministisch, testbar.
   *
   * @param {Array<{lat:number,lon:number}>} points
   * @param {object} [opts]
   * @param {number} [opts.maxTargets=2]      Max additional map captures (clamped to 0..3).
   * @param {number} [opts.minTotal=5]        Minimum points per hotspot. Hard floor of 2 –
   *                                          smaller values would make every isolated point
   *                                          a "cluster" and produce noisy maps.
   * @param {number} [opts.minSeparationM=200] Minimum distance between targets, in metres.
   * @returns {Array<{lat:number,lon:number,total:number,zoom:number,label:string}>}
   */
  UA.computeClusterMapTargets = function computeClusterMapTargets(points, opts) {
    const o = opts || {};
    const maxTargets = Math.max(0, Math.min(3,
      Number.isFinite(Number(o.maxTargets)) ? Number(o.maxTargets) : 2));
    const minTotal = Math.max(2,
      Number.isFinite(Number(o.minTotal)) ? Number(o.minTotal) : 5);
    const minSepM = Math.max(0,
      Number.isFinite(Number(o.minSeparationM)) ? Number(o.minSeparationM) : 200);
    const hotspots = UA.computeTopHotspots(points, { k: 3, minTotal });
    if (!hotspots.length || maxTargets === 0) return [];

    const M_PER_DEG_LAT = 111320;
    function distM(a, b) {
      const meanLat = (a.lat + b.lat) / 2;
      const mPerDegLon = 111320 * Math.cos(meanLat * Math.PI / 180);
      const dx = (a.lon - b.lon) * mPerDegLon;
      const dy = (a.lat - b.lat) * M_PER_DEG_LAT;
      return Math.hypot(dx, dy);
    }
    function zoomFor(total) {
      if (total >= 20) return 19;
      if (total >= 10) return 18;
      return 17;
    }

    const targets = [];
    for (const h of hotspots) {
      if (targets.length >= maxTargets) break;
      // Mindestabstand zu bereits gewählten Targets, damit keine doppelten
      // Karten desselben Knotens entstehen (Task 3 verlangt sinnvoll
      // getrennte räumliche Einheiten).
      let tooClose = false;
      for (const t of targets) {
        if (distM(t, h) < minSepM) { tooClose = true; break; }
      }
      if (tooClose) continue;
      targets.push({
        lat: h.lat,
        lon: h.lon,
        total: h.total,
        zoom: zoomFor(h.total),
        label: targets.length === 0 ? "Hauptcluster" : "Sekundärcluster",
        // Bounding box derived from the cluster's actual coordinates and the
        // cluster's own point list. Both are used by the export pipeline to
        // (a) fitBounds the captured map onto the cluster (Tasks 1, 7),
        // (b) draw export markers only for the cluster's points so the
        //     visible n exactly matches the table (Tasks 4, 5, 6),
        // (c) build a unique, cluster-specific Werkbank URL (Task 3).
        bounds: h.bounds || null,
        points: Array.isArray(h.points) ? h.points : []
      });
    }
    return targets;
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

  // ----------------------------
  // Context road overlays ("Straßensteigung" / "Verkehrsbelastung")
  //
  // First-class map layers backed by the per-way geometry+attrs that
  // `UA.contextLayers.loadAtIdle` lazily loads from `ways_<city>.json`.
  // Overlays are off by default; toggling either one builds the
  // Leaflet LayerGroup the first time and just flips visibility on
  // subsequent toggles. Capability gating (`ctx.contextCapabilities`)
  // hides controls for cities that don't carry the corresponding
  // enrichment field.
  //
  // URL state: `?mapLayer=slope,traffic` (csv, empty when nothing
  // active). Persisted through `UA.syncAllToUrl`; hydrated in
  // `UA.app_v2`'s main() before `UA.refreshContextOverlays(ctx)` runs.
  // ----------------------------

  const CONTEXT_OVERLAY_KINDS = ['slope', 'traffic'];
  const CONTEXT_TILE_DEFAULT_ZOOM = 13;

  function _lonToTileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  }
  function _latToTileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
        Math.pow(2, z)
    );
  }

  function _viewportTileDiagnostics(ctx) {
    const state = ctx && ctx.contextLayerState;
    const map = ctx && ctx.map;
    if (!state || !state.tileIndex || !map || typeof map.getBounds !== 'function') {
      return { expectedKeys: [], missingKeys: [], loadedKeys: [], expectedTileCount: 0 };
    }
    let bounds = null;
    try { bounds = map.getBounds(); } catch (_) { bounds = null; }
    if (!bounds) return { expectedKeys: [], missingKeys: [], loadedKeys: [], expectedTileCount: 0 };
    const z = Number.isFinite(state.tileIndex.z) ? state.tileIndex.z : CONTEXT_TILE_DEFAULT_ZOOM;
    const south = bounds.getSouth();
    const north = bounds.getNorth();
    const west = bounds.getWest();
    const east = bounds.getEast();
    if (!Number.isFinite(south) || !Number.isFinite(north) || !Number.isFinite(west) || !Number.isFinite(east)) {
      return { expectedKeys: [], missingKeys: [], loadedKeys: [], expectedTileCount: 0 };
    }
    const xMin = _lonToTileX(Math.min(west, east), z);
    const xMax = _lonToTileX(Math.max(west, east), z);
    const yMin = _latToTileY(Math.max(south, north), z);
    const yMax = _latToTileY(Math.min(south, north), z);
    const known = (state.tileIndex.tileKeySet instanceof Set)
      ? state.tileIndex.tileKeySet
      : new Set(((state.tileIndex.tiles || []).map(t => `${t.x}/${t.y}`)));
    const expectedKeys = [];
    const loadedKeys = [];
    const missingKeys = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        const key = `${x}/${y}`;
        if (!known.has(key)) continue;
        expectedKeys.push(key);
        if (state._tileCache && state._tileCache.has(key)) loadedKeys.push(key);
        else missingKeys.push(key);
      }
    }
    return { expectedKeys, loadedKeys, missingKeys, expectedTileCount: expectedKeys.length };
  }

  function _countOverlayFeatures(layer) {
    if (!layer) return 0;
    if (typeof layer.getLayers === 'function') {
      try { return (layer.getLayers() || []).length; } catch (_) { return 0; }
    }
    return 0;
  }

  function _logOverlayConsistency(ctx, kind, layer, tileDiag) {
    const reg = _ensureOverlayRegistry(ctx);
    const builtFeatures = _countOverlayFeatures(layer);
    const expectedTiles = tileDiag && Number.isFinite(tileDiag.expectedTileCount) ? tileDiag.expectedTileCount : 0;
    const missingTiles = tileDiag && Array.isArray(tileDiag.missingKeys) ? tileDiag.missingKeys.length : 0;
    const inconsistent = (missingTiles > 0) || (!!reg.active[kind] && builtFeatures === 0);
    if (!inconsistent) return;
    console.warn(
      `[context-overlay] consistency kind=${kind} active=${!!reg.active[kind]} features=${builtFeatures} expectedTiles=${expectedTiles} missingTiles=${missingTiles}`
    );
  }

  UA.parseMapLayerCsv = function parseMapLayerCsv(raw) {
    const out = { slope: false, traffic: false };
    if (!raw) return out;
    const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) if (p in out) out[p] = true;
    return out;
  };

  UA.serializeMapLayerCsv = function serializeMapLayerCsv(active) {
    const a = active || {};
    const out = [];
    for (const k of CONTEXT_OVERLAY_KINDS) if (a[k]) out.push(k);
    return out.join(',');
  };

  // Internal: returns `ctx.contextOverlays`, lazily creating it. The
  // registry holds the L.LayerGroup per kind (built on first toggle),
  // the desired-active flags, the layer control, and the legend control.
  function _ensureOverlayRegistry(ctx) {
    if (!ctx.contextOverlays) {
      ctx.contextOverlays = {
        active:  { slope: false, traffic: false },
        layers:  { slope: null,  traffic: null  },
        pending: { slope: false, traffic: false },
        // The controls are managed by refreshContextOverlays; track
        // them so we can tear them down on city switch.
        layerControl:  null,
        legendControl: null,
      };
    }
    if (!ctx.contextOverlays.pending) {
      ctx.contextOverlays.pending = { slope: false, traffic: false };
    }
    return ctx.contextOverlays;
  }

  function _buildOverlayLayer(ctx, kind) {
    const reg = _ensureOverlayRegistry(ctx);
    if (!UA.contextRoadLayer) return null;
    const state = ctx.contextLayerState;
    if (!state || !state.geometries) {
      reg.pending[kind] = true;
      return null;
    }
    try {
      // PR-E (full-network v3): when the loaded state has tile-based
      // coverage, only build polylines for the current viewport — the
      // moveend handler below rebuilds the layer as the user pans.
      const opts = (state.tileIndex && ctx.map && typeof ctx.map.getBounds === 'function')
        ? { bounds: ctx.map.getBounds() }
        : {};
      // PR-berlin-slope-qa: optional debug overlay. Read once from
      // the URL — the toggle is hidden behind a query param so it
      // never affects production rendering. `?debugSlope=1` shows the
      // numeric road_slope_percent as a permanent tooltip on each
      // slope polyline so values can be sight-checked in the field.
      if (kind === 'slope' && typeof UA.qGet === 'function') {
        const showPercent = String(UA.qGet('debugSlope', '') || '') === '1';
        const showSamples = String(UA.qGet('debugSlopeSamples', '') || '') === '1';
        if (showPercent || showSamples) {
          opts.debug = { showPercent, showSamples };
        }
      }
      const layer = (kind === 'slope')
        ? UA.contextRoadLayer.buildSlopeLayer(state, opts)
        : UA.contextRoadLayer.buildTrafficLayer(state, opts);
      reg.pending[kind] = false;
      return layer;
    } catch (e) {
      console.warn(`[context-overlay] build "${kind}" failed:`, e);
      return null;
    }
  }

  // Internal: build (or reuse) the L.LayerGroup for the given kind.
  function _buildOverlay(ctx, kind) {
    const reg = _ensureOverlayRegistry(ctx);
    if (reg.layers[kind]) return reg.layers[kind];
    const layer = _buildOverlayLayer(ctx, kind);
    if (layer) reg.layers[kind] = layer;
    return layer;
  }

  // Internal: rebuild every active overlay LayerGroup in place. Used by
  // the `moveend` handler so the slope/traffic ramps stay in sync with
  // the v3 tile data that arrives lazily as the user pans.
  async function _rebuildActiveOverlays(ctx) {
    const reg = _ensureOverlayRegistry(ctx);
    if (!ctx.map || !UA.contextRoadLayer) return;
    if (reg._overlayRebuildInFlight) return reg._overlayRebuildInFlight;
    reg._overlayRebuildInFlight = Promise.resolve().then(async () => {
      const tileDiag = await _ensureViewportTilesLoaded(ctx, { skipOverlayRebuild: true });
      for (const kind of CONTEXT_OVERLAY_KINDS) {
        if (!reg.active[kind]) continue;
        const prevLayer = reg.layers[kind];
        const nextLayer = _buildOverlayLayer(ctx, kind);
        if (!nextLayer) {
          _logOverlayConsistency(ctx, kind, prevLayer, tileDiag);
          continue;
        }
        try {
          if (typeof nextLayer.addTo === 'function') nextLayer.addTo(ctx.map);
          reg.layers[kind] = nextLayer;
          if (prevLayer && prevLayer !== nextLayer && typeof prevLayer.remove === 'function') {
            try { prevLayer.remove(); } catch (_) {}
          }
        } catch (e) {
          console.warn(`[context-overlay] attach "${kind}" failed:`, e);
          if (nextLayer && nextLayer !== prevLayer && typeof nextLayer.remove === 'function') {
            try { nextLayer.remove(); } catch (_) {}
          }
          reg.layers[kind] = prevLayer || null;
        }
        _logOverlayConsistency(ctx, kind, reg.layers[kind], tileDiag);
      }
      _refreshContextLegend(ctx);
      if (typeof UA.refreshContextOverlayZOrder === 'function') {
        try { UA.refreshContextOverlayZOrder(ctx); } catch (_) {}
      }
    }).finally(() => {
      reg._overlayRebuildInFlight = null;
    });
    return reg._overlayRebuildInFlight;
  }

  // Internal: refresh the floating legend so it shows the colour ramp
  // for whichever overlays are currently visible. Idempotent.
  function _refreshContextLegend(ctx) {
    const reg = _ensureOverlayRegistry(ctx);
    if (!reg.legendControl || !reg.legendControl._container) return;
    const c = reg.legendControl._container;
    while (c.firstChild) c.removeChild(c.firstChild);
    let added = 0;
    for (const kind of CONTEXT_OVERLAY_KINDS) {
      if (!reg.active[kind] || !reg.layers[kind]) continue;
      try {
        c.appendChild(UA.contextRoadLayer.buildLegend(kind));
        added++;
      } catch (_) { /* ignore */ }
    }
    c.style.display = added > 0 ? '' : 'none';
  }

  // Public: set an overlay active/inactive. Lazy-builds + adds/removes
  // the LayerGroup on `ctx.map`, persists state to the URL, and
  // refreshes the floating legend. Safe to call when controls have
  // not been wired (acts as a no-op).
  //
  // Also keeps the layer-control checkbox in sync, so programmatic
  // callers (tour player, URL hydration, …) see the UI reflect the
  // overlay's actual visibility.
  UA.setContextOverlayActive = function setContextOverlayActive(ctx, kind, active) {
    if (!CONTEXT_OVERLAY_KINDS.includes(kind)) return;
    const reg = _ensureOverlayRegistry(ctx);
    const want = !!active;
    if (reg.active[kind] === want) {
      if (want && !reg.layers[kind]) {
        _ensureViewportTilesLoaded(ctx).then(() => {
          const layer = _buildOverlay(ctx, kind);
          if (layer && ctx.map && typeof layer.addTo === 'function') {
            try { layer.addTo(ctx.map); } catch (_) { /* tolerate test stubs */ }
          }
          if (typeof UA.refreshContextOverlayZOrder === 'function') {
            try { UA.refreshContextOverlayZOrder(ctx); } catch (_) {}
          }
          _refreshContextLegend(ctx);
        }).catch(() => { /* tile fetch failure handled in _ensureViewportTilesLoaded */ });
      }
      // Even when the desired state already matches, keep the
      // checkbox in sync — a previous teardown may have left it
      // stale. This is cheap (one DOM lookup).
      _syncOverlayCheckbox(reg, kind, want);
      return;
    }

    if (want) {
      // PR-E: kick off a viewport-bounded tile fetch first so the
      // initial overlay build sees the data for the current viewport.
      // Best-effort — falls back silently to whatever's already in
      // state.geometries (v1/v2 path resolves immediately).
      _ensureViewportTilesLoaded(ctx).then(() => {
        const layer = _buildOverlay(ctx, kind);
        if (layer && ctx.map && typeof layer.addTo === 'function') {
          try { layer.addTo(ctx.map); } catch (_) { /* tolerate test stubs */ }
        }
        if (typeof UA.refreshContextOverlayZOrder === 'function') {
          try { UA.refreshContextOverlayZOrder(ctx); } catch (_) {}
        }
      });
    } else if (reg.layers[kind] && ctx.map && typeof reg.layers[kind].remove === 'function') {
      try { reg.layers[kind].remove(); } catch (_) { /* noop */ }
    }
    reg.active[kind] = want;
    _syncOverlayCheckbox(reg, kind, want);
    _refreshContextLegend(ctx);
    // PR-E: install / tear down the moveend handler the first time an
    // overlay turns on / the last one turns off. Idempotent — the
    // handler is stored on the registry to enable later removal.
    _ensureMoveEndHandler(ctx);
    if (typeof UA.syncAllToUrl === 'function') {
      try { UA.syncAllToUrl(ctx); } catch (_) { /* tolerate hydration */ }
    }
  };

  // Internal: kick off a viewport tile fetch and re-render active
  // overlays once new data arrives. v1/v2 states resolve immediately
  // and the rebuild is a no-op.
  function _ensureViewportTilesLoaded(ctx, opts = {}) {
    const state = ctx.contextLayerState;
    const cl = UA.contextLayers;
    const preDiag = _viewportTileDiagnostics(ctx);
    if (!state || !ctx.map || !cl || typeof cl.loadTilesForBbox !== 'function') {
      return Promise.resolve(preDiag);
    }
    let bounds = null;
    try { bounds = (typeof ctx.map.getBounds === 'function') ? ctx.map.getBounds() : null; }
    catch (_) { bounds = null; }
    if (!bounds) return Promise.resolve(preDiag);
    const before = state.geometries ? Object.keys(state.geometries).length : 0;
    return cl.loadTilesForBbox(state, bounds).then(() => {
      const after = state.geometries ? Object.keys(state.geometries).length : 0;
      if (after > before && !opts.skipOverlayRebuild) _rebuildActiveOverlays(ctx);
      return _viewportTileDiagnostics(ctx);
    }).catch(() => preDiag);
  }

  // Internal: install (once) a debounced map.moveend handler that
  // refreshes the v3 tile data + active overlays for the new viewport.
  // No-op for v1/v2 states (state.tileIndex absent) so legacy cities
  // don't pay any cost — viewport-bound rendering and lazy tile fetch
  // are v3-only concepts.
  function _ensureMoveEndHandler(ctx) {
    const reg = _ensureOverlayRegistry(ctx);
    if (!ctx.map || typeof ctx.map.on !== 'function') return;
    const state = ctx.contextLayerState;
    const isV3 = !!(state && state.tileIndex && state._tileCache);
    const anyActive = CONTEXT_OVERLAY_KINDS.some(k => reg.active[k]);
    if (!anyActive || !isV3) {
      if (reg._moveEndHandler) {
        try { ctx.map.off('moveend', reg._moveEndHandler); } catch (_) {}
        reg._moveEndHandler = null;
      }
      if (reg._moveEndTimer) {
        try { clearTimeout(reg._moveEndTimer); } catch (_) {}
        reg._moveEndTimer = null;
      }
      return;
    }
    if (reg._moveEndHandler) return;
    const handler = () => {
      if (reg._moveEndTimer) clearTimeout(reg._moveEndTimer);
      reg._moveEndTimer = setTimeout(() => {
        reg._moveEndTimer = null;
        // Bail out if overlays were turned off (or the city was
        // swapped to a non-v3 state) while the debounce was pending.
        const stillActive = CONTEXT_OVERLAY_KINDS.some(k => reg.active[k]);
        const stillV3 = !!(ctx.contextLayerState && ctx.contextLayerState.tileIndex);
        if (!stillActive || !stillV3) return;
        _ensureViewportTilesLoaded(ctx).then(() => {
          // Always rebuild — even when no new tiles arrived, the
          // viewport bound used by buildLayer() has changed so the
          // visible polylines must be re-filtered.
          _rebuildActiveOverlays(ctx);
        });
      }, 250);
    };
    ctx.map.on('moveend', handler);
    reg._moveEndHandler = handler;
  }

  // Internal: mirror `reg.active[kind]` onto the layer-control
  // checkbox without re-triggering its `change` handler. No-op when
  // the control isn't built or the input has been removed.
  function _syncOverlayCheckbox(reg, kind, want) {
    const ctrl = reg.layerControl;
    const c = ctrl && (ctrl._container || (typeof ctrl.getContainer === 'function' ? ctrl.getContainer() : null));
    if (!c || typeof c.querySelector !== 'function') return;
    const cb = c.querySelector('input[data-context-overlay="' + kind + '"]');
    if (cb && cb.checked !== !!want) cb.checked = !!want;
  }

  UA.refreshContextOverlayZOrder = function refreshContextOverlayZOrder(ctx) {
    if (!ctx || !ctx.map) return;
    const reg = _ensureOverlayRegistry(ctx);
    for (const kind of CONTEXT_OVERLAY_KINDS) {
      const layer = reg.layers[kind];
      if (!reg.active[kind] || !layer) continue;
      try {
        if (typeof layer.eachLayer === 'function') {
          layer.eachLayer((child) => {
            if (child && typeof child.bringToFront === 'function') child.bringToFront();
          });
        } else if (typeof layer.bringToFront === 'function') {
          layer.bringToFront();
        }
      } catch (_) {}
    }
    // Keep interaction-heavy layers above context polylines.
    for (const top of [ctx.clusterLayer, ctx.poiLayer, ctx.argumentationLayer]) {
      if (top && typeof top.bringToFront === 'function') {
        try { top.bringToFront(); } catch (_) {}
      }
    }
  };

  UA.waitForMapFullyRendered = function waitForMapFullyRendered(map, opts = {}) {
    const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || 30000);
    const ctx = opts.ctx || (UA && UA.ctx) || null;
    const tileTimeoutMs = Math.min(timeoutMs, Number(opts.tileTimeoutMs) || 15000);
    const cl = UA.contextLayers;
    const layerCtor = window.L && window.L.TileLayer;
    const raf = (typeof window.requestAnimationFrame === 'function')
      ? window.requestAnimationFrame.bind(window)
      : (cb) => setTimeout(cb, 16);

    const waitForTileLayers = () => new Promise((resolve) => {
      if (!map || typeof map.eachLayer !== 'function' || !layerCtor) {
        resolve(true);
        return;
      }
      const tileLayers = [];
      map.eachLayer((layer) => {
        if (layer instanceof layerCtor) tileLayers.push(layer);
      });
      if (tileLayers.length === 0) {
        resolve(true);
        return;
      }
      const layerLoading = new Map();
      let sawLoadedState = false;
      let done = false;
      const cleanups = [];
      let timeout = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        if (timeout) clearTimeout(timeout);
        for (const c of cleanups) c();
        resolve(!!ok);
      };
      const anyLoading = () => {
        for (const v of layerLoading.values()) {
          if (v) return true;
        }
        return false;
      };
      const maybeDone = () => {
        if (!anyLoading() && sawLoadedState) finish(true);
      };
      for (const layer of tileLayers) {
        const getLoading = () => !!(typeof layer.isLoading === 'function' && layer.isLoading());
        const syncLoading = () => {
          const isLoading = getLoading();
          layerLoading.set(layer, isLoading);
          if (!isLoading) sawLoadedState = true;
          maybeDone();
        };
        syncLoading();
        const onLoading = () => { syncLoading(); };
        const onLoad = () => {
          sawLoadedState = true;
          if (typeof layer.isLoading === 'function') syncLoading();
          else {
            layerLoading.set(layer, false);
            maybeDone();
          }
        };
        if (typeof layer.on === 'function' && typeof layer.off === 'function') {
          layer.on('loading', onLoading);
          layer.on('load', onLoad);
          cleanups.push(() => {
            try { layer.off('loading', onLoading); } catch (_) {}
            try { layer.off('load', onLoad); } catch (_) {}
          });
        }
      }
      if (!anyLoading()) {
        if (!sawLoadedState) {
          sawLoadedState = true;
        }
        finish(true);
        return;
      }
      timeout = setTimeout(() => finish(false), tileTimeoutMs);
    });

    const waitForContextTiles = () => {
      if (!ctx || !ctx.contextOverlays || !CONTEXT_OVERLAY_KINDS.some(k => ctx.contextOverlays.active && ctx.contextOverlays.active[k])) {
        return Promise.resolve(true);
      }
      if (!ctx.contextLayerState || !ctx.contextLayerState.tileIndex || !cl || typeof cl.loadTilesForBbox !== 'function') {
        return Promise.resolve(true);
      }
      let bounds = null;
      try { bounds = map && typeof map.getBounds === 'function' ? map.getBounds() : null; } catch (_) { bounds = null; }
      if (!bounds) return Promise.resolve(true);
      return cl.loadTilesForBbox(ctx.contextLayerState, bounds).then(() => true).catch(() => false);
    };

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(!!ok);
      };
      const timeout = setTimeout(() => finish(false), timeoutMs);
      Promise.resolve()
        .then(waitForTileLayers)
        .then((tilesOk) => {
          if (!tilesOk) return false;
          return waitForContextTiles();
        })
        .then((contextOk) => {
          if (!contextOk) {
            finish(false);
            return;
          }
          new Promise((r) => raf(() => raf(r))).then(() => finish(true)).catch(() => finish(false));
        })
        .catch(() => {
          finish(false);
        });
    });
  };

  /**
   * Wire (or re-wire) the context-overlay controls onto the map.
   * Called immediately during `main()` (capabilities only), and again
   * after `ctx.contextLayerState` resolves via `loadAtIdle` (now with
   * geometries). Idempotent — tears down previous controls first.
   *
   * Crucially, this is called twice during a normal cold start:
   *   1. before the lazy geometry load resolves — `state` is null,
   *      controls render but the checkboxes are disabled, and any
   *      previously-hydrated `reg.active.*` flags (e.g. from a
   *      `?mapLayer=…` deep link) are PRESERVED until the geometry
   *      arrives so the URL state isn't silently dropped.
   *   2. after the lazy load resolves — controls re-render, disabled
   *      state lifts, and any previously-pending `reg.active.*` flags
   *      auto-trigger the actual layer build via setContextOverlayActive.
   *
   * Renders nothing for cities without the corresponding capability
   * flag (`ctx.contextCapabilities.{hasSlope,hasTrafficProxy}`).
   */
  UA.refreshContextOverlays = function refreshContextOverlays(ctx) {
    if (!ctx || !ctx.map || !window.L || !UA.contextRoadLayer) return;
    const reg  = _ensureOverlayRegistry(ctx);
    const caps = ctx.contextCapabilities || {};
    const state = ctx.contextLayerState;
    // PR-E (full-network v3): a state with `tileIndex` is considered
    // "ready" even when `state.geometries` is still empty — the per-
    // tile fetch happens on overlay enable / map move, not at load
    // time. Without this the v3 envelope would render the permanent
    // "Layer nicht verfügbar (alte Datenversion)" hint.
    const hasV3Tiles = !!(state && state.tileIndex);
    const hasGeom = hasV3Tiles
      || !!(state && state.geometries && Object.keys(state.geometries).length);
    // Three-state model for the layer control:
    //   - state === null            → still loading (loadAtIdle pending)
    //   - state !== null && hasGeom → ready, checkboxes enabled
    //   - state !== null && !hasGeom → loaded but no per-way geometries
    //                                   (legacy/v1 ways file or unsupported
    //                                   future schema). Overlays cannot be
    //                                   built — show a non-loading hint
    //                                   instead of a permanent "(lädt …)".
    const isLoadingGeom    = (state === null);
    const geomUnavailable  = (state !== null) && !hasGeom;

    // Detach any prior layers + controls so a city switch starts clean.
    for (const kind of CONTEXT_OVERLAY_KINDS) {
      if (reg.layers[kind]) {
        try { reg.layers[kind].remove(); } catch (_) {}
        reg.layers[kind] = null;
      }
    }
    if (reg.layerControl) {
      try { reg.layerControl.remove(); } catch (_) {}
      reg.layerControl = null;
    }
    if (reg.legendControl) {
      try { reg.legendControl.remove(); } catch (_) {}
      reg.legendControl = null;
    }

    // Gate the controls on capabilities, NOT on geometry. The geometry
    // is loaded lazily and may legitimately not be there yet on the
    // first call; resetting `reg.active` at that point would clobber
    // a `?mapLayer=…` deep link before it had a chance to take effect.
    const showSlope   = !!caps.hasSlope;
    const showTraffic = !!caps.hasTrafficProxy;
    if (!showSlope && !showTraffic) {
      // City genuinely has no slope / no traffic data — drop any stale
      // active flags so a city switch can't leak a hidden restriction
      // into the URL.
      let changed = false;
      if (reg.active.slope)   { reg.active.slope   = false; changed = true; }
      if (reg.active.traffic) { reg.active.traffic = false; changed = true; }
      if (changed && typeof UA.syncAllToUrl === 'function') {
        try { UA.syncAllToUrl(ctx); } catch (_) {}
      }
      return;
    }
    // Drop active flags only for capabilities that actually disappeared
    // (mirroring the chip-filter pruning in refreshContextFilterVisibility).
    if (!showSlope)   reg.active.slope   = false;
    if (!showTraffic) reg.active.traffic = false;

    // Layer control — top-left to avoid the existing draw + bottom-
    // right legend controls. We use a custom control rather than
    // `L.control.layers` so capability gating + URL persistence stay
    // explicit and the styling matches the existing layer-legend UX.
    const ctrl = window.L.control({ position: 'topleft' });
    ctrl.onAdd = function() {
      const c = window.L.DomUtil.create('div', 'context-overlay-control leaflet-bar');
      window.L.DomEvent.disableClickPropagation(c);
      window.L.DomEvent.disableScrollPropagation(c);
      c.style.background = '#fff';
      c.style.padding    = '6px 8px';
      c.style.font       = '12px/1.3 system-ui, sans-serif';
      c.style.borderRadius = '4px';
      // A11y: this is a logically grouped set of layer toggles.
      c.setAttribute('role', 'group');
      c.setAttribute('aria-label', 'Karten-Layer für Straßenkontext');

      const title = document.createElement('div');
      title.id = 'context-overlay-control-title';
      title.textContent = 'Karten-Layer';
      title.style.fontWeight = '700';
      title.style.marginBottom = '4px';
      c.appendChild(title);
      c.setAttribute('aria-labelledby', 'context-overlay-control-title');

      // Pending vs. unavailable hint — the overlay control is built
      // even for capability-positive cities whose geometry table is
      // missing (legacy v1 ways file or unsupported future schema),
      // so we must distinguish the two cases:
      //   * isLoadingGeom    → "(lädt …)" — transient, will resolve.
      //   * geomUnavailable  → permanent "Layer nicht verfügbar"
      //                        hint, no spinner-like wording.
      if (isLoadingGeom) {
        const hint = document.createElement('div');
        hint.textContent = '(lädt …)';
        hint.style.fontSize = '11px';
        hint.style.color    = '#888';
        hint.style.marginBottom = '4px';
        c.appendChild(hint);
      } else if (geomUnavailable) {
        const hint = document.createElement('div');
        hint.textContent = 'Layer nicht verfügbar (alte Datenversion)';
        hint.style.fontSize = '11px';
        hint.style.color    = '#888';
        hint.style.marginBottom = '4px';
        c.appendChild(hint);
      }

      const add = (kind, label) => {
        const id  = 'ctxOverlay_' + kind;
        const row = document.createElement('label');
        row.style.display = 'block';
        // Cursor: 'wait' for transient loading, default for permanent
        // unavailability so it doesn't look like a spinner forever.
        row.style.cursor  = hasGeom ? 'pointer' : (isLoadingGeom ? 'wait' : 'not-allowed');
        row.htmlFor = id;
        if (!hasGeom) row.style.opacity = '0.6';
        const cb  = document.createElement('input');
        cb.type   = 'checkbox';
        cb.id     = id;
        cb.checked = !!reg.active[kind];
        cb.disabled = !hasGeom;
        cb.setAttribute('data-context-overlay', kind);
        cb.setAttribute('aria-label', label);
        // A11y (item 6, post-PR #261): make the toggles part of the
        // natural keyboard tab order alongside the existing Leaflet
        // controls (zoom, attribution), and announce the legend as
        // their description so screen-reader users get the colour
        // semantics without having to physically locate the
        // bottom-left legend.
        cb.setAttribute('tabindex', '0');
        cb.setAttribute('aria-describedby', 'context-overlay-legend');
        cb.addEventListener('change', () => {
          UA.setContextOverlayActive(ctx, kind, cb.checked);
        });
        row.appendChild(cb);
        row.appendChild(document.createTextNode(' ' + label));
        c.appendChild(row);
      };
      if (showSlope)   add('slope',   'Straßensteigung');
      if (showTraffic) add('traffic', 'Verkehrsbelastung');
      return c;
    };
    ctrl.addTo(ctx.map);
    reg.layerControl = ctrl;

    // Floating legend — bottom-left, only visible when ≥ 1 overlay active.
    const legend = window.L.control({ position: 'bottomleft' });
    legend.onAdd = function() {
      const c = window.L.DomUtil.create('div', 'context-overlay-legend');
      window.L.DomEvent.disableClickPropagation(c);
      c.style.background  = 'rgba(255,255,255,0.92)';
      c.style.padding     = '6px 8px';
      c.style.borderRadius = '4px';
      c.style.font        = '11px/1.3 system-ui, sans-serif';
      c.style.maxWidth    = '220px';
      c.style.display     = 'none';
      // A11y: stable id so the overlay-control checkboxes can point
      // their `aria-describedby` at the live legend (item 6 of the
      // post-PR #261 follow-up plan). `region` + label make screen
      // readers announce it as a meaningful map landmark instead of
      // an anonymous floating div.
      c.id = 'context-overlay-legend';
      c.setAttribute('role', 'region');
      c.setAttribute('aria-label', 'Legende der Karten-Layer');
      return c;
    };
    legend.addTo(ctx.map);
    reg.legendControl = legend;

    // Re-apply the desired active flags (e.g. hydrated from URL).
    for (const kind of CONTEXT_OVERLAY_KINDS) {
      if (reg.active[kind]) {
        const layer = _buildOverlay(ctx, kind);
        if (layer && typeof layer.addTo === 'function') {
          try { layer.addTo(ctx.map); } catch (_) {}
        }
      }
    }
    _refreshContextLegend(ctx);
    if (hasV3Tiles && CONTEXT_OVERLAY_KINDS.some(kind => reg.active[kind])) {
      _ensureViewportTilesLoaded(ctx).then(() => {
        _refreshContextLegend(ctx);
      });
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
        // Compose popup HTML — base content (none today, hook for
        // future PRs) plus the optional Kontextdaten section. Helper
        // returns null when neither produces content, so we don't
        // attach an empty popup to thousands of markers.
        const composeFn = (typeof UA.composeAccidentPopupHtml === 'function')
          ? UA.composeAccidentPopupHtml
          : null;
        const popupHtml = composeFn ? composeFn(ctx, p.props, { baseHtml: '' }) : null;
        if (popupHtml) m.bindPopup(popupHtml, { maxWidth: 360 });
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
    if (typeof UA.refreshContextOverlayZOrder === 'function') {
      try { UA.refreshContextOverlayZOrder(ctx); } catch (_) {}
    }

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
