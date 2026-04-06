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

    function openModal(){ ui.modalOverlay.style.display = "flex"; }
    function closeModal(){ ui.modalOverlay.style.display = "none"; }

    ui.btnCloseModal.addEventListener('click', closeModal);
    ui.modalOverlay.addEventListener('click', (e)=>{ if (e.target === ui.modalOverlay) closeModal(); });

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
      ui.exportProgress.textContent = "Report wird erzeugt…";
      ui.exportHtml.innerHTML = `<div style="color:#666; font-size:12px;">(Report wird erzeugt…)</div>`;
      ui.exportBoxTa.value = "…";
      await new Promise(r=>setTimeout(r,0));

      try {
        const r = await UA.computeExportReport(ctx);
        ui.exportProgress.textContent = "Fertig.";
        ui.exportHtml.innerHTML = r.html;
        ui.exportBoxTa.value = r.text;
        // Update modal title based on committee type from structured data
        const modalTitleEl = document.querySelector('#modalOverlay .modalTitle');
        if (modalTitleEl && r.structured && r.structured.meta && r.structured.meta.gremium) {
          const gremiumTyp = r.structured.meta.gremium.typ;
          if (gremiumTyp) {
            modalTitleEl.textContent = UA.deriveDocTitle ? UA.deriveDocTitle(gremiumTyp) : gremiumTyp;
          }
        }
        UA.setQS({ export: 1 });
      } catch(e) {
        ui.exportProgress.textContent = "Fehler.";
        ui.exportHtml.innerHTML = `<div style="color:#b00; font-weight:900;">Export fehlgeschlagen</div><div>${UA.escHtml(String(e))}</div>`;
        ui.exportBoxTa.value = "Export fehlgeschlagen: " + String(e);
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
      showKindergartens: true
    };

    if (UA.cleanUrlIfNeeded()) return;

    // Read layer visibility from URL before initLeaflet, because
    // addLayerLegend (called inside initLeaflet) uses these values
    // to set the initial CSS class on legend buttons.
    ctx.showCluster = UA.qBool("showCluster", true);
    ctx.showHeatmap = UA.qBool("showHeatmap", true);
    ctx.showOnlyAboveAverage = UA.qBool("showOnlyAboveAverage", false);
    ctx.showSchools = UA.qBool("showSchools", true);
    ctx.showKindergartens = UA.qBool("showKindergartens", true);

    UA.bindDom(ctx);
    UA.initLeaflet(ctx);

    // Cities
    const cities = await UA.loadCitiesList(ctx);
    UA.setCityDropdown(ctx, cities);

    // data
    await UA.loadCityData(ctx);
    
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
    bindExport(ctx);

    // Initialize tour module (gracefully degraded – only if ua.tour.js is loaded)
    if (typeof UA.initTour === "function") {
      UA.initTour(ctx);
    }

    // Initialize report export UI for V2 (Word/PDF) if available
    if (typeof UA.initReportExportUI === "function") {
      UA.initReportExportUI(ctx);
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
  }

  main().catch(err => {
    console.error(err);
    try {
      const statEl = document.getElementById("stat");
      if (statEl) statEl.textContent = String(err);
    } catch {}
    alert(String(err));
  });
})();