(() => {
  const UA = (window.UA = window.UA || {});

  UA.recomputeAndRender = function recomputeAndRender(ctx){
    UA.applyFilters(ctx);
    UA.applyViewportFilter(ctx);
    ctx._dataChanged = true; // Mark data as changed when filters are applied
    UA.renderLayers(ctx);
    UA.saveCityState(ctx);
  };

  UA.scheduleViewportUpdate = function scheduleViewportUpdate(ctx, isZoom){
    if (!ctx.allPts?.length) return;
    if (ctx._moveTimer) clearTimeout(ctx._moveTimer);
    
    // Use longer debounce for smoother performance
    ctx._moveTimer = setTimeout(() => {
      if (ctx._rafId) cancelAnimationFrame(ctx._rafId);
      ctx._rafId = requestAnimationFrame(() => {
        UA.applyViewportFilter(ctx);
        // Always rebuild layers when viewport changes to ensure new areas are loaded
        // Mark that viewport changed (not a filter change) to rebuild with new data
        ctx._dataChanged = true;
        UA.renderLayers(ctx);
        UA.syncViewToUrl(ctx);
      });
    }, 350);
  };

  async function writeClipboard(text){
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, 999999);
      try { document.execCommand("copy"); } catch {}
      ta.remove();
      return false;
    }
  }

  function bindExport(ctx){
    const ui = ctx.ui;

    function openModal(){
      ui.modalOverlay.style.display = "flex";
      // QA-Härtung „Export-Dialog": Hinweis „kein Bereich markiert"
      // dynamisch ein-/ausblenden, abhängig vom aktuellen ctx-Zustand.
      const hint = document.getElementById("noSelectionHint");
      if (hint) hint.hidden = !!ctx.selectionBounds;
    }
    function closeModal(){ ui.modalOverlay.style.display = "none"; }

    ui.btnCloseModal.addEventListener('click', closeModal);
    ui.modalOverlay.addEventListener('click', (e)=>{ if (e.target === ui.modalOverlay) closeModal(); });

    // Returns true on a successful render, false if report generation failed.
    // Callers use the return value to decide whether to persist export-related
    // URL state (the failure path renders an error placeholder, not a real
    // report, so the URL shouldn't claim "export=1" in that case).
    async function rerenderExportReport(){
      ui.exportProgress.textContent = "Report wird erzeugt…";
      ui.exportHtml.innerHTML = `<div style="color:#666; font-size:12px;">(Report wird erzeugt…)</div>`;
      ui.exportBoxTa.value = "…";
      await new Promise(r=>setTimeout(r,0));
      try {
        // Mirror modal toggles into ctx.exportOptions so computeExportReport
        // can decide which optional sections to include in the preview.
        const cbCosts    = document.getElementById("cbIncludeCosts");
        const cbMeasures = document.getElementById("cbIncludeMeasures");
        const cbHeatmap  = document.getElementById("cbIncludeHeatmap");
        const cbOsm      = document.getElementById("cbIncludeOsmContext");
        const cbPol      = document.getElementById("cbPoliticalLanguage");
        ctx.exportOptions = Object.assign({}, ctx.exportOptions, {
          includeCosts:      cbCosts    ? cbCosts.checked    : true,
          includeMeasures:   cbMeasures ? cbMeasures.checked : true,
          includeHeatmap:    cbHeatmap  ? cbHeatmap.checked  : true,
          includeOsmContext: cbOsm      ? cbOsm.checked      : true,
          // Task 10: "Politische Sprache" – Faktoren in Bänder übersetzen,
          // 95%-KI im Modus ausblenden. Default aus (technisch).
          mode: (cbPol && cbPol.checked) ? "political" : "technical"
        });
        const r = await UA.computeExportReport(ctx);
        ui.exportProgress.textContent = "Fertig.";
        ui.exportHtml.innerHTML = r.html;
        ui.exportBoxTa.value = r.text;
        const modalTitleEl = document.querySelector('#modalOverlay .modalTitle');
        if (modalTitleEl && r.structured && r.structured.meta && r.structured.meta.gremium) {
          const gremiumTyp = r.structured.meta.gremium.typ;
          if (gremiumTyp) {
            modalTitleEl.textContent = UA.deriveDocTitle ? UA.deriveDocTitle(gremiumTyp) : gremiumTyp;
          }
        }
        return true;
      } catch (e) {
        ui.exportProgress.textContent = "Fehler.";
        ui.exportHtml.innerHTML = `<div style="color:#b00; font-weight:900;">Export fehlgeschlagen</div><div>${UA.escHtml(String(e))}</div>`;
        ui.exportBoxTa.value = "Export fehlgeschlagen: " + String(e);
        return false;
      }
    }

    // Bind the accident-view selector: switching the strategy re-renders the report
    // (HTML preview + text-to-copy) and persists the choice as a URL param.
    if (ui.accidentViewSel) {
      const initial = ctx.accidentView || (UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");
      ui.accidentViewSel.value = initial;
      ui.accidentViewSel.addEventListener('change', () => {
        const v = ui.accidentViewSel.value || (UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");
        ctx.accidentView = v;
        UA.setQS({ accidentView: v });
        // Only re-render if the modal is visible (user is looking at the report).
        if (ui.modalOverlay.style.display === "flex") {
          rerenderExportReport();
        }
      });
    }

    // Re-render preview when cost / measures toggles change (only while modal open).
    const _wireToggleRerender = (id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('change', () => {
        if (ui.modalOverlay.style.display === "flex") rerenderExportReport();
      });
    };
    _wireToggleRerender("cbIncludeCosts");
    _wireToggleRerender("cbIncludeMeasures");
    _wireToggleRerender("cbIncludeHeatmap");
    _wireToggleRerender("cbIncludeOsmContext");
    _wireToggleRerender("cbPoliticalLanguage");

    ui.btnCopyText.addEventListener("click", async ()=> {
      await writeClipboard(ui.exportBoxTa.value || "");
      alert("Kopiert.");
    });
    ui.btnCopyLink.addEventListener("click", async ()=> {
      const url = UA.setQS({ export: 1 });
      await writeClipboard(url);
      alert("Link kopiert.");
    });

    ui.btnOpenExport.addEventListener("click", async ()=> {
      openModal();
      const renderSucceeded = await rerenderExportReport();
      // Persist the export marker in the URL only after a successful render —
      // otherwise the URL would claim "export=1" while the modal actually
      // shows an error placeholder.
      if (renderSucceeded) {
        try { UA.setQS({ export: 1 }); } catch {}
      }
    });

    const btnExportCSV = document.getElementById("btnExportCSV");
    const btnExportGeoJSON = document.getElementById("btnExportGeoJSON");
    const btnExportKML = document.getElementById("btnExportKML");

    if (btnExportCSV) {
      btnExportCSV.addEventListener("click", () => {
        try { UA.exportToCSV(ctx); }
        catch (e) { alert("CSV-Export fehlgeschlagen: " + String(e)); }
      });
    }
    if (btnExportGeoJSON) {
      btnExportGeoJSON.addEventListener("click", () => {
        try { UA.exportToGeoJSON(ctx); }
        catch (e) { alert("GeoJSON-Export fehlgeschlagen: " + String(e)); }
      });
    }
    if (btnExportKML) {
      btnExportKML.addEventListener("click", () => {
        try { UA.exportToKML(ctx); }
        catch (e) { alert("KML-Export fehlgeschlagen: " + String(e)); }
      });
    }

    // KI-Antragsentwurf (#E1) — Frontend-Aufruf des serverseitigen
    // /api/ai/export-assessment/v2-Endpoints. Die KI-Logik bleibt im
    // Docker-Image (server/ai/), hier nur Aufruf + Anzeige.
    if (UA.aiProposal && typeof UA.aiProposal.wire === "function") {
      try { UA.aiProposal.wire(ctx); }
      catch (e) { console.warn("aiProposal.wire failed:", e); }
    }
  }

  async function main(){
    const ctx = {
      CITY_RAW: (UA.qGet("city","Hannover") || "Hannover").trim(),
      DATA_URL: "",
      allPts: [],
      filteredAll: [],
      filteredCapped: [],
      viewportPts: [],
      baselineCounts: null,
      involvementMode: "or",
      showCluster: true,
      showHeatmap: true,
      showOnlyAboveAverage: false,
      showSchools: true,
      showKindergartens: true,
      showArgumentation: true
    };
    if (UA.cleanUrlIfNeeded()) return;

    // QA-Härtung „URL = Source of Truth": Während der Init-Phase
    // wird die URL ausschliesslich GELESEN. Schreibwege (UA.setQS aus
    // bindUi/syncAllToUrl/syncViewToUrl/recomputeAndRender→saveCityState)
    // werden über UA._hydrating unterdrückt. Nach dem ersten
    // recomputeAndRender wird die URL einmal gezielt normalisiert
    // (siehe Block am Ende dieser Funktion). So kann es weder zu
    // konkurrierenden setState-Aufrufen während des Daten-Ladens
    // kommen noch zu unbeabsichtigten History-Einträgen.
    if (typeof UA.setHydrating === "function") UA.setHydrating(true);
    try {

    // Read layer visibility from URL before initLeaflet, because
    // addLayerLegend (called inside initLeaflet) uses these values
    // to set the initial CSS class on legend buttons.
    ctx.showCluster = UA.qBool("showCluster", true);
    ctx.showHeatmap = UA.qBool("showHeatmap", true);
    ctx.showOnlyAboveAverage = UA.qBool("showOnlyAboveAverage", false);
    ctx.showSchools = UA.qBool("showSchools", true);
    ctx.showKindergartens = UA.qBool("showKindergartens", true);
    ctx.showArgumentation = UA.qBool("showArgumentation", true);
    // Accident-view strategy (URL ?accidentView=bySeverity|byInvolvement|flat)
    {
      const v = UA.qGet("accidentView", UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");
      ctx.accidentView = (UA.accidentViews && UA.accidentViews[v]) ? v : (UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");
    }

    UA.bindDom(ctx);
    UA.initLeaflet(ctx);

    // Cities — UA.loadCitiesList fängt Lade-Fehler intern ab und liefert
    // eine Fallback-Liste mit der aktuell aktiven Stadt, daher kein
    // try/catch hier nötig.
    const cities = await UA.loadCitiesList(ctx);
    UA.setCityDropdown(ctx, cities);

    // data — bei Fehler eine verständliche Meldung anzeigen statt
    // unkommentiert in den globalen catch-Pfad zu fallen (QA-Härtung
    // „Ladezustand"). Wir werfen dennoch weiter, damit das `main()`-catch
    // greifen kann; vorher wird der UI-Zustand sauber gesetzt.
    try {
      await UA.loadCityData(ctx);
    } catch (e) {
      if (typeof UA.markCityDropdownError === "function") {
        UA.markCityDropdownError(ctx,
          "Daten konnten nicht geladen werden. Bitte später erneut versuchen oder Quelle prüfen.");
      }
      throw e;
    }
    // Build/Quelle erst jetzt anzeigen — dataSourceCode wurde von
    // loadCityData gesetzt, BUILD ist seit Seitenstart bekannt.
    if (typeof UA.maybeRevealMetaInfo === "function") UA.maybeRevealMetaInfo(ctx);

    // POI data (optional, fail-safe)
    await UA.loadPOIData(ctx);

    // if no URL view and no state: fit
    if (!UA.viewParamsPresent()) {
      const hadState = UA.restoreCityStateIfNoUrlView(ctx);
      if (!hadState) UA.fitToAllPoints(ctx);
      // if selectionBounds restored: draw it
      if (ctx.selectionBounds) {
        ctx.drawnItems.clearLayers();
        ctx.drawnItems.addLayer(L.rectangle(ctx.selectionBounds, {color:"#2b7cff", weight:2}));
      }
    }



    UA.bindUi(ctx);
    // PR-D: After URL/DOM hydration, reveal context filter section based
    // on capabilities detected during loadCityData. Idempotent — also
    // re-runnable after an in-place city switch.
    if (typeof UA.refreshContextFilterVisibility === 'function') {
      UA.refreshContextFilterVisibility(ctx);
    }
    // First-class context map overlays (Straßensteigung /
    // Verkehrsbelastung). Hydrate the desired state from the URL
    // *before* refreshContextOverlays builds the controls, so a
    // shared link with `?mapLayer=slope,traffic` shows the overlays
    // immediately. Default is "all off"; the controls themselves only
    // appear when the city carries the corresponding capability.
    if (typeof UA.parseMapLayerCsv === 'function') {
      const desired = UA.parseMapLayerCsv(UA.qGet('mapLayer', ''));
      ctx.contextOverlays = ctx.contextOverlays || { active: { slope: false, traffic: false }, layers: { slope: null, traffic: null }, layerControl: null, legendControl: null };
      ctx.contextOverlays.active.slope   = !!desired.slope;
      ctx.contextOverlays.active.traffic = !!desired.traffic;
    }
    if (typeof UA.refreshContextOverlays === 'function') {
      UA.refreshContextOverlays(ctx);
    }
    bindExport(ctx);

    // Initialize tour module (gracefully degraded – only if ua.tour.js is loaded)
    if (typeof UA.initTour === "function") {
      UA.initTour(ctx);
    }

    // Initialize report export UI for V2 (Word/PDF) if available
    if (typeof UA.initReportExportUI === "function") {
      UA.initReportExportUI(ctx);
    }

    // Initialize political context research module (fail-safe)
    if (UA.PoliticalContext && typeof UA.PoliticalContext.init === "function") {
      UA.PoliticalContext.init(ctx);
    }

    // Initialize priorities panel (Top-N, gespeicherte Briefs) – fail-safe.
    // Hängt nicht an Karten-/Export-Logik; wenn das Modul fehlt, passiert nichts.
    if (UA.Priorities && typeof UA.Priorities.init === "function") {
      UA.Priorities.init(ctx);
    }

    // map events - separate pan vs zoom handling
    ctx.map.on("moveend", () => UA.scheduleViewportUpdate(ctx, false));
    ctx.map.on("zoomend", () => UA.scheduleViewportUpdate(ctx, true));

    UA.recomputeAndRender(ctx);



// nachdem ui gebaut ist, map existiert, ctx gesetzt ist:
if (UA.Export && typeof UA.Export.init === "function") {
  UA.Export.init({ ctx, ui: ctx.ui, map: ctx.map });
}

// optional: wenn export=1 in URL -> direkt öffnen
if (UA.qBool("export", false)) {
  setTimeout(() => ctx.ui.btnOpenExport.click(), 200);
}

    // auto open export
    } finally {
      // QA-Härtung „URL = Source of Truth": Hydration-Phase beenden
      // und URL EINMAL gezielt aus dem hydrierten ctx-Zustand
      // normalisieren. Damit ist die URL nach `main()` deterministisch
      // genau dann gleich, wenn der UI-Zustand gleich ist – und ein
      // zweiter Reload mit derselben URL erzeugt denselben UI-Zustand
      // und dieselbe URL (Idempotenz).
      if (typeof UA.setHydrating === "function") UA.setHydrating(false);
      try {
        if (ctx && ctx.ui && typeof UA.syncAllToUrl === "function") {
          UA.syncAllToUrl(ctx);
        }
      } catch (e) {
        // Bewusst geschluckt: ein fehlgeschlagener Normalisierungs-
        // Schreibvorgang darf den App-Start nicht verhindern.
        console.warn("URL-Normalisierung nach Hydration fehlgeschlagen:", e);
      }
    }
  }

  main().catch(err => {
    console.error(err);
    // QA-Härtung „URL = Source of Truth": auch im Fehlerpfad das
    // Hydration-Flag sicher abräumen, damit nachgelagerte UI-Events
    // (Retry, manuelle Bedienelemente) wieder in die URL schreiben
    // können. Bewusst geschluckt: ein gescheitertes Cleanup darf das
    // Anzeigen der Fehlermeldung unten nicht verhindern.
    try { if (typeof UA.setHydrating === "function") UA.setHydrating(false); }
    catch (cleanupErr) { console.warn("setHydrating(false) im catch fehlgeschlagen:", cleanupErr); }
    try {
      const statEl = document.getElementById("stat");
      if (statEl) {
        // QA-Härtung „Ladezustand": Statt der rohen Exception eine
        // verständliche Fehlermeldung anzeigen. Die Originalmeldung
        // bleibt in der Konsole für Entwickler.
        statEl.textContent =
          "Daten konnten nicht geladen werden. Bitte später erneut versuchen oder Quelle prüfen.";
        statEl.setAttribute("role", "alert");
      }
    } catch (uiErr) {
      // Bewusst geschluckt: wenn nicht einmal das DOM erreichbar ist,
      // gibt es keinen sinnvollen Anzeige-Pfad mehr; die ursprüngliche
      // Exception wurde bereits oben in die Konsole geschrieben.
      console.warn("Anzeige der Fehlermeldung fehlgeschlagen:", uiErr);
    }
  });
})();
