(() => {
  const UA = window.UA;

  UA.recomputeAndRender = function recomputeAndRender(ctx){
    UA.applyFilters(ctx);
    UA.applyViewportFilter(ctx);
    UA.renderLayers(ctx);
    UA.saveCityState(ctx);
  };

  UA.scheduleViewportUpdate = function scheduleViewportUpdate(ctx){
    if (!ctx.allPts?.length) return;
    if (ctx._moveTimer) clearTimeout(ctx._moveTimer);
    ctx._moveTimer = setTimeout(() => {
      UA.applyViewportFilter(ctx);
      UA.renderLayers(ctx);
      UA.syncViewToUrl(ctx);
    }, 150);
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
        UA.setQS({ export: 1 });
      } catch(e) {
        ui.exportProgress.textContent = "Fehler.";
        ui.exportHtml.innerHTML = `<div style="color:#b00; font-weight:900;">Export fehlgeschlagen</div><div>${UA.escHtml(String(e))}</div>`;
        ui.exportBoxTa.value = "Export fehlgeschlagen: " + String(e);
      }
    });
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
      showOnlyAboveAverage: false
    };

    if (UA.cleanUrlIfNeeded()) return;

    UA.bindDom(ctx);
    UA.initLeaflet(ctx);

    // Cities
    const cities = await UA.loadCitiesList(ctx);
    UA.setCityDropdown(ctx, cities);

    // restore state (only if no URL view)
    UA.restoreCityStateIfNoUrlView(ctx);

    // data
    await UA.loadCityData(ctx);

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

    // map events
    ctx.map.on("moveend zoomend", () => UA.scheduleViewportUpdate(ctx));

    UA.recomputeAndRender(ctx);

    // auto open export
    if (UA.qBool("export", false)) setTimeout(()=> ctx.ui.btnOpenExport.click(), 200);
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