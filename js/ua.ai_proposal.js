/**
 * UA.aiProposal — frontend hookup for the optional, server-side
 * AI proposal-brief generator (#E1) plus a user-owned prompt export.
 *
 * The server-side AI path remains optional and uses the Docker/server
 * provider configuration (`server/ai/`). The user-owned prompt path added
 * here deliberately does not call ChatGPT, Gemini or any other model API:
 * it packages the deterministic Unfallwerkbank facts into a prompt that the
 * user can copy/download and paste into their own AI account.
 *
 * Server AI path:
 *   1. Compute the deterministic export report (re-uses `UA.computeExportReport`).
 *   2. POST the `structured` payload to `/api/ai/export-assessment/v2?mode=proposal-brief`.
 *   3. Render the returned `proposalBrief.v1` JSON as a read-only HTML panel
 *      and copy the long-form text into the `exportBoxTa` textarea so the
 *      user can paste it into Word/eMail/etc.
 *
 * User-owned prompt path:
 *   1. Compute the same deterministic report.
 *   2. Build a self-contained Markdown prompt containing rules, map link,
 *      structured facts and deterministic report text.
 *   3. Let the user copy or download that prompt/facts package and open
 *      ChatGPT/Gemini manually. No token/API cost is incurred by Unfallwerkbank.
 */
(() => {
  const root = (typeof window !== "undefined") ? window : globalThis;
  const UA = root.UA = root.UA || {};

  const EXTERNAL_AI_FACTS_SCHEMA = "unfallwerkbank.externalAiPromptFacts.v1";
  const EXTERNAL_AI_PROMPT_SCHEMA = "unfallwerkbank.externalAiPrompt.v1";

  /**
   * Wire up the AI button and the user-owned prompt controls. Called once
   * during app init when both DOM and `UA.computeExportReport` are available.
   *
   * @param {object} ctx – the same context object passed to other UA modules.
   */
  function wire(ctx) {
    const btn        = document.getElementById("btnAiProposal");
    const statusEl   = document.getElementById("aiProposalStatus");
    const resultEl   = document.getElementById("aiProposalResult");
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
        mirrorExportOptions(ctx);

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

    ensureExternalPromptControls(ctx);
  }

  function setStatus(el, msg) { if (el) el.textContent = msg || ""; }

  function labelForSource(s) {
    switch (s) {
      case "ai":          return "KI-generiert";
      case "ai-repaired": return "KI-generiert, schemarepariert";
      case "cache":       return "aus Cache";
      case "fallback":    return "deterministischer Fallback ohne KI";
      default:             return s || "unbekannte Quelle";
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

  function ensureExternalPromptControls(ctx) {
    const host = document.getElementById("aiProposalSection");
    if (!host || document.getElementById("btnAiPromptCopy")) return;

    const wrap = document.createElement("div");
    wrap.id = "externalAiPromptPanel";
    wrap.style.cssText = "margin-top:12px; padding-top:10px; border-top:1px solid rgba(0,0,0,.12);";
    wrap.innerHTML = `
      <div style="font-size:12px; color:#555; line-height:1.45; margin-bottom:8px;">
        <strong>Eigenes KI-Konto nutzen:</strong>
        Die Unfallwerkbank kann ein vollständiges Promptpaket erzeugen. Es wird nichts automatisch an ChatGPT, Gemini oder andere KI-Dienste gesendet; Nutzer:innen kopieren oder laden den Prompt und verwenden ihn selbst im eigenen Konto.
      </div>
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <button id="btnAiPromptCopy" type="button"
                title="Erzeugt einen vollständigen Prompt und kopiert ihn in die Zwischenablage. Keine Daten werden automatisch an KI-Dienste gesendet."
                style="padding:8px 12px; background:#315f9e; color:white; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:6px;">
          <span aria-hidden="true">📋</span> Prompt für ChatGPT/Gemini kopieren
        </button>
        <button id="btnAiPromptDownloadMd" type="button"
                style="padding:8px 12px; background:#555; color:white; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:6px;">
          <span aria-hidden="true">⬇</span> Prompt .md
        </button>
        <button id="btnAiFactsDownloadJson" type="button"
                style="padding:8px 12px; background:#555; color:white; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:6px;">
          <span aria-hidden="true">{ }</span> Fakten .json
        </button>
        <button id="btnOpenChatGpt" type="button"
                title="Öffnet ChatGPT in einem neuen Tab. Den kopierten Prompt dort selbst einfügen."
                style="padding:8px 12px; background:#f5f5f5; color:#222; border:1px solid rgba(0,0,0,.18); border-radius:10px; font-weight:700; cursor:pointer; font-size:12px;">
          ChatGPT öffnen
        </button>
        <button id="btnOpenGemini" type="button"
                title="Öffnet Gemini in einem neuen Tab. Den kopierten Prompt dort selbst einfügen."
                style="padding:8px 12px; background:#f5f5f5; color:#222; border:1px solid rgba(0,0,0,.18); border-radius:10px; font-weight:700; cursor:pointer; font-size:12px;">
          Gemini öffnen
        </button>
        <span id="aiPromptStatus" style="font-size:12px; color:#555;" role="status" aria-live="polite"></span>
      </div>
    `;
    host.appendChild(wrap);

    const btnCopy = document.getElementById("btnAiPromptCopy");
    const btnPromptDownload = document.getElementById("btnAiPromptDownloadMd");
    const btnFactsDownload = document.getElementById("btnAiFactsDownloadJson");
    const btnChatGpt = document.getElementById("btnOpenChatGpt");
    const btnGemini = document.getElementById("btnOpenGemini");
    const statusEl = document.getElementById("aiPromptStatus");

    btnCopy.addEventListener("click", async () => {
      await withPromptPackage(ctx, statusEl, async ({ prompt }) => {
        await writeClipboard(prompt);
        setStatus(statusEl, "Prompt kopiert. Jetzt in ChatGPT/Gemini einfügen.");
      });
    });

    btnPromptDownload.addEventListener("click", async () => {
      await withPromptPackage(ctx, statusEl, async ({ prompt, promptFilename }) => {
        downloadTextFile(promptFilename, "text/markdown;charset=utf-8", prompt);
        setStatus(statusEl, "Prompt-Datei heruntergeladen.");
      });
    });

    btnFactsDownload.addEventListener("click", async () => {
      await withPromptPackage(ctx, statusEl, async ({ facts, factsFilename }) => {
        downloadTextFile(factsFilename, "application/json;charset=utf-8", stableJson(facts));
        setStatus(statusEl, "Faktenpaket heruntergeladen.");
      });
    });

    btnChatGpt.addEventListener("click", () => openAiSurface("https://chatgpt.com/", statusEl));
    btnGemini.addEventListener("click", () => openAiSurface("https://gemini.google.com/app", statusEl));
  }

  async function withPromptPackage(ctx, statusEl, fn) {
    setStatus(statusEl, "Erzeuge Promptpaket …");
    try {
      const pkg = await generateExternalAiPromptPackage(ctx);
      await fn(pkg);
    } catch (e) {
      setStatus(statusEl, "Fehler: " + (e && e.message || e));
    }
  }

  function mirrorExportOptions(ctx) {
    const cbCosts    = document.getElementById("cbIncludeCosts");
    const cbMeasures = document.getElementById("cbIncludeMeasures");
    const cbHeatmap  = document.getElementById("cbIncludeHeatmap");
    const cbOsm      = document.getElementById("cbIncludeOsmContext");
    const cbPol      = document.getElementById("cbPoliticalLanguage");
    ctx.exportOptions = Object.assign({}, ctx.exportOptions, {
      includeCosts:      cbCosts    ? cbCosts.checked    : (ctx.exportOptions ? ctx.exportOptions.includeCosts      !== false : true),
      includeMeasures:   cbMeasures ? cbMeasures.checked : (ctx.exportOptions ? ctx.exportOptions.includeMeasures   !== false : true),
      includeHeatmap:    cbHeatmap  ? cbHeatmap.checked  : (ctx.exportOptions ? ctx.exportOptions.includeHeatmap    !== false : true),
      includeOsmContext: cbOsm      ? cbOsm.checked      : (ctx.exportOptions ? ctx.exportOptions.includeOsmContext !== false : true),
      mode: (cbPol && cbPol.checked) ? "political" : (ctx.exportOptions && ctx.exportOptions.mode) || "technical"
    });
  }

  async function generateExternalAiPromptPackage(ctx) {
    if (!UA || typeof UA.computeExportReport !== "function") {
      throw new Error("Exportbericht kann nicht erzeugt werden.");
    }
    const normalizedCtx = ctx || {};
    mirrorExportOptions(normalizedCtx);
    const report = await UA.computeExportReport(normalizedCtx);
    const structured = report && report.structured;
    if (!structured) {
      throw new Error("Kein strukturierter Export verfügbar (bitte Bereich markieren oder Export erneut öffnen).");
    }
    const now = new Date().toISOString();
    const mapUrl = buildCurrentMapUrl(normalizedCtx);
    const facts = buildExternalAiFactsPackage({
      structured,
      deterministicReportText: report.text || "",
      mapUrl,
      generatedAt: now,
      city: extractCity(structured, normalizedCtx)
    });
    const prompt = buildExternalAiPrompt(facts);
    const base = filenameBase(facts.city, now);
    return {
      facts,
      prompt,
      factsFilename: `${base}_facts.json`,
      promptFilename: `${base}_ki_prompt.md`
    };
  }

  function buildExternalAiFactsPackage(input) {
    const structured = input && input.structured;
    const city = input && input.city || extractCity(structured || {}, {});
    return {
      schemaVersion: EXTERNAL_AI_FACTS_SCHEMA,
      createdAt: input && input.generatedAt || new Date().toISOString(),
      generator: "Unfallwerkbank",
      intendedUse: "Nutzerseitige Antragserstellung in einem eigenen KI-Konto",
      privacyNote: "Dieses Paket wurde lokal in der Unfallwerkbank erzeugt. Es wird erst an einen KI-Dienst übermittelt, wenn Nutzer:innen es selbst kopieren, hochladen oder einfügen.",
      city,
      mapUrl: input && input.mapUrl || "",
      structured,
      deterministicReportText: input && input.deterministicReportText || ""
    };
  }

  function buildExternalAiPrompt(facts) {
    const city = facts && facts.city ? facts.city : "der ausgewählten Kommune";
    const mapUrl = facts && facts.mapUrl ? facts.mapUrl : "(kein Kartenlink verfügbar)";
    return [
      `# KI-Prompt für einen kommunalpolitischen Antrag (${city})`,
      "",
      `Prompt-Schema: ${EXTERNAL_AI_PROMPT_SCHEMA}`,
      `Erzeugt am: ${facts && facts.createdAt || "unbekannt"}`,
      "",
      "## Aufgabe",
      "Du unterstützt eine kommunalpolitische Antragstellung auf Grundlage eines Unfallwerkbank-Exports. Erstelle einen sachlichen, prüffähigen Antrag in deutscher Sprache.",
      "",
      "Nutze ausschließlich die unten übergebenen Fakten. Erfinde keine Unfallzahlen, Ursachen, Ortsnamen, Behördenzuständigkeiten oder politischen Vorgänge. Wenn Angaben fehlen, formuliere transparent als Prüfauftrag.",
      "",
      "## Sicherheits- und Qualitätsregeln",
      "- Behaupte keine gesicherten Unfallursachen allein aus Unfallatlasdaten, OSM-/GIS-Kontext, Orthofotos oder Kartenbildern.",
      "- Trenne klar zwischen amtlichen Unfallattributen, rechnerisch/GIS-abgeleiteten Hinweisen, sichtbaren Kontextindizien und Empfehlungen zur fachlichen Detailprüfung.",
      "- Formuliere vorsichtig mit Begriffen wie „Hinweis“, „auffällig“, „möglicherweise relevant“, „prüfbedürftig“, „Detailprüfung empfohlen“.",
      "- Verwende den Kartenlink nur als Nachprüf- und Visualisierungshilfe; die maßgeblichen Fakten stehen im JSON-Paket und im deterministischen Bericht.",
      "- Wenn Datenbasis oder Fallzahl schwach ist, kennzeichne die Unsicherheit statt den Befund rhetorisch zu überhöhen.",
      "- Erzeuge keine personenbezogenen Annahmen und keine Schuldzuweisungen.",
      "",
      "## Gewünschte Ausgabe",
      "1. Antragstitel",
      "2. Beschlussvorschlag",
      "3. Sachverhalt mit Bezug auf Untersuchungsraum, Filter und Fallzahlen",
      "4. Begründung mit vorsichtiger Interpretation",
      "5. Prüfauftrag an die Verwaltung",
      "6. Maßnahmenvorschläge als prüfbare Optionen, nicht als feststehende Ursache-Wirkung-Behauptung",
      "7. Hinweise zu Datenbasis, Unsicherheiten und Anlagen/Kartenlink",
      "",
      "## Kartenlink zur Prüfung",
      mapUrl,
      "",
      "## Faktenpaket der Unfallwerkbank (JSON)",
      "```json",
      stableJson(facts),
      "```",
      "",
      "## Hinweis zum Nutzungsmodell",
      "Dieser Prompt wurde von der Unfallwerkbank erzeugt, aber es wird nichts automatisch an einen KI-Dienst gesendet. Die weitere Verarbeitung erfolgt erst, wenn Nutzer:innen diesen Prompt selbst in ChatGPT, Gemini oder ein anderes Werkzeug ihres eigenen Kontos einfügen."
    ].join("\n");
  }

  function extractCity(structured, ctx) {
    return (structured && structured.meta && (structured.meta.city || structured.meta.cityRaw))
      || (ctx && (ctx.CITY_RAW || ctx.city))
      || "unbekannte-stadt";
  }

  function buildCurrentMapUrl(ctx) {
    try {
      if (typeof UA.syncAllToUrl === "function" && ctx && ctx.ui) {
        UA.syncAllToUrl(ctx);
      }
      if (root.location && root.location.href) {
        const url = new URL(root.location.href);
        url.searchParams.set("export", "1");
        return url.href;
      }
    } catch (_) { /* ignore */ }
    return root.location && root.location.href || "";
  }

  async function writeClipboard(text) {
    const nav = root.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === "function") {
      await nav.clipboard.writeText(text);
      return true;
    }
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "readonly");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, 999999);
    try { document.execCommand("copy"); }
    finally { ta.remove(); }
    return false;
  }

  function downloadTextFile(filename, mime, text) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = root.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => root.URL.revokeObjectURL(url), 0);
  }

  function openAiSurface(url, statusEl) {
    try {
      const popup = root.open(url, "_blank", "noopener,noreferrer");
      if (!popup) {
        setStatus(statusEl, "Öffnen blockiert (Popup-Blocker). Bitte ChatGPT/Gemini manuell öffnen und den Prompt einfügen.");
        return;
      }
      setStatus(statusEl, "KI-Oberfläche geöffnet. Den kopierten Prompt dort einfügen.");
    } catch (e) {
      setStatus(statusEl, "Öffnen fehlgeschlagen: " + (e && e.message || e));
    }
  }

  function stableJson(value) {
    return JSON.stringify(sortJsonKeys(value), null, 2);
  }

  function sortJsonKeys(value) {
    if (!value || typeof value !== "object") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(sortJsonKeys);
    }
    const out = {};
    Object.keys(value).sort().forEach((key) => {
      out[key] = sortJsonKeys(value[key]);
    });
    return out;
  }

  function filenameBase(city, iso) {
    const d = String(iso || new Date().toISOString()).slice(0, 10);
    const c = String(city || "unfallwerkbank")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unfallwerkbank";
    return `${c}_${d}`;
  }

  UA.aiProposal = {
    wire,
    _internal: {
      buildPlainText,
      labelForSource,
      mirrorExportOptions,
      buildExternalAiFactsPackage,
      buildExternalAiPrompt,
      generateExternalAiPromptPackage,
      filenameBase
    }
  };
})();