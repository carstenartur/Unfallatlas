/**
 * UA.aiLinkHandoff — evidence-first, link-first handoff to a user-owned AI account.
 *
 * The canonical Unfallwerkbank URL is the collaboration surface: it restores
 * the requested analysis state, opens the deterministic export view and lets a
 * browser-capable AI inspect adjacent areas, switch layers or load the public
 * source data. The handoff preserves the official, police-based evidentiary
 * value of the accident records and requires an independent QA before prose.
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

  const LINK_SCHEMA = "unfallwerkbank.aiResearchHandoff.v2";
  const EVIDENCE_SCHEMA = "unfallwerkbank.accidentEvidenceContract.v1";
  const QA_SCHEMA = "unfallwerkbank.analysisQaContract.v1";
  const PROMPT_AUDIT_SCHEMA = "unfallwerkbank.aiPromptAudit.v1";
  const DEFAULT_PUBLIC_APP_URL = "https://carstenartur.github.io/Unfallatlas/werkbank_v2.html";
  const OFFICIAL_UNFALLATLAS_URL = "https://www.statistikportal.de/de/karten/unfallatlas";
  const OFFICIAL_DESTATIS_URL = "https://www.destatis.de/DE/Service/Statistik-Visualisiert/unfall-atlas.html";

  const REQUIRED_PROMPT_MARKERS = Object.freeze([
    "Meldungen der Polizeidienststellen",
    "Unfälle mit Personenschaden",
    "amtlich dokumentierten Tatsachenkern",
    "keine bloße Umformulierung",
    "QA-Urteil",
    "Evidenzmatrix",
    "Schreibe den Antrag erst nach",
    "Unsicherheit über die Ursache",
    "reine Sachschadensunfälle",
  ]);

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

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function firstFinite(...values) {
    for (const value of values) {
      const number = finiteNumber(value);
      if (number !== null) return number;
    }
    return null;
  }

  function safeFilename(value, fallback = "unfallwerkbank") {
    return String(value || fallback)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback;
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

  function readSelectionFromUrl(analysisUrl) {
    try {
      const params = new URL(analysisUrl).searchParams;
      const keys = ["selSouth", "selWest", "selNorth", "selEast"];
      if (!keys.every(key => params.has(key))) return null;
      const values = Object.fromEntries(keys.map(key => [key, finiteNumber(params.get(key))]));
      return Object.values(values).every(value => value !== null) ? values : null;
    } catch (_) {
      return null;
    }
  }

  function extractSnapshotMetrics(structured, analysisUrl) {
    const meta = structured?.meta || {};
    const severity = structured?.severity || {};
    const bySev = severity?.bySev || {};
    const crossTotals = structured?.crossTable?.totals || {};
    const details = structured?.accidentDetails || {};
    const yearRows = Array.isArray(structured?.yearTable) ? structured.yearTable : [];
    const years = yearRows
      .map(row => finiteNumber(row?.year))
      .filter(year => year !== null)
      .sort((a, b) => a - b);
    const yearTotal = yearRows.reduce((sum, row) => {
      const count = finiteNumber(row?.total);
      return count === null ? sum : sum + count;
    }, 0);
    const totalAccidents = firstFinite(
      severity.total,
      crossTotals.total,
      details.total,
      structured?.summary?.totalAccidents,
      structured?.summary?.accidents
    );
    return {
      city: meta.city || meta.cityRaw || null,
      areaName: meta.areaName || null,
      reportDate: meta.date || null,
      filters: meta.filters || null,
      involvementMode: meta.involvementMode || structured?.involvementMode || null,
      selectionBounds: readSelectionFromUrl(analysisUrl),
      totalAccidents,
      severity: {
        fatal: firstFinite(bySev["1"], crossTotals.sev1),
        serious: firstFinite(bySev["2"], crossTotals.sev2),
        slight: firstFinite(bySev["3"], crossTotals.sev3),
        other: firstFinite(bySev.other),
      },
      yearRange: years.length ? { from: years[0], to: years[years.length - 1] } : null,
      yearRows: yearRows.length,
      yearTotal: yearRows.length ? yearTotal : null,
      accidentDetails: {
        total: finiteNumber(details.total),
        renderedRows: Array.isArray(details.rows) ? details.rows.length : 0,
        truncated: Boolean(details.truncated),
      },
      representedTotals: {
        severityTotal: finiteNumber(severity.total),
        crossTableTotal: finiteNumber(crossTotals.total),
        accidentDetailsTotal: finiteNumber(details.total),
        yearTableTotal: yearRows.length ? yearTotal : null,
      },
    };
  }

  function buildEvidenceContract(structured, analysisUrl) {
    const metrics = extractSnapshotMetrics(structured, analysisUrl);
    return {
      schemaVersion: EVIDENCE_SCHEMA,
      primaryDataset: {
        name: "Unfallatlas der Statistischen Ämter des Bundes und der Länder",
        provenance: "Statistik der Straßenverkehrsunfälle auf Grundlage von Meldungen der Polizeidienststellen",
        officialSourceUrl: OFFICIAL_UNFALLATLAS_URL,
        officialScopeUrl: OFFICIAL_DESTATIS_URL,
        scope: "Veröffentlichte Unfälle mit Personenschaden; reine Sachschadensunfälle werden im Unfallatlas nicht dargestellt.",
        evidentiaryWeight: {
          highFor: [
            "das amtlich dokumentierte Unfallereignis",
            "den veröffentlichten Unfallort",
            "Jahr, Zeit- und Straßen-/Witterungsattribute, soweit im Datensatz vorhanden",
            "Unfallschwere und kodierte Beteiligungsarten, soweit im Datensatz vorhanden",
          ],
          notEstablishedByDatasetAlone: [
            "die vollständige Kausalkette eines einzelnen Unfalls",
            "nicht polizeilich gemeldete oder nicht veröffentlichte Ereignisse",
            "die aktuelle bauliche Situation ohne ergänzende Ortsprüfung",
            "die Wirksamkeit einer konkreten Maßnahme ohne fachliche Prüfung",
          ],
        },
      },
      chainOfCustody: [
        "polizeiliche Erfassung und Meldung",
        "amtliche Straßenverkehrsunfallstatistik",
        "Unfallatlas-Open-Data der Statistischen Ämter",
        "reproduzierbare Filterung, Aggregation und Darstellung durch die Unfallwerkbank",
      ],
      snapshotMetrics: metrics,
      decisionUse: [
        "Amtlich dokumentierte Unfallzahlen und -attribute bilden den Tatsachenkern des Antrags und dürfen nicht zu bloßen Vermutungen oder dekorativen Hinweisen herabgestuft werden.",
        "Unsicherheit über die genaue Ursache entwertet nicht die dokumentierten Ereignisse, ihre Schwere oder eine reproduzierbare räumliche bzw. zeitliche Häufung.",
        "Der Tatsachenkern kann einen konkreten Prüf-, Sicherungs-, Pilot- oder Abhilfeauftrag begründen, ohne eine nicht belegte Alleinursache zu behaupten.",
        "Die Unfallwerkbank-Auswertung selbst ist auf korrekte Filter, Zählungen, Karten, Diagramme und Datenstände zu prüfen; Fehler der Darstellung sind getrennt von der amtlichen Primärdatenbasis zu behandeln.",
      ],
      languageRule: "Formuliere amtlich belegte Ereignisse und Zahlen bestimmt. Verwende vorsichtige Sprache nur für Ursachenhypothesen, Kontextdeutungen, Zuständigkeiten und Wirkungsprognosen.",
    };
  }

  function buildAnalysisPreflight(structured, deterministicReportText, analysisUrl, resources) {
    const metrics = extractSnapshotMetrics(structured, analysisUrl);
    const representedTotals = Object.values(metrics.representedTotals)
      .filter(value => value !== null);
    const distinctTotals = [...new Set(representedTotals)];
    const checks = [
      {
        id: "structured-report",
        status: structured && typeof structured === "object" ? "pass" : "fail",
        detail: "Strukturierter Unfallwerkbank-Bericht vorhanden",
      },
      {
        id: "city-and-scope",
        status: metrics.city && (metrics.areaName || metrics.selectionBounds) ? "pass" : "review",
        detail: "Kommune und räumlicher Untersuchungsraum müssen eindeutig sein",
      },
      {
        id: "central-count",
        status: metrics.totalAccidents !== null ? "pass" : "review",
        detail: "Zentrale Unfallzahl muss im Snapshot maschinenlesbar vorliegen",
      },
      {
        id: "count-consistency",
        status: representedTotals.length < 2 ? "review" : (distinctTotals.length === 1 ? "pass" : "fail"),
        detail: representedTotals.length
          ? `Repräsentierte Gesamtzahlen: ${representedTotals.join(", ")}`
          : "Keine unabhängig vergleichbaren Gesamtzahlen gefunden",
      },
      {
        id: "year-coverage",
        status: metrics.yearRange ? "pass" : "review",
        detail: metrics.yearRange
          ? `Zeitraum ${metrics.yearRange.from}–${metrics.yearRange.to}`
          : "Auswertungszeitraum nicht eindeutig aus Jahrgangstabelle ableitbar",
      },
      {
        id: "deterministic-report",
        status: String(deterministicReportText || "").trim().length > 40 ? "pass" : "review",
        detail: "Deterministischer Bericht muss substanziellen Inhalt enthalten",
      },
      {
        id: "public-analysis-url",
        status: /^https:\/\//i.test(String(analysisUrl || "")) ? "pass" : "fail",
        detail: "Öffentliche reproduzierbare Analyse-URL",
      },
      {
        id: "raw-accident-data",
        status: resources.some(resource => resource.role === "data.accidents") ? "pass" : "review",
        detail: "Direkte Unfall-GeoJSON-URL für unabhängige Nachzählung",
      },
      {
        id: "visual-completeness",
        status: "pending",
        detail: "Karten, Legenden, Tabellen, Trend- und Heatmap-Darstellungen müssen im Browser visuell geprüft werden",
      },
    ];
    const blocking = checks.filter(check => check.status === "fail");
    return {
      schemaVersion: QA_SCHEMA,
      status: blocking.length ? "blocked" : "ready-for-independent-review",
      automatedScope: "Präsenz- und einfache Konsistenzprüfung; keine visuelle oder fachliche Endabnahme",
      metrics,
      checks,
      blockingCheckIds: blocking.map(check => check.id),
    };
  }

  function buildQaContract() {
    return {
      schemaVersion: QA_SCHEMA,
      purpose: "Die KI soll die Unfallwerkbank-Auswertung prüfen und erst danach einen evidenzbasierten Antrag formulieren.",
      requiredOrder: [
        "Abruf- und Quellenprotokoll",
        "Reproduktionsprüfung des Ausgangszustands",
        "Zähl- und Filterkonsistenz",
        "visuelle Vollständigkeit von Karte und Diagrammen",
        "Evidenzmatrix mit amtlichen Tatsachen, Unfallwerkbank-Ableitungen und Hypothesen",
        "Mängelliste der Unfallwerkbank-Analyse mit Schweregrad",
        "fachliche Maßnahmenlogik",
        "kommunalpolitischer Antrag",
      ],
      blockingDefects: [
        "Analyse-URL oder Unfall-Rohdaten nicht abrufbar",
        "widersprüchliche zentrale Unfallzahlen",
        "nicht reproduzierbarer Filter- oder Auswahlzustand",
        "behauptete, aber nicht sichtbare Karte oder Grafik",
        "fehlender Auswertungszeitraum oder unklarer räumlicher Bezug",
        "Maßnahmenbegründung ohne Bezug zu einem belegten Befund",
      ],
      measureRule: "Ein dokumentiertes Unfallgeschehen kann Handlungs- und Prüfbedarf belegen. Die konkrete Maßnahme ist als verhältnismäßige Reaktion, Pilot, Sofortmaßnahme mit geringem Fehlentscheidungsrisiko oder fachlicher Prüfauftrag zu begründen; eine unbelegte Alleinursache darf nicht erfunden werden.",
      applicationRule: "Der Antrag muss konkrete Zahlen, Zeitraum, Untersuchungsraum, Beteiligung/Schwere soweit vorhanden, Anlagen und überprüfbare Verwaltungsaufträge enthalten. Allgemeine Verkehrssicherheitsfloskeln genügen nicht.",
    };
  }

  function auditResearchPrompt(prompt) {
    const text = String(prompt || "");
    const missingMarkers = REQUIRED_PROMPT_MARKERS.filter(marker => !text.includes(marker));
    return {
      schemaVersion: PROMPT_AUDIT_SCHEMA,
      passed: missingMarkers.length === 0,
      requiredMarkers: [...REQUIRED_PROMPT_MARKERS],
      missingMarkers,
    };
  }

  function buildResearchPrompt(input) {
    const facts = input?.facts || {};
    const city = facts.city || input?.city || "der ausgewählten Kommune";
    const analysisUrl = input?.analysisUrl || facts.mapUrl || "";
    const resources = input?.resources || [];
    const evidence = facts.evidenceContract || buildEvidenceContract(facts.structured || {}, analysisUrl);
    const qa = facts.qaContract || buildQaContract();
    return [
      `# Evidenzbasierte QA und kommunaler Antrag (${city})`,
      "",
      `Übergabe-Schema: ${LINK_SCHEMA}`,
      `Erzeugt: ${facts.createdAt || new Date().toISOString()}`,
      "",
      "## Primärer Einstieg: öffentliche Analyseansicht öffnen",
      "Öffne zuerst den folgenden reproduzierbaren Unfallwerkbank-Link. Die URL ist nicht nur ein Quellenhinweis, sondern die primäre Arbeitsoberfläche. Sie stellt Stadt, Filter, Kartenmodus, Mittelpunkt, Zoom, Auswahlgrenzen und aktivierte Kontextansichten wieder her und öffnet mit `export=1` den deterministischen Bericht.",
      "",
      analysisUrl || "(kein Analyse-Link verfügbar)",
      "",
      "## Evidenzstatus – den amtlichen Tatsachenkern nicht relativieren",
      "Die im Unfallatlas veröffentlichten Unfallereignisse stammen aus der amtlichen Statistik der Straßenverkehrsunfälle auf Grundlage von Meldungen der Polizeidienststellen. Der Unfallatlas zeigt Unfälle mit Personenschaden; reine Sachschadensunfälle werden dort nicht dargestellt.",
      `Amtliche Quellenbeschreibung: ${OFFICIAL_UNFALLATLAS_URL}`,
      `Abgrenzung des dargestellten Umfangs: ${OFFICIAL_DESTATIS_URL}`,
      "Behandle Ereignis, veröffentlichten Ort, Zeitraum, Unfallschwere und kodierte Beteiligungsarten – soweit im Datensatz vorhanden – als Tatsachen mit hohem Evidenzwert. Formuliere sie bestimmt und mit konkreten Zahlen. Mache daraus nicht bloß „mögliche Hinweise“, nur weil die genaue Unfallursache oder die beste Maßnahme noch geprüft werden muss.",
      "Unsicherheit über die Ursache entwertet den amtlich dokumentierten Tatsachenkern nicht. Vorsicht ist bei Kausalität, Kontextdeutung und Wirkungsprognose nötig, nicht bei der Wiedergabe dokumentierter Ereignisse.",
      "",
      "## Verbindlicher Arbeitsablauf: QA vor Antrag",
      "Schreibe den Antrag erst nach Abschluss der folgenden Prüfung. Erstelle keine bloße Umformulierung des deterministischen Berichts und beginne nicht mit ein paar allgemeinen oder hübschen Sätzen.",
      "1. **Abrufprotokoll:** Nenne die erfolgreich und erfolglos geöffneten Web- und Daten-URLs.",
      "2. **Reproduktion:** Prüfe, ob Stadt, Zeitraum, Auswahlgrenzen, Unfallfilter, Beteiligungsmodus, Kartenmodus, Mittelpunkt, Zoom und aktivierte Layer dem Ausgangssnapshot entsprechen.",
      "3. **Zählprüfung:** Vergleiche zentrale Gesamtzahl, Schweregrade, Jahrgangssummen, Kreuz-/Beteiligungstabelle und Unfall-Detailzeilen. Zähle bei Bedarf das Unfall-GeoJSON mit denselben Filtern und Grenzen selbst nach.",
      "4. **Visuelle QA:** Prüfe Karte, Unfallpunkte, Auswahlgrenze, Legende, Detail-/Clusteransichten, Trendgrafik und Stunden-/Tagestyp-Heatmap, soweit für den Zustand vorgesehen. Fehlende, leere, abgeschnittene oder widersprüchliche Grafiken sind als Produktmangel zu dokumentieren.",
      "5. **Inhaltliche QA:** Prüfe, ob die Unfallwerkbank relevante Befunde vollständig, verständlich und ortsspezifisch darstellt. Benenne generische Texte, fehlende Kennzahlen, unklare Einheiten, unpassende Maßnahmen, schlechte Deep-Links oder nicht belegte Aussagen.",
      "6. **Evidenzmatrix:** Ordne jede tragende Aussage einer Stufe zu: (A) amtliche Unfalltatsache, (B) reproduzierbare Berechnung/Aggregation der Unfallwerkbank, (C) ergänzender GIS-/Bild-/Kontextbefund, (D) Hypothese oder Maßnahmenoption. Nenne Quelle, Feld bzw. Grafik und Einschränkung.",
      "7. **QA-Urteil:** Gib `bestanden`, `bestanden mit Mängeln` oder `blockiert` aus. Bei einem blockierenden Mangel erstelle keinen fertigen Antrag, sondern eine konkrete Fehler- und Nachforderungsliste.",
      "",
      "## Zusätzliche Untersuchungen",
      "Nutze die interaktive Anwendung für benachbarte Ausschnitte, andere Zoomstufen, Beteiligungs- und Zeitfilter, Cluster/Heatmap, POI-, Steigungs- und Verkehrskontext. Verändere den Ausgangszustand nicht stillschweigend; kennzeichne jede Variante als zusätzliche Untersuchung und nenne die geänderten Parameter.",
      "Lade bei Bedarf die unten genannten öffentlichen Rohdaten und Kontextdateien selbst herunter. Die bevorzugten URLs sind komprimierte `.gz`-Dateien; dekomprimiere sie vor der JSON-/GeoJSON-Auswertung. Verwende die Daten für nachvollziehbare Berechnungen statt Werte aus einem Kartenbild abzuschätzen.",
      "",
      "## Ableitung von Maßnahmen",
      "Ein reproduzierbar dokumentiertes Unfallgeschehen kann einen konkreten Handlungs- und Prüfbedarf tragen, auch wenn die Unfallwerkbank keine vollständige Kausalanalyse ersetzt. Verlange nicht fälschlich einen Nachweis der exakten Alleinursache, bevor überhaupt eine Ortsprüfung, Sicherung, Pilotmaßnahme oder Abhilfe beantragt werden darf.",
      "Leite jede Maßnahme sichtbar aus mindestens einem belegten Befund ab. Unterscheide: kurzfristige risikoarme Sicherung, vertiefte Prüfung durch die Verwaltung/Unfallkommission, Pilot mit Evaluation und dauerhafte bauliche Maßnahme. Benenne Ziel, Zuständigkeit als zu prüfende Annahme, Umsetzungs- bzw. Berichtsfrist und Erfolgskontrolle.",
      "",
      "## Direkte Daten- und Kontext-URLs",
      ...resourceMarkdown(resources),
      "",
      "## Gebundener Ausgangssnapshot, Evidenz- und QA-Vertrag (JSON)",
      "Die folgenden Fakten beschreiben den Ausgangszustand. Ergebnisse zusätzlicher Untersuchungen sind separat auszuweisen.",
      "```json",
      stableJson({
        schemaVersion: LINK_SCHEMA,
        analysisUrl,
        officialSources: {
          accidentAtlas: OFFICIAL_UNFALLATLAS_URL,
          destatisScope: OFFICIAL_DESTATIS_URL,
        },
        resources,
        evidenceContract: evidence,
        qaContract: qa,
        facts,
      }),
      "```",
      "",
      "## Pflichtausgabe",
      "1. Abruf- und Quellenprotokoll",
      "2. QA-Urteil mit Prüftabelle und Mängeln der Unfallwerkbank-Analyse",
      "3. Evidenzmatrix der tragenden Aussagen",
      "4. belastbare Befunde und Gegenbefunde mit konkreten Zahlen, Zeitraum und Raumbezug",
      "5. getrennte Ursachen-/Kontexthypothesen und offene Fragen",
      "6. Maßnahmenmatrix: Befund → Ziel → Option → Prüfbedarf → Erfolgskriterium",
      "7. sachlicher, prüffähiger Antrag an Bezirksrat bzw. Stadtverwaltung mit Beschlussvorschlag, Sachverhalt, Begründung, konkreten Verwaltungsaufträgen, Fristen, Berichtspflicht und Anlagenliste",
      "8. Quellenliste mit den tatsächlich verwendeten URLs und Datenfeldern.",
      "",
      "Falls dein Werkzeug die öffentliche Seite nicht öffnen oder nicht visuell auswerten kann, sage das ausdrücklich. Bitte dann gezielt um den vorhandenen PDF- oder Word-Export beziehungsweise einzelne Screenshots; erfinde keine nicht gesehenen Grafikinhalte.",
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
    const evidenceContract = buildEvidenceContract(structured, analysisUrl);
    const qaContract = buildQaContract();
    const analysisPreflight = buildAnalysisPreflight(
      structured,
      report.text || "",
      analysisUrl,
      resources
    );
    const baseFacts = internal.buildExternalAiFactsPackage({
      structured,
      deterministicReportText: report.text || "",
      mapUrl: analysisUrl,
      generatedAt: createdAt,
      city,
    });
    const facts = {
      ...baseFacts,
      intendedUse: "Unabhängige QA und evidenzbasierte kommunale Antragserstellung über einen reproduzierbaren Unfallwerkbank-Link",
      collaborationMode: "link-first-evidence-first",
      officialSourceUrls: [OFFICIAL_UNFALLATLAS_URL, OFFICIAL_DESTATIS_URL],
      evidenceContract,
      qaContract,
      analysisPreflight,
      researchResources: resources,
    };
    const prompt = buildResearchPrompt({ facts, city, analysisUrl, resources });
    const promptAudit = auditResearchPrompt(prompt);
    if (!promptAudit.passed) {
      fail("prompt_contract_incomplete", "KI-Auftrag erfüllt den Evidenz-/QA-Vertrag nicht", promptAudit);
    }
    return {
      schemaVersion: LINK_SCHEMA,
      createdAt,
      city,
      analysisUrl,
      resources,
      evidenceContract,
      qaContract,
      analysisPreflight,
      promptAudit,
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

  function downloadTextFile(filename, mime, text) {
    if (typeof root?.Blob !== "function" || !root?.URL?.createObjectURL) {
      fail("download_unavailable", "Dateidownload ist in dieser Laufzeit nicht verfügbar");
    }
    const blob = new root.Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const url = root.URL.createObjectURL(blob);
    const anchor = root.document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    root.document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    root.setTimeout?.(() => root.URL.revokeObjectURL(url), 0);
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
        "Den reproduzierbaren Analyse-Link mit Evidenz- und QA-Auftrag weitergeben. Die amtlichen, polizeibasierten Unfalldaten bilden den Tatsachenkern; die KI soll Darstellung, Zählungen und Maßnahmenlogik der Unfallwerkbank unabhängig prüfen. ",
        "Lokale Docker-Links werden mit denselben Parametern auf die öffentliche Werkbank übertragen. Nur bei fehlendem Webzugriff ist ein vorhandener PDF-/Word-Export oder ein einzelner Screenshot nötig.",
      ].join("");
    }

    // The old copy action generated the generic v1 text prompt. The primary
    // evidence/QA button below replaces it; removing the duplicate also removes
    // the obsolete event listener without changing ua.ai_proposal.js.
    documentValue.getElementById("btnAiPromptCopy")?.remove();

    const markdown = documentValue.getElementById("btnAiPromptDownloadMd");
    if (markdown) {
      markdown.title = "Lädt denselben Evidenz-/QA-Auftrag mit Analyse-Link als Markdown.";
      if (markdown.lastChild) markdown.lastChild.textContent = " Evidenz-/QA-Auftrag .md";
    }
    const facts = documentValue.getElementById("btnAiFactsDownloadJson");
    if (facts) {
      facts.title = "Lädt Ausgangssnapshot, amtlichen Evidenzvertrag und QA-Vorprüfung als JSON.";
      if (facts.lastChild) facts.lastChild.textContent = " Fakten + Evidenzvertrag .json";
    }
  }

  function runtimeContext(UA, ctx) {
    return ctx || (typeof UA.getRuntimeContext === "function" ? UA.getRuntimeContext() : null) || {};
  }

  function bindEvidenceDownloads(UA, ctx, documentValue) {
    function replaceAndBind(id, handler) {
      let button = documentValue.getElementById(id);
      if (!button || button.dataset.uaEvidenceHandoff === "1") return button;
      const clone = button.cloneNode(true);
      clone.dataset.uaEvidenceHandoff = "1";
      button.replaceWith(clone);
      clone.addEventListener("click", async () => {
        clone.disabled = true;
        const original = clone.innerHTML;
        clone.innerHTML = '<span aria-hidden="true">⏳</span> Evidenz-/QA-Snapshot wird erzeugt …';
        try {
          const handoff = await generateResearchHandoff(UA, runtimeContext(UA, ctx));
          await handler(handoff);
        } catch (error) {
          setStatus(`KI-Übergabe fehlgeschlagen: ${error?.message || error}`);
        } finally {
          clone.disabled = false;
          clone.innerHTML = original;
        }
      });
      return clone;
    }

    replaceAndBind("btnAiPromptDownloadMd", async handoff => {
      const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
      downloadTextFile(
        `${safeFilename(handoff.city)}_${date}_evidenz_qa_auftrag.md`,
        "text/markdown;charset=utf-8",
        handoff.prompt
      );
      setStatus("Evidenz-/QA-Auftrag als Markdown heruntergeladen.");
    });

    replaceAndBind("btnAiFactsDownloadJson", async handoff => {
      const date = String(handoff.createdAt || new Date().toISOString()).slice(0, 10);
      downloadTextFile(
        `${safeFilename(handoff.city)}_${date}_fakten_evidenz_qa.json`,
        "application/json;charset=utf-8",
        `${stableJson(handoff.facts)}\n`
      );
      setStatus("Fakten, Evidenzvertrag und QA-Vorprüfung heruntergeladen.");
    });
  }

  function ensureControls(UA, ctx) {
    const documentValue = root?.document;
    const panel = documentValue?.getElementById("externalAiPromptPanel");
    if (!panel) return false;

    reframeExistingControls(documentValue);
    bindEvidenceDownloads(UA, ctx, documentValue);
    if (documentValue.getElementById("btnAiResearchLinkCopy")) return true;

    const button = documentValue.createElement("button");
    button.id = "btnAiResearchLinkCopy";
    button.type = "button";
    button.title = "Kopiert einen evidenzbasierten KI-Arbeitsauftrag mit öffentlich erreichbarem, reproduzierbarem Analyse-Link, amtlicher Datenprovenienz, unabhängiger QA und direkten Daten-URLs.";
    button.style.cssText = "padding:8px 12px; background:#315f9e; color:white; border:none; border-radius:10px; font-weight:700; cursor:pointer; font-size:12px; display:flex; align-items:center; gap:6px;";
    button.innerHTML = '<span aria-hidden="true">🔗</span> KI-Auftrag: QA + Antrag + Analyse-Link kopieren';

    const actions = panel.querySelector("div[style*='display:flex']") || panel.lastElementChild;
    const firstSecondary = documentValue.getElementById("btnAiPromptDownloadMd")
      || documentValue.getElementById("btnAiFactsDownloadJson");
    if (firstSecondary?.parentElement === actions) actions.insertBefore(button, firstSecondary);
    else actions?.prepend(button);

    const note = documentValue.createElement("div");
    note.id = "aiLinkHandoffNote";
    note.style.cssText = "flex-basis:100%; font-size:12px; color:#355; line-height:1.45; padding:7px 9px; border-left:3px solid #315f9e; background:rgba(49,95,158,.08);";
    note.textContent = "Link zuerst, Evidenz bewahren: Amtliche, polizeibasierte Unfalldaten tragen den Tatsachenkern. Die KI muss Karte, Zahlen, Grafiken und Unfallwerkbank-Auswertung zunächst unabhängig prüfen und darf erst danach einen konkreten Antrag formulieren.";
    actions?.appendChild(note);

    button.addEventListener("click", async () => {
      button.disabled = true;
      const original = button.innerHTML;
      button.innerHTML = '<span aria-hidden="true">⏳</span> Evidenz- und QA-Auftrag wird vorbereitet …';
      setStatus("Berechne Ausgangssnapshot, amtlichen Evidenzvertrag, QA-Vorprüfung und öffentliche Daten-URLs …");
      try {
        const handoff = await generateResearchHandoff(UA, runtimeContext(UA, ctx));
        await writeClipboard(handoff.prompt);
        setStatus(`Evidenz-/QA-Auftrag mit Analyse-Link und ${handoff.resources.length} direkten Datenquelle(n) kopiert.`);
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
    EVIDENCE_SCHEMA,
    QA_SCHEMA,
    PROMPT_AUDIT_SCHEMA,
    DEFAULT_PUBLIC_APP_URL,
    OFFICIAL_UNFALLATLAS_URL,
    OFFICIAL_DESTATIS_URL,
    AiLinkHandoffError,
    install,
    ensureControls,
    generateResearchHandoff,
    buildResearchPrompt,
    buildEvidenceContract,
    buildAnalysisPreflight,
    buildQaContract,
    auditResearchPrompt,
    _internal: Object.freeze({
      stableJson,
      finiteNumber,
      firstFinite,
      safeFilename,
      isPrivateHostname,
      configuredPublicAppUrl,
      shareableAnalysisUrl,
      absoluteUrl,
      currentAnalysisUrl,
      resourceDescriptor,
      researchResources,
      resourceMarkdown,
      readSelectionFromUrl,
      extractSnapshotMetrics,
      reframeExistingControls,
      bindEvidenceDownloads,
      writeClipboard,
      downloadTextFile,
    }),
  });
});
