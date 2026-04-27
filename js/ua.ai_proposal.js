/**
 * UA.aiProposal — frontend hookup for the optional, server-side
 * AI proposal-brief generator (#E1).
 *
 * The actual AI logic — prompt builder, Gemini provider, schema validation,
 * caching — lives in `server/ai/` and ships inside the Docker image.  This
 * module is a thin client:
 *
 *   1. Compute the deterministic export report (re-uses `UA.computeExportReport`).
 *   2. POST the `structured` payload to `/api/ai/export-assessment/v2?mode=proposal-brief`.
 *   3. Render the returned `proposalBrief.v1` JSON as a read-only HTML panel
 *      and copy the long-form text into the `exportBoxTa` textarea so the
 *      user can paste it into Word/eMail/etc.
 *
 * Robustness:
 *   - 503 (`AI_NOT_CONFIGURED`) → friendly hint that the operator hasn't set
 *     `GEMINI_API_KEY`. The deterministic report itself remains untouched.
 *   - 200 with `source:"fallback"` → still rendered, but labelled as such so
 *     readers know the text is the deterministic baseline, not LLM-generated.
 *   - any other failure → status line shows the error message.
 */
(() => {
  const root = (typeof window !== "undefined") ? window : globalThis;
  const UA = root.UA = root.UA || {};

  /**
   * Wire up the AI button. Called once during app init when both DOM and
   * `UA.computeExportReport` are available.
   *
   * @param {object} ctx – the same context object passed to other UA modules.
   */
  function wire(ctx) {
    const btn       = document.getElementById("btnAiProposal");
    const statusEl  = document.getElementById("aiProposalStatus");
    const resultEl  = document.getElementById("aiProposalResult");
    const textareaEl = document.getElementById("exportBoxTa");
    if (!btn || !statusEl || !resultEl) return;

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const originalLabel = btn.innerHTML;
      btn.innerHTML = '<span aria-hidden="true">⏳</span> KI fragt …';
      setStatus(statusEl, "Sende Daten an Server …");
      resultEl.style.display = "none";
      resultEl.innerHTML = "";

      try {
        // Mirror the modal toggles into ctx.exportOptions so the AI request
        // sees exactly the same `structured` shape the user will download
        // (and we don't trigger an unwanted Overpass call when the user has
        // unchecked the OSM-Kontext toggle). Mirrors the logic in
        // js/ua.app_v2.js#rerenderExportReport.
        const cbCosts    = document.getElementById("cbIncludeCosts");
        const cbMeasures = document.getElementById("cbIncludeMeasures");
        const cbHeatmap  = document.getElementById("cbIncludeHeatmap");
        const cbOsm      = document.getElementById("cbIncludeOsmContext");
        ctx.exportOptions = Object.assign({}, ctx.exportOptions, {
          includeCosts:      cbCosts    ? cbCosts.checked    : (ctx.exportOptions ? ctx.exportOptions.includeCosts      !== false : true),
          includeMeasures:   cbMeasures ? cbMeasures.checked : (ctx.exportOptions ? ctx.exportOptions.includeMeasures   !== false : true),
          includeHeatmap:    cbHeatmap  ? cbHeatmap.checked  : (ctx.exportOptions ? ctx.exportOptions.includeHeatmap    !== false : true),
          includeOsmContext: cbOsm      ? cbOsm.checked      : (ctx.exportOptions ? ctx.exportOptions.includeOsmContext !== false : true)
        });

        // Reuse the deterministic export pipeline so the AI sees exactly the
        // same `structured` object the user would download as Word/PDF.
        const report = await UA.computeExportReport(ctx);
        const structured = report && report.structured;
        if (!structured) {
          throw new Error("Kein strukturierter Export verfügbar (bitte Bereich markieren).");
        }

        setStatus(statusEl, "KI bewertet …");
        const resp = await fetch("/api/ai/export-assessment/v2?mode=proposal-brief", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ structured, mode: "proposal-brief", withFallback: true })
        });

        if (resp.status === 503) {
          setStatus(statusEl, "KI nicht konfiguriert – serverseitiger GEMINI_API_KEY fehlt. Der deterministische Antrag oben ist weiterhin nutzbar.");
          return;
        }
        if (!resp.ok) {
          let detail = "";
          try { detail = (await resp.json()).message || ""; } catch (_) { /* ignore */ }
          throw new Error(`HTTP ${resp.status}${detail ? " – " + detail : ""}`);
        }

        const payload = await resp.json();
        const result  = payload && payload.result;
        if (!result || !result.shortVersion) {
          throw new Error("Antwort enthält keinen Antragstext.");
        }

        renderResult(resultEl, payload);
        if (textareaEl) {
          // Append, don't overwrite — the user may have manual edits in the
          // textarea. The marker line makes it easy to remove later.
          const marker = `\n\n--- KI-Antragsentwurf (Quelle: ${payload.source}) ---\n`;
          textareaEl.value = (textareaEl.value || "") + marker + buildPlainText(result);
        }
        const sourceLabel = labelForSource(payload.source);
        setStatus(statusEl, `Fertig (${sourceLabel}). Text auch im Kopierfeld unten.`);
      } catch (e) {
        setStatus(statusEl, "Fehler: " + (e && e.message || e));
      } finally {
        btn.disabled = false;
        btn.innerHTML = originalLabel;
      }
    });
  }

  function setStatus(el, msg) { el.textContent = msg || ""; }

  function labelForSource(s) {
    switch (s) {
      case "ai":          return "KI-generiert";
      case "ai-repaired": return "KI-generiert, schemarepariert";
      case "cache":       return "aus Cache";
      case "fallback":    return "deterministischer Fallback ohne KI";
      default:            return s || "unbekannte Quelle";
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderResult(el, payload) {
    const r = payload.result;
    const sourceLabel = labelForSource(payload.source);
    const measures = Array.isArray(r.measureSummary) ? r.measureSummary : [];
    const caveats  = Array.isArray(r.caveats) ? r.caveats : [];
    const html = `
      <div style="border-left:4px solid #5a3fa0; padding:8px 12px; background:#fff;">
        <div style="font-size:11px; color:#666; margin-bottom:6px;">
          Quelle: <strong>${esc(sourceLabel)}</strong>${payload.fallbackReason ? ` &middot; ${esc(payload.fallbackReason)}` : ""}
        </div>
        <h4 style="margin:0 0 6px 0; font-size:15px;">${esc(r.title || "Antragsentwurf")}</h4>
        <div style="margin-bottom:8px;"><strong>Kurzfassung:</strong><br>${esc(r.shortVersion)}</div>
        <details style="margin-bottom:8px;">
          <summary style="cursor:pointer; font-weight:700;">Langfassung</summary>
          <div style="margin-top:6px; white-space:pre-wrap;">${esc(r.longVersion || "")}</div>
        </details>
        <div style="margin-bottom:6px;"><strong>Beschlussvorschlag:</strong><br>${esc(r.beschlussvorschlag || "")}</div>
        <div style="margin-bottom:6px;"><strong>Prüfauftrag:</strong><br>${esc(r.pruefauftrag || "")}</div>
        ${measures.length ? `
          <div style="margin-bottom:6px;"><strong>Maßnahmen:</strong>
            <ul style="margin:4px 0 0 18px; padding:0;">
              ${measures.map(m => `<li>${esc(m.title)}${m.category ? ` <em style="color:#666;">[${esc(m.category)}]</em>` : ""}</li>`).join("")}
            </ul>
          </div>` : ""}
        ${caveats.length ? `
          <div style="font-size:12px; color:#7a4a00;"><strong>Hinweise:</strong>
            <ul style="margin:4px 0 0 18px; padding:0;">${caveats.map(c => `<li>${esc(c)}</li>`).join("")}</ul>
          </div>` : ""}
      </div>
    `;
    el.innerHTML = html;
    el.style.display = "block";
  }

  function buildPlainText(r) {
    const parts = [];
    if (r.title)              parts.push(`# ${r.title}`);
    if (r.shortVersion)       parts.push(`Kurzfassung:\n${r.shortVersion}`);
    if (r.longVersion)        parts.push(`Langfassung:\n${r.longVersion}`);
    if (r.sachverhalt)        parts.push(`Sachverhalt:\n${r.sachverhalt}`);
    if (r.begruendung)        parts.push(`Begründung:\n${r.begruendung}`);
    if (r.beschlussvorschlag) parts.push(`Beschlussvorschlag:\n${r.beschlussvorschlag}`);
    if (r.pruefauftrag)       parts.push(`Prüfauftrag:\n${r.pruefauftrag}`);
    if (Array.isArray(r.caveats) && r.caveats.length) {
      parts.push("Hinweise:\n" + r.caveats.map(c => "- " + c).join("\n"));
    }
    return parts.join("\n\n");
  }

  UA.aiProposal = { wire, _internal: { buildPlainText, labelForSource } };
})();
