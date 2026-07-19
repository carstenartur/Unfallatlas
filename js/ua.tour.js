(() => {
  "use strict";
  const UA = (window.UA = window.UA || {});

  // ---------------------------------------------------------------------------
  // Tour Player + Recorder for Unfallwerkbank V2
  // ---------------------------------------------------------------------------

  // Built-in tour file locations
  const BUILTIN_TOURS = {
    demo: "tours/demo.json"
  };

  // --- Player state ---
  let _ctx = null;
  let _steps = [];
  let _index = 0;
  let _timer = null;
  let _playing = false;
  let _tourName = "";
  let _flyPending = false;

  // --- Recorder state ---
  let _recActive = false;
  let _recSteps = [];
  let _recStartTime = 0;
  let _recLastStepTime = 0;
  let _recMoveTimer = null;
  let _recLastCenter = null;
  let _recLastZoom = null;
  let _recFilterTimer = null;
  let _recMapHandler = null;
  let _recFilterHandlers = [];
  let _recorderReturnFocus = null;

  // ---------------------------------------------------------------------------
  // Utility: Haversine distance in metres
  // ---------------------------------------------------------------------------
  function haversineM(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  // ---------------------------------------------------------------------------
  // DOM helpers (overlay elements are injected by werkbank_v2.html)
  // ---------------------------------------------------------------------------
  function el(id) {
    return document.getElementById(id);
  }

  function focusWithoutScrolling(target) {
    if (!target || typeof target.focus !== "function") return;
    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      target.focus();
    }
  }

  // ---------------------------------------------------------------------------
  // Tour overlay UI helpers
  // ---------------------------------------------------------------------------
  function overlayShow() {
    const o = el("tourOverlay");
    if (o) o.style.display = "block";
  }

  function overlayHide() {
    const o = el("tourOverlay");
    if (o) o.style.display = "none";
  }

  function overlayUpdate() {
    const descEl = el("tourStepDesc");
    const progEl = el("tourProgress");
    const nameEl = el("tourName");
    const ppBtn = el("tourBtnPlayPause");

    if (nameEl) nameEl.textContent = _tourName;
    if (progEl) progEl.textContent = `${_index + 1} / ${_steps.length}`;
    if (descEl) {
      const step = _steps[_index];
      descEl.textContent = step ? (step.description || "") : "";
    }
    if (ppBtn) ppBtn.textContent = _playing ? "⏸" : "▶";

    // Progress bar fill
    const fill = el("tourProgressFill");
    if (fill && _steps.length > 0) {
      fill.style.width = `${((_index + 1) / _steps.length) * 100}%`;
    }
  }

  function showEndMessage() {
    const descEl = el("tourStepDesc");
    const progEl = el("tourProgress");
    if (descEl) descEl.textContent = "Tour beendet – Jetzt selbst erkunden! 🎉";
    if (progEl) progEl.textContent = `${_steps.length} / ${_steps.length}`;
    const fill = el("tourProgressFill");
    if (fill) fill.style.width = "100%";
  }

  // ---------------------------------------------------------------------------
  // Step execution
  // ---------------------------------------------------------------------------
  async function executeStep(step) {
    if (!step || !_ctx) return;
    const ctx = _ctx;

    switch (step.action) {
      case "flyTo": {
        const lat = Number(step.lat);
        const lng = Number(step.lng);
        const zoom = Number(step.zoom);
        if (Number.isFinite(lat) && Number.isFinite(lng) && Number.isFinite(zoom)) {
          _flyPending = true;
          await new Promise((resolve) => {
            ctx.map.once("moveend", () => {
              _flyPending = false;
              resolve();
            });
            ctx.map.flyTo([lat, lng], zoom, { animate: true, duration: 1.2 });
          });
        }
        break;
      }

      case "setCity": {
        const city = String(step.value || "").trim();
        if (!city || city === ctx.CITY_RAW) break;
        ctx.CITY_RAW = city;
        // Update dropdown if present
        if (ctx.ui && ctx.ui.citySel) {
          ctx.ui.citySel.value = city;
        }
        // Update URL param
        UA.setQS({ city });
        // Load data directly (no page reload)
        try {
          if (ctx.ui && ctx.ui.statEl) {
            ctx.ui.statEl.textContent = `Lade ${city}…`;
          }
          await UA.loadCityData(ctx);
          await UA.loadPOIData(ctx);
          UA.recomputeAndRender(ctx);
        } catch (e) {
          console.warn("[Tour] setCity failed:", e);
        }
        break;
      }

      case "setFilter": {
        const f = step.filters || {};
        const ui = ctx.ui;
        if (!ui) break;

        if (f.includeCyclist !== undefined) ui.incBikeEl.checked = !!f.includeCyclist;
        if (f.includePedestrian !== undefined) ui.incPedEl.checked = !!f.includePedestrian;
        if (f.includeCar !== undefined) ui.incCarEl.checked = !!f.includeCar;
        if (f.includeMotorcycle !== undefined) ui.incMotoEl.checked = !!f.includeMotorcycle;

        if (f.involvementMode !== undefined) {
          ctx.involvementMode = f.involvementMode;
          UA.setBtnState(ui.btnModeOr, f.involvementMode === "or");
          UA.setBtnState(ui.btnModeAnd, f.involvementMode === "and");
          UA.setBtnState(ui.btnModeSolo, f.involvementMode === "solo");
        }

        if (f.severity !== undefined) ui.severityEl.value = String(f.severity);
        if (f.dayType !== undefined) ui.dayTypeEl.value = String(f.dayType);
        if (f.roadCondition !== undefined) ui.roadConditionEl.value = String(f.roadCondition);

        if (f.hourFrom !== undefined) {
          ui.hFromEl.value = String(clamp(Number(f.hourFrom), 0, 23));
        }
        if (f.hourTo !== undefined) {
          ui.hToEl.value = String(clamp(Number(f.hourTo), 0, 23));
        }
        if (typeof UA.syncHourUI === "function") UA.syncHourUI(ctx);

        UA.syncAllToUrl(ctx);
        UA.recomputeAndRender(ctx);
        break;
      }

      case "toggleDisplay": {
        const ui = ctx.ui;
        if (!ui) break;

        if (step.showCluster !== undefined) {
          ctx.showCluster = !!step.showCluster;
          UA.setBtnState(ui.btnCluster, ctx.showCluster);
          if (typeof UA.syncLegendButtons === "function") UA.syncLegendButtons(ctx);
        }
        if (step.showHeatmap !== undefined) {
          ctx.showHeatmap = !!step.showHeatmap;
          UA.setBtnState(ui.btnHeat, ctx.showHeatmap);
          if (typeof UA.syncLegendButtons === "function") UA.syncLegendButtons(ctx);
        }
        if (step.showOnlyAboveAverage !== undefined) {
          ctx.showOnlyAboveAverage = !!step.showOnlyAboveAverage;
          UA.setBtnState(ui.btnOnlyHot, ctx.showOnlyAboveAverage);
        }

        ctx._dataChanged = true;
        UA.syncAllToUrl(ctx);
        UA.renderLayers(ctx);
        break;
      }

      case "setContextOverlay": {
        // Toggle one of the road-context overlays (slope/traffic) via
        // the public API. Acts as a no-op when the city has no
        // enriched geometries (capability gating handled inside
        // UA.setContextOverlayActive). Used by the onboarding tour
        // to point at the top-left "Karten-Layer" control and the
        // bottom-left legend.
        if (typeof UA.setContextOverlayActive !== "function") break;
        const kind = String(step.kind || "").trim();
        if (!kind) break;
        const active = step.active !== false; // defaults to true
        try {
          UA.setContextOverlayActive(_ctx, kind, active);
        } catch (e) {
          console.warn("[Tour] setContextOverlay failed:", e);
        }
        break;
      }

      case "openExport": {
        if (_ctx.ui && _ctx.ui.btnOpenExport) {
          _ctx.ui.btnOpenExport.click();
        }
        break;
      }

      case "closeExport": {
        if (_ctx.ui && _ctx.ui.btnCloseModal) {
          _ctx.ui.btnCloseModal.click();
        }
        break;
      }

      default:
        console.warn("[Tour] Unknown action:", step.action);
    }
  }

  // ---------------------------------------------------------------------------
  // Tour scheduling
  // ---------------------------------------------------------------------------
  function cancelTimer() {
    if (_timer !== null) {
      clearTimeout(_timer);
      _timer = null;
    }
  }

  async function runCurrentStep() {
    if (_index < 0 || _index >= _steps.length) return;
    const step = _steps[_index];
    overlayUpdate();
    await executeStep(step);
    if (_playing) {
      const pause = Number.isFinite(Number(step.pause)) ? Number(step.pause) : 3000;
      _timer = setTimeout(advanceStep, pause);
    }
  }

  function advanceStep() {
    cancelTimer();
    if (_index >= _steps.length - 1) {
      _playing = false;
      showEndMessage();
      const ppBtn = el("tourBtnPlayPause");
      if (ppBtn) ppBtn.textContent = "▶";
      return;
    }
    _index++;
    runCurrentStep();
  }

  // ---------------------------------------------------------------------------
  // Public Player API
  // ---------------------------------------------------------------------------
  UA.tourPlay = function tourPlay() {
    if (_steps.length === 0) return;
    _playing = true;
    const ppBtn = el("tourBtnPlayPause");
    if (ppBtn) ppBtn.textContent = "⏸";
    runCurrentStep();
  };

  UA.tourPause = function tourPause() {
    _playing = false;
    cancelTimer();
    const ppBtn = el("tourBtnPlayPause");
    if (ppBtn) ppBtn.textContent = "▶";
  };

  UA.tourTogglePlayPause = function tourTogglePlayPause() {
    if (_playing) UA.tourPause();
    else UA.tourPlay();
  };

  UA.tourNext = function tourNext() {
    cancelTimer();
    if (_index < _steps.length - 1) {
      _index++;
      runCurrentStep();
    }
  };

  UA.tourPrev = function tourPrev() {
    cancelTimer();
    if (_index > 0) {
      _index--;
      runCurrentStep();
    }
  };

  UA.tourStop = function tourStop() {
    cancelTimer();
    _playing = false;
    _steps = [];
    _index = 0;
    overlayHide();
  };

  // ---------------------------------------------------------------------------
  // Load tour from file/URL and start
  // ---------------------------------------------------------------------------
  async function loadAndStartTour(tourId) {
    let url;
    if (BUILTIN_TOURS[tourId]) {
      url = BUILTIN_TOURS[tourId];
    } else if (tourId.startsWith("http") || tourId.includes("/")) {
      url = tourId;
    } else if (tourId.endsWith(".json")) {
      url = tourId;
    } else {
      url = `tours/${tourId}.json`;
    }

    try {
      const resp = await fetch(url, { cache: "no-cache" });
      if (!resp.ok) throw new Error(`Tour nicht gefunden: ${url} (${resp.status})`);
      const tour = await resp.json();
      startTourFromObject(tour);
    } catch (e) {
      console.error("[Tour] Ladefehler:", e);
      const descEl = el("tourStepDesc");
      if (descEl) descEl.textContent = `Fehler: ${e.message}`;
      overlayShow();
    }
  }

  function startTourFromObject(tour) {
    _steps = Array.isArray(tour.steps) ? tour.steps : [];
    _tourName = tour.name || "Tour";
    _index = 0;
    _playing = false;
    overlayShow();
    overlayUpdate();
    UA.tourPlay();
  }

  // ---------------------------------------------------------------------------
  // Tour Recorder
  // ---------------------------------------------------------------------------

  function captureFilterStep(pauseMs) {
    if (!_recActive || !_ctx) return;
    const ctx = _ctx;
    const ui = ctx.ui;
    if (!ui) return;

    const now = Date.now();
    const elapsed = now - _recLastStepTime;
    const pause = clamp(elapsed, 1000, 10000);
    _recLastStepTime = now;

    const step = {
      action: "setFilter",
      filters: {
        includeCyclist: ui.incBikeEl.checked,
        includePedestrian: ui.incPedEl.checked,
        includeCar: ui.incCarEl.checked,
        includeMotorcycle: ui.incMotoEl.checked,
        involvementMode: ctx.involvementMode,
        severity: ui.severityEl.value,
        dayType: ui.dayTypeEl.value,
        roadCondition: ui.roadConditionEl.value,
        hourFrom: Number(ui.hFromEl.value),
        hourTo: Number(ui.hToEl.value)
      },
      description: "",
      pause: pauseMs !== undefined ? pauseMs : pause
    };

    // Collapse consecutive setFilter steps
    if (_recSteps.length > 0 && _recSteps[_recSteps.length - 1].action === "setFilter") {
      _recSteps[_recSteps.length - 1] = step;
    } else {
      _recSteps.push(step);
    }
    updateRecBadge();
  }

  function captureMoveStep() {
    if (!_recActive || !_ctx) return;
    const ctx = _ctx;
    const map = ctx.map;
    if (!map) return;

    const center = map.getCenter();
    const zoom = map.getZoom();
    const lat = Number(center.lat.toFixed(6));
    const lng = Number(center.lng.toFixed(6));

    // Check if movement is significant
    let significant = true;
    if (_recLastCenter && _recLastZoom !== null) {
      const dist = haversineM(lat, lng, _recLastCenter.lat, _recLastCenter.lng);
      const zoomDiff = Math.abs(zoom - _recLastZoom);
      significant = dist > 100 || zoomDiff >= 1;
    }
    if (!significant) return;

    _recLastCenter = { lat, lng };
    _recLastZoom = zoom;

    const now = Date.now();
    const elapsed = now - _recLastStepTime;
    const pause = clamp(elapsed, 1000, 10000);
    _recLastStepTime = now;

    const step = {
      action: "flyTo",
      lat,
      lng,
      zoom,
      description: "",
      pause
    };

    // Collapse consecutive flyTo steps
    if (_recSteps.length > 0 && _recSteps[_recSteps.length - 1].action === "flyTo") {
      _recSteps[_recSteps.length - 1] = step;
    } else {
      _recSteps.push(step);
    }
    updateRecBadge();
  }

  function updateRecBadge() {
    const badge = el("recStepCount");
    if (badge) badge.textContent = _recSteps.length;
  }

  UA.recorderStart = function recorderStart() {
    if (!_ctx) return;
    _recActive = true;
    _recSteps = [];
    _recStartTime = Date.now();
    _recLastStepTime = Date.now();

    const ctx = _ctx;
    const map = ctx.map;
    if (map) {
      const c = map.getCenter();
      _recLastCenter = { lat: c.lat, lng: c.lng };
      _recLastZoom = map.getZoom();
    }

    // Record initial state as setCity step if possible
    if (ctx.CITY_RAW) {
      _recSteps.push({
        action: "setCity",
        value: ctx.CITY_RAW,
        description: `Stadt: ${ctx.CITY_RAW}`,
        pause: 2000
      });
    }

    // Capture initial map position
    if (map) {
      const c = map.getCenter();
      _recSteps.push({
        action: "flyTo",
        lat: Number(c.lat.toFixed(6)),
        lng: Number(c.lng.toFixed(6)),
        zoom: map.getZoom(),
        description: "Startposition",
        pause: 2000
      });
    }

    // Capture initial filter state
    captureFilterStep(2000);

    // Listen for map movements
    _recMoveTimer = null;
    _recMapHandler = () => {
      if (_recMoveTimer) clearTimeout(_recMoveTimer);
      _recMoveTimer = setTimeout(captureMoveStep, 1500);
    };
    map && map.on("moveend", _recMapHandler);

    // Listen for filter changes
    const ui = ctx.ui;
    if (ui) {
      const filterEls = [
        ui.incBikeEl, ui.incPedEl, ui.incCarEl, ui.incMotoEl,
        ui.severityEl, ui.dayTypeEl, ui.roadConditionEl,
        ui.hFromEl, ui.hToEl
      ].filter(Boolean);

      const modeEls = [ui.btnModeOr, ui.btnModeAnd, ui.btnModeSolo].filter(Boolean);

      const filterHandler = () => {
        if (_recFilterTimer) clearTimeout(_recFilterTimer);
        _recFilterTimer = setTimeout(() => captureFilterStep(), 600);
      };

      for (const el2 of filterEls) {
        el2.addEventListener("change", filterHandler);
        el2.addEventListener("input", filterHandler);
        _recFilterHandlers.push({ el: el2, fn: filterHandler });
      }
      for (const el2 of modeEls) {
        el2.addEventListener("click", filterHandler);
        _recFilterHandlers.push({ el: el2, fn: filterHandler });
      }

      // Display toggles
      const dispHandler = () => {
        const step = {
          action: "toggleDisplay",
          showCluster: ctx.showCluster,
          showHeatmap: ctx.showHeatmap,
          showOnlyAboveAverage: ctx.showOnlyAboveAverage,
          description: "",
          pause: clamp(Date.now() - _recLastStepTime, 1000, 10000)
        };
        _recLastStepTime = Date.now();
        if (_recSteps.length > 0 && _recSteps[_recSteps.length - 1].action === "toggleDisplay") {
          _recSteps[_recSteps.length - 1] = step;
        } else {
          _recSteps.push(step);
        }
        updateRecBadge();
      };

      for (const el2 of [ui.btnCluster, ui.btnHeat, ui.btnOnlyHot].filter(Boolean)) {
        el2.addEventListener("click", dispHandler);
        _recFilterHandlers.push({ el: el2, fn: dispHandler });
      }

      // Export open/close
      const openExportHandler = () => {
        if (!_recActive) return;
        _recSteps.push({ action: "openExport", description: "Export öffnen", pause: 5000 });
        _recLastStepTime = Date.now();
        updateRecBadge();
      };
      const closeExportHandler = () => {
        if (!_recActive) return;
        _recSteps.push({ action: "closeExport", description: "Export schließen", pause: 1000 });
        _recLastStepTime = Date.now();
        updateRecBadge();
      };

      if (ui.btnOpenExport) {
        ui.btnOpenExport.addEventListener("click", openExportHandler);
        _recFilterHandlers.push({ el: ui.btnOpenExport, fn: openExportHandler });
      }
      if (ui.btnCloseModal) {
        ui.btnCloseModal.addEventListener("click", closeExportHandler);
        _recFilterHandlers.push({ el: ui.btnCloseModal, fn: closeExportHandler });
      }
    }

    // Update UI
    const btn = el("tourBtnRecord");
    if (btn) {
      btn.classList.add("active");
      btn.title = "Aufnahme läuft – klicken zum Stoppen";
    }
    const badge = el("recBadge");
    if (badge) badge.style.display = "inline-flex";
    updateRecBadge();
  };

  UA.recorderStop = function recorderStop() {
    if (!_recActive) return;
    _recActive = false;

    const ctx = _ctx;
    const map = ctx && ctx.map;

    if (map && _recMapHandler) {
      map.off("moveend", _recMapHandler);
    }
    if (_recMoveTimer) clearTimeout(_recMoveTimer);
    if (_recFilterTimer) clearTimeout(_recFilterTimer);

    for (const { el: el2, fn } of _recFilterHandlers) {
      el2.removeEventListener("change", fn);
      el2.removeEventListener("input", fn);
      el2.removeEventListener("click", fn);
    }
    _recFilterHandlers = [];

    // Update UI
    const btn = el("tourBtnRecord");
    if (btn) {
      btn.classList.remove("active");
      btn.title = "Aufnahme starten";
    }
    const badge = el("recBadge");
    if (badge) badge.style.display = "none";

    // Show recorder editor
    openRecorderEditor();
  };

  // ---------------------------------------------------------------------------
  // Recorder Editor Modal
  // ---------------------------------------------------------------------------
  function openRecorderEditor() {
    const modal = el("recorderModal");
    if (!modal) return;

    const active = document.activeElement;
    _recorderReturnFocus = active && active !== document.body && typeof active.focus === "function"
      ? active
      : el("tourBtnRecord");

    const tour = {
      name: `Aufgenommene Tour – ${new Date().toLocaleString("de-DE")}`,
      steps: _recSteps.slice()
    };

    const jsonStr = JSON.stringify(tour, null, 2);
    const ta = el("recorderJson");
    if (ta) ta.value = jsonStr;

    // Render step list
    renderStepList(tour.steps);

    modal.style.display = "flex";
    focusWithoutScrolling(el("recorderBtnClose"));
  }

  function closeRecorderEditor() {
    const modal = el("recorderModal");
    if (modal) modal.style.display = "none";

    const returnFocus = _recorderReturnFocus || el("tourBtnRecord");
    _recorderReturnFocus = null;
    if (returnFocus && document.contains(returnFocus)) {
      focusWithoutScrolling(returnFocus);
    }
  }

  function renderStepList(steps) {
    const list = el("recorderStepList");
    if (!list) return;
    list.innerHTML = "";

    steps.forEach((step, i) => {
      const row = document.createElement("div");
      row.className = "recStepRow";
      row.dataset.index = i;

      const label = document.createElement("span");
      label.className = "recStepLabel";
      label.textContent = `${i + 1}. ${step.action}`;

      const descInput = document.createElement("input");
      descInput.type = "text";
      descInput.className = "recStepDesc";
      descInput.placeholder = "Beschreibung…";
      descInput.value = step.description || "";
      descInput.addEventListener("input", () => {
        steps[i].description = descInput.value;
        syncRecorderJson(steps);
      });

      const pauseInput = document.createElement("input");
      pauseInput.type = "number";
      pauseInput.className = "recStepPause";
      pauseInput.min = "500";
      pauseInput.max = "30000";
      pauseInput.step = "500";
      pauseInput.title = "Pause (ms)";
      pauseInput.value = String(step.pause || 2000);
      pauseInput.addEventListener("change", () => {
        steps[i].pause = clamp(Number(pauseInput.value), 500, 30000);
        syncRecorderJson(steps);
      });

      const upBtn = document.createElement("button");
      upBtn.type = "button";
      upBtn.className = "recStepMoveBtn";
      upBtn.textContent = "▲";
      upBtn.title = "Nach oben";
      upBtn.disabled = i === 0;
      upBtn.addEventListener("click", () => {
        if (i > 0) {
          [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
          renderStepList(steps);
          syncRecorderJson(steps);
        }
      });

      const downBtn = document.createElement("button");
      downBtn.type = "button";
      downBtn.className = "recStepMoveBtn";
      downBtn.textContent = "▼";
      downBtn.title = "Nach unten";
      downBtn.disabled = i === steps.length - 1;
      downBtn.addEventListener("click", () => {
        if (i < steps.length - 1) {
          [steps[i], steps[i + 1]] = [steps[i + 1], steps[i]];
          renderStepList(steps);
          syncRecorderJson(steps);
        }
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "recStepDelBtn";
      delBtn.textContent = "✕";
      delBtn.title = "Schritt löschen";
      delBtn.addEventListener("click", () => {
        steps.splice(i, 1);
        renderStepList(steps);
        syncRecorderJson(steps);
      });

      row.appendChild(label);
      row.appendChild(descInput);
      row.appendChild(pauseInput);
      row.appendChild(upBtn);
      row.appendChild(downBtn);
      row.appendChild(delBtn);
      list.appendChild(row);
    });
  }

  function syncRecorderJson(steps) {
    const ta = el("recorderJson");
    if (!ta) return;
    let name = "Aufgenommene Tour";
    try {
      const parsed = JSON.parse(ta.value);
      if (parsed && typeof parsed.name === "string") name = parsed.name;
    } catch {
      // keep default name if JSON is currently invalid (user is editing)
    }
    ta.value = JSON.stringify({ name, steps }, null, 2);
  }

  function downloadTourJson() {
    const ta = el("recorderJson");
    if (!ta) return;
    let obj;
    try {
      obj = JSON.parse(ta.value);
    } catch {
      alert("Ungültiges JSON – bitte korrigieren.");
      return;
    }
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const safeName = (obj.name || "tour")
      .replace(/[^a-zA-Z0-9äöüÄÖÜß\-_ ]/g, "")
      .trim()
      .replace(/\s+/g, "_")
      .toLowerCase() || "tour";
    a.download = `${safeName}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function playRecordedTour() {
    const ta = el("recorderJson");
    if (!ta) return;
    let tour;
    try {
      tour = JSON.parse(ta.value);
    } catch {
      alert("Ungültiges JSON – bitte korrigieren.");
      return;
    }
    closeRecorderEditor();
    startTourFromObject(tour);
  }

  // ---------------------------------------------------------------------------
  // Panel buttons setup
  // ---------------------------------------------------------------------------
  function setupPanelButtons(ctx) {
    const startBtn = el("tourBtnStart");
    const recBtn = el("tourBtnRecord");

    if (startBtn) {
      startBtn.addEventListener("click", () => {
        loadAndStartTour("demo");
      });
    }

    if (recBtn) {
      recBtn.addEventListener("click", () => {
        if (_recActive) {
          UA.recorderStop();
        } else {
          UA.recorderStart();
        }
      });
    }
  }

  function setupOverlayButtons() {
    const ppBtn = el("tourBtnPlayPause");
    const nextBtn = el("tourBtnNext");
    const prevBtn = el("tourBtnPrev");
    const stopBtn = el("tourBtnStop");

    if (ppBtn) ppBtn.addEventListener("click", UA.tourTogglePlayPause);
    if (nextBtn) nextBtn.addEventListener("click", UA.tourNext);
    if (prevBtn) prevBtn.addEventListener("click", UA.tourPrev);
    if (stopBtn) stopBtn.addEventListener("click", UA.tourStop);
  }

  function setupRecorderModal() {
    const closeBtn = el("recorderBtnClose");
    const downloadBtn = el("recorderBtnDownload");
    const playBtn = el("recorderBtnPlay");
    const modal = el("recorderModal");

    if (closeBtn) closeBtn.addEventListener("click", closeRecorderEditor);
    if (modal) modal.addEventListener("click", (e) => { if (e.target === modal) closeRecorderEditor(); });
    if (downloadBtn) downloadBtn.addEventListener("click", downloadTourJson);
    if (playBtn) playBtn.addEventListener("click", playRecordedTour);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !modal || modal.style.display !== "flex") return;
      event.preventDefault();
      closeRecorderEditor();
    });
  }

  // ---------------------------------------------------------------------------
  // Main init – called from ua.app_v2.js after ctx is ready
  // ---------------------------------------------------------------------------
  UA.initTour = function initTour(ctx) {
    _ctx = ctx;
    setupPanelButtons(ctx);
    setupOverlayButtons();
    setupRecorderModal();

    // Auto-start tour from URL param
    const tourParam = UA.qGet("tour", "");
    if (tourParam) {
      // Small delay so map is fully rendered
      setTimeout(() => loadAndStartTour(tourParam), 800);
    }
  };
})();
