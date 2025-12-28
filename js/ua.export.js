(() => {
  const UA = (window.UA = window.UA || {});

  // --------------------
  // Export templates (optional)
  // --------------------
  const TEMPLATE_DIR = "templates";
  const DEFAULT_TEMPLATES = {
    intro: `Bezirksratsantrag (Entwurf) – Unfallwerkbank\n\nBetreff: Verbesserung der Verkehrssicherheit – Auffälliger Unfallschwerpunkt im markierten Bereich\n`,
    sachverhalt: `Sachverhalt:\nIm markierten Kartenausschnitt wurden {{local_total}} Unfälle ausgewertet. Im Vergleich zum Stadtdurchschnitt ({{baseline_total}} Unfälle, gleiche Filter für Schwere/Zeit/Zustand) zeigen sich Abweichungen in den Beteiligungskombinationen.\n\nVerletzungsschwere (Ausschnitt):\n{{severity_summary}}`,
    beschluss: `Beschlussvorschlag:\nDer Bezirksrat bittet die Verwaltung, den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen.\n\n1) Sofortmaßnahmen (Quick Wins): Markierungen/Warnhinweise, Sichtbeziehungen herstellen, konfliktärmere Führung, Signalisierung prüfen, ggf. Tempoanpassung.\n2) Infrastrukturmaßnahmen: sichere Rad- und Fußführung, sichere Querungen, Oberflächen-/Kantenprüfung, Knotenpunktgestaltung.\n3) Monitoring: Nach Umsetzung Evaluation anhand Unfallatlas-Daten der Folgejahre.\n`,
    hinweis: `Hinweis (intern, vor Versand entfernen): Dieser Text wurde automatisiert erzeugt. Link zur Überarbeitung: {{link}}\n`,
    lizenz: `Datenquelle/Lizenzhinweis: Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).\n`
  };

  async function loadTemplate(name) {
    const url = `${TEMPLATE_DIR}/${name}.txt`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) return DEFAULT_TEMPLATES[name] || "";
      return await r.text();
    } catch {
      return DEFAULT_TEMPLATES[name] || "";
    }
  }

  function tpl(str, vars) {
    return String(str).replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_, k) => String(vars[k] ?? ""));
  }

  function fmtPct(x) {
    return (x * 100).toFixed(1).replace(".", ",") + " %";
  }

  // --------------------
  // Unfallklassen / Masken (robust, unabhängig von anderen Modulen)
  // --------------------
  const COMBO_LABEL = {
    1:  "🚲",
    2:  "🚶",
    4:  "🚗",
    8:  "🏍️",
    3:  "🚲+🚶",
    5:  "🚲+🚗",
    6:  "🚗+🚶",
    7:  "🚲+🚗+🚶",
    9:  "🚲+🏍️",
    10: "🚶+🏍️",
    12: "🚗+🏍️",
    11: "🚲+🚶+🏍️",
    13: "🚲+🚗+🏍️",
    14: "🚶+🚗+🏍️",
    15: "🚲+🚶+🚗+🏍️"
  };

  function maskFromProps(pr) {
    // sowohl lower-case als auch Originalfelder tolerieren
    const get = (k) => {
      if (!pr) return "";
      if (pr[k] !== undefined) return pr[k];
      const lk = String(k).toLowerCase();
      if (pr[lk] !== undefined) return pr[lk];
      return "";
    };

    const isBike = String(get("IstRad")) === "1" || String(get("istrad")) === "1";
    const isPed  = String(get("IstFuss")) === "1" || String(get("istfuss")) === "1";
    const isCar  = String(get("IstPKW")) === "1" || String(get("istpkw")) === "1";
    const isMoto = String(get("IstKrad")) === "1" || String(get("istkrad")) === "1";

    return (isBike ? 1 : 0) | (isPed ? 2 : 0) | (isCar ? 4 : 0) | (isMoto ? 8 : 0);
  }

  function interpretMask(mask) {
    if (mask === 1) return "Überrepräsentation von 🚲-Alleinunfällen kann auf Infrastruktur-Risiken (z. B. Schienenquerungen, Kanten/Spurrinnen, Belagswechsel, Engstellen) hindeuten.";
    if (mask === 2) return "Überrepräsentation von 🚶-Alleinunfällen kann auf Querungsdefizite, Sichtbehinderungen oder Stolperstellen hinweisen.";
    if (mask === 5) return "Überrepräsentation von 🚲+🚗 deutet häufig auf Konflikte an Knotenpunkten/Abbiegesituationen, Sichtbeziehungen und Führung des Radverkehrs hin.";
    if (mask === 6) return "Überrepräsentation von 🚗+🚶 weist oft auf Querungsdefizite, Sichtbeziehungen oder hohes Geschwindigkeitsniveau hin.";
    if (mask === 3) return "Überrepräsentation von 🚲+🚶 kann auf enge Führungen, gemeinsame Flächen oder fehlende Trennung hinweisen.";
    if (mask === 7) return "Überrepräsentation von 🚲+🚗+🚶 spricht für komplexe Konfliktlagen an Knotenpunkten bzw. stark frequentierten Querungen.";
    return "Auffälligkeit kann auf lokale Führungs-/Sicht-/Querungsprobleme hinweisen; eine Ortsbegehung und Unfallkommissionsprüfung ist angezeigt.";
  }

  // --------------------
  // Bounds helpers
  // --------------------
  function boundsForExport(ctx) {
    return ctx.selectionBounds ? ctx.selectionBounds : ctx.map.getBounds();
  }

  function inBounds(p, b) {
    return b.contains([p.lat, p.lon]);
  }

  function yearsRange(points) {
    let minY = Infinity, maxY = -Infinity;
    for (const p of points || []) {
      const y = parseInt(p.props?.year, 10);
      if (!Number.isFinite(y)) continue;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
    return { minY, maxY };
  }

  function severityStats(ctx, bounds) {
    const b = bounds || ctx.map.getBounds();
    const res = { total: 0, bySev: { "1": 0, "2": 0, "3": 0, "other": 0 } };

    for (const p of ctx.allPts || []) {
      if (!p?.props) continue;

      // Wenn es ein Filter-Modul gibt, nutzen wir es (damit ist es konsistent mit der UI)
      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, p.props)) continue;
      }

      if (!b.contains([p.lat, p.lon])) continue;
      res.total++;

      const k = String(p.props.ukategorie ?? "");
      if (k === "1" || k === "2" || k === "3") res.bySev[k] = (res.bySev[k] || 0) + 1;
      else res.bySev.other++;
    }
    return res;
  }

  function yearTable(ctx, bounds) {
    const rows = new Map(); // year -> {total, byMask}
    const yearsSet = new Set();

    for (const p of ctx.allPts || []) {
      const y = parseInt(p.props?.year, 10);
      if (Number.isFinite(y)) yearsSet.add(y);
    }
    const years = [...yearsSet].sort((a, b) => a - b);

    for (const p of ctx.allPts || []) {
      const pr = p.props || {};

      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
      }

      const y = parseInt(pr.year, 10);
      if (!Number.isFinite(y)) continue;
      if (!inBounds(p, bounds)) continue;

      const m = maskFromProps(pr);
      if (m === 0) continue;

      if (!rows.has(y)) rows.set(y, { total: 0, byMask: {} });
      const r = rows.get(y);
      r.total++;
      r.byMask[m] = (r.byMask[m] || 0) + 1;
    }

    const out = [];
    for (const y of years) {
      const r = rows.get(y) || { total: 0, byMask: {} };
      const classes = Object.entries(r.byMask)
        .map(([m, c]) => ({ m: Number(m), c }))
        .sort((a, b) => b.c - a.c)
        .map(e => `${COMBO_LABEL[e.m] || ("Mask " + e.m)}=${e.c}`);
      out.push({ year: y, total: r.total, classes });
    }
    return out;
  }

  function topDeviations(ctx, bounds) {
    // Baseline: entweder ctx.baselineCounts (ideal) oder wir bauen eine einfache Baseline aus allPts nach Non-Involvement-Filtern
    let baseline = ctx.baselineCounts;

    if (!baseline || !baseline.total) {
      const bc = { total: 0, byMask: {} };
      for (const p of ctx.allPts || []) {
        const pr = p.props || {};
        if (typeof UA.matchesNonInvolvementFilters === "function") {
          if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
        }
        const m = maskFromProps(pr);
        if (m === 0) continue;
        bc.total++;
        bc.byMask[m] = (bc.byMask[m] || 0) + 1;
      }
      baseline = bc;
    }

    const local = { total: 0, byMask: {} };
    for (const p of ctx.allPts || []) {
      const pr = p.props || {};
      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, pr)) continue;
      }
      if (!inBounds(p, bounds)) continue;
      const m = maskFromProps(pr);
      if (m === 0) continue;
      local.total++;
      local.byMask[m] = (local.byMask[m] || 0) + 1;
    }

    const rows = [];
    for (const [mStr, locCnt] of Object.entries(local.byMask)) {
      const m = Number(mStr);
      const baseCnt = baseline.byMask[m] || 0;
      const locR = local.total ? (locCnt / local.total) : 0;
      const baseR = baseline.total ? (baseCnt / baseline.total) : 0;
      const factor = (baseR > 0) ? (locR / baseR) : Infinity;
      rows.push({ mask: m, label: COMBO_LABEL[m] || ("Mask " + m), locCnt, baseCnt, locR, baseR, factor });
    }
    rows.sort((a, b) => (b.factor - a.factor));

    const focus = rows
      .filter(r => Number.isFinite(r.factor))
      .filter(r => r.baseR > 0)
      .filter(r => r.locCnt >= 3)
      .filter(r => r.factor >= 1.35)
      .slice(0, 6);

    return { local, baseline, rows, focus };
  }

  // --------------------
  // Public API: UA.computeExportReport(ctx)
  // --------------------
  UA.computeExportReport = async function computeExportReport(ctx) {
    const bounds = boundsForExport(ctx);
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const bStr = `${sw.lat.toFixed(5)},${sw.lng.toFixed(5)} – ${ne.lat.toFixed(5)},${ne.lng.toFixed(5)}`;

    const dev = topDeviations(ctx, bounds);
    const yr = yearTable(ctx, bounds);
    const sev = severityStats(ctx, bounds);
    const range = yearsRange(ctx.allPts || []);

    const CITY_RAW = ctx.CITY_RAW || "—";

    const vars = {
      city: CITY_RAW,
      bounds: bStr,
      local_total: dev.local.total.toLocaleString(),
      baseline_total: dev.baseline.total.toLocaleString(),
      severity_summary: ((sev.bySev["1"] || 0) > 0
        ? `Im Ausschnitt wurden ${sev.bySev["1"]} Getötete, ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`
        : `Im Ausschnitt wurden ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`),
      date: new Date().toLocaleDateString("de-DE"),
      link: window.location.href
    };

    const [tIntro, tSach, tBesch, tHinw, tLiz] = await Promise.all([
      loadTemplate("intro"),
      loadTemplate("sachverhalt"),
      loadTemplate("beschluss"),
      loadTemplate("hinweis"),
      loadTemplate("lizenz")
    ]);

    // ---- Text (Clipboard/Word) ----
    const lines = [];
    lines.push(tpl(tIntro, vars).trim());
    lines.push("");
    lines.push(`Stadt: ${CITY_RAW}`);
    if (range) lines.push(`Datenzeitraum: ${range.minY}–${range.maxY}`);
    lines.push(`Ausschnitt (Bounds): ${bStr}`);
    lines.push(`Datum: ${vars.date}`);
    lines.push("");
    lines.push(tpl(tSach, vars).trim());
    lines.push("");

    if (dev.focus.length) {
      lines.push("Auffälligkeiten (Top-Abweichungen, Anteil im Ausschnitt vs. Stadt):");
      for (const r of dev.focus) {
        lines.push(`- ${r.label}: lokal ${fmtPct(r.locR)} vs Stadt ${fmtPct(r.baseR)} (Faktor ${r.factor.toFixed(2)}); lokal ${r.locCnt} / stadtweit ${r.baseCnt}`);
      }
      lines.push("");
      lines.push("Bewertung / Interpretation (heuristisch):");
      for (const r of dev.focus.slice(0, 3)) {
        lines.push(`- ${r.label}: ${interpretMask(r.mask)}`);
      }
      lines.push("");
    } else {
      lines.push("Auffälligkeiten: In diesem Ausschnitt zeigen sich unter den gewählten Filtern keine klar überrepräsentierten Beteiligungskombinationen (Schwelle: min. 3 Fälle, Faktor ≥ 1,35).");
      lines.push("");
    }

    lines.push(tpl(tBesch, vars).trim());
    lines.push("");
    lines.push(tpl(tHinw, vars).trim());
    lines.push("");
    lines.push(tpl(tLiz, vars).trim());

    const textOut = lines.join("\n").replace(/\n{3,}/g, "\n\n");

    // ---- HTML (Modal) ----
    const focusRows = dev.focus.length ? dev.focus : dev.rows.slice(0, 5);

    const mkDevRow = (r) => `
      <tr>
        <td><span class="pill">${UA.escHtml(r.label)}</span></td>
        <td style="text-align:right;">${r.locCnt.toLocaleString()}</td>
        <td style="text-align:right;">${fmtPct(r.locR)}</td>
        <td style="text-align:right;">${fmtPct(r.baseR)}</td>
        <td style="text-align:right; font-weight:900;">${r.factor.toFixed(2)}×</td>
      </tr>`;

    const mkYearRow = (row) => `
      <tr>
        <td style="width:80px;"><strong>${row.year}</strong></td>
        <td style="text-align:right; width:110px;">${row.total.toLocaleString()}</td>
        <td>${row.classes.length ? UA.escHtml(row.classes.join(", ")) : "<span style=\"color:#777;\">—</span>"}</td>
      </tr>`;

    const htmlOut = `
      <div style="font:14px/1.35 system-ui;">
        <div style="font-weight:950; font-size:16px;">Report – Auffälligkeiten im markierten Bereich</div>
        <div style="color:#444; margin-top:4px;">
          <div><strong>Stadt:</strong> ${UA.escHtml(CITY_RAW)} | <strong>Bounds:</strong> <code>${UA.escHtml(bStr)}</code></div>
          <div><strong>Auswertung:</strong> lokal ${dev.local.total.toLocaleString()} Unfälle | Baseline ${dev.baseline.total.toLocaleString()} Unfälle</div>
          <div><strong>Datenzeitraum:</strong> ${range ? (range.minY + "–" + range.maxY) : "—"}</div>
        </div>

        <div style="margin-top:12px; font-weight:900;">Top-Abweichungen</div>
        <table class="report">
          <thead>
            <tr><th>Muster</th><th style="text-align:right;">lokal</th><th style="text-align:right;">lokal %</th><th style="text-align:right;">Stadt %</th><th style="text-align:right;">Faktor</th></tr>
          </thead>
          <tbody>
            ${focusRows.filter(r => r.locCnt > 0).map(mkDevRow).join("") || "<tr><td colspan=\"5\" style=\"color:#777;\">—</td></tr>"}
          </tbody>
        </table>

        <div style="margin-top:12px; font-weight:900;">Unfälle pro Jahr (im Ausschnitt)</div>
        <table class="report">
          <thead>
            <tr><th>Jahr</th><th style="text-align:right;">Summe</th><th>Kombinationen (sortiert)</th></tr>
          </thead>
          <tbody>
            ${yr.map(mkYearRow).join("")}
          </tbody>
        </table>

        <div style="margin-top:12px; font-weight:900;">Verletzungsschwere im Ausschnitt</div>
        <table class="report" style="margin-top:6px;">
          <thead>
            <tr><th>Kategorie</th><th style="text-align:right;">Anzahl</th><th style="text-align:right;">Anteil</th></tr>
          </thead>
          <tbody>
            <tr><td>1 – Getötete</td><td style="text-align:right;">${sev.bySev["1"] || 0}</td><td style="text-align:right;">${sev.total ? fmtPct((sev.bySev["1"] || 0) / sev.total) : "0,0 %"}</td></tr>
            <tr><td>2 – Schwerverletzte</td><td style="text-align:right;">${sev.bySev["2"] || 0}</td><td style="text-align:right;">${sev.total ? fmtPct((sev.bySev["2"] || 0) / sev.total) : "0,0 %"}</td></tr>
            <tr><td>3 – Leichtverletzte</td><td style="text-align:right;">${sev.bySev["3"] || 0}</td><td style="text-align:right;">${sev.total ? fmtPct((sev.bySev["3"] || 0) / sev.total) : "0,0 %"}</td></tr>
          </tbody>
        </table>

        <div style="margin-top:10px; color:#555; font-size:12px;">
          <div><strong>Methodik:</strong> Verglichen wird die Verteilung exakter Beteiligungskombinationen im Ausschnitt vs. stadtweit – jeweils unter denselben Nicht-Beteiligungsfiltern (Schwere/Zeit/Zustand/Wochentag).</div>
          <div><strong>Hinweis:</strong> Heuristisch – ersetzt keine Unfallkommission/Ortsbegehung.</div>
        </div>
      </div>
    `;

    return { text: textOut, html: htmlOut };
  };
})();