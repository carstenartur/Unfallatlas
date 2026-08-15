/**
 * UA.aiHandoff — complete user-owned AI handoff package.
 *
 * The existing prompt export intentionally stays text-only. This module adds
 * a deterministic ZIP package that binds one export snapshot to the facts,
 * rendered report, overview/detail/cluster maps and the available trend and
 * hour/day heatmap SVGs. No data is sent to an AI service automatically.
 */
(function initAiHandoff(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.aiHandoff = api;
    try {
      api.install(UA, root);
    } catch (error) {
      UA.aiHandoffError = error;
      root.console?.error?.("KI-Übergabepaket konnte nicht initialisiert werden", error);
    }
  }
})(typeof window !== "undefined" ? window : null, function createAiHandoffApi(root) {
  "use strict";

  const PACKAGE_SCHEMA = "unfallwerkbank.aiHandoff.v1";
  const PACKAGE_MEDIA_TYPE = "application/zip";
  const PNG_PREFIX = "data:image/png;base64,";

  class AiHandoffError extends Error {
    constructor(code, message, details) {
      super(`${code}: ${message}`);
      this.name = "AiHandoffError";
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new AiHandoffError(code, message, details);
  }

  function utf8Bytes(value) {
    if (value instanceof Uint8Array) return value;
    if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) {
      return new Uint8Array(value);
    }
    if (typeof value !== "string") fail("invalid_content", "Dateiinhalt muss Text oder Uint8Array sein");
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(value);
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "utf8"));
    fail("utf8_unavailable", "UTF-8-Kodierung ist nicht verfügbar");
  }

  function decodeBase64(value) {
    if (typeof root?.atob === "function") {
      const binary = root.atob(value);
      return Uint8Array.from(binary, character => character.charCodeAt(0));
    }
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"));
    fail("base64_unavailable", "Base64-Dekodierung ist nicht verfügbar");
  }

  function pngBytesFromDataUrl(value) {
    if (typeof value !== "string" || !value.startsWith(PNG_PREFIX)) {
      fail("invalid_png_data_url", "Kartenaufnahme ist keine PNG-Data-URL");
    }
    const bytes = decodeBase64(value.slice(PNG_PREFIX.length));
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.byteLength < signature.length || signature.some((byte, index) => bytes[index] !== byte)) {
      fail("invalid_png", "Kartenaufnahme enthält keine gültige PNG-Signatur");
    }
    return bytes;
  }

  function sortJsonKeys(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(sortJsonKeys);
    const out = {};
    Object.keys(value).sort().forEach(key => { out[key] = sortJsonKeys(value[key]); });
    return out;
  }

  function stableJson(value) {
    return `${JSON.stringify(sortJsonKeys(value), null, 2)}\n`;
  }

  function safeSlug(value, fallback = "unfallwerkbank") {
    return String(value || fallback)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
  }

  function xmlEscape(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  function currentMapUrl(UA, ctx) {
    try {
      if (typeof UA.syncAllToUrl === "function" && ctx?.ui) UA.syncAllToUrl(ctx);
      if (root?.location?.href) {
        const url = new URL(root.location.href);
        url.searchParams.set("export", "1");
        return url.href;
      }
    } catch (_) { /* retain fallback below */ }
    return root?.location?.href || "";
  }

  function applicationState(ctx, mapUrl) {
    const bounds = ctx?.selectionBounds;
    const sw = bounds?.getSouthWest?.();
    const ne = bounds?.getNorthEast?.();
    const center = ctx?.map?.getCenter?.();
    const zoom = ctx?.map?.getZoom?.();
    return {
      mapUrl,
      city: ctx?.CITY_RAW || ctx?.city || null,
      exportOptions: ctx?.exportOptions || {},
      selectionBounds: sw && ne ? {
        south: Number(sw.lat),
        west: Number(sw.lng),
        north: Number(ne.lat),
        east: Number(ne.lng),
      } : null,
      mapView: center ? {
        latitude: Number(center.lat),
        longitude: Number(center.lng),
        zoom: Number.isFinite(Number(zoom)) ? Number(zoom) : null,
      } : null,
    };
  }

  async function waitForDependencies(UA) {
    const ready = UA.exportProvenanceReady;
    if (ready && typeof ready.then === "function") await ready;
    if (!UA.zip?.createStoredZip) fail("missing_zip", "Deterministischer ZIP-Writer ist nicht geladen");
    if (!UA.artifactProvenance?.sha256) fail("missing_hash", "SHA-256-Provenienzmodul ist nicht geladen");
    if (!UA.aiProposal?._internal?.buildExternalAiFactsPackage ||
        !UA.aiProposal?._internal?.buildExternalAiPrompt ||
        !UA.aiProposal?._internal?.mirrorExportOptions) {
      fail("missing_prompt_export", "Textbasierter KI-Export ist nicht vollständig geladen");
    }
    if (typeof UA.computeExportReport !== "function") {
      fail("missing_report", "Exportbericht kann nicht erzeugt werden");
    }
    if (typeof UA.captureExportMapImage !== "function") {
      fail("missing_map_capture", "Kartenaufnahme ist nicht verfügbar");
    }
  }

  async function describeEntry(UA, entry) {
    const bytes = utf8Bytes(entry.content);
    return {
      path: entry.name,
      mediaType: entry.mediaType,
      role: entry.role,
      caption: entry.caption || null,
      bytes: bytes.byteLength,
      sha256: await UA.artifactProvenance.sha256(bytes),
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
    };
  }

  function graphicInstructionLines(graphics) {
    if (!graphics.length) return ["- Keine Grafiken vorhanden — Paket darf in diesem Zustand nicht als vollständig bewertet werden."];
    return graphics.map(graphic => {
      const count = Number.isFinite(Number(graphic.metadata?.accidentCount))
        ? `; dargestellte Unfälle: ${Number(graphic.metadata.accidentCount)}`
        : "";
      return `- \`${graphic.name}\`: ${graphic.caption}${count}`;
    });
  }

  function enrichPrompt(basePrompt, graphics) {
    return [
      basePrompt,
      "",
      "## Verbindliche Anlagen dieses Medienpakets",
      "Dieser Prompt ist nur zusammen mit den nachfolgend genannten Dateien vollständig. Öffne beziehungsweise analysiere jede Grafik; ersetze ihren Inhalt nicht durch Vermutungen aus dem Kartenlink.",
      "",
      ...graphicInstructionLines(graphics),
      "",
      "Zusätzlich gehören `facts.json`, `report.md`, `report.html`, `application-state.json` und `manifest.json` zum selben, unveränderlichen Export-Snapshot.",
      "",
      "## Regeln für die Auswertung der Grafiken",
      "- Beschreibe zuerst objektiv, was in jeder Grafik sichtbar ist, und nenne den Dateinamen.",
      "- Prüfe sichtbare Unfallpunkte, Auswahlgrenze, Legende und räumliche Zuordnung gegen die Fallzahlen im Faktenpaket.",
      "- Nutze sichtbare Straßen-, Steigungs-, Verkehrs- oder Orthofotohinweise nur als Kontextindizien, niemals als bewiesene Unfallursache.",
      "- Melde Widersprüche zwischen Grafik, Text, Tabellen und JSON ausdrücklich; gleiche sie nicht stillschweigend an.",
      "- Fehlt beim KI-Upload eine im Manifest aufgeführte Datei, stoppe und benenne genau die fehlende Anlage.",
    ].join("\n");
  }

  function reportMarkdown(facts) {
    return [
      `# Deterministischer Unfallwerkbank-Bericht (${facts.city || "unbekannte Kommune"})`,
      "",
      `Erzeugt: ${facts.createdAt}`,
      "",
      "## Kartenlink",
      facts.mapUrl || "Kein Kartenlink verfügbar.",
      "",
      "## Berichtstext",
      facts.deterministicReportText || "Kein Berichtstext verfügbar.",
      "",
    ].join("\n");
  }

  function readmeMarkdown(manifest) {
    const graphics = manifest.files.filter(file => file.role?.startsWith("graphic"));
    return [
      "# Unfallwerkbank – KI-Übergabepaket",
      "",
      "Dieses ZIP enthält **einen gebundenen Analyse-Snapshot mit Text, strukturierten Fakten und den zugehörigen Grafiken**. Es wurde lokal im Browser erzeugt und nicht automatisch an einen KI-Dienst gesendet.",
      "",
      "## Verwendung in ChatGPT, Gemini oder einem anderen eigenen KI-Konto",
      "1. ZIP lokal entpacken.",
      "2. `prompt.md`, `facts.json`, `manifest.json` und **alle Dateien im Ordner `graphics/`** gemeinsam hochladen.",
      "3. `prompt.md` als Arbeitsauftrag verwenden.",
      "4. Prüfen, ob das KI-Werkzeug alle im Manifest genannten Dateien tatsächlich erkannt hat.",
      "",
      "Das Hochladen nur des ZIP-Archivs ist nicht ausreichend, wenn das gewählte KI-Werkzeug Archive nicht selbst entpackt oder einzelne Bilddateien daraus nicht verarbeitet.",
      "",
      "## Enthaltene Grafiken",
      ...graphics.map(file => `- \`${file.path}\`: ${file.caption || file.role}`),
      "",
      "## Vollständigkeits- und Konsistenzvertrag",
      "- `manifest.json` enthält SHA-256, Dateigröße, Rolle und Bildmetadaten.",
      "- Übersichtskarte und bei vorhandener Auswahl die Detailkarte sind Pflichtbestandteile; ihre Aufnahme scheitert fail-closed.",
      "- Clusterkarten werden nur aufgenommen, wenn ihre sichtbare Punktzahl zur angegebenen Fallzahl passt.",
      "- Trend- und Stunden-Heatmap werden als eigenständige SVG-Dateien beigefügt, sofern der strukturierte Bericht sie enthält.",
      "- Der Kartenlink ist eine Prüfhilfe und kein Ersatz für die beigefügten Grafiken.",
      "",
      `Paket-Schema: ${manifest.schemaVersion}`,
      `Erzeugt: ${manifest.createdAt}`,
      `Stadt: ${manifest.city}`,
      "",
    ].join("\n");
  }

  async function captureGraphics(UA, ctx, structured, progress) {
    const graphics = [];
    const options = { ...(ctx?.exportOptions || {}) };
    const notify = message => { if (typeof progress === "function") progress(message); };

    notify("Erzeuge Übersichtskarte …");
    const overview = await UA.captureExportMapImage(ctx, options);
    graphics.push({
      name: "graphics/01-uebersichtskarte.png",
      mediaType: "image/png",
      role: "graphic.overview-map",
      caption: "Übersichtskarte des aktiven Unfallwerkbank-Ausschnitts mit aktueller Filterung",
      content: pngBytesFromDataUrl(overview),
      metadata: {
        accidentCount: Number(structured?.summary?.totalAccidents ?? structured?.counts?.total ?? NaN),
        mapUrl: currentMapUrl(UA, ctx),
      },
    });

    if (ctx?.selectionBounds) {
      if (typeof UA._captureDetailMap !== "function") {
        fail("missing_detail_capture", "Für die vorhandene Auswahl ist keine Detailkartenaufnahme verfügbar");
      }
      notify("Erzeuge Detailkarte …");
      const detail = await UA._captureDetailMap(ctx, options);
      graphics.push({
        name: "graphics/02-detailkarte.png",
        mediaType: "image/png",
        role: "graphic.detail-map",
        caption: "Detailkarte der markierten Auswahl mit Unfallpunkten",
        content: pngBytesFromDataUrl(detail),
        metadata: {
          accidentCount: Number(structured?.summary?.totalAccidents ?? structured?.counts?.total ?? NaN),
          mapUrl: currentMapUrl(UA, ctx),
        },
      });
    }

    if (typeof UA._captureClusterMaps === "function") {
      notify("Erzeuge Clusterkarten …");
      const clusters = await UA._captureClusterMaps(ctx, options);
      let index = 0;
      for (const cluster of clusters || []) {
        const total = Number(cluster?.total);
        const visible = Array.isArray(cluster?.points) ? cluster.points.length : null;
        if (visible != null && Number.isFinite(total) && visible !== total) {
          fail("cluster_count_mismatch", `Clusterkarte ${cluster?.label || index + 1} zeigt ${visible} statt ${total} Unfallpunkte`, {
            label: cluster?.label || null,
            visible,
            total,
          });
        }
        if (!cluster?.image) fail("missing_cluster_image", `Clusterkarte ${cluster?.label || index + 1} enthält kein Bild`);
        index += 1;
        graphics.push({
          name: `graphics/${String(index + 2).padStart(2, "0")}-cluster-${safeSlug(cluster.label, String(index))}.png`,
          mediaType: "image/png",
          role: "graphic.cluster-map",
          caption: `${cluster.label || `Cluster ${index}`} – räumliche Detailansicht`,
          content: pngBytesFromDataUrl(cluster.image),
          metadata: {
            accidentCount: Number.isFinite(total) ? total : visible,
            latitude: Number.isFinite(Number(cluster.lat)) ? Number(cluster.lat) : null,
            longitude: Number.isFinite(Number(cluster.lon)) ? Number(cluster.lon) : null,
            zoom: Number.isFinite(Number(cluster.zoom)) ? Number(cluster.zoom) : null,
          },
        });
      }
    }

    if (structured?.yearlyTrend && typeof UA.trend?.renderTrendSVG === "function") {
      const svg = UA.trend.renderTrendSVG(structured.yearlyTrend, {
        width: 720,
        height: 220,
        ariaLabel: `Mehrjahres-Trend ${structured.yearlyTrend.classification || "unbestimmt"}`,
      });
      if (svg) {
        graphics.push({
          name: "graphics/mehrjahres-trend.svg",
          mediaType: "image/svg+xml;charset=utf-8",
          role: "graphic.yearly-trend",
          caption: "Mehrjahres-Trend der Unfallzahlen einschließlich Regressionslinie",
          content: `${svg}\n`,
          metadata: {
            years: structured.yearlyTrend.years || [],
            classification: structured.yearlyTrend.classification || null,
          },
        });
      }
    }

    if (structured?.heatmap && typeof UA.heatmap?.renderHeatmapSVG === "function") {
      const svg = UA.heatmap.renderHeatmapSVG(structured.heatmap, {
        cellW: 38,
        cellH: 24,
        ariaLabel: `Stunden-Heatmap nach Tagestyp; gesamt ${structured.heatmap.total || 0} Unfälle`,
      });
      if (svg) {
        graphics.push({
          name: "graphics/stunden-heatmap.svg",
          mediaType: "image/svg+xml;charset=utf-8",
          role: "graphic.hour-daytype-heatmap",
          caption: "Stunden-Heatmap für Werktage und Wochenenden",
          content: `${svg}\n`,
          metadata: {
            accidentCount: Number(structured.heatmap.total || 0),
          },
        });
      }
    }

    return graphics;
  }

  async function generatePackage(UA, ctx, options = {}) {
    await waitForDependencies(UA);
    const normalizedCtx = ctx || {};
    const internal = UA.aiProposal._internal;
    internal.mirrorExportOptions(normalizedCtx);

    const progress = options.progress;
    if (typeof progress === "function") progress("Berechne unveränderlichen Analyse-Snapshot …");
    const report = await UA.computeExportReport(normalizedCtx);
    const structured = report?.structured;
    if (!structured) fail("missing_structured_report", "Kein strukturierter Export verfügbar; bitte Bereich markieren oder Export neu öffnen");

    const createdAt = new Date().toISOString();
    const mapUrl = currentMapUrl(UA, normalizedCtx);
    const city = structured?.meta?.city || structured?.meta?.cityRaw || normalizedCtx.CITY_RAW || normalizedCtx.city || "unbekannte-stadt";
    const facts = internal.buildExternalAiFactsPackage({
      structured,
      deterministicReportText: report.text || "",
      mapUrl,
      generatedAt: createdAt,
      city,
    });

    const graphics = await captureGraphics(UA, normalizedCtx, structured, progress);
    if (!graphics.some(graphic => graphic.role === "graphic.overview-map")) {
      fail("missing_overview_map", "Übersichtskarte fehlt im KI-Übergabepaket");
    }

    const prompt = enrichPrompt(internal.buildExternalAiPrompt(facts), graphics);
    const base = `${safeSlug(city)}_${createdAt.slice(0, 10)}_ki-medienpaket`;
    const state = applicationState(normalizedCtx, mapUrl);
    const initialEntries = [
      {
        name: "prompt.md",
        mediaType: "text/markdown;charset=utf-8",
        role: "instruction.prompt",
        caption: "Arbeitsauftrag für das eigene KI-Konto",
        content: `${prompt}\n`,
      },
      {
        name: "facts.json",
        mediaType: "application/json;charset=utf-8",
        role: "data.structured-facts",
        caption: "Vollständiges strukturiertes Faktenpaket",
        content: stableJson(facts),
      },
      {
        name: "report.md",
        mediaType: "text/markdown;charset=utf-8",
        role: "report.deterministic-markdown",
        caption: "Deterministischer Berichtstext",
        content: reportMarkdown(facts),
      },
      {
        name: "report.html",
        mediaType: "text/html;charset=utf-8",
        role: "report.rendered-html",
        caption: "Gerenderter HTML-Bericht einschließlich eingebetteter SVG-Grafiken",
        content: report.html || `<main><h1>${xmlEscape(city)}</h1><pre>${xmlEscape(report.text || "")}</pre></main>\n`,
      },
      {
        name: "application-state.json",
        mediaType: "application/json;charset=utf-8",
        role: "data.application-state",
        caption: "Kartenansicht, Auswahlgrenzen und Exportoptionen",
        content: stableJson(state),
      },
      {
        name: "map-url.txt",
        mediaType: "text/plain;charset=utf-8",
        role: "reference.map-url",
        caption: "Prüfbarer Link zur Unfallwerkbank-Ansicht",
        content: `${mapUrl}\n`,
      },
      ...graphics,
    ];

    const described = [];
    for (const entry of initialEntries) described.push(await describeEntry(UA, entry));
    const manifest = {
      schemaVersion: PACKAGE_SCHEMA,
      createdAt,
      generator: "Unfallwerkbank",
      packageMediaType: PACKAGE_MEDIA_TYPE,
      city,
      mapUrl,
      completeness: "complete",
      privacyNote: "Lokal erzeugt; Übermittlung erst durch expliziten Upload der Nutzer:innen.",
      uploadContract: {
        requiredFiles: ["prompt.md", "facts.json", "manifest.json", ...graphics.map(graphic => graphic.name)],
        instruction: "ZIP entpacken und alle Pflichtdateien gemeinsam hochladen.",
      },
      files: described,
    };
    const readme = readmeMarkdown(manifest);
    const readmeEntry = {
      name: "README.md",
      mediaType: "text/markdown;charset=utf-8",
      role: "documentation.readme",
      caption: "Nutzungs- und Vollständigkeitsanleitung",
      content: readme,
    };
    manifest.files.unshift(await describeEntry(UA, readmeEntry));
    const manifestEntry = {
      name: "manifest.json",
      mediaType: "application/json;charset=utf-8",
      role: "provenance.package-manifest",
      caption: "Datei-, Hash- und Konsistenzmanifest",
      content: stableJson(manifest),
    };

    const entries = [readmeEntry, ...initialEntries, manifestEntry];
    const zipBytes = UA.zip.createStoredZip(entries.map(entry => ({ name: entry.name, content: entry.content })));
    return {
      schemaVersion: PACKAGE_SCHEMA,
      filename: `${base}.zip`,
      mediaType: PACKAGE_MEDIA_TYPE,
      bytes: zipBytes,
      entries,
      manifest,
      facts,
      prompt,
      graphics,
    };
  }

  function downloadPackage(rootValue, pkg) {
    if (!rootValue?.Blob || !rootValue?.URL?.createObjectURL || !rootValue?.document) {
      fail("download_unavailable", "Browser-Download ist nicht verfügbar");
    }
    const blob = new rootValue.Blob([pkg.bytes], { type: pkg.mediaType });
    const url = rootValue.URL.createObjectURL(blob);
    const anchor = rootValue.document.createElement("a");
    anchor.href = url;
    anchor.download = pkg.filename;
    rootValue.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    rootValue.setTimeout(() => rootValue.URL.revokeObjectURL(url), 0);
  }

  function setStatus(message) {
    const status = root?.document?.getElementById("aiPromptStatus");
    if (status) status.textContent = message || "";
  }

  function relabelTextOnlyControls(documentValue) {
    const copy = documentValue.getElementById("btnAiPromptCopy");
    if (copy) {
      copy.title = "Kopiert nur Text und JSON in die Zwischenablage. Karten und sonstige Grafiken sind ausschließlich im KI-Medienpaket enthalten.";
      copy.lastChild.textContent = " Text-Prompt kopieren (ohne Grafiken)";
    }
    const markdown = documentValue.getElementById("btnAiPromptDownloadMd");
    if (markdown) {
      markdown.title = "Lädt nur den textbasierten Prompt. Für Karten und Grafiken das KI-Medienpaket verwenden.";
      markdown.lastChild.textContent = " Text-Prompt .md";
    }
    const intro = documentValue.querySelector("#externalAiPromptPanel > div:first-child");
    if (intro && !documentValue.getElementById("aiHandoffCompletenessNote")) {
      const note = documentValue.createElement("div");
      note.id = "aiHandoffCompletenessNote";
      note.style.cssText = "margin-top:6px; padding:7px 9px; border-left:3px solid #9a6700; background:rgba(154,103,0,.08);";
      note.textContent = "Text-Prompt und Fakten-JSON enthalten keine Bilddateien. Für eine vollständige Übergabe mit Karten, Trendgrafik und Stunden-Heatmap das KI-Medienpaket herunterladen.";
      intro.appendChild(note);
    }
  }

  function ensureControls(UA, ctx) {
    const documentValue = root?.document;
    const panel = documentValue?.getElementById("externalAiPromptPanel");
    if (!panel) return false;
    relabelTextOnlyControls(documentValue);
    if (documentValue.getElementById("btnAiHandoffDownload")) return true;

    const button = documentValue.createElement("button");
    button.id = "btnAiHandoffDownload";
    button.type = "button";
    button.title = "Erzeugt ein ZIP mit Prompt, vollständigen Fakten, Bericht, Karten, Trendgrafik, Stunden-Heatmap und SHA-256-Manifest. Es wird nichts automatisch an KI-Dienste gesendet.";
    button.style.cssText = "padding:8px 12px; background:#6b3fa0; color:white; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:6px;";
    button.innerHTML = '<span aria-hidden="true">🗂️</span> KI-Medienpaket mit Grafiken (.zip)';

    const actions = panel.querySelector("div[style*='display:flex']") || panel.lastElementChild;
    const chatButton = documentValue.getElementById("btnOpenChatGpt");
    if (chatButton?.parentElement === actions) actions.insertBefore(button, chatButton);
    else actions?.appendChild(button);

    button.addEventListener("click", async () => {
      button.disabled = true;
      const original = button.innerHTML;
      button.innerHTML = '<span aria-hidden="true">⏳</span> Medienpaket wird erstellt …';
      try {
        const runtimeCtx = ctx || (typeof UA.getRuntimeContext === "function" ? UA.getRuntimeContext() : null) || {};
        const pkg = await generatePackage(UA, runtimeCtx, { progress: setStatus });
        downloadPackage(root, pkg);
        setStatus(`KI-Medienpaket mit ${pkg.graphics.length} Grafik(en) und ${pkg.entries.length} Dateien heruntergeladen.`);
      } catch (error) {
        setStatus(`KI-Medienpaket fehlgeschlagen: ${error?.message || error}`);
      } finally {
        button.disabled = false;
        button.innerHTML = original;
      }
    });
    return true;
  }

  function install(UA) {
    const proposal = UA?.aiProposal;
    if (!proposal || typeof proposal.wire !== "function") return false;
    if (!proposal.wire._uaAiHandoffWrapped) {
      const originalWire = proposal.wire;
      const wrapped = function wireWithCompleteAiHandoff(ctx) {
        const result = originalWire.call(proposal, ctx);
        Promise.resolve().then(() => ensureControls(UA, ctx));
        return result;
      };
      wrapped._uaAiHandoffWrapped = true;
      wrapped._uaOriginalWire = originalWire;
      proposal.wire = wrapped;
    }
    const existingCtx = typeof UA.getRuntimeContext === "function" ? UA.getRuntimeContext() : null;
    if (root?.document?.getElementById("externalAiPromptPanel")) ensureControls(UA, existingCtx);
    return true;
  }

  return Object.freeze({
    PACKAGE_SCHEMA,
    PACKAGE_MEDIA_TYPE,
    AiHandoffError,
    install,
    ensureControls,
    generatePackage,
    downloadPackage,
    _internal: Object.freeze({
      utf8Bytes,
      pngBytesFromDataUrl,
      stableJson,
      safeSlug,
      currentMapUrl,
      applicationState,
      captureGraphics,
      enrichPrompt,
      readmeMarkdown,
    }),
  });
});
