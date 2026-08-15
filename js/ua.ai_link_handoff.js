/**
 * UA.aiLinkHandoff — link-first handoff to a user-owned AI account.
 *
 * The canonical Unfallwerkbank URL is the collaboration surface: it restores
 * the requested analysis state, opens the deterministic export view and lets a
 * browser-capable AI inspect adjacent areas, switch layers or load the public
 * source data. No separate media archive is required for the normal workflow.
 */
(function initAiLinkHandoff(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!root) return;

  const UA = (root.UA = root.UA || {});
  UA.aiLinkHandoff = api;

  // This optional module may be loaded before ua.ai_proposal.js. Retry the
  // idempotent installation for a bounded period instead of coupling the
  // feature to an unrelated visualization module or script order.
  let attempt = 0;
  const installWhenReady = () => {
    try {
      if (api.install(UA)) return;
    } catch (error) {
      UA.aiLinkHandoffError = error;
      root.console?.error?.("KI-Analyse-Link konnte nicht initialisiert werden", error);
      return;
    }
    if (attempt++ < 240 && typeof root.setTimeout === "function") {
      root.setTimeout(installWhenReady, 25);
    }
  };
  installWhenReady();
})(typeof window !== "undefined" ? window : null, function createAiLinkHandoffApi(root) {
  "use strict";

  const LINK_SCHEMA = "unfallwerkbank.aiResearchHandoff.v1";
  const DEFAULT_PUBLIC_APP_URL = "https://carstenartur.github.io/Unfallatlas/werkbank_v2.html";

  class AiLinkHandoffError extends Error {
    constructor(code, message, details) {
      super(`${code}: ${message}`);
      this.name = "AiLinkHandoffError";
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new AiLinkHandoffError(code, message, details);
  }

  function stableJson(value) {
    function sort(valueToSort) {
      if (!valueToSort || typeof valueToSort !== "object") return valueToSort;
      if (Array.isArray(valueToSort)) return valueToSort.map(sort);
      const out = {};
      Object.keys(valueToSort).sort().forEach(key => { out[key] = sort(valueToSort[key]); });
      return out;
    }
    return JSON.stringify(sort(value), null, 2);
  }

  function isPrivateHostname(hostnameValue) {
    const hostname = String(hostnameValue || "").toLowerCase().replace(/^\[|\]$/g, "");
    if (!hostname || hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local")) {
      return true;
    }
    if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname)) {
      return true;
    }
    const private172 = hostname.match(/^172\.(\d+)\./);
    return Boolean(private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31);
  }

  function configuredPublicAppUrl(UA) {
    const configured = UA?.PUBLIC_APP_URL || UA?.publicAppUrl;
    if (configured) return String(configured);
    try {
      const meta = root?.document?.querySelector?.('meta[name="unfallwerkbank:public-app-url"]');
      const value = meta?.getAttribute?.("content");
      if (value) return value;
    } catch (_) { /* headless/test environment */ }
    return DEFAULT_PUBLIC_APP_URL;
  }

  function shareableAnalysisUrl(UA, currentUrl) {
    try {
      const current = new URL(currentUrl);
      if (!isPrivateHostname(current.hostname)) return current.href;
      const target = new URL(configuredPublicAppUrl(UA), current.href);
      target.search = current.search;
      target.hash = current.hash;
      return target.href;
    } catch (_) {
      return String(currentUrl || "");
    }
  }

  function absoluteUrl(value, baseUrl) {
    if (!value) return "";
    try {
      return new URL(value, baseUrl || root?.location?.href || DEFAULT_PUBLIC_APP_URL).href;
    } catch (_) {
      return String(value);
    }
  }

  function currentAnalysisUrl(UA, ctx) {
    try {
      if (typeof UA.syncAllToUrl === "function" && ctx?.ui) UA.syncAllToUrl(ctx);
      if (root?.location?.href) {
        const url = new URL(root.location.href);
        // export=1 opens the deterministic report after the interactive map and
        // its data have loaded. The map remains usable for further research.
        url.searchParams.set("export", "1");
        url.searchParams.delete("tour");
        return shareableAnalysisUrl(UA, url.href);
      }
    } catch (_) { /* use fallback below */ }
    return shareableAnalysisUrl(UA, root?.location?.href || configuredPublicAppUrl(UA));
  }

  function resourceDescriptor(UA, kind, params, role, description, baseUrl) {
    try {
      const descriptor = UA?.DataResources?.resolve?.(kind, params || {});
      if (!descriptor) return null;
      const url = absoluteUrl(descriptor.logicalUrl, baseUrl);
      const gzipUrl = descriptor.gzipUrl ? absoluteUrl(descriptor.gzipUrl, baseUrl) : null;
      // The application itself attempts the .gz representation first for both
      // gzip-preferred and gzip-only resources. Expose the actually published
      // compressed file as the primary AI download URL and retain the logical
      // raw URL only as a local-development fallback.
      const preferredUrl = descriptor.compression !== "raw" && gzipUrl
        ? gzipUrl
        : url;
      return {
        role,
        kind,
        description,
        compression: descriptor.compression || null,
        preferredUrl,
        url,
        gzipUrl,
      };
    } catch (_) {
      return null;
    }
  }

  function researchResources(UA, city, analysisUrl) {
    return [
      resourceDescriptor(
        UA,
        "accidentGeoJson",
        { city },
        "data.accidents",
        "Veröffentlichte Unfallpunkte aller verfügbaren Jahre für die aktive Stadt",
        analysisUrl
      ),
      resourceDescriptor(
        UA,
        "poiGeoJson",
        { city },
        "data.points-of-interest",
        "Schulen, Kindertagesstätten und weitere verfügbare POI-Kontexte",
        analysisUrl
      ),
      resourceDescriptor(
        UA,
        "contextWays",
        { city },
        "data.road-context",
        "Straßenkontext einschließlich verfügbarer Steigungs- und Verkehrshinweise",
        analysisUrl
      ),
      resourceDescriptor(
        UA,
        "enrichmentMeta",
        { city },
        "data.enrichment-provenance",
        "Metadaten und Provenienz der Kontextanreicherung",
        analysisUrl
      ),
      resourceDescriptor(
        UA,
        "accidentTileIndex",
        { city },
        "data.accident-tile-index",
        "Index der kachelbasierten Unfallansicht für gezielte räumliche Nachuntersuchungen",
        analysisUrl
      ),
      resourceDescriptor(
        UA,
        "contextTileIndex",
        { city },
        "data.context-tile-index",
        "Index der räumlichen Kontextkacheln",
        analysisUrl
      ),
    ].filter(Boolean);
  }

  function resourceMarkdown(resources) {
    if (!resources.length) {
      return ["- Keine separaten Daten-URLs wurden von dieser Laufzeit veröffentlicht; nutze die Analyseansicht selbst."];
    }
    return resources.flatMap(resource => {
      const lines = [
        `- **${resource.description}** (${resource.role}): ${resource.preferredUrl}`,
      ];
      if (resource.url && resource.url !== resource.preferredUrl) {
        lines.push(`  - logische Rohdaten-URL (lokaler Fallback): ${resource.url}`);
      }
      return lines;
    });
  }

  function buildResearchPrompt(input) {
    const facts = input?.facts || {};
    const city = facts.city || input?.city || "der ausgewählten Kommune";
    const analysisUrl = input?.analysisUrl || facts.mapUrl || "";
    const resources = input?.resources || [];
    return [
      `# Explorative Unfallwerkbank-Analyse (${city})`,
      "",
      `Übergabe-Schema: ${LINK_SCHEMA}`,
      `Erzeugt: ${facts.createdAt || new Date().toISOString()}`,
      "",
      "## Primärer Einstieg: öffentliche Analyseansicht öffnen",
      "Öffne zuerst den folgenden reproduzierbaren Unfallwerkbank-Link. Die URL ist nicht nur ein Quellenhinweis, sondern die primäre Arbeitsoberfläche. Sie stellt Stadt, Filter, Kartenmodus, Mittelpunkt, Zoom, Auswahlgrenzen und aktivierte Kontextansichten wieder her und öffnet mit `export=1` den deterministischen Bericht.",
      "",
      analysisUrl || "(kein Analyse-Link verfügbar)",
      "",
      "## Arbeitsweise",
      "1. Warte, bis Karte, Unfallpunkte und Exportbericht vollständig geladen sind.",
      "2. Untersuche die sichtbaren Karten, Legenden, Tabellen, Trend- und Heatmap-Darstellungen direkt in der Webanwendung. Behaupte nicht, Grafiken fehlten, bevor du versucht hast, die verlinkte Ansicht zu öffnen und visuell auszuwerten.",
      "3. Nutze die interaktive Anwendung für zusätzliche Untersuchungen: benachbarte Ausschnitte, andere Zoomstufen, Beteiligungs- und Zeitfilter, Cluster/Heatmap, POI-, Steigungs- und Verkehrskontext. Verändere den Ausgangszustand nicht stillschweigend; kennzeichne jede Variante als zusätzliche Untersuchung und nenne die geänderten Parameter.",
      "4. Lade bei Bedarf die unten genannten öffentlichen Rohdaten und Kontextdateien selbst herunter. Die bevorzugten URLs sind komprimierte `.gz`-Dateien; dekomprimiere sie vor der JSON-/GeoJSON-Auswertung. Verwende die Daten für nachvollziehbare Berechnungen statt Werte aus einem Kartenbild abzuschätzen.",
      "5. Trenne amtliche Unfallattribute, rechnerisch abgeleitete GIS-Hinweise, sichtbare Kontextindizien und Empfehlungen. Leite aus Karte, Orthofoto oder räumlicher Nähe allein keine gesicherte Unfallursache ab.",
      "6. Nenne die tatsächlich verwendeten URLs und dokumentiere Unsicherheiten, fehlgeschlagene Abrufe und Abweichungen vom Ausgangszustand.",
      "7. Falls dein Werkzeug die öffentliche Seite nicht öffnen oder nicht visuell auswerten kann, sage das ausdrücklich. Bitte dann gezielt um den vorhandenen PDF- oder Word-Export beziehungsweise einzelne Screenshots; erfinde keine nicht gesehenen Grafikinhalte.",
      "",
      "## Direkte Daten- und Kontext-URLs",
      ...resourceMarkdown(resources),
      "",
      "## Gebundener Ausgangssnapshot (JSON)",
      "Die folgenden Fakten beschreiben den Ausgangszustand. Ergebnisse zusätzlicher Untersuchungen sind separat auszuweisen.",
      "```json",
      stableJson({
        schemaVersion: LINK_SCHEMA,
        analysisUrl,
        resources,
        facts,
      }),
      "```",
      "",
      "## Gewünschte Ausgabe",
      "- kurze Bestätigung, welche Webansicht und welche Daten-URLs erfolgreich geöffnet wurden;",
      "- objektive Beschreibung der Ausgangsansicht und ihrer Grafiken;",
      "- nachvollziehbare zusätzliche Untersuchungen mit jeweils geänderten Parametern;",
      "- Befunde, Gegenbefunde, Unsicherheiten und Datenlücken;",
      "- ein sachlicher, prüffähiger kommunalpolitischer Antrag oder eine fachliche Maßnahmenbewertung, sofern dies zum Auftrag passt.",
    ].join("\n");
  }

  async function generateResearchHandoff(UA, ctx) {
    const internal = UA?.aiProposal?._internal;
    if (!internal?.mirrorExportOptions || !internal?.buildExternalAiFactsPackage) {
      fail("missing_prompt_export", "Textbasierter KI-Export ist nicht vollständig geladen");
    }
    if (typeof UA.computeExportReport !== "function") {
      fail("missing_report", "Exportbericht kann nicht erzeugt werden");
    }

    const normalizedCtx = ctx || {};
    internal.mirrorExportOptions(normalizedCtx);
    const report = await UA.computeExportReport(normalizedCtx);
    const structured = report?.structured;
    if (!structured) {
      fail("missing_structured_report", "Kein strukturierter Export verfügbar; bitte Bereich markieren oder Export neu öffnen");
    }

    const createdAt = new Date().toISOString();
    const analysisUrl = currentAnalysisUrl(UA, normalizedCtx);
    const city = structured?.meta?.city
      || structured?.meta?.cityRaw
      || normalizedCtx.CITY_RAW
      || normalizedCtx.city
      || "unbekannte-stadt";
    const resources = researchResources(UA, city, analysisUrl);
    const baseFacts = internal.buildExternalAiFactsPackage({
      structured,
      deterministicReportText: report.text || "",
      mapUrl: analysisUrl,
      generatedAt: createdAt,
      city,
    });
    const facts = {
      ...baseFacts,
      intendedUse: "Explorative Zusammenarbeit über einen reproduzierbaren Unfallwerkbank-Link",
      collaborationMode: "link-first",
      researchResources: resources,
    };
    const prompt = buildResearchPrompt({ facts, city, analysisUrl, resources });
    return {
      schemaVersion: LINK_SCHEMA,
      createdAt,
      city,
      analysisUrl,
      resources,
      facts,
      prompt,
      report,
    };
  }

  async function writeClipboard(text) {
    const nav = root?.navigator;
    if (nav?.clipboard?.writeText) {
      await nav.clipboard.writeText(text);
      return true;
    }
    const doc = root?.document;
    if (!doc?.createElement || !doc.body) fail("clipboard_unavailable", "Zwischenablage ist nicht verfügbar");
    const textarea = doc.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "readonly");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    doc.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, 999999);
    try { doc.execCommand("copy"); }
    finally { textarea.remove(); }
    return false;
  }

  function setStatus(message) {
    const status = root?.document?.getElementById("aiPromptStatus");
    if (status) status.textContent = message || "";
  }

  function reframeExistingControls(documentValue) {
    const intro = documentValue.querySelector("#externalAiPromptPanel > div:first-child");
    if (intro) {
      intro.innerHTML = [
        "<strong>Eigenes KI-Konto nutzen:</strong> ",
        "Den reproduzierbaren Analyse-Link weitergeben. Eine browserfähige KI kann die verlinkte Karte und den Bericht selbst öffnen, öffentliche Daten laden und weitere Varianten untersuchen. ",
        "Lokale Docker-Links werden dabei mit denselben Parametern auf die öffentliche Werkbank übertragen. Nur bei fehlendem Webzugriff ist ein vorhandener PDF-/Word-Export oder ein einzelner Screenshot nötig.",
      ].join("");
    }

    const copy = documentValue.getElementById("btnAiPromptCopy");
    if (copy) {
      copy.title = "Kopiert einen festen Text-/Fakten-Snapshot als sekundären Weg.";
      if (copy.lastChild) copy.lastChild.textContent = " Text-Snapshot kopieren";
    }
    const markdown = documentValue.getElementById("btnAiPromptDownloadMd");
    if (markdown) {
      markdown.title = "Lädt einen festen Text-/Fakten-Snapshot als Markdown.";
      if (markdown.lastChild) markdown.lastChild.textContent = " Text-Snapshot .md";
    }
    const facts = documentValue.getElementById("btnAiFactsDownloadJson");
    if (facts) facts.title = "Lädt den strukturierten Ausgangssnapshot ohne explorative Webuntersuchung.";
  }

  function ensureControls(UA, ctx) {
    const documentValue = root?.document;
    const panel = documentValue?.getElementById("externalAiPromptPanel");
    if (!panel) return false;

    reframeExistingControls(documentValue);
    if (documentValue.getElementById("btnAiResearchLinkCopy")) return true;

    const button = documentValue.createElement("button");
    button.id = "btnAiResearchLinkCopy";
    button.type = "button";
    button.title = "Kopiert einen KI-Arbeitsauftrag mit öffentlich erreichbarem, reproduzierbarem Analyse-Link und direkten Daten-URLs. Die KI kann die Webanwendung selbst untersuchen.";
    button.style.cssText = "padding:8px 12px; background:#315f9e; color:white; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:6px;";
    button.innerHTML = '<span aria-hidden="true">🔗</span> KI-Auftrag + Analyse-Link kopieren';

    const actions = panel.querySelector("div[style*='display:flex']") || panel.lastElementChild;
    const firstSecondary = documentValue.getElementById("btnAiPromptCopy");
    if (firstSecondary?.parentElement === actions) actions.insertBefore(button, firstSecondary);
    else actions?.prepend(button);

    const note = documentValue.createElement("div");
    note.id = "aiLinkHandoffNote";
    note.style.cssText = "flex-basis:100%; font-size:12px; color:#355; line-height:1.45; padding:7px 9px; border-left:3px solid #315f9e; background:rgba(49,95,158,.08);";
    note.textContent = "Link zuerst: Die KI erhält eine öffentlich erreichbare, reproduzierbare Ausgangsansicht, kann Karten und Bericht selbst ansehen und über direkte Daten-URLs weitere räumliche oder fachliche Prüfungen durchführen.";
    actions?.appendChild(note);

    button.addEventListener("click", async () => {
      button.disabled = true;
      const original = button.innerHTML;
      button.innerHTML = '<span aria-hidden="true">⏳</span> Analyse-Link wird vorbereitet …';
      setStatus("Berechne Ausgangssnapshot und öffentliche Daten-URLs …");
      try {
        const runtimeCtx = ctx || (typeof UA.getRuntimeContext === "function" ? UA.getRuntimeContext() : null) || {};
        const handoff = await generateResearchHandoff(UA, runtimeCtx);
        await writeClipboard(handoff.prompt);
        setStatus(`KI-Auftrag mit Analyse-Link und ${handoff.resources.length} direkten Datenquelle(n) kopiert.`);
      } catch (error) {
        setStatus(`KI-Analyse-Link fehlgeschlagen: ${error?.message || error}`);
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
    if (!proposal.wire._uaAiLinkHandoffWrapped) {
      const originalWire = proposal.wire;
      const wrapped = function wireWithLinkFirstAiHandoff(ctx) {
        const result = originalWire.call(proposal, ctx);
        Promise.resolve().then(() => ensureControls(UA, ctx));
        return result;
      };
      wrapped._uaAiLinkHandoffWrapped = true;
      wrapped._uaOriginalWire = originalWire;
      proposal.wire = wrapped;
    }
    const existingCtx = typeof UA.getRuntimeContext === "function" ? UA.getRuntimeContext() : null;
    if (root?.document?.getElementById("externalAiPromptPanel")) ensureControls(UA, existingCtx);
    return true;
  }

  return Object.freeze({
    LINK_SCHEMA,
    DEFAULT_PUBLIC_APP_URL,
    AiLinkHandoffError,
    install,
    ensureControls,
    generateResearchHandoff,
    buildResearchPrompt,
    _internal: Object.freeze({
      stableJson,
      isPrivateHostname,
      configuredPublicAppUrl,
      shareableAnalysisUrl,
      absoluteUrl,
      currentAnalysisUrl,
      resourceDescriptor,
      researchResources,
      resourceMarkdown,
      reframeExistingControls,
      writeClipboard,
    }),
  });
});
