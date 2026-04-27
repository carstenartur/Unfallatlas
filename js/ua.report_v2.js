(() => {
  const UA = (window.UA = window.UA || {});

  // Initialize export libraries loaded flag
  UA._exportLibrariesLoaded = false;

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
      script.crossOrigin = 'anonymous';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`Failed to load script: ${src}`));
      document.head.appendChild(script);
    });
  }

  /**
   * Ensure export libraries are loaded
   * @returns {Promise<void>}
   */
  UA.ensureExportLibraries = async function ensureExportLibraries() {
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
    
    try {
      // NOTE: Keep CDN versions in sync with package.json and tests/e2e/werkbank.spec.js setupCDNRoutes().
      // docx@9.x uses dist/index.iife.js (IIFE format); docx@8.x used build/index.umd.js.
      await Promise.all([
        loadScript('https://unpkg.com/docx@9.6.1/dist/index.iife.js', 'docx'),
        loadScript('https://unpkg.com/pdfmake@0.3.7/build/pdfmake.min.js', 'pdfMake'),
        loadScript('https://unpkg.com/file-saver@2.0.5/dist/FileSaver.min.js', 'saveAs')
      ]);
      
      // Load vfs_fonts after pdfMake
      if (window.pdfMake && !window.pdfMake.vfs) {
        await loadScript('https://unpkg.com/pdfmake@0.3.7/build/vfs_fonts.js', null);
      }
      
      UA._exportLibrariesLoaded = true;
    } catch (e) {
      console.error('Failed to load export libraries:', e);
      throw new Error('Export-Bibliotheken konnten nicht geladen werden. Bitte Seite neu laden.');
    }
  };

  // =====================================================================
  // Map Image Export (programmatic, using leaflet-image)
  // =====================================================================

  // Delay (in milliseconds) to wait for map tiles to load before capture
  const MAP_CAPTURE_DELAY_MS = 100;

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

          try {
            // Use leaflet-image to capture the map with all layers and styling
            window.leafletImage(ctx.map, (err, canvas) => {
              // Restore original heat canvas pixels as soon as capture is done
              restoreHeat();

              if (err) {
                console.error("leaflet-image capture error:", err);
                reject(err);
                return;
              }

              try {
                // Convert canvas to base64 data URL (PNG format preserves transparency)
                const dataUrl = canvas.toDataURL("image/png");
                
                // Verify the data URL is valid
                if (!dataUrl || !dataUrl.startsWith("data:image/png;base64,")) {
                  reject(new Error("Invalid map image data URL generated"));
                  return;
                }
                
                resolve(dataUrl);
              } catch (e) {
                console.error("Canvas to data URL conversion error:", e);
                reject(e);
              }
            });
          } catch (e) {
            restoreHeat();
            console.error("leafletImage call error:", e);
            reject(e);
          }
        }, MAP_CAPTURE_DELAY_MS); // Small delay to ensure tiles are loaded
      } catch (e) {
        console.error("captureMapImage error:", e);
        reject(e);
      }
    });
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

      const imageData = await UA.captureMapImage(ctx, options);
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

    // Helper: shared cell border style
    const cellBorder = {
      top:    { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      left:   { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" },
      right:  { style: BorderStyle.SINGLE, size: 1, color: "AAAAAA" }
    };

    // Helper: build a table cell containing plain text
    function textCell(text, bold) {
      return new TableCell({
        borders: cellBorder,
        children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ""), bold })] })]
      });
    }

    // Helper: build a table cell containing a clickable hyperlink
    function linkCell(url) {
      const link = ExternalHyperlink
        ? new ExternalHyperlink({
            link: url,
            children: [new TextRun({ text: url, style: "Hyperlink" })]
          })
        : new TextRun({ text: url });
      return new TableCell({
        borders: cellBorder,
        children: [new Paragraph({ children: [link] })]
      });
    }

    // Helper to build a simple bordered table from headers + rows (plain text cells)
    // Optional: rowHighlights is an array of booleans – true = highlight that data row
    function makeDocxTable(headers, dataRows, rowHighlights) {
      const makeRow = (cells, bold, highlight) =>
        new TableRow({
          children: cells.map(text => {
            const cell = new TableCell({
              borders: cellBorder,
              children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ""), bold })] })],
              ...(highlight ? { shading: { fill: "FFFFCC" } } : {})
            });
            return cell;
          })
        });
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          makeRow(headers, true, false),
          ...dataRows.map((row, i) => makeRow(row, false, rowHighlights ? rowHighlights[i] : false))
        ]
      });
    }

    // Helper to build a 2-column key/value table where the value cell may be a hyperlink
    function makeKVTable(rows) {
      return new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: rows.map(([key, value, isLink]) =>
          new TableRow({
            children: [
              textCell(key, true),
              isLink ? linkCell(value) : textCell(value, false)
            ]
          })
        )
      });
    }

    const children = [];
    const textLines = reportData.text ? reportData.text.split("\n") : [];

    // Use structured data if available (preferred path), else fall back to text parsing
    const sd = reportData.structured || null;

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
      metaLink              ? ["Werkbank-Link",         metaLink,              IS_LINK] : null,
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
    const filters = (sd && sd.meta && sd.meta.filters) || {};
    const filterRows = [];

    if (filters.severity   != null) filterRows.push(["Schweregrad",       String(filters.severity),        false]);
    if (filters.roadCondition != null) filterRows.push(["Fahrbahnzustand", String(filters.roadCondition),  false]);
    if (filters.involvementMode != null) filterRows.push(["Beteiligungsmodus", String(filters.involvementMode), false]);

    // Build participation flags label
    const partLabels = [];
    if (filters.includeCyclist)    partLabels.push("🚲 Rad");
    if (filters.includePedestrian) partLabels.push("🚶 Fuß");
    if (filters.includeCar)        partLabels.push("🚗 PKW");
    if (filters.includeMotorcycle) partLabels.push("🏍️ Krad");
    if (filters.includeGkfz)       partLabels.push("🚛 Gkfz");
    if (filters.includeSonstig)    partLabels.push("🚌 Sonst.");
    if (partLabels.length > 0) filterRows.push(["Beteiligte", partLabels.join(", "), false]);

    if (filters.hourFrom != null && filters.hourTo != null) {
      filterRows.push(["Zeitraum", `${filters.hourFrom}:00–${filters.hourTo}:00 Uhr`, false]);
    }
    if (filters.dayType != null) filterRows.push(["Wochentag", String(filters.dayType), false]);

    if (filterRows.length > 0) {
      children.push(new Paragraph({
        text: "Aktive Filter",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 200, after: 100 }
      }));
      children.push(makeKVTable(filterRows));
      children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
    }

    // ---- 5. SACHVERHALT section ----
    children.push(
      new Paragraph({
        text: "SACHVERHALT",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      })
    );

    // Parse the text report to extract the SACHVERHALT section using helper
    const sachverhaltSection = extractSection(
      textLines,
      "Sachverhalt:",
      ["Auffälligkeiten:", "POI-Analyse", "Bezugsdokumente:", "Beschlussvorschlag:"]
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
    if (sd) {
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
        children.push(new Paragraph({ text: "Top-Abweichungen (Ausschnitt vs. Stadt):", spacing: { after: 100 } }));
        const devRows = sd.deviations.focus.map(r => {
          const locPct = sd.deviations.local.total ? ((r.locR) * 100).toFixed(1).replace(".", ",") + " %" : "0,0 %";
          const basePct = ((r.baseR) * 100).toFixed(1).replace(".", ",") + " %";
          const ciLowPct = r.ciLow != null ? (r.ciLow * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const ciHighPct = r.ciHigh != null ? (r.ciHigh * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const factorStr = r.factor.toFixed(2) + "×" + (r.isSignificant === false ? " (n.s.)" : "");
          return [r.label, String(r.locCnt), locPct, basePct, factorStr, `[${ciLowPct} – ${ciHighPct}]`];
        });
        children.push(makeDocxTable(
          ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor", "95%-KI (lokaler Anteil)"],
          devRows
        ));
        const allNonSig = sd.deviations.focus.every(r => r.isSignificant === false);
        if (allNonSig) {
          children.push(new Paragraph({
            text: "Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (95%-KI schließt Stadtwert ein). Faktor-Werte bei kleinen Fallzahlen mit Vorsicht interpretieren.",
            spacing: { after: 100 }
          }));
        }
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Year table
      if (sd.yearTable && sd.yearTable.length > 0) {
        children.push(new Paragraph({ text: "Unfälle pro Jahr im Ausschnitt:", spacing: { after: 100 } }));
        const yrRows = sd.yearTable.map(row => [
          String(row.year),
          String(row.total),
          row.classes.length ? row.classes.join(", ") : "—"
        ]);
        children.push(makeDocxTable(
          ["Jahr", "Summe", "Kombinationen"],
          yrRows
        ));
        children.push(new Paragraph({ text: "", spacing: { after: 200 } }));
      }

      // Cross-table: Beteiligungskombination × Schweregrad
      if (sd.crossTable && sd.crossTable.rows && sd.crossTable.rows.length > 0) {
        children.push(new Paragraph({ text: "Beteiligungskombination × Schweregrad:", spacing: { after: 100 } }));
        const ctRows = sd.crossTable.rows.map(r => [
          r.label, String(r.sev1), String(r.sev2), String(r.sev3), String(r.total)
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

      // Recommended measures (PR-D / B1+B3)
      if (options.includeMeasures !== false && UA.hasRecommendationsOrFiltered
          && UA.hasRecommendationsOrFiltered(sd.recommendedMeasures)) {
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
                text: h.text || "",
                bold: !!h.bold,
                spacing: { before: 200, after: 100 }
              }));
            }
          } else if (g.sevLabel) {
            // Back-compat: synthesize a header for plain { sevLabel, histogram } groups
            const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
            children.push(new Paragraph({
              text: headerText,
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
          children.push(makeDocxTable(cols, detailRows));
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
          detailRows
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

        const mapImageData = await UA.captureMapImage(ctx, options);
        
        // Remove data URL prefix to get raw base64 (leaflet-image produces PNG)
        const base64Data = mapImageData.replace(/^data:image\/png;base64,/, "");

        let binaryString;
        try {
          binaryString = atob(base64Data);
        } catch (decodeError) {
          console.error("Failed to decode base64 map image data:", decodeError);
          throw new Error("Kartenbild konnte nicht dekodiert werden: ungültige Base64-Bilddaten");
        }

        children.push(
          new Paragraph({
            children: [
              new ImageRun({
                data: Uint8Array.from(binaryString, c => c.charCodeAt(0)),
                transformation: {
                  width: 600,
                  height: 400
                }
              })
            ],
            spacing: { after: 200 }
          })
        );

        const legendText =
          ctx && typeof ctx.t === "function"
            ? ctx.t("report.map.legend")
            : "Legende: Darstellung entsprechend der aktuellen Kartendarstellung.";

        children.push(
          new Paragraph({
            text: legendText,
            italics: true,
            spacing: { after: 200 }
          })
        );

        // Detail map: zoom to selection bounds if available
        if (ctx.selectionBounds) {
          try {
            const detailImageData = await captureDetailMap(ctx, options);
            const detailBase64 = detailImageData.replace(/^data:image\/png;base64,/, "");
            let detailBinary;
            try {
              detailBinary = atob(detailBase64);
            } catch (e2) {
              throw new Error("Detailkartenbild konnte nicht dekodiert werden");
            }
            children.push(new Paragraph({
              text: "Detailansicht – markierter Bereich",
              heading: HeadingLevel.HEADING_3,
              spacing: { before: 200, after: 100 }
            }));
            children.push(new Paragraph({
              children: [new ImageRun({
                data: Uint8Array.from(detailBinary, c => c.charCodeAt(0)),
                transformation: { width: 600, height: 400 }
              })],
              spacing: { after: 200 }
            }));
          } catch (detailErr) {
            console.warn("Detail map capture failed (graceful fallback):", detailErr);
          }
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
    if (sd && sd.yearlyTrend && Array.isArray(sd.yearlyTrend.years) && sd.yearlyTrend.years.length > 0) {
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
        spacing: { before: 100, after: 200 }
      }));
    } else if (sd && sd.osmContext && sd.osmContext.quality && sd.osmContext.quality.error) {
      children.push(new Paragraph({
        text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)",
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 400, after: 200 }
      }));
      children.push(new Paragraph({
        children: [new TextRun({ text: `Nicht verfügbar (${sd.osmContext.quality.error}).`, italics: true })],
        spacing: { after: 200 }
      }));
    }

    // ---- 9. BESCHLUSSVORSCHLAG section ----
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
          text: "Der Bezirksrat bittet die Verwaltung, den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen.",
          spacing: { after: 200 }
        })
      );
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
    children.push(new Paragraph({
      text: "ANLAGEN",
      heading: HeadingLevel.HEADING_2,
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
  function buildWerkbankUrl(ctx) {
    const params = new URLSearchParams();
    
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
    
    // Map position
    if (ctx.map) {
      const center = ctx.map.getCenter();
      const zoom = ctx.map.getZoom();
      params.set("centerLat", center.lat.toFixed(6));
      params.set("centerLon", center.lng.toFixed(6));
      params.set("zoom", zoom);
    }
    
    // Selection bounds
    if (ctx.selectionBounds) {
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
   * Replace emoji icons with text labels for PDF compatibility.
   * pdfMake's default Roboto font doesn't support emoji glyphs; for plain
   * `text` cells (and the textual report fallback) we substitute readable
   * short labels. For *table cells* that carry involvement icons we use the
   * richer `pdfInvolvementCell` helper below, which embeds inline SVG icons
   * so the symbols are visually preserved in the exported PDF.
   * @param {string} text - Text containing emoji icons
   * @returns {string} Text with emojis replaced by readable labels
   */
  function replaceEmojisForPDF(text) {
    return text
      .replace(/\u{1F6B2}/gu, "[Rad]")      // 🚲 Bicycle
      .replace(/\u{1F6B6}/gu, "[Fuss]")     // 🚶 Pedestrian
      .replace(/\u{1F697}/gu, "[PKW]")      // 🚗 Car
      .replace(/\u{1F3CD}[\u{FE0F}]?/gu, "[Krad]")  // 🏍 Motorcycle (optional variation selector)
      .replace(/\u{1F69B}/gu, "[Gkfz]")    // 🚛 Heavy vehicle
      .replace(/\u{1F68C}/gu, "[Sonst]");   // 🚌 Other (bus)
  }

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
        return {
          text: String(cell ?? ""),
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

    // Helper: determine if a cross-table row mask matches the active filter (for PDF)
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
      metaLink             ? ["Werkbank-Link",         metaLink]             : null,
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
    const filters = (sd && sd.meta && sd.meta.filters) || {};
    const filterRows = [];
    if (filters.severity      != null) filterRows.push(["Schweregrad",       String(filters.severity)]);
    if (filters.roadCondition != null) filterRows.push(["Fahrbahnzustand",   String(filters.roadCondition)]);
    if (filters.involvementMode != null) filterRows.push(["Beteiligungsmodus", String(filters.involvementMode)]);

    // Render the active "Beteiligte" line with real icons (one cell per active
    // category) instead of the legacy "[Rad], [PKW]" text fallback.
    const partEmojis = [];
    if (filters.includeCyclist)    partEmojis.push("\u{1F6B2}");
    if (filters.includePedestrian) partEmojis.push("\u{1F6B6}");
    if (filters.includeCar)        partEmojis.push("\u{1F697}");
    if (filters.includeMotorcycle) partEmojis.push("\u{1F3CD}");
    if (filters.includeGkfz)       partEmojis.push("\u{1F69B}");
    if (filters.includeSonstig)    partEmojis.push("\u{1F68C}");
    if (partEmojis.length > 0) {
      filterRows.push(["Beteiligte", pdfInvolvementCell(partEmojis.join("+"))]);
    }

    if (filters.hourFrom != null && filters.hourTo != null) {
      filterRows.push(["Zeitraum", `${filters.hourFrom}:00-${filters.hourTo}:00 Uhr`]);
    }
    if (filters.dayType != null) filterRows.push(["Wochentag", String(filters.dayType)]);

    if (filterRows.length > 0) {
      docDefinition.content.push({ text: "Aktive Filter", style: "subheader" });
      docDefinition.content.push(makePdfTable(
        ["Filter", "Wert"],
        filterRows,
        undefined,
        { widths: ["auto", "*"] }
      ));
    }

    // ---- SACHVERHALT section ----
    docDefinition.content.push({
      text: "SACHVERHALT",
      style: "subheader",
      pageBreak: undefined
    });

    const sachverhaltSection = extractSection(textLines, "Sachverhalt:");
    if (sachverhaltSection.length > 0) {
      for (const line of sachverhaltSection) {
        if (line.includes("Auffälligkeiten:") || line.includes("POI-Analyse") || line.includes("Bezugsdokumente:")) {
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
    if (sd) {
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

      // Deviations table — parity with DOCX/HTML: 95%-KI + n.s.-Hinweis
      if (sd.deviations && sd.deviations.focus && sd.deviations.focus.length > 0) {
        docDefinition.content.push({ text: "Top-Abweichungen (Ausschnitt vs. Stadt):", style: "normal" });
        const devRows = sd.deviations.focus.map(r => {
          const locPct = ((r.locR) * 100).toFixed(1).replace(".", ",") + " %";
          const basePct = ((r.baseR) * 100).toFixed(1).replace(".", ",") + " %";
          const ciLowPct  = r.ciLow  != null ? (r.ciLow  * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const ciHighPct = r.ciHigh != null ? (r.ciHigh * 100).toFixed(1).replace(".", ",") + " %" : "—";
          const factorStr = r.factor.toFixed(2) + "x" + (r.isSignificant === false ? " (n.s.)" : "");
          return [pdfInvolvementCell(r.label), String(r.locCnt), locPct, basePct, factorStr, `[${ciLowPct} – ${ciHighPct}]`];
        });
        // Explicit widths: pattern column gets the slack (*), narrow numeric
        // columns are sized to their content so the table stops overflowing
        // on narrower viewports/pageSizes.
        docDefinition.content.push(makePdfTable(
          ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor", "95%-KI (lokaler Anteil)"],
          devRows,
          undefined,
          { widths: ["*", "auto", "auto", "auto", "auto", "auto"] }
        ));
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

      // Year table
      if (sd.yearTable && sd.yearTable.length > 0) {
        docDefinition.content.push({ text: "Unfälle pro Jahr im Ausschnitt:", style: "normal" });
        const yrRows = sd.yearTable.map(row => [
          String(row.year),
          String(row.total),
          row.classes.length ? pdfInvolvementCell(row.classes.join(", ")) : "—"
        ]);
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
        const ctRows = sd.crossTable.rows.map(r => [
          pdfInvolvementCell(r.label), String(r.sev1), String(r.sev2), String(r.sev3), String(r.total)
        ]);
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

      // Recommended measures (PR-D / B1+B3)
      if (options.includeMeasures !== false && UA.hasRecommendationsOrFiltered
          && UA.hasRecommendationsOrFiltered(sd.recommendedMeasures)) {
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
              docDefinition.content.push({ text: h.text || "", bold: !!h.bold, margin: [0, 8, 0, 4] });
            }
          } else if (g.sevLabel) {
            const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
            docDefinition.content.push({ text: headerText, bold: true, margin: [0, 8, 0, 4] });
          }
          const detailRows = g.rows.map((r, i) => {
            // Use the strategy's docx row producer (same column shape as DOCX).
            // For PDF we keep the cell contents but route emoji-bearing strings
            // through pdfInvolvementCell so the icons render as real SVG
            // pictograms instead of being lost to the Roboto font.
            let cells;
            if (view && view.renderRow && view.renderRow.docx) {
              cells = view.renderRow.docx(r, i);
            } else {
              const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
              const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
              cells = [String(i + 1), String(r.year ?? "—"), r.involved, hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
            }
            // Promote any string cell that carries involvement emojis to a rich
            // SVG-based content node; non-string (already rich) cells pass
            // through unchanged. Strings without emojis remain plain strings.
            return cells.map(c => typeof c === "string" ? pdfInvolvementCell(c) : c);
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
        // Fallback for legacy data without groups
        docDefinition.content.push({ text: "EINZELUNFÄLLE IM BEREICH", style: "subheader" });
        const detailRows = sd.accidentDetails.rows.map((r, i) => {
          const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
          const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
          return [String(i + 1), String(r.year ?? "—"), r.sevLabel, pdfInvolvementCell(r.involved), hour, (typeof UA !== "undefined" && UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—")), r.roadCondition || "—", coords];
        });
        docDefinition.content.push(makePdfTable(
          ["#", "Jahr", "Schwere", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"],
          detailRows,
          undefined,
          // 8-column legacy layout: same width strategy with one extra "auto"
          // column for the explicit Schwere label.
          { widths: ["auto", "auto", "auto", "*", "auto", "auto", "auto", "auto"], fontSize: 8 }
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
          style: "subheader"
        });

        const mapImageData = await UA.captureMapImage(ctx, options);
        const werkbankUrl = buildWerkbankUrl(ctx);

        // Calculate image dimensions: constrain to A4 content area (475pt wide, ~650pt tall)
        const PDF_MAX_IMG_WIDTH = 475;
        const PDF_MAX_IMG_HEIGHT = 650;
        // Make map image clickable
        docDefinition.content.push({
          image: mapImageData,
          fit: [PDF_MAX_IMG_WIDTH, PDF_MAX_IMG_HEIGHT],
          margin: [0, 10, 0, 10],
          link: werkbankUrl
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
            "Farben: rot=Tote, orange=Schwerverletzte, gelb=Leichtverletzte.\n",
            "Kategorien: [Rad]=Fahrrad, [Fuss]=Fußgänger, [PKW]=PKW, [Krad]=Motorrad, [Gkfz]=Lkw, [Sonst]=Sonstige.\n",
            "POIs wie Schulen und Kitas sind hervorgehoben."
          ].join(""),
          style: "small"
        });

        // Detail map: zoom to selection bounds if available
        if (ctx.selectionBounds) {
          try {
            const detailImageData = await captureDetailMap(ctx, options);
            const detailWerkbankUrl = buildWerkbankUrl(ctx);
            docDefinition.content.push({ text: "Detailansicht – markierter Bereich", style: "subheader" });
            docDefinition.content.push({
              image: detailImageData,
              fit: [475, 350],
              margin: [0, 10, 0, 10],
              link: detailWerkbankUrl
            });
            docDefinition.content.push({
              text: "→ In Werkbank öffnen",
              link: detailWerkbankUrl,
              color: "blue",
              decoration: "underline",
              style: "normal",
              margin: [0, 5, 0, 10]
            });
          } catch (detailErr) {
            console.warn("Detail map capture failed for PDF (graceful fallback):", detailErr);
          }
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
    if (sd && sd.yearlyTrend && Array.isArray(sd.yearlyTrend.years) && sd.yearlyTrend.years.length > 0) {
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
        margin: [0, 0, 0, 8]
      });
    } else if (sd && sd.osmContext && sd.osmContext.quality && sd.osmContext.quality.error) {
      docDefinition.content.push({ text: "VERKEHRSRÄUMLICHER KONTEXT (OSM)", style: "subheader" });
      docDefinition.content.push({
        text: `Nicht verfügbar (${sd.osmContext.quality.error}).`,
        italics: true,
        fontSize: 9,
        margin: [0, 0, 0, 8]
      });
    }

    // ---- BESCHLUSSVORSCHLAG section ----
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
        text: "Der Bezirksrat bittet die Verwaltung, den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen.",
        style: "normal"
      });
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
    docDefinition.content.push({
      text: "ANLAGEN",
      style: "subheader"
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
    
    // Default stop sections if none provided
    const defaultStopSections = [
      "Sachverhalt:",
      "Auffälligkeiten:",
      "POI-Analyse",
      "Bezugsdokumente:",
      "Beschlussvorschlag:",
      "Hinweis (intern)",
      "Datenquelle"
    ];
    
    const stopPatterns = stopSections || defaultStopSections;
    
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
        try {
          exportProgress.textContent = "Lade Export-Bibliotheken...";
          button.style.opacity = "0.6";
          button.style.cursor = "not-allowed";
          button.disabled = true;

          // Ensure libraries are loaded (with progress indication)
          await UA.ensureExportLibraries();
          
          exportProgress.textContent = inProgressText;

          // Get current report data. Pass cost/measures opt-out via ctx so
          // computeExportReport can honour the modal toggles when building
          // the text/HTML/structured payload (default: include both).
          ctx.exportOptions = Object.assign({}, ctx.exportOptions, {
            includeCosts:    cbIncludeCosts    ? cbIncludeCosts.checked    : true,
            includeMeasures: cbIncludeMeasures ? cbIncludeMeasures.checked : true
          });
          const reportData = await UA.computeExportReport(ctx);

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
          button.style.opacity = "1";
          button.style.cursor = "pointer";
          button.disabled = false;
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
