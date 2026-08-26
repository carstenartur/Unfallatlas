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
    ui.metaInfoBox = document.getElementById("metaInfoBox");
    ui.noSelectionHint = document.getElementById("noSelectionHint");
    ui.quickStartHint  = document.getElementById("quickStartHint");

    ui.citySel = document.getElementById("citySel");
    ui.severityEl = document.getElementById("severity");
    ui.dayTypeEl = document.getElementById("dayType");
    ui.roadConditionEl = document.getElementById("roadCondition");
    ui.maxPointsEl = document.getElementById("maxPoints");
    ui.viewportPaddingEl = document.getElementById("viewportPaddingPct");
    ui.heatRadiusEl = document.getElementById("heatRadius");
    ui.mapModeStandardBtn = document.getElementById("mapModeStandard");
    ui.mapModeOrthophotoBtn = document.getElementById("mapModeOrthophoto");
    ui.mapModeHybridBtn = document.getElementById("mapModeHybrid");
    ui.mapModeAnalysisBtn = document.getElementById("mapModeAnalysis");
    ui.orthophotoOpacityEl = document.getElementById("orthophotoOpacity");
    ui.orthophotoOpacityLbl = document.getElementById("orthophotoOpacityLbl");
    ui.mapLayerStatusEl = document.getElementById("mapLayerStatus");

    ui.incBikeEl = document.getElementById("incBike");
    ui.incPedEl  = document.getElementById("incPed");
    ui.incCarEl  = document.getElementById("incCar");
    ui.incMotoEl = document.getElementById("incMoto");
    ui.incGkfzEl = document.getElementById("incGkfz");
    ui.incSonEl  = document.getElementById("incSon");

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
    ui.accidentViewSel = document.getElementById('accidentViewSel');
    ui.exportMapModeHintEl = document.getElementById('exportMapModeHint');

    // PR-D: Kontextfilter (Hangneigung / Verkehrsklasse / nur gematchte
    // Straßen). Die Sektion und Unter-Reihen sind initial hidden;
    // UA.refreshContextFilterVisibility() schaltet sie nur ein, wenn
    // die Stadt die jeweilige Capability trägt (siehe ctx.contextCapabilities).
    ui.ctxFilterSection      = document.getElementById('ctxFilterSection');
    ui.ctxFilterEmpty        = document.getElementById('ctxFilterEmpty');
    ui.ctxSlopeRow           = document.getElementById('ctxSlopeRow');
    ui.ctxTrafficRow         = document.getElementById('ctxTrafficRow');
    ui.ctxOnlyMatchedRow     = document.getElementById('ctxOnlyMatchedRow');
    ui.ctxOnlyMatchedEl      = document.getElementById('ctxOnlyMatched');
    ui.ctxSlopeChipEls       = ui.ctxFilterSection
      ? Array.from(ui.ctxFilterSection.querySelectorAll('input[data-ctx-slope]'))
      : [];
    ui.ctxTrafficChipEls     = ui.ctxFilterSection
      ? Array.from(ui.ctxFilterSection.querySelectorAll('input[data-ctx-traffic]'))
      : [];

    ctx.ui = ui;

    // QA-Härtung „Ladezustand": Build/Quelle erst sichtbar machen, wenn
    // beide echte Werte tragen. UA.BUILD ist beim Laden der Seite über
    // ein <meta>-Pendant + Inline-Script gesetzt; bei statischen Builds
    // ohne BUILD bleibt das Meta-Box hidden, statt einen Dauer-„-"-
    // Platzhalter zu zeigen.
    UA.maybeRevealMetaInfo(ctx);
  };

  /**
   * QA-Härtung „Ladezustand": Zeigt die Meta-Info-Box (Quelle/Build) nur
   * an, wenn beide Felder einen echten Wert haben. Wird sowohl direkt nach
   * `bindDom` als auch nach `loadCityData` aufgerufen — letzteres setzt
   * `dataSourceCode.textContent` auf die GeoJSON-URL.
   */
  UA.maybeRevealMetaInfo = function maybeRevealMetaInfo(ctx) {
    const ui = ctx && ctx.ui;
    if (!ui || !ui.metaInfoBox) return;
    const build = (UA.BUILD || "").trim();
    if (build && ui.buildInfo) ui.buildInfo.textContent = build;
    const source = (ui.dataSourceCode && ui.dataSourceCode.textContent || "").trim();
    const ready = !!build && !!source && source !== "-";
    ui.metaInfoBox.hidden = !ready;
  };

  /**
   * Render the "ⓘ Datenstand" tooltip in the city header / meta-info
   * box from the enrichment sidecar (item 10 of the post-PR #261
   * follow-up plan). Pure (no side effects beyond DOM toggling) and
   * idempotent — safe to call multiple times as ctx.contextLayerState
   * resolves asynchronously.
   *
   * Surfaces, in a single line per source: generation timestamp,
   * enrichment script version and per-source extractDate /
   * producerVersion / datasetVersion. Hides itself when no enrichment
   * meta is available so cities without enrichment don't grow a stale
   * placeholder.
   */
  UA.updateEnrichmentProvenance = function updateEnrichmentProvenance(ctx) {
    const ui = ctx && ctx.ui;
    if (!ui) return;
    const wrap = document.getElementById('enrichmentProvenance');
    const tip  = document.getElementById('enrichmentProvenanceTip');
    if (!wrap || !tip) return;

    const meta = ctx.contextLayerState && ctx.contextLayerState.meta;
    if (!meta || typeof meta !== 'object') {
      wrap.hidden = true;
      tip.setAttribute('title', '');
      tip.removeAttribute('aria-label');
      return;
    }

    const lines = [];
    if (meta.generatedAt)              lines.push('Erzeugt: ' + meta.generatedAt);
    if (meta.enrichmentScriptVersion)  lines.push('Enrichment-Skript: v' + meta.enrichmentScriptVersion);
    const sources = meta.sources || {};
    const fmtSource = (key, label) => {
      const s = sources[key];
      if (!s || typeof s !== 'object') return null;
      const parts = [];
      if (s.source)          parts.push(s.source);
      if (s.producerVersion) parts.push('Producer v' + s.producerVersion);
      if (s.extractDate)     parts.push(s.extractDate);
      if (s.datasetVersion)  parts.push('Dataset ' + s.datasetVersion);
      if (s.resolutionM)     parts.push(s.resolutionM + ' m');
      return label + ': ' + parts.join(', ');
    };
    const osmLine     = fmtSource('osm',     'OSM');
    const demLine     = fmtSource('dem',     'DEM');
    const trafficLine = fmtSource('traffic', 'Traffic');
    if (osmLine)     lines.push(osmLine);
    if (demLine)     lines.push(demLine);
    if (trafficLine) lines.push(trafficLine);

    if (lines.length === 0) {
      wrap.hidden = true;
      tip.setAttribute('title', '');
      tip.removeAttribute('aria-label');
      return;
    }
    const text = lines.join('\n');
    tip.setAttribute('title', text);
    // Mirror into aria-label so screen-readers that don't read `title`
    // on focus still announce the provenance when the user tabs to
    // the marker. (Browsers are inconsistent about announcing
    // `title`; aria-label is universal.)
    tip.setAttribute('aria-label', 'Datenstand: ' + lines.join('; '));
    wrap.hidden = false;
  };

  function setCollapsed(ctx, on){
    const ui = ctx.ui;
    ui.panelEl.classList.toggle('collapsed', on);
    ui.collapseBtn.textContent = on ? ">" : "v";
    ui.collapseBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
    ui.collapseBtn.setAttribute('aria-label', on ? 'Bedienfeld ausklappen' : 'Bedienfeld einklappen');
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
    const cf = ctx.contextFilters || {};
    const slopeStr   = cf.slopeClasses   ? Array.from(cf.slopeClasses).sort().join(",")   : "";
    const trafficStr = cf.trafficClasses ? Array.from(cf.trafficClasses).sort().join(",") : "";
    UA.setQS({
      city: ctx.CITY_RAW,
      severity: ui.severityEl.value,
      dayType: ui.dayTypeEl.value,
      roadCondition: ui.roadConditionEl.value,
      hourFrom: ui.hFromEl.value,
      hourTo: ui.hToEl.value,
      maxPoints: ui.maxPointsEl.value,
      viewportPaddingPct: ui.viewportPaddingEl.value,
      heatRadius: ui.heatRadiusEl.value,
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
      showSchools: ctx.showSchools ? 1 : 0,
      showKindergartens: ctx.showKindergartens ? 1 : 0,
      showArgumentation: ctx.showArgumentation ? 1 : 0,
      mapMode: ctx.mapMode || 'standard',
      orthophotoOpacity: Math.round((Number(ctx.orthophotoOpacity) || 0.92) * 100),
      // PR-D: Kontextfilter — leere Strings (kein Filter aktiv) werden
      // von UA.setQS automatisch aus der URL entfernt.
      ctxSlope:        slopeStr,
      ctxTraffic:      trafficStr,
      ctxOnlyMatched:  cf.onlyMatchedWays ? 1 : 0,
      // First-class context map overlays (slope/traffic). CSV; empty
      // string when no overlay is active. See UA.refreshContextOverlays
      // and UA.parseMapLayerCsv.
      mapLayer: (typeof UA.serializeMapLayerCsv === 'function')
        ? UA.serializeMapLayerCsv(ctx.contextOverlays && ctx.contextOverlays.active)
        : '',
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
    // QA-Härtung „Ladezustand": Liste ist da → aria-busy abräumen.
    ui.citySel.removeAttribute("aria-busy");
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

  /**
   * QA-Härtung „Ladezustand": Wird aufgerufen, wenn der GeoJSON-Datenfetch
   * (UA.loadCityData) scheitert. Setzt eine sichtbare Fehleroption am
   * Stadt-Dropdown und eine verständliche Stat-Meldung, damit Nutzer:innen
   * den Zustand ohne Browser-Konsole erkennen.
   */
  UA.markCityDropdownError = function markCityDropdownError(ctx, message) {
    const ui = ctx && ctx.ui;
    if (!ui || !ui.citySel) return;
    ui.citySel.removeAttribute("aria-busy");
    // Erste Option durch eine sichtbare Fehleroption ersetzen, damit User
    // den Zustand sehen ohne Console öffnen zu müssen.
    const opt = document.createElement("option");
    opt.value = "";
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = message || "Daten konnten nicht geladen werden";
    ui.citySel.insertBefore(opt, ui.citySel.firstChild);
    if (ui.statEl) {
      ui.statEl.textContent =
        "Daten konnten nicht geladen werden. Bitte später erneut versuchen oder Quelle prüfen.";
    }
  };

  UA.bindUi = function bindUi(ctx){
    const ui = ctx.ui;

    // panel collapse + legend
    const savedCollapsed = (() => { try { return localStorage.getItem("ua_panel_collapsed"); } catch { return null; } })();
    if (savedCollapsed === "1") setCollapsed(ctx, true);

    ui.collapseBtn.addEventListener('click', () => setCollapsed(ctx, !ui.panelEl.classList.contains('collapsed')));
    ui.legendBtn.addEventListener('click', () => {
      const expanded = ui.legendBox.style.display !== "block";
      ui.legendBox.style.display = expanded ? "block" : "none";
      ui.legendBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      ui.legendBtn.setAttribute('aria-label', expanded ? 'Legende ausblenden' : 'Legende einblenden');
    });

    // defaults from URL
    ui.severityEl.value = UA.qGet("severity","all");
    ui.dayTypeEl.value = UA.qGet("dayType","all");
    ui.roadConditionEl.value = UA.qGet("roadCondition","all");

    ui.hFromEl.value = String(Math.max(0, Math.min(23, parseInt(UA.qGet("hourFrom","0"),10)||0)));
    ui.hToEl.value   = String(Math.max(0, Math.min(23, parseInt(UA.qGet("hourTo","23"),10)||23)));
    ui.maxPointsEl.value = String(Math.max(500, Math.min(200000, parseInt(UA.qGet("maxPoints","100000"),10)||100000)));
    ui.viewportPaddingEl.value = String(Math.max(0, Math.min(100, parseInt(UA.qGet("viewportPaddingPct","20"),10)||20)));
    ui.heatRadiusEl.value = String(Math.max(5, Math.min(60, parseInt(UA.qGet("heatRadius","25"),10)||25)));
    ctx.mapMode = (typeof UA.resolveMapMode === "function")
      ? UA.resolveMapMode(UA.qGet("mapMode", ctx.mapMode || "standard"))
      : (ctx.mapMode || "standard");
    ctx.orthophotoOpacity = (typeof UA.normalizeMapOpacity === "function")
      ? UA.normalizeMapOpacity((UA.qNum("orthophotoOpacity", Math.round((ctx.orthophotoOpacity || 0.92) * 100)) || 92) / 100, ctx.orthophotoOpacity || 0.92)
      : (ctx.orthophotoOpacity || 0.92);

    ui.incBikeEl.checked = UA.qBool("includeCyclist", true);
    ui.incPedEl.checked  = UA.qBool("includePedestrian", true);
    ui.incCarEl.checked  = UA.qBool("includeCar", true);
    ui.incMotoEl.checked = UA.qBool("includeMotorcycle", false);
    if (ui.incGkfzEl) ui.incGkfzEl.checked = UA.qBool("includeGkfz", false);
    if (ui.incSonEl)  ui.incSonEl.checked  = UA.qBool("includeSonstig", false);

    ctx.involvementMode = UA.qGet("involvementMode", ctx.involvementMode || "or");
    ctx.showCluster = UA.qBool("showCluster", true);
    ctx.showHeatmap = UA.qBool("showHeatmap", true);
    ctx.showOnlyAboveAverage = UA.qBool("showOnlyAboveAverage", false);
    ctx.showSchools = UA.qBool("showSchools", true);
    ctx.showKindergartens = UA.qBool("showKindergartens", true);
    ctx.showArgumentation = UA.qBool("showArgumentation", true);

    UA.setBtnState(ui.btnModeOr, ctx.involvementMode==="or");
    UA.setBtnState(ui.btnModeAnd, ctx.involvementMode==="and");
    UA.setBtnState(ui.btnModeSolo, ctx.involvementMode==="solo");

    UA.setBtnState(ui.btnCluster, ctx.showCluster);
    UA.setBtnState(ui.btnHeat, ctx.showHeatmap);
    UA.setBtnState(ui.btnOnlyHot, ctx.showOnlyAboveAverage);
    UA.syncMapModeButtons(ctx);
    UA.syncOrthophotoOpacityUi(ctx);
    UA.renderMapLayerStatus(ctx);

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
      // QA-Härtung „Fehlerhandling": ungültige sel*-Parameter (NaN,
      // verkehrte Reihenfolge, außerhalb gültiger Lat/Lon-Range
      // ±90/±180) werden ignoriert statt einen leeren oder
      // gespiegelten Selektionsbereich zu zeichnen. Reicht den Fall
      // „URL enthält Quatsch" sauber durch (Defaults greifen, kein
      // Crash). Eine engere Deutschland-Bounding-Box wird hier
      // bewusst nicht erzwungen, damit grenznahe Bezirke und
      // Tests/Beispieldaten außerhalb DE nicht versehentlich
      // verworfen werden.
      const allFinite = [s,w,n,e].every(x => x!==null && Number.isFinite(x));
      const inLatRange = allFinite && s >= -90 && n <= 90 && s < n;
      const inLonRange = allFinite && w >= -180 && e <= 180 && w < e;
      if (allFinite && inLatRange && inLonRange) {
        ctx.selectionBounds = L.latLngBounds([s,w],[n,e]);
        ctx.drawnItems.clearLayers();
        ctx.drawnItems.addLayer(L.rectangle(ctx.selectionBounds, {color:"#2b7cff", weight:2, fillOpacity:0.06}));
      } else {
        console.warn("Ungültige sel*-Parameter in URL ignoriert:", { s, w, n, e });
      }
    }

    // changes
    for (const el of [ui.severityEl, ui.dayTypeEl, ui.roadConditionEl, ui.maxPointsEl, ui.viewportPaddingEl, ui.heatRadiusEl]) {
      el.addEventListener("change", ()=>{ UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });
    }
    for (const el of [ui.incBikeEl, ui.incPedEl, ui.incCarEl, ui.incMotoEl, ui.incGkfzEl, ui.incSonEl].filter(Boolean)) {
      el.addEventListener("change", ()=>{ UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });
    }

    ui.hFromEl.addEventListener("input", ()=>{ UA.syncHourUI(ctx, "from"); UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });
    ui.hToEl.addEventListener("input", ()=>{ UA.syncHourUI(ctx, "to"); UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); });

    ui.btnModeOr.addEventListener("click", ()=> { ctx.involvementMode="or"; UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); UA.setBtnState(ui.btnModeOr,true); UA.setBtnState(ui.btnModeAnd,false); UA.setBtnState(ui.btnModeSolo,false);} );
    ui.btnModeAnd.addEventListener("click", ()=> { ctx.involvementMode="and"; UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); UA.setBtnState(ui.btnModeOr,false); UA.setBtnState(ui.btnModeAnd,true); UA.setBtnState(ui.btnModeSolo,false);} );
    ui.btnModeSolo.addEventListener("click", ()=> { ctx.involvementMode="solo"; UA.syncAllToUrl(ctx); UA.recomputeAndRender(ctx); UA.setBtnState(ui.btnModeOr,false); UA.setBtnState(ui.btnModeAnd,false); UA.setBtnState(ui.btnModeSolo,true);} );

    const bindMapMode = (btn, mode) => {
      if (!btn) return;
      btn.addEventListener("click", () => {
        ctx.mapMode = mode;
        if (typeof UA.applyMapMode === "function") UA.applyMapMode(ctx);
        UA.syncMapModeButtons(ctx);
        UA.syncAllToUrl(ctx);
        UA.renderMapLayerStatus(ctx);
      });
    };
    bindMapMode(ui.mapModeStandardBtn, "standard");
    bindMapMode(ui.mapModeOrthophotoBtn, "orthophoto");
    bindMapMode(ui.mapModeHybridBtn, "hybrid");
    bindMapMode(ui.mapModeAnalysisBtn, "analysis");
    if (ui.orthophotoOpacityEl) {
      ui.orthophotoOpacityEl.addEventListener("input", () => {
        const raw = (parseInt(ui.orthophotoOpacityEl.value, 10) || 92) / 100;
        ctx.orthophotoOpacity = (typeof UA.normalizeMapOpacity === "function")
          ? UA.normalizeMapOpacity(raw, ctx.orthophotoOpacity || 0.92)
          : raw;
        UA.syncOrthophotoOpacityUi(ctx);
        if (typeof UA.applyMapMode === "function") UA.applyMapMode(ctx);
        UA.syncAllToUrl(ctx);
        UA.renderMapLayerStatus(ctx);
      });
    }

    ui.btnCluster.addEventListener("click", ()=>{
      ctx.showCluster = !ctx.showCluster;
      UA.setBtnState(ui.btnCluster, ctx.showCluster);
      UA.syncAllToUrl(ctx);
      if (typeof UA.syncLegendButtons === 'function') UA.syncLegendButtons(ctx);
      // Dispatch through the MapStore/RenderScheduler when available so
      // that stale renders are dropped via epoch tracking.
      if (ctx.store) { ctx.store.dispatch('layerToggled'); }
      else { ctx._dataChanged = true; UA.renderLayers(ctx); }
    });
    ui.btnHeat.addEventListener("click", ()=>{
      ctx.showHeatmap = !ctx.showHeatmap;
      UA.setBtnState(ui.btnHeat, ctx.showHeatmap);
      UA.syncAllToUrl(ctx);
      if (typeof UA.syncLegendButtons === 'function') UA.syncLegendButtons(ctx);
      if (ctx.store) { ctx.store.dispatch('layerToggled'); }
      else { ctx._dataChanged = true; UA.renderLayers(ctx); }
    });
    ui.btnOnlyHot.addEventListener("click", ()=>{
      ctx.showOnlyAboveAverage = !ctx.showOnlyAboveAverage;
      UA.setBtnState(ui.btnOnlyHot, ctx.showOnlyAboveAverage);
      UA.syncAllToUrl(ctx);
      if (ctx.store) { ctx.store.dispatch('layerToggled'); }
      else { ctx._dataChanged = true; UA.renderLayers(ctx); }
    });

    // PR-D: Kontextfilter — Hydration aus URL + Listener. Die Sektion
    // selbst bleibt hidden, bis nach dem Daten-Load
    // UA.refreshContextFilterVisibility(ctx) sie für die jeweils
    // unterstützten Felder freischaltet.
    UA.initContextFilters(ctx);
    for (const el of ui.ctxSlopeChipEls) {
      el.addEventListener("change", () => {
        UA.readContextFilterChips(ctx);
        UA.syncAllToUrl(ctx);
        UA.recomputeAndRender(ctx);
      });
    }
    for (const el of ui.ctxTrafficChipEls) {
      el.addEventListener("change", () => {
        UA.readContextFilterChips(ctx);
        UA.syncAllToUrl(ctx);
        UA.recomputeAndRender(ctx);
      });
    }
    if (ui.ctxOnlyMatchedEl) {
      ui.ctxOnlyMatchedEl.addEventListener("change", () => {
        UA.readContextFilterChips(ctx);
        UA.syncAllToUrl(ctx);
        UA.recomputeAndRender(ctx);
      });
    }

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

  UA.syncMapModeButtons = function syncMapModeButtons(ctx) {
    const ui = ctx && ctx.ui;
    if (!ui) return;
    const mode = (typeof UA.resolveMapMode === "function")
      ? UA.resolveMapMode(ctx.mapMode)
      : (ctx.mapMode || "standard");
    UA.setBtnState(ui.mapModeStandardBtn, mode === "standard");
    UA.setBtnState(ui.mapModeOrthophotoBtn, mode === "orthophoto");
    UA.setBtnState(ui.mapModeHybridBtn, mode === "hybrid");
    UA.setBtnState(ui.mapModeAnalysisBtn, mode === "analysis");
  };

  UA.syncOrthophotoOpacityUi = function syncOrthophotoOpacityUi(ctx) {
    const ui = ctx && ctx.ui;
    if (!ui || !ui.orthophotoOpacityEl || !ui.orthophotoOpacityLbl) return;
    const fallbackRaw = Number(ctx && ctx.orthophotoOpacity);
    const fallbackOpacity = Number.isFinite(fallbackRaw) ? Math.max(0, Math.min(1, fallbackRaw)) : 0.92;
    const opacity = (typeof UA.normalizeMapOpacity === "function")
      ? UA.normalizeMapOpacity(ctx.orthophotoOpacity, 0.92)
      : fallbackOpacity;
    const percent = Math.round(opacity * 100);
    ui.orthophotoOpacityEl.value = String(percent);
    ui.orthophotoOpacityLbl.textContent = `${percent} %`;
  };

  UA.renderMapLayerStatus = function renderMapLayerStatus(ctx) {
    const ui = ctx && ctx.ui;
    if (!ui) return;
    const info = (typeof UA.getActiveMapLayerInfo === "function")
      ? UA.getActiveMapLayerInfo(ctx)
      : null;
    const defaultText = "Standardkarte aktiv.";
    const lines = [];
    if (!info) {
      lines.push(defaultText);
    } else {
      lines.push(`Kartenmodus: ${info.modeLabel || "Standardkarte"}.`);
      if (info.orthophoto) {
        lines.push(`Orthofoto: ${info.orthophoto.displayName} (${info.orthophoto.provider}).`);
        if (info.orthophotoFallbackFrom) {
          lines.push(`Fallback aktiv statt ${info.orthophotoFallbackFrom.displayName}.`);
        }
        if (info.orthophoto.license) {
          lines.push(`Lizenz: ${info.orthophoto.license}.`);
        }
      } else {
        lines.push("Kein Orthofoto aktiv.");
      }
      if (info.warning) lines.push(info.warning);
    }
    const text = lines.join(" ");
    if (ui.mapLayerStatusEl) ui.mapLayerStatusEl.textContent = text;
    if (ui.exportMapModeHintEl) {
      ui.exportMapModeHintEl.textContent = `Word/PDF übernehmen diesen Kartenmodus. ${text}`;
    }
  };

  // ---------------------------------------------------------------------------
  // PR-D: Kontextfilter helpers
  // ---------------------------------------------------------------------------

  // Allowed values mirror SLOPE_CLASS_THRESHOLDS / TRAFFIC_PROXY_THRESHOLDS in
  // scripts/enrich_geojson.js. Anything outside this set is silently dropped
  // when hydrating from the URL — so a stale querystring from an older app
  // version cannot enable a filter that doesn't exist anymore.
  const SLOPE_CLASS_VALUES   = new Set(["flat","gentle","moderate","steep","very_steep"]);
  const TRAFFIC_CLASS_VALUES = new Set(["low","medium","high","very_high"]);

  function parseCsvSet(raw, allowed) {
    if (!raw) return new Set();
    return new Set(String(raw).split(",").map(s => s.trim()).filter(s => allowed.has(s)));
  }

  /**
   * Initialise ctx.contextFilters from the URL and apply the resulting
   * checkbox state to the DOM. Idempotent — safe to call multiple times.
   */
  UA.initContextFilters = function initContextFilters(ctx){
    const ui = ctx.ui || {};
    const slopeSel   = parseCsvSet(UA.qGet("ctxSlope", ""),   SLOPE_CLASS_VALUES);
    const trafficSel = parseCsvSet(UA.qGet("ctxTraffic", ""), TRAFFIC_CLASS_VALUES);
    const onlyMatched = UA.qBool("ctxOnlyMatched", false);

    ctx.contextFilters = {
      slopeClasses:    slopeSel,
      trafficClasses:  trafficSel,
      onlyMatchedWays: onlyMatched,
    };

    for (const el of ui.ctxSlopeChipEls || []) {
      el.checked = slopeSel.has(el.dataset.ctxSlope);
    }
    for (const el of ui.ctxTrafficChipEls || []) {
      el.checked = trafficSel.has(el.dataset.ctxTraffic);
    }
    if (ui.ctxOnlyMatchedEl) ui.ctxOnlyMatchedEl.checked = onlyMatched;
  };

  /** Read the current checkbox state into ctx.contextFilters. */
  UA.readContextFilterChips = function readContextFilterChips(ctx){
    const ui = ctx.ui || {};
    const slope   = new Set();
    const traffic = new Set();
    for (const el of ui.ctxSlopeChipEls || []) {
      if (el.checked && SLOPE_CLASS_VALUES.has(el.dataset.ctxSlope)) slope.add(el.dataset.ctxSlope);
    }
    for (const el of ui.ctxTrafficChipEls || []) {
      if (el.checked && TRAFFIC_CLASS_VALUES.has(el.dataset.ctxTraffic)) traffic.add(el.dataset.ctxTraffic);
    }
    ctx.contextFilters = {
      slopeClasses:    slope,
      trafficClasses:  traffic,
      onlyMatchedWays: !!(ui.ctxOnlyMatchedEl && ui.ctxOnlyMatchedEl.checked),
    };
  };

  /**
   * Show/hide the "Kontext-Filter (Detailanalyse)" section and its
   * sub-rows based on which capabilities the loaded city actually
   * carries
   * (ctx.contextCapabilities, populated by ua.data_v2.loadCityData via
   * UA.contextLayers.capabilitiesFromDetection). When a row is hidden,
   * its filter is also reset so we don't leak a hidden restriction.
   * Safe to call multiple times (e.g. after an in-place city switch);
   * idempotent.
   */
  UA.refreshContextFilterVisibility = function refreshContextFilterVisibility(ctx){
    const ui   = ctx.ui || {};
    const caps = ctx.contextCapabilities || {};
    const sec  = ui.ctxFilterSection;
    if (!sec) return;

    const showSlope   = !!caps.hasSlope;
    const showTraffic = !!caps.hasTrafficProxy;
    const showMatched = !!caps.hasOsmContext;
    const showAny     = showSlope || showTraffic || showMatched;
    // Empty-state: when *no* relevant context capability is present
    // (i.e. neither slope, nor traffic, nor matched-only OSM), the
    // section now stays *visible* so we can show a one-line hint
    // explaining that this city has no enriched context data,
    // instead of the section silently disappearing (which previously
    // looked like a bug to first-time users). When hasOsmContext is
    // true (matched-only toggle visible), the toggle itself is the
    // meaningful UI and the empty-state hint must NOT appear, even
    // if slope/traffic are absent.
    const showEmpty   = !showSlope && !showTraffic && !showMatched;

    sec.hidden = !(showAny || showEmpty);
    if (ui.ctxFilterEmpty)    ui.ctxFilterEmpty.hidden    = !showEmpty;
    if (ui.ctxSlopeRow)       ui.ctxSlopeRow.hidden       = !showSlope;
    if (ui.ctxTrafficRow)     ui.ctxTrafficRow.hidden     = !showTraffic;
    if (ui.ctxOnlyMatchedRow) ui.ctxOnlyMatchedRow.hidden = !showMatched;

    const cf = ctx.contextFilters || (ctx.contextFilters = { slopeClasses: new Set(), trafficClasses: new Set(), onlyMatchedWays: false });
    let mutated = false;
    if (!showSlope && cf.slopeClasses && cf.slopeClasses.size) {
      cf.slopeClasses = new Set(); mutated = true;
      for (const el of ui.ctxSlopeChipEls || []) el.checked = false;
    }
    if (!showTraffic && cf.trafficClasses && cf.trafficClasses.size) {
      cf.trafficClasses = new Set(); mutated = true;
      for (const el of ui.ctxTrafficChipEls || []) el.checked = false;
    }
    if (!showMatched && cf.onlyMatchedWays) {
      cf.onlyMatchedWays = false; mutated = true;
      if (ui.ctxOnlyMatchedEl) ui.ctxOnlyMatchedEl.checked = false;
    }
    if (mutated && typeof UA.syncAllToUrl === 'function') UA.syncAllToUrl(ctx);
  };

})();
