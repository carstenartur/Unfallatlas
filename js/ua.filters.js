(() => {
  const UA = (window.UA = window.UA || {});

  UA.COMBO_LABEL = {
    1:  "🚲",
    2:  "🚶",
    4:  "🚗",
    8:  "🏍️",
    5:  "🚲+🚗",
    3:  "🚲+🚶",
    6:  "🚗+🚶",
    7:  "🚲+🚗+🚶",
    9:  "🚲+🏍️",
    12: "🚗+🏍️",
    10: "🚶+🏍️",
    11: "🚲+🚶+🏍️",
    13: "🚲+🚗+🏍️",
    14: "🚶+🚗+🏍️",
    15: "🚲+🚶+🚗+🏍️"
  };

  UA.maskFromProps = function maskFromProps(pr){
    const isBike = String(pr?.istrad)==="1";
    const isPed  = String(pr?.istfuss)==="1";
    const isCar  = String(pr?.istpkw)==="1";
    const isMoto = String(pr?.istkrad)==="1";
    return (isBike?1:0) | (isPed?2:0) | (isCar?4:0) | (isMoto?8:0);
  };

  UA.matchesNonInvolvementFilters = function matchesNonInvolvementFilters(ctx, pr){
    const ui = ctx.ui;

    const sev = ui.severityEl.value;
    if (sev !== "all" && String(pr.ukategorie) !== String(sev)) return false;

    const rc = ui.roadConditionEl.value;
    if (rc !== "all") {
      const z = String(pr.strzustand ?? "");
      if (rc === "__unknown__") {
        if (z !== "" && z !== "null" && z !== "undefined") return false;
      } else {
        if (z !== String(rc)) return false;
      }
    }

    const dt = ui.dayTypeEl.value;
    if (dt !== "all") {
      const wd = String(pr.uwochentag ?? "");
      const isWeekend = UA.WEEKEND_SET.has(wd);
      if (dt === "weekend" && !isWeekend) return false;
      if (dt === "weekday" && isWeekend) return false;
    }

    const h = parseInt(pr.ustunde, 10);
    if (Number.isNaN(h)) return false;
    const hf = parseInt(ui.hFromEl.value || "0", 10);
    const ht = parseInt(ui.hToEl.value || "23", 10);
    if (h < hf || h > ht) return false;

    return true;
  };

  UA.matchesInvolvementFilter = function matchesInvolvementFilter(ctx, mask){
    const ui = ctx.ui;
    const wantBike = ui.incBikeEl.checked;
    const wantPed  = ui.incPedEl.checked;
    const wantCar  = ui.incCarEl.checked;
    const wantMoto = ui.incMotoEl.checked;
    const anySelected = wantBike || wantPed || wantCar || wantMoto;
    if (!anySelected) return false;

    const hasBike = (mask & 1) !== 0;
    const hasPed  = (mask & 2) !== 0;
    const hasCar  = (mask & 4) !== 0;
    const hasMoto = (mask & 8) !== 0;

    if (ctx.involvementMode === "or") {
      return (wantBike && hasBike) || (wantPed && hasPed) || (wantCar && hasCar) || (wantMoto && hasMoto);
    } else if (ctx.involvementMode === "and") {
      if (wantBike && !hasBike) return false;
      if (wantPed  && !hasPed)  return false;
      if (wantCar  && !hasCar)  return false;
      if (wantMoto && !hasMoto) return false;
      return true;
    } else if (ctx.involvementMode === "solo") {
      const count = (hasBike?1:0)+(hasPed?1:0)+(hasCar?1:0)+(hasMoto?1:0);
      if (count !== 1) return false;
      return (wantBike && hasBike) || (wantPed && hasPed) || (wantCar && hasCar) || (wantMoto && hasMoto);
    }
    return true;
  };

  UA.computeBaselineCounts = function computeBaselineCounts(ctx){
    const counts = { total:0, byMask:{} };
    for (const p of ctx.allPts) {
      const pr = p.props || {};
      if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
      const m = UA.maskFromProps(pr);
      if (m === 0) continue;
      counts.total++;
      counts.byMask[m] = (counts.byMask[m]||0)+1;
    }
    return counts;
  };

  UA.applyFilters = function applyFilters(ctx){
    const ui = ctx.ui;
    const maxN = Math.max(500, parseInt(ui.maxPointsEl.value || "100000", 10));
    const outAll = [];
    const outCapped = [];

    for (const p of ctx.allPts) {
      const pr = p.props || {};
      if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
      const m = UA.maskFromProps(pr);
      if (m === 0) continue;
      if (!UA.matchesInvolvementFilter(ctx, m)) continue;

      outAll.push(p);
      if (outCapped.length < maxN) outCapped.push(p);
    }

    ctx.filteredAll = outAll;
    ctx.filteredCapped = outCapped;
    ctx.baselineCounts = UA.computeBaselineCounts(ctx);
  };

  UA.getPaddedBounds = function getPaddedBounds(ctx){
    const ui = ctx.ui;
    const padPct = Math.max(0, Math.min(100, parseInt(ui.viewportPaddingEl.value || "20", 10))) / 100.0;
    const b = ctx.map.getBounds();
    const latSpan = b.getNorth() - b.getSouth();
    const lonSpan = b.getEast() - b.getWest();
    const dLat = latSpan * padPct;
    const dLon = lonSpan * padPct;
    return L.latLngBounds(
      [b.getSouth() - dLat, b.getWest() - dLon],
      [b.getNorth() + dLat, b.getEast() + dLon]
    );
  };

  UA.applyViewportFilter = function applyViewportFilter(ctx){
    const vb = UA.getPaddedBounds(ctx);
    const south = vb.getSouth();
    const north = vb.getNorth();
    const west = vb.getWest();
    const east = vb.getEast();
    
    // Optimized bounds check - direct comparison without creating LatLng objects
    const filtered = [];
    for (const p of ctx.filteredCapped) {
      if (p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east) {
        filtered.push(p);
      }
    }
    ctx.viewportPts = filtered;
  };

  // Hotspots (Nur „auffällig“)
  UA.HOTSPOT = {
    minCellM: 20,
    cellPx: 110,
    minTotal: 10,
    minMask: 4,
    factor: 1.35
  };

  function metersPerPixel(lat, zoom){
    const rad = lat * Math.PI / 180;
    return 156543.03392 * Math.cos(rad) / Math.pow(2, zoom);
  }

  UA.updateHotspotCellPx = function updateHotspotCellPx(ctx){
    const z = ctx.map.getZoom();
    const lat = ctx.map.getCenter().lat;
    const mpp = metersPerPixel(lat, z) || 1;
    const px = Math.round(UA.HOTSPOT.minCellM / mpp);
    UA.HOTSPOT.cellPx = Math.max(40, Math.min(400, px));
  };

  function cellKeyForPoint(ctx, p){
    const pt = ctx.map.project(L.latLng(p.lat, p.lon), ctx.map.getZoom());
    const cx = Math.floor(pt.x / UA.HOTSPOT.cellPx);
    const cy = Math.floor(pt.y / UA.HOTSPOT.cellPx);
    return cx + ":" + cy;
  }

  function computeHotCells(ctx, points, baseline){
    if (!baseline || !baseline.total) return null;

    const baseRatios = {};
    for (const [k,v] of Object.entries(baseline.byMask || {})) baseRatios[k] = (baseline.total>0 ? (v/baseline.total) : 0);

    const cells = new Map(); // key -> {total, byMask}
    for (const p of points){
      const k = cellKeyForPoint(ctx, p);
      let c = cells.get(k);
      if (!c){ c = { total:0, byMask:{} }; cells.set(k,c); }
      c.total++;
      const mask = UA.maskFromProps(p.props || {});
      c.byMask[mask] = (c.byMask[mask] || 0) + 1;
    }

    const hot = new Set();
    const hotReason = new Map();
    for (const [k,c] of cells.entries()){
      if (c.total < UA.HOTSPOT.minTotal) continue;
      const reasons = [];
      for (const [mask, cnt] of Object.entries(c.byMask)){
        if (cnt < UA.HOTSPOT.minMask) continue;
        const locR = cnt / c.total;
        const baseR = baseRatios[mask] || 0;
        if (baseR <= 0) continue;
        const f = locR / baseR;
        if (f >= UA.HOTSPOT.factor){
          reasons.push({ mask, locR, baseR, f, cnt, total:c.total });
        }
      }
      if (reasons.length){
        reasons.sort((a,b)=> b.f - a.f);
        hot.add(k);
        hotReason.set(k, reasons.slice(0,3));
      }
    }
    return { hot, hotReason };
  }

  UA.hotFilter = function hotFilter(ctx, points){
    const baseline = ctx.baselineCounts;
    const grid = computeHotCells(ctx, points, baseline);
    if (!grid) return { pts: points, grid: null };
    const pts = points.filter(p => grid.hot.has(cellKeyForPoint(ctx, p)));
    return { pts, grid };
  };
})();