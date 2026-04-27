/**
 * UA.trend — Mehrjahres-Trend pro Bereich (#C2).
 *
 * Liefert für eine Liste von gefilterten Unfall-Punkten:
 *   - jährliche Zählungen pro Schweregrad (fatal / severe / light)
 *   - Slope, Intercept und R² einer einfachen linearen Regression über
 *     die Gesamtzahl pro Jahr
 *   - eine qualitative Klassifikation („rückläufig" / „stagnierend" /
 *     „steigend") basierend auf relativer Steigung und Bestimmtheitsmaß
 *
 * Das Ergebnis hängt ua.export_v2.js als `structured.yearlyTrend` an,
 * damit die HTML-/DOCX-/PDF-Renderer in ua.report_v2.js es konsistent
 * darstellen können (Tabelle + Klassifikation; im HTML zusätzlich eine
 * SVG-Linie als optionales Bonbon).
 *
 * Die Schwellwerte für die Klassifikation sind bewusst konservativ:
 * Schwankungen unter ±5 % pro Jahr und/oder R² < 0,3 gelten als
 * stagnierend, weil bei kleinen Fallzahlen die Regression sehr instabil
 * werden kann. Adressaten von Anträgen sollten lieber einen schwachen
 * Trend nicht überinterpretieren als andersherum.
 */
