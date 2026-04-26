/**
 * UA.heatmap — Stunden-×-Tagestyp-Heatmap (#A2).
 *
 * Liefert eine 24×2-Matrix (Stunde 0..23 × Werktag/Wochenende) aus einer
 * Liste von Unfall-Punkten und kann sie als skalierbares Inline-SVG
 * rendern (für den HTML-Antrag) oder als gefärbte Tabelle (für DOCX/PDF
 * über die Renderer in ua.report_v2.js).
 *
 * Daten-Konvention (kompatibel zu ua.export_v2.js):
 *   - Stunde: `props.ustunde` (0..23, String/Number toleriert)
 *   - Wochentag: `props.uwochentag` 1=Montag … 7=Sonntag (deutsche
 *     Konvention der Unfallatlas-Daten). 6/7 → Wochenende, sonst Werktag.
 *
 * Das Modul ist absichtlich pure-JS und kennt weder DOM noch Leaflet, damit
 * Tests es ohne jsdom/Leaflet-Stubs einbinden können.
 */
(() => {
  const UA = (typeof window !== "undefined" ? (window.UA = window.UA || {}) : (globalThis.UA = globalThis.UA || {}));

  const HOURS = 24;
  const COLS = ["weekday", "weekend"];
  const COL_LABELS = { weekday: "Werktag (Mo–Fr)", weekend: "Wochenende (Sa/So)" };

  /**
   * Klassifiziert einen Wochentag (1=Mo … 7=So) als Werktag oder Wochenende.
   * Werte außerhalb 1..7 werden als „nicht klassifizierbar" verworfen.
   *
   * @param {number} wd
   * @returns {"weekday"|"weekend"|null}
   */
  function dayTypeOf(wd) {
    const n = Number(wd);
    if (!Number.isFinite(n) || n < 1 || n > 7) return null;
    return (n === 6 || n === 7) ? "weekend" : "weekday";
  }

  /**
   * Berechnet die 24×2-Heatmap-Matrix.
   *
   * @param {Array<{props?:object}>} points
   * @returns {{
   *   hours: number[],                // [0,1,…,23]
   *   columns: ["weekday","weekend"],
   *   columnLabels: { weekday:string, weekend:string },
   *   matrix: number[][],             // matrix[hour][colIndex] = count
   *   colTotals: number[],            // [weekdayTotal, weekendTotal]
   *   rowTotals: number[],            // [count for hour 0, …]
   *   total: number,
   *   max: number                     // largest single cell, used for color scaling
   * }}
   */
  function computeHourDaytypeMatrix(points) {
    const hours = Array.from({ length: HOURS }, (_, i) => i);
    const matrix = hours.map(() => [0, 0]);
    let total = 0;
    let max = 0;
    for (const p of points || []) {
      const pr = p && p.props;
      if (!pr) continue;
      const h = Number(pr.ustunde);
      if (!Number.isFinite(h) || h < 0 || h > 23) continue;
      const dt = dayTypeOf(pr.uwochentag);
      if (!dt) continue;
      const col = dt === "weekday" ? 0 : 1;
      const ih = Math.floor(h);
      matrix[ih][col]++;
      total++;
      if (matrix[ih][col] > max) max = matrix[ih][col];
    }
    const colTotals = [0, 0];
    const rowTotals = hours.map(() => 0);
    for (let h = 0; h < HOURS; h++) {
      for (let c = 0; c < 2; c++) {
        colTotals[c] += matrix[h][c];
        rowTotals[h] += matrix[h][c];
      }
    }
    return { hours, columns: COLS, columnLabels: COL_LABELS, matrix, colTotals, rowTotals, total, max };
  }

  /**
   * Berechnet eine Hintergrundfarbe (HEX, "#RRGGBB") für einen Zellenwert.
   * Linear interpoliert zwischen weiß (#FFFFFF) bei value=0 und einem
   * dunklen Blau (#08306B) bei value=max.
   *
   * @param {number} value
   * @param {number} max
   * @returns {string} Hex-Farbe (z.B. "#1F4D8C")
   */
  function cellColor(value, max) {
    if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return "#FFFFFF";
    const t = Math.min(1, value / max);
    // sequential blue ramp (white → #08306B)
    const lerp = (a, b) => Math.round(a + (b - a) * t);
    const r = lerp(255, 8);
    const g = lerp(255, 48);
    const b = lerp(255, 107);
    const toHex = (n) => n.toString(16).padStart(2, "0").toUpperCase();
    return "#" + toHex(r) + toHex(g) + toHex(b);
  }

  /**
   * Wählt eine kontrastreiche Textfarbe (schwarz oder weiß) für eine
   * Zellen-Hintergrundfarbe via einfacher Helligkeits-Schwelle.
   *
   * @param {string} hex   "#RRGGBB"
   * @returns {"#000000"|"#FFFFFF"}
   */
  function readableTextColor(hex) {
    if (typeof hex !== "string" || hex.length < 7) return "#000000";
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if ([r, g, b].some(n => Number.isNaN(n))) return "#000000";
    // Standard luminance approximation; cells darker than ~50% get white text.
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance < 0.55 ? "#FFFFFF" : "#000000";
  }

  /**
   * Render die Heatmap als kompaktes Inline-SVG. Nicht-leere Zellen tragen
   * die Zahl als Beschriftung; ganz leere Zellen bleiben weiß.
   *
   * @param {ReturnType<typeof computeHourDaytypeMatrix>} m
   * @param {{ cellW?:number, cellH?:number, ariaLabel?:string }} [opts]
   * @returns {string} `<svg>…</svg>` oder `""` falls m fehlt/leer.
   */
  function renderHeatmapSVG(m, opts) {
    if (!m || !m.matrix || m.total === 0) return "";
    const cellW = (opts && opts.cellW) || 22;
    const cellH = (opts && opts.cellH) || 18;
    const padL = 38; // room for hour labels
    const padT = 24; // room for column labels
    const width = padL + cellW * 2 + 4;
    const height = padT + cellH * HOURS + 4;
    const ariaLabel = (opts && opts.ariaLabel) || `Stunden-Heatmap nach Tagestyp; gesamt ${m.total} Unfälle`;
    const parts = [];
    parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}" width="${width}" height="${height}">`);
    // Column headers
    parts.push(`<text x="${padL + cellW / 2}" y="14" text-anchor="middle" font-size="10" fill="#333">Mo–Fr</text>`);
    parts.push(`<text x="${padL + cellW + cellW / 2}" y="14" text-anchor="middle" font-size="10" fill="#333">Sa/So</text>`);
    for (let h = 0; h < HOURS; h++) {
      const y = padT + h * cellH;
      // Hour label
      parts.push(`<text x="${padL - 4}" y="${y + cellH / 2 + 3}" text-anchor="end" font-size="9" fill="#555">${String(h).padStart(2, "0")}</text>`);
      for (let c = 0; c < 2; c++) {
        const v = m.matrix[h][c];
        const fill = cellColor(v, m.max);
        const x = padL + c * cellW;
        parts.push(`<rect x="${x}" y="${y}" width="${cellW - 1}" height="${cellH - 1}" fill="${fill}" stroke="#ccc" stroke-width="0.5"/>`);
        if (v > 0) {
          parts.push(`<text x="${x + cellW / 2}" y="${y + cellH / 2 + 3}" text-anchor="middle" font-size="9" fill="${readableTextColor(fill)}">${v}</text>`);
        }
      }
    }
    parts.push(`</svg>`);
    return parts.join("");
  }

  UA.heatmap = {
    computeHourDaytypeMatrix,
    renderHeatmapSVG,
    cellColor,
    readableTextColor,
    dayTypeOf,
    HOURS,
    COLS,
    COL_LABELS
  };
})();
