(() => {
  const UA = (window.UA = window.UA || {});
  

  UA.bindDom = function bindDom(ctx){
    const ui = {};
    ui.panelEl = document.getElementById('panel');
    ui.collapseBtn = document.getElementById('collapseBtn');
    ui.legendBtn = document.getElementById('legendBtn');
    ui.legendBox = document.getElementById('legendBox');
    ui.statEl = document.getElementById('stat');
    ui.buildInfo = document.getElementById("buildInfo");
    ui.dataSourceCode = document.getElementById("dataSourceCode");

    ui.citySel = document.getElementById("citySel");
    ui.severityEl = document.getElementById("severity");
    ui.dayTypeEl = document.getElementById("dayType");
    ui.roadConditionEl = document.getElementById("roadCondition");
    ui.maxPointsEl = document.getElementById("maxPoints");
    ui.viewportPaddingEl = document.getElementById("viewportPaddingPct");
    ui.heatRadiusEl = document.getElementById("heatRadius");

    ui.incBikeEl = document.getElementById("incBike");
    ui.incPedEl  = document.getElementById("incPed");
    ui.incCarEl  = document.getElementById("incCar");
    ui.incMotoEl = document.getElementById("incMoto");

    ui.btnModeOr = document.getElementById("modeOr");
    ui.btnModeAnd = document.getElementById("modeAnd");
    ui.btnModeSolo = document.getElementById("modeSolo");

    ui.hFromEl = document.getElementById("hFrom");
    ui.hToEl = document.getElementById("hTo");
    ui.hFromLbl = document.getElementById("hFromLbl");
    ui.hToLbl = document.getElementById("hToLbl");
    ui.hourFill = document.getElementById("hourFill");

    ui.btnCluster = document.getElementById("toggleCluster");
    ui.btnHeat = document.getElementById("toggleHeat");
    ui.btnOnlyHot = document.getElementById("toggleOnlyHot");

    ui.btnDraw = document.getElementById("btnDraw");
    ui.btnClearDraw = document.getElementById("btnClearDraw");
    ui.btnOpenExport = document.getElementById("btnOpenExport");

    ui.modalOverlay = document.getElementById('modalOverlay');
    ui.exportHtml = document.getElementById('exportHtml');
    ui.exportBoxTa = document.getElementById('exportBoxTa');
    ui.exportProgress = document.getElementById('exportProgress');
    ui.btnCloseModal = document.getElementById('btnCloseModal');
    ui.btnCopyText = document.getElementById('btnCopyText');
    ui.btnCopyLink = document.getElementById('btnCopyLink');

    ctx.ui = ui;

    if (ui.buildInfo) ui.buildInfo.textContent = UA.BUILD || "";
  };

  function setCollapsed(ctx, on){
    const ui = ctx.ui;
    ui.panelEl.classList.toggle('collapsed', on);
    ui.collapseBtn.textContent = on ? ">" : "v";
    try { localStorage.setItem("ua_panel_collapsed", on ? "1" : "0"); } catch {}
  }

  UA.syncHourUI = function syncHourUI(ctx, changed){
    const ui = ctx.ui;
    let a = parseInt(ui.hFromEl.value, 10);
    let b = parseInt(ui.hToEl.value, 10);
    if (changed === "from" && a > b) { b = a; ui.hToEl.value = String(b); }
    if (changed === "to"   && b < a) { a = b; ui.hFromEl.value = String(a); }
    ui.hFromLbl.textContent = String(a);
    ui.hToLbl.textContent = String(b);
    const min = parseInt(ui.hFromEl.min,10);
    const max = parseInt(ui.hFromEl.max,10);
    const span = (max - min) || 1;
    const leftPct = ((a - min) / span) * 100;
    const rightPct = 100 - ((b - min) / span) * 100;
    ui.hourFill.style.left = `${leftPct}%`;
    ui.hourFill.style.right = `${rightPct}%`;
  };

  UA.syncViewToUrl = function syncViewToUrl(ctx, removeSelection=false){
    const c = ctx.map.getCenter();
    const z = ctx.map.getZoom();
    const upd = {
      centerLat: c.lat.toFixed(6),
      centerLon: c.lng.toFixed(6),
      zoom: z
    };
    if (removeSelection) {
      upd.selSouth = null; upd.selWest = null; upd.selNorth = null; upd.selEast = null;
    } else if (ctx.selectionBounds) {
      upd.selSouth = ctx.selectionBounds.getSouth().toFixed(6);
      upd.selWest  = ctx.selectionBounds.getWest().toFixed(6);
      upd.selNorth = ctx.selectionBounds.getNorth().toFixed(6);
      upd.selEast  = ctx.selectionBounds.getEast().toFixed(6);
    }
    UA.setQS(upd);
    UA.saveCityState(ctx);
  };

  UA.syncAllToUrl = function syncAllToUrl(ctx){
    const ui = ctx.ui;
    UA.setQS({
      city: ctx.CITY_RAW,
      severity: ui.severityEl.value,
      roadCondition: ui.roadConditionEl.value,
      dayType: ui.dayTypeEl.value,
      hourFrom: ui.hFromEl.value,
      hourTo: ui.hToEl.value,
      maxPoints: ui.maxPointsEl.value,
      viewportPaddingPct: ui.viewportPaddingEl.value,
      heatRadius: ui.heatRadiusEl.value,
      includeCyclist: ui.incBikeEl.checked ? 1 : 0,
      includePedestrian: ui.incPedEl.checked ? 1 : 0,
      includeCar: ui.incCarEl.checked ? 1 : 0,
      includeMotorcycle: ui.incMotoEl.checked ? 1 : 0,
      involvementMode: ctx.involvementMode,
      showCluster: ctx.showCluster ? 1 : 0,
      showHeatmap: ctx.showHeatmap ? 1 : 0,
      showOnlyAboveAverage: ctx.showOnlyAboveAverage ? 1 : 0,
      showSchools: ctx.showSchools ? 1 : 0,
      showKindergartens: ctx.showKindergartens ? 1 : 0
    });
    UA.syncViewToUrl(ctx);
  };

  UA.loadCitiesList = async function loadCitiesList(ctx){
    try{
      const resp = await fetch("cities.txt", { cache: "no-store" });
      if (!resp.ok) throw new Error(`cities.txt load failed (${resp.status})`);
      const txt = await resp.text();
      const lines = txt.split(/\n/).map(l => l.replace(/\r/g,"").replace(/#.*/,"").trim()).filter(Boolean);
      const seen = new Set();
      const uniq = [];
      for (const c of lines){
        const k = UA.normKey(c);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(c);
      }
      uniq.sort((a,b)=>a.localeCompare(b,'de',{sensitivity:'base'}));
      return uniq;
    } catch (e) {
      console.warn("cities.txt not available, fallback:", e);
      return [ctx.CITY_RAW];
    }
  };

  UA.setCityDropdown = function setCityDropdown(ctx, cities){
    const ui = ctx.ui;
    ui.citySel.innerHTML = "";
    for (const c of cities) {
      const opt = document.createElement("option");
      opt.value = c;
      opt.textContent = c;
      ui.citySel.appendChild(opt);
    }
    if (!cities.some(x => x.toLowerCase() === ctx.CITY_RAW.toLowerCase())) {
      const opt = document.createElement("option");
      opt.value = ctx.CITY_RAW;
      opt.textContent = ctx.CITY_RAW + " (nicht in cities.txt)";
      ui.citySel.insertBefore(opt, ui.citySel.firstChild);
    }
    ui.citySel.value = ctx.CITY_RAW;
  };

  UA.bindUi = function bindUi(ctx){
    const ui = ctx.ui;

    // panel collapse + legend
    const savedCollapsed = (() => { try { return localStorage.getItem("ua_panel_collapsed"); } catch { return null; } })();
    if (savedCollapsed === "1") setCollapsed(ctx, true);

    ui.collapseBtn.addEventListener('click', () => setCollapsed(ctx, !ui.panelEl.classList.contains('collapsed')));
    ui.legendBtn.addEventListener('click', () => { ui.legendBox.style.display = (ui.legendBox.style.display==="block") ? "none" : "block"; });

    // defaults from URL
    ui.severityEl.value = UA.qGet("severity","all");
    ui.dayTypeEl.value = UA.qGet("dayType","all");
    ui.roadConditionEl.value = UA.qGet("roadCondition","all");

    ui.hFromEl.value = String(Math.max(0, Math.min(23, parseInt(UA.qGet("hourFrom","0"),10)||0)));
    ui.hToEl.value   = String(Math.max(0, Math.min(23, parseInt(UA.qGet("hourTo","23"),10)||23)));
    ui.maxPointsEl.value = String(Math.max(500, Math.min(200000, parseInt(UA.qGet("maxPoints","100000"),10)||100000)));
    ui.viewportPaddingEl.value = String(Math.max(0, Math.min(100, parseInt(UA.qGet("viewportPaddingPct","20"),10)||20)));
    ui.heatRadiusEl.value = String(Math.max(5, Math.min(60, parseInt(UA.qGet("heatRadius","25"),10)||25)));

    ui.incBikeEl.checked = UA.qBool("includeCyclist", true);
    ui.incPedEl.checked  = UA.qBool("includePedestrian", true);
    ui.incCarEl.checked  = UA.qBool("includeCar", true);
    ui.incMotoEl.checked = UA.qBool("includeMotorcycle", false);

    ctx.involvementMode = UA.qGet("involvementMode", ctx.involvementMode || "or");
    ctx.showCluster = UA.qBool("showCluster", true);
    ctx.showHeatmap = UA.qBool("showHeatmap", true);
    ctx.showOnlyAboveAverage = UA.qBool("showOnlyAboveAverage", false);
    ctx.showSchools = UA.qBool("showSchools", true);
    ctx.showKindergartens = UA.qBool("showKindergartens", true);

    UA.setBtnState(ui.btnModeOr, ctx.involvementMode==="or");
    UA.setBtnState(ui.btnModeAnd, ctx.involvementMode==="and");
    UA.setBtnState(ui.btnModeSolo, ctx.involvementMode==="solo");

    UA.setBtnState(ui.btnCluster, ctx.showCluster);
    UA.setBtnState(ui.btnHeat, ctx.showHeatmap);
    UA.setBtnState(ui.btnOnlyHot, ctx.showOnlyAboveAverage);

    UA.syncHourUI(ctx);

    // view from URL
    if (UA.viewParamsPresent()) {
      const clat = UA.qNum("centerLat", null);
      const clon = UA.qNum("centerLon", null);
      const zoom = UA.qNum("zoom", null);
      if (clat!==null && clon!==null && zoom!==null) ctx.map.setView([clat, clon], zoom);
    }
    if (UA.selectionParamsPresent()) {
      const s = UA.qNum("selSouth", null), w=UA.qNum("selWest", null), n=UA.qNum("selNorth", null), e=UA.qNum("selEast", null);
      if ([s,w,n,e].every(x => x!==null && Number.isFinite(x))) {
        ctx.selectionBounds = L.latLngBounds([s,w],[n,e]);
        ctx.drawnItems.clearLayers();
        ctx.drawnItems.addLayer(L.rectangle(ctx.selectionBounds, {color:"#2b7cff", weight:2}));
      }
    }

    // changes
    for (const el of [ui.severityEl, ui.dayTypeEl, ui.roadConditionEl, ui.maxPointsEl, ui.viewportPaddingEl, ui.heatRadiusEl]) {
      el.addEventListener("change", ()=>{ UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });
    }
    for (const el of [ui.incBikeEl, ui.incPedEl, ui.incCarEl, ui.incMotoEl]) {
      el.addEventListener("change", ()=>{ UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });
    }

    ui.hFromEl.addEventListener("input", ()=>{ UA.syncHourUI(ctx, "from"); UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });
    ui.hToEl.addEventListener("input", ()=>{ UA.syncHourUI(ctx, "to"); UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });

    ui.btnModeOr.addEventListener("click", ()=> { ctx.involvementMode="or"; UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); UA.setBtnState(ui.btnModeOr,true); UA.setBtnState(ui.btnModeAnd,false); UA.setBtnState(ui.btnModeSolo,false);} );
    ui.btnModeAnd.addEventListener("click", ()=> { ctx.involvementMode="and"; UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); UA.setBtnState(ui.btnModeOr,false); UA.setBtnState(ui.btnModeAnd,true); UA.setBtnState(ui.btnModeSolo,false);} );
    ui.btnModeSolo.addEventListener("click", ()=> { ctx.involvementMode="solo"; UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); UA.setBtnState(ui.btnModeOr,false); UA.setBtnState(ui.btnModeAnd,false); UA.setBtnState(ui.btnModeSolo,true);} );

    ui.btnCluster.addEventListener("click", ()=>{ ctx.showCluster=!ctx.showCluster; UA.setBtnState(ui.btnCluster, ctx.showCluster); UA.syncAllToUrl(ctx); ctx._dataChanged = true; UA.syncLegendButtons(ctx); UA.renderLayers(ctx); });
    ui.btnHeat.addEventListener("click", ()=>{ ctx.showHeatmap=!ctx.showHeatmap; UA.setBtnState(ui.btnHeat, ctx.showHeatmap); UA.syncAllToUrl(ctx); ctx._dataChanged = true; UA.syncLegendButtons(ctx); UA.renderLayers(ctx); });
    ui.btnOnlyHot.addEventListener("click", ()=>{ ctx.showOnlyAboveAverage=!ctx.showOnlyAboveAverage; UA.setBtnState(ui.btnOnlyHot, ctx.showOnlyAboveAverage); UA.syncAllToUrl(ctx); ctx._dataChanged = true; UA.renderLayers(ctx); });

    // draw controls
    ui.btnDraw.addEventListener('click', () => {
      const toolbar = ctx.drawControl._toolbars?.draw;
      const rectTool = toolbar?._modes?.rectangle?.handler;
      if (rectTool) rectTool.enable();
    });
    ui.btnClearDraw.addEventListener('click', () => {
      ctx.drawnItems.clearLayers();
      ctx.selectionBounds = null;
      UA.syncViewToUrl(ctx, true);
      UA.recomputeAndRender(ctx);
    });

    // city change -> page reload but keep canonical params
    ui.citySel.addEventListener("change", async () => {
      UA.saveCityState(ctx);
      const nextCity = ui.citySel.value;
      if (!nextCity || nextCity === ctx.CITY_RAW) return;

      const u = new URL(window.location.href);
      u.searchParams.set("city", nextCity);
      ["centerLat","centerLon","zoom","selSouth","selWest","selNorth","selEast","export"].forEach(k => u.searchParams.delete(k));
      window.location.assign(u.toString());
    });

    // Sync legend button CSS to reflect URL-restored state
    // (addLayerLegend runs before bindUi, so buttons may have wrong initial class)
    if (typeof UA.syncLegendButtons === 'function') UA.syncLegendButtons(ctx);
  };

})();