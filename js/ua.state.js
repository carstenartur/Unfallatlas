(() => {
  const UA = (window.UA = window.UA || {});

  const CANON = {
    city: "city",
    severity: "severity",
    dayType: "dayType",
    roadCondition: "roadCondition",
    hourFrom: "hourFrom",
    hourTo: "hourTo",
    maxPoints: "maxPoints",
    viewportPaddingPct: "viewportPaddingPct",
    heatRadius: "heatRadius",
    includeCyclist: "includeCyclist",
    includePedestrian: "includePedestrian",
    includeCar: "includeCar",
    includeMotorcycle: "includeMotorcycle",
    includeGkfz: "includeGkfz",
    includeSonstig: "includeSonstig",
    involvementMode: "involvementMode",
    showCluster: "showCluster",
    showHeatmap: "showHeatmap",
    showOnlyAboveAverage: "showOnlyAboveAverage",
    showSchools: "showSchools",
    showKindergartens: "showKindergartens",
    showArgumentation: "showArgumentation",
    ctxSlope: "ctxSlope",
    ctxTraffic: "ctxTraffic",
    ctxOnlyMatched: "ctxOnlyMatched",
    mapLayer: "mapLayer",
    debugSlope: "debugSlope",
    debugSlopeSamples: "debugSlopeSamples",
    centerLat: "centerLat",
    centerLon: "centerLon",
    zoom: "zoom",
    selSouth: "selSouth",
    selWest: "selWest",
    selNorth: "selNorth",
    selEast: "selEast",
    accidentView: "accidentView",
    export: "export",
    tour: "tour"
  };

  const LEGACY = {
    year: "severity",
    kat: "severity",
    weekend: "dayType",
    strz: "roadCondition",
    hFrom: "hourFrom",
    hTo: "hourTo",
    maxn: "maxPoints",
    pad: "viewportPaddingPct",
    heatR: "heatRadius",
    rad: "includeCyclist",
    fuss: "includePedestrian",
    pkw: "includeCar",
    krad: "includeMotorcycle",
    gkfz: "includeGkfz",
    sonstig: "includeSonstig",
    mode: "involvementMode",
    cluster: "showCluster",
    heat: "showHeatmap",
    above: "showOnlyAboveAverage",
    onlyHot: "showOnlyAboveAverage"
  };

  function parseSearchKeepLast(search) {
    const raw = search.replace(/^\?/, "");
    const pairs = raw ? raw.split("&") : [];
    const map = new Map();
    let hadDup = false;
    let hadLegacy = false;
    let hadUnknown = false;

    for (const part of pairs) {
      if (!part) continue;
      const i = part.indexOf("=");
      const k0 = decodeURIComponent(i>=0 ? part.slice(0,i) : part);
      const v0 = decodeURIComponent(i>=0 ? part.slice(i+1) : "");
      const k = LEGACY[k0] || k0;
      if (k0 !== k) hadLegacy = true;
      if (!CANON[k]) hadUnknown = true;
      if (map.has(k)) hadDup = true;
      map.set(k, v0);
    }
    return { map, hadDup, hadLegacy, hadUnknown };
  }

  function buildSearch(map) {
    const p = new URLSearchParams();
    for (const [k,v] of map.entries()) {
      if (v === null || v === undefined || v === "") continue;
      if (!CANON[k]) continue;
      p.set(k, String(v));
    }
    const ordered = new URLSearchParams();
    Object.keys(CANON).forEach(k => {
      if (p.has(k)) ordered.set(k, p.get(k));
    });
    return ordered.toString();
  }

  UA.cleanUrlIfNeeded = function cleanUrlIfNeeded() {
    const parsed = parseSearchKeepLast(window.location.search);
    // Only reload for actual content changes (duplicates, legacy param names, unknown params).
    // Do NOT reload for pure parameter-ordering differences to avoid unexpected reloads
    // that can cause the map to jump to a saved state from a different city.
    if (parsed.hadDup || parsed.hadLegacy || parsed.hadUnknown) {
      const cleanedSearch = buildSearch(parsed.map);
      const u = new URL(window.location.href);
      u.search = cleanedSearch ? ("?" + cleanedSearch) : "";
      window.location.replace(u.toString());
      return true;
    }
    return false;
  };

  UA.viewParamsPresent = () => UA.qs().has("centerLat") && UA.qs().has("centerLon") && UA.qs().has("zoom");
  UA.selectionParamsPresent = () => UA.qs().has("selSouth") && UA.qs().has("selWest") && UA.qs().has("selNorth") && UA.qs().has("selEast");

  const CITY_STATE_KEY = (city) => `ua_state_${UA.normKey(city)}`;

  UA.saveCityState = function saveCityState(ctx){
    // ctx liefert UI + map + selection
    try {
      const { CITY_RAW, map, ui, selectionBounds } = ctx;
      const c = map.getCenter();
      const st = {
        ts: Date.now(),
        severity: ui.severityEl.value,
        roadCondition: ui.roadConditionEl.value,
        dayType: ui.dayTypeEl.value,
        hourFrom: Number(ui.hFromEl.value),
        hourTo: Number(ui.hToEl.value),
        maxPoints: Number(ui.maxPointsEl.value),
        viewportPaddingPct: Number(ui.viewportPaddingEl.value),
        heatRadius: Number(ui.heatRadiusEl.value),
        includeCyclist: ui.incBikeEl.checked ? 1 : 0,
        includePedestrian: ui.incPedEl.checked ? 1 : 0,
        includeCar: ui.incCarEl.checked ? 1 : 0,
        includeMotorcycle: ui.incMotoEl.checked ? 1 : 0,
        includeGkfz: ui.incGkfzEl ? (ui.incGkfzEl.checked ? 1 : 0) : undefined,
        includeSonstig: ui.incSonEl ? (ui.incSonEl.checked ? 1 : 0) : undefined,
        involvementMode: ctx.involvementMode,
        showCluster: ctx.showCluster ? 1 : 0,
        showHeatmap: ctx.showHeatmap ? 1 : 0,
        showOnlyAboveAverage: ctx.showOnlyAboveAverage ? 1 : 0,
        centerLat: Number(c.lat.toFixed(6)),
        centerLon: Number(c.lng.toFixed(6)),
        zoom: map.getZoom(),
        sel: selectionBounds ? {
          s: Number(selectionBounds.getSouth().toFixed(6)),
          w: Number(selectionBounds.getWest().toFixed(6)),
          n: Number(selectionBounds.getNorth().toFixed(6)),
          e: Number(selectionBounds.getEast().toFixed(6))
        } : null
      };
      localStorage.setItem(CITY_STATE_KEY(CITY_RAW), JSON.stringify(st));
    } catch {}
  };

  UA.restoreCityStateIfNoUrlView = function restoreCityStateIfNoUrlView(ctx){
    if (UA.viewParamsPresent()) return false;
    try {
      const raw = localStorage.getItem(CITY_STATE_KEY(ctx.CITY_RAW));
      if (!raw) return false;
      const st = JSON.parse(raw);
      if (!st) return false;

      const ui = ctx.ui;

      ui.severityEl.value = st.severity ?? ui.severityEl.value;
      ui.roadConditionEl.value = st.roadCondition ?? ui.roadConditionEl.value;
      ui.dayTypeEl.value = st.dayType ?? ui.dayTypeEl.value;

      ui.hFromEl.value = String(st.hourFrom ?? 0);
      ui.hToEl.value = String(st.hourTo ?? 23);
      ui.maxPointsEl.value = String(st.maxPoints ?? 100000);
      ui.viewportPaddingEl.value = String(st.viewportPaddingPct ?? 20);
      ui.heatRadiusEl.value = String(st.heatRadius ?? 25);

      ui.incBikeEl.checked = !!st.includeCyclist;
      ui.incPedEl.checked  = !!st.includePedestrian;
      ui.incCarEl.checked  = !!st.includeCar;
      ui.incMotoEl.checked = !!st.includeMotorcycle;
      if (ui.incGkfzEl) ui.incGkfzEl.checked = !!st.includeGkfz;
      if (ui.incSonEl)  ui.incSonEl.checked  = !!st.includeSonstig;

      ctx.involvementMode = st.involvementMode ?? ctx.involvementMode;
      ctx.showCluster = !!st.showCluster;
      ctx.showHeatmap = !!st.showHeatmap;
      ctx.showOnlyAboveAverage = !!st.showOnlyAboveAverage;

      if (Number.isFinite(st.centerLat) && Number.isFinite(st.centerLon) && Number.isFinite(st.zoom)) {
        ctx.map.setView([st.centerLat, st.centerLon], st.zoom);
      }
      if (st.sel && Number.isFinite(st.sel.s) && Number.isFinite(st.sel.w) && Number.isFinite(st.sel.n) && Number.isFinite(st.sel.e)) {
        ctx.selectionBounds = L.latLngBounds([st.sel.s, st.sel.w],[st.sel.n, st.sel.e]);
      }
      return true;
    } catch {
      return false;
    }
  };
})();
