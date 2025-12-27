// js/ua.export.js
(() => {
  "use strict";

  // Namespace
  window.UA = window.UA || {};

  const Export = {
    _ctx: null,
    _ui: null,
    _map: null,

    init({ ctx, ui, map }) {
      this._ctx = ctx;
      this._ui = ui;
      this._map = map;

      // Guard: DOM elements vorhanden?
      const need = [
        ui.modalOverlay, ui.exportHtml, ui.exportBoxTa, ui.exportProgress,
        ui.btnCloseModal, ui.btnCopyText, ui.btnCopyLink, ui.btnOpenExport
      ];
      if (need.some(x => !x)) {
        console.warn("[UA.Export] Missing UI elements, export disabled");
        return;
      }

      // Bind once
      ui.btnCloseModal.addEventListener("click", () => this.closeModal());
      ui.modalOverlay.addEventListener("click", (e) => {
        if (e.target === ui.modalOverlay) this.closeModal();
      });

      ui.btnCopyText.addEventListener("click", async () => {
        await this._writeClipboard(ui.exportBoxTa.value || "");
        alert("Kopiert.");
      });

      ui.btnCopyLink.addEventListener("click", async () => {
        // export=1 in URL setzen
        const url = UA.setQS({ export: 1 });
        await this._writeClipboard(url);
        alert("Link kopiert.");
      });

      ui.btnOpenExport.addEventListener("click", async () => {
        await this.openAndCompute();
      });
    },

    openModal() {
      this._ui.modalOverlay.style.display = "flex";
    },
    closeModal() {
      this._ui.modalOverlay.style.display = "none";
    },

    async openAndCompute() {
      const ui = this._ui;

      this.openModal();
      ui.exportProgress.textContent = "Report wird erzeugt…";
      ui.exportHtml.innerHTML = `<div style="color:#666; font-size:12px;">(Report wird erzeugt…)</div>`;
      ui.exportBoxTa.value = "…";

      // Browser einen Tick rendern lassen
      await new Promise(r => setTimeout(r, 0));

      try {
        const r = await this.computeExportReport();
        ui.exportProgress.textContent = "Fertig.";
        ui.exportHtml.innerHTML = r.html;
        ui.exportBoxTa.value = r.text;
        UA.setQS({ export: 1 }); // URL markiert Export offen
      } catch (e) {
        console.error(e);
        ui.exportProgress.textContent = "Fehler.";
        ui.exportHtml.innerHTML =
          `<div style="color:#b00; font-weight:900;">Export fehlgeschlagen</div>` +
          `<div style="font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px;">${UA.escHtml(String(e))}</div>`;
        ui.exportBoxTa.value = "Export fehlgeschlagen: " + String(e);
      }
    },

    // --------------------
    // Report-Kern
    // --------------------

    _boundsForExport() {
      // selectionBounds sitzt im ctx (so wie du es in ua.map / ua.state pflegst)
      const b = this._ctx.selectionBounds;
      return b ? b : this._map.getBounds();
    },

    _inBounds(p, b) {
      return b.contains([p.lat, p.lon]);
    },

    _yearsRange(points) {
      let minY = Infinity, maxY = -Infinity;
      for (const p of points) {
        const y = parseInt(p.props?.year, 10);
        if (!Number.isFinite(y)) continue;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (!Number.isFinite(minY) || !Number.isFinite(maxY)) return null;
      return { minY, maxY };
    },

    _severityStats(bounds) {
      // ukategorie: 1/2/3
      const pts = this._ctx.filteredAll.filter(p => this._inBounds(p, bounds));
      const bySev = { "1": 0, "2": 0, "3": 0, other: 0 };
      for (const p of pts) {
        const k = String(p.props?.ukategorie ?? "");
        if (k === "1" || k === "2" || k === "3") bySev[k]++; else bySev.other++;
      }
      return { total: pts.length, bySev };
    },

    _yearTable(bounds) {
      // im Ausschnitt: nur Nicht-Beteiligungsfilter, keine Doppelzählung
      // => wir verwenden allPts und matchesNonInvolvementFilters
      const ctx = this._ctx;

      const rows = new Map(); // year -> { total, byMask }
      const yearsSet = new Set();
      for (const p of ctx.allPts) {
        const y = parseInt(p.props?.year, 10);
        if (Number.isFinite(y)) yearsSet.add(y);
      }
      const years = [...yearsSet].sort((a, b) => a - b);

      for (const p of ctx.allPts) {
        const pr = p.props || {};
        if (!ctx.matchesNonInvolvementFilters(pr)) continue;
        if (!this._inBounds(p, bounds)) continue;

        const y = parseInt(pr.year, 10);
        if (!Number.isFinite(y)) continue;

        const m = ctx.maskFromProps(pr);
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
          .map(e => `${ctx.COMBO_LABEL[e.m] || ("Mask " + e.m)}=${e.c}`);
        out.push({ year: y, total: r.total, classes });
      }
      return out;
    },

    _topDeviations(bounds) {
      // baselineCounts wird in ctx.computeBaselineCounts() gepflegt
      const ctx = this._ctx;
      const baseline = ctx.baselineCounts;

      if (!baseline || !baseline.total) {
        return { local: { total: 0, byMask: {} }, baseline: { total: 0, byMask: {} }, rows: [], focus: [] };
      }

      const local = { total: 0, byMask: {} };
      for (const p of ctx.allPts) {
        const pr = p.props || {};
        if (!ctx.matchesNonInvolvementFilters(pr)) continue;
        if (!this._inBounds(p, bounds)) continue;

        const m = ctx.maskFromProps(pr);
        if (m === 0) continue;

        local.total++;
        local.byMask[m] = (local.byMask[m] || 0) + 1;
      }

      const rows = [];
      for (const [mStr, locCnt] of Object.entries(local.byMask)) {
        const m = Number(mStr);
        const baseCnt = baseline.byMask[m] || 0;
        if (locCnt <= 0) continue;

        const locR = locCnt / local.total;
        const baseR = baseCnt / baseline.total;
        const factor = (baseR > 0) ? (locR / baseR) : Infinity;

        rows.push({
          mask: m,
          label: ctx.COMBO_LABEL[m] || ("Mask " + m),
          locCnt, baseCnt, locR, baseR, factor
        });
      }

      rows.sort((a, b) => (b.factor - a.factor));

      const focus = rows
        .filter(r => Number.isFinite(r.factor))
        .filter(r => r.baseR > 0)
        .filter(r => r.locCnt >= 3)
        .filter(r => r.factor >= 1.35)
        .slice(0, 6);

      return { local, baseline, rows, focus };
    },

    _fmtPct(x) {
      return (x * 100).toFixed(1).replace(".", ",") + " %";
    },

    _interpretMask(mask) {
      // gleiche Heuristik wie früher
      if (mask === 1) return "Überrepräsentation von 🚲-Alleinunfällen kann auf Infrastruktur-Risiken (z. B. Schienenquerungen, Kanten/Spurrinnen, Belagswechsel, Engstellen) hindeuten.";
      if (mask === 2) return "Überrepräsentation von 🚶-Alleinunfällen kann auf Querungsdefizite, Sichtbehinderungen oder Stolperstellen hinweisen.";
      if (mask === 5) return "Überrepräsentation von 🚲+🚗 deutet häufig auf Konflikte an Knotenpunkten/Abbiegesituationen, Sichtbeziehungen und Führung des Radverkehrs hin.";
      if (mask === 6) return "Überrepräsentation von 🚗+🚶 weist oft auf Querungsdefizite, Sichtbeziehungen oder hohes Geschwindigkeitsniveau hin.";
      if (mask === 3) return "Überrepräsentation von 🚲+🚶 kann auf enge Führungen, gemeinsame Flächen oder fehlende Trennung hinweisen.";
      if (mask === 7) return "Überrepräsentation von 🚲+🚗+🚶 spricht für komplexe Konfliktlagen an Knotenpunkten bzw. stark frequentierten Querungen.";
      return "Auffälligkeit kann auf lokale Führungs-/Sicht-/Querungsprobleme hinweisen; eine Ortsbegehung und Unfallkommissionsprüfung ist angezeigt.";
    },

    async computeExportReport() {
      const ctx = this._ctx;
      const bounds = this._boundsForExport();

      const sw = bounds.getSouthWest();
      const ne = bounds.getNorthEast();
      const bStr = `${sw.lat.toFixed(5)},${sw.lng.toFixed(5)} – ${ne.lat.toFixed(5)},${ne.lng.toFixed(5)}`;

      const dev = this._topDeviations(bounds);
      const yr = this._yearTable(bounds);
      const sev = this._severityStats(bounds);
      const range = this._yearsRange(ctx.allPts);

      const city = ctx.CITY_RAW;

      const severity_summary =
        (sev.bySev["1"] || 0) > 0
          ? `Im Ausschnitt wurden ${sev.bySev["1"]} Getötete, ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`
          : `Im Ausschnitt wurden ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`;

      const lines = [];
      lines.push("Bezirksratsantrag (Entwurf) – Unfallwerkbank");
      lines.push("");
      lines.push(`Stadt: ${city}`);
      if (range) lines.push(`Datenzeitraum: ${range.minY}–${range.maxY}`);
      lines.push(`Ausschnitt (Bounds): ${bStr}`);
      lines.push(`Datum: ${new Date().toLocaleDateString("de-DE")}`);
      lines.push("");
      lines.push("Sachverhalt:");
      lines.push(`Im markierten Kartenausschnitt wurden ${dev.local.total.toLocaleString()} Unfälle ausgewertet.`);
      lines.push(`Baseline (Stadt, gleiche Filter für Schwere/Zeit/Zustand): ${dev.baseline.total.toLocaleString()} Unfälle.`);
      lines.push("");
      lines.push("Verletzungsschwere (Ausschnitt):");
      lines.push(severity_summary);
      lines.push("");

      if (dev.focus.length) {
        lines.push("Auffälligkeiten (Top-Abweichungen, Anteil im Ausschnitt vs. Stadt):");
        for (const r of dev.focus) {
          lines.push(
            `- ${r.label}: lokal ${this._fmtPct(r.locR)} vs Stadt ${this._fmtPct(r.baseR)} ` +
            `(Faktor ${r.factor.toFixed(2)}); lokal ${r.locCnt} / stadtweit ${r.baseCnt}`
          );
        }
        lines.push("");
        lines.push("Bewertung / Interpretation (heuristisch):");
        for (const r of dev.focus.slice(0, 3)) {
          lines.push(`- ${r.label}: ${this._interpretMask(r.mask)}`);
        }
        lines.push("");
      } else {
        lines.push("Auffälligkeiten: In diesem Ausschnitt zeigen sich unter den gewählten Filtern keine klar überrepräsentierten Beteiligungskombinationen (Schwelle: min. 3 Fälle, Faktor ≥ 1,35).");
        lines.push("");
      }

      lines.push("Beschlussvorschlag:");
      lines.push("Der Bezirksrat bittet die Verwaltung, den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen.");
      lines.push("");
      lines.push("1) Sofortmaßnahmen (Quick Wins): Markierungen/Warnhinweise, Sichtbeziehungen herstellen, konfliktärmere Führung, Signalisierung prüfen, ggf. Tempoanpassung.");
      lines.push("2) Infrastrukturmaßnahmen: sichere Rad- und Fußführung, sichere Querungen, Oberflächen-/Kantenprüfung, Knotenpunktgestaltung.");
      lines.push("3) Monitoring: Nach Umsetzung Evaluation anhand Unfallatlas-Daten der Folgejahre.");
      lines.push("");
      lines.push("Hinweis (intern, vor Versand entfernen): Dieser Text wurde automatisiert erzeugt.");
      lines.push(`Link zur Überarbeitung: ${window.location.href}`);
      lines.push("");
      lines.push("Datenquelle/Lizenzhinweis: Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).");

      const textOut = lines.join("\n").replace(/\n{3,}/g, "\n\n");

      const mkDevRow = (r) => `
        <tr>
          <td><span class="pill">${UA.escHtml(r.label)}</span></td>
          <td style="text-align:right;">${r.locCnt.toLocaleString()}</td>
          <td style="text-align:right;">${this._fmtPct(r.locR)}</td>
          <td style="text-align:right;">${this._fmtPct(r.baseR)}</td>
          <td style="text-align:right; font-weight:900;">${r.factor.toFixed(2)}×</td>
        </tr>`;

      const mkYearRow = (row) => `
        <tr>
          <td style="width:80px;"><strong>${row.year}</strong></td>
          <td style="text-align:right; width:110px;">${row.total.toLocaleString()}</td>
          <td>${row.classes.length ? UA.escHtml(row.classes.join(", ")) : "<span style=\\"color:#777;\\">—</span>"}</td>
        </tr>`;

      const focusRows = dev.focus.length ? dev.focus : dev.rows.slice(0, 5);

      const htmlOut = `
        <div style="font:14px/1.35 system-ui;">
          <div style="font-weight:950; font-size:16px;">Report – Auffälligkeiten im markierten Bereich</div>
          <div style="color:#444; margin-top:4px;">
            <div><strong>Stadt:</strong> ${UA.escHtml(city)} | <strong>Bounds:</strong> <code>${UA.escHtml(bStr)}</code></div>
            <div><strong>Auswertung:</strong> lokal ${dev.local.total.toLocaleString()} Unfälle | Baseline ${dev.baseline.total.toLocaleString()} Unfälle</div>
            <div><strong>Datenzeitraum:</strong> ${range ? (range.minY + "–" + range.maxY) : "—"}</div>
          </div>

          <div style="margin-top:12px; font-weight:900;">Top-Abweichungen</div>
          <table class="report">
            <thead>
              <tr><th>Muster</th><th style="text-align:right;">lokal</th><th style="text-align:right;">lokal %</th><th style="text-align:right;">Stadt %</th><th style="text-align:right;">Faktor</th></tr>
            </thead>
            <tbody>
              ${focusRows.filter(r => r.locCnt > 0).map(mkDevRow).join("") || "<tr><td colspan=\\"5\\" style=\\"color:#777;\\">—</td></tr>"}
            </tbody>
          </table>

          <div style="margin-top:12px; font-weight:900;">Unfälle pro Jahr (im Ausschnitt; ohne Doppelzählung)</div>
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
              <tr><td>1 – Getötete</td><td style="text-align:right;">${sev.bySev["1"]||0}</td><td style="text-align:right;">${sev.total?this._fmtPct((sev.bySev["1"]||0)/sev.total):"0,0 %"}</td></tr>
              <tr><td>2 – Schwerverletzte</td><td style="text-align:right;">${sev.bySev["2"]||0}</td><td style="text-align:right;">${sev.total?this._fmtPct((sev.bySev["2"]||0)/sev.total):"0,0 %"}</td></tr>
              <tr><td>3 – Leichtverletzte</td><td style="text-align:right;">${sev.bySev["3"]||0}</td><td style="text-align:right;">${sev.total?this._fmtPct((sev.bySev["3"]||0)/sev.total):"0,0 %"}</td></tr>
            </tbody>
          </table>

          <div style="margin-top:10px; color:#555; font-size:12px;">
            <div><strong>Methodik:</strong> Verglichen wird die Verteilung exakter Beteiligungskombinationen im Ausschnitt vs. stadtweit – jeweils unter denselben Filtern für Unfallschwere, Fahrbahnzustand, Wochentag und Uhrzeit.</div>
            <div><strong>Hinweis:</strong> Heuristisch – ersetzt keine Unfallkommission/Ortsbegehung.</div>
          </div>
        </div>
      `;

      return { text: textOut, html: htmlOut };
    },

    // --------------------
    // Clipboard
    // --------------------
    async _writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, 999999);
        try { document.execCommand("copy"); } catch {}
        ta.remove();
        return false;
      }
    }
  };

  UA.Export = Export;
})();