(() => {
  const UA = (window.UA = window.UA || {});

  // =====================================================================
  // Map Image Export (programmatic, using leaflet-image)
  // =====================================================================

  // Delay (in milliseconds) to wait for map tiles to load before capture
  const MAP_CAPTURE_DELAY_MS = 100;

  /**
   * Capture current map view as base64 image
   * @param {Object} ctx - Application context with map instance
   * @param {Object} options - Export options
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
          try {
            // Use leaflet-image to capture the map with all layers and styling
            // This captures the current visual state including markers, heatmaps, and their transparency
            window.leafletImage(ctx.map, (err, canvas) => {
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

  /**
   * Generate and download Word document
   * @param {Object} ctx - Application context
   * @param {Object} reportData - Report data from UA.computeExportReport
   * @param {Object} options - Export options
   */
  UA.exportToWord = async function exportToWord(ctx, reportData, options = {}) {
    if (!window.docx) {
      throw new Error("docx.js library not loaded");
    }

    const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } = window.docx;

    const children = [];
    const textLines = reportData.text.split("\n");

    // ---- Title / Cover ----
    const CITY_RAW = ctx.CITY_RAW || "—";
    const today = new Date().toLocaleDateString("de-DE");

    children.push(
      new Paragraph({
        text: "BEZIRKSRATSANTRAG",
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER
      })
    );

    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `Stadt: ${CITY_RAW}`, bold: true }),
          new TextRun({ text: ` | Datum: ${today}` })
        ],
        spacing: { before: 200, after: 200 }
      })
    );

    children.push(
      new Paragraph({
        text: "─────────────────────────────────",
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 }
      })
    );

    children.push(
      new Paragraph({
        text: "Betreff: Verbesserung der Verkehrssicherheit – Auffälliger Unfallschwerpunkt",
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 }
      })
    );

    // ---- SACHVERHALT section ----
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

    // ---- Map section (if enabled) ----
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

    // ---- POI section (if enabled and data available) ----
    if (options.includePOIs) {
      const poiSection = extractSection(textLines, "POI-Analyse");
      if (poiSection.length > 0) {
        children.push(
          new Paragraph({
            text: "SENSIBLE EINRICHTUNGEN",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 }
          })
        );

        for (const line of poiSection) {
          children.push(
            new Paragraph({
              text: line,
              spacing: { after: 100 }
            })
          );
        }
      }
    }

    // ---- BESCHLUSSVORSCHLAG section ----
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

    // ---- FACHLICHE BEZÜGE section (if enabled) ----
    if (options.includeReferences) {
      const refsSection = extractSection(textLines, "Bezugsdokumente:");
      if (refsSection.length > 0) {
        children.push(
          new Paragraph({
            text: "FACHLICHE BEZÜGE",
            heading: HeadingLevel.HEADING_2,
            spacing: { before: 400, after: 200 }
          })
        );

        for (const line of refsSection) {
          children.push(
            new Paragraph({
              text: line,
              spacing: { after: 100 }
            })
          );
        }
      }
    }

    // ---- DATENQUELLE section ----
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
    const filename = `Bezirksratsantrag_${citySlug}_${today.replace(/\./g, "-")}.docx`;
    
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
      .replace(/\u{1F3CD}[\u{FE0F}]?/gu, "[Krad]");  // 🏍 Motorcycle (optional variation selector)
  }

  /**
   * Generate and download PDF document
   * @param {Object} ctx - Application context
   * @param {Object} reportData - Report data from UA.computeExportReport
   * @param {Object} options - Export options
   */
  UA.exportToPDF = async function exportToPDF(ctx, reportData, options = {}) {
    if (!window.pdfMake) {
      throw new Error("pdfMake library not loaded");
    }

    const CITY_RAW = ctx.CITY_RAW || "—";
    const today = new Date().toLocaleDateString("de-DE");
    // Replace emojis with text labels for PDF compatibility
    const pdfText = replaceEmojisForPDF(reportData.text);
    const textLines = pdfText.split("\n");

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
    docDefinition.content.push({
      text: "BEZIRKSRATSANTRAG",
      style: "header"
    });

    docDefinition.content.push({
      text: `Stadt: ${CITY_RAW} | Datum: ${today}`,
      style: "normal",
      alignment: "center",
      margin: [0, 5, 0, 10]
    });

    docDefinition.content.push({
      text: "─────────────────────────────────",
      alignment: "center",
      margin: [0, 0, 0, 15]
    });

    docDefinition.content.push({
      text: "Betreff: Verbesserung der Verkehrssicherheit – Auffälliger Unfallschwerpunkt",
      style: "subheader"
    });

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

    // ---- Map section (if enabled) ----
    if (options.includeMap) {
      try {
        docDefinition.content.push({
          text: "KARTENAUSSCHNITT",
          style: "subheader"
        });

        const mapImageData = await UA.captureMapImage(ctx, options);
        const werkbankUrl = buildWerkbankUrl(ctx);

        // Make map image clickable
        docDefinition.content.push({
          image: mapImageData,
          width: 500,
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
            "Kategorien: [Rad]=Fahrrad, [Fuss]=Fußgänger, [PKW]=PKW, [Krad]=Motorrad.\n",
            "POIs wie Schulen und Kitas sind hervorgehoben."
          ].join(""),
          style: "small"
        });
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
      const poiSection = extractSection(textLines, "POI-Analyse");
      if (poiSection.length > 0) {
        docDefinition.content.push({
          text: "SENSIBLE EINRICHTUNGEN",
          style: "subheader"
        });

        for (const line of poiSection) {
          const content = textWithLinks(line);
          docDefinition.content.push({
            text: content,
            style: "normal"
          });
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
      const refsSection = extractSection(textLines, "Bezugsdokumente:");
      if (refsSection.length > 0) {
        docDefinition.content.push({
          text: "FACHLICHE BEZÜGE",
          style: "subheader"
        });

        for (const line of refsSection) {
          const content = textWithLinks(line);
          docDefinition.content.push({
            text: content,
            style: "normal"
          });
        }
      }
    }

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
    const filename = `Bezirksratsantrag_${CITY_RAW.replace(/[^a-zA-Z0-9]/g, "_")}_${today.replace(/\./g, "-")}.pdf`;
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
    const exportProgress = document.getElementById("exportProgress");

    if (!btnExportWord || !btnExportPDF || !exportProgress) {
      console.warn("Export buttons or progress element not found in DOM");
      return;
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
          exportProgress.textContent = inProgressText;
          button.style.opacity = "0.6";
          button.style.cursor = "not-allowed";
          button.disabled = true;

          // Get current report data
          const reportData = await UA.computeExportReport(ctx);

          // Get export options
          const options = {
            includeMap: cbIncludeMap ? cbIncludeMap.checked : true,
            includePOIs: cbIncludePOIs ? cbIncludePOIs.checked : true,
            includeReferences: cbIncludeRefs ? cbIncludeRefs.checked : true
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
