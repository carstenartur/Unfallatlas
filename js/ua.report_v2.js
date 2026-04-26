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
          return [r.label, String(r.locCnt), locPct, basePct, r.factor.toFixed(2) + "×"];
        });
        children.push(makeDocxTable(
          ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor"],
          devRows
        ));
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

      // Accident details table – grouped by severity
      if (sd.accidentDetails && sd.accidentDetails.groups && sd.accidentDetails.groups.length > 0) {
        children.push(new Paragraph({
          text: "EINZELUNFÄLLE IM BEREICH",
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 }
        }));
        for (const g of sd.accidentDetails.groups) {
          const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
          children.push(new Paragraph({
            text: headerText,
            bold: true,
            spacing: { before: 200, after: 100 }
          }));
          const detailRows = g.rows.map((r, i) => {
            const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
            const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
            return [String(i + 1), String(r.year ?? "—"), r.involved, hour, r.weekday || "—", r.roadCondition || "—", coords];
          });
          children.push(makeDocxTable(
            ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"],
            detailRows
          ));
          if (g.overflow > 0) {
            children.push(new Paragraph({
              text: `… und ${g.overflow} weitere ${g.sevLabel}`,
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
          return [String(i + 1), String(r.year ?? "—"), r.sevLabel, r.involved, hour, r.weekday || "—", r.roadCondition || "—", coords];
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
   * Replace emoji icons with text labels for PDF compatibility
   * pdfMake's default Roboto font doesn't support emoji glyphs
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
    function makePdfTable(headers, dataRows, rowHighlights) {
      return {
        table: {
          headerRows: 1,
          widths: headers.map(() => "*"),
          body: [
            headers.map(h => ({ text: h, bold: true, fillColor: "#EEEEEE" })),
            ...dataRows.map((row, i) => row.map(cell => ({
              text: String(cell ?? ""), fontSize: 10,
              ...(rowHighlights && rowHighlights[i] ? { fillColor: "#FFFFCC", bold: true } : {})
            })))
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
      pageMargins: [60, 60, 60, 60],
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
      docDefinition.content.push(makePdfTable(["Feld", "Wert"], kvRahmen));
    }

    // ---- Aktive Filter table ----
    const filters = (sd && sd.meta && sd.meta.filters) || {};
    const filterRows = [];
    if (filters.severity      != null) filterRows.push(["Schweregrad",       String(filters.severity)]);
    if (filters.roadCondition != null) filterRows.push(["Fahrbahnzustand",   String(filters.roadCondition)]);
    if (filters.involvementMode != null) filterRows.push(["Beteiligungsmodus", String(filters.involvementMode)]);

    const partLabels = [];
    if (filters.includeCyclist)    partLabels.push("[Rad]");
    if (filters.includePedestrian) partLabels.push("[Fuss]");
    if (filters.includeCar)        partLabels.push("[PKW]");
    if (filters.includeMotorcycle) partLabels.push("[Krad]");
    if (filters.includeGkfz)       partLabels.push("[Gkfz]");
    if (filters.includeSonstig)    partLabels.push("[Sonst]");
    if (partLabels.length > 0) filterRows.push(["Beteiligte", partLabels.join(", ")]);

    if (filters.hourFrom != null && filters.hourTo != null) {
      filterRows.push(["Zeitraum", `${filters.hourFrom}:00-${filters.hourTo}:00 Uhr`]);
    }
    if (filters.dayType != null) filterRows.push(["Wochentag", String(filters.dayType)]);

    if (filterRows.length > 0) {
      docDefinition.content.push({ text: "Aktive Filter", style: "subheader" });
      docDefinition.content.push(makePdfTable(["Filter", "Wert"], filterRows));
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

      // Deviations table
      if (sd.deviations && sd.deviations.focus && sd.deviations.focus.length > 0) {
        docDefinition.content.push({ text: "Top-Abweichungen (Ausschnitt vs. Stadt):", style: "normal" });
        const devRows = sd.deviations.focus.map(r => {
          const locPct = ((r.locR) * 100).toFixed(1).replace(".", ",") + " %";
          const basePct = ((r.baseR) * 100).toFixed(1).replace(".", ",") + " %";
          return [replaceEmojisForPDF(r.label), String(r.locCnt), locPct, basePct, r.factor.toFixed(2) + "x"];
        });
        docDefinition.content.push(makePdfTable(
          ["Muster", "Lokal", "Lokal %", "Stadt %", "Faktor"],
          devRows
        ));
      }

      // Year table
      if (sd.yearTable && sd.yearTable.length > 0) {
        docDefinition.content.push({ text: "Unfälle pro Jahr im Ausschnitt:", style: "normal" });
        const yrRows = sd.yearTable.map(row => [
          String(row.year),
          String(row.total),
          row.classes.length ? replaceEmojisForPDF(row.classes.join(", ")) : "—"
        ]);
        docDefinition.content.push(makePdfTable(
          ["Jahr", "Summe", "Kombinationen"],
          yrRows
        ));
      }

      // Cross-table: Beteiligungskombination × Schweregrad
      if (sd.crossTable && sd.crossTable.rows && sd.crossTable.rows.length > 0) {
        docDefinition.content.push({ text: "Beteiligungskombination × Schweregrad:", style: "normal" });
        const ctRows = sd.crossTable.rows.map(r => [
          replaceEmojisForPDF(r.label), String(r.sev1), String(r.sev2), String(r.sev3), String(r.total)
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
          ctHighlights
        ));
      }

      // Accident details table – grouped by severity
      if (sd.accidentDetails && sd.accidentDetails.groups && sd.accidentDetails.groups.length > 0) {
        docDefinition.content.push({ text: "EINZELUNFÄLLE IM BEREICH", style: "subheader" });
        for (const g of sd.accidentDetails.groups) {
          const headerText = `${g.sevLabel} (n=${g.count})${g.histogram ? "  —  " + g.histogram : ""}`;
          docDefinition.content.push({ text: headerText, bold: true, margin: [0, 8, 0, 4] });
          const detailRows = g.rows.map((r, i) => {
            const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
            const coords = (r.lat != null && r.lon != null) ? `${r.lat.toFixed(4)}, ${r.lon.toFixed(4)}` : "—";
            return [String(i + 1), String(r.year ?? "—"), replaceEmojisForPDF(r.involved), hour, r.weekday || "—", r.roadCondition || "—", coords];
          });
          docDefinition.content.push(makePdfTable(
            ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"],
            detailRows
          ));
          if (g.overflow > 0) {
            docDefinition.content.push({
              text: `… und ${g.overflow} weitere ${g.sevLabel}`,
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
          return [String(i + 1), String(r.year ?? "—"), r.sevLabel, replaceEmojisForPDF(r.involved), hour, r.weekday || "—", r.roadCondition || "—", coords];
        });
        docDefinition.content.push(makePdfTable(
          ["#", "Jahr", "Schwere", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"],
          detailRows
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

          // Get current report data
          const reportData = await UA.computeExportReport(ctx);

          // Get export options
          const rawPct = heatExportOpacityEl ? parseInt(heatExportOpacityEl.value, 10) : 40;
          const heatOpacityPct = Number.isFinite(rawPct) ? Math.max(0, Math.min(100, rawPct)) : 40;
          const options = {
            includeMap: cbIncludeMap ? cbIncludeMap.checked : true,
            includePOIs: cbIncludePOIs ? cbIncludePOIs.checked : true,
            includeReferences: cbIncludeRefs ? cbIncludeRefs.checked : true,
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