(() => {
  const UA = (typeof window !== "undefined" ? (window.UA = window.UA || {}) : (globalThis.UA = globalThis.UA || {}));

  // Schwellwerte (relativ zum Mittelwert, pro Jahr).
  // - |slopeRel| < SLOPE_FLAT_REL → stagnierend
  // - sonst: Vorzeichen entscheidet (positiv → steigend, negativ → rückläufig)
  // - Zusätzlich: schlechtes Modell-Fit (R² < R2_MIN) wird als stagnierend
  //   klassifiziert, um falsche Trendaussagen aus 2-3 Datenpunkten zu vermeiden.
  const SLOPE_FLAT_REL = 0.05; // 5 % pro Jahr
  const R2_MIN = 0.3;
  const MIN_YEARS_FOR_TREND = 3;

  /**
   * Klassifiziert einen jährlichen Slope (absolute Einheiten) gegenüber dem
   * Mittelwert der Reihe.
   *
   * @param {number} slope        Steigung pro Jahr (Unfälle/Jahr)
   * @param {number} mean         Mittelwert der Reihe (Unfälle/Jahr)
   * @param {number} r2           Bestimmtheitsmaß der Regression (0..1)
   * @param {number} nYears       Anzahl der Datenpunkte (Jahre)
   * @returns {"rückläufig"|"stagnierend"|"steigend"|"unbestimmt"}
   */
  function classifyTrend(slope, mean, r2, nYears) {
    if (!Number.isFinite(slope) || !Number.isFinite(mean) || nYears < MIN_YEARS_FOR_TREND) {
      return "unbestimmt";
    }
    if (mean <= 0) {
      // Komplett leerer Bereich → keine sinnvolle Aussage.
      return "unbestimmt";
    }
    if (!Number.isFinite(r2) || r2 < R2_MIN) {
      // Modell erklärt zu wenig Varianz → konservativ stagnierend nennen.
      return "stagnierend";
    }
    const slopeRel = slope / mean;
    if (Math.abs(slopeRel) < SLOPE_FLAT_REL) return "stagnierend";
    return slopeRel > 0 ? "steigend" : "rückläufig";
  }

  /**
   * Berechnet einfache Ordinary-Least-Squares-Regression y = a*x + b über
   * die übergebenen (xs, ys)-Reihen.
   *
   * Robust gegen Randfälle:
   *  - n < 2  → slope=0, intercept=mean(ys)||0, r2=NaN
   *  - alle x identisch → slope=0, intercept=mean(ys), r2=NaN (kein x-Varianz)
   *  - alle y identisch → slope=0, intercept=y, r2=1 (perfekter Fit auf konstante Reihe)
   *
   * @param {number[]} xs
   * @param {number[]} ys
   * @returns {{ slope:number, intercept:number, r2:number, mean:number }}
   */
  function linearRegression(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) {
      const m = n === 1 ? ys[0] : 0;
      return { slope: 0, intercept: m, r2: NaN, mean: m };
    }
    let sumX = 0, sumY = 0;
    for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; }
    const meanX = sumX / n;
    const meanY = sumY / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - meanX;
      const dy = ys[i] - meanY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    if (denX === 0) {
      // Kein x-Spread → keine sinnvolle Regression
      return { slope: 0, intercept: meanY, r2: NaN, mean: meanY };
    }
    const slope = num / denX;
    const intercept = meanY - slope * meanX;
    // R² = 1 - SSres/SStot. SStot==0 bedeutet konstante y-Reihe → perfekter Fit.
    let r2;
    if (denY === 0) {
      r2 = 1;
    } else {
      let ssRes = 0;
      for (let i = 0; i < n; i++) {
        const yhat = slope * xs[i] + intercept;
        const e = ys[i] - yhat;
        ssRes += e * e;
      }
      r2 = 1 - ssRes / denY;
    }
    return { slope, intercept, r2, mean: meanY };
  }

  /**
   * Hauptfunktion: berechnet jährliche Zählungen pro Schweregrad und einen
   * Trend für die Gesamtsumme.
   *
   * Erwartet Punkte in dem Format, das ua.export_v2.js intern verwendet:
   * `{ props: { year, ukategorie } }`. Punkte ohne gültigen Jahres-Wert
   * werden ignoriert. Die `ukategorie` wird auf String gemappt:
   *   "1" → fatal, "2" → severe, "3" → light. Andere Werte landen in
   *   `other` (und zählen für `total`).
   *
   * Wenn weniger als MIN_YEARS_FOR_TREND verschiedene Jahre vorliegen,
   * wird `classification = "unbestimmt"` zurückgegeben (Slope/R² werden
   * trotzdem berechnet, falls möglich, sind dann aber nicht aussagekräftig).
   *
   * @param {Array<{props?:object}>} points
   * @returns {{
   *   years: number[],
   *   counts: { fatal:number[], severe:number[], light:number[], total:number[] },
   *   slope: number,
   *   intercept: number,
   *   r2: number,
   *   classification: "rückläufig"|"stagnierend"|"steigend"|"unbestimmt",
   *   nYears: number
   * }}
   */
  function computeYearlyTrend(points) {
    const byYear = new Map(); // year -> { fatal, severe, light, other, total }
    for (const p of points || []) {
      const pr = p && p.props;
      if (!pr) continue;
      const y = parseInt(pr.year, 10);
      if (!Number.isFinite(y)) continue;
      let row = byYear.get(y);
      if (!row) { row = { fatal: 0, severe: 0, light: 0, other: 0, total: 0 }; byYear.set(y, row); }
      const k = String(pr.ukategorie ?? "");
      if (k === "1") row.fatal++;
      else if (k === "2") row.severe++;
      else if (k === "3") row.light++;
      else row.other++;
      row.total++;
    }
    const years = [...byYear.keys()].sort((a, b) => a - b);
    const counts = { fatal: [], severe: [], light: [], total: [] };
    for (const y of years) {
      const r = byYear.get(y);
      counts.fatal.push(r.fatal);
      counts.severe.push(r.severe);
      counts.light.push(r.light);
      counts.total.push(r.total);
    }
    const reg = linearRegression(years, counts.total);
    const classification = classifyTrend(reg.slope, reg.mean, reg.r2, years.length);
    return {
      years,
      counts,
      slope: reg.slope,
      intercept: reg.intercept,
      r2: reg.r2,
      classification,
      nYears: years.length
    };
  }

  /**
   * Render eine schlanke SVG-Linie für die Gesamtreihe – nur für HTML-Antrag
   * gedacht (DOCX/PDF bekommen die Tabelle + Klassifikation, kein Bild).
   *
   * Liefert einen kompletten `<svg>…</svg>`-String. Bei < 2 Datenpunkten
   * gibt die Funktion `""` zurück (nichts zu zeichnen).
   *
   * @param {{years:number[], counts:{total:number[]}, slope:number, intercept:number}} trend
   * @param {{width?:number, height?:number, ariaLabel?:string}} [opts]
   */
  function renderTrendSVG(trend, opts) {
    if (!trend || !Array.isArray(trend.years) || trend.years.length < 2) return "";
    const width = (opts && opts.width) || 320;
    const height = (opts && opts.height) || 80;
    const padL = 28, padR = 6, padT = 6, padB = 18;
    const W = width - padL - padR;
    const H = height - padT - padB;
    const ys = trend.counts.total;
    const minX = trend.years[0];
    const maxX = trend.years[trend.years.length - 1];
    const maxY = Math.max(1, ...ys);
    const xPos = (yr) => padL + (W * (yr - minX) / Math.max(1, maxX - minX));
    const yPos = (v)  => padT + H - (H * v / maxY);
    const dataPath = ys.map((v, i) => `${i === 0 ? "M" : "L"}${xPos(trend.years[i]).toFixed(1)},${yPos(v).toFixed(1)}`).join(" ");
    // Regression line endpoints
    const yReg0 = trend.intercept + trend.slope * minX;
    const yReg1 = trend.intercept + trend.slope * maxX;
    const regPath = `M${xPos(minX).toFixed(1)},${yPos(Math.max(0, yReg0)).toFixed(1)} L${xPos(maxX).toFixed(1)},${yPos(Math.max(0, yReg1)).toFixed(1)}`;
    const ariaLabel = (opts && opts.ariaLabel) || `Mehrjahres-Trend ${minX}\u2013${maxX}: ${trend.classification}`;
    // Year ticks: only first/last to keep it compact and readable.
    const tickFirst = `<text x="${xPos(minX).toFixed(1)}" y="${(height - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="#555">${minX}</text>`;
    const tickLast  = `<text x="${xPos(maxX).toFixed(1)}" y="${(height - 4).toFixed(1)}" font-size="9" text-anchor="middle" fill="#555">${maxX}</text>`;
    const yMaxLabel = `<text x="${(padL - 4).toFixed(1)}" y="${(padT + 8).toFixed(1)}" font-size="9" text-anchor="end" fill="#555">${maxY}</text>`;
    const yMinLabel = `<text x="${(padL - 4).toFixed(1)}" y="${(padT + H).toFixed(1)}" font-size="9" text-anchor="end" fill="#555">0</text>`;
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${ariaLabel}" width="${width}" height="${height}">` +
        `<rect x="0" y="0" width="${width}" height="${height}" fill="none" stroke="#ddd" stroke-width="0.5"/>` +
        `<path d="${dataPath}" fill="none" stroke="#1f77b4" stroke-width="1.5"/>` +
        `<path d="${regPath}" fill="none" stroke="#d62728" stroke-width="1" stroke-dasharray="3 2"/>` +
        tickFirst + tickLast + yMaxLabel + yMinLabel +
      `</svg>`
    );
  }

  UA.trend = {
    computeYearlyTrend,
    classifyTrend,
    linearRegression,
    renderTrendSVG,
    SLOPE_FLAT_REL,
    R2_MIN,
    MIN_YEARS_FOR_TREND
  };
})();
