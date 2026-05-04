(() => {
  const UA = (window.UA = window.UA || {});

  // Initialize export libraries loaded flag and in-flight load guard
  UA._exportLibrariesLoaded = false;
  UA._exportLibrariesLoading = null;

  // ---------------------------------------------------------------------
  // Hinweis zur Zählweise (PR 2 / Spec-Item 4 — „Hinweis-zur-Zählweise"-Box)
  //
  // Wird sowohl in DOCX als auch in PDF unmittelbar nach dem „Aktive
  // Filter"-Block eingefügt. Die Box stellt für Verwaltungspublikum klar,
  // welche Population die in den Tabellen genannten Fallzahlen abdecken,
  // damit Ausschnittszahlen nicht versehentlich als stadtweite Statistik
  // gelesen werden.
  const HINWEIS_ZAEHLWEISE_LINES = [
    "Hinweis zur Zählweise:",
    "Alle in diesem Dokument genannten Fallzahlen beziehen sich – sofern nicht anders ausgewiesen – ausschließlich auf den oben markierten Auswertungsbereich (Kartenausschnitt + aktive Filter). Stadtweite Vergleichswerte (z. B. in den Top-Abweichungen) werden als \"Vergleich mit dem Stadtgebiet\" gekennzeichnet."
  ];

  // ---------------------------------------------------------------------
  // Figure-Caption-Counter (PR 2 / Spec-Item 4 — „Abbildung N: …")
  //
  // Beide Renderer (DOCX + PDF) erzeugen genau drei Bildklassen:
  // Übersichtskarte, Detailkarte, Cluster-Karten (1..n). Die Caption-Box
  // hängt unter jedem Bild eine durchnummerierte Bildunterschrift an,
  // damit das resultierende Dokument zitierfähig wird (z. B. „siehe
  // Abbildung 2"). Für jeden Export-Aufruf wird ein frischer Counter
  // erzeugt; die DOCX- und PDF-Pfade verwenden je einen eigenen.
  function makeFigureCounter() {
    let n = 0;
    return {
      next(subject) {
        n += 1;
        return { index: n, caption: `Abbildung ${n}: ${subject}` };
      }
    };
  }


  // ---------------------------------------------------------------------
  // Block headers used to terminate the SACHVERHALT extraction in DOCX
  // and PDF export. The TEXT renderer in js/ua.export_v2.js emits these
  // headers after "Sachverhalt:". Used by extractSection() and by the
  // PDF/DOCX SACHVERHALT extraction call sites to terminate the
  // SACHVERHALT block before the next major section. Without this,
  // blocks like "Mehrjahres-Trend (Gesamtzahl pro Jahr):\n  Jahr |
  // Getötete | …" leak into the SACHVERHALT paragraph as raw pipe-text
  // and then render again later as proper structured tables — exactly
  // the QA blocker tracked by the regression assertion in
  // tests/unit/ua.report_v2.pdfQA.test.js.
  //
  // The list also includes "Sachverhalt:" itself so that an unexpected
  // re-entry of the entry marker terminates extraction defensively (the
  // first "Sachverhalt:" line activates collection and is consumed by
  // the inSection flag in extractSection; only a second occurrence would
  // be matched against this list). The DOCX call site explicitly filters
  // out the entry marker since it's already used as the sectionHeader
  // argument.
  //
  // Headers are matched via String.prototype.startsWith on the trimmed
  // line, so substrings of headers (e.g. "Auffälligkeiten (" matches both
  // "Auffälligkeiten:" and "Auffälligkeiten (Top-Abweichungen…)") are
  // sufficient.
  const POST_SACHVERHALT_STOP_HEADERS = [
    "Sachverhalt:",
    "Auffälligkeiten:",
    "Auffälligkeiten (",
    "URSACHEN UND MASSNAHMEN",
    "Bewertung / Interpretation",
    "Methodik",
    "Mehrjahres-Trend",
    "Stunden-Heatmap",
    "Verkehrsräumlicher Kontext",
    "Volkswirtschaftliche Bedeutung",
    "Empfohlene Maßnahmen",
    "POI-Analyse",
    "Bezugsdokumente:",
    "Beschlussvorschlag:",
    "Hinweis (intern)",
    "Datenquelle"
  ];

  // =====================================================================
  // Lazy Loading Utilities for Export Libraries
  // =====================================================================

  /**
   * Load a script dynamically
   * @param {string} src - Script URL
   * @param {string} globalCheck - Global variable to check if already loaded
   * @returns {Promise<void>}
   */
  function loadScript(src, globalCheck) {
    return new Promise((resolve, reject) => {
      // Check if already loaded
      if (globalCheck && window[globalCheck]) {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }

  /**
   * Try loading a script from a list of CDN URLs in order, stopping at first success.
   * @param {string[]} urls - CDN URLs to try (primary first, then fallbacks)
   * @param {string|null} globalCheck - Global variable name to check if already loaded
   * @returns {Promise<void>}
   */
  async function loadScriptWithFallback(urls, globalCheck) {
    let lastError;
    for (const src of urls) {
      try {
        await loadScript(src, globalCheck);
        return;
      } catch (e) {
        lastError = e;
        console.warn(`Failed to load ${src}, trying fallback...`);
      }
    }
    throw lastError;
  }

  /**
   * Ensure export libraries are loaded.
   * Concurrent calls share the same in-flight Promise so scripts are only
   * injected once even if Word and PDF buttons are clicked simultaneously.
   * @param {Function} [onProgress] - Optional callback(message) called as each library loads
   * @returns {Promise<void>}
   */
  UA.ensureExportLibraries = async function ensureExportLibraries(onProgress) {
    if (UA._exportLibrariesLoaded) return;
    
    // In test environment, libraries might already be loaded or mocked
    if (window.docx && window.pdfMake && window.saveAs) {
      UA._exportLibrariesLoaded = true;
      return;
    }
    
    // If no document object (not in browser), skip loading
    if (typeof document === 'undefined') {
      UA._exportLibrariesLoaded = true;
      return;
    }

    // If a load is already in progress, share it to avoid duplicate script injections.
    // Subsequent callers silently join — progress messages go to the first caller's UI.
    if (UA._exportLibrariesLoading) {
      return UA._exportLibrariesLoading;
    }

    function progress(msg) {
      if (typeof onProgress === 'function') onProgress(msg);
    }

    UA._exportLibrariesLoading = (async function doLoad() {
      try {
        // NOTE: Keep CDN versions in sync with package.json and tests/e2e/helpers.js setupCDNRoutes().
        // Primary CDN: jsDelivr. Fallback CDN: unpkg.
        // docx@9.x uses dist/index.iife.js (IIFE format).
        // pdfmake@0.2.x: vfs_fonts.js registers fonts via pdfMake.addVirtualFileSystem() side-effect.
        progress('Lade Bibliothek 1/3: docx…');
        await loadScriptWithFallback([
          'https://cdn.jsdelivr.net/npm/docx@9.6.1/dist/index.iife.js',
          'https://unpkg.com/docx@9.6.1/dist/index.iife.js'
        ], 'docx');

        progress('Lade Bibliothek 2/3: pdfMake…');
        await loadScriptWithFallback([
          'https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/pdfmake.min.js',
          'https://unpkg.com/pdfmake@0.2.20/build/pdfmake.min.js'
        ], 'pdfMake');

        progress('Lade Bibliothek 3/3: FileSaver…');
        await loadScriptWithFallback([
          'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js',
          'https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js'
        ], 'saveAs');
        
        // Load vfs_fonts after pdfMake so it can register fonts via side-effect
        if (window.pdfMake) {
          progress('Lade Schriftarten…');
          await loadScriptWithFallback([
            'https://cdn.jsdelivr.net/npm/pdfmake@0.2.20/build/vfs_fonts.js',
            'https://unpkg.com/pdfmake@0.2.20/build/vfs_fonts.js'
          ], null);
        }
        
        UA._exportLibrariesLoaded = true;
      } catch (e) {
        console.error('Failed to load export libraries:', e);
        throw new Error('Export-Bibliotheken konnten nicht geladen werden. Bitte Seite neu laden.');
      } finally {
        UA._exportLibrariesLoading = null;
      }
    })();

    return UA._exportLibrariesLoading;
  };

  // =====================================================================
  // Map Image Export (programmatic, using leaflet-image)
  // =====================================================================

  // Delay (in milliseconds) to wait for map tiles to load before capture
  const MAP_CAPTURE_DELAY_MS = 100;

  // ---------------------------------------------------------------------
  // Layout-PR „Bildverzerrung beheben" — Aspektrate-erhaltende Skalierung.
  //
  // Bisheriges Verhalten:
  //   * DOCX setzte ImageRun-`transformation` hart auf `{width:600, height:400}`,
  //     unabhängig von der Originalgröße der von leaflet-image gelieferten
  //     PNGs. Bei einem realen Map-Canvas (z. B. 1024×512 oder 800×900) wurde
  //     das Bild gestreckt/gestaucht — Kreise erschienen als Ellipsen, Straßen
  //     wirkten verzerrt. QA-Befund Item 1: harte Anforderung.
  //   * PDF nutzt zwar pdfMake-`fit:[w,h]` (ratio-erhaltend), aber mit
  //     unterschiedlichen Boxen pro Map-Typ (Übersicht 475×650, Detail/Cluster
  //     475×350). QA-Befund Item 2: einheitliche Skalierungslogik.
  //
  // Lösung: ein gemeinsamer Helper, der die Originalgröße aus dem PNG-Header
  // liest (IHDR-Chunk, Bytes 16–23 nach dem 8-Byte-Magic) und einen
  // einheitlichen Skalierungsfaktor `min(maxW/origW, maxH/origH)` anwendet.
  //
  // Zentrale Konstanten — gleicher Bildrahmen für ALLE Karten (Übersicht,
  // Detail, Cluster), damit Karten visuell konsistent skaliert wirken
  // (Spec-Item 2 + 6).
  // ---------------------------------------------------------------------
  const DOCX_MAP_MAX = Object.freeze({ width: 600, height: 400 }); // EMU-Punkte (docx)
  const PDF_MAP_MAX  = Object.freeze({ width: 475, height: 340 }); // pdfMake-Punkte
  // Akzeptanzkriterium 7: |after.ratio − before.ratio| < ASPECT_TOLERANCE
  const ASPECT_TOLERANCE = 0.01;

  /**
   * Read PNG width/height from the IHDR chunk of a base64-encoded PNG.
   * PNG file format:
   *   bytes  0–7   : magic   (89 50 4E 47 0D 0A 1A 0A)
   *   bytes  8–15  : IHDR length (4) + chunk type "IHDR" (4)
   *   bytes 16–19  : width  (uint32 BE)
   *   bytes 20–23  : height (uint32 BE)
   *
   * Akzeptiert sowohl reine Base64-Strings als auch Data-URLs
   * (`data:image/png;base64,…`). Wirft `Error` bei nicht-PNG-Daten oder zu
   * kurzen Eingaben — das ist gewollt, weil unbekannte Originalgrößen die
   * QA-Anforderung „Aspektrate erhalten" nicht erfüllen können.
   *
   * @param {string} dataUrlOrBase64
   * @returns {{width:number, height:number}}
   */
  function readPngDimensions(dataUrlOrBase64) {
    if (typeof dataUrlOrBase64 !== "string" || !dataUrlOrBase64) {
      throw new Error("readPngDimensions: empty input");
    }
    const base64 = dataUrlOrBase64.replace(/^data:image\/png;base64,/, "");
    // We only need the first 24 bytes (magic + IHDR len/type + w/h).
    // atob is available in browser + jsdom test environment.
    const head = (typeof atob === "function")
      ? atob(base64.slice(0, 64))
      : Buffer.from(base64.slice(0, 64), "base64").toString("binary");
    if (head.length < 24) throw new Error("readPngDimensions: input too short to be a PNG");
    // Full 8-byte PNG magic: 0x89 'P' 'N' 'G' 0x0D 0x0A 0x1A 0x0A
    const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < PNG_MAGIC.length; i++) {
      if (head.charCodeAt(i) !== PNG_MAGIC[i]) {
        throw new Error("readPngDimensions: not a PNG (magic mismatch)");
      }
    }
    // The first chunk in a PNG must be IHDR. Bytes 8..11 = chunk length,
    // bytes 12..15 = chunk type. Validate "IHDR" so that arbitrary data
    // with a valid PNG prefix cannot pass.
    if (
      head.charCodeAt(12) !== 0x49 || // 'I'
      head.charCodeAt(13) !== 0x48 || // 'H'
      head.charCodeAt(14) !== 0x44 || // 'D'
      head.charCodeAt(15) !== 0x52    // 'R'
    ) {
      throw new Error("readPngDimensions: missing IHDR chunk");
    }
    const u32 = (off) =>
      ((head.charCodeAt(off)     & 0xff) << 24 >>> 0) +
      ((head.charCodeAt(off + 1) & 0xff) << 16) +
      ((head.charCodeAt(off + 2) & 0xff) << 8)  +
       (head.charCodeAt(off + 3) & 0xff);
    const width  = u32(16);
    const height = u32(20);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error("readPngDimensions: invalid IHDR dimensions");
    }
    return { width, height };
  }
  UA.readPngDimensions = readPngDimensions;

  /**
   * Compute scaled `{width, height}` that fits inside `max` while
   * preserving the original aspect ratio. Uses one common scale factor
   * for both axes — the QA-Spec verbietet ausdrücklich, width und height
   * unabhängig zu setzen.
   *
   *   scale  = min(maxW / origW, maxH / origH)
   *   width  = origW * scale
   *   height = origH * scale
   *
   * Beide Achsen werden auf maximal eine Nachkommastelle gerundet, damit
   * die `transformation`-Werte stabil und im Test deterministisch sind.
   *
   * @param {{width:number,height:number}} orig
   * @param {{width:number,height:number}} max
   * @returns {{width:number, height:number}}
   */
  function fitWithAspectRatio(orig, max) {
    const oW = Number(orig && orig.width);
    const oH = Number(orig && orig.height);
    const mW = Number(max && max.width);
    const mH = Number(max && max.height);
    if (!(oW > 0) || !(oH > 0) || !(mW > 0) || !(mH > 0)) {
      throw new Error("fitWithAspectRatio: non-positive dimensions");
    }
    const scale = Math.min(mW / oW, mH / oH);
    const round1 = (n) => Math.round(n * 10) / 10;
    return { width: round1(oW * scale), height: round1(oH * scale) };
  }
  UA.fitWithAspectRatio = fitWithAspectRatio;

  /**
   * Convenience: read PNG size + fit to `max` in one call. Falls back to
   * `max` (full box) if the PNG header cannot be parsed — that keeps the
   * export from crashing on synthetic test fixtures while still preferring
   * the correct aspect ratio when real PNG data is present.
   *
   * Returned object has the canonical `{width, height}` shape that
   * `docx`-`ImageRun.transformation` and pdfMake `image` accept.
   *
   * @param {string} dataUrlOrBase64
   * @param {{width:number,height:number}} max
   */
  function fitImageToMax(dataUrlOrBase64, max) {
    try {
      const orig = readPngDimensions(dataUrlOrBase64);
      return fitWithAspectRatio(orig, max);
    } catch (_) {
      // Fallback: max box (kein „verzerrt", aber Originalgröße unbekannt).
      return { width: max.width, height: max.height };
    }
  }
  UA.fitImageToMax = fitImageToMax;
  UA.DOCX_MAP_MAX = DOCX_MAP_MAX;
  UA.PDF_MAP_MAX = PDF_MAP_MAX;
  UA.ASPECT_TOLERANCE = ASPECT_TOLERANCE;

  /**
   * Bake opacity into the heatmap canvas pixel data so that leaflet-image
   * (which ignores CSS style.opacity) exports the correct transparency.
   * Returns a restore function that reverts the canvas to its original state.
   * @param {Object} heatLayer - Leaflet.heat layer instance
   * @param {number} opacity - Opacity to apply (0–1)
   * @returns {Function} Restore function (call after capture to undo)
   */
  function bakeHeatOpacityIntoCanvas(heatLayer, opacity) {
    // Match same canvas resolution as applyHeatOpacity in ua.map_v2.js
    const canvas = heatLayer && (heatLayer._canvas || (heatLayer._renderer && heatLayer._renderer._container));
    if (!canvas) return function () {};
    try {
      const ctx2d = canvas.getContext("2d");
      const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      const original = new Uint8ClampedArray(imageData.data);
      // Also save/restore CSS opacity to avoid double-applying on screen during export
      const originalCssOpacity = canvas.style.opacity;
      for (let i = 3; i < imageData.data.length; i += 4) {
        imageData.data[i] = Math.round(imageData.data[i] * opacity);
      }
      canvas.style.opacity = "1";
      ctx2d.putImageData(imageData, 0, 0);
      return function restoreHeatCanvas() {
        try {
          const restore = ctx2d.createImageData(canvas.width, canvas.height);
          restore.data.set(original);
          ctx2d.putImageData(restore, 0, 0);
          canvas.style.opacity = originalCssOpacity;
        } catch (err) {
          canvas.style.opacity = originalCssOpacity;
          console.warn("Failed to restore heatmap canvas:", err);
        }
      };
    } catch (err) {
      console.warn("Failed to bake heatmap opacity:", err);
      return function () {};
    }
  }

  /**
   * Detach markers that leaflet-image@0.4.0 cannot render from the given map.
   *
   * Background: leaflet-image's handleMarkerLayer assumes every marker icon
   * exposes an HTMLImageElement at marker._icon with a .src URL. For markers
   * created with L.divIcon (used by our POI layer for school/kindergarten
   * pictograms) marker._icon is a <div>, so reading marker._icon.src yields
   * undefined. leaflet-image then throws inside an asynchronous image.onload,
   * its callback is never invoked, and any awaited capture hangs forever —
   * which breaks the entire Word/PDF export pipeline.
   *
   * To work around this we temporarily detach those non-imageable markers
   * from the map before invoking leaflet-image and re-attach them afterwards.
   *
   * @param {Object} map - Leaflet map instance
   * @returns {Function} Restore function that re-attaches detached markers.
   */
  function detachUncapturableMarkers(map) {
    const detached = [];
    if (!map || typeof map.eachLayer !== "function" || typeof window.L === "undefined") {
      return function () {};
    }
    try {
      map.eachLayer(function (layer) {
        if (!(layer instanceof window.L.Marker)) return;
        const icon = layer.options && layer.options.icon;
        if (!icon) return;
        const isDivIcon = window.L.DivIcon && icon instanceof window.L.DivIcon;
        const iconUrl = icon.options && icon.options.iconUrl;
        // leaflet-image only knows how to draw markers backed by a real image
        // URL. Anything else (DivIcon, custom icons without iconUrl) crashes
        // the capture, so detach it for the duration of the snapshot.
        if (isDivIcon || typeof iconUrl !== "string" || !iconUrl) {
          detached.push(layer);
          map.removeLayer(layer);
        }
      });
    } catch (err) {
      console.warn("Failed to scan markers for export capture:", err);
    }
    return function restoreDetachedMarkers() {
      for (const marker of detached) {
        try {
          marker.addTo(map);
        } catch (err) {
          console.warn("Failed to re-attach marker after export capture:", err);
        }
      }
    };
  }

  // Safety timeout (ms) for leaflet-image. Some marker/layer combinations can
  // cause leaflet-image's internal queue to never invoke its callback (see
  // detachUncapturableMarkers above). Without an upper bound the export
  // promise would hang indefinitely and the export buttons stay disabled.
  const MAP_CAPTURE_TIMEOUT_MS = 30000;

  /**
   * Capture current map view as base64 image
   * @param {Object} ctx - Application context with map instance
   * @param {Object} options - Export options
   * @param {number} [options.heatmapExportOpacity] - Override heatmap opacity for export (0–1)
   * @returns {Promise<string>} Base64 image data URL
   */
  UA.captureMapImage = async function captureMapImage(ctx, options = {}) {
    return new Promise((resolve, reject) => {
      if (!window.leafletImage) {
        reject(new Error("leaflet-image library not loaded"));
        return;
      }

      try {
        // Wait a moment for any pending tile loads or animations to complete
        setTimeout(() => {
          // Bake heatmap opacity into canvas pixels so leaflet-image picks it up
          // (leaflet-image ignores CSS style.opacity on the canvas element)
          let restoreHeat = function () {};
          if (ctx.heatLayer) {
            const zoom = ctx.map && ctx.map.getZoom ? ctx.map.getZoom() : 12;
            const rawOpacity =
              options.heatmapExportOpacity != null
                ? options.heatmapExportOpacity
                : (UA.heatOpacityForZoom ? UA.heatOpacityForZoom(zoom) : 0.6);
            const exportOpacity = Number.isFinite(Number(rawOpacity))
              ? Math.max(0, Math.min(1, Number(rawOpacity)))
              : 0.6;
            restoreHeat = bakeHeatOpacityIntoCanvas(ctx.heatLayer, exportOpacity);
          }

          // Detach markers leaflet-image can't render (DivIcon / no iconUrl)
          // BEFORE invoking leafletImage — otherwise the capture throws inside
          // an async image.onload, never invokes its callback, and the export
          // promise hangs forever (breaking Word + PDF export).
          const restoreMarkers = detachUncapturableMarkers(ctx.map);

          // Idempotent cleanup that restores both side-effects (detached
          // markers + baked heatmap canvas) exactly once, even if a late
          // leaflet-image callback fires after the safety timeout already
          // settled the promise. Any restore error is logged and surfaced
          // through `finish()` only when the primary path didn't already
          // produce one.
          let restoredCaptureState = false;
          const restoreCaptureState = function () {
            if (restoredCaptureState) return null;
            restoredCaptureState = true;

            let restoreError = null;
            try {
              restoreMarkers();
            } catch (e) {
              restoreError = e;
            }
            try {
              restoreHeat();
            } catch (e) {
              if (!restoreError) restoreError = e;
            }
            return restoreError;
          };

          let settled = false;
          const finish = function (err, dataUrl) {
            if (settled) {
              // Late callback after timeout: still ensure cleanup happens
              // exactly once, but don't change the already-settled result.
              restoreCaptureState();
              return;
            }
            settled = true;
            clearTimeout(safetyTimer);

            const restoreError = restoreCaptureState();
            if (restoreError) {
              console.error("Map capture cleanup error:", restoreError);
              if (!err) err = restoreError;
            }

            if (err) reject(err);
            else resolve(dataUrl);
          };

          // Safety net: if leaflet-image's callback is never invoked (e.g. an
          // unhandled async error inside one of its layer handlers), reject
          // with a clear error so the export UI can recover instead of hanging.
          const safetyTimer = setTimeout(() => {
            const e = new Error(
              "Kartenaufnahme abgebrochen: leaflet-image hat nicht innerhalb von " +
              (MAP_CAPTURE_TIMEOUT_MS / 1000) + "s geantwortet."
            );
            console.error(e.message);
            finish(e);
          }, MAP_CAPTURE_TIMEOUT_MS);

          try {
            // Use leaflet-image to capture the map with all layers and styling
            window.leafletImage(ctx.map, (err, canvas) => {
              if (err) {
                console.error("leaflet-image capture error:", err);
                finish(err);
                return;
              }

              try {
                // Convert canvas to base64 data URL (PNG format preserves transparency)
                const dataUrl = canvas.toDataURL("image/png");

                // Verify the data URL is valid
                if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
                  finish(new Error("Invalid map image data URL generated"));
                  return;
                }

                finish(null, dataUrl);
              } catch (e) {
                console.error("Canvas to data URL conversion error:", e);
                finish(e);
              }
            });
          } catch (e) {
            console.error("leafletImage call error:", e);
            finish(e);
          }
        }, MAP_CAPTURE_DELAY_MS); // Small delay to ensure tiles are loaded
      } catch (e) {
        console.error("captureMapImage error:", e);
        reject(e);
      }
    });
  };

  // Expose for tests
  UA._detachUncapturableMarkers = detachUncapturableMarkers;

  /**
   * Capture the current map view styled for export: high-contrast accident
   * points overlay (severity-coloured, white border) on top of a dimmed
   * heatmap. This is what the Tasks call for: locations dominate, density
   * stays as supporting context (Tasks 1, 5, 7).
   *
   * The wrapper is symmetric – `endExportMapMode` always runs, even on
   * capture errors – so the live map state is restored unconditionally.
   *
   * @param {Object} ctx
   * @param {Object} [options]
   * @returns {Promise<string>} Base64 PNG data URL
   */
  UA.captureExportMapImage = async function captureExportMapImage(ctx, options = {}) {
    let token = null;
    try {
      if (typeof UA.beginExportMapMode === "function") {
        // Allow callers (e.g. cluster maps) to restrict the severity overlay
        // to a specific subset of points so the visible markers exactly match
        // the table count below the map (Tasks 4, 5, 6).
        const beginOpts = (options && Array.isArray(options.exportPoints))
          ? { points: options.exportPoints }
          : undefined;
        token = UA.beginExportMapMode(ctx, beginOpts);
      }
      // A short wait gives Leaflet a tick to lay out the overlay layer
      // before leaflet-image walks the layer list.
      await new Promise(r => setTimeout(r, 50));
      // leaflet-image ignores the canvas CSS opacity that beginExportMapMode
      // sets, so we additionally clamp the baked heatmap opacity used by
      // captureMapImage to the same ≤0.35 ceiling. Cloned to avoid mutating
      // the caller's options object.
      const exportOptions = { ...options };
      const HEAT_EXPORT_CEILING = 0.35;
      if (typeof exportOptions.heatmapExportOpacity === "number"
          && Number.isFinite(exportOptions.heatmapExportOpacity)) {
        exportOptions.heatmapExportOpacity = Math.min(
          exportOptions.heatmapExportOpacity, HEAT_EXPORT_CEILING);
      } else {
        exportOptions.heatmapExportOpacity = HEAT_EXPORT_CEILING;
      }
      return await UA.captureMapImage(ctx, exportOptions);
    } finally {
      if (typeof UA.endExportMapMode === "function") {
        try { UA.endExportMapMode(ctx, token); } catch { /* swallow */ }
      }
    }
  };

  // =====================================================================
  // Word Document Export (using docx.js)
  // =====================================================================

  // Shared helper: map OSM POI type key to German label
  const POI_TYPE_LABELS = { school: "Schulen", kindergarten: "Kindergärten", childcare: "Kitas" };
  function poiTypeLabel(type) {
    return POI_TYPE_LABELS[type] || type;
  }

  /**
   * Capture a detail map image zoomed to selectionBounds.
   * Temporarily calls fitBounds (with animation disabled), waits for re-render,
   * captures, then restores the original view.
   * Throws if ctx.map or ctx.selectionBounds are missing; capture errors propagate
   * to the caller, which is responsible for graceful fallback.
   * @param {Object} ctx - Application context
   * @param {Object} options - Export options
   * @returns {Promise<string>} Base64 image data URL
   */
  async function captureDetailMap(ctx, options) {
    if (!ctx.map || !ctx.selectionBounds) {
      throw new Error("No map or selectionBounds available for detail capture");
    }

    // Save current map state
    const origCenter = ctx.map.getCenter();
    const origZoom = ctx.map.getZoom();

    try {
      // Zoom to selection bounds without animation to avoid capturing mid-animation
      ctx.map.fitBounds(ctx.selectionBounds, { animate: false });

      // Wait for tiles to load and the map to re-render
      await new Promise(resolve => setTimeout(resolve, 500));

      // Use export-styled capture so individual accident points are visible
      // on the detail map (Tasks 1, 5).
      const imageData = await UA.captureExportMapImage(ctx, options);
      return imageData;
    } finally {
      // Always restore original map state
      try {
        ctx.map.setView(origCenter, origZoom, { animate: false });
      } catch (restoreErr) {
        console.warn("Failed to restore map view after detail capture:", restoreErr);
      }
    }
  }

  /**
   * Capture additional zoom-in maps for the dominant accident clusters
   * (Tasks 2, 3, 4). Centers each capture on the actual coordinate centroid
   * of the cluster (not on selectionBounds), at a zoom level chosen by
   * point density. Returns at most `opts.maxTargets` captures (default 2).
   *
   * Each returned entry: { label, image, total, lat, lon, zoom }.
   * Failures for individual targets are logged and skipped – we never let a
   * single cluster capture break the export pipeline.
   *
   * @param {Object} ctx
   * @param {Object} options
   * @param {Object} [opts]
   * @returns {Promise<Array<{label:string,image:string,total:number,lat:number,lon:number,zoom:number}>>}
   */
  async function captureClusterMaps(ctx, options, opts) {
    if (!ctx || !ctx.map) return [];
    if (typeof UA.computeClusterMapTargets !== "function") return [];
    let points = (ctx.viewportPts && ctx.viewportPts.length)
      ? ctx.viewportPts
      : (ctx.allPts || []);

    // When the user has drawn a selection rectangle, restrict the cluster
    // analysis to points inside that rectangle. Without this filter,
    // computeClusterMapTargets could pick hotspots from a different part of
    // the viewport that are completely unrelated to the marked area.
    if (ctx.selectionBounds && typeof ctx.selectionBounds.contains === "function") {
      points = points.filter(p =>
        Number.isFinite(p?.lat) && Number.isFinite(p?.lon) &&
        ctx.selectionBounds.contains([p.lat, p.lon])
      );
    }

    const targets = UA.computeClusterMapTargets(points, opts);
    if (!targets.length) return [];

    const origCenter = ctx.map.getCenter();
    const origZoom = ctx.map.getZoom();
    const out = [];
    try {
      for (const t of targets) {
        try {
          // Prefer fitBounds on the cluster's actual bounding box so the map
          // shows exactly the cluster area – never an unrelated part of the
          // city (Task 7). A small padding keeps edge markers visible.
          let actualZoom = t.zoom;
          if (t.bounds && typeof window !== "undefined" && window.L
              && Number.isFinite(t.bounds.south)) {
            const ll = window.L.latLngBounds(
              [t.bounds.south, t.bounds.west],
              [t.bounds.north, t.bounds.east]
            );
            // maxZoom guard avoids over-zooming for single-point clusters
            // where bounds collapse to a point.
            ctx.map.fitBounds(ll, { animate: false, padding: [16, 16], maxZoom: t.zoom });
            try { actualZoom = ctx.map.getZoom(); } catch { /* fall back to planned t.zoom */ }
          } else {
            ctx.map.setView([t.lat, t.lon], t.zoom, { animate: false });
          }
          // Tile load + Leaflet render tick.
          await new Promise(r => setTimeout(r, 500));
          // Render only the cluster's own points as severity markers so the
          // visible n exactly matches the table (Task 5 / Task 6 verification
          // sentence).
          const captureOpts = { ...options };
          if (Array.isArray(t.points) && t.points.length) {
            captureOpts.exportPoints = t.points;
          }
          const image = await UA.captureExportMapImage(ctx, captureOpts);
          out.push({
            label: t.label,
            image,
            total: t.total,
            lat: t.lat,
            lon: t.lon,
            zoom: actualZoom,
            bounds: t.bounds || null,
            points: Array.isArray(t.points) ? t.points : []
          });
        } catch (err) {
          console.warn("Cluster map capture failed for target (graceful fallback):", t, err);
        }
      }
    } finally {
      try {
        ctx.map.setView(origCenter, origZoom, { animate: false });
      } catch (restoreErr) {
        console.warn("Failed to restore map view after cluster capture:", restoreErr);
      }
    }
    return out;
  }
  // Exported for tests; the public name stays inside the IIFE.
  UA._captureClusterMaps = captureClusterMaps;
  UA._captureDetailMap = captureDetailMap;

  /**
   * Build the German verification sentence required below every exported map
   * (Task 6). The exact wording is mandated by the Werkbank export spec.
   * @param {number} n
   * @returns {string}
   */
  function mapVerificationSentence(n) {
    const safe = Number.isFinite(Number(n)) ? Math.max(0, Math.trunc(Number(n))) : 0;
    return `Die dargestellten Punkte entsprechen exakt den in der Tabelle aufgeführten Unfällen (n = ${safe}).`;
  }
  UA.mapVerificationSentence = mapVerificationSentence;

  /**
   * Count points whose coordinates fall inside a {south,west,north,east}
   * bounding box. Used for Task 5 (cross-check map ↔ table count) and to
   * compute n for the verification sentence (Task 6).
   * @param {Array<{lat:number,lon:number}>} points
   * @param {{south:number,west:number,north:number,east:number}|null|undefined} bounds
   * @returns {number}
   */
  function countPointsInBounds(points, bounds) {
    if (!Array.isArray(points) || !bounds) return 0;
    const { south, west, north, east } = bounds;
    if (![south, west, north, east].every(Number.isFinite)) return 0;
    let n = 0;
    for (const p of points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      if (p.lat >= south && p.lat <= north && p.lon >= west && p.lon <= east) n++;
    }
    return n;
  }
  UA._countPointsInBounds = countPointsInBounds;

  /**
   * Derive a {south,west,north,east} bbox from the export-relevant area on
   * `ctx`. Mirrors `boundsForExport` in js/ua.export_v2.js (selectionBounds
   * wins, otherwise the current map viewport). Returns null if no usable
   * bounds are available — in that case the consistency check below short-
   * circuits as success.
   */
  function exportBoundsFromCtx(ctx) {
    if (!ctx) return null;
    const lb = ctx.selectionBounds || (ctx.map && typeof ctx.map.getBounds === "function" ? ctx.map.getBounds() : null);
    if (!lb || typeof lb.getSouthWest !== "function" || typeof lb.getNorthEast !== "function") return null;
    const sw = lb.getSouthWest();
    const ne = lb.getNorthEast();
    if (!sw || !ne || !Number.isFinite(sw.lat) || !Number.isFinite(sw.lng) || !Number.isFinite(ne.lat) || !Number.isFinite(ne.lng)) return null;
    return { south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng };
  }
  UA._exportBoundsFromCtx = exportBoundsFromCtx;

  /**
   * Pre-Flight-Konsistenz-Gate für PDF/DOCX-Export (Phase 2.2 des Sanierungs-
   * plans). Stellt die Invariante sicher:
   *
   *   accidentDetails.total ≤ structured.totalAccidents
   *   countPointsInBounds(ctx.viewportPts, exportBbox) === structured.totalAccidents
   *
   * Hintergrund: Der Render-Gate für Cluster-Karten (Task 5) prüft nur
   * einzelne Bounding-Boxen. Eine globale Inkonsistenz – etwa wenn das
   * Tabellen-Modell mehr Punkte führt, als auf den Karten tatsächlich
   * gerendert werden – würde dort durchrutschen und Vertrauen brechen
   * („Bericht behauptet 262, Karte zeigt 250").
   *
   * Bei Mismatch liefert die Funktion `{ ok: false, ... }` mit einer
   * deutschen Fehlermeldung im exakt vom Plan vorgeschriebenen Wortlaut
   * („Export abgebrochen: Tabelle (n=X) und Karte (n=Y) inkonsistent.").
   * Aufrufer (Export-Handler) brechen den Export daraufhin ab und zeigen
   * die Meldung im Modal-Banner (#exportProgress).
   *
   * Defensiv: fehlende/unvollständige Eingaben → ok:true (kein false-positive
   * Abbruch in Tests oder bei sehr kleinen Datensätzen ohne Bounds).
   *
   * @param {Object} ctx        Application context (uses ctx.viewportPts und
   *                            ctx.selectionBounds / ctx.map).
   * @param {Object} structured Output von UA.computeExportReport(...).structured
   * @returns {{ok:boolean, message?:string, nTable?:number, nMap?:number, kind?:string}}
   */
  function validateExportConsistency(ctx, structured) {
    if (!structured || typeof structured !== "object") return { ok: true };

    // Kanonische Fallzahl: bevorzugt structured.totalAccidents (Phase-2.2-
    // Erweiterung), Fallback severity.total für Alt-Reports/Tests.
    let totalAccidents = null;
    if (Number.isFinite(structured.totalAccidents)) {
      totalAccidents = structured.totalAccidents;
    } else if (structured.severity && Number.isFinite(structured.severity.total)) {
      totalAccidents = structured.severity.total;
    }
    if (totalAccidents === null) return { ok: true };

    // Invariante 1: Detail-Tabelle darf nie mehr Zeilen führen als die
    // Gesamt-Fallzahl behauptet (mask-0-Punkte werden in accidentDetails
    // ausgefiltert, sind aber in severity.total mitgezählt → ≤, nicht ===).
    const ad = structured.accidentDetails;
    const adTotal = (ad && Number.isFinite(ad.total)) ? ad.total : null;
    if (adTotal !== null && adTotal > totalAccidents) {
      return {
        ok: false,
        kind: "table_exceeds_total",
        nTable: adTotal,
        nMap: totalAccidents,
        message: `Export abgebrochen: Tabelle (n=${adTotal}) und Karte (n=${totalAccidents}) inkonsistent.`
      };
    }

    // Invariante 2: Die Punkte, die der Export auf der Übersichtskarte
    // rendert (= ctx.viewportPts innerhalb der Export-Bounds), müssen mit
    // den Zeilen der Einzelunfall-Tabelle (= structured.accidentDetails)
    // übereinstimmen. Beide Datenquellen sind beteiligungsgefiltert
    // (mask>0 + Involvement-Filter), während structured.totalAccidents
    // alle non-involvement-gefilterten Punkte (inkl. mask=0) zählt — ein
    // direkter Vergleich gegen totalAccidents erzeugte bei realen Daten
    // immer einen False-Positive (siehe Sanierungsplan Phase 2.2).
    // Fallback auf totalAccidents nur, wenn accidentDetails fehlt
    // (Alt-Reports/Tests ohne Detail-Tabelle).
    const ad2 = structured.accidentDetails;
    const ad2Total = (ad2 && Number.isFinite(ad2.total)) ? ad2.total : null;
    const tableN = (ad2Total !== null) ? ad2Total : totalAccidents;
    const bbox = exportBoundsFromCtx(ctx);
    const pts = (ctx && Array.isArray(ctx.viewportPts)) ? ctx.viewportPts : null;
    if (bbox && pts) {
      const nMap = countPointsInBounds(pts, bbox);
      if (nMap !== tableN) {
        return {
          ok: false,
          kind: "table_map_mismatch",
          nTable: tableN,
          nMap,
          message: `Export abgebrochen: Tabelle (n=${tableN}) und Karte (n=${nMap}) inkonsistent.`
        };
      }
    }

    // Invariante 3 (PR 2 / Spec-Item 5 — cluster-subset): Jede Cluster-/
    // Gruppen-Zählung in accidentDetails.groups ist eine Teilmenge der
    // Gesamtfallzahl im Ausschnitt. Eine Gruppe darf NIE größer sein als
    // die Gesamtmenge der sie enthaltenden Tabelle. Außerdem darf die
    // Summe mehrerer Cluster (z. B. mainCluster + secondaryCluster) NICHT
    // automatisch mit der Gesamtsumme gleichgesetzt werden — Cluster
    // können sich nicht überlappen, müssen aber auch nicht erschöpfend
    // sein. Dieser Check fängt verfälschte Cluster-Counts ab, bevor sie
    // im PDF/DOCX als „n=X" gerendert und in den Verifikationssatz
    // übernommen werden.
    if (ad2 && Array.isArray(ad2.groups) && Number.isFinite(tableN)) {
      for (const g of ad2.groups) {
        if (!g || !Number.isFinite(g.count)) continue;
        if (g.count > tableN) {
          const label = g.sevLabel || g.key || "(unbenannt)";
          return {
            ok: false,
            kind: "cluster_exceeds_total",
            nCluster: g.count,
            nTable: tableN,
            clusterLabel: label,
            message: `Export abgebrochen: Cluster „${label}" (n=${g.count}) ist größer als die Tabellen-Gesamtsumme (n=${tableN}).`
          };
        }
      }
    }

    return { ok: true };
  }
  UA.validateExportConsistency = validateExportConsistency;

  // ---------------------------------------------------------------------
  // QA-PR „Export-Semantik vor Layout" — Export-QA-Gate
  //
  // Prüft den `pdfMake`-`docDefinition.content`-Baum (oder den DOCX-
  // Children-Baum) auf verbotene Tokens, bevor die Datei erzeugt wird:
  //   - Beteiligten-Emojis  (🚲/🚗/🚶/🚌/🏍/🚛)
  //   - FontAwesome / Private-Use-Codepoints  (U+E000…U+F8FF)
  //   - „Fetch is aborted" / „Beteiligungsmaske" / isoliertes „Scope"
  //   - „undefined" / „null" als sichtbarer Zellinhalt
  //   - „+ :" oder „+:"-Kombinationen ohne Textlabel (das frühere
  //     QA-Symptom „Symbol-Wüste" in den Kreuztabellen).
  //
  // Liefert `{ ok:true }` oder `{ ok:false, violations: [...] }`. Caller
  // (in `exportToPDF`) wirft auf Verletzung mit lesbarer Meldung, damit
  // der Export NICHT als „PR-reifes" PDF nach außen dringt.
  // ---------------------------------------------------------------------
  function _walkVisibleStrings(node, sink) {
    if (node == null) return;
    if (Array.isArray(node)) { for (const n of node) _walkVisibleStrings(n, sink); return; }
    if (typeof node === "string") { sink(node); return; }
    if (typeof node !== "object") return;
    if (typeof node.text === "string") sink(node.text);
    else if (Array.isArray(node.text)) _walkVisibleStrings(node.text, sink);
    if (Array.isArray(node.stack))   _walkVisibleStrings(node.stack, sink);
    if (Array.isArray(node.columns)) _walkVisibleStrings(node.columns, sink);
    if (Array.isArray(node.ul))      _walkVisibleStrings(node.ul, sink);
    if (Array.isArray(node.ol))      _walkVisibleStrings(node.ol, sink);
    if (node.table && Array.isArray(node.table.body)) {
      for (const row of node.table.body) for (const cell of row) _walkVisibleStrings(cell, sink);
    }
  }

  // Forbidden glyphs: involvement emojis + FontAwesome/private-use range.
  const _QA_FORBIDDEN_GLYPH_RE =
    /(\u{1F6B2}|\u{1F6B6}|\u{1F697}|\u{1F3CD}\u{FE0F}?|\u{1F69B}|\u{1F68C}|[\uE000-\uF8FF])/u;
  // Forbidden technical words / phrases.
  const _QA_FORBIDDEN_PHRASES = [
    { re: /Fetch is aborted/i,                                  reason: 'Technische Fehlermeldung "Fetch is aborted" im Antrag.' },
    { re: /Beteiligungsmaske/,                                  reason: 'Technischer Begriff "Beteiligungsmaske" im sichtbaren Text.' },
    { re: /(?:^|[^A-Za-zÄÖÜäöüß])Scope(?:[^A-Za-zÄÖÜäöüß]|$)/,  reason: 'Entwicklerjargon "Scope" im sichtbaren Text.' },
    { re: /Vergleichs-Baseline/,                                reason: 'Entwicklerjargon "Vergleichs-Baseline" im sichtbaren Text.' },
    { re: /Aktiver Filter-Scope/,                               reason: 'Entwicklerjargon "Aktiver Filter-Scope" im sichtbaren Text.' },
    { re: /Muster-Analyse/,                                     reason: 'Entwicklerjargon "Muster-Analyse" im sichtbaren Text.' }
  ];
  // „+ :" / „+:" mit nur Symbolen drumherum (typisches QA-Symptom).
  const _QA_PLUS_COLON_RE = /\+\s*:/;

  /**
   * Run the export-content QA gate over the visible strings of a pdfMake
   * docDefinition.content tree (or any tree with the `text`/`stack`/
   * `columns`/`table.body` shape we use).
   *
   * @param {Array|object} contentRoot
   * @returns {{ok: true} | {ok: false, violations: Array<{kind:string,sample:string,reason:string}>}}
   */
  function runExportQAGate(contentRoot) {
    const violations = [];
    const seenSamples = new Set();
    const push = (kind, sample, reason) => {
      const key = kind + "|" + sample;
      if (seenSamples.has(key)) return;
      seenSamples.add(key);
      violations.push({ kind, sample, reason });
    };
    _walkVisibleStrings(contentRoot, (s) => {
      const str = String(s);
      if (!str) return;
      if (_QA_FORBIDDEN_GLYPH_RE.test(str)) {
        push("glyph", str.slice(0, 80), "Beteiligten-Symbol oder Private-Use-Glyph im sichtbaren Export.");
      }
      for (const { re, reason } of _QA_FORBIDDEN_PHRASES) {
        if (re.test(str)) push("phrase", str.slice(0, 120), reason);
      }
      // Standalone "undefined"/"null" cell content (whitespace tolerated).
      if (/^\s*(?:undefined|null)\s*$/.test(str)) {
        push("placeholder", str, 'Roher Platzhalter ("undefined"/"null") als Zellinhalt.');
      }
      // "+ :" / "+:" pattern (cross-table symbol-wüste).
      if (_QA_PLUS_COLON_RE.test(str)) {
        push("symbolOnly", str.slice(0, 80), 'Beteiligungs-Kombination ohne Textlabel ("+ :"-Muster).');
      }
    });
    if (violations.length === 0) return { ok: true };
    return { ok: false, violations };
  }
  UA.runExportQAGate = runExportQAGate;

  /**
   * Derive a {south,west,north,east} bbox from a Leaflet LatLngBounds object.
   * Tolerant of plain {south,west,north,east} objects (already serialised).
   * Returns null if no usable input.
   */
  function boundsToBbox(b) {
    if (!b) return null;
    if (typeof b.getSouth === "function") {
      return {
        south: b.getSouth(), west: b.getWest(),
        north: b.getNorth(), east: b.getEast()
      };
    }
    if (Number.isFinite(b.south) && Number.isFinite(b.west)
        && Number.isFinite(b.north) && Number.isFinite(b.east)) {
      return { south: b.south, west: b.west, north: b.north, east: b.east };
    }
    return null;
  }
  UA._boundsToBbox = boundsToBbox;

  /**
   * Derive a {south,west,north,east} bbox enclosing all supplied points.
   * Returns null if no valid coordinates are present.
   */
  function bboxFromPoints(points) {
    if (!Array.isArray(points) || !points.length) return null;
    let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
    let any = false;
    for (const p of points) {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) continue;
      any = true;
      if (p.lat < south) south = p.lat;
      if (p.lat > north) north = p.lat;
      if (p.lon < west) west = p.lon;
      if (p.lon > east) east = p.lon;
    }
    return any ? { south, west, north, east } : null;
  }
  UA._bboxFromPoints = bboxFromPoints;

  /**
   * Derive a document title from the Gremium type string.
   * @param {string|undefined} gremiumTyp - Value of sd.meta.gremium.typ
   * @returns {string} German document title
   */
  function deriveDocTitle(gremiumTyp) {
    if (!gremiumTyp) return "Antrag zur Verkehrssicherheit";
    const t = gremiumTyp.trim();
    const normalized = t.replace(/\s*\([^)]*\)\s*$/, "");
    if (t === "Bezirksverordnetenversammlung" || t === "BVV" ||
        normalized === "Bezirksverordnetenversammlung" || normalized === "BVV") return "BVV-Antrag";
    if (t === "Bezirksrat" || normalized === "Bezirksrat") return "Bezirksratsantrag";
    if (t === "Bezirksvertretung" || normalized === "Bezirksvertretung") return "Antrag an die Bezirksvertretung";
    return "Antrag zur Verkehrssicherheit";
  }
  // Expose for use in other modules (e.g. ua.app_v2.js for dynamic modal title)
  UA.deriveDocTitle = deriveDocTitle;

  // --------------------
  // Trend-Qualifier (PR-β) und OSM-Voraussetzungen-Hinweis (PR-γ).
  // Identische Wortwahl wie in `js/ua.export_v2.js` (TEXT/HTML), damit
  // DOCX und PDF dieselben Antragstexte ausgeben.
  // --------------------
  function trendQualifierTextDocx(classification) {
    switch (classification) {
      case "steigend":     return "im Mittel der letzten Jahre steigend";
      case "stagnierend":  return "stagnierend hoch (kein erkennbarer Rückgang)";
      case "rückläufig":   return "rückläufig im Mehrjahresvergleich";
      case "unbestimmt":   return "Trend statistisch unbestimmt (zu wenig Datenjahre)";
      default:             return null;
    }
  }
  function osmCoverageNoteDocx(coverage) {
    if (!coverage) return null;
    if (!coverage.present) {
      const why = coverage.error ? ` (${coverage.error})` : "";
      return `OSM-Kontext nicht abgerufen${why}: Maßnahmen-Voraussetzungen wurden mangels Daten NICHT geprüft – die unten gelisteten Vorschläge können daher räumliche Voraussetzungen verletzen.`;
    }
    if (coverage.hasGap) {
      return `OSM-Voraussetzungen mangels Daten nicht geprüft: ${coverage.missingAxes.join(", ")}. Die Vorschläge wurden NICHT anhand dieser Achse(n) gefiltert.`;
    }
    return null;
  }
  // Exportieren, damit Tests die Helfer direkt prüfen können.
  UA.trendQualifierTextDocx = trendQualifierTextDocx;
  UA.osmCoverageNoteDocx = osmCoverageNoteDocx;

  /**
   * Generate and download Word document
   * @param {Object} ctx - Application context
   * @param {Object} reportData - Report data from UA.computeExportReport
   * @param {Object} options - Export options
   */
  UA.exportToWord = async function exportToWord(ctx, reportData, options = {}) {
    // Ensure export libraries are loaded
    await UA.ensureExportLibraries();
    
    if (!window.docx) {
      throw new Error("docx.js library not loaded");
    }

    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun,
            Table, TableRow, TableCell, WidthType, BorderStyle, ExternalHyperlink } = window.docx;

    // ---------------------------------------------------------------
    // PR-QA „DOCX-Härtung": eindeutige docPr-IDs + altText pro Bild.
    // docx@9.x speichert Bilder ohne `type` als `word/media/*.undefined`,
    // was Word/LibreOffice/PDF-Konverter destabilisiert. Außerdem vergibt
    // die Library ohne `altText.id` für jedes Bild dieselbe `docPr id="1"`,
    // was OOXML-technisch unsauber ist und Screenreader stört. Die Helper
    // `nextImageId()` und `pngImageRun()` zentralisieren Type, Alt-Text
    // und ID-Vergabe für alle drei Karten-Bildquellen (Übersicht, Detail,
    // Cluster) und werden vom QA-Test geprüft.
    // ---------------------------------------------------------------
    // Bild-IDs starten bewusst bei 1000 (statt 1), damit sie sich von
    // historischen `docPr id="1"` Werten klar abheben — erleichtert das
    // Debugging in alten vs. neuen DOCX und macht den QA-Test gegen
    // doppelte ID="1" robuster.
    let _docxImageIdSeq = 1000;
    function nextImageId() { return String(_docxImageIdSeq++); }

    /**
     * Build a docx ImageRun for a PNG with mandatory accessibility
     * metadata. Decodes either a base64-encoded data URL or raw base64
     * (leaflet-image always produces PNG).
     * @param {string} dataUrlOrBase64 - data URL or raw base64 string
     * @param {{width:number,height:number}} transformation
     * @param {{title:string, description:string}} alt
     */
    function pngImageRun(dataUrlOrBase64, transformation, alt) {
      const base64 = String(dataUrlOrBase64 || "").replace(/^data:image\/png;base64,/, "");
      const binaryString = atob(base64);
      const data = Uint8Array.from(binaryString, c => c.charCodeAt(0));
      const id = nextImageId();
      const altText = {
        // `name` is also used as the image's filename inside the DOCX
        // package — must be unique to avoid collisions in word/media.
        name: `Bild_${id}`,
        title: (alt && alt.title) || "Karte",
        description: (alt && alt.description) || "Kartenausschnitt des untersuchten Unfallbereichs",
        id
      };
      return new ImageRun({
        type: "png",            // ← fixes word/media/*.undefined bug
        data,
        transformation,
        altText
      });
    }

    // Helper: shared cell border style
    const cellBorder = {
      top:    { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      left:   { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      right:  { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" }
    };

    // Helper: build a table cell containing plain text. Emoji-bearing strings
    // (e.g. "🚲+🚗") get sanitized first so DOCX viewers without an emoji-
    // capable body font still show the involvement labels (PR-QA Task 1).
    function textCell(text, bold) {
      return new TableCell({
        borders: cellBorder,
        children: [new Paragraph({ children: [new TextRun({ text: replaceEmojisForDocx(text), bold })] })]
      });
    }

    // Helper to build a simple bordered table from headers + rows (plain text cells)
    // Optional: rowHighlights is an array of booleans – true = highlight that data row
    // Cells go through `replaceEmojisForDocx` so involvement icons fall back to
    // text labels (`[Rad]+[PKW]`) when the Word installation lacks an emoji
    // body font (PR-QA Task 1).
    //
    // PR-QA „Tabellenlayout":
    //  - explizite Spaltenbreiten (DXA-Twips) statt der generischen Default-
    //    Verteilung von docx@9, damit lange Tabellen nicht über den rechten
    //    Seitenrand hinauslaufen (A4 nutzbare Breite ≈ 9000 Twips).
    //  - Kopfzeile als wiederholter Header (`tableHeader: true`), damit lange
    //    Tabellen auch auf Folgeseiten ihre Spaltenbeschriftung behalten.
    //  - gleichmäßige bzw. gewichtete Spaltenverteilung fördert Zellumbruch
    //    in schmalen Spalten, ohne hier zusätzliche Row-Optionen zu setzen.
    function _twipsForCols(numCols, weights) {
      const total = 9000; // ≈ A4 (210 mm) Portrait usable width in twips
      if (Array.isArray(weights) && weights.length === numCols) {
        const sum = weights.reduce((a, b) => a + b, 0) || numCols;
        return weights.map(w => Math.max(400, Math.round(total * w / sum)));
      }
      // even split, but never narrower than 400 twips per column
      const each = Math.max(400, Math.floor(total / Math.max(1, numCols)));
      return Array(numCols).fill(each);
    }

    function makeDocxTable(headers, dataRows, rowHighlights, opts) {
      const numCols = headers.length;
      const colWidths = _twipsForCols(numCols, opts && opts.colWeights);
      const makeRow = (cells, bold, highlight, isHeader) =>
        new TableRow({
          tableHeader: !!isHeader,
          children: cells.map((text, ci) => {
            return new TableCell({
              borders: cellBorder,
              width: { size: colWidths[ci] || colWidths[0], type: WidthType.DXA },
              children: [new Paragraph({ children: [new TextRun({ text: replaceEmojisForDocx(text), bold })] })],
              ...(highlight ? { shading: { fill: "FFFFCC" } } : {})
            });
          })
        });
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: colWidths,
        rows: [
          makeRow(headers, true, false, true),
          ...dataRows.map((row, i) => makeRow(row, false, rowHighlights ? rowHighlights[i] : false, false))
        ]
      });
    }

    // Helper to build a 2-column key/value table where the value cell may be a hyperlink.
    // Row schema:
    //   [key, value, false]                       → plain value cell
    //   [key, displayText, true, hrefOverride?]   → hyperlink cell; if
    //         hrefOverride is set, the URL stored in the link is taken
    //         from there and `displayText` is shown as a short caption.
    //
    // PR-QA „Tabellenlayout": schmale Label-Spalte (~2200 twips ≈ 38 mm),
    // breite Wert-Spalte (~6800 twips). Dadurch passen lange Werte
    // (Bereich, Hinweis-Text) sauber, ohne dass die Label-Spalte unnötig
    // viel Platz frisst.
    function makeKVTable(rows) {
      const colWidths = [2200, 6800];
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: colWidths,
        rows: rows.map(([key, value, isLink, hrefOverride]) => {
          const keyCell = new TableCell({
            borders: cellBorder,
            width: { size: colWidths[0], type: WidthType.DXA },
            children: [new Paragraph({ children: [new TextRun({ text: replaceEmojisForDocx(key), bold: true })] })]
          });
          let valueCell;
          if (isLink) {
            const href = hrefOverride || value;
            const link = ExternalHyperlink
              ? new ExternalHyperlink({
                  link: href,
                  children: [new TextRun({ text: value, style: "Hyperlink" })]
                })
              : new TextRun({ text: value });
            valueCell = new TableCell({
              borders: cellBorder,
              width: { size: colWidths[1], type: WidthType.DXA },
              children: [new Paragraph({ children: [link] })]
            });
          } else {
            valueCell = new TableCell({
              borders: cellBorder,
              width: { size: colWidths[1], type: WidthType.DXA },
              children: [new Paragraph({ children: [new TextRun({ text: replaceEmojisForDocx(value), bold: false })] })]
            });
          }
          return new TableRow({ children: [keyCell, valueCell] });
        })
      });
    }

    const children = [];
    // PR-QA Task 1: Body-Text durch dieselbe Emoji→Label-Substitution wie der
    // PDF-Renderer schicken – DOCX hat dasselbe Font-Risiko (Beteiligungs-
    // Symbole bleiben auf vielen Word-Installationen leer).
    const docxText = replaceEmojisForDocx(reportData.text || "");
    const textLines = docxText ? docxText.split("\n") : [];

    // Use structured data if available (preferred path), else fall back to text parsing
    const sd = reportData.structured || null;

    // Task 5: Dedup-Guard. Renderpfad pro Sektion höchstens einmal ausgeben.
    // Aktuell rendert dieser Code jede Sektion exakt einmal aus structured;
    // diese Guard-Set verhindert zukünftige Regressions, bei denen Text-
    // Fallback (`textLines`) und structured-Pfad denselben Block doppeln.
    const renderedSections = new Set();
    /** @returns {boolean} true wenn schon gerendert (Caller überspringt dann). */
    function _alreadyRendered(name) {
      if (renderedSections.has(name)) return true;
      renderedSections.add(name);
      return false;
    }
    // Expose for nested helpers within this function.
    const sectionGuard = _alreadyRendered;

    // Helper: determine if a cross-table row mask matches the active filter
    const afm = (sd && sd.meta && sd.meta.activeFilterMask) || 0;
    const afMode = (sd && sd.meta && sd.meta.involvementMode) || "or";
    function isActiveFilterRow(rowMask) {
      if (afm === 0) return false;
      if (afMode === "solo") {
        const isSingleBit = rowMask > 0 && (rowMask & (rowMask - 1)) === 0;
        return isSingleBit && (rowMask & afm) !== 0;
      }
      if (afMode === "and") {
        return (rowMask & afm) === afm;
      }
      return (rowMask & afm) !== 0;
    }

    const CITY_RAW = ctx.CITY_RAW || "—";
    const today = new Date().toLocaleDateString("de-DE");

    // ---- 1. Derive document title from meta ----
    const gremiumMeta = sd && sd.meta && sd.meta.gremium ? sd.meta.gremium : {};
    const docTitle = deriveDocTitle(gremiumMeta.typ);

    // ---- 2. Dokumentkopf ----
    children.push(
      new Paragraph({
        text: docTitle.toUpperCase(),
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER
      })
    );

    // Sublines: An, Stadt, Bereich, Datum, Betreff
    const metaCity    = (sd && sd.meta && sd.meta.city)     || CITY_RAW;
    const metaArea    = (sd && sd.meta && sd.meta.areaName) || "(Kartenausschnitt)";
    const metaDate    = (sd && sd.meta && sd.meta.date)     || today;
    const metaToWhom  = gremiumMeta.gremium || "zuständiges Gremium prüfen";

    const headerLines = [
      ["An:", metaToWhom],
      ["Stadt:", metaCity],
      ["Bereich:", metaArea],
      ["Datum:", metaDate],
      ["Betreff:", "Verbesserung der Verkehrssicherheit – auffälliger Unfallschwerpunkt im markierten Bereich"]
    ];
    for (const [label, value] of headerLines) {
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `${label} `, bold: true }),
          new TextRun({ text: value })
        ],
        spacing: { before: 80, after: 80 }
      }));
    }

    children.push(new Paragraph({
      text: "---------------------------------",
      alignment: AlignmentType.CENTER,
      spacing: { before: 100, after: 200 }
    }));

    // ---- 3. Rahmendaten (metadata box) ----
    const metaLink    = (sd && sd.meta && sd.meta.link) || "";
    const IS_LINK = true;
    const kvRahmen = [
      ["Dokumenttyp", docTitle, false],
      gremiumMeta.gremium   ? ["Gremium",              gremiumMeta.gremium,   false]   : null,
      gremiumMeta.typ       ? ["Gremiumstyp",          gremiumMeta.typ,       false]   : null,
      gremiumMeta.kontakt   ? ["Kontakt",               gremiumMeta.kontakt,   false]   : null,
      metaArea              ? ["Bereich",               metaArea,              false]   : null,
      metaCity              ? ["Stadt",                 metaCity,              false]   : null,
      metaDate              ? ["Exportdatum",           metaDate,              false]   : null,
      metaLink              ? ["Werkbank-Link",         "Werkbank-Link öffnen", IS_LINK, metaLink] : null,
      gremiumMeta.hinweis   ? ["Zuständigkeitshinweis", gremiumMeta.hinweis,   false]   : null
    ].filter(Boolean);

    if (kvRahmen.length > 0) {
      children.push(new Paragraph({
        text: "Rahmendaten",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 }
      }));
      children.push(makeKVTable(kvRahmen));
      children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
    }

    // ---- 4. Aktive Filter ----
    // PR-QA „Textqualität": rohe technische Filterwerte (z. B. "all",
    // "wet", numerische Codes) in lesbare deutsche Begriffe übersetzen.
    // Sonst landen Zeilen wie „Schweregrad: all" oder „Wochentag: all" im
    // einreichungsreifen Antrag und wirken wie ein Rohdatenexport.
    const filters = (sd && sd.meta && sd.meta.filters) || {};
    const filterRows = [];
    const fmtFilterValue = (UA && typeof UA.formatFilterValue === "function")
      ? UA.formatFilterValue
      : (key, val) => String(val);

    if (filters.severity   != null) filterRows.push(["Schweregrad",       fmtFilterValue("severity", filters.severity),               false]);
    if (filters.roadCondition != null) filterRows.push(["Fahrbahnzustand", fmtFilterValue("roadCondition", filters.roadCondition),    false]);
    if (filters.involvementMode != null) filterRows.push(["Beteiligungsmodus", fmtFilterValue("involvementMode", filters.involvementMode), false]);

    // Build participation flags label — Prosa-Form (QA-PR „Export-Semantik
    // vor Layout"): keine Emojis im DOCX-Sichtbereich.
    const partCodes = [];
    if (filters.includeCyclist)    partCodes.push("Rad");
    if (filters.includePedestrian) partCodes.push("Fuss");
    if (filters.includeCar)        partCodes.push("PKW");
    if (filters.includeMotorcycle) partCodes.push("Krad");
    if (filters.includeGkfz)       partCodes.push("Lkw");
    if (filters.includeSonstig)    partCodes.push("Sonst");
    if (partCodes.length > 0) {
      const partProse = (typeof UA.formatParticipantCombinationForExport === "function")
        ? UA.formatParticipantCombinationForExport(partCodes)
        : partCodes.join(" + ");
      filterRows.push(["Beteiligte", partProse, false]);
    }

    if (filters.hourFrom != null && filters.hourTo != null) {
      filterRows.push(["Zeitraum", `${filters.hourFrom}:00–${filters.hourTo}:00 Uhr`, false]);
    }
    if (filters.dayType != null) filterRows.push(["Wochentag", fmtFilterValue("dayType", filters.dayType), false]);

    if (filterRows.length > 0) {
      children.push(new Paragraph({
        text: "Aktive Filter",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 }
      }));
      children.push(makeKVTable(filterRows));
      children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
    }

    // ---- 4b. Hinweis zur Zählweise (PR 2 / Spec-Item 4) ----
    // Direkt nach dem „Aktive Filter"-Block, damit Lesende beim Übergang
    // zu den eigentlichen Inhalten wissen, worauf sich alle folgenden
    // Fallzahlen beziehen. Optisch als kursive Info-Box gestaltet.
    children.push(new Paragraph({
      children: [new TextRun({ text: HINWEIS_ZAEHLWEISE_LINES[0], bold: true, italics: true })],
      spacing: { before: 100, after: 60 }
    }));
    children.push(new Paragraph({
      children: [new TextRun({ text: HINWEIS_ZAEHLWEISE_LINES[1], italics: true })],
      spacing: { after: 200 }
    }));

    // ---- 4c. Methodik – Scope der Auswertung (PR 2 / Spec-Item 6) ----
    // Spiegelt structured.methodikScope (drei Sätze) als kompakter
    // Methodik-Block in das DOCX. Der Block fasst die in
    // structured.meta.activeFilterScope / patternAnalysisScope /
    // baselineScope hinterlegten Definitionen für Lesende zusammen.
    if (sd && sd.methodikScope && Array.isArray(sd.methodikScope.lines) && sd.methodikScope.lines.length > 0) {
      children.push(new Paragraph({
        text: sd.methodikScope.title || "Methodik – Scope der Auswertung",
        heading: HeadingLevel.HEADING_3,
        spacing: { before: 100, after: 80 }
      }));
      for (const ln of sd.methodikScope.lines) {
        children.push(new Paragraph({
          children: [new TextRun({ text: String(ln) })],
          spacing: { after: 60 }
        }));
      }
      children.push(new Paragraph({ text: "", spacing: { after: 120 } }));
    }

    // ---- 4d. Figure-Caption-Counter (PR 2 / Spec-Item 4) ----
    // Pro DOCX-Aufruf wird ein eigener Counter erzeugt; jede der drei
    // Bildklassen (Übersichts-, Detail-, Cluster-Karte) ruft figCounter
    // .next(...) auf und fügt die Bildunterschrift unmittelbar unter
    // dem ImageRun ein.
    const figCounter = makeFigureCounter();

    // ---- 4a. ANTRAG / BESCHLUSSVORSCHLAG (Layout-PR „Semantische
    // Dokumentstruktur"): Verwaltungsdokumente führen den Antragstext
    // direkt nach dem Dokumentkopf, damit das Lesegremium ohne Suchen
    // erkennt, worüber abgestimmt werden soll. Der ausführliche
    // Wortlaut bleibt zusätzlich am Ende erhalten (BESCHLUSSVORSCHLAG-
    // Block via sectionGuard nicht mehr doppelt gerendert).
    {
      const beschlussLeadDocx = extractSection(textLines, "Beschlussvorschlag:");
      const beschlussTextDocx = (Array.isArray(beschlussLeadDocx) ? beschlussLeadDocx : [])
        .map(l => String(l || "").trim())
        .filter(Boolean);
      children.push(new Paragraph({
        text: "ANTRAG / BESCHLUSSVORSCHLAG",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 300, after: 150 }
      }));
      if (beschlussTextDocx.length > 0) {
        for (const line of beschlussTextDocx) {
          children.push(new Paragraph({ text: line, spacing: { after: 120 } }));
        }
      } else {
        children.push(new Paragraph({
          text: "Der Bezirksrat fordert die Verwaltung auf, innerhalb von 3 Monaten den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen. Die Wirksamkeit der Maßnahmen ist nach 12 Monaten anhand der Unfallatlas-Daten zu evaluieren.",
          spacing: { after: 200 }
        }));
      }
      // markiere die spätere Sektion als bereits gerendert, damit kein
      // doppelter „BESCHLUSSVORSCHLAG"-Block am Dokumentende erscheint.
      sectionGuard("BESCHLUSSVORSCHLAG");
    }

    // ---- 4a-2. BEGRÜNDUNG (Sammelüberschrift) ----
    // Layout-PR „Semantische Dokumentstruktur": Sachverhalt, Statistik,
    // Bewertung und Maßnahmen sind zusammen die Begründung des Antrags.
    // Eine sichtbare Heading-2-Klammer macht das im PDF/DOCX explizit
    // sichtbar – sonst wirkt die Aufzählung wie unzusammenhängende
    // Einzelblöcke.
    children.push(new Paragraph({
      text: "BEGRÜNDUNG",
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 300, after: 100 }
    }));

    // ---- 4b. KURZBEWERTUNG (Task 2) ----
    if (sd && sd.executiveSummary) {
      const es = sd.executiveSummary;
      children.push(new Paragraph({
        text: "KURZBEWERTUNG",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      children.push(new Paragraph({
        children: [new TextRun({ text: es.classification, bold: true })],
        spacing: { after: 120 }
      }));
      for (const b of (es.bullets || [])) {
        children.push(new Paragraph({ text: "• " + b, spacing: { after: 60 } }));
      }
      if (es.urgency) {
        children.push(new Paragraph({
          children: [new TextRun({ text: es.urgency, italics: true })],
          spacing: { before: 100, after: 200 }
        }));
      }
      // Task 7 – Map reference sentences immediately after KURZBEWERTUNG.
      if (Array.isArray(sd.mapReferences) && sd.mapReferences.length > 0) {
        for (const s of sd.mapReferences) {
          children.push(new Paragraph({ text: s, spacing: { after: 80 } }));
        }
      }
    }

    // ---- 5. SACHVERHALT section ----
    children.push(
      new Paragraph({
        text: "SACHVERHALT",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      })
    );

    // Parse the text report to extract the SACHVERHALT section using helper.
    // Stop list mirrors POST_SACHVERHALT_STOP_HEADERS (minus "Sachverhalt:"
    // itself, which is the entry marker) so post-Sachverhalt blocks like
    // Mehrjahres-Trend never leak into the SACHVERHALT paragraph.
    const sachverhaltSection = extractSection(
      textLines,
      "Sachverhalt:",
      POST_SACHVERHALT_STOP_HEADERS.filter(h => h !== "Sachverhalt:")
    );

    const sachverhaltContent = Array.isArray(sachverhaltSection)
      ? sachverhaltSection.join(" ").trim()
      : (sachverhaltSection || "").trim();

    if (sachverhaltContent.length > 0) {
      children.push(
        new Paragraph({
          text: sachverhaltContent,
          spacing: { after: 200 }
        })
      );
    }

    // ---- 6. STATISTIK section with real tables (from structured data) ----
    if (sd && !sectionGuard("STATISTIK")) {
      children.push(
        new Paragraph({
          text: "STATISTIK",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        })
      );

      // Severity table
      children.push(new Paragraph({ text: "Verletzungsschwere im Ausschnitt:", spacing: { after: 100 } }));
      const sev = sd.severity;
      const sevTotal = sev ? sev.total : 0;
      const fmtPct = (n, total) => total ? ((n / total) * 100).toFixed(1).replace(".", ",") + " %" : "0,0 %";
      children.push(makeDocxTable(
        ["Kategorie", "Anzahl", "Anteil"],
        [
          ["1 – Getötete",       String((sev && sev.bySev["1"]) || 0), fmtPct((sev && sev.bySev["1"]) || 0, sevTotal)],
          ["2 – Schwerverletzte", String((sev && sev.bySev["2"]) || 0), fmtPct((sev && sev.bySev["2"]) || 0, sevTotal)],
          ["3 – Leichtverletzte", String((sev && sev.bySev["3"]) || 0), fmtPct((sev && sev.bySev["3"]) || 0, sevTotal)]
        ]
      ));
      children.push(new Paragraph({ text: "", spacing: { after: 200 } }));

      // Deviations table
      if (sd.deviations && sd.deviations.focus && sd.deviations.focus.length > 0) {
        const isPolitical = sd.meta && sd.meta.mode === "political";
        children.push(new Paragraph({ text: "Top-Abweichungen (Ausschnitt vs. Stadt):", spacing: { after: 100 } }));
        const fmtCombo = (UA.formatInvolvementCombo || ((s) => s));
        const fmtFactor = UA.formatFactorPolitical || ((f) => `Faktor ${f.toFixed(2).replace(".", ",")}`);
        const devRows = sd.deviations.focus.map(r => {
          const locPct = sd.deviations.local.total ? ((r.locR) * 100).toFixed(1).replace(".", ",") + " %" : "0,0 %";
          const basePct = ((r.baseR) * 100).toFixed(1).replace(".", ",") + " %";
          const muster = r.textLabel || fmtCombo(r.mask, { format: "text" });
          if (isPolitical) {
            // Task 9/10: politisches Wording; 95%-KI weggelassen.
            return [muster, String(r.locCnt), locPct, basePct, fmtFactor(r.factor, { mode: "political" })];
          }
          const ciLowPct = r.ciLow != null ? (r.ciLow * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const ciHighPct = r.ciHigh != null ? (r.ciHigh * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const factorStr = r.factor.toFixed(2).replace(".", ",") + "×" + (r.isSignificant === false ? " (n.s.)" : "");
          return [muster, String(r.locCnt), locPct, basePct, factorStr, `[${ciLowPct} – ${ciHighPct}]`];
        });
        const headers = isPolitical
          ? ["Muster", "Lokal", "Lokal %", "Stadt %", "Einordnung"]
          : ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor", "95%-KI (lokaler Anteil)"];
        children.push(makeDocxTable(headers, devRows, undefined, {
          // Spaltengewichte (relative Anteile, werden in `_twipsForCols`
          // normiert). Reihenfolge entspricht den Headern oben:
          //   technisch:  Muster | Lokal | Lokal % | Stadt % | Faktor | 95%-KI
          //   politisch:  Muster | Lokal | Lokal % | Stadt % | Einordnung
          // Das „Muster"- und das „95%-KI"/„Einordnung"-Feld sind die
          // textreichen Spalten und bekommen den meisten Platz; die drei
          // Zahl-Spalten in der Mitte werden bewusst schmaler gehalten.
          colWeights: isPolitical
            ? [2.0, 0.8, 1.0, 1.0, 1.6]
            : [1.8, 0.7, 0.9, 0.9, 0.9, 1.6]
        }));
        // PR-QA „Begriffliche Inkonsistenzen": Kurze Erklärung des
        // Faktor-Werts, damit Leser:innen ohne statistischen Hintergrund
        // verstehen, was „Faktor 2,18" bedeutet.
        if (!isPolitical) {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: "Lesart: ", bold: true }),
              new TextRun({ text: "„Faktor 2,18" }),
              new TextRun({ text: "× bedeutet, dass das jeweilige Beteiligungsmuster im untersuchten Bereich rund 2,18-mal so häufig vorkommt wie im Stadtdurchschnitt. Werte > 1 = überrepräsentiert, Werte < 1 = unterrepräsentiert. Die 95 %-Konfidenzintervalle zeigen die statistische Unsicherheit bei kleinen Fallzahlen." })
            ],
            spacing: { after: 100 }
          }));
        }
        if (!isPolitical) {
          const allNonSig = sd.deviations.focus.every(r => r.isSignificant === false);
          if (allNonSig) {
            children.push(new Paragraph({
              text: "Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (95%-KI schließt Stadtwert ein). Faktor-Werte bei kleinen Fallzahlen mit Vorsicht interpretieren.",
              spacing: { after: 100 }
            }));
          }
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));

        // Task 4 – URSACHEN UND MASSNAHMEN direkt nach den Abweichungen.
        if (Array.isArray(sd.causesMeasures) && sd.causesMeasures.length > 0) {
          children.push(new Paragraph({
            text: "URSACHEN UND MASSNAHMEN",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 200, after: 100 }
          }));
          // Cross-Reference per Maßnahmen-Nummer, falls verfügbar — sonst
          // klassische Label-Liste (Backward-compat).
          const cmRows = sd.causesMeasures.map(c => [
            c.cause,
            (c.measureRefs && c.measureRefs.length > 0)
              ? c.measureRefs.map(e => `#${e.idx} (${e.label})`).join("; ")
              : c.measures.join("; ")
          ]);
          children.push(makeDocxTable(
            ["Auffälliges Muster", "Empfohlene Maßnahmen (siehe Liste unten)"],
            cmRows
          ));
          children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
        }
      }

      // Year table
      if (sd.yearTable && sd.yearTable.length > 0) {
        children.push(new Paragraph({ text: "Unfälle pro Jahr im Ausschnitt:", spacing: { after: 100 } }));
        const yrRows = sd.yearTable.map(row => {
          // Phase 1.2: DOCX bevorzugt das deterministische Bracket-Label
          // (`textClasses`), damit auch ohne Emoji-fähigen Body-Font in Word
          // keine kaputten Trennzeichen ("+", "=") sichtbar werden.
          const cls = (row.textClasses && row.textClasses.length)
            ? row.textClasses
            : (row.classes || []);
          return [
            String(row.year),
            String(row.total),
            cls.length ? cls.join(", ") : "—"
          ];
        });
        children.push(makeDocxTable(
          ["Jahr", "Summe", "Kombinationen"],
          yrRows
        ));
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Cross-table: Beteiligungskombination × Schweregrad
      if (sd.crossTable && sd.crossTable.rows && sd.crossTable.rows.length > 0) {
        children.push(new Paragraph({ text: "Beteiligungskombination × Schweregrad:", spacing: { after: 100 } }));
        // PR-QA Task 1: deterministische Text-Labels in der DOCX-Tabelle.
        const fmtCombo = (UA.formatInvolvementCombo || ((s) => s));
        const ctRows = sd.crossTable.rows.map(r => [
          r.textLabel || fmtCombo(r.mask, { format: "text" }),
          String(r.sev1), String(r.sev2), String(r.sev3), String(r.total)
        ]);
        // Highlight rows whose mask matches the active filter
        const ctHighlights = sd.crossTable.rows.map(r => isActiveFilterRow(r.mask));
        ctRows.push([
          "Gesamt",
          String(sd.crossTable.totals.sev1),
          String(sd.crossTable.totals.sev2),
          String(sd.crossTable.totals.sev3),
          String(sd.crossTable.totals.total)
        ]);
        ctHighlights.push(false); // Gesamt row is not highlighted
        children.push(makeDocxTable(
          ["Kombination", "Getötete", "Schwerverletzt", "Leichtverletzt", "Summe"],
          ctRows,
          ctHighlights
        ));
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Patterns section
      if (sd.patterns && sd.patterns.length > 0) {
        children.push(new Paragraph({
          text: "FACHLICHE EINORDNUNG / MUSTER",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        for (const pat of sd.patterns) {
          if (pat.title) {
            children.push(new Paragraph({
              children: [new TextRun({ text: pat.title, bold: true })],
              spacing: { after: 60 }
            }));
          }
          if (pat.content) {
            children.push(new Paragraph({ text: pat.content, spacing: { after: 100 } }));
          }
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Economic impact (PR-C / B2): Volkswirtschaftliche Bedeutung
      if (options.includeCosts !== false && sd.economicImpact && sd.economicImpact.total > 0) {
        const fmt = (UA.costs && UA.costs.formatEUR) ? UA.costs.formatEUR : (n) => `${n} €`;
        const ei = sd.economicImpact;
        children.push(new Paragraph({
          text: "VOLKSWIRTSCHAFTLICHE BEDEUTUNG (SCHÄTZUNG)",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        const eiRows = [
          ["Getötete", String(ei.counts.fatal), fmt(ei.breakdown.fatal)],
          ["Schwerverletzte", String(ei.counts.severe), fmt(ei.breakdown.severe)],
          ["Leichtverletzte", String(ei.counts.light), fmt(ei.breakdown.light)],
          [`Gesamt im Datenzeitraum (${ei.years} Jahr${ei.years === 1 ? "" : "e"})`,
            String(ei.counts.fatal + ei.counts.severe + ei.counts.light),
            fmt(ei.total)],
          ["Pro Jahr", "", fmt(ei.annual)]
        ];
        children.push(makeDocxTable(["Kategorie", "Anzahl", "Geschätzte Kosten"], eiRows));
        // Trend-Qualifier (PR-β): konsistent mit TEXT/HTML/PDF.
        const tq = trendQualifierTextDocx(ei.trendQualifier);
        if (tq) {
          children.push(new Paragraph({
            children: [new TextRun({ text: `Mehrjahres-Trend: ${tq}.`, bold: true })],
            spacing: { before: 80, after: 40 }
          }));
        }
        if (ei.source && (ei.source.publisher || ei.source.year)) {
          const srcParts = [ei.source.publisher, ei.source.year].filter(Boolean).join(", ");
          children.push(new Paragraph({ text: `Quelle: ${srcParts}`, spacing: { after: 60 } }));
        }
        if (ei.disclaimer) {
          children.push(new Paragraph({
            children: [new TextRun({ text: ei.disclaimer, italics: true })],
            spacing: { after: 200 }
          }));
        }
      }

      // Orts- und musterbezogene Empfehlungen (UA.contextMeasures, Spec
      // Items 4–8). Direkt VOR „EMPFOHLENE MASSNAHMEN" — Antrag soll mit
      // den passenden Prüfaufträgen beginnen, nicht mit Standardmaßnahmen.
      if (options.includeMeasures !== false && sd.contextualMeasures
          && Array.isArray(sd.contextualMeasures.matchedRules)
          && sd.contextualMeasures.matchedRules.length > 0
          && !sectionGuard("ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN")) {
        children.push(new Paragraph({
          text: "ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        if (sd.contextualMeasures.rationale) {
          children.push(new Paragraph({
            children: [new TextRun({ text: sd.contextualMeasures.rationale, italics: true })],
            spacing: { after: 200 }
          }));
        }
        const renderBucketDocxCtx = (heading, items) => {
          if (!Array.isArray(items) || items.length === 0) return;
          children.push(new Paragraph({
            children: [new TextRun({ text: heading, bold: true })],
            spacing: { before: 120, after: 40 }
          }));
          for (const it of items) {
            children.push(new Paragraph({ text: "• " + it, spacing: { after: 20 } }));
          }
        };
        renderBucketDocxCtx("Erforderliche Vor-Ort-Prüfung",     sd.contextualMeasures.pruefauftraege);
        renderBucketDocxCtx("Kurzfristig prüfbar",               sd.contextualMeasures.kurzfristig);
        renderBucketDocxCtx("Baulich/organisatorisch zu prüfen", sd.contextualMeasures.mittelfristig);
      }

      // Recommended measures (PR-D / B1+B3)
      if (options.includeMeasures !== false && UA.hasRecommendationsOrFiltered
          && UA.hasRecommendationsOrFiltered(sd.recommendedMeasures)
          && !sectionGuard("EMPFOHLENE MASSNAHMEN")) {
        const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
        const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
        children.push(new Paragraph({
          text: "EMPFOHLENE MASSNAHMEN",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        // OSM-Datenstand-Hinweis vor der Liste, kursiv hervorgehoben.
        const cov = osmCoverageNoteDocx(sd.recommendedMeasures.osmCoverage);
        if (cov) {
          children.push(new Paragraph({
            children: [new TextRun({ text: `OSM-Datenstand: ${cov}`, italics: true })],
            spacing: { after: 120 }
          }));
        }
        let i = 1;
        for (const item of (sd.recommendedMeasures.measures || [])) {
          const m = item.measure;
          children.push(new Paragraph({
            children: [new TextRun({ text: `${i}. ${m.label}`, bold: true })],
            spacing: { after: 40 }
          }));
          if (m.description) {
            children.push(new Paragraph({ text: m.description, spacing: { after: 40 } }));
          }
          const ev = (m.effect && m.effect.evidenceLevel) ? `Evidenz ${m.effect.evidenceLevel}` : "";
          const meta = `Kosten: ${fmtCost(m.costRange)} pro ${m.perUnit || "Einheit"} · Reduktion: ${fmtRed(m.effect && m.effect.expectedReductionPct)}${ev ? " · " + ev : ""} · Vorlauf: ${m.leadTime || "—"}`;
          children.push(new Paragraph({ text: meta, spacing: { after: 40 } }));
          // Goldstandard Items 5–6: explizite Cross-Reference auf den
          // URSACHEN-Block, damit der Leser sofort sieht, *warum* diese
          // Maßnahme empfohlen wird.
          if (Array.isArray(item.derivedFrom) && item.derivedFrom.length > 0) {
            children.push(new Paragraph({
              children: [
                new TextRun({ text: "Abgeleitet aus auffälligem Muster: ", italics: true }),
                new TextRun({ text: item.derivedFrom.map(d => d.label).join(" · "), italics: true })
              ],
              spacing: { after: 40 }
            }));
          }
          if (item.amortisation && item.amortisation.years) {
            const [best, worst] = item.amortisation.years;
            children.push(new Paragraph({
              text: `Geschätzte Amortisation: ca. ${best.toFixed(1)} – ${worst.toFixed(1)} Jahre.`,
              spacing: { after: 40 }
            }));
          }
          if (Array.isArray(m.considerations)) {
            for (const c of m.considerations) {
              children.push(new Paragraph({ text: "• " + c, spacing: { after: 20 } }));
            }
          }
          i++;
        }
        // Wegen OSM-Voraussetzungen ausgeschlossene Vorschläge transparent listen.
        if (Array.isArray(sd.recommendedMeasures.filteredOut) && sd.recommendedMeasures.filteredOut.length > 0) {
          children.push(new Paragraph({
            children: [new TextRun({ text: "Wegen OSM-Voraussetzungen NICHT empfohlen:", bold: true })],
            spacing: { before: 120, after: 40 }
          }));
          for (const f of sd.recommendedMeasures.filteredOut) {
            children.push(new Paragraph({
              text: `• ${f.label}: ${f.reason || "Voraussetzungen nicht erfüllt"}`,
              spacing: { after: 20 }
            }));
          }
        }
        if (sd.recommendedMeasures.disclaimer) {
          children.push(new Paragraph({
            children: [new TextRun({ text: sd.recommendedMeasures.disclaimer, italics: true })],
            spacing: { before: 100, after: 200 }
          }));
        }
      }

      // Goldstandard-Sektion 8: Priorisierung (DOCX). Drei-Bucket-Listen
      // mit den vom User vorgegebenen Überschriften. Leere Buckets werden
      // explizit ausgewiesen, damit die Wahrnehmung nicht zu „nur lang-
      // fristig möglich" verschoben wird.
      if (sd.prioritization && sd.prioritization.meta && sd.prioritization.meta.totals.all > 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: "Priorisierung (Umsetzungshorizont)", bold: true, size: 24 })],
          spacing: { before: 240, after: 120 }
        }));
        const renderBucketDocx = (heading, bucket) => {
          children.push(new Paragraph({
            children: [new TextRun({ text: heading, bold: true })],
            spacing: { before: 120, after: 40 }
          }));
          if (bucket.length === 0) {
            children.push(new Paragraph({
              children: [new TextRun({ text: "— keine Maßnahmen in diesem Horizont —", italics: true })],
              spacing: { after: 40 }
            }));
            return;
          }
          for (const it of bucket) {
            children.push(new Paragraph({
              text: `• ${it.label} (Vorlauf: ${it.leadTime})`,
              spacing: { after: 20 }
            }));
          }
        };
        renderBucketDocx("Kurzfristig (0–3 Monate)", sd.prioritization.kurzfristig);
        renderBucketDocx("Mittelfristig (3–12 Monate)", sd.prioritization.mittelfristig);
        renderBucketDocx("Langfristig (>12 Monate)", sd.prioritization.langfristig);
      }

      // Accident details table – grouped by strategy (consumes structured.accidentDetails.groups)
      if (sd.accidentDetails && sd.accidentDetails.groups && sd.accidentDetails.groups.length > 0) {
        const view = (typeof UA !== "undefined" && UA.resolveAccidentView)
          ? UA.resolveAccidentView(sd.accidentDetails.viewId)
          : null;
        const cols = (sd.accidentDetails.columns && sd.accidentDetails.columns.length)
          ? sd.accidentDetails.columns
          : ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];
        children.push(new Paragraph({
          text: "EINZELUNFÄLLE IM BEREICH",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        for (const g of sd.accidentDetails.groups) {
          // Render header from the strategy (skip empty headers, e.g. flat view)
          const docxHeader = (g.headers && Array.isArray(g.headers.docx)) ? g.headers.docx : null;
          if (docxHeader && docxHeader.length > 0) {
            for (const h of docxHeader) {
              children.push(new Paragraph({
                text: replaceEmojisForDocx(h.text || ""),
                bold: !!h.bold,
                spacing: { before: 200, after: 100 }
              }));
            }
          } else if (g.sevLabel) {
            // Back-compat: synthesize a header for plain { sevLabel, histogram } groups
            const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
            children.push(new Paragraph({
              text: replaceEmojisForDocx(headerText),
              bold: true,
              spacing: { before: 200, after: 100 }
            }));
          }
          const detailRows = g.rows.map((r, i) => {
            if (view && view.renderRow && view.renderRow.docx) return view.renderRow.docx(r, i);
            // Defensive fallback (matches the previous bySeverity layout)
            const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
            const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
            return [String(i + 1), String(r.year ?? "—"), r.involved, hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
          });
          children.push(makeDocxTable(cols, detailRows, undefined, {
            // Einzelunfälle-Tabelle: Spaltenanzahl hängt von der gewählten
            // accidentDetails-View ab.
            //   7-Spalten-Layout (View ohne Schwere-Spalte):
            //     #  | Jahr | Beteiligte | Uhrzeit | Wochentag | Fahrbahnzustand | Koordinaten
            //   8-Spalten-Layout (View mit Schwere-Spalte):
            //     #  | Jahr | Schwere | Beteiligte | Uhrzeit | Wochentag | Fahrbahnzustand | Koordinaten
            // Gewichte: laufende Nummer und Jahr sind sehr schmal, „Beteiligte"
            // und „Koordinaten" brauchen viel Platz, die Mittel-Spalten halten
            // sich an typische Inhalte (Uhrzeit „08:30", Wochentag „Mittwoch",
            // Fahrbahnzustand „nass/feucht/schlüpfrig").
            colWeights: cols.length === 7
              ? [0.5, 0.7, 1.5, 0.9, 1.0, 1.2, 1.6]
              : cols.length === 8
                ? [0.5, 0.7, 1.0, 1.5, 0.9, 1.0, 1.2, 1.4]
                : undefined
          }));
          if (g.overflow > 0) {
            const label = g.overflowLabel || `weitere ${g.sevLabel || ""}`;
            children.push(new Paragraph({
              text: `… und ${g.overflow} ${label}`,
              italics: true,
              spacing: { after: 100 }
            }));
          }
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      } else if (sd.accidentDetails && sd.accidentDetails.rows && sd.accidentDetails.rows.length > 0) {
        // Fallback for legacy data without groups
        children.push(new Paragraph({
          text: "EINZELUNFÄLLE IM BEREICH",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        const detailRows = sd.accidentDetails.rows.map((r, i) => {
          const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
          const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
          return [String(i + 1), String(r.year ?? "—"), r.sevLabel, r.involved, hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
        });
        children.push(makeDocxTable(
          ["#", "Jahr", "Schwere", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"],
          detailRows,
          undefined,
          { colWeights: [0.5, 0.7, 1.0, 1.5, 0.9, 1.0, 1.2, 1.4] }
        ));
        if (sd.accidentDetails.truncated) {
          children.push(new Paragraph({
            text: `… und ${sd.accidentDetails.total - sd.accidentDetails.rows.length} weitere Unfälle`,
            italics: true,
            spacing: { after: 100 }
          }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }
    }

    // ---- 7. Map section (if enabled) ----
    if (options.includeMap) {
      try {
        children.push(
          new Paragraph({
            text: "KARTENAUSSCHNITT",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 }
          })
        );

        // Layout-Pass / Spec-Item 6 + 7: erklärender Lead-in vor der
        // Bilderfolge — stellt die Dramaturgie her (Text → Bild → Tabelle)
        // und macht die Detail-/Cluster-Karten als Teilmengen der
        // Übersichtskarte explizit verständlich.
        children.push(new Paragraph({
          children: [new TextRun({
            text: "Die folgenden Karten zeigen unterschiedliche Detailebenen. Detail- und Clusteransichten sind Teilmengen der Gesamtansicht."
          })],
          spacing: { after: 160 }
        }));

        // Layout-Pass / Spec-Item 6: Parent-Count für Caption-Cross-References
        // („Die N dargestellten Unfälle sind eine Teilmenge der M Unfälle aus
        // Abbildung 1."). M = Gesamtfallzahl im Ausschnitt mit denselben
        // Fallback-Quellen wie der Verifikationssatz weiter unten.
        const docxParentN =
          (sd && sd.accidentDetails && Number.isFinite(sd.accidentDetails.total)) ? sd.accidentDetails.total
          : (sd && Number.isFinite(sd.totalAccidents) ? sd.totalAccidents
            : (Array.isArray(ctx.viewportPts) ? ctx.viewportPts.length : null));

        const mapImageData = await UA.captureExportMapImage(ctx, options);

        let mainMapRun;
        try {
          mainMapRun = pngImageRun(
            mapImageData,
            // Layout-PR „Bildverzerrung beheben": Aspektrate des PNG-
            // Originals erhalten — kein hartes 600×400 mehr.
            fitImageToMax(mapImageData, DOCX_MAP_MAX),
            {
              title: "Übersichtskarte",
              description: "Übersichtskarte des untersuchten Unfallbereichs mit allen gefilterten Unfällen"
            }
          );
        } catch (decodeError) {
          console.error("Failed to decode base64 map image data:", decodeError);
          throw new Error("Kartenbild konnte nicht dekodiert werden: ungültige Base64-Bilddaten");
        }

        children.push(
          new Paragraph({
            children: [mainMapRun],
            // Layout-PR Spec-Item 3: Bild und Caption als Einheit halten —
            // `keepNext` verhindert einen Seitenumbruch zwischen Bild-
            // Paragraph und folgendem Caption-Paragraph.
            keepNext: true,
            alignment: AlignmentType.CENTER,
            spacing: { after: 200 }
          })
        );

        // PR 2 / Spec-Item 4: numbered figure caption directly under the image.
        children.push(new Paragraph({
          children: [new TextRun({
            text: figCounter.next("Übersichtskarte – gefilterte Unfälle im markierten Bereich").caption,
            italics: true,
            bold: true
          })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 80 }
        }));

        const legendText =
          ctx && typeof ctx.t === "function"
            ? ctx.t("report.map.legend")
            : "Legende: Darstellung entsprechend der aktuellen Kartendarstellung. Punkte: rot = Getötete, orange = Schwerverletzte, gelb = Leichtverletzte.";

        children.push(
          new Paragraph({
            text: legendText,
            italics: true,
            spacing: { after: 200 }
          })
        );

        // Verification sentence (Task 6) – n MUST be the canonical
        // Einzelunfall-Tabellen-Zählung („Tabelle" im Verifikationssatz).
        // ctx.viewportPts.length basiert auf gepaddingten Karten-Bounds und
        // kann Punkte außerhalb der Export-Bounds enthalten — würde also
        // eine größere Zahl ausgeben als auf der Karte sichtbar sind und
        // würde dem Pre-Flight-Konsistenz-Gate widersprechen.
        const overviewN =
          (sd && sd.accidentDetails && Number.isFinite(sd.accidentDetails.total)) ? sd.accidentDetails.total
          : (sd && Number.isFinite(sd.totalAccidents) ? sd.totalAccidents
            : (Array.isArray(ctx.viewportPts) ? ctx.viewportPts.length : 0));
        children.push(new Paragraph({
          text: mapVerificationSentence(overviewN),
          italics: true,
          spacing: { after: 200 }
        }));

        // Detail map: zoom to selection bounds if available
        if (ctx.selectionBounds) {
          try {
            const detailImageData = await (UA._captureDetailMap || captureDetailMap)(ctx, options);
            let detailRun;
            try {
              detailRun = pngImageRun(
                detailImageData,
                // Layout-PR „Bildverzerrung beheben": Aspektrate des PNG-
                // Originals erhalten — kein hartes 600×400 mehr.
                fitImageToMax(detailImageData, DOCX_MAP_MAX),
                {
                  title: "Detailkarte",
                  description: "Detailansicht des markierten Auswahlbereichs mit den darin liegenden Unfällen"
                }
              );
            } catch (e2) {
              throw new Error("Detailkartenbild konnte nicht dekodiert werden");
            }
            children.push(new Paragraph({
              text: "Detailansicht – markierter Bereich",
              heading: HeadingLevel.HEADING_3,
              // Layout-PR Spec-Item 3 + 5: Überschrift + Bild + Caption
              // bleiben zusammen (kein Umbruch nach der Subheading).
              keepNext: true,
              spacing: { before: 200, after: 100 }
            }));
            children.push(new Paragraph({
              children: [detailRun],
              keepNext: true,
              alignment: AlignmentType.CENTER,
              spacing: { after: 100 }
            }));
            // Verification sentence for detail map (Task 6).
            const detailBbox = boundsToBbox(ctx.selectionBounds);
            const detailN = countPointsInBounds(ctx.viewportPts || [], detailBbox);
            // PR 2 / Spec-Item 4: numbered figure caption.
            // Layout-Pass: Subset-Cross-Reference auf Abbildung 1.
            const detailFig = figCounter.next("Detailausschnitt innerhalb des markierten Bereichs");
            const detailCaptionText = (docxParentN != null)
              ? `${detailFig.caption} Die ${detailN} dargestellten Unfälle sind eine Teilmenge der ${docxParentN} Unfälle aus Abbildung 1.`
              : detailFig.caption;
            children.push(new Paragraph({
              children: [new TextRun({
                text: detailCaptionText,
                italics: true
              })],
              spacing: { after: 80 }
            }));
            children.push(new Paragraph({
              text: mapVerificationSentence(detailN),
              italics: true,
              spacing: { after: 200 }
            }));
          } catch (detailErr) {
            console.warn("Detail map capture failed (graceful fallback):", detailErr);
          }
        }

        // Cluster maps: one zoom-in per dominant accident hotspot (Tasks 1–7).
        // Each cluster gets:
        //   – its own bbox-driven map view (fitBounds → no unrelated areas)
        //   – a unique heading "<label> – n Unfälle (Zoom z)" matching the table
        //   – the verification sentence below the image
        try {
          const clusterMaps = await (UA._captureClusterMaps || captureClusterMaps)(ctx, options);
          for (const cm of clusterMaps) {
            // Task 5: do not render a cluster map if the visible point count
            // would not match the stated total.
            const visibleN = Array.isArray(cm.points)
              ? cm.points.length
              : countPointsInBounds(ctx.viewportPts || [], cm.bounds);
            if (visibleN !== cm.total) {
              console.warn(
                "Cluster map skipped: point/total mismatch",
                { label: cm.label, total: cm.total, visibleN }
              );
              continue;
            }

            const cBase64 = cm.image.replace(/^data:image\/png;base64,/, "");
            let cRun;
            try {
              cRun = pngImageRun(
                cBase64,
                // Layout-PR „Bildverzerrung beheben": Aspektrate erhalten.
                fitImageToMax(cBase64, DOCX_MAP_MAX),
                {
                  title: `Cluster-Karte: ${cm.label || "Hotspot"}`,
                  description: `Zoomansicht eines Unfall-Hotspots (${cm.total} Unfälle, Zoom ${cm.zoom})`
                }
              );
            } catch {
              console.warn("Cluster map image could not be decoded – skipping");
              continue;
            }
            children.push(new Paragraph({
              text: `${cm.label} – ${cm.total} Unfälle (Zoom ${cm.zoom})`,
              heading: HeadingLevel.HEADING_3,
              keepNext: true,
              spacing: { before: 200, after: 100 }
            }));
            children.push(new Paragraph({
              children: [cRun],
              keepNext: true,
              alignment: AlignmentType.CENTER,
              spacing: { after: 100 }
            }));
            // PR 2 / Spec-Item 4: numbered figure caption per cluster map.
            // Layout-Pass: Subset-Cross-Reference auf Abbildung 1.
            const clusterFig = figCounter.next(`Cluster-Karte – ${cm.label} (n=${cm.total})`);
            const clusterCaptionText = (docxParentN != null)
              ? `${clusterFig.caption} Die ${cm.total} dargestellten Unfälle sind eine Teilmenge der ${docxParentN} Unfälle aus Abbildung 1.`
              : clusterFig.caption;
            children.push(new Paragraph({
              children: [new TextRun({
                text: clusterCaptionText,
                italics: true
              })],
              spacing: { after: 80 }
            }));
            children.push(new Paragraph({
              text: mapVerificationSentence(cm.total),
              italics: true,
              spacing: { after: 200 }
            }));
          }
        } catch (clusterErr) {
          console.warn("Cluster maps capture failed (graceful fallback):", clusterErr);
        }
      } catch (e) {
        console.error("Map capture failed:", e);
        children.push(
          new Paragraph({
            text: "[Kartenerstellung fehlgeschlagen]",
            italics: true,
            spacing: { after: 200 }
          })
        );
      }
    }

    // ---- 8. POI section (if enabled and data available) ----
    if (options.includePOIs) {
      // Prefer structured POI data for a real table
      const poi = sd && sd.poi;
      const hasPoi = poi && (poi.totalWithin > 0 || poi.totalNear > 0);
      const poiTextSection = extractSection(textLines, "POI-Analyse");
      if (hasPoi || poiTextSection.length > 0) {
        children.push(
          new Paragraph({
            text: "SENSIBLE EINRICHTUNGEN",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 }
          })
        );

        if (hasPoi) {
          const poiRows = [];
          const allTypes = [...new Set([
            ...Object.keys(poi.withinByType || {}),
            ...Object.keys(poi.nearByType || {})
          ])].sort((a, b) => poiTypeLabel(a).localeCompare(poiTypeLabel(b), "de"));
          for (const type of allTypes) {
            const label = poiTypeLabel(type);
            poiRows.push([
              label,
              String(poi.withinByType[type] || 0),
              String(poi.nearByType[type] || 0)
            ]);
          }
          children.push(makeDocxTable(
            ["Typ", "Im Bereich", "In der Nähe (< 200m)"],
            poiRows
          ));
          children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
          children.push(new Paragraph({
            text: "Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.",
            spacing: { after: 200 }
          }));
        } else {
          for (const line of poiTextSection) {
            children.push(new Paragraph({ text: line, spacing: { after: 100 } }));
          }
        }
      }
    }

    // ---- 8b. DUNKELZIFFER-PFLICHTHINWEIS (#C3) ----
    {
      const note = (sd && sd.darkFigureNote) || (typeof UA !== "undefined" && UA.DARK_FIGURE_NOTE) || null;
      if (note) {
        children.push(new Paragraph({
          text: note.title,
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        children.push(new Paragraph({ text: note.body, spacing: { after: 100 } }));
        children.push(new Paragraph({
          children: [new TextRun({ text: note.sourceLabel, italics: true })],
          spacing: { after: 200 }
        }));
      }
    }

    // ---- 8c. MEHRJAHRES-TREND (#C2) ----
    if (sd && sd.yearlyTrend && Array.isArray(sd.yearlyTrend.years) && sd.yearlyTrend.years.length > 0
        && !sectionGuard("MEHRJAHRES-TREND")) {
      const t = sd.yearlyTrend;
      children.push(new Paragraph({
        text: "MEHRJAHRES-TREND",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      const trendHeader = ["Jahr", "Getötete", "Schwerverletzte", "Leichtverletzte", "Summe"];
      const trendRows = t.years.map((y, i) => [
        String(y),
        String(t.counts.fatal[i]),
        String(t.counts.severe[i]),
        String(t.counts.light[i]),
        String(t.counts.total[i])
      ]);
      children.push(makeDocxTable(trendHeader, trendRows));
      const slopeStr = Number.isFinite(t.slope) ? t.slope.toFixed(2) : "—";
      const r2Str = Number.isFinite(t.r2) ? t.r2.toFixed(2) : "—";
      children.push(new Paragraph({
        children: [
          new TextRun({ text: "Klassifikation: ", bold: true }),
          new TextRun({ text: `${t.classification} ` }),
          new TextRun({ text: `(Slope ${slopeStr}/Jahr, R² ${r2Str}, n=${t.nYears})`, italics: true })
        ],
        spacing: { after: 200 }
      }));
    }

    // ---- 8d. STUNDEN-HEATMAP (#A2) ----
    if (sd && sd.heatmap && sd.heatmap.total > 0 && UA.heatmap) {
      const hm = sd.heatmap;
      children.push(new Paragraph({
        text: "STUNDEN-HEATMAP (WERKTAG VS. WOCHENENDE)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      // Build a 25-row table: 1 header + 24 hour rows. Per-cell shading
      // mirrors the SVG in HTML so DOCX/PDF readers see the same hot/cold
      // pattern even when they can't render inline SVG.
      const headerRow = new TableRow({
        children: ["Stunde", "Mo–Fr", "Sa/So"].map(t => new TableCell({
          borders: cellBorder,
          shading: { fill: "EEEEEE" },
          children: [new Paragraph({ children: [new TextRun({ text: t, bold: true })] })]
        }))
      });
      const rows = [headerRow];
      for (let h = 0; h < 24; h++) {
        const cells = [
          new TableCell({
            borders: cellBorder,
            children: [new Paragraph({ children: [new TextRun({ text: `${String(h).padStart(2, "0")}:00`, bold: true })] })]
          })
        ];
        for (let c = 0; c < 2; c++) {
          const v = hm.matrix[h][c];
          const fill = UA.heatmap.cellColor(v, hm.max);
          // docx shading.fill expects 6-hex without leading "#"
          const hex = fill.replace(/^#/, "");
          const txtColor = UA.heatmap.readableTextColor(fill).replace(/^#/, "");
          cells.push(new TableCell({
            borders: cellBorder,
            shading: { fill: hex },
            children: [new Paragraph({
              alignment: undefined,
              children: [new TextRun({ text: v > 0 ? String(v) : "", color: txtColor })]
            })]
          }));
        }
        rows.push(new TableRow({ children: cells }));
      }
      children.push(new Table({
        width: { size: 60, type: WidthType.PERCENTAGE },
        rows
      }));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `Gesamt: ${hm.total} Unfälle (Mo–Fr: ${hm.colTotals[0]}, Sa/So: ${hm.colTotals[1]}). `, italics: true }),
          new TextRun({ text: `Max. ${hm.max} Unfälle pro Stunde × Tagestyp.`, italics: true })
        ],
        spacing: { before: 100, after: 200 }
      }));
    }

    // ---- 8e. OSM-KONTEXT (#C4) ----
    // Only render the table when we actually have aggregated data.
    // For pure error stubs we add a one-line note so readers know why the
    // section is missing in this run.
    if (sd && sd.osmContext && sd.osmContext.summary) {
      const oc = sd.osmContext;
      const s = oc.summary;
      children.push(new Paragraph({
        text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      const ocRows = [];
      if (s.dominantMaxspeed != null) {
        ocRows.push(["Vorherrschendes Tempolimit", `${s.dominantMaxspeed} km/h (n=${s.speedSampleSize} Wegabschnitte)`]);
      }
      ocRows.push(["Radverkehrsanlagen",
        s.cycleInfraWays > 0
          ? `${s.cycleInfraWays} Wegabschnitte mit Radinfrastruktur` + (s.cycleInfraShare != null ? ` (${Math.round(s.cycleInfraShare * 100)} % der Hauptachsen)` : "")
          : "keine separaten Radverkehrsanlagen erkannt"
      ]);
      ocRows.push(["Knoten / Querungen", `${s.trafficSignals} signalisierte Knoten · ${s.crossings} markierte Querungen`]);
      if (s.avgLanes != null) ocRows.push(["Ø Fahrstreifen", `${s.avgLanes.toFixed(1)} (n=${s.lanesSampleSize})`]);
      if (s.avgWidthMeters != null) ocRows.push(["Ø Fahrbahnbreite", `${s.avgWidthMeters.toFixed(1)} m (n=${s.widthSampleSize})`]);
      children.push(makeKVTable(ocRows));
      children.push(new Paragraph({
        children: [
          new TextRun({ text: `Quelle: ${oc.source.publisher} (${oc.source.license}), via ${oc.source.retrievedVia}.`, italics: true })
        ],
        spacing: { before: 100, after: 100 }
      }));
      // Task 8 – analytische Schlussfolgerungen aus den OSM-Werten.
      if (Array.isArray(sd.osmInsights) && sd.osmInsights.length > 0) {
        children.push(new Paragraph({
          children: [new TextRun({ text: "OSM-Schlussfolgerungen:", bold: true })],
          spacing: { before: 100, after: 60 }
        }));
        for (const s of sd.osmInsights) {
          children.push(new Paragraph({ text: "• " + s, spacing: { after: 60 } }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
      }
    } else if (sd && sd.osmContext && sd.osmContext.quality && sd.osmContext.quality.error) {
      children.push(new Paragraph({
        text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      children.push(new Paragraph({
        // QA-PR „Export-Semantik": keine technischen Fehlerstrings im
        // Antrag (vorher: „Nicht verfügbar (Fetch is aborted)").
        children: [new TextRun({ text: "OSM-Kontextdaten konnten beim Export nicht geladen werden.", italics: true })],
        spacing: { after: 200 }
      }));
    }

    // ---- 9. BESCHLUSSVORSCHLAG section (Wortlaut, Wiederholung) ----
    // Layout-PR „Semantische Dokumentstruktur": der Antrag wurde bereits
    // unter „ANTRAG / BESCHLUSSVORSCHLAG" oben am Dokument geführt.
    // Diese Sektion wird daher per sectionGuard übersprungen, damit der
    // Wortlaut nicht doppelt erscheint.
    if (!sectionGuard("BESCHLUSSVORSCHLAG")) {
      children.push(
        new Paragraph({
          text: "BESCHLUSSVORSCHLAG",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        })
      );

      const beschlussSection = extractSection(textLines, "Beschlussvorschlag:");
      if (beschlussSection.length > 0) {
        for (const line of beschlussSection) {
          children.push(
            new Paragraph({
              text: line,
              spacing: { after: 100 }
            })
          );
        }
      } else {
        // Default text if not found
        children.push(
          new Paragraph({
            text: "Der Bezirksrat fordert die Verwaltung auf, innerhalb von 3 Monaten den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen. Die Wirksamkeit der Maßnahmen ist nach 12 Monaten anhand der Unfallatlas-Daten zu evaluieren.",
            spacing: { after: 200 }
          })
        );
      }
    }

    // ---- 10. FACHLICHE BEZÜGE section (if enabled) ----
    if (options.includeReferences) {
      const refs = sd && sd.references;
      const refsTextSection = extractSection(textLines, "Bezugsdokumente:");
      if ((refs && refs.documents && refs.documents.length > 0) || refsTextSection.length > 0) {
        children.push(
          new Paragraph({
            text: "FACHLICHE BEZÜGE",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 }
          })
        );

        if (refs && refs.documents && refs.documents.length > 0) {
          for (const doc of refs.documents) {
            const title = doc.title || "Ohne Titel";
            const meta = [doc.author, doc.date].filter(Boolean).join(", ");
            children.push(new Paragraph({
              children: [
                new TextRun({ text: `- ${title}`, bold: false }),
                ...(meta ? [new TextRun({ text: ` (${meta})`, italics: true })] : [])
              ],
              spacing: { after: 80 }
            }));
            if (doc.url) {
              // Render reference URLs as clickable hyperlinks
              const urlLink = ExternalHyperlink
                ? new ExternalHyperlink({
                    link: doc.url,
                    children: [new TextRun({ text: `  ${doc.url}`, style: "Hyperlink" })]
                  })
                : new TextRun({ text: `  ${doc.url}` });
              children.push(new Paragraph({ children: [urlLink], spacing: { after: 40 } }));
            }
          }
        } else {
          for (const line of refsTextSection) {
            children.push(new Paragraph({ text: line, spacing: { after: 100 } }));
          }
        }
      }
    }

    // ---- 11. DATENQUELLE section ----
    children.push(
      new Paragraph({
        text: "DATENQUELLE",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      })
    );

    children.push(
      new Paragraph({
        text: "Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).",
        spacing: { after: 200 }
      })
    );

    // ---- 12. Werkbank-Link ("→ In Werkbank öffnen") ----
    if (metaLink && ExternalHyperlink) {
      children.push(new Paragraph({
        children: [
          new ExternalHyperlink({
            link: metaLink,
            children: [new TextRun({ text: "→ In Werkbank öffnen", style: "Hyperlink" })]
          })
        ],
        spacing: { before: 200, after: 100 }
      }));
    } else if (metaLink) {
      children.push(new Paragraph({
        text: `→ In Werkbank öffnen: ${metaLink}`,
        spacing: { before: 200, after: 100 }
      }));
    }

    // ---- 13. Anlagen block ----
    // Layout-PR „Vor Anlagen Seitenumbruch": Anlagen sind im
    // Verwaltungsdokument ein eigener Abschnitt und beginnen daher auf
    // einer neuen Seite. `pageBreakBefore: true` erzwingt das in DOCX,
    // unabhängig davon, ob die vorausgehende Sektion knapp am
    // Seitenende endet.
    children.push(new Paragraph({
      text: "ANLAGEN",
      heading: HeadingLevel.HEADING_2,
      pageBreakBefore: true,
      spacing: { before: 400, after: 200 }
    }));
    children.push(new Paragraph({ text: "Anlage 1: Kartenansicht", spacing: { after: 80 } }));
    children.push(new Paragraph({ text: "Anlage 2: Statistische Übersicht", spacing: { after: 80 } }));
    children.push(new Paragraph({ text: "Anlage 3: Fachliche Bezüge", spacing: { after: 80 } }));

    // Create document
    const doc = new Document({
      sections: [{
        properties: {},
        children: children
      }]
    });

    // Generate and download
    const blob = await Packer.toBlob(doc);
    const citySlug = CITY_RAW
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    // Use dynamic title prefix for filename (normalize same way as citySlug)
    const titleSlug = docTitle
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `${titleSlug}_${citySlug}_${today.replace(/\./g, "-")}.docx`;
    
    if (window.saveAs) {
      window.saveAs(blob, filename);
    } else {
      // Fallback download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  // =====================================================================
  // PDF Export (using pdfmake)
  // =====================================================================

  /**
   * Build Werkbank URL from current application context
   * @param {Object} ctx - Application context
   * @returns {string} URL to Werkbank page with current parameters
   */
  function buildWerkbankUrl(ctx, override) {
    const params = new URLSearchParams();
    const ovr = override || {};
    
    // City
    if (ctx.CITY_RAW) {
      params.set("city", ctx.CITY_RAW);
    }
    
    // UI filters (if available)
    if (ctx.ui) {
      if (ctx.ui.severityEl) params.set("severity", ctx.ui.severityEl.value);
      if (ctx.ui.roadConditionEl) params.set("roadCondition", ctx.ui.roadConditionEl.value);
      if (ctx.ui.dayTypeEl) params.set("dayType", ctx.ui.dayTypeEl.value);
      if (ctx.ui.hFromEl) params.set("hourFrom", ctx.ui.hFromEl.value);
      if (ctx.ui.hToEl) params.set("hourTo", ctx.ui.hToEl.value);
      if (ctx.ui.maxPointsEl) params.set("maxPoints", ctx.ui.maxPointsEl.value);
      if (ctx.ui.viewportPaddingEl) params.set("viewportPaddingPct", ctx.ui.viewportPaddingEl.value);
      if (ctx.ui.heatRadiusEl) params.set("heatRadius", ctx.ui.heatRadiusEl.value);
      if (ctx.ui.incBikeEl) params.set("includeCyclist", ctx.ui.incBikeEl.checked ? 1 : 0);
      if (ctx.ui.incPedEl) params.set("includePedestrian", ctx.ui.incPedEl.checked ? 1 : 0);
      if (ctx.ui.incCarEl) params.set("includeCar", ctx.ui.incCarEl.checked ? 1 : 0);
      if (ctx.ui.incMotoEl) params.set("includeMotorcycle", ctx.ui.incMotoEl.checked ? 1 : 0);
      if (ctx.ui.incGkfzEl) params.set("includeGkfz", ctx.ui.incGkfzEl.checked ? 1 : 0);
      if (ctx.ui.incSonEl) params.set("includeSonstig", ctx.ui.incSonEl.checked ? 1 : 0);
    }
    
    // Involvement mode
    if (ctx.involvementMode) {
      params.set("involvementMode", ctx.involvementMode);
    }
    
    // Display modes
    if (ctx.showCluster !== undefined) params.set("showCluster", ctx.showCluster ? 1 : 0);
    if (ctx.showHeatmap !== undefined) params.set("showHeatmap", ctx.showHeatmap ? 1 : 0);
    if (ctx.showOnlyAboveAverage !== undefined) params.set("showOnlyAboveAverage", ctx.showOnlyAboveAverage ? 1 : 0);

    // Map position – override.center / override.zoom take precedence so each
    // exported map (overview, detail, cluster A, cluster B) gets its own
    // unique URL pointing exactly at its cluster (Task 3).
    if (ovr.center && Number.isFinite(ovr.center.lat) && Number.isFinite(ovr.center.lon)) {
      params.set("centerLat", Number(ovr.center.lat).toFixed(6));
      params.set("centerLon", Number(ovr.center.lon).toFixed(6));
    } else if (ctx.map) {
      const center = ctx.map.getCenter();
      params.set("centerLat", center.lat.toFixed(6));
      params.set("centerLon", center.lng.toFixed(6));
    }
    if (Number.isFinite(Number(ovr.zoom))) {
      params.set("zoom", Number(ovr.zoom));
    } else if (ctx.map) {
      params.set("zoom", ctx.map.getZoom());
    }

    // Selection / cluster bounds. An explicit override.bounds wins so cluster
    // maps publish their own bbox (selSouth/selWest/selNorth/selEast – Task 1).
    const b = ovr.bounds;
    if (b && Number.isFinite(b.south) && Number.isFinite(b.west)
        && Number.isFinite(b.north) && Number.isFinite(b.east)) {
      params.set("selSouth", Number(b.south).toFixed(6));
      params.set("selWest",  Number(b.west).toFixed(6));
      params.set("selNorth", Number(b.north).toFixed(6));
      params.set("selEast",  Number(b.east).toFixed(6));
    } else if (ctx.selectionBounds) {
      params.set("selSouth", ctx.selectionBounds.getSouth().toFixed(6));
      params.set("selWest", ctx.selectionBounds.getWest().toFixed(6));
      params.set("selNorth", ctx.selectionBounds.getNorth().toFixed(6));
      params.set("selEast", ctx.selectionBounds.getEast().toFixed(6));
    }
    
    // Build full URL
    // Determine werkbank path:
    // 1) per-call override via ctx.werkbankPath
    // 2) global configuration via window.UA_WERKBANK_PATH
    // 3) fallback: same directory as current page (preserve existing behavior)
    const fallbackWerkbankPath = window.location.pathname.replace(/[^/]*$/, "werkbank_v2.html");
    const werkbankPath =
      (ctx && ctx.werkbankPath) ||
      (typeof window !== "undefined" && window.UA_WERKBANK_PATH) ||
      fallbackWerkbankPath;

    // Build full URL using URL API for robust resolution
    const baseUrl = new URL(werkbankPath, window.location.origin).toString();
    
    // Only append query string if there are parameters
    const query = params.toString();
    return query ? `${baseUrl}?${query}` : baseUrl;
  }
  // Expose for testing purposes
  UA.buildWerkbankUrl = buildWerkbankUrl;

  /**
   * Convert text to pdfMake content with auto-detected clickable links
   * @param {string} text - Text that may contain URLs
   * @returns {Array|string} pdfMake content array with links or plain text
   */
  function textWithLinks(text) {
    if (text == null) {
      return "";
    }
    // URL regex pattern - matches URLs and excludes common trailing punctuation
    // that is likely to be sentence punctuation rather than part of the URL
    const urlPattern = /(https?:\/\/[^\s)]+?)([.,!?;:)]*)(?=\s|$)/g;
    const matches = [...text.matchAll(urlPattern)];
    
    if (matches.length === 0) {
      return text;
    }
    
    // Split text and create content array with links
    const content = [];
    let lastIndex = 0;
    
    for (const match of matches) {
      const url = match[1]; // URL without trailing punctuation
      const trailingPunct = match[2]; // Captured trailing punctuation
      const offset = match.index;
      
      // Add text before URL
      if (offset > lastIndex) {
        content.push({ text: text.substring(lastIndex, offset) });
      }
      
      // Add URL as link
      content.push({
        text: url,
        link: url,
        color: "blue",
        decoration: "underline"
      });
      
      // Add trailing punctuation as regular text (if any)
      if (trailingPunct) {
        content.push({ text: trailingPunct });
      }
      
      lastIndex = offset + match[0].length;
    }
    
    // Add remaining text
    if (lastIndex < text.length) {
      content.push({ text: text.substring(lastIndex) });
    }
    
    return content;
  }

  /**
   * Replace involvement icons / bracket tokens with verwaltungstaugliche
   * prose labels for PDF export (QA-PR „Export-Semantik vor Layout").
   *
   * Im sichtbaren PDF dürfen weder Emojis (`🚲`/`🚗`/…) noch die
   * Übergangs-Bracket-Tokens (`[Rad]`/`[PKW]`/…) erscheinen — sie sind
   * für ein Verwaltungspublikum nicht akzeptabel und auf vielen
   * Behörden-Arbeitsplätzen ohne Emoji-Font unleserlich. Stattdessen
   * nutzen wir die zentralen Prosa-Labels aus
   * `UA.proseLabelForExport` (definiert in js/ua.export_v2.js).
   *
   * Fallback: wenn das Modul `UA.proseLabelForExport` nicht geladen ist
   * (bei Standalone-Tests von ua.report_v2.js ohne ua.export_v2.js),
   * substituieren wir mit derselben Prosa-Tabelle als Inline-Fallback.
   *
   * @param {string} text - Text containing emoji icons and/or [Rad]-tokens
   * @returns {string} Text with all involvement glyphs replaced by prose
   */
  function replaceEmojisForPDF(text) {
    if (text == null) return "";
    if (typeof UA.proseLabelForExport === "function") {
      return UA.proseLabelForExport(text);
    }
    // Inline fallback (mirror of UA.proseLabelForExport).
    let s = String(text);
    const PROSE = {
      Rad: "Radverkehr", Fuss: "Fußverkehr", PKW: "PKW",
      Krad: "Motorrad", Lkw: "LKW/Güterverkehr", Sonst: "Sonstige Beteiligte"
    };
    s = s.replace(/\[(Rad|Fuss|PKW|Krad|Lkw|Sonst)\]/g, (_, k) => PROSE[k] || _);
    s = s
      .replace(/\u{1F6B2}/gu, PROSE.Rad)
      .replace(/\u{1F6B6}/gu, PROSE.Fuss)
      .replace(/\u{1F697}/gu, PROSE.PKW)
      .replace(/\u{1F3CD}[\u{FE0F}]?/gu, PROSE.Krad)
      .replace(/\u{1F69B}/gu, PROSE.Lkw)
      .replace(/\u{1F68C}/gu, PROSE.Sonst);
    s = s.replace(/(\p{L})\s*\+\s*(\p{L})/gu, "$1 + $2");
    return s;
  }

  /**
   * DOCX-Variante derselben Prosa-Substitution. Wir routen die DOCX-
   * Anzeigetexte durch dieselbe Funktion wie das PDF, damit beide
   * Exportformate identische Beteiligten-Beschriftungen führen
   * (QA-PR „Export-Semantik vor Layout").
   * Exportiert als `UA.replaceEmojisForDocx`, damit Tests sie einzeln
   * prüfen können.
   */
  function replaceEmojisForDocx(text) {
    return replaceEmojisForPDF(String(text == null ? "" : text));
  }
  UA.replaceEmojisForDocx = replaceEmojisForDocx;

  /**
   * PR-QA „Textqualität": Übersetzt rohe technische Filterwerte in
   * lesbare deutsche Begriffe. Rohwerte wie "all", "wet", "dry" entstehen
   * direkt aus den UI-Selectors und gehören nicht in einen
   * einreichungsreifen Bezirksratsantrag.
   *
   * Bekannte Werte werden umgesetzt; alles andere wird unverändert
   * zurückgegeben (numerische Codes, Eigennamen). "all" bzw. "*" werden
   * grundsätzlich zu „Alle" bzw. „Alle (keine Einschränkung)".
   *
   * @param {string} key   - Filtername (z. B. "severity", "dayType")
   * @param {string|number} val
   * @returns {string}
   */
  function formatFilterValue(key, val) {
    if (val == null) return "—";
    const s = String(val).trim();
    const lower = s.toLowerCase();
    if (lower === "all" || lower === "*" || lower === "any") return "Alle (keine Einschränkung)";
    const dicts = {
      severity: {
        "1": "Getötete", "2": "Schwerverletzte", "3": "Leichtverletzte",
        "tot": "Getötete", "schwer": "Schwerverletzte", "leicht": "Leichtverletzte"
      },
      roadCondition: {
        "0": "trocken", "1": "nass/feucht/schlüpfrig", "2": "winterglatt",
        "dry": "trocken", "wet": "nass/feucht/schlüpfrig", "winter": "winterglatt"
      },
      dayType: {
        "weekday": "Werktag (Mo–Fr)", "weekend": "Wochenende (Sa/So)",
        "mo-fr": "Werktag (Mo–Fr)", "sa-so": "Wochenende (Sa/So)"
      },
      involvementMode: {
        "or": "ODER (eine der gewählten Beteiligungen)",
        "and": "UND (alle gewählten Beteiligungen gemeinsam)",
        "solo": "Nur Solo (genau eine Beteiligung)"
      }
    };
    const dict = dicts[key];
    if (dict && Object.prototype.hasOwnProperty.call(dict, lower)) return dict[lower];
    return s;
  }
  UA.formatFilterValue = formatFilterValue;

  /**
   * PR-QA „Textqualität": Deutsches Zahlformat für Faktor-Werte. Aus
   * „Faktor 2.18" wird „Faktor 2,18". Wird sowohl im DOCX/PDF als auch
   * in den TEXT/HTML-Renderern verwendet. Liefert „k. A." bei NaN/∞.
   * @param {number} factor
   * @param {number} [decimals=2]
   */
  function formatFactorDe(factor, decimals) {
    if (!Number.isFinite(factor)) return "k. A.";
    const d = (typeof decimals === "number") ? decimals : 2;
    return factor.toFixed(d).replace(".", ",");
  }
  UA.formatFactorDe = formatFactorDe;


  // ---------------------------------------------------------------------
  // PDF involvement icons (issue: "Symbole … sichtbar machen in der PDF")
  //
  // Inline-SVG pictograms for the 6 involvement classes. They are embedded
  // directly into pdfMake table cells via { svg, width, height } content
  // nodes, which renders independently of the (Roboto) text font and so
  // works without bundling an emoji-capable TTF.
  //
  // The SVGs are kept tiny and monochrome (single dark-grey fill) so they
  // print cleanly in B/W and stay legible at the table font sizes we use
  // (~9 pt). All viewBoxes are 24×24 → easy to scale uniformly.
  // ---------------------------------------------------------------------
  const PDF_ICON_FILL = "#222";
  // Source: Material-design / Tabler-style minimalist pictograms, hand-trimmed
  // to single <path> elements per icon to keep the inline SVG small. Each is
  // a stand-alone, self-contained SVG document (no external refs).
  const PDF_INVOLVEMENT_ICONS = {
    bike:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M5 18a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm14 1.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM15 6h3v2h-2l-2.3 4.6 2 3.4H13l-1.5-2.6L9 17H7l3.5-6.3L9 8H7V6h3l1.5 3h2L15 6Z"/></svg>',
    ped:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M13.5 5.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0ZM10 8h2.5l2 4 2.5 1-.5 1.5-3-1-1.5-2v3l2 5h-1.7l-2-5-2 5H6l2-6V9.5L7 11l-2 1V10l2.5-1L10 8Z"/></svg>',
    car:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11h.5a1.5 1.5 0 0 1 1.5 1.5V17a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1v-1H6v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-4.5A1.5 1.5 0 0 1 4.5 11H5Zm1.7 0h10.6l-1-3a.5.5 0 0 0-.5-.4H8.2a.5.5 0 0 0-.5.4l-1 3ZM7 14.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm10 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>',
    moto:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M5 17a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm14 1.5a3 3 0 1 1 0-6 3 3 0 0 1 0 6Zm0-1.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM14 7h3l2 4-2 1-2-3h-1.5l-1.5 2 2.5 2-1 1.5-3-2.5-2 1V12l1.5-1L8 8H6V6h2.5L11 8h3V7Z"/></svg>',
    truck: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M3 7a1 1 0 0 1 1-1h9v8H3V7Zm11 1h3.5l2.5 3v3h-1a2 2 0 1 1-4 0h-1V8Zm3 5h2v-1.5L17.7 9.5H17V13ZM7 17a2 2 0 1 1 0-4 2 2 0 0 1 0 4Zm10 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4ZM7 15.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Zm10 0a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1Z"/></svg>',
    bus:   '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="' + PDF_ICON_FILL + '" d="M6 4h12a2 2 0 0 1 2 2v10a2 2 0 0 1-1 1.7V19a1 1 0 0 1-2 0v-1H7v1a1 1 0 0 1-2 0v-1.3A2 2 0 0 1 4 16V6a2 2 0 0 1 2-2Zm0 2v5h12V6H6Zm0 7v3h12v-3H6Zm2 2.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"/></svg>'
  };
  // Map original emoji codepoints → icon key. Mirrors COMBO_BITS in
  // js/ua.export_v2.js so the two stay in sync.
  const PDF_EMOJI_TO_KEY = {
    "\u{1F6B2}": "bike",   // 🚲
    "\u{1F6B6}": "ped",    // 🚶
    "\u{1F697}": "car",    // 🚗
    "\u{1F3CD}": "moto",   // 🏍 (variation-selector handled by stripping below)
    "\u{1F69B}": "truck",  // 🚛
    "\u{1F68C}": "bus"     // 🚌
  };
  // Regex matches any of the involvement emojis (with optional VS-16 selector).
  const PDF_EMOJI_RE = /(\u{1F6B2}|\u{1F6B6}|\u{1F697}|\u{1F3CD}\u{FE0F}?|\u{1F69B}|\u{1F68C})/u;

  /**
   * Build a pdfMake table-cell content node for an involvement label.
   * If `label` contains no involvement emoji, returns the original string
   * unchanged so callers stay back-compatible. Otherwise returns a `columns`
   * node where every emoji is rendered as an inline SVG icon and any non-
   * emoji text (e.g. " + ", counts, prefixes like "Mask " for unknown masks)
   * is preserved as plain text — emojis themselves are replaced with their
   * pictogram so no glyph is left for the unsupported font to render.
   *
   * @param {string} label   e.g. "🚲+🚗" or "🚲: 4"
   * @param {object} [opts]  { fontSize?: number, iconSize?: number, bold?: boolean }
   * @returns {string|object} pdfMake content node
   */
  function pdfInvolvementCell(label, opts) {
    const s = String(label == null ? "" : label);
    if (!PDF_EMOJI_RE.test(s)) return s;
    const fontSize = (opts && opts.fontSize) || 9;
    const iconSize = (opts && opts.iconSize) || (fontSize + 2);
    const bold = !!(opts && opts.bold);
    // Tokenise: split on the emoji regex, alternating text / emoji.
    const parts = s.split(PDF_EMOJI_RE);
    const cols = [];
    for (const part of parts) {
      if (!part) continue;
      // Strip optional VS-16 (\uFE0F) so the lookup hits 🏍.
      const stripped = part.replace(/\uFE0F/g, "");
      const key = PDF_EMOJI_TO_KEY[stripped];
      if (key && PDF_INVOLVEMENT_ICONS[key]) {
        cols.push({ svg: PDF_INVOLVEMENT_ICONS[key], width: iconSize, height: iconSize, margin: [0, 0, 1, 0] });
      } else {
        cols.push({ text: part, fontSize, bold, margin: [0, 1, 1, 0] });
      }
    }
    return { columns: cols, columnGap: 1 };
  }
  // Expose for unit tests; harmless if a future refactor moves it elsewhere.
  UA.pdfInvolvementCell = pdfInvolvementCell;

  /**
   * Generate and download PDF document
   * @param {Object} ctx - Application context
   * @param {Object} reportData - Report data from UA.computeExportReport
   * @param {Object} options - Export options
   */
  UA.exportToPDF = async function exportToPDF(ctx, reportData, options = {}) {
    // Ensure export libraries are loaded
    await UA.ensureExportLibraries();
    
    if (!window.pdfMake) {
      throw new Error("pdfMake library not loaded");
    }

    const CITY_RAW = ctx.CITY_RAW || "—";
    const today = new Date().toLocaleDateString("de-DE");
    // Replace emojis with text labels for PDF compatibility
    const pdfText = replaceEmojisForPDF(reportData.text || "");
    const textLines = pdfText.split("\n");

    // Use structured data if available
    const sd = reportData.structured || null;

    // Task 5: Dedup-Guard für PDF (siehe DOCX-Variante).
    const renderedSections = new Set();
    function sectionGuard(name) {
      if (renderedSections.has(name)) return true;
      renderedSections.add(name);
      return false;
    }

    // Helper: format percentage for PDF
    function fmtPctPdf(n, total) {
      return total ? ((n / total) * 100).toFixed(1).replace(".", ",") + " %" : "0,0 %";
    }

    // Helper: build pdfmake table with header row
    // Optional: rowHighlights is an array of booleans – true = highlight that data row
    // Optional: opts.widths overrides column widths (default: equal "*" split).
    //           opts.fontSize overrides per-cell font size (default 9).
    // Cells may be plain strings (rendered as { text }) OR pre-built pdfMake
    // content objects (e.g. { columns: [...] } for cells produced by
    // pdfInvolvementCell). The latter pass through unchanged so callers can
    // embed inline SVG icons or other rich layouts without extra plumbing.
    function makePdfTable(headers, dataRows, rowHighlights, opts) {
      const fontSize = (opts && opts.fontSize) || 9;
      const widths = (opts && opts.widths) || headers.map(() => "*");
      const wrapCell = (cell, highlight) => {
        if (cell != null && typeof cell === "object") {
          // Pass-through for rich content (svg/columns/stack). Apply highlight
          // by wrapping in a 1-row table-like fillColor cell only if needed —
          // pdfMake honors `fillColor` on the cell descriptor itself, which
          // for compound nodes we set on the wrapping object.
          return highlight ? Object.assign({}, cell, { fillColor: "#FFFFCC" }) : cell;
        }
        // QA-PR „Export-Semantik vor Layout": jede sichtbare String-Zelle
        // wird durch die zentrale Prosa-Substitution gefiltert. Damit
        // erscheinen weder Beteiligten-Emojis (🚲/🚗/…) noch die internen
        // Bracket-Tokens („[Rad]+[PKW]") in den PDF-Tabellen — nur die
        // verwaltungstauglichen Prosa-Labels („Radverkehr + PKW").
        const safe = replaceEmojisForPDF(String(cell ?? ""));
        return {
          text: safe,
          fontSize,
          ...(highlight ? { fillColor: "#FFFFCC", bold: true } : {})
        };
      };
      return {
        table: {
          headerRows: 1,
          widths,
          body: [
            headers.map(h => ({ text: h, bold: true, fillColor: "#EEEEEE", fontSize })),
            ...dataRows.map((row, i) => row.map(cell => wrapCell(cell, !!(rowHighlights && rowHighlights[i]))))
          ]
        },
        layout: "lightHorizontalLines",
        margin: [0, 4, 0, 10]
      };
    }

    // Helper: noteBox — light-gray, padded, single-cell info box.
    // Wird im Layout-PR für die "Hinweis zur Zählweise"-Box (und potentiell
    // weitere kursiv-graue Hinweisblöcke) verwendet, damit pdfMake echtes
    // Padding + Hintergrund rendert (Text-Knoten allein erlauben das nicht).
    // `lines` ist ein Array von pdfMake-text-Knoten ODER plain-Strings.
    function makePdfNoteBox(lines) {
      const linesArr = (Array.isArray(lines) ? lines : [lines])
        .filter((x) => x != null);
      const stack = linesArr.map((ln) => {
        if (ln && typeof ln === "object") return ln;
        return { text: String(ln), style: "noteBox" };
      });
      return {
        table: {
          widths: ["*"],
          body: [[
            {
              stack,
              fillColor: "#F2F2F2",
              margin: [8, 6, 8, 6],
              border: [false, false, false, false]
            }
          ]]
        },
        layout: "noBorders",
        margin: [0, 6, 0, 8]
      };
    }


    const pdfAfm = (sd && sd.meta && sd.meta.activeFilterMask) || 0;
    const pdfAfMode = (sd && sd.meta && sd.meta.involvementMode) || "or";
    function isPdfActiveFilterRow(rowMask) {
      if (pdfAfm === 0) return false;
      if (pdfAfMode === "solo") {
        const isSingleBit = rowMask > 0 && (rowMask & (rowMask - 1)) === 0;
        return isSingleBit && (rowMask & pdfAfm) !== 0;
      }
      if (pdfAfMode === "and") {
        return (rowMask & pdfAfm) === pdfAfm;
      }
      return (rowMask & pdfAfm) !== 0;
    }

    const docDefinition = {
      pageSize: "A4",
      // Reduced left/right margins (was 60/60) so wide tables — especially the
      // Einzelunfall-Detailtabelle with 7+ columns — fit within the printable
      // area instead of overflowing the page edge.
      pageMargins: [40, 60, 40, 60],
      content: [],
      styles: {
        // ---- Layout-Pass: kanonische Style-Namen ----
        // Die neuen Stilnamen (title/sectionHeader/subsectionHeader/body/
        // lead/caption/noteBox) bilden die im Layout-PR vorgegebene zentrale
        // Typografie ab. Die Legacy-Namen (header/subheader/subheader2/
        // normal/small) bleiben als Aliase erhalten, damit bestehende Call-
        // sites unverändert weiter funktionieren — neue Inhalte SOLLEN aber
        // konsequent die kanonischen Namen verwenden.
        title: {
          fontSize: 20,
          bold: true,
          alignment: "center",
          margin: [0, 0, 0, 12]
        },
        sectionHeader: {
          fontSize: 15,
          bold: true,
          margin: [0, 12, 0, 6]
        },
        subsectionHeader: {
          fontSize: 12,
          bold: true,
          margin: [0, 8, 0, 4]
        },
        body: {
          fontSize: 11,
          margin: [0, 0, 0, 4],
          lineHeight: 1.3
        },
        lead: {
          fontSize: 12,
          bold: true,
          margin: [0, 0, 0, 6]
        },
        caption: {
          fontSize: 9,
          italics: true,
          color: "#444444",
          margin: [0, 2, 0, 8]
        },
        // noteBox als Style-Definition — wird von einer leichten Tabelle mit
        // einer einzigen Zelle (fillColor=lightGray) genutzt, damit pdfMake
        // tatsächlich Padding+Background rendert (pdfMake unterstützt
        // Padding nicht direkt auf Text-Knoten). Bewusst KEIN `margin` hier:
        // der Style wird per Zeile (`stack[i].style = "noteBox"`) gesetzt
        // und würde sich sonst pro Zeile aufaddieren — Außenabstände
        // kommen vom Cell-`margin` (Padding) und der Wrapper-Tabelle in
        // `makePdfNoteBox()`.
        noteBox: {
          fontSize: 10,
          color: "#222222"
        },

        // ---- Legacy-Aliase (siehe Kommentar oben) ----
        header: {
          fontSize: 18,
          bold: true,
          alignment: "center",
          margin: [0, 0, 0, 10]
        },
        subheader: {
          fontSize: 14,
          bold: true,
          margin: [0, 10, 0, 5]
        },
        // Phase 1.4: dritte Hierarchiestufe für Sub-Sub-Sektionen
        // (z. B. "Detailansicht – markierter Bereich" und einzelne
        // Cluster-Karten innerhalb von KARTENAUSSCHNITT). Kleinere Schrift
        // und engere Margins trennen sie optisch von Hauptkapiteln.
        subheader2: {
          fontSize: 12,
          bold: true,
          margin: [0, 6, 0, 3]
        },
        normal: {
          fontSize: 11,
          margin: [0, 0, 0, 5]
        },
        small: {
          fontSize: 9,
          italics: true,
          color: "#666666"
        }
      },
      defaultStyle: {
        font: "Roboto"
      }
    };

    // ---- Title / Cover ----
    // Derive document title from structured data (same logic as Word export)
    const gremiumMeta = sd && sd.meta && sd.meta.gremium ? sd.meta.gremium : {};
    const docTitle = deriveDocTitle(gremiumMeta.typ);

    docDefinition.content.push({
      text: docTitle.toUpperCase(),
      style: "header"
    });

    // Sublines: An, Stadt, Bereich, Datum, Betreff
    const metaCity   = (sd && sd.meta && sd.meta.city)     || CITY_RAW;
    const metaArea   = (sd && sd.meta && sd.meta.areaName) || "(Kartenausschnitt)";
    const metaDate   = (sd && sd.meta && sd.meta.date)     || today;
    const metaToWhom = gremiumMeta.gremium || "zuständiges Gremium prüfen";

    const headerLines = [
      ["An:", metaToWhom],
      ["Stadt:", metaCity],
      ["Bereich:", metaArea],
      ["Datum:", metaDate],
      ["Betreff:", "Verbesserung der Verkehrssicherheit – Auffälliger Unfallschwerpunkt"]
    ];
    for (const [label, value] of headerLines) {
      docDefinition.content.push({
        text: [{ text: `${label} `, bold: true }, { text: value }],
        style: "normal",
        margin: [0, 2, 0, 2]
      });
    }

    docDefinition.content.push({
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: 450, y2: 0, lineWidth: 0.5, lineColor: '#888888' }],
      margin: [0, 5, 0, 15]
    });

    // ---- Rahmendaten table ----
    const metaLink = (sd && sd.meta && sd.meta.link) || "";
    const kvRahmen = [
      ["Dokumenttyp", docTitle],
      gremiumMeta.gremium  ? ["Gremium",              gremiumMeta.gremium]  : null,
      gremiumMeta.typ      ? ["Gremiumstyp",          gremiumMeta.typ]      : null,
      gremiumMeta.kontakt  ? ["Kontakt",               gremiumMeta.kontakt]  : null,
      metaArea             ? ["Bereich",               metaArea]             : null,
      metaCity             ? ["Stadt",                 metaCity]             : null,
      metaDate             ? ["Exportdatum",           metaDate]             : null,
      // PR-QA „Werkbank-Link in Tabelle": kurzer Linktext statt
      // vollständigem URL — pdfmake-Hyperlink über `link:` + Zellinhalt.
      metaLink             ? ["Werkbank-Link",
                              { text: "Werkbank-Link öffnen", link: metaLink, color: "blue", decoration: "underline" }
                             ] : null,
      gremiumMeta.hinweis  ? ["Zuständigkeitshinweis", gremiumMeta.hinweis]  : null
    ].filter(Boolean);

    if (kvRahmen.length > 0) {
      docDefinition.content.push({ text: "Rahmendaten", style: "subheader" });
      // Narrow label column + flexible value column so long values like the
      // Werkbank-Link don't push the whole table off-page.
      docDefinition.content.push(makePdfTable(
        ["Feld", "Wert"],
        kvRahmen,
        undefined,
        { widths: ["auto", "*"] }
      ));
    }

    // ---- Aktive Filter table ----
    // PR-QA „Textqualität": rohe Werte wie "all" in lesbare Begriffe
    // übersetzen (siehe UA.formatFilterValue für die Wörterbücher).
    const filters = (sd && sd.meta && sd.meta.filters) || {};
    const filterRows = [];
    if (filters.severity      != null) filterRows.push(["Schweregrad",       UA.formatFilterValue("severity", filters.severity)]);
    if (filters.roadCondition != null) filterRows.push(["Fahrbahnzustand",   UA.formatFilterValue("roadCondition", filters.roadCondition)]);
    if (filters.involvementMode != null) filterRows.push(["Beteiligungsmodus", UA.formatFilterValue("involvementMode", filters.involvementMode)]);

    // Render the active "Beteiligte" line as Prosa-Textlabel (QA-PR
    // „Export-Semantik vor Layout"): keine Emojis/Icons im PDF.
    const partCodesPdf = [];
    if (filters.includeCyclist)    partCodesPdf.push("Rad");
    if (filters.includePedestrian) partCodesPdf.push("Fuss");
    if (filters.includeCar)        partCodesPdf.push("PKW");
    if (filters.includeMotorcycle) partCodesPdf.push("Krad");
    if (filters.includeGkfz)       partCodesPdf.push("Lkw");
    if (filters.includeSonstig)    partCodesPdf.push("Sonst");
    if (partCodesPdf.length > 0) {
      const partProsePdf = (typeof UA.formatParticipantCombinationForExport === "function")
        ? UA.formatParticipantCombinationForExport(partCodesPdf)
        : partCodesPdf.join(" + ");
      filterRows.push(["Beteiligte", partProsePdf]);
    }

    if (filters.hourFrom != null && filters.hourTo != null) {
      filterRows.push(["Zeitraum", `${filters.hourFrom}:00-${filters.hourTo}:00 Uhr`]);
    }
    if (filters.dayType != null) filterRows.push(["Wochentag", UA.formatFilterValue("dayType", filters.dayType)]);

    if (filterRows.length > 0) {
      docDefinition.content.push({ text: "Aktive Filter", style: "subheader" });
      docDefinition.content.push(makePdfTable(
        ["Filter", "Wert"],
        filterRows,
        undefined,
        { widths: ["auto", "*"] }
      ));
    }

    // ---- Hinweis zur Zählweise (PR 2 / Spec-Item 4) ----
    // Layout-Pass: als echte noteBox (light-gray, padded) statt als loser
    // kursiver Text — damit der Hinweis visuell als Block erkennbar ist
    // und vom Antragstext klar abgesetzt wird.
    docDefinition.content.push(makePdfNoteBox([
      { text: HINWEIS_ZAEHLWEISE_LINES[0], style: "noteBox", bold: true, margin: [0, 0, 0, 3] },
      { text: HINWEIS_ZAEHLWEISE_LINES[1], style: "noteBox" }
    ]));

    // ---- Methodik – Scope der Auswertung (PR 2 / Spec-Item 6) ----
    if (sd && sd.methodikScope && Array.isArray(sd.methodikScope.lines) && sd.methodikScope.lines.length > 0) {
      docDefinition.content.push({
        text: sd.methodikScope.title || "Methodik – Scope der Auswertung",
        style: "subsectionHeader"
      });
      for (const ln of sd.methodikScope.lines) {
        docDefinition.content.push({
          text: String(ln),
          style: "body"
        });
      }
      docDefinition.content.push({ text: "", margin: [0, 0, 0, 6] });
    }

    // PR 2 / Spec-Item 4: per-export figure-caption counter (PDF side).
    const pdfFigCounter = makeFigureCounter();
    // Layout-Pass / Spec-Item 6: Parent-Count für Caption-Cross-References
    // ("Die N dargestellten Unfälle sind eine Teilmenge der M Unfälle aus
    // Abbildung 1."). M = Gesamtfallzahl im Ausschnitt
    // (= structured.accidentDetails.total mit Fallback auf totalAccidents).
    const pdfParentN =
      (sd && sd.accidentDetails && Number.isFinite(sd.accidentDetails.total))
        ? sd.accidentDetails.total
        : (sd && Number.isFinite(sd.totalAccidents) ? sd.totalAccidents : null);

    // ---- ANTRAG / BESCHLUSSVORSCHLAG (oben, Layout-PR) ----
    // Verwaltungsdokumente führen den Antragstext direkt nach dem
    // Dokumentkopf — siehe Begleit-Kommentar im DOCX-Export. Der
    // ausführliche Wortlaut bleibt zusätzlich am Ende erhalten,
    // wird aber per sectionGuard nicht mehr doppelt gerendert.
    {
      const beschlussLeadPdf = extractSection(textLines, "Beschlussvorschlag:");
      const beschlussLinesPdf = (Array.isArray(beschlussLeadPdf) ? beschlussLeadPdf : [])
        .map(l => String(l || "").trim())
        .filter(Boolean);
      docDefinition.content.push({
        text: "ANTRAG / BESCHLUSSVORSCHLAG",
        style: "subheader"
      });
      if (beschlussLinesPdf.length > 0) {
        for (const line of beschlussLinesPdf) {
          const content = textWithLinks(line);
          docDefinition.content.push({ text: content, style: "normal" });
        }
      } else {
        docDefinition.content.push({
          text: "Der Bezirksrat fordert die Verwaltung auf, innerhalb von 3 Monaten den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen. Die Wirksamkeit der Maßnahmen ist nach 12 Monaten anhand der Unfallatlas-Daten zu evaluieren.",
          style: "normal"
        });
      }
      sectionGuard("BESCHLUSSVORSCHLAG");
    }

    // ---- BEGRÜNDUNG (Sammelüberschrift) ----
    docDefinition.content.push({
      text: "BEGRÜNDUNG",
      style: "subheader"
    });

    // ---- KURZBEWERTUNG (Task 2) ----
    if (sd && sd.executiveSummary) {
      const es = sd.executiveSummary;
      docDefinition.content.push({ text: "KURZBEWERTUNG", style: "subheader" });
      docDefinition.content.push({ text: es.classification, bold: true, margin: [0, 0, 0, 6] });
      for (const b of (es.bullets || [])) {
        docDefinition.content.push({ text: "• " + b, margin: [0, 0, 0, 3] });
      }
      if (es.urgency) {
        docDefinition.content.push({ text: es.urgency, italics: true, margin: [0, 4, 0, 8] });
      }
      if (Array.isArray(sd.mapReferences) && sd.mapReferences.length > 0) {
        for (const s of sd.mapReferences) {
          docDefinition.content.push({ text: s, margin: [0, 0, 0, 4] });
        }
      }
    }

    // ---- SACHVERHALT section ----
    docDefinition.content.push({
      text: "SACHVERHALT",
      style: "subheader",
      pageBreak: undefined
    });

    const sachverhaltSection = extractSection(textLines, "Sachverhalt:");
    if (sachverhaltSection.length > 0) {
      // Defense in depth: the default stop-list in extractSection already
      // terminates at every post-Sachverhalt block header, but keep this
      // inline guard in sync with POST_SACHVERHALT_STOP_HEADERS so future
      // refactors of extractSection cannot regress the QA blocker.
      for (const line of sachverhaltSection) {
        const trimmed = line.trim();
        const hitsBlockHeader = POST_SACHVERHALT_STOP_HEADERS.some(
          h => h !== "Sachverhalt:" && trimmed.startsWith(h)
        );
        if (hitsBlockHeader) {
          break;
        }
        const content = textWithLinks(line);
        docDefinition.content.push({
          text: content,
          style: "normal"
        });
      }
    }

    // ---- STATISTIK section with real tables (from structured data) ----
    if (sd && !sectionGuard("STATISTIK")) {
      docDefinition.content.push({ text: "STATISTIK", style: "subheader" });

      // Severity table
      docDefinition.content.push({ text: "Verletzungsschwere im Ausschnitt:", style: "normal" });
      const sev = sd.severity;
      const sevTotal = sev ? sev.total : 0;
      docDefinition.content.push(makePdfTable(
        ["Kategorie", "Anzahl", "Anteil"],
        [
          ["1 – Getötete",       String((sev && sev.bySev["1"]) || 0), fmtPctPdf((sev && sev.bySev["1"]) || 0, sevTotal)],
          ["2 – Schwerverletzte", String((sev && sev.bySev["2"]) || 0), fmtPctPdf((sev && sev.bySev["2"]) || 0, sevTotal)],
          ["3 – Leichtverletzte", String((sev && sev.bySev["3"]) || 0), fmtPctPdf((sev && sev.bySev["3"]) || 0, sevTotal)]
        ]
      ));

      // Deviations table — parity with DOCX/HTML: 95%-KI + n.s.-Hinweis (or political simplification).
      if (sd.deviations && sd.deviations.focus && sd.deviations.focus.length > 0) {
        const isPolitical = sd.meta && sd.meta.mode === "political";
        const fmtFactor = UA.formatFactorPolitical || ((f) => `Faktor ${f.toFixed(2).replace(".", ",")}`);
        docDefinition.content.push({ text: "Top-Abweichungen (Ausschnitt vs. Stadt):", style: "normal" });
        const devRows = sd.deviations.focus.map(r => {
          const locPct = ((r.locR) * 100).toFixed(1).replace(".", ",") + " %";
          const basePct = ((r.baseR) * 100).toFixed(1).replace(".", ",") + " %";
          // QA-PR „Export-Semantik": Prosa-Label statt SVG-Icons.
          const muster = (typeof UA.formatParticipantCombinationForExport === "function")
            ? UA.formatParticipantCombinationForExport(r.mask)
            : (r.textLabel || r.label);
          if (isPolitical) {
            // Task 9/10: politisches Wording, kein 95%-KI.
            return [muster, String(r.locCnt), locPct, basePct, fmtFactor(r.factor, { mode: "political" })];
          }
          const ciLowPct  = r.ciLow  != null ? (r.ciLow  * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const ciHighPct = r.ciHigh != null ? (r.ciHigh * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const factorStr = r.factor.toFixed(2).replace(".", ",") + "x" + (r.isSignificant === false ? " (n.s.)" : "");
          return [muster, String(r.locCnt), locPct, basePct, factorStr, `[${ciLowPct} – ${ciHighPct}]`];
        });
        if (isPolitical) {
          docDefinition.content.push(makePdfTable(
            ["Muster", "Lokal", "Lokal %", "Stadt %", "Einordnung"],
            devRows,
            undefined,
            { widths: ["*", "auto", "auto", "auto", "*"] }
          ));
        } else {
          // Explicit widths: pattern column gets the slack (*), narrow numeric
          // columns are sized to their content so the table stops overflowing
          // on narrower viewports/pageSizes.
          docDefinition.content.push(makePdfTable(
            ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor", "95%-KI (lokaler Anteil)"],
            devRows,
            undefined,
            { widths: ["*", "auto", "auto", "auto", "auto", "auto"] }
          ));
          // PR-QA „Begriffliche Inkonsistenzen": Lesehilfe für Faktor-Wert.
          docDefinition.content.push({
            text: [
              { text: "Lesart: ", bold: true },
              { text: "„Faktor 2,18×" },
              { text: " bedeutet, dass das Beteiligungsmuster im untersuchten Bereich rund 2,18-mal so häufig vorkommt wie im Stadtdurchschnitt. Werte > 1 = überrepräsentiert, Werte < 1 = unterrepräsentiert. Die 95 %-Konfidenzintervalle zeigen die statistische Unsicherheit bei kleinen Fallzahlen." }
            ],
            style: "small",
            margin: [0, 2, 0, 6]
          });
        }
        // Task 10: 95%-KI/n.s.-Hinweis nur im technischen Modus.
        if (!isPolitical) {
          const allNonSig = sd.deviations.focus.every(r => r.isSignificant === false);
          if (allNonSig) {
            docDefinition.content.push({
              text: "Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (95%-KI schließt Stadtwert ein). Faktor-Werte bei kleinen Fallzahlen mit Vorsicht interpretieren.",
              style: "normal",
              italics: true,
              margin: [0, 4, 0, 8]
            });
          }
        }
        // Task 4 – URSACHEN UND MASSNAHMEN direkt nach den Abweichungen.
        if (Array.isArray(sd.causesMeasures) && sd.causesMeasures.length > 0) {
          docDefinition.content.push({ text: "URSACHEN UND MASSNAHMEN", style: "subheader" });
          const cmRows = sd.causesMeasures.map(c => [
            c.cause,
            (c.measureRefs && c.measureRefs.length > 0)
              ? c.measureRefs.map(e => `#${e.idx} (${e.label})`).join("; ")
              : c.measures.join("; ")
          ]);
          docDefinition.content.push(makePdfTable(
            ["Auffälliges Muster", "Empfohlene Maßnahmen (siehe Liste unten)"],
            cmRows,
            undefined,
            { widths: ["auto", "*"] }
          ));
        }
      }

      // Year table
      if (sd.yearTable && sd.yearTable.length > 0) {
        docDefinition.content.push({ text: "Unfälle pro Jahr im Ausschnitt:", style: "normal" });
        // QA-PR „Export-Semantik": „Kombinationen"-Spalte als Prosa,
        // niemals als Icon-/Bracket-Text. textClasses (Bracket-Form) wird
        // durch proseLabelForExport in „Radverkehr + PKW: 4" überführt.
        const proseFor = (typeof UA.proseLabelForExport === "function")
          ? UA.proseLabelForExport
          : (s) => String(s == null ? "" : s);
        const yrRows = sd.yearTable.map(row => {
          const cls = (row.textClasses && row.textClasses.length)
            ? row.textClasses.map(proseFor)
            : (row.classes || []).map(proseFor);
          return [
            String(row.year),
            String(row.total),
            cls.length ? cls.join(", ") : "—"
          ];
        });
        docDefinition.content.push(makePdfTable(
          ["Jahr", "Summe", "Kombinationen"],
          yrRows,
          undefined,
          { widths: ["auto", "auto", "*"] }
        ));
      }

      // Cross-table: Beteiligungskombination × Schweregrad
      if (sd.crossTable && sd.crossTable.rows && sd.crossTable.rows.length > 0) {
        docDefinition.content.push({ text: "Beteiligungskombination × Schweregrad:", style: "normal" });
        const ctRows = sd.crossTable.rows.map(r => {
          // QA-PR „Export-Semantik": Prosa-Label statt SVG-Icons.
          const label = (typeof UA.formatParticipantCombinationForExport === "function")
            ? UA.formatParticipantCombinationForExport(r.mask)
            : (r.textLabel || r.label);
          return [label, String(r.sev1), String(r.sev2), String(r.sev3), String(r.total)];
        });
        // Highlight rows whose mask matches the active filter
        const ctHighlights = sd.crossTable.rows.map(r => isPdfActiveFilterRow(r.mask));
        ctRows.push([
          "Gesamt",
          String(sd.crossTable.totals.sev1),
          String(sd.crossTable.totals.sev2),
          String(sd.crossTable.totals.sev3),
          String(sd.crossTable.totals.total)
        ]);
        ctHighlights.push(false); // Gesamt row is not highlighted
        docDefinition.content.push(makePdfTable(
          ["Kombination", "Getötete", "Schwerverletzt", "Leichtverletzt", "Summe"],
          ctRows,
          ctHighlights,
          { widths: ["*", "auto", "auto", "auto", "auto"] }
        ));
      }

      // Accident details table – grouped by strategy (consumes structured.accidentDetails.groups)
      // Economic impact (PR-C / B2): Volkswirtschaftliche Bedeutung
      if (options.includeCosts !== false && sd.economicImpact && sd.economicImpact.total > 0) {
        const fmt = (UA.costs && UA.costs.formatEUR) ? UA.costs.formatEUR : (n) => `${n} €`;
        const ei = sd.economicImpact;
        docDefinition.content.push({ text: "VOLKSWIRTSCHAFTLICHE BEDEUTUNG (SCHÄTZUNG)", style: "subheader" });
        const eiRows = [
          ["Getötete", String(ei.counts.fatal), fmt(ei.breakdown.fatal)],
          ["Schwerverletzte", String(ei.counts.severe), fmt(ei.breakdown.severe)],
          ["Leichtverletzte", String(ei.counts.light), fmt(ei.breakdown.light)],
          [`Gesamt (${ei.years} Jahr${ei.years === 1 ? "" : "e"})`,
            String(ei.counts.fatal + ei.counts.severe + ei.counts.light),
            fmt(ei.total)],
          ["Pro Jahr", "", fmt(ei.annual)]
        ];
        docDefinition.content.push(makePdfTable(["Kategorie", "Anzahl", "Geschätzte Kosten"], eiRows));
        // Trend-Qualifier (PR-β): konsistent mit TEXT/HTML/DOCX.
        const tq = trendQualifierTextDocx(ei.trendQualifier);
        if (tq) {
          docDefinition.content.push({ text: `Mehrjahres-Trend: ${tq}.`, bold: true, margin: [0, 4, 0, 2] });
        }
        if (ei.source && (ei.source.publisher || ei.source.year)) {
          const srcParts = [ei.source.publisher, ei.source.year].filter(Boolean).join(", ");
          docDefinition.content.push({ text: `Quelle: ${srcParts}`, style: "normal", margin: [0, 4, 0, 0] });
        }
        if (ei.disclaimer) {
          docDefinition.content.push({ text: ei.disclaimer, italics: true, fontSize: 9, margin: [0, 4, 0, 8] });
        }
      }

      // Orts- und musterbezogene Empfehlungen (UA.contextMeasures, Spec
      // Items 4–8). Direkt VOR „EMPFOHLENE MASSNAHMEN" — analog zur DOCX-
      // Sektion oben. Nutzt pdfMake-Styles ("subheader" für Heading-2,
      // bold/italics inline, eingerückte Bullets via margin: [10, …]).
      if (options.includeMeasures !== false && sd.contextualMeasures
          && Array.isArray(sd.contextualMeasures.matchedRules)
          && sd.contextualMeasures.matchedRules.length > 0
          && !sectionGuard("ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN")) {
        docDefinition.content.push({ text: "ORTS- UND MUSTERBEZOGENE EMPFEHLUNGEN", style: "subheader" });
        if (sd.contextualMeasures.rationale) {
          docDefinition.content.push({
            text: sd.contextualMeasures.rationale,
            italics: true, fontSize: 10, margin: [0, 2, 0, 8]
          });
        }
        const renderBucketPdfCtx = (heading, items) => {
          if (!Array.isArray(items) || items.length === 0) return;
          docDefinition.content.push({ text: heading, bold: true, margin: [0, 6, 0, 2] });
          for (const it of items) {
            docDefinition.content.push({
              text: "• " + it,
              style: "normal",
              margin: [10, 0, 0, 2]
            });
          }
        };
        renderBucketPdfCtx("Erforderliche Vor-Ort-Prüfung",     sd.contextualMeasures.pruefauftraege);
        renderBucketPdfCtx("Kurzfristig prüfbar",               sd.contextualMeasures.kurzfristig);
        renderBucketPdfCtx("Baulich/organisatorisch zu prüfen", sd.contextualMeasures.mittelfristig);
      }

      // Recommended measures (PR-D / B1+B3)
      if (options.includeMeasures !== false && UA.hasRecommendationsOrFiltered
          && UA.hasRecommendationsOrFiltered(sd.recommendedMeasures)
          && !sectionGuard("EMPFOHLENE MASSNAHMEN")) {
        const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
        const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
        docDefinition.content.push({ text: "EMPFOHLENE MASSNAHMEN", style: "subheader" });
        const cov = osmCoverageNoteDocx(sd.recommendedMeasures.osmCoverage);
        if (cov) {
          docDefinition.content.push({
            text: `OSM-Datenstand: ${cov}`,
            italics: true, fontSize: 9, margin: [0, 2, 0, 6],
            color: "#a05000"
          });
        }
        let i = 1;
        for (const item of (sd.recommendedMeasures.measures || [])) {
          const m = item.measure;
          docDefinition.content.push({ text: `${i}. ${m.label}`, bold: true, margin: [0, 6, 0, 2] });
          if (m.description) docDefinition.content.push({ text: m.description, style: "normal" });
          const ev = (m.effect && m.effect.evidenceLevel) ? `Evidenz ${m.effect.evidenceLevel}` : "";
          const meta = `Kosten: ${fmtCost(m.costRange)} pro ${m.perUnit || "Einheit"} · Reduktion: ${fmtRed(m.effect && m.effect.expectedReductionPct)}${ev ? " · " + ev : ""} · Vorlauf: ${m.leadTime || "—"}`;
          docDefinition.content.push({ text: meta, style: "normal" });
          // Goldstandard Items 5–6: explizite Cross-Reference auf den
          // URSACHEN-Block (analog DOCX/HTML/TEXT).
          if (Array.isArray(item.derivedFrom) && item.derivedFrom.length > 0) {
            docDefinition.content.push({
              text: `Abgeleitet aus auffälligem Muster: ${item.derivedFrom.map(d => d.label).join(" · ")}`,
              italics: true, fontSize: 10, color: "#555555",
              margin: [0, 0, 0, 2]
            });
          }
          if (item.amortisation && item.amortisation.years) {
            const [best, worst] = item.amortisation.years;
            docDefinition.content.push({ text: `Geschätzte Amortisation: ca. ${best.toFixed(1)} – ${worst.toFixed(1)} Jahre.`, style: "normal" });
          }
          if (Array.isArray(m.considerations)) {
            for (const c of m.considerations) {
              docDefinition.content.push({ text: "• " + c, style: "normal", margin: [10, 0, 0, 0] });
            }
          }
          i++;
        }
        if (Array.isArray(sd.recommendedMeasures.filteredOut) && sd.recommendedMeasures.filteredOut.length > 0) {
          docDefinition.content.push({ text: "Wegen OSM-Voraussetzungen NICHT empfohlen:", bold: true, margin: [0, 8, 0, 2] });
          for (const f of sd.recommendedMeasures.filteredOut) {
            docDefinition.content.push({ text: `• ${f.label}: ${f.reason || "Voraussetzungen nicht erfüllt"}`, style: "normal", margin: [10, 0, 0, 0] });
          }
        }
        if (sd.recommendedMeasures.disclaimer) {
          docDefinition.content.push({ text: sd.recommendedMeasures.disclaimer, italics: true, fontSize: 9, margin: [0, 4, 0, 8] });
        }
      }

      // Goldstandard-Sektion 8: Priorisierung (PDF). Drei-Bucket-Listen
      // analog zur DOCX-Sektion oben. Leere Buckets werden explizit
      // ausgewiesen, damit das Bild „der Bereich erfordert nur lange
      // Maßnahmen" nicht entsteht.
      if (sd.prioritization && sd.prioritization.meta && sd.prioritization.meta.totals.all > 0) {
        docDefinition.content.push({ text: "Priorisierung (Umsetzungshorizont)", style: "h2", margin: [0, 12, 0, 6] });
        const renderBucketPdf = (heading, bucket) => {
          docDefinition.content.push({ text: heading, bold: true, margin: [0, 6, 0, 2] });
          if (bucket.length === 0) {
            docDefinition.content.push({ text: "— keine Maßnahmen in diesem Horizont —", italics: true, color: "#666666", margin: [10, 0, 0, 0] });
            return;
          }
          for (const it of bucket) {
            docDefinition.content.push({
              text: `• ${it.label} (Vorlauf: ${it.leadTime})`,
              style: "normal",
              margin: [10, 0, 0, 0]
            });
          }
        };
        renderBucketPdf("Kurzfristig (0–3 Monate)", sd.prioritization.kurzfristig);
        renderBucketPdf("Mittelfristig (3–12 Monate)", sd.prioritization.mittelfristig);
        renderBucketPdf("Langfristig (>12 Monate)", sd.prioritization.langfristig);
      }

      if (sd.accidentDetails && sd.accidentDetails.groups && sd.accidentDetails.groups.length > 0) {
        // Resolve accident-view strategy + columns from the structured payload,
        // mirroring the DOCX branch above. Without these the per-row producer
        // and `makePdfTable(cols, …)` call below reference undefined names and
        // pdfMake.createPdf() then throws ReferenceError ("view is not defined")
        // before the download can ever fire.
        const view = (typeof UA !== "undefined" && UA.resolveAccidentView)
          ? UA.resolveAccidentView(sd.accidentDetails.viewId)
          : null;
        const cols = (sd.accidentDetails.columns && sd.accidentDetails.columns.length)
          ? sd.accidentDetails.columns
          : ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];
        for (const g of sd.accidentDetails.groups) {
          const docxHeader = (g.headers && Array.isArray(g.headers.docx)) ? g.headers.docx : null;
          if (docxHeader && docxHeader.length > 0) {
            for (const h of docxHeader) {
              docDefinition.content.push({ text: replaceEmojisForPDF(h.text || ""), bold: !!h.bold, margin: [0, 8, 0, 4] });
            }
          } else if (g.sevLabel) {
            const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
            docDefinition.content.push({ text: replaceEmojisForPDF(headerText), bold: true, margin: [0, 8, 0, 4] });
          }
          const detailRows = g.rows.map((r, i) => {
            // Use the strategy's docx row producer (same column shape as DOCX).
            // QA-PR „Export-Semantik": jede String-Zelle wird durch
            // proseLabelForExport gefiltert — danach enthält keine Detail-
            // tabellen-Zelle mehr ein Beteiligten-Emoji oder ein Bracket-
            // Token wie „[Rad]+[PKW]"; sichtbar bleibt nur Prosa
            // („Radverkehr + PKW"). Vorher wurden Strings stattdessen
            // durch pdfInvolvementCell als SVG-Icons gerendert — das hat
            // der QA-Bericht ausdrücklich als „kaputte Symbole" markiert.
            let cells;
            if (view && view.renderRow && view.renderRow.docx) {
              cells = view.renderRow.docx(r, i);
            } else {
              const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
              const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
              cells = [String(i + 1), String(r.year ?? "—"), r.involved, hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
            }
            const proseFor = (typeof UA.proseLabelForExport === "function")
              ? UA.proseLabelForExport
              : (s) => String(s == null ? "" : s);
            return cells.map(c => typeof c === "string" ? proseFor(c) : c);
          });
          // Tighter column widths so a 7-column accident-details table stays
          // within the printable area (was overflowing on A4 even with margin
          // tightened to 40 pt). Numeric/short-text columns sized to content;
          // the lone star column absorbs the slack.
          const detailWidths = (cols.length === 7)
            ? ["auto", "auto", "*", "auto", "auto", "auto", "auto"]
            : cols.map(() => "*");
          docDefinition.content.push(makePdfTable(cols, detailRows, undefined, { widths: detailWidths, fontSize: 8 }));
          if (g.overflow > 0) {
            const label = g.overflowLabel || `weitere ${g.sevLabel || ""}`;
            docDefinition.content.push({
              text: `… und ${g.overflow} ${label}`,
              style: "small"
            });
          }
        }
      } else if (sd.accidentDetails && sd.accidentDetails.rows && sd.accidentDetails.rows.length > 0) {
        // Fallback for legacy data without groups.
        // Phase 1.1: Statt eines 8-Spalters splitten wir in zwei kompakte
        // Tabellen ("Zeit/Ort" + "Beteiligung/Zustand"), korreliert über
        // die laufende Nr. (#). Damit bleiben beide Tabellen ≤ 5 Spalten
        // und es gibt keinen rechten Überlauf mehr auf A4.
        docDefinition.content.push({ text: "EINZELUNFÄLLE IM BEREICH", style: "subheader" });

        const ts = sd.accidentDetails.rows.map((r, i) => {
          const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
          const wd = (typeof UA !== "undefined" && UA.fmtWeekday)
            ? UA.fmtWeekday(r)
            : (r.weekday || "—");
          return [String(i + 1), String(r.year ?? "—"), r.sevLabel, hour, wd];
        });
        docDefinition.content.push({ text: "Zeit", style: "subheader2" });
        docDefinition.content.push(makePdfTable(
          ["#", "Jahr", "Schwere", "Uhrzeit", "Wochentag"],
          ts,
          undefined,
          { widths: ["auto", "auto", "auto", "auto", "*"], fontSize: 8 }
        ));

        const bs = sd.accidentDetails.rows.map((r, i) => {
          const coords = (r.lat != null && r.lon != null)
            ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}`
            : "—";
          // QA-PR „Export-Semantik": Prosa statt SVG-Icons.
          const involvedProse = (typeof UA.proseLabelForExport === "function")
            ? UA.proseLabelForExport(r.involved)
            : String(r.involved == null ? "" : r.involved);
          return [String(i + 1), involvedProse, r.roadCondition || "—", coords];
        });
        docDefinition.content.push({ text: "Beteiligung & Ort", style: "subheader2" });
        docDefinition.content.push(makePdfTable(
          ["#", "Beteiligte", "Fahrbahnzustand", "Koordinaten"],
          bs,
          undefined,
          { widths: ["auto", "*", "auto", "auto"], fontSize: 8 }
        ));
        if (sd.accidentDetails.truncated) {
          docDefinition.content.push({
            text: `… und ${sd.accidentDetails.total - sd.accidentDetails.rows.length} weitere Unfälle`,
            style: "small"
          });
        }
      }
    }

    // ---- Map section (if enabled) ----
    if (options.includeMap) {
      try {
        docDefinition.content.push({
          text: "KARTENAUSSCHNITT",
          style: "sectionHeader"
        });

        // Layout-Pass / Spec-Item 6 + 7: erklärender Absatz vor der Bilderfolge.
        // Stellt die Dramaturgie her (Text → Bild → Tabelle) und macht die
        // Detail- und Cluster-Karten als Teilmengen der Übersichtskarte
        // explizit verständlich.
        docDefinition.content.push({
          text: "Die folgenden Karten zeigen unterschiedliche Detailebenen. Detail- und Clusteransichten sind Teilmengen der Gesamtansicht.",
          style: "body"
        });

        const mapImageData = await UA.captureExportMapImage(ctx, options);
        const werkbankUrl = buildWerkbankUrl(ctx);

        // Layout-PR „Bildverzerrung beheben" / Spec-Items 1+2:
        //  - pdfMake-`fit:[w,h]` erhält die Aspektrate des PNG-Originals
        //    automatisch (das Bild wird in die Box eingepasst).
        //  - ALLE Karten (Übersicht, Detail, Cluster) nutzen jetzt dieselbe
        //    `PDF_MAP_MAX`-Box — vorher hatte die Übersicht 475×650 (zu hoch,
        //    erzeugte fast leere Folgeseiten), Detail/Cluster 475×350.
        // Bild und Caption werden in einem `stack` mit `unbreakable: true`
        // gerendert (Spec-Item 3 + 5: Bild-Block als Einheit, kein
        // Seitenumbruch zwischen Bild und Caption).
        const overviewCaption = pdfFigCounter.next("Übersichtskarte – gefilterte Unfälle im markierten Bereich").caption;
        docDefinition.content.push({
          unbreakable: true,
          stack: [
            {
              image: mapImageData,
              fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height],
              alignment: "center",
              margin: [0, 10, 0, 6],
              link: werkbankUrl
            },
            {
              text: overviewCaption,
              style: "caption",
              alignment: "center",
              margin: [0, 0, 0, 4]
            }
          ]
        });

        // Add "In Werkbank öffnen" link
        docDefinition.content.push({
          text: "→ In Werkbank öffnen",
          link: werkbankUrl,
          color: "blue",
          decoration: "underline",
          style: "normal",
          margin: [0, 5, 0, 10]
        });

        docDefinition.content.push({
          text: [
            "Legende: Die Karte zeigt die aktuelle Ansicht mit allen konfigurierten Filtern.\n",
            "Punkte: rot = Getötete, orange = Schwerverletzte, gelb = Leichtverletzte (mit weißem Rand für Sichtbarkeit).\n",
            "Kategorien: [Rad]=Fahrrad, [Fuss]=Fußgänger, [PKW]=PKW, [Krad]=Motorrad, [Lkw]=Lkw/Gkfz, [Sonst]=Sonstige.\n",
            "POIs wie Schulen und Kitas sind hervorgehoben."
          ].join(""),
          style: "small"
        });

        // Verification sentence (Task 6) – n MUST be the canonical
        // Einzelunfall-Tabellen-Zählung (siehe DOCX-Branch oben für die
        // ausführliche Begründung).
        const overviewN =
          (sd && sd.accidentDetails && Number.isFinite(sd.accidentDetails.total)) ? sd.accidentDetails.total
          : (sd && Number.isFinite(sd.totalAccidents) ? sd.totalAccidents
            : (Array.isArray(ctx.viewportPts) ? ctx.viewportPts.length : 0));
        docDefinition.content.push({
          text: mapVerificationSentence(overviewN),
          style: "small",
          italics: true,
          margin: [0, 4, 0, 8]
        });

        // Detail map: zoom to selection bounds if available
        if (ctx.selectionBounds) {
          try {
            const detailImageData = await (UA._captureDetailMap || captureDetailMap)(ctx, options);
            // Unique URL for detail map: explicit selSouth/West/North/East
            // and centered on the selection (Tasks 1, 3).
            const detailBbox = boundsToBbox(ctx.selectionBounds);
            const detailCenter = detailBbox ? {
              lat: (detailBbox.south + detailBbox.north) / 2,
              lon: (detailBbox.west + detailBbox.east) / 2
            } : null;
            const detailWerkbankUrl = buildWerkbankUrl(ctx, {
              bounds: detailBbox,
              center: detailCenter
            });
            const detailN = countPointsInBounds(ctx.viewportPts || [], detailBbox);
            // Layout-PR „Bildverzerrung beheben": einheitliche Box
            // (PDF_MAP_MAX) für alle Map-Typen; Bild + Caption als
            // unbreakable-Stack (Spec-Items 1, 2, 3, 5).
            const detailFig = pdfFigCounter.next("Detailausschnitt innerhalb des markierten Bereichs");
            const detailCaptionText = (pdfParentN != null)
              ? `${detailFig.caption} Die ${detailN} dargestellten Unfälle sind eine Teilmenge der ${pdfParentN} Unfälle aus Abbildung 1.`
              : detailFig.caption;
            docDefinition.content.push({
              unbreakable: true,
              stack: [
                { text: "Detailansicht – markierter Bereich", style: "subsectionHeader" },
                {
                  image: detailImageData,
                  fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height],
                  alignment: "center",
                  margin: [0, 10, 0, 6],
                  link: detailWerkbankUrl
                },
                {
                  text: detailCaptionText,
                  style: "caption",
                  alignment: "center"
                }
              ]
            });
            docDefinition.content.push({
              text: "→ In Werkbank öffnen",
              link: detailWerkbankUrl,
              color: "blue",
              decoration: "underline",
              style: "normal",
              margin: [0, 5, 0, 4]
            });
            docDefinition.content.push({
              text: mapVerificationSentence(detailN),
              style: "small",
              italics: true,
              margin: [0, 0, 0, 8]
            });
          } catch (detailErr) {
            console.warn("Detail map capture failed for PDF (graceful fallback):", detailErr);
          }
        }

        // Cluster maps: one zoomed-in PDF page section per dominant accident
        // hotspot (Tasks 1–7). Each map gets:
        //   – fitBounds onto its own bbox (no unrelated areas, Task 7)
        //   – a unique Werkbank URL with cluster-specific selSouth/…/selEast
        //     and centerLat/Lon/zoom (Tasks 1, 3)
        //   – heading "<label> – n Unfälle (Zoom z)" (matches the table)
        //   – verification sentence "Die dargestellten Punkte … (n = X)." (Task 6)
        try {
          const clusterMaps = await (UA._captureClusterMaps || captureClusterMaps)(ctx, options);
          for (const cm of clusterMaps) {
            // Task 5: only render a cluster map when the visible point count
            // matches the stated total. This is the explicit consistency
            // gate required by the spec.
            const visibleN = Array.isArray(cm.points)
              ? cm.points.length
              : countPointsInBounds(ctx.viewportPts || [], cm.bounds);
            if (visibleN !== cm.total) {
              console.warn(
                "Cluster map skipped: point/total mismatch",
                { label: cm.label, total: cm.total, visibleN }
              );
              continue;
            }

            const clusterUrl = buildWerkbankUrl(ctx, {
              bounds: cm.bounds,
              center: { lat: cm.lat, lon: cm.lon },
              zoom: cm.zoom
            });
            // Layout-PR „Bildverzerrung beheben": einheitliche Box +
            // unbreakable-Stack — Header, Bild und Caption bleiben zusammen.
            const clusterFig = pdfFigCounter.next(`Cluster-Karte – ${cm.label} (n=${cm.total})`);
            const clusterCaptionText = (pdfParentN != null)
              ? `${clusterFig.caption} Die ${cm.total} dargestellten Unfälle sind eine Teilmenge der ${pdfParentN} Unfälle aus Abbildung 1.`
              : clusterFig.caption;
            docDefinition.content.push({
              unbreakable: true,
              stack: [
                {
                  text: `${cm.label} – ${cm.total} Unfälle (Zoom ${cm.zoom})`,
                  style: "subsectionHeader"
                },
                {
                  image: cm.image,
                  fit: [PDF_MAP_MAX.width, PDF_MAP_MAX.height],
                  alignment: "center",
                  margin: [0, 10, 0, 6],
                  link: clusterUrl
                },
                {
                  text: clusterCaptionText,
                  style: "caption",
                  alignment: "center"
                }
              ]
            });
            docDefinition.content.push({
              text: "→ In Werkbank öffnen",
              link: clusterUrl,
              color: "blue",
              decoration: "underline",
              style: "normal",
              margin: [0, 5, 0, 4]
            });
            docDefinition.content.push({
              text: mapVerificationSentence(cm.total),
              style: "small",
              italics: true,
              margin: [0, 0, 0, 8]
            });
          }
        } catch (clusterErr) {
          console.warn("Cluster maps capture failed for PDF (graceful fallback):", clusterErr);
        }
      } catch (e) {
        console.error("Map capture failed for PDF:", e);
        docDefinition.content.push({
          text: "[Kartenerstellung fehlgeschlagen]",
          style: "small"
        });
      }
    }

    // ---- POI section (if enabled) ----
    if (options.includePOIs) {
      const poi = sd && sd.poi;
      const hasPoi = poi && (poi.totalWithin > 0 || poi.totalNear > 0);
      const poiSection = extractSection(textLines, "POI-Analyse");
      if (hasPoi || poiSection.length > 0) {
        docDefinition.content.push({
          text: "SENSIBLE EINRICHTUNGEN",
          style: "subheader"
        });

        if (hasPoi) {
          const poiRows = [];
          const allTypes = [...new Set([
            ...Object.keys(poi.withinByType || {}),
            ...Object.keys(poi.nearByType || {})
          ])].sort((a, b) => poiTypeLabel(a).localeCompare(poiTypeLabel(b), "de"));
          for (const type of allTypes) {
            const label = poiTypeLabel(type);
            poiRows.push([
              label,
              String(poi.withinByType[type] || 0),
              String(poi.nearByType[type] || 0)
            ]);
          }
          docDefinition.content.push(makePdfTable(
            ["Typ", "Im Bereich", "In der Nähe (< 200m)"],
            poiRows
          ));
          docDefinition.content.push({
            text: "Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.",
            style: "small"
          });
        } else {
          for (const line of poiSection) {
            const content = textWithLinks(line);
            docDefinition.content.push({
              text: content,
              style: "normal"
            });
          }
        }
      }
    }

    // ---- DUNKELZIFFER-PFLICHTHINWEIS (#C3) ----
    {
      const note = (sd && sd.darkFigureNote) || (typeof UA !== "undefined" && UA.DARK_FIGURE_NOTE) || null;
      if (note) {
        docDefinition.content.push({ text: note.title, style: "subheader" });
        docDefinition.content.push({ text: note.body, style: "normal" });
        docDefinition.content.push({ text: note.sourceLabel, italics: true, fontSize: 9, margin: [0, 4, 0, 8] });
      }
    }

    // ---- MEHRJAHRES-TREND (#C2) ----
    if (sd && sd.yearlyTrend && Array.isArray(sd.yearlyTrend.years) && sd.yearlyTrend.years.length > 0
        && !sectionGuard("MEHRJAHRES-TREND")) {
      const t = sd.yearlyTrend;
      docDefinition.content.push({ text: "MEHRJAHRES-TREND", style: "subheader" });
      const trendRows = t.years.map((y, i) => [
        String(y),
        String(t.counts.fatal[i]),
        String(t.counts.severe[i]),
        String(t.counts.light[i]),
        String(t.counts.total[i])
      ]);
      docDefinition.content.push(makePdfTable(
        ["Jahr", "Getötete", "Schwerverletzte", "Leichtverletzte", "Summe"],
        trendRows,
        undefined,
        { widths: ["auto", "auto", "auto", "auto", "*"] }
      ));
      const slopeStr = Number.isFinite(t.slope) ? t.slope.toFixed(2) : "—";
      const r2Str = Number.isFinite(t.r2) ? t.r2.toFixed(2) : "—";
      docDefinition.content.push({
        text: [
          { text: "Klassifikation: ", bold: true },
          { text: `${t.classification} ` },
          { text: `(Slope ${slopeStr}/Jahr, R² ${r2Str}, n=${t.nYears})`, italics: true }
        ],
        style: "normal",
        margin: [0, 0, 0, 8]
      });
    }

    // ---- STUNDEN-HEATMAP (#A2) ----
    if (sd && sd.heatmap && sd.heatmap.total > 0 && UA.heatmap) {
      const hm = sd.heatmap;
      docDefinition.content.push({ text: "STUNDEN-HEATMAP (WERKTAG VS. WOCHENENDE)", style: "subheader" });
      const body = [];
      // Header row
      body.push(["Stunde", "Mo–Fr", "Sa/So"].map(t => ({ text: t, bold: true, fillColor: "#EEEEEE", fontSize: 9, alignment: "center" })));
      for (let h = 0; h < 24; h++) {
        const row = [{ text: `${String(h).padStart(2, "0")}:00`, fontSize: 9, bold: true }];
        for (let c = 0; c < 2; c++) {
          const v = hm.matrix[h][c];
          const fill = UA.heatmap.cellColor(v, hm.max);
          const txt = UA.heatmap.readableTextColor(fill);
          row.push({
            text: v > 0 ? String(v) : "",
            fontSize: 9,
            alignment: "center",
            color: txt,
            fillColor: fill
          });
        }
        body.push(row);
      }
      docDefinition.content.push({
        // Constrain width so the heatmap doesn't span the whole page; the
        // narrow 3-column layout reads better at typical magnifications.
        table: {
          headerRows: 1,
          // Slim hour col, two equal data cols; total ≈ 200 pt < page width.
          widths: [40, 60, 60],
          body
        },
        layout: "lightHorizontalLines",
        margin: [0, 4, 0, 6]
      });
      docDefinition.content.push({
        text: `Gesamt: ${hm.total} Unfälle (Mo–Fr: ${hm.colTotals[0]}, Sa/So: ${hm.colTotals[1]}). Max. ${hm.max} Unfälle pro Stunde × Tagestyp.`,
        italics: true,
        fontSize: 9,
        margin: [0, 0, 0, 8]
      });
    }

    // ---- VERKEHRSRÄUMLICHER KONTEXT (#C4) ----
    if (sd && sd.osmContext && sd.osmContext.summary) {
      const oc = sd.osmContext;
      const s = oc.summary;
      docDefinition.content.push({ text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)", style: "subheader" });
      const ocBody = [];
      if (s.dominantMaxspeed != null) {
        ocBody.push([
          { text: "Vorherrschendes Tempolimit", bold: true, fontSize: 10 },
          { text: `${s.dominantMaxspeed} km/h (n=${s.speedSampleSize} Wegabschnitte)`, fontSize: 10 }
        ]);
      }
      ocBody.push([
        { text: "Radverkehrsanlagen", bold: true, fontSize: 10 },
        { text: s.cycleInfraWays > 0
            ? `${s.cycleInfraWays} Wegabschnitte mit Radinfrastruktur` + (s.cycleInfraShare != null ? ` (${Math.round(s.cycleInfraShare * 100)} % der Hauptachsen)` : "")
            : "keine separaten Radverkehrsanlagen erkannt", fontSize: 10 }
      ]);
      ocBody.push([
        { text: "Knoten / Querungen", bold: true, fontSize: 10 },
        { text: `${s.trafficSignals} signalisierte Knoten · ${s.crossings} markierte Querungen`, fontSize: 10 }
      ]);
      if (s.avgLanes != null) {
        ocBody.push([
          { text: "Ø Fahrstreifen", bold: true, fontSize: 10 },
          { text: `${s.avgLanes.toFixed(1)} (n=${s.lanesSampleSize})`, fontSize: 10 }
        ]);
      }
      if (s.avgWidthMeters != null) {
        ocBody.push([
          { text: "Ø Fahrbahnbreite", bold: true, fontSize: 10 },
          { text: `${s.avgWidthMeters.toFixed(1)} m (n=${s.widthSampleSize})`, fontSize: 10 }
        ]);
      }
      docDefinition.content.push({
        table: { widths: ["auto", "*"], body: ocBody },
        layout: "lightHorizontalLines",
        margin: [0, 4, 0, 4]
      });
      docDefinition.content.push({
        text: `Quelle: ${oc.source.publisher} (${oc.source.license}), via ${oc.source.retrievedVia}.`,
        italics: true,
        fontSize: 9,
        margin: [0, 0, 0, 4]
      });
      // Task 8 – analytische OSM-Schlussfolgerungen.
      if (Array.isArray(sd.osmInsights) && sd.osmInsights.length > 0) {
        docDefinition.content.push({ text: "OSM-Schlussfolgerungen:", bold: true, margin: [0, 4, 0, 2] });
        for (const s of sd.osmInsights) {
          docDefinition.content.push({ text: "• " + s, margin: [0, 0, 0, 2] });
        }
        docDefinition.content.push({ text: "", margin: [0, 0, 0, 6] });
      }
    } else if (sd && sd.osmContext && sd.osmContext.quality && sd.osmContext.quality.error) {
      docDefinition.content.push({ text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)", style: "subheader" });
      docDefinition.content.push({
        // QA-PR „Export-Semantik": verwaltungstauglicher Hinweis statt
        // technischer Fehlerstring.
        text: "OSM-Kontextdaten konnten beim Export nicht geladen werden.",
        italics: true,
        fontSize: 9,
        margin: [0, 0, 0, 8]
      });
    }

    // ---- BESCHLUSSVORSCHLAG section (Wortlaut, Wiederholung) ----
    // Siehe DOCX-Export: durch sectionGuard wird hier nicht erneut
    // gerendert, wenn der Antrag bereits oben am Dokument steht.
    if (!sectionGuard("BESCHLUSSVORSCHLAG")) {
      docDefinition.content.push({
        text: "BESCHLUSSVORSCHLAG",
        style: "subheader"
      });

      const beschlussSection = extractSection(textLines, "Beschlussvorschlag:");
      if (beschlussSection.length > 0) {
        for (const line of beschlussSection) {
          const content = textWithLinks(line);
          docDefinition.content.push({
            text: content,
            style: "normal"
          });
        }
      } else {
        docDefinition.content.push({
          text: "Der Bezirksrat fordert die Verwaltung auf, innerhalb von 3 Monaten den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen. Die Wirksamkeit der Maßnahmen ist nach 12 Monaten anhand der Unfallatlas-Daten zu evaluieren.",
          style: "normal"
        });
      }
    }

    // ---- FACHLICHE BEZÜGE section (if enabled) ----
    if (options.includeReferences) {
      const refs = sd && sd.references;
      const refsSection = extractSection(textLines, "Bezugsdokumente:");
      if ((refs && refs.documents && refs.documents.length > 0) || refsSection.length > 0) {
        docDefinition.content.push({
          text: "FACHLICHE BEZÜGE",
          style: "subheader"
        });

        if (refs && refs.documents && refs.documents.length > 0) {
          for (const doc of refs.documents) {
            const title = doc.title || "Ohne Titel";
            const meta = [doc.author, doc.date].filter(Boolean).join(", ");
            docDefinition.content.push({
              text: meta ? `- ${title} (${meta})` : `- ${title}`,
              style: "normal"
            });
            if (doc.url) {
              docDefinition.content.push(textWithLinks(doc.url) !== doc.url
                ? { text: textWithLinks(`  ${doc.url}`), style: "normal" }
                : { text: `  ${doc.url}`, style: "normal" });
            }
          }
        } else {
          for (const line of refsSection) {
            const content = textWithLinks(line);
            docDefinition.content.push({
              text: content,
              style: "normal"
            });
          }
        }
      }
    }

    // ---- ANLAGEN block (feature parity with Word export) ----
    // Layout-PR „Vor Anlagen Seitenumbruch": Anlagen beginnen auf
    // einer neuen Seite — sonst klebt der Anhang optisch am Fließtext
    // der Begründung.
    docDefinition.content.push({
      text: "ANLAGEN",
      style: "subheader",
      pageBreak: "before"
    });
    docDefinition.content.push({ text: "Anlage 1: Kartenansicht", style: "normal" });
    docDefinition.content.push({ text: "Anlage 2: Statistische Übersicht", style: "normal" });
    docDefinition.content.push({ text: "Anlage 3: Fachliche Bezüge", style: "normal" });

    // ---- DATENQUELLE section ----
    docDefinition.content.push({
      text: "DATENQUELLE",
      style: "subheader"
    });

    docDefinition.content.push({
      text: "Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).",
      style: "normal"
    });

    // Generate and download PDF
    const citySlug = CITY_RAW
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const titleSlug = docTitle
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const filename = `${titleSlug}_${citySlug}_${today.replace(/\./g, "-")}.pdf`;

    // QA-PR „Export-Semantik vor Layout" — Pre-flight-Gate über den
    // sichtbaren docDefinition-Text. Bricht den Export ab, falls noch
    // Beteiligten-Emojis, FontAwesome-Glyphen, „Fetch is aborted",
    // „Beteiligungsmaske", „Scope" usw. im sichtbaren Output stehen.
    // Akzeptanzkriterium: das erzeugte PDF wirkt wie ein Verwaltungs-
    // dokument und nicht wie ein UI-Dump.
    if (!options || options._skipQAGate !== true) {
      const gate = runExportQAGate(docDefinition.content);
      if (!gate.ok) {
        const head = gate.violations.slice(0, 3).map(v => v.reason).join(" | ");
        const more = gate.violations.length > 3 ? ` (+${gate.violations.length - 3} weitere)` : "";
        const msg = `Export abgebrochen: PDF-Inhalt enthält noch nicht-verwaltungstaugliche Tokens — ${head}${more}.`;
        // Banner für UI-Sichtbarkeit, falls vorhanden.
        try {
          const bar = (typeof document !== "undefined") ? document.getElementById("exportProgress") : null;
          if (bar) { bar.textContent = msg; bar.style.display = "block"; }
        } catch (_) { /* DOM nicht verfügbar (Tests) → still */ }
        const err = new Error(msg);
        err.qaViolations = gate.violations;
        throw err;
      }
    }

    window.pdfMake.createPdf(docDefinition).download(filename);
  };

  // =====================================================================
  // Helper functions
  // =====================================================================

  /**
   * Extract a section from text lines
   * @param {Array<string>} lines - Text lines
   * @param {string} sectionHeader - Section header to look for
   * @param {Array<string>} [stopSections] - Optional array of section headers to stop at
   * @returns {Array<string>} Section lines
   */
  function extractSection(lines, sectionHeader, stopSections) {
    const result = [];
    let inSection = false;

    // Default stop sections cover every post-Sachverhalt block header
    // emitted by the TEXT renderer in js/ua.export_v2.js — see
    // POST_SACHVERHALT_STOP_HEADERS for rationale and the regression
    // assertion in tests/unit/ua.report_v2.pdfQA.test.js.
    const stopPatterns = stopSections || POST_SACHVERHALT_STOP_HEADERS;
    
    for (const line of lines) {
      if (line.includes(sectionHeader)) {
        inSection = true;
        continue;
      }
      
      if (inSection) {
        // Stop at next major section (check if line starts with any stop pattern)
        const trimmedLine = line.trim();
        const shouldStop = stopPatterns.some(pattern => trimmedLine.startsWith(pattern));
        if (shouldStop) {
          break;
        }
        
        if (line.trim()) {
          result.push(line);
        }
      }
    }
    
    return result;
  }

  /**
   * Initialize export UI bindings for Word/PDF
   * @param {Object} ctx - Application context
   */
  UA.initReportExportUI = function initReportExportUI(ctx) {
    const btnExportWord = document.getElementById("btnExportWord");
    const btnExportPDF = document.getElementById("btnExportPDF");
    const cbIncludeMap = document.getElementById("cbIncludeMap");
    const cbIncludePOIs = document.getElementById("cbIncludePOIs");
    const cbIncludeRefs = document.getElementById("cbIncludeRefs");
    const cbIncludeCosts = document.getElementById("cbIncludeCosts");
    const cbIncludeMeasures = document.getElementById("cbIncludeMeasures");
    const heatExportOpacityEl = document.getElementById("heatExportOpacity");
    const exportProgress = document.getElementById("exportProgress");
    const heatExportOpacityValEl = document.getElementById("heatExportOpacityVal");

    if (!btnExportWord || !btnExportPDF || !exportProgress) {
      console.warn("Export buttons or progress element not found in DOM");
      return;
    }

    // Wire up slider label update (avoids inline oninput in HTML)
    if (heatExportOpacityEl && heatExportOpacityValEl) {
      heatExportOpacityEl.addEventListener("input", function () {
        heatExportOpacityValEl.textContent = heatExportOpacityEl.value + " %";
      });
    }

    /**
     * Attach a generic export handler to a button.
     *
     * @param {HTMLButtonElement} button - The button to bind the handler to.
     * @param {string} inProgressText - Message shown while export is running.
     * @param {string} successText - Message shown when export succeeds.
     * @param {string} consoleErrorPrefix - Prefix for console error logging.
     * @param {string} alertErrorPrefix - Prefix for alert error message.
     * @param {Function} exportFn - Export function (e.g., UA.exportToWord/PDF).
     */
    function attachExportHandler(
      button,
      inProgressText,
      successText,
      consoleErrorPrefix,
      alertErrorPrefix,
      exportFn
    ) {
      button.addEventListener("click", async () => {
        // Collect all export buttons so both can be disabled during load/export
        const allExportButtons = [btnExportWord, btnExportPDF].filter(Boolean);
        function setButtonsDisabled(disabled) {
          allExportButtons.forEach((btn) => {
            btn.style.opacity = disabled ? "0.6" : "1";
            btn.style.cursor = disabled ? "not-allowed" : "pointer";
            btn.disabled = disabled;
          });
        }
        try {
          exportProgress.textContent = "Lade Export-Bibliotheken...";
          setButtonsDisabled(true);

          // Ensure libraries are loaded (with per-library progress indication).
          // Concurrent clicks share the same in-flight Promise via UA._exportLibrariesLoading.
          await UA.ensureExportLibraries(function(msg) {
            exportProgress.textContent = msg;
          });
          
          exportProgress.textContent = inProgressText;

          // Get current report data. Pass cost/measures opt-out via ctx so
          // computeExportReport can honour the modal toggles when building
          // the text/HTML/structured payload (default: include both).
          ctx.exportOptions = Object.assign({}, ctx.exportOptions, {
            includeCosts:    cbIncludeCosts    ? cbIncludeCosts.checked    : true,
            includeMeasures: cbIncludeMeasures ? cbIncludeMeasures.checked : true
          });
          const reportData = await UA.computeExportReport(ctx);

          // Pre-Flight-Konsistenz-Gate (Phase 2.2):
          //  - Invariante 1 (table_exceeds_total): echter Logik-Bug
          //    (Tabelle behauptet mehr Zeilen als die Gesamt-Fallzahl) →
          //    Export wird abgebrochen.
          //  - Invariante 2 (table_map_mismatch): „Tabelle vs. Karte" sind
          //    aktuell aus *unterschiedlichen* Filterpfaden zusammengesetzt
          //    (accidentDetails wendet aktuell den Involvement-Filter nicht
          //    an, viewportPts schon). Eine Abweichung ist daher in der
          //    Praxis erwartbar und KEIN Grund den Export zu blockieren —
          //    sie wird als Warnung im Banner und in der Konsole angezeigt,
          //    der Export läuft regulär weiter.
          if (typeof UA.validateExportConsistency === "function") {
            const consistency = UA.validateExportConsistency(ctx, reportData && reportData.structured);
            if (consistency && consistency.ok === false) {
              if (consistency.kind === "table_exceeds_total") {
                exportProgress.textContent = consistency.message;
                alert(consistency.message);
                setButtonsDisabled(false);
                return;
              }
              // table_map_mismatch → soft warning, do not abort the export.
              console.warn("[Pre-Flight]", consistency.message);
              exportProgress.textContent = `Hinweis: ${consistency.message}`;
            }
          }

          // Get export options
          const rawPct = heatExportOpacityEl ? parseInt(heatExportOpacityEl.value, 10) : 40;
          const heatOpacityPct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 40;
          const options = {
            includeMap: cbIncludeMap ? cbIncludeMap.checked : true,
            includePOIs: cbIncludePOIs ? cbIncludePOIs.checked : true,
            includeReferences: cbIncludeRefs ? cbIncludeRefs.checked : true,
            includeCosts:    cbIncludeCosts    ? cbIncludeCosts.checked    : true,
            includeMeasures: cbIncludeMeasures ? cbIncludeMeasures.checked : true,
            heatmapExportOpacity: heatOpacityPct / 100
          };

          await exportFn(ctx, reportData, options);

          exportProgress.textContent = successText;
        } catch (e) {
          console.error(consoleErrorPrefix, e);
          exportProgress.textContent = `Fehler: ${e.message}`;
          alert(alertErrorPrefix + e.message);
        } finally {
          setButtonsDisabled(false);
        }
      });
    }

    // Word export handler
    attachExportHandler(
      btnExportWord,
      "Word-Dokument wird erstellt...",
      "Word-Dokument erfolgreich erstellt.",
      "Word export failed:",
      "Word-Export fehlgeschlagen: ",
      UA.exportToWord
    );

    // PDF export handler
    attachExportHandler(
      btnExportPDF,
      "PDF wird erstellt...",
      "PDF erfolgreich erstellt.",
      "PDF export failed:",
      "PDF-Export fehlgeschlagen: ",
      UA.exportToPDF
    );
  };

})();
