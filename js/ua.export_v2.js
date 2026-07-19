(() => {
  const UA = (window.UA = window.UA || {});

  // --------------------
  // Export templates (optional)
  // --------------------
  const TEMPLATE_DIR = "templates";
  const DEFAULT_TEMPLATES = {
    intro: `Bezirksratsantrag (Entwurf) – Unfallwerkbank\n\nBetreff: Verbesserung der Verkehrssicherheit – Auffälliger Unfallschwerpunkt im markierten Bereich\n`,
    sachverhalt: `Sachverhalt:\nIm markierten Kartenausschnitt wurden {{local_total}} Unfälle ausgewertet. Im Vergleich zum Stadtdurchschnitt ({{baseline_total}} Unfälle, gleiche Filter für Schwere/Zeit/Zustand) zeigen sich Abweichungen in den Beteiligungskombinationen.\n\nVerletzungsschwere (Ausschnitt):\n{{severity_summary}}`,
    beschluss: `Beschlussvorschlag:\nDer Bezirksrat fordert die Verwaltung auf, innerhalb von 3 Monaten den markierten Bereich verkehrssicherheitsfachlich zu prüfen und kurzfristig umsetzbare Maßnahmen vorzuschlagen bzw. umzusetzen.\n\n1) Sofortmaßnahmen (Quick Wins, innerhalb von 3 Monaten umzusetzen): Markierungen/Warnhinweise, Sichtbeziehungen herstellen, konfliktärmere Führung, Signalisierung prüfen, ggf. Tempoanpassung.\n2) Infrastrukturmaßnahmen: sichere Rad- und Fußführung, sichere Querungen, Oberflächen-/Kantenprüfung, Knotenpunktgestaltung – mit verbindlichem Umsetzungszeitplan.\n3) Evaluation: Wirksamkeit nach 12 Monaten anhand der Unfallatlas-Daten überprüfen und der Bezirksvertretung berichten.\n`,
    hinweis: ``,
    lizenz: `Datenquelle/Lizenzhinweis: Unfallatlas / Open-Data-Downloads. Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0).\n`
  };

  async function loadTemplate(name, stadtSlug) {
    // Fallback chain:
    // 1. templates/{stadtSlug}/{name}.txt  (city-specific)
    // 2. templates/{name}.txt              (generic)
    // 3. DEFAULT_TEMPLATES[name]           (hardcoded fallback)
    if (stadtSlug) {
      const cityUrl = `${TEMPLATE_DIR}/${stadtSlug}/${name}.txt`;
      try {
        const r = await fetch(cityUrl, { cache: "no-store" });
        if (r.ok) return await r.text();
        // city-specific not found – fall through to generic
      } catch { /* city-specific unavailable – fall through to generic */ }
    }
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
  // Render-Helfer: Trend-Qualifier (PR-β) und OSM-Voraussetzungen (PR-γ).
  // Werden von Text-, HTML-, DOCX- und PDF-Renderern verwendet, damit der
  // Wortlaut in allen Pfaden identisch ist.
  // --------------------

  /**
   * Übersetzt die `yearlyTrend.classification` (steigend / stagnierend /
   * rückläufig / unbestimmt) in einen menschlich lesbaren Antragstext.
   * Liefert `null`, wenn die Klassifikation fehlt — der Caller blendet dann.
   */
  function trendQualifierText(classification) {
    switch (classification) {
      case "steigend":     return "im Mittel der letzten Jahre steigend";
      case "stagnierend":  return "stagnierend hoch (kein erkennbarer Rückgang)";
      case "rückläufig":   return "rückläufig im Mehrjahresvergleich";
      case "unbestimmt":   return "Trend statistisch unbestimmt (zu wenig Datenjahre)";
      default:             return null;
    }
  }

  /**
   * Baut für die Empfehlungsliste eine kompakte Hinweiszeile zum
   * OSM-Datenstand:
   *  - "OSM-Voraussetzungen mangels Daten nicht geprüft (Tempolimit, Fahrbahnbreite)"
   *  - "OSM-Kontext nicht abgerufen (HTTP 504): Voraussetzungen wurden nicht geprüft."
   *  - `null` wenn alle Achsen abgedeckt sind.
   *
   * @param {object|null} coverage  Ausgabe von `UA.measures.osmCoverage`
   */
  function osmCoverageNote(coverage) {
    if (!coverage) return null;
    if (!coverage.present) {
      const why = coverage.error ? ` (${coverage.error})` : "";
      // Plain text only – TEXT/HTML/DOCX consumers wrap or escape this string,
      // so any inline Markdown (`**…**`) would leak verbatim into the output.
      // Render-site emphasis (e.g. <strong>) is the responsibility of the caller.
      return `OSM-Kontext nicht abgerufen${why}: Maßnahmen-Voraussetzungen wurden mangels Daten nicht geprüft – die unten gelisteten Vorschläge können daher räumliche Voraussetzungen verletzen.`;
    }
    if (coverage.hasGap) {
      return `OSM-Voraussetzungen mangels Daten nicht geprüft: ${coverage.missingAxes.join(", ")}. Die Vorschläge wurden nicht anhand dieser Achse(n) gefiltert.`;
    }
    return null;
  }

  // --------------------
  // Dunkelziffer / Erfassungsgrenzen (#C3)
  // Pflicht-Hinweisblock in allen Antrags-Ausgaben (Text/HTML/DOCX/PDF), damit
  // Adressaten verstehen, dass die offiziellen Zahlen nur einen Ausschnitt der
  // tatsächlichen Verkehrssicherheitsbelastung abbilden. Quelle/Faktor sind in
  // docs/DOKUMENTATION.md hinterlegt.
  // --------------------
  const DARK_FIGURE_NOTE = Object.freeze({
    title: "Datenerfassung – Dunkelziffer und Erfassungsgrenzen",
    body: "Erfasst sind ausschließlich polizeilich aufgenommene Verkehrsunfälle mit Personenschaden. Reine Sachschäden, Beinaheunfälle und nicht gemeldete Unfälle (Dunkelziffer) sind nicht enthalten. Studien schätzen, dass insbesondere bei Radunfällen ohne Fremdverschulden sowie bei leichten Verletzungen ein erheblicher Anteil der Vorfälle nicht in der amtlichen Statistik landet — die tatsächliche Belastung kann je nach Verkehrsart um den Faktor 2–10 höher liegen.",
    sourceLabel: "Quelle: BASt – Bundesanstalt für Straßenwesen; Unfallforschung der Versicherer (UDV).",
    sourceUrl: "https://www.bast.de/DE/Statistik/Unfaelle/volkswirtschaftliche_kosten.html",
    sources: Object.freeze([
      Object.freeze({
        label: "BASt – Volkswirtschaftliche Kosten von Straßenverkehrsunfällen",
        url: "https://www.bast.de/DE/Statistik/Unfaelle/volkswirtschaftliche_kosten.html"
      }),
      Object.freeze({
        label: "UDV – Unfallforschung der Versicherer",
        url: "https://www.udv.de/"
      })
    ])
  });
  // Exportieren, damit Tests und andere Module (Doku-Generator) die selbe
  // Definition wiederverwenden können.
  UA.DARK_FIGURE_NOTE = DARK_FIGURE_NOTE;

  // --------------------
  // PR-E – Enrichment-Quellen-Hinweis
  // Dokumentiert die Datenquellen für die in PR-A/B/C/D dargestellten
  // Kontextdaten (Topographie, Verkehrslast, OSM-Straßenattribute).
  // Wird nur dann gerendert, wenn der Datensatz mindestens eines der
  // Kontextfelder trägt (`structured.enrichmentSourcesNote` ist sonst
  // null). Quellen sind bewusst klein gehalten und stadtübergreifend
  // — produzentenspezifische Versionen (OSM-Stand, SRTM-Tile) liefert
  // bereits die `*.enrichment.meta.json` als Anhang im Repo.
  // --------------------
  const ENRICHMENT_SOURCES_NOTE = Object.freeze({
    title: "Kontextdaten – Datenquellen",
    body: "Die in dieser Auswertung dargestellten Kontextdaten (Höhe, Hangneigung, OSM-Straßenattribute, geschätzte Verkehrsexposition als Proxy) sind aus offenen Datenquellen abgeleitet und beschreiben die Umgebung der Unfallorte – nicht deren Ursachen. Die Verkehrsklasse ist eine projekteigene Grobschätzung anhand der OSM-Straßenklasse und keine gemessene Verkehrsdichte.",
    sources: Object.freeze([
      Object.freeze({
        label: "SRTM 30 m Geländemodell (NASA, via AWS Open Data)",
        url:   "https://registry.opendata.aws/terrain-tiles/"
      }),
      Object.freeze({
        label: "OpenStreetMap-Straßenattribute (© OpenStreetMap-Mitwirkende, ODbL)",
        url:   "https://www.openstreetmap.org/copyright"
      }),
      Object.freeze({
        label: "Verkehrsklasse: projekteigener OSM-highway-Proxy (keine gemessenen Zähldaten)",
        url:   "https://wiki.openstreetmap.org/wiki/Key:highway"
      })
    ])
  });
  UA.ENRICHMENT_SOURCES_NOTE = ENRICHMENT_SOURCES_NOTE;

  /**
   * Pure helper: returns the enrichment-sources note iff the dataset
   * actually carries any context field (`ctx.contextCapabilities.hasAny`).
   * Returns null otherwise so renderers can do a single null check.
   */
  function pickEnrichmentSourcesNote(ctx) {
    const caps = ctx && ctx.contextCapabilities;
    if (!caps || !caps.hasAny) return null;
    return ENRICHMENT_SOURCES_NOTE;
  }
  UA._pickEnrichmentSourcesNote = pickEnrichmentSourcesNote;

  function buildVisualContextHints(ctx) {
    const info = (UA && typeof UA.getActiveMapLayerInfo === "function")
      ? UA.getActiveMapLayerInfo(ctx)
      : null;
    const orthophoto = info && info.orthophoto ? info.orthophoto : null;
    if (!orthophoto) return null;

    return {
      category: "orthophoto",
      sourceType: "visual_context",
      source: {
        mapMode: info.mode || ctx?.mapMode || null,
        mapModeLabel: info.modeLabel || null,
        layerId: orthophoto.id || null,
        layerName: orthophoto.displayName || null,
        provider: orthophoto.provider || null,
        attribution: orthophoto.attribution || null,
        license: orthophoto.license || null,
        officialForExport: orthophoto.officialForExport !== false
      },
      hints: [
        "Sichtbarer Hinweis aus Orthofoto/Luftbild: Infrastruktur- und Sichtbeziehungsmerkmale sind möglicherweise relevant, aber keine amtlich belegte Unfallursache."
      ],
      recommendation: "Detailprüfung empfohlen (Vor-Ort-Begehung/Unfallkommission); Hinweis ist prüfbedürftig."
    };
  }
  UA._buildVisualContextHints = buildVisualContextHints;

  // --------------------
  // Task 9 / Task 10 – Politischer Sprachmodus
  // --------------------
  /**
   * Übersetzt einen technischen Faktor (Über-/Unterrepräsentation gegenüber
   * dem Stadtdurchschnitt) in eine politisch-allgemeinverständliche
   * Formulierung. Ohne `opts.mode` ist der Default `"political"` (Wortband);
   * `opts.mode = "technical"` (oder jeder andere Wert) liefert die Roh-Faktor-Zahl.
   *
   * Bands wurden bewusst eng gewählt, um Übertreibungen zu vermeiden:
   *   ≥ 2.0  → "mehr als doppelt so häufig wie im Stadtmittel"
   *   ≥ 1.5  → "rund 1,5-mal so häufig wie im Stadtmittel"
   *   ≥ 1.35 → "deutlich häufiger als im Stadtmittel"
   *   < 1.35 → "leicht erhöht gegenüber dem Stadtmittel"
   *
   * @param {number} factor   z. B. r.factor aus topDeviations
   * @param {object} [opts]
   * @param {string} [opts.mode="political"]  "political" → Wortband, sonst Roh-Faktor.
   * @returns {string}
   */
  function formatFactorPolitical(factor, opts) {
    const mode = (opts && opts.mode) || "political";
    if (!Number.isFinite(factor)) return "k. A.";
    if (mode !== "political") {
      // PR-QA „Textqualität": deutsches Komma (2,18 statt 2.18).
      return `Faktor ${factor.toFixed(2).replace(".", ",")}`;
    }
    if (factor >= 2.0) return "mehr als doppelt so häufig wie im Stadtmittel";
    if (factor >= 1.5) return "rund 1,5-mal so häufig wie im Stadtmittel";
    if (factor >= 1.35) return "deutlich häufiger als im Stadtmittel";
    return "leicht erhöht gegenüber dem Stadtmittel";
  }
  UA.formatFactorPolitical = formatFactorPolitical;

  // --------------------
  // Task 2 – Kurzbewertung / Executive Summary
  // --------------------
  /**
   * Baut deterministisch einen Executive-Summary-Block für den Antrag.
   * Ableitung erfolgt aus bereits vorhandenen Feldern in `structured`
   * (deviations, severity, yearlyTrend) – kein neues Analyse-Modul.
   *
   * @param {object} structured  Output von computeExportReport.structured
   * @param {object} [opts]
   * @param {string} [opts.mode="political"]
   * @returns {{ classification: string, bullets: string[], urgency: string }}
   */
  function buildExecutiveSummary(structured, opts) {
    const mode = (opts && opts.mode) || "political";
    const focus = (structured && structured.deviations && Array.isArray(structured.deviations.focus))
      ? structured.deviations.focus : [];
    const sev = (structured && structured.severity) || { total: 0, bySev: {} };
    const yt = (structured && structured.yearlyTrend) || null;
    const top = focus[0] || null;
    const total = sev.total || 0;

    // 1) Klassifikation: Unfallschwerpunkt? Wir definieren hier:
    //    - "auffälliger Unfallschwerpunkt" wenn ein Fokus-Muster mit
    //      Faktor ≥ 1.5 + isSignificant existiert ODER Anteil Schwer/Tot ≥ 30 %.
    //    - "Häufungspunkt" bei mind. einem Fokus-Muster (Faktor ≥ 1.35).
    //    - "unauffällig" sonst.
    const fatal = Number(sev.bySev && sev.bySev["1"]) || 0;
    const severe = Number(sev.bySev && sev.bySev["2"]) || 0;
    const heavyShare = total > 0 ? (fatal + severe) / total : 0;
    const hasStrongFocus = focus.some(r => r.factor >= 1.5 && r.isSignificant);
    const hasFocus = focus.length > 0;
    let classification;
    if (hasStrongFocus || heavyShare >= 0.30) {
      classification = "Auffälliger Unfallschwerpunkt – verkehrssicherheitsfachliches Handeln erforderlich.";
    } else if (hasFocus) {
      classification = "Lokaler Häufungspunkt mit erhöhtem Risikoprofil – Prüfung empfohlen.";
    } else {
      classification = "Im markierten Bereich kein eindeutiger Unfallschwerpunkt erkennbar.";
    }

    // 2) Bullets (2–4): aus existierenden Feldern. Bei dünner Datenlage
    //    weniger Bullets statt "k. A."-Bullets (Open-Question-Default).
    const bullets = [];
    bullets.push(`Insgesamt ${total} polizeilich erfasste Unfälle mit Personenschaden im markierten Bereich.`);
    if (top && Number.isFinite(top.factor)) {
      const factorPhrase = formatFactorPolitical(top.factor, { mode });
      const lbl = top.textLabel || top.label || "auffälliges Muster";
      bullets.push(`Schwerpunktmuster ${lbl}: ${factorPhrase}.`);
    }
    if (yt && yt.classification) {
      const tq = trendQualifierText(yt.classification);
      if (tq) bullets.push(`Mehrjahres-Trend: ${tq}.`);
    }
    if (heavyShare > 0) {
      const pct = (heavyShare * 100).toFixed(0);
      bullets.push(`Schwere Verletzungsfolgen (Getötete + Schwerverletzte): ${pct} % der erfassten Fälle.`);
    }
    // Begrenzen auf 2–4. Wenn weniger als 2 zur Verfügung stehen
    // (extrem dünne Daten), liefern wir die wenigen ehrlich aus.
    const limited = bullets.slice(0, 4);

    // 3) Urgency: Klassifikation + Trend.
    let urgency;
    const trend = yt && yt.classification;
    if (hasStrongFocus && (trend === "steigend" || trend === "stagnierend")) {
      urgency = "Dringliche Befassung geboten – die Häufung ist signifikant und nicht rückläufig.";
    } else if (hasStrongFocus) {
      urgency = "Zeitnahe Befassung geboten.";
    } else if (hasFocus) {
      urgency = "Befassung empfohlen; Wirksamkeit der Maßnahmen monitoren.";
    } else {
      urgency = "Beobachtungsmodus – regelmäßige Auswertung mit Unfallatlas-Daten.";
    }

    return { classification, bullets: limited, urgency };
  }
  UA.buildExecutiveSummary = buildExecutiveSummary;

  // --------------------
  // Task 4 – Ursachen → Maßnahmen-Mapping
  // --------------------
  /**
   * Deterministischer Fallback, falls der Maßnahmenkatalog für ein
   * detektiertes Muster keine Empfehlung liefert. Schlüssel = Maske.
   * Werte = Liste von Maßnahmen-Labels, sehr kurz und politisch lesbar.
   */
  const CAUSE_MEASURE_FALLBACK = Object.freeze({
    1:  ["Oberflächeninstandsetzung", "Schienenquerung sichern", "Engstellen entschärfen"],
    2:  ["Querungsverbesserung (Mittelinsel/Zebra)", "Sichtbeziehungen herstellen"],
    3:  ["Trennung Fuß-/Radverkehr", "Querungsverbesserung"],
    5:  ["Knotenpunkt-Sichtbeziehungen prüfen", "Konfliktarme Radführung", "Tempoanpassung"],
    6:  ["Querungsverbesserung", "Tempoanpassung", "Sichtbeziehungen prüfen"],
    7:  ["Knotenpunkt-Umgestaltung", "Getrennte Signalphasen", "Querungsverbesserung"],
    16: ["Schleppkurven prüfen", "Geometrie-Anpassung", "Lieferzonen ausweisen"],
    17: ["Abbiegeassistent fördern", "Getrennte Signalphasen", "Sichtbeziehungen am Knoten"],
    18: ["Sichtbeziehungen am Knoten", "Getrennte Signalphasen für Fußverkehr"],
    20: ["Fahrbahnbreiten/Engstellen prüfen", "Überholverbot prüfen"],
    21: ["Knotenumgestaltung mit Radverkehrsführung", "Abbiegeschutz"],
    22: ["Knotenumgestaltung", "Sicherer Fußverkehr"]
  });

  /**
   * Erzeugt strukturierte Zeilen `[{ cause, mask, measures, measureRefs }]`
   * für die "URSACHEN UND MASSNAHMEN"-Sektion.
   *
   * - `measures` (string[]): Maßnahmen-Labels, max 3 (Backward-compat).
   * - `measureRefs` (Array<{idx, label}>): 1-basierte Indizes in
   *   `recommendedMeasures.measures[]`. Renderer können daraus
   *   „Maßnahme #1 (Tempo-30-Anordnung)" bauen statt das Label
   *   stumm zu wiederholen (Goldstandard Items 5–6: explizite
   *   Cross-Reference statt Redundanz).
   *
   * Wenn keine Maßnahme zu einer Ursache passt (z. B. Toggle aus
   * oder Filter zu eng), greift der Fallback aus
   * `CAUSE_MEASURE_FALLBACK` und `measureRefs` bleibt leer — der
   * Renderer fällt dann automatisch auf die Label-Darstellung zurück.
   *
   * @param {Array<{mask:number,label?:string,textLabel?:string}>} detectedFocusRows  z. B. structured.deviations.focus
   * @param {object|null} recommendedMeasures  structured.recommendedMeasures (kann null sein)
   * @returns {Array<{ cause: string, mask: number, measures: string[], measureRefs: Array<{idx:number,label:string}> }>}
   */
  function buildCausesMeasuresSection(detectedFocusRows, recommendedMeasures) {
    const focus = Array.isArray(detectedFocusRows) ? detectedFocusRows : [];
    if (focus.length === 0) return [];

    // Map: mask -> Liste von { idx, label } aus recommendedMeasures.measures.
    // `idx` ist 1-basiert, identisch zur Nummerierung im Empfohlene-
    // Maßnahmen-Block (TEXT/HTML/DOCX/PDF rendern beide bei 1).
    const refsByMask = {};
    if (recommendedMeasures && Array.isArray(recommendedMeasures.measures)) {
      recommendedMeasures.measures.forEach((item, i) => {
        const m = item && item.measure;
        if (!m) return;
        const tgt = (m.effect && Array.isArray(m.effect.targetPatterns)) ? m.effect.targetPatterns : [];
        for (const t of tgt) {
          const key = Number(t);
          if (!Number.isFinite(key)) continue;
          if (!refsByMask[key]) refsByMask[key] = [];
          if (!refsByMask[key].some(e => e.idx === i + 1)) {
            refsByMask[key].push({ idx: i + 1, label: m.label });
          }
        }
      });
    }

    return focus.map(r => {
      const mask = Number(r.mask);
      const cause = r.textLabel || r.label || formatInvolvementCombo(mask, { format: "text" });
      const refs = (refsByMask[mask] || []).slice(0, 3);
      let measures = refs.map(e => e.label);
      if (measures.length === 0) {
        const fb = CAUSE_MEASURE_FALLBACK[mask];
        if (Array.isArray(fb) && fb.length > 0) measures = fb.slice(0, 3);
      }
      if (measures.length === 0) {
        measures = ["Keine spezifische Maßnahme aus Katalog (siehe allgemeine Maßnahmen)."];
      }
      return { cause, mask, measures, measureRefs: refs };
    });
  }
  UA.buildCausesMeasuresSection = buildCausesMeasuresSection;

  // --------------------
  // Task 8 – Analytische OSM-Schlussfolgerungen
  // --------------------
  /**
   * Liefert 0–3 deterministische Sätze, die aus `structured.osmContext.summary`
   * direkt ableitbar sind (z. B. "Tempo 30 bereits etabliert").
   * @param {object|null} osmContext
   * @returns {string[]}
   */
  function deriveOsmInsights(osmContext) {
    const out = [];
    if (!osmContext || !osmContext.summary) return out;
    const s = osmContext.summary;
    if (Number.isFinite(s.cycleInfraShare) && s.cycleInfraShare < 0.30) {
      out.push("Geringer Anteil sicherer Radinfrastruktur (< 30 % der Hauptachsen) – strukturelles Defizit.");
    }
    if (Number.isFinite(s.dominantMaxspeed) && Number(s.speedSampleSize || 0) > 0) {
      if (s.dominantMaxspeed <= 30) {
        out.push("Tempo 30 ist bereits etabliert – keine zusätzliche Tempoabsenkung empfohlen; Fokus auf Infrastruktur und Sichtbeziehungen.");
      } else if (s.dominantMaxspeed >= 50) {
        out.push("Vorherrschendes Tempolimit ≥ 50 km/h – Tempoabsenkung im Bereich des Schwerpunkts prüfen.");
      }
    }
    if (Number.isFinite(s.crossings) && Number.isFinite(s.trafficSignals)) {
      if (s.crossings === 0 && s.trafficSignals === 0) {
        out.push("Keine markierten Querungen oder signalisierten Knoten erfasst – Querungsangebot prüfen.");
      } else if (s.crossings >= 3 && s.trafficSignals === 0) {
        out.push("Mehrere markierte Querungen ohne Signalisierung – Sicherung (LSA, Mittelinsel) prüfen.");
      }
    }
    return out;
  }
  UA.deriveOsmInsights = deriveOsmInsights;


  // --------------------
  // Task 6 – Räumliche Argumentation aus Unfallkoordinaten
  // --------------------
  /**
   * Leitet aus den tatsächlichen Unfallkoordinaten genau einen Satz ab, der
   * das räumliche Muster benennt (Knotenpunkt-Konzentration, Korridor entlang
   * einer Achse, mehrere verteilte Schwerpunkte oder durchgängige
   * Verteilung). Bewusst koordinatenbasiert – die Heatmap zeigt nur
   * aggregierte Dichte und darf laut Aufgabenstellung nicht als alleinige
   * Quelle für räumliche Aussagen dienen.
   *
   * Algorithmus:
   *  1. Punkte in ~55 m-Bins (lat/lon-Raster) aggregieren – grobe Knoten-Auflösung,
   *     verträglich mit GPS-Streuung der Polizeidaten.
   *  2. Hotspot-Zellen (≥2 Fälle) sortiert nach Anzahl absteigend.
   *  3. Klassifikation:
   *     - "konzentriert"        : eine Zelle deckt ≥ 50 % aller Punkte ab.
   *     - "knotenpunktnah"      : 2–3 Top-Zellen, paarweise Abstand ≤ 150 m.
   *     - "korridor"            : Top-Zellen liegen entlang einer Achse
   *                               (Hauptvarianz ≥ 9× Querkomponente, Spannweite ≥ 200 m).
   *     - "verteilte_schwerpunkte": mehrere Zellen, kein dominanter Knoten.
   *     - "diffus"              : keine Zelle erreicht den Mindestcluster.
   *
   * @param {Array<{lat:number,lon:number}>} points
   * @returns {string[]} Genau 0 (n<3) oder 1 Satz, fertig formatiert (deutsch).
   */
  function deriveSpatialArgumentation(points) {
    const sentences = [];
    const pts = Array.isArray(points)
      ? points.filter(p => p && Number.isFinite(p.lat) && Number.isFinite(p.lon))
      : [];
    const n = pts.length;
    // Bei sehr wenigen Punkten ist jede räumliche Aussage spekulativ – dann
    // lieber schweigen, als eine Scheinaussage zu generieren.
    if (n < 3) return sentences;

    // 1) Binning auf ~55 m: 0,0005° ≈ 56 m Latitude. Wir nehmen die gleiche
    //    Auflösung wie der Lat/Lon-Fallback in UA.computeTopHotspots, damit
    //    Karten-Hotspots und Antragstext dieselben Cluster benennen.
    const STEP = 0.0005;
    const cells = new Map();
    for (const p of pts) {
      const cy = Math.floor(p.lat / STEP);
      const cx = Math.floor(p.lon / STEP);
      const key = cx + ":" + cy;
      let c = cells.get(key);
      if (!c) { c = { total: 0, latSum: 0, lonSum: 0 }; cells.set(key, c); }
      c.total++;
      c.latSum += p.lat;
      c.lonSum += p.lon;
    }
    const ranked = [];
    for (const c of cells.values()) {
      if (c.total < 2) continue;
      ranked.push({ total: c.total, lat: c.latSum / c.total, lon: c.lonSum / c.total });
    }
    ranked.sort((a, b) => b.total - a.total);

    // 2) Keine echten Cluster → diffuse Verteilung benennen.
    if (ranked.length === 0) {
      sentences.push("Die Unfälle sind im markierten Bereich räumlich verteilt; ein dominanter Knotenpunkt ist anhand der Koordinaten nicht erkennbar.");
      return sentences;
    }

    const top = ranked[0];
    const topShare = top.total / n;

    // 3a) Eine Zelle deckt den Großteil aller Punkte ab → klare Konzentration.
    if (topShare >= 0.5) {
      const pct = Math.round(topShare * 100);
      sentences.push(`Die Unfälle konzentrieren sich auf einen engen Bereich (${top.total} von ${n} Fällen, rund ${pct} %, in unmittelbarer Nähe zueinander) – das Muster ist knotenpunkttypisch.`);
      return sentences;
    }

    // 3b) Mehrere Hotspots → räumliche Lage analysieren.
    //     Distanzen in Metern via äquirektangulärer Näherung (Stadtmaßstab),
    //     bezogen auf den Cluster-Schwerpunkt.
    const top3 = ranked.slice(0, Math.min(3, ranked.length));
    const meanLat = top3.reduce((s, c) => s + c.lat, 0) / top3.length;
    const M_PER_DEG_LAT = 111320;
    const M_PER_DEG_LON = 111320 * Math.cos(meanLat * Math.PI / 180);
    const xy = top3.map(c => ({
      x: (c.lon - top3[0].lon) * M_PER_DEG_LON,
      y: (c.lat - top3[0].lat) * M_PER_DEG_LAT
    }));
    let maxPair = 0;
    for (let i = 0; i < xy.length; i++) {
      for (let j = i + 1; j < xy.length; j++) {
        const d = Math.hypot(xy[i].x - xy[j].x, xy[i].y - xy[j].y);
        if (d > maxPair) maxPair = d;
      }
    }
    // Eng beieinander liegende Top-Zellen → zentraler Knotenbereich.
    if (top3.length >= 2 && maxPair <= 150) {
      sentences.push(`Mehrere Häufungen liegen in unmittelbarer Nähe zueinander (${top3.length} Schwerpunktzellen mit ${top3.reduce((s, c) => s + c.total, 0)} Fällen auf engem Raum) – das Muster spricht für einen zentralen Knotenpunktbereich.`);
      return sentences;
    }
    // Korridor-Heuristik: Hauptvarianz vs. Querkomponente.
    if (top3.length >= 3 && maxPair >= 200) {
      const cx = xy.reduce((s, p) => s + p.x, 0) / xy.length;
      const cy = xy.reduce((s, p) => s + p.y, 0) / xy.length;
      let sxx = 0, syy = 0, sxy = 0;
      for (const p of xy) {
        const dx = p.x - cx, dy = p.y - cy;
        sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
      }
      // Eigenwerte der 2×2-Kovarianzmatrix (Hauptachsentransformation).
      const tr = sxx + syy;
      const det = sxx * syy - sxy * sxy;
      const disc = Math.max(0, tr * tr / 4 - det);
      const lambda1 = tr / 2 + Math.sqrt(disc); // Hauptachse
      const lambda2 = tr / 2 - Math.sqrt(disc); // Querachse
      // Korridor-Schwellwert: Hauptvarianz ≥ 9× Querkomponente entspricht
      // einer Standardabweichungs-Streckung von ≥ 3× entlang der Hauptachse
      // gegenüber der Querachse (Kommentar oben spricht von "3× Querkomponente"
      // bezogen auf Standardabweichungen, nicht Varianzen).
      if (lambda1 > 0 && (lambda2 <= 0 || lambda1 / lambda2 >= 9)) {
        sentences.push(`Die Schwerpunkte ziehen sich entlang einer Achse (Spannweite rund ${Math.round(maxPair)} m) – die Häufung folgt dem Verlauf einer durchgehenden Verkehrsverbindung (Korridor).`);
        return sentences;
      }
    }
    // Default: mehrere getrennte Schwerpunkte (oder ein einzelner Schwerpunkt
    // mit < 50 % Anteil, der bisher keiner anderen Heuristik entspricht).
    const fallbackSentence = ranked.length === 1
      ? `Im markierten Bereich tritt ein räumlich abgegrenzter Schwerpunkt auf; eine Bündelung an einem einzelnen Knotenpunkt liegt nicht vor.`
      : `Im markierten Bereich treten ${ranked.length} räumlich getrennte Schwerpunkte auf; eine Bündelung an einem einzelnen Knotenpunkt liegt nicht vor.`;
    sentences.push(fallbackSentence);
    return sentences;
  }
  UA.deriveSpatialArgumentation = deriveSpatialArgumentation;


  /**
   * Entfernt führende „Marker"-Zeilen, die rein aus einem `[...]`-Block bestehen
   * (z. B. `[Interner Hinweis – vor Versand entfernen]` als erste Zeile von
   * `templates/outro_internal_note.txt`). Solche Marker sind als visuelle
   * Erinnerung im Template gedacht und sollen weder im fertigen Antrag noch in
   * Klartext-/HTML-/DOCX-/PDF-Renderpfaden auftauchen. Der inhaltliche Rest
   * (Erklärtext + `{{LINK}}`) bleibt unverändert. Bracket-Lines mitten im
   * Body bleiben erhalten – nur die zusammenhängende Marker-Header-Sequenz
   * am Anfang wird entfernt (PR-QA Task 8).
   */
  function stripInternalMarkerHeader(s) {
    if (s == null) return s;
    if (s === "") return s;
    return String(s).replace(/^(?:[ \t]*\[[^\]\n]*\][ \t]*\r?\n)+/, "");
  }
  UA._stripInternalMarkerHeader = stripInternalMarkerHeader;

  /**
   * Tiny predicate: true wenn der `recommendedMeasures`-Block für den
   * Renderer überhaupt etwas zu zeigen hat (entweder Empfehlungen oder
   * mindestens einen filteredOut-Eintrag, den wir transparent listen).
   * Geteilt von TEXT- und HTML-Pfad sowie dem DOCX/PDF-Renderer in
   * `js/ua.report_v2.js`, der dieselbe Bedingung als
   * `UA.hasRecommendationsOrFiltered` konsumiert.
   */
  function hasRecommendationsOrFiltered(rm) {
    if (!rm) return false;
    if (Array.isArray(rm.measures) && rm.measures.length > 0) return true;
    if (Array.isArray(rm.filteredOut) && rm.filteredOut.length > 0) return true;
    return false;
  }
  UA.hasRecommendationsOrFiltered = hasRecommendationsOrFiltered;

  // --------------------
  // Unfallklassen / Masken (robust, unabhängig von anderen Modulen)
  // --------------------
  // 6-Bit-Maske: Rad=1, Fuß=2, PKW=4, Krad=8, Gkfz=16, Sonstig=32
  const COMBO_BITS = [[1,"🚲"],[2,"🚶"],[4,"🚗"],[8,"🏍️"],[16,"🚛"],[32,"🚌"]];
  // Deterministische Text-Labels (Task 1) – identische Reihenfolge wie COMBO_BITS,
  // damit eine 6-Bit-Maske eindeutig auf "[Rad]+[PKW]" abgebildet werden kann.
  // Entspricht den Ersetzungen in `replaceEmojisForPDF`/`replaceEmojisForDocx`,
  // wird hier aber primär für Tabellen verwendet, die den Text-Pfad nehmen.
  const COMBO_BIT_LABELS = [[1,"[Rad]"],[2,"[Fuss]"],[4,"[PKW]"],[8,"[Krad]"],[16,"[Lkw]"],[32,"[Sonst]"]];
  const COMBO_LABEL = {};
  for (let m = 1; m <= 63; m++) {
    COMBO_LABEL[m] = COMBO_BITS.filter(([b]) => m & b).map(([,e]) => e).join("+");
  }

  /**
   * Task 1 – Deterministische Beteiligungs-Kombinations-Formatierung für
   * Tabellen (Cross-Tabelle, Pro-Jahr, Einzelunfälle). Ersetzt die ad-hoc
   * Stringifizierung, die bei kaputtem Datenstand sichtbare "+", "=" oder
   * "0" zurückließ.
   *
   * @param {number|string|null|undefined} input  Maske (0..63) oder beliebiger
   *        Vorschlags-String (z. B. "🚲+🚗", "[Rad]+[PKW]", "🚲: 4").
   *        Akzeptiert numerische Strings ("5") als Maske.
   * @param {object} [opts]
   * @param {string} [opts.format="text"]  "text" → "[Rad]+[PKW]", "emoji" → "🚲+🚗".
   * @param {string} [opts.fallback="k. A."] Fallback bei leerem/symbol-only Ergebnis.
   * @returns {string} Lesbare Beteiligungskombination oder Fallback.
   */
  function formatInvolvementCombo(input, opts) {
    const format = (opts && opts.format) || "text";
    const fallback = (opts && opts.fallback != null) ? String(opts.fallback) : "k. A.";

    // 1) Numerische Eingabe oder rein-numerischer String → Bitmaske.
    let mask = null;
    if (typeof input === "number" && Number.isFinite(input)) {
      mask = input;
    } else if (typeof input === "string" && /^-?\d+$/.test(input.trim())) {
      mask = Number(input.trim());
    }
    if (mask != null) {
      mask = mask & 63; // nur 6 Bits relevant
      if (mask === 0) return fallback;
      const bits = format === "emoji" ? COMBO_BITS : COMBO_BIT_LABELS;
      const parts = bits.filter(([b]) => mask & b).map(([, label]) => label);
      return parts.length > 0 ? parts.join("+") : fallback;
    }

    // 2) String: Emojis zu Labels normalisieren (für "text"-Format).
    if (typeof input === "string") {
      let s = input;
      if (format === "text") {
        // Inline-Normalisierung (gleicher Mapping-Tabelle wie
        // COMBO_BIT_LABELS und `replaceEmojisForDocx` in ua.report_v2.js –
        // wir wollen keine cross-module load-order-Abhängigkeit).
        s = s
          .replace(/\u{1F6B2}/gu, "[Rad]")
          .replace(/\u{1F6B6}/gu, "[Fuss]")
          .replace(/\u{1F697}/gu, "[PKW]")
          .replace(/\u{1F3CD}[\u{FE0F}]?/gu, "[Krad]")
          .replace(/\u{1F69B}/gu, "[Lkw]")
          .replace(/\u{1F68C}/gu, "[Sonst]");
      }
      // Prüfen, ob nach der Normalisierung lesbarer Inhalt übrig ist:
      // Etiketten wie "[Rad]" enthalten Buchstaben → ok. Fällt das alles weg
      // und es bleiben nur Trennzeichen/Ziffern/Whitespace, wechseln wir auf
      // den Fallback (das war exakt der QA-Bug "+, =, 0").
      const stripped = s.replace(/\[[^\]]+\]/g, "X"); // Etiketten zählen als Inhalt
      if (!/[A-Za-zÄÖÜäöüß]/.test(stripped)) return fallback;
      return s.trim() || fallback;
    }

    // 3) Sonstige Eingaben (null, undefined, {}): Fallback.
    return fallback;
  }
  UA.formatInvolvementCombo = formatInvolvementCombo;

  // ------------------------------------------------------------------
  // QA-PR „Export-Semantik vor Layout" — zentrale Prosa-Labels für
  // Beteiligten-Klassen. Tabellen, Filter-Zeilen und Detail-Tabellen in
  // PDF/DOCX dürfen keine Icons, Emojis, Bracket-Tokens („[Rad]"),
  // FontAwesome- oder SVG-Pictogramme enthalten — nur stabile, für ein
  // Verwaltungspublikum lesbare Textlabels.
  //
  // Mapping (Spec QA-Befund Punkt 1):
  //   Rad   → "Radverkehr"
  //   Fuss  → "Fußverkehr"
  //   PKW   → "PKW"
  //   Krad  → "Motorrad"
  //   Lkw   → "LKW/Güterverkehr"
  //   Sonst → "Sonstige Beteiligte"
  // ------------------------------------------------------------------
  const PARTICIPANT_PROSE = {
    Rad:   "Radverkehr",
    Fuss:  "Fußverkehr",
    PKW:   "PKW",
    Krad:  "Motorrad",
    Lkw:   "LKW/Güterverkehr",
    Sonst: "Sonstige Beteiligte"
  };
  // Bit → Code, in derselben Reihenfolge wie COMBO_BITS (Rad=1 … Sonst=32),
  // damit eine 6-Bit-Maske in eine geordnete Code-Liste zerlegt werden kann.
  const PARTICIPANT_BIT_TO_CODE = { 1: "Rad", 2: "Fuss", 4: "PKW", 8: "Krad", 16: "Lkw", 32: "Sonst" };
  // Synonyme/legacy Schreibweisen → Code (case-insensitiv). Akzeptiert
  // sowohl die Bracket-Tokens („[Rad]" aus dem alten DOCX/PDF-Pfad) als
  // auch Klartext-Varianten („Fuß", „Motorrad", „Gkfz").
  const PARTICIPANT_ALIAS = {
    "rad": "Rad", "fahrrad": "Rad", "bike": "Rad",
    "fuss": "Fuss", "fuß": "Fuss", "fussverkehr": "Fuss", "fußverkehr": "Fuss", "ped": "Fuss",
    "pkw": "PKW", "auto": "PKW", "car": "PKW",
    "krad": "Krad", "motorrad": "Krad", "moto": "Krad",
    "lkw": "Lkw", "gkfz": "Lkw", "truck": "Lkw", "lkw/güterverkehr": "Lkw",
    "sonst": "Sonst", "sonstig": "Sonst", "sonstige": "Sonst", "bus": "Sonst", "sonstige beteiligte": "Sonst"
  };
  // Emoji → Code (mirrors COMBO_BITS in this module).
  const PARTICIPANT_EMOJI_TO_CODE = {
    "\u{1F6B2}": "Rad",
    "\u{1F6B6}": "Fuss",
    "\u{1F697}": "PKW",
    "\u{1F3CD}": "Krad",
    "\u{1F69B}": "Lkw",
    "\u{1F68C}": "Sonst"
  };
  const PARTICIPANT_FALLBACK = "Keine Angabe";

  /**
   * Normalisiere einen beliebigen Eingabewert auf den kanonischen Code
   * ("Rad"/"Fuss"/"PKW"/"Krad"/"Lkw"/"Sonst") oder `null` bei nicht
   * erkennbaren Eingaben.
   * @param {string|number} input
   */
  function _normalizeParticipantCode(input) {
    if (input == null) return null;
    if (typeof input === "number" && Number.isFinite(input)) {
      const m = input & 63;
      return PARTICIPANT_BIT_TO_CODE[m] || null;
    }
    let s = String(input).trim();
    if (!s) return null;
    // Bracket-Token: "[Rad]" → "Rad"
    const br = s.match(/^\[([^\]]+)\]$/);
    if (br) s = br[1];
    // Reines Emoji?
    const em = s.replace(/\uFE0F/g, "");
    if (PARTICIPANT_EMOJI_TO_CODE[em]) return PARTICIPANT_EMOJI_TO_CODE[em];
    // Numerisch als String?
    if (/^-?\d+$/.test(s)) {
      const m = Number(s) & 63;
      return PARTICIPANT_BIT_TO_CODE[m] || null;
    }
    // Direktcode oder Alias?
    if (Object.prototype.hasOwnProperty.call(PARTICIPANT_PROSE, s)) return s;
    const lower = s.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(PARTICIPANT_ALIAS, lower)) return PARTICIPANT_ALIAS[lower];
    return null;
  }

  /**
   * Verwaltungstaugliches Prosa-Label für eine einzelne Beteiligungsklasse.
   * Akzeptiert Code ("Rad"), Bit-Wert (1), Bracket-Token ("[Rad]") oder
   * Emoji (`🚲`). Unbekannte/leere Werte → `"Keine Angabe"`.
   *
   * @param {string|number|null|undefined} input
   * @param {object} [opts]
   * @param {string} [opts.fallback="Keine Angabe"]
   * @returns {string}
   */
  function formatParticipantForExport(input, opts) {
    const fallback = (opts && opts.fallback != null) ? String(opts.fallback) : PARTICIPANT_FALLBACK;
    const code = _normalizeParticipantCode(input);
    if (!code) return fallback;
    return PARTICIPANT_PROSE[code] || fallback;
  }
  UA.formatParticipantForExport = formatParticipantForExport;

  /**
   * Prosa-Label für eine Beteiligungs-Kombination. Eingabe kann sein:
   *   - Bit-Maske (Number, z. B. 5 → "Radverkehr + PKW")
   *   - Array von Codes/Bits/Emojis (z. B. ["Rad","PKW"] oder [1,4])
   *   - String mit Trennzeichen `+` / `,` / ` ` (z. B. "[Rad]+[PKW]")
   *
   * Reihenfolge ist deterministisch (Rad, Fuss, PKW, Krad, Lkw, Sonst),
   * Duplikate werden eliminiert. Leere/komplett unerkannte Eingabe →
   * `opts.fallback` (default `"Keine Angabe"`).
   *
   * @param {number|string|Array|null|undefined} input
   * @param {object} [opts]
   * @param {string} [opts.fallback="Keine Angabe"]
   * @param {string} [opts.separator=" + "]
   * @returns {string}
   */
  function formatParticipantCombinationForExport(input, opts) {
    const fallback = (opts && opts.fallback != null) ? String(opts.fallback) : PARTICIPANT_FALLBACK;
    const separator = (opts && opts.separator != null) ? String(opts.separator) : " + ";

    // 1) Maske (Number) oder rein-numerischer String → Bits in fester
    //    Reihenfolge entpacken.
    let codes = null;
    if (typeof input === "number" && Number.isFinite(input)) {
      const m = input & 63;
      if (m === 0) return fallback;
      codes = [];
      for (const bit of [1, 2, 4, 8, 16, 32]) {
        if (m & bit) codes.push(PARTICIPANT_BIT_TO_CODE[bit]);
      }
    } else if (typeof input === "string" && /^-?\d+$/.test(input.trim())) {
      return formatParticipantCombinationForExport(Number(input.trim()), opts);
    } else if (Array.isArray(input)) {
      codes = [];
      for (const it of input) {
        const c = _normalizeParticipantCode(it);
        if (c && codes.indexOf(c) === -1) codes.push(c);
      }
    } else if (typeof input === "string") {
      // Tokenize on separators that real call-sites emit: "+", ",", "/",
      // " ", " · " — und auch Emoji-Sequenzen (ohne Trennzeichen).
      // Wir splitten zunächst grob, normalisieren jedes Token einzeln.
      // Emoji-only Sequenzen: pro Zeichen splitten (Spread auf Codepoints).
      const raw = input.trim();
      if (!raw) return fallback;
      let parts = raw.split(/\s*[+,/·]\s*|\s+/).filter(Boolean);
      // Falls ein Token noch mehrere Emojis enthält („🚲🚗"), aufspalten.
      const expanded = [];
      for (const p of parts) {
        // Bracket-Token oder Code direkt verwenden.
        if (/^\[[^\]]+\]$/.test(p) || /^[A-Za-zÄÖÜäöüß/]+$/.test(p)) {
          expanded.push(p);
          continue;
        }
        // Emoji-Sequenz: in einzelne Codepoints zerlegen.
        const cps = Array.from(p);
        for (const cp of cps) {
          if (cp === "\uFE0F") continue;
          expanded.push(cp);
        }
      }
      codes = [];
      // Prefer kanonische Sortierung: Wir sortieren am Ende nach Bit.
      const seen = new Set();
      for (const tok of expanded) {
        const c = _normalizeParticipantCode(tok);
        if (c && !seen.has(c)) {
          seen.add(c);
          codes.push(c);
        }
      }
    } else if (input != null) {
      // {} / boolean / sonstiges → fallback
      return fallback;
    } else {
      return fallback;
    }

    if (!codes || codes.length === 0) return fallback;
    // Deterministische Reihenfolge: nach Bit aufsteigend (Rad, Fuss, PKW, …).
    const codeToBit = { Rad: 1, Fuss: 2, PKW: 4, Krad: 8, Lkw: 16, Sonst: 32 };
    codes.sort((a, b) => (codeToBit[a] || 99) - (codeToBit[b] || 99));
    return codes.map(c => PARTICIPANT_PROSE[c]).join(separator);
  }
  UA.formatParticipantCombinationForExport = formatParticipantCombinationForExport;

  /**
   * Wandelt einen beliebigen Anzeige-String (Tabellenzelle, Beschriftung,
   * Fließtext) in eine Prosa-Form um, in der weder Beteiligten-Emojis
   * noch Bracket-Tokens (`[Rad]`) übrig bleiben. Das ist der zentrale
   * Filter, durch den jeder vom DOCX/PDF-Renderer ausgegebene Zellinhalt
   * läuft (siehe `replaceEmojisForDocx` / `replaceEmojisForPDF` in
   * js/ua.report_v2.js).
   *
   * Beispiele:
   *   "🚲+🚗"             → "Radverkehr + PKW"
   *   "[Rad]+[PKW]"        → "Radverkehr + PKW"
   *   "[Rad]+[PKW]: 3"     → "Radverkehr + PKW: 3"
   *   "Mehrjahres-Trend"   → "Mehrjahres-Trend"   (unverändert)
   *   ""                   → ""
   *   null/undefined       → ""
   */
  function proseLabelForExport(text) {
    if (text == null) return "";
    let s = String(text);
    if (!s) return s;
    // 1) Bracket-Tokens "[Rad]"/"[PKW]"/… → Prosa.
    s = s.replace(/\[([A-Za-zÄÖÜäöüß]+)\]/g, (m, tok) => {
      const code = _normalizeParticipantCode(tok);
      return code ? PARTICIPANT_PROSE[code] : m;
    });
    // 2) Beteiligten-Emojis → Prosa (mit optionalem VS-16).
    s = s.replace(/(\u{1F6B2}|\u{1F6B6}|\u{1F697}|\u{1F3CD}\u{FE0F}?|\u{1F69B}|\u{1F68C})/gu, (m) => {
      const stripped = m.replace(/\uFE0F/g, "");
      const code = PARTICIPANT_EMOJI_TO_CODE[stripped];
      return code ? PARTICIPANT_PROSE[code] : m;
    });
    // 3) Trennzeichen vereinheitlichen, wenn es zwischen zwei Prosa-Labels
    //    steht. Wir betrachten "+" zwischen Wörtern (kein Operator-Pluszeichen
    //    in Faktoren wie "2,5+x" — daher nur, wenn beide Seiten Buchstaben
    //    oder schließende Klammer/Wort sind).
    s = s.replace(/(\p{L})\s*\+\s*(\p{L})/gu, "$1 + $2");
    return s;
  }
  UA.proseLabelForExport = proseLabelForExport;

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
    const isGkfz = String(get("IstGkfz")) === "1" || String(get("istgkfz")) === "1";
    const isSon  = String(get("IstSonstig")) === "1" || String(get("istsonstig")) === "1";

    return (isBike ? 1 : 0) | (isPed ? 2 : 0) | (isCar ? 4 : 0) | (isMoto ? 8 : 0) | (isGkfz ? 16 : 0) | (isSon ? 32 : 0);
  }

  function interpretMask(mask) {
    if (mask === 1) return "Überrepräsentation von 🚲-Alleinunfällen kann auf Infrastruktur-Risiken (z. B. Schienenquerungen, Kanten/Spurrinnen, Belagswechsel, Engstellen) hindeuten.";
    if (mask === 2) return "Überrepräsentation von 🚶-Alleinunfällen kann auf Querungsdefizite, Sichtbehinderungen oder Stolperstellen hinweisen.";
    if (mask === 5) return "Überrepräsentation von 🚲+🚗 deutet häufig auf Konflikte an Knotenpunkten/Abbiegesituationen, Sichtbeziehungen und Führung des Radverkehrs hin.";
    if (mask === 6) return "Überrepräsentation von 🚗+🚶 weist oft auf Querungsdefizite, Sichtbeziehungen oder hohes Geschwindigkeitsniveau hin.";
    if (mask === 3) return "Überrepräsentation von 🚲+🚶 kann auf enge Führungen, gemeinsame Flächen oder fehlende Trennung hinweisen.";
    if (mask === 7) return "Überrepräsentation von 🚲+🚗+🚶 spricht für komplexe Konfliktlagen an Knotenpunkten bzw. stark frequentierten Querungen.";
    if (mask === 16) return "Überrepräsentation von 🚛-Alleinunfällen (Gkfz) kann auf ungeeignete Straßengeometrie, Schleppkurven-Probleme oder Ladungssicherungsdefizite hinweisen.";
    if (mask === 17) return "Überrepräsentation von 🚲+🚛 (Rad+Gkfz) ist besonders gefährlich – häufig Abbiegeunfälle mit totem Winkel. Maßnahmen: Abbiegeassistent, Spiegel, getrennte Signalphasen, Radwegeführung an Knotenpunkten prüfen.";
    if (mask === 18) return "Überrepräsentation von 🚶+🚛 (Fuß+Gkfz) ist besonders gefährlich – häufig Abbiege-/Rangierunfälle. Maßnahmen: Sichtfelder, Schleppkurven, Fußgängerführung und separate Signalphasen prüfen.";
    if (mask === 20) return "Überrepräsentation von 🚗+🚛 kann auf Engstellen, ungeeignete Fahrbahnbreiten oder Überholprobleme hinweisen.";
    if (mask === 21) return "Überrepräsentation von 🚲+🚗+🚛 spricht für komplexe Konflikte an Knotenpunkten mit Schwerverkehr – Radverkehrsführung und Abbiegesicherung prüfen.";
    if (mask === 22) return "Überrepräsentation von 🚶+🚗+🚛 weist auf komplexe Querungssituationen mit Schwerverkehr hin – Sichtbeziehungen und Signalisierung prüfen.";
    return "Auffälligkeit kann auf lokale Führungs-/Sicht-/Querungsprobleme hinweisen; eine Ortsbegehung und Unfallkommissionsprüfung ist angezeigt.";
  }

  // PR-QA „Textqualität": Helper, der den Faktor im deutschen Zahlformat
  // (Komma statt Punkt) liefert; verwendet von allen PATTERN_MAP-Vars
  // sowie der Abweichungs-Tabelle.
  const _fmtFactorDe = (f) => (Number.isFinite(f) ? f.toFixed(2).replace(".", ",") : "k. A.");

  // --------------------
  // Pattern template matching
  // --------------------
  const PATTERN_MAP = {
    1: {
      template: "pattern_rad_solo",
      // RAD_SOLO_CITY ist in templates/pattern_rad_solo.txt referenziert, war aber
      // bis hierher nie belegt → der Antrag enthielt sichtbar "stadtweit  Fällen".
      // Wir binden den stadtweiten Vergleichswert aus `r.baseCnt`.
      vars: (r) => ({ RAD_SOLO_FACTOR: _fmtFactorDe(r.factor), RAD_SOLO_LOCAL: String(r.locCnt), RAD_SOLO_CITY: String(r.baseCnt) })
    },
    3: {
      template: "pattern_rad_fuss",
      vars: (r) => ({ RAD_FUSS_FACTOR: _fmtFactorDe(r.factor), RAD_FUSS_LOCAL: String(r.locCnt) })
    },
    5: {
      template: "pattern_rad_pkw",
      vars: (r) => ({ RAD_PKW_FACTOR: _fmtFactorDe(r.factor), RAD_PKW_LOCAL: String(r.locCnt) })
    },
    6: {
      template: "pattern_pkw_fuss",
      vars: (r) => ({ PKW_FUSS_FACTOR: _fmtFactorDe(r.factor), PKW_FUSS_LOCAL: String(r.locCnt) })
    },
    17: {
      template: "pattern_rad_gkfz",
      vars: (r) => ({ RAD_GKFZ_FACTOR: _fmtFactorDe(r.factor), RAD_GKFZ_LOCAL: String(r.locCnt) })
    },
    18: {
      template: "pattern_fuss_gkfz",
      vars: (r) => ({ FUSS_GKFZ_FACTOR: _fmtFactorDe(r.factor), FUSS_GKFZ_LOCAL: String(r.locCnt) })
    },
    20: {
      template: "pattern_pkw_gkfz",
      vars: (r) => ({ PKW_GKFZ_FACTOR: _fmtFactorDe(r.factor), PKW_GKFZ_LOCAL: String(r.locCnt) })
    }
  };

  async function matchPatterns(dev, stadtSlug) {
    const matched = [];
    for (const r of dev.focus) {
      const mapping = PATTERN_MAP[r.mask];
      if (!mapping) continue;
      const content = await loadTemplate(mapping.template, stadtSlug);
      if (!content) continue;
      const filled = tpl(content, mapping.vars(r));
      matched.push({ mask: r.mask, template: mapping.template, content: filled, row: r });
    }
    return matched;
  }

  // --------------------
  // POI loading and analysis
  // --------------------
  async function loadPOIData(citySlug) {
    const poiPath = `out/poi_${citySlug}.geojson`;
    try {
      if (typeof UA !== 'undefined' && typeof UA.fetchJsonCompressed === 'function') {
        return await UA.fetchJsonCompressed(poiPath);
      }
      const r = await fetch(poiPath, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      console.warn(`POI data not available for ${citySlug}:`, e);
      return null;
    }
  }

  function analyzePOIs(poiData, bounds) {
    if (!poiData || !poiData.features) return null;

    const withinArea = [];
    const nearArea = [];
    const BUFFER_METERS = 200; // Define "near" as 200m from bounds

    for (const feature of poiData.features) {
      if (!feature.geometry || feature.geometry.type !== "Point") continue;
      const [lon, lat] = feature.geometry.coordinates;
      const props = feature.properties || {};

      const isWithin = bounds.contains([lat, lon]);
      
      if (isWithin) {
        withinArea.push({
          lat, lon,
          type: props.type || "unknown",
          name: props.name || "Unbenannt",
          id: props.id
        });
      } else {
        // Simple distance check (approximate)
        const sw = bounds.getSouthWest();
        const ne = bounds.getNorthEast();
        const center = bounds.getCenter();
        
        // Rough check if within buffer distance
        const distToCenter = center.distanceTo([lat, lon]);
        const boundsRadius = center.distanceTo(sw);
        
        if (distToCenter < boundsRadius + BUFFER_METERS) {
          nearArea.push({
            lat, lon,
            type: props.type || "unknown",
            name: props.name || "Unbenannt",
            id: props.id
          });
        }
      }
    }

    // Count by type
    const withinByType = {};
    const nearByType = {};
    
    for (const poi of withinArea) {
      withinByType[poi.type] = (withinByType[poi.type] || 0) + 1;
    }
    for (const poi of nearArea) {
      nearByType[poi.type] = (nearByType[poi.type] || 0) + 1;
    }

    return {
      withinArea,
      nearArea,
      withinByType,
      nearByType,
      totalWithin: withinArea.length,
      totalNear: nearArea.length
    };
  }

  // --------------------
  // Reference documents loading
  // --------------------

  /** Load a single references JSON file; returns parsed data or null on any error. */
  async function _fetchRefFile(path) {
    try {
      const r = await fetch(path, { cache: "no-store" });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      console.warn(`Reference documents not available at ${path}:`, e);
      return null;
    }
  }

  /**
   * Load references_global.json plus (if citySlug is given) references_<city>.json,
   * merge the two document lists, and deduplicate by (title+author).
   * City-specific entries win over global entries on collision.
   * Returns { documents: [...] } or null if nothing could be loaded.
   */
  async function loadReferenceDocuments(citySlug) {
    const globalData = await _fetchRefFile("templates/references_global.json");
    const cityData = citySlug ? await _fetchRefFile(`templates/references_${citySlug}.json`) : null;

    const globalDocs = (globalData && Array.isArray(globalData.documents)) ? globalData.documents : [];
    const cityDocs   = (cityData   && Array.isArray(cityData.documents))   ? cityData.documents   : [];

    if (globalDocs.length === 0 && cityDocs.length === 0) return null;

    // Deduplicate: city entries override global entries with the same title+author key.
    const dedupKey = (d) => `${(d.title || "").trim().toLowerCase()}|${(d.author || "").trim().toLowerCase()}`;
    const cityKeys = new Set(cityDocs.map(dedupKey));
    const merged = [
      ...globalDocs.filter(d => !cityKeys.has(dedupKey(d))),
      ...cityDocs
    ];
    return { documents: merged };
  }

  // --------------------
  // Gremien (committee) loading and matching
  // --------------------
  async function loadGremienData(citySlug) {
    const gremienPath = `${TEMPLATE_DIR}/gremien_${citySlug}.json`;
    try {
      const r = await fetch(gremienPath, { cache: "no-store" });
      if (!r.ok) return null;
      const data = await r.json();
      return data;
    } catch (e) {
      console.warn(`Gremien data not available for ${citySlug}:`, e);
      return null;
    }
  }

  /**
   * Match admin fields from Nominatim against a city's Gremien config.
   * Returns the best matching committee, or a fallback hint.
   *
   * @param {Object} adminData - Fields from Nominatim (suburb, city_district, borough, quarter, postcode)
   * @param {Object} gremienConfig - Config from gremien_{city}.json
   * @returns {{ gremium: string|null, typ: string|null, kontakt: string|null, confidence: string, hinweis: string }}
   */
  function matchGremium(adminData, gremienConfig) {
    if (!gremienConfig || !adminData) {
      return { gremium: null, typ: null, kontakt: null, confidence: "unbekannt", hinweis: "" };
    }

    const zuordnung = gremienConfig.zuordnung || [];
    for (const z of zuordnung) {
      const match = z.match || {};
      for (const [field, values] of Object.entries(match)) {
        const adminVal = adminData[field];
        // Support both string and array for match values
        const valArray = Array.isArray(values) ? values : [values];
        if (adminVal && valArray.includes(adminVal)) {
          return {
            gremium: z.gremium || null,
            typ: gremienConfig.gremiumTyp || null,
            kontakt: z.kontakt || null,
            confidence: "hoch",
            hinweis: gremienConfig.hinweis || ""
          };
        }
      }
    }

    return {
      gremium: null,
      typ: gremienConfig.gremiumTyp || null,
      kontakt: null,
      confidence: "unbekannt",
      hinweis: gremienConfig.fallback || "Zuständiges Gremium bitte lokal ermitteln."
    };
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
      const sorted = Object.entries(r.byMask)
        .map(([m, c]) => ({ m: Number(m), c }))
        .sort((a, b) => b.c - a.c);
      // Task 1: emoji-Label fürs HTML/PDF (mit pdfInvolvementCell-SVG-Substitution).
      // Separator ist `: ` statt `=`, damit auch ohne Emoji-Glyph nichts wie
      // "+= 4" stehen bleibt – siehe QA-Plan Phase 1.2 (keine "+", "=", "0").
      const classes = sorted.map(e =>
        `${COMBO_LABEL[e.m] || formatInvolvementCombo(e.m, { format: "emoji" })}: ${e.c}`
      );
      // textClasses: deterministischer Bracket-Fallback für DOCX/Klartext,
      // wo Emoji-Fonts auf Verwaltungs-Arbeitsplätzen nicht zwingend
      // vorhanden sind. Wird vom DOCX-Renderer bevorzugt, falls vorhanden.
      const textClasses = sorted.map(e =>
        `${formatInvolvementCombo(e.m, { format: "text" })}: ${e.c}`
      );
      out.push({ year: y, total: r.total, classes, textClasses });
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

      // Wilson-Score-Konfidenzintervall (95 %) für den lokalen Anteil
      const ci = (typeof UA.wilsonScoreInterval === "function")
        ? UA.wilsonScoreInterval(locCnt, local.total)
        : { low: 0, high: 1 };
      // Signifikant überrepräsentiert: untere CI-Grenze liegt über baseR.
      // Auch korrekt wenn baseR === 0: jeder lokale Treffer (locCnt > 0) führt
      // dann zu ci.low > 0 = baseR und damit zu Signifikanz, was fachlich
      // gewollt ist (Stadt-Baseline kennt das Muster nicht, lokal tritt es auf).
      const isSignificant = local.total > 0 && ci.low > baseR;

      rows.push({
        mask: m,
        // Emoji-Label (für HTML/PDF mit Icon-Substitution) plus
        // deterministisches Bracket-Label (Task 1, für DOCX/Klartext).
        label: COMBO_LABEL[m] || formatInvolvementCombo(m, { format: "emoji" }),
        textLabel: formatInvolvementCombo(m, { format: "text" }),
        locCnt, baseCnt, locR, baseR, factor,
        ciLow: ci.low, ciHigh: ci.high, isSignificant
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
  }

  // --------------------
  // crossTableSeverityByMask: Kreuztabelle Beteiligungskombination × Schweregrad
  // Accepts a pre-filtered list of points (already in-bounds, already passing non-involvement filters).
  // --------------------
  function crossTableSeverityByMask(filteredPts) {
    const byMask = {};

    for (const p of filteredPts) {
      const pr = p.props || {};
      const m = maskFromProps(pr);
      if (m === 0) continue;

      if (!byMask[m]) byMask[m] = { sev1: 0, sev2: 0, sev3: 0 };
      const k = String(pr.ukategorie ?? "");
      if (k === "1") byMask[m].sev1++;
      else if (k === "2") byMask[m].sev2++;
      else if (k === "3") byMask[m].sev3++;
    }

    const rows = Object.entries(byMask).map(([mStr, v]) => {
      const mask = Number(mStr);
      const total = v.sev1 + v.sev2 + v.sev3;
      return {
        mask,
        label: COMBO_LABEL[mask] || formatInvolvementCombo(mask, { format: "emoji" }),
        textLabel: formatInvolvementCombo(mask, { format: "text" }),
        sev1: v.sev1, sev2: v.sev2, sev3: v.sev3, total
      };
    });

    rows.sort((a, b) => b.total - a.total);

    const totals = rows.reduce((acc, r) => ({
      sev1: acc.sev1 + r.sev1,
      sev2: acc.sev2 + r.sev2,
      sev3: acc.sev3 + r.sev3,
      total: acc.total + r.total
    }), { sev1: 0, sev2: 0, sev3: 0, total: 0 });

    return { rows: rows.filter(r => r.total > 0), totals };
  }

  // --------------------
  // accidentDetailTable: Einzelunfall-Liste für markierte Bereiche
  // Accepts a pre-filtered list of points (already in-bounds, already passing non-involvement filters).
  // --------------------
  const SEV_LABEL_MAP = { "1": "Getötet", "2": "Schwerverletzt", "3": "Leichtverletzt" };

  // Weekday raw codes (1=So, 2=Mo, …, 7=Sa) → { day, group }.
  // The Werktag/Wochenende grouping is derived from UA.WEEKEND_SET (single
  // source of truth in ua.utils.js) so it never drifts from how the rest of
  // the app classifies day-types (filters, dayType selector, etc.).
  const WEEKDAY_LABEL_MAP = (() => {
    const days = { "1": "So", "2": "Mo", "3": "Di", "4": "Mi", "5": "Do", "6": "Fr", "7": "Sa" };
    const weekendSet = (UA.WEEKEND_SET instanceof Set) ? UA.WEEKEND_SET : new Set(["1", "7"]);
    const m = {};
    for (const k of Object.keys(days)) {
      m[k] = { day: days[k], group: weekendSet.has(k) ? "Wochenende" : "Werktag" };
    }
    return m;
  })();
  const ROAD_COND_LABEL_MAP = { "0": "trocken", "1": "nass/feucht", "2": "winterglatt" };

  // Shared helper: format lat/lon pair for display; uses "—" when coordinates are missing
  function formatCoords(lat, lon) {
    if (lat != null && lon != null) return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
    return "—";
  }

  function accidentDetailTable(filteredPts, maxRows, viewId, viewOpts) {
    const items = [];

    for (const p of filteredPts) {
      const pr = p.props || {};
      const mask = maskFromProps(pr);
      if (mask === 0) continue;

      const severity = String(pr.ukategorie ?? "");
      const year = parseInt(pr.year, 10);
      const hour = parseInt(pr.ustunde, 10);
      const weekdayRaw = String(pr.uwochentag ?? "");
      const roadCondRaw = String(pr.strzustand ?? "");

      items.push({
        lat: p.lat,
        lon: p.lon,
        year: Number.isFinite(year) ? year : null,
        severity,
        sevLabel: SEV_LABEL_MAP[severity] || severity,
        involved: COMBO_LABEL[mask] || ("Mask " + mask),
        hour: Number.isFinite(hour) ? hour : null,
        weekday: WEEKDAY_LABEL_MAP[weekdayRaw]?.day ?? weekdayRaw,
        weekdayGroup: WEEKDAY_LABEL_MAP[weekdayRaw]?.group ?? null,
        roadCondition: ROAD_COND_LABEL_MAP[roadCondRaw] || roadCondRaw,
        mask
      });
    }

    // Delegate grouping/cap/header rendering to the strategy registry.
    // `maxRows` overrides the strategy's default rowCap (back-compat with the
    // old per-group cap argument; tests and callers may still pass a number).
    // The override is passed explicitly to applyAccidentView so the shared
    // strategy object is never mutated (re-entrant / concurrent safe).
    // `viewOpts` may carry strategy-specific data (e.g. byTimePattern uses
    // `clusters` to support per-city time-cluster overrides).
    const resolvedViewId = viewId || (UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");
    const view = (UA.resolveAccidentView ? UA.resolveAccidentView(resolvedViewId) : null);
    const explicitCap = (maxRows !== undefined && Number.isFinite(Number(maxRows)))
      ? Number(maxRows)
      : null;
    const cap = explicitCap !== null
      ? explicitCap
      : (view && Number.isFinite(view.rowCap) ? view.rowCap : 20);

    const opts = Object.assign({ rowCap: cap }, viewOpts || {});

    let viewResult;
    if (UA.applyAccidentView) {
      viewResult = UA.applyAccidentView(items, resolvedViewId, opts);
    } else {
      // Should not happen in production (ua.accident_views.js loads before ua.export_v2.js).
      viewResult = { viewId: resolvedViewId, columns: [], groups: [], total: items.length, truncated: false };
    }

    // Back-compat shape expected by existing tests / consumers:
    //   - groups[].sevKey, sevLabel (singular: "Getötet"), count, rows, overflow, histogram
    //   - rows: flattened cap-applied rows
    //   - total, truncated
    // For non-bySeverity views these legacy fields are best-effort.
    const legacyGroups = viewResult.groups.map(g => {
      const sevKey = g.key;
      const isSeverityKey = sevKey === "1" || sevKey === "2" || sevKey === "3";
      // Singular label (PR #219 contract). Plural form lives in meta.sevLabel.
      const sevLabelSingular = isSeverityKey
        ? SEV_LABEL_MAP[sevKey]
        : ((g.meta && g.meta.label) || g.key);
      return {
        // Back-compat keys (PR #219 tests and ua.report_v2 fallback)
        sevKey: isSeverityKey ? sevKey : g.key,
        sevLabel: sevLabelSingular,
        count: g.count,
        rows: g.rows,
        overflow: g.overflow,
        histogram: (g.meta && g.meta.histogram) || "",
        // Strategy-aware keys (used by ua.report_v2 / new HTML/text rendering)
        key: g.key,
        meta: g.meta,
        headers: g.headers,
        overflowLabel: g.overflowLabel
      };
    });

    const allRows = legacyGroups.flatMap(g => g.rows);

    return {
      viewId: viewResult.viewId,
      columns: viewResult.columns,
      groups: legacyGroups,
      rows: allRows,
      total: viewResult.total,
      truncated: viewResult.truncated
    };
  }

  // Export for testing and external use
  UA.accidentDetailTable = accidentDetailTable;
  UA.topDeviations = topDeviations;

  // --------------------
  // Public API: UA.computeExportReport(ctx)
  // --------------------
  UA.computeExportReport = async function computeExportReport(ctx) {
    const bounds = boundsForExport(ctx);
    
    const center = bounds.getCenter ? bounds.getCenter() : null;
    let loc = null;
    if (center) {
      loc = await UA.reverseGeocode(center.lat, center.lng);
      // Issue 3: cache compact `locationHint` on ctx so the political-context
      // panel can use street/district from the same reverse-geocode result
      // without redoing the call.
      try {
        const a = (loc && loc.address) || {};
        const adm = (loc && loc.admin) || {};
        const street = a.road || null;
        const district = a.city_district || adm.city_district || adm.borough || adm.quarter || null;
        const suburb = a.suburb || adm.suburb || null;
        if (street || district || suburb) {
          ctx.locationHint = {
            street: street || null,
            district: district || null,
            suburb: suburb || null,
            label: (loc && loc.label) || null
          };
        }
      } catch (_) { /* defensive */ }
    }
    
    const sw = bounds.getSouthWest();
    const ne = bounds.getNorthEast();
    const bStr = `${sw.lat.toFixed(5)},${sw.lng.toFixed(5)} – ${ne.lat.toFixed(5)},${ne.lng.toFixed(5)}`;

    const dev = topDeviations(ctx, bounds);
    const yr = yearTable(ctx, bounds);
    const sev = severityStats(ctx, bounds);
    const range = yearsRange(ctx.allPts || []);

    // Pre-filter points once: applies non-involvement filters + in-bounds check.
    // Both new summary tables share this filtered list to avoid repeated full scans over ctx.allPts.
    const filteredPts = getPointsInBounds(ctx);  // see getPointsInBounds() below
    const crossTable = crossTableSeverityByMask(filteredPts);
    const accidentViewId = ctx.accidentView || (UA.ACCIDENT_VIEW_DEFAULT || "bySeverity");

    const CITY_RAW = ctx.CITY_RAW || "—";
    const citySlug = UA.normKey ? UA.normKey(CITY_RAW) : CITY_RAW.toLowerCase().replace(/[^a-z0-9]+/g, "_");

    // Resolve optional-section toggles up front so we can gate expensive
    // fetch/parse work (cost factors, measures catalog, time clusters) on the
    // common path where the user disabled the corresponding modal options.
    const includeCosts = !ctx.exportOptions || ctx.exportOptions.includeCosts !== false;
    const includeMeasures = !ctx.exportOptions || ctx.exportOptions.includeMeasures !== false;

    // Task 10: Politischer Sprachmodus. Ausschließlich über
    // ctx.exportOptions.mode aktiviert (UI-Checkbox #cbPoliticalLanguage).
    // Wirkt sich auf Faktor-Wording (Task 9) und 95%-KI-Auslassung (Task 10) aus.
    const exportMode = (ctx.exportOptions && ctx.exportOptions.mode === "political")
      ? "political"
      : "technical";

    // Load time clusters only when the byTimePattern view is actually active —
    // the other strategies (bySeverity / byInvolvement / flat) ignore the
    // cluster set, so on the default path no fetch/parse happens.
    let timeClusters = null;
    if (accidentViewId === "byTimePattern" && UA.timeClusters && UA.timeClusters.loadTimeClusters) {
      try {
        const cfg = await UA.timeClusters.loadTimeClusters(citySlug);
        timeClusters = (cfg && Array.isArray(cfg.clusters)) ? cfg.clusters : null;
      } catch (e) {
        console.warn("Time-cluster loading failed:", e);
      }
    }
    const accidentDetails = accidentDetailTable(filteredPts, undefined, accidentViewId, { clusters: timeClusters });

    // Load POI data
    let poiAnalysis = null;
    try {
      const poiData = await loadPOIData(citySlug);
      if (poiData) {
        poiAnalysis = analyzePOIs(poiData, bounds);
      }
    } catch (e) {
      console.warn("POI analysis failed:", e);
    }

    // Load reference documents
    let refDocs = null;
    try {
      refDocs = await loadReferenceDocuments(citySlug);
    } catch (e) {
      console.warn("Reference documents loading failed:", e);
    }

    // Match pattern templates based on detected deviations
    let matchedPatterns = [];
    try {
      matchedPatterns = await matchPatterns(dev, citySlug);
    } catch (e) {
      console.warn("Pattern matching failed:", e);
    }

    // Load Gremien data and match committee
    let gremiumMatch = { gremium: null, typ: null, kontakt: null, confidence: "unbekannt", hinweis: "" };
    try {
      const gremienConfig = await loadGremienData(citySlug);
      if (gremienConfig && loc && loc.admin) {
        gremiumMatch = matchGremium(loc.admin, gremienConfig);
      } else if (gremienConfig) {
        gremiumMatch = matchGremium({}, gremienConfig);
      }
    } catch (e) {
      console.warn("Gremien matching failed:", e);
    }

    const areaName = (loc && (loc.details || loc.label)) ? (loc.details || loc.label) : bStr;
    const visualContextHints = buildVisualContextHints(ctx);

    // ---- Yearly trend (#C2): linear regression over per-year counts ----
    // Always computed when UA.trend is available — it's a pure function over
    // the in-bounds points, so we don't gate it behind a modal toggle.
    // Computed early so downstream blocks (e.g. economicImpact.trendQualifier)
    // can reference the trend classification.
    let yearlyTrend = null;
    if (UA.trend && typeof UA.trend.computeYearlyTrend === "function") {
      try {
        yearlyTrend = UA.trend.computeYearlyTrend(filteredPts);
      } catch (e) {
        console.warn("Yearly trend computation failed:", e);
      }
    }

    // ---- OSM context (#C4) ----
    // Network call to the Overpass API; gated by exportOptions.includeOsmContext
    // (default ON). The helper is fully defensive — it returns either the
    // aggregated summary, a `{ quality.error }` stub, or `null` (invalid bbox).
    // We tolerate all three so a slow/blocked Overpass mirror never breaks the
    // report. Caller can pass `ctx.exportOptions.osmContextOverride` (already
    // computed payload) to skip the fetch — used by tests and the AI flow,
    // which may want to feed pre-fetched context into the prompt.
    // Computed early so the recommendedMeasures filter can read its summary.
    const includeOsmContext = !ctx.exportOptions || ctx.exportOptions.includeOsmContext !== false;
    let osmContext = null;
    if (includeOsmContext && UA.osmContext && typeof UA.osmContext.fetchOsmContext === "function") {
      const override = ctx.exportOptions && ctx.exportOptions.osmContextOverride;
      if (override !== undefined) {
        osmContext = override;
      } else {
        try {
          osmContext = await UA.osmContext.fetchOsmContext({
            south: sw.lat, west: sw.lng, north: ne.lat, east: ne.lng
          }, ctx.exportOptions && ctx.exportOptions.osmContextOpts);
        } catch (e) {
          console.warn("OSM context fetch failed:", e);
          osmContext = null;
        }
      }
    }

    // ---- Economic impact (PR-C / B2): annual external cost via BASt-like factors ----
    // Only computed when the modal toggle "Volkswirtschaftliche Kosten" is on
    // (default ON). Skipping avoids a fetch + parse on the common opted-out path.
    let economicImpact = null;
    if (includeCosts && UA.costs && UA.costs.loadCostFactors) {
      try {
        const factors = await UA.costs.loadCostFactors();
        const yearsCount = (range && range.minY != null && range.maxY != null)
          ? Math.max(1, range.maxY - range.minY + 1)
          : 1;
        const calc = UA.costs.computeAnnualCost(sev.bySev, yearsCount, factors);
        economicImpact = {
          annual: calc.annual,
          total: calc.total,
          years: calc.years,
          breakdown: calc.breakdown,
          counts: calc.counts,
          source: factors.source,
          disclaimer: factors.disclaimer,
          // Trend-Qualifier (PR-β): nutzt die bereits berechnete `yearlyTrend`-
          // Klassifikation, damit Antragstexte den Kostenblock ehrlich
          // einordnen können ("stagnierend hoch", "rückläufig").
          trendQualifier: (yearlyTrend && yearlyTrend.classification) || null
        };
      } catch (e) {
        console.warn("Economic impact computation failed:", e);
      }
    }

    // ---- Recommended measures (PR-D / B1+B3) ----
    // Only computed when the modal toggle "Maßnahmenvorschläge" is on
    // (default ON). Avoids loading the catalog on the common opted-out path.
    // Receives `osmContext` so the engine can suppress measures whose
    // `prerequisites` are not met (z. B. Tempo 30 nur, wenn aktuell > 30).
    //
    // Kontextuelle Maßnahmen-Logik (UA.contextMeasures, separate Engine):
    //   Liefert (Pattern × Kontext)-spezifische Prüfaufträge und ergänzt
    //   sie als `structured.contextualMeasures`. Außerdem werden die
    //   erkannten Kontexte an `recommendMeasures` als
    //   `opts.activeContexts` weitergereicht — die Katalog-Engine kann
    //   damit generische Maßnahmen unterdrücken, deren `prerequisites`
    //   `suppressInContexts` setzen (z. B. „Sichtbeziehungen
    //   herstellen / Bewuchs zurückschneiden" entfällt im Bahnhofs-/
    //   Schienen-Kontext, sofern keine explizite Sicht-Evidenz vorliegt).
    let activeContexts = null;
    if (UA.contextMeasures && typeof UA.contextMeasures.detectContexts === "function") {
      const ovr = ctx.exportOptions && ctx.exportOptions.contextTypes;
      activeContexts = UA.contextMeasures.detectContexts(osmContext, ovr);
    }

    let recommendedMeasures = null;
    if (includeMeasures && UA.measures && UA.measures.loadCatalog && UA.measures.recommendMeasures) {
      try {
        const detectedPatterns = (dev.focus || []).map(r => Number(r.mask)).filter(Number.isFinite);
        if (detectedPatterns.length > 0) {
          const catalog = await UA.measures.loadCatalog(citySlug);
          recommendedMeasures = UA.measures.recommendMeasures(detectedPatterns, catalog, {
            limit: 5,
            economicImpact: economicImpact,
            osmContext: osmContext,
            activeContexts: activeContexts
          });
          // Enrich each entry with `derivedFrom`: the human-readable focus
          // labels that triggered this measure. This is the explicit link
          // back to the URSACHEN-block (Goldstandard Items 5–6: avoid
          // unmoored repetition between „Ursachen" and „Empfohlene
          // Maßnahmen"). matchedPatterns already carries the masks; we
          // resolve them against dev.focus once so renderers can simply
          // print labels without re-doing the lookup per format.
          if (recommendedMeasures && Array.isArray(recommendedMeasures.measures)) {
            const focusByMask = new Map();
            for (const r of (dev.focus || [])) {
              const k = Number(r.mask);
              if (Number.isFinite(k) && !focusByMask.has(k)) {
                focusByMask.set(k, r.textLabel || r.label || formatInvolvementCombo(k, { format: "text" }));
              }
            }
            for (const item of recommendedMeasures.measures) {
              const masks = Array.isArray(item.matchedPatterns) ? item.matchedPatterns : [];
              item.derivedFrom = masks
                .map(m => Number(m))
                .filter(Number.isFinite)
                .map(m => ({ mask: m, label: focusByMask.get(m) || formatInvolvementCombo(m, { format: "text" }) }));
            }
          }
        }
      } catch (e) {
        console.warn("Measure recommendation failed:", e);
      }
    }

    // Orts- und musterbezogene Empfehlungen (UA.contextMeasures). Wird
    // *vor* dem TEXT-Rendering berechnet, damit die kontext-spezifischen
    // Prüfaufträge im Antrag VOR der allgemeinen Maßnahmenliste stehen
    // — ein Antrag muss mit den passenden Vorschlägen beginnen, nicht
    // mit pauschalen Standardmaßnahmen (QA-Spec Item 5+8). Das fertige
    // Objekt wird unten zusätzlich in `structured.contextualMeasures`
    // durchgereicht.
    let contextualMeasures = null;
    if (UA.contextMeasures && typeof UA.contextMeasures.deriveContextualMeasures === "function") {
      try {
        // classifyPatterns liest aus structured.deviations + severity +
        // weather + heatmap. Hier rekonstruieren wir die nötigen Felder
        // aus den lokalen Variablen (structured wird erst weiter unten
        // zusammengesetzt, siehe `const structured = { … }`).
        const stubForClassifier = {
          deviations: { focus: dev.focus || [] },
          severity: { bySev: sev.bySev || {} }
          // weather/heatmap-Eskalationen werden bewusst weggelassen,
          // solange computeExportReport sie nicht im selben Schema in
          // structured ablegt — die Fallback-Pfade in classifyPatterns
          // sind defensiv (fehlende Felder schweigen).
        };
        const pKeys = UA.contextMeasures.classifyPatterns(stubForClassifier);
        const cm = UA.contextMeasures.deriveContextualMeasures(pKeys, activeContexts || new Set());
        if (cm && Array.isArray(cm.matchedRules) && cm.matchedRules.length > 0) {
          contextualMeasures = {
            ...cm,
            patterns: Array.from(pKeys),
            contexts: Array.from(activeContexts || [])
          };
        }
      } catch (e) {
        console.warn("contextualMeasures derivation failed:", e);
      }
    }

    // ---- Hour × daytype heatmap (#A2) ----
    // Gated by ctx.exportOptions.includeHeatmap (default ON). Cheap to compute
    // (single pass over filteredPts), but the renderers would otherwise burn
    // page space on a panel the user explicitly hid.
    const includeHeatmap = !ctx.exportOptions || ctx.exportOptions.includeHeatmap !== false;
    let heatmap = null;
    if (includeHeatmap && UA.heatmap && typeof UA.heatmap.computeHourDaytypeMatrix === "function") {
      try {
        heatmap = UA.heatmap.computeHourDaytypeMatrix(filteredPts);
      } catch (e) {
        console.warn("Heatmap computation failed:", e);
      }
    }

    const vars = {
      city: CITY_RAW,
      CITY: CITY_RAW,
      bounds: bStr,
      BOUNDS: bStr,
      local_total: dev.local.total.toLocaleString(),
      baseline_total: dev.baseline.total.toLocaleString(),
      severity_summary: ((sev.bySev["1"] || 0) > 0
        ? `Im Ausschnitt wurden ${sev.bySev["1"]} Getötete, ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`
        : `Im Ausschnitt wurden ${sev.bySev["2"] || 0} Schwerverletzte und ${sev.bySev["3"] || 0} Leichtverletzte registriert.`),
      date: new Date().toLocaleDateString("de-DE"),
      DATE: new Date().toLocaleDateString("de-DE"),
      link: window.location.href,
      LINK: window.location.href,
      area_name: areaName,
      AREA_NAME: areaName,
      THRESH_FACTOR: "1,35",
      location_label: loc ? loc.label : "",
      location_details: loc ? loc.details : "",
      location_osm: loc ? loc.osmUrl : "",
      GREMIUM_NAME: gremiumMatch.gremium || "—",
      GREMIUM_TYP: gremiumMatch.typ || "—",
      GREMIUM_HINWEIS: gremiumMatch.hinweis || "Zuständigkeit vor Einreichung bitte prüfen.",
      GREMIUM_KONTAKT: gremiumMatch.kontakt || ""
    };

    // Load Gen-2 templates with Gen-1 fallback:
    // If Gen-2 file loads successfully (non-empty), use it; otherwise fall back to Gen-1.
    // Always returns { content: string, isGen2: boolean } regardless of which generation was used.
    async function loadGen2WithFallback(gen2Name, gen1Name) {
      const gen2 = await loadTemplate(gen2Name, citySlug);
      if (gen2) return { content: gen2, isGen2: true };
      return { content: await loadTemplate(gen1Name, citySlug), isGen2: false };
    }

    const [introResult, tSach, beschResult, hinwResult, lizResult, tMethod] = await Promise.all([
      loadGen2WithFallback("base_intro", "intro"),
      loadTemplate("sachverhalt", citySlug),
      loadGen2WithFallback("base_resolution", "beschluss"),
      loadGen2WithFallback("outro_internal_note", "hinweis"),
      loadGen2WithFallback("outro_source_note", "lizenz"),
      loadTemplate("base_method", citySlug)
    ]);
    const tIntro = introResult.content;
    const isGen2Intro = introResult.isGen2;
    const tBesch = beschResult.content;
    // PR-QA Task 8: Marker-Zeile aus dem internal-note-Template entfernen, damit
    // `[Interner Hinweis – vor Versand entfernen]` nicht im offiziellen Antrag landet.
    const tHinw = stripInternalMarkerHeader(hinwResult.content);
    const tLiz = lizResult.content;

    // ---- Text (Clipboard/Word) ----
    const lines = [];
    lines.push(tpl(tIntro, vars).trim());
    lines.push("");

    // When Gen-2 intro is used (base_intro.txt), it already contains "Stadt:" and
    // "Erstellt am:" in the cover block – skip those duplicate lines to avoid
    // doubled metadata in the output.  Datenzeitraum and location are new info, keep them.
    if (!isGen2Intro) {
      lines.push(`Stadt: ${CITY_RAW}`);
    }
    if (range) lines.push(`Datenzeitraum: ${range.minY}–${range.maxY}`);
    lines.push(`Ausschnitt (Bounds): ${bStr}`);

    if (loc) {
      lines.push(`Lage/Adresse (Mittelpunkt): ${loc.details || loc.label}`);
      lines.push(`OSM: ${loc.osmUrl}`);
    }

    if (!isGen2Intro) {
      lines.push(`Datum: ${vars.date}`);
    }
    lines.push("");

    // Task 2 – KURZBEWERTUNG (Executive Summary). Build deterministically
    // from the structured fields we already computed; renders in TEXT/HTML/
    // DOCX/PDF as the first content block after the cover.
    const _executiveSummary = buildExecutiveSummary({
      deviations: dev, severity: sev, yearlyTrend
    }, { mode: exportMode });
    lines.push("KURZBEWERTUNG:");
    lines.push("  " + _executiveSummary.classification);
    for (const b of _executiveSummary.bullets) lines.push("  • " + b);
    lines.push("  " + _executiveSummary.urgency);
    lines.push("");

    // Task 7 – Map-Reference Sätze unmittelbar nach KURZBEWERTUNG.
    if (areaName) {
      lines.push(`Die in Anlage 1 dokumentierte Karte zeigt die räumliche Verteilung der Vorfälle im Bereich ${areaName}.`);
    } else {
      lines.push("Die in Anlage 1 dokumentierte Karte zeigt die räumliche Verteilung der Vorfälle im markierten Bereich.");
    }
    // Task 6 – Räumliche Argumentation aus Koordinaten (nicht aus Heatmap):
    // Knotenpunkt vs. Korridor vs. verteilte Schwerpunkte.
    for (const s of deriveSpatialArgumentation(filteredPts)) {
      lines.push(s);
    }
    if (loc && (loc.details || loc.label)) {
      lines.push(`Schwerpunkt der Häufung: ${loc.details || loc.label}.`);
    }
    if (visualContextHints) {
      const src = visualContextHints.source || {};
      const srcLabel = [src.layerName, src.provider].filter(Boolean).join(" / ");
      lines.push("Visuelle Hinweise (Orthofoto/Luftbild):");
      for (const hint of (visualContextHints.hints || [])) {
        lines.push(`  - ${hint}`);
      }
      if (srcLabel) {
        lines.push(`  Quelle/Provenienz: ${srcLabel}.`);
      }
      lines.push(`  Empfehlung: ${visualContextHints.recommendation}`);
    }
    lines.push("");

    lines.push(tpl(tSach, vars).trim());
    lines.push("");

    if (dev.focus.length) {
      lines.push("Auffälligkeiten (Top-Abweichungen, Anteil im Ausschnitt vs. Stadt):");
      for (const r of dev.focus) {
        // Task 9/10: Politischer Modus → Faktor in Worten, kein 95%-KI.
        if (exportMode === "political") {
          const phrase = formatFactorPolitical(r.factor, { mode: "political" });
          const lbl = r.textLabel || r.label;
          lines.push(`- ${lbl}: ${phrase} (lokal ${r.locCnt} Fälle, stadtweit ${r.baseCnt}).`);
        } else {
          const ciStr = `95%-KI: ${fmtPct(r.ciLow)} – ${fmtPct(r.ciHigh)}`;
          const sigStr = r.isSignificant ? "signifikant" : "nicht signifikant – kleine Datenmenge";
          lines.push(`- ${r.label}: lokal ${fmtPct(r.locR)} vs Stadt ${fmtPct(r.baseR)} (Faktor ${_fmtFactorDe(r.factor)}, ${ciStr}; ${sigStr}); lokal ${r.locCnt} / stadtweit ${r.baseCnt}`);
        }
      }
      // Task 10: 95%-KI/n.s.-Hinweis nur im technischen Modus.
      if (exportMode !== "political") {
        const allNonSignificant = dev.focus.every(r => !r.isSignificant);
        if (allNonSignificant) {
          lines.push("Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (kleine Fallzahlen). Die Faktor-Werte sollten mit Vorsicht interpretiert werden.");
        }
      }
      lines.push("");
      // Task 4 – URSACHEN UND MASSNAHMEN-Block direkt nach den Abweichungen.
      const _causes = buildCausesMeasuresSection(dev.focus, recommendedMeasures);
      if (_causes.length > 0) {
        lines.push("URSACHEN UND MASSNAHMEN (kurz):");
        for (const c of _causes) {
          // Wenn die Empfohlene-Maßnahmen-Liste die Maßnahme bereits
          // enthält, referenzieren wir per „#N (Label)" — so sieht der
          // Leser die Verbindung zur Detail-Liste unten und wir
          // wiederholen das Label nicht stumm. Ohne Cross-Refs (z. B.
          // Maßnahmen-Toggle aus, Fallback aus CAUSE_MEASURE_FALLBACK)
          // bleibt die alte Label-Liste erhalten.
          const list = (c.measureRefs && c.measureRefs.length > 0)
            ? c.measureRefs.map(e => `#${e.idx} (${e.label})`).join("; ")
            : c.measures.join("; ");
          lines.push(`  ${c.cause}: ${list}`);
        }
        lines.push("");
      }
      // Include pattern-specific assessments (Gen-2) if available, else fall back to heuristic
      if (matchedPatterns.length > 0) {
        for (const p of matchedPatterns) {
          lines.push(p.content.trim());
          lines.push("");
        }
      } else {
        lines.push("Bewertung / Interpretation (heuristisch):");
        for (const r of dev.focus.slice(0, 3)) {
          lines.push(`- ${r.label}: ${interpretMask(r.mask)}`);
        }
        lines.push("");
      }
    } else {
      lines.push("Auffälligkeiten: In diesem Ausschnitt zeigen sich unter den gewählten Filtern keine klar überrepräsentierten Beteiligungskombinationen (Schwelle: min. 3 Fälle, Faktor ≥ 1,35).");
      lines.push("");
    }

    // Add methodology section (Gen-2)
    if (tMethod) {
      lines.push(tpl(tMethod, vars).trim());
      lines.push("");
    }

    // Mehrjahres-Trend (#C2): kompakte Tabelle + Klassifikation.
    if (yearlyTrend && yearlyTrend.years && yearlyTrend.years.length > 0) {
      lines.push("Mehrjahres-Trend (Gesamtzahl pro Jahr):");
      const header = "  Jahr | Getötete | Schwerverletzte | Leichtverletzte | Summe";
      lines.push(header);
      for (let i = 0; i < yearlyTrend.years.length; i++) {
        lines.push(`  ${yearlyTrend.years[i]} | ${yearlyTrend.counts.fatal[i]} | ${yearlyTrend.counts.severe[i]} | ${yearlyTrend.counts.light[i]} | ${yearlyTrend.counts.total[i]}`);
      }
      const slopeStr = Number.isFinite(yearlyTrend.slope) ? yearlyTrend.slope.toFixed(2) : "—";
      const r2Str = Number.isFinite(yearlyTrend.r2) ? yearlyTrend.r2.toFixed(2) : "—";
      lines.push(`  Klassifikation: ${yearlyTrend.classification} (Slope ${slopeStr}/Jahr, R² ${r2Str}, n=${yearlyTrend.nYears}).`);
      lines.push("");
    }

    // Stunden-Heatmap (#A2): Top-3 Spitzenstunden je Tagestyp als
    // textfreundliche Zusammenfassung. Die volle 24×2-Matrix steckt in
    // structured.heatmap und wird in HTML/PDF/DOCX vollständig dargestellt.
    if (heatmap && heatmap.total > 0) {
      lines.push("Stunden-Heatmap (Werktag vs. Wochenende):");
      lines.push(`  Gesamt im Bereich: ${heatmap.total} (Mo–Fr: ${heatmap.colTotals[0]}, Sa/So: ${heatmap.colTotals[1]}).`);
      const topPerCol = (col) => {
        const ranked = heatmap.hours
          .map(h => ({ h, v: heatmap.matrix[h][col] }))
          .filter(x => x.v > 0)
          .sort((a, b) => b.v - a.v)
          .slice(0, 3);
        return ranked.length === 0
          ? "—"
          : ranked.map(x => `${String(x.h).padStart(2, "0")}:00 (${x.v})`).join(", ");
      };
      lines.push(`  Spitzenstunden Mo–Fr: ${topPerCol(0)}.`);
      lines.push(`  Spitzenstunden Sa/So: ${topPerCol(1)}.`);
      lines.push("");
    }

    // OSM-Kontext (#C4): kurze Zusammenfassung der Verkehrsanlagen im Bereich.
    // `osmContext` ist eines von: null (Toggle aus / ungültige Bbox),
    // { quality:{error} } (Netzfehler) oder die volle Aggregation. Nur bei
    // einer echten Aggregation rendern wir Daten — Fehlerfälle erwähnen wir
    // dezent, damit Leser des Antrags wissen, warum hier nichts steht.
    if (osmContext && osmContext.summary) {
      lines.push("Verkehrsräumlicher Kontext (OSM):");
      const sumLine = (UA.osmContext && UA.osmContext.summarizeForText)
        ? UA.osmContext.summarizeForText(osmContext)
        : null;
      if (sumLine) lines.push("  " + sumLine);
      lines.push(`  Quelle: ${osmContext.source.publisher} (${osmContext.source.license}), via ${osmContext.source.retrievedVia}.`);
      lines.push("");
    } else if (osmContext && osmContext.quality && osmContext.quality.error) {
      lines.push("Verkehrsräumlicher Kontext (OSM): OSM-Kontextdaten konnten beim Export nicht geladen werden.");
      lines.push("");
    }

    // Add economic impact (PR-C / B2): respect ctx.exportOptions.includeCosts (default ON).
    // Note: `economicImpact` is null when the toggle was off (load gated above).
    if (includeCosts && economicImpact && economicImpact.total > 0) {
      const fmt = (UA.costs && UA.costs.formatEUR) ? UA.costs.formatEUR : (n) => `${n} €`;
      lines.push("Volkswirtschaftliche Bedeutung (Schätzung):");
      lines.push(`  Geschätzte externe Kosten im Bereich: ${fmt(economicImpact.total)} (Datenzeitraum ${economicImpact.years} Jahr${economicImpact.years === 1 ? "" : "e"}).`);
      lines.push(`  Pro Jahr: ca. ${fmt(economicImpact.annual)}.`);
      lines.push(`  Aufschlüsselung – Getötete: ${fmt(economicImpact.breakdown.fatal)} · Schwerverletzte: ${fmt(economicImpact.breakdown.severe)} · Leichtverletzte: ${fmt(economicImpact.breakdown.light)}.`);
      // Trend-Qualifier: Klassifikation der Mehrjahres-Trendlinie (PR-β),
      // damit Antragstexte den Kostenblock ehrlich einordnen können.
      const tq = trendQualifierText(economicImpact.trendQualifier);
      if (tq) lines.push(`  Mehrjahres-Trend: ${tq}.`);
      if (economicImpact.source && (economicImpact.source.publisher || economicImpact.source.year)) {
        const srcParts = [economicImpact.source.publisher, economicImpact.source.year].filter(Boolean).join(", ");
        lines.push(`  Quelle: ${srcParts}.`);
      }
      if (economicImpact.disclaimer) {
        lines.push(`  Hinweis: ${economicImpact.disclaimer}`);
      }
      lines.push("");
    }

    // Orts- und musterbezogene Empfehlungen — VOR der allgemeinen
    // Maßnahmenliste, damit der Antrag mit den passenden Vorschlägen
    // beginnt (Spec-Item 5+8). Drei Buckets, jeweils 1–2 Sätze;
    // explizite Unsicherheitsformulierung (Spec-Item 6).
    if (includeMeasures && contextualMeasures) {
      lines.push("Orts- und musterbezogene Empfehlungen:");
      if (contextualMeasures.rationale) {
        lines.push(`  ${contextualMeasures.rationale}`);
      }
      const renderBlock = (heading, items) => {
        if (!Array.isArray(items) || items.length === 0) return;
        lines.push(`  ${heading}:`);
        for (const it of items) lines.push(`    – ${it}`);
      };
      renderBlock("Erforderliche Vor-Ort-Prüfung", contextualMeasures.pruefauftraege);
      renderBlock("Kurzfristig prüfbar", contextualMeasures.kurzfristig);
      renderBlock("Baulich/organisatorisch zu prüfen", contextualMeasures.mittelfristig);
      lines.push("");
    }

    // Add recommended measures (PR-D / B1+B3): respect ctx.exportOptions.includeMeasures (default ON).
    // Note: `recommendedMeasures` is null when the toggle was off (load gated above).
    if (includeMeasures && hasRecommendationsOrFiltered(recommendedMeasures)) {
      const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
      const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
      lines.push("Empfohlene Maßnahmen (automatischer Vorschlag, basierend auf detektierten Mustern):");
      // OSM-Datenstand-Hinweis: Wenn Achsen relevant sind, aber nicht
      // belastbar geprüft werden konnten, vor der Liste klar markieren.
      const cov = osmCoverageNote(recommendedMeasures.osmCoverage);
      if (cov) lines.push(`  Hinweis (OSM-Datenstand): ${cov}`);
      let i = 1;
      for (const item of recommendedMeasures.measures) {
        const m = item.measure;
        const cost = fmtCost(m.costRange);
        const red = fmtRed(m.effect && m.effect.expectedReductionPct);
        const ev = (m.effect && m.effect.evidenceLevel) ? ` Evidenz ${m.effect.evidenceLevel}` : "";
        lines.push(`  ${i}. ${m.label}`);
        if (m.description) lines.push(`     ${m.description}`);
        lines.push(`     Kosten: ${cost} pro ${m.perUnit || "Einheit"} · erwartete Reduktion: ${red} ·${ev} · Vorlauf: ${m.leadTime || "—"}`);
        // Goldstandard Items 5–6: Cross-Reference zurück in den
        // URSACHEN-Block. Macht für den Leser explizit, *warum* genau
        // diese Maßnahme vorgeschlagen wird — und verhindert, dass der
        // Eindruck einer beliebigen, unverbundenen Liste entsteht.
        if (Array.isArray(item.derivedFrom) && item.derivedFrom.length > 0) {
          lines.push(`     Abgeleitet aus auffälligem Muster: ${item.derivedFrom.map(d => d.label).join(" · ")}`);
        }
        if (item.amortisation && item.amortisation.years) {
          const [best, worst] = item.amortisation.years;
          lines.push(`     Geschätzte Amortisation: ca. ${best.toFixed(1)} – ${worst.toFixed(1)} Jahre (Best- bis Worst-Case).`);
        }
        if (Array.isArray(m.considerations) && m.considerations.length > 0) {
          for (const c of m.considerations) lines.push(`     – ${c}`);
        }
        i++;
      }
      // Wegen OSM-Voraussetzungen ausgeschlossene Vorschläge transparent listen.
      if (Array.isArray(recommendedMeasures.filteredOut) && recommendedMeasures.filteredOut.length > 0) {
        lines.push("  Wegen OSM-Voraussetzungen NICHT empfohlen:");
        for (const f of recommendedMeasures.filteredOut) {
          lines.push(`    – ${f.label}: ${f.reason}`);
        }
      }
      if (recommendedMeasures.disclaimer) {
        lines.push(`  Hinweis: ${recommendedMeasures.disclaimer}`);
      }
      // Issue 2 (a): Quellen vollständig — Titel, Publisher, Jahr und URL.
      // Vorher wurden Quellen nur in der HTML-Vorschau gerendert, sodass
      // TEXT-Reports (und damit AI-Konsum) die Belege nicht sahen.
      if (Array.isArray(recommendedMeasures.sources) && recommendedMeasures.sources.length > 0) {
        lines.push("  Quellen:");
        for (const s of recommendedMeasures.sources) {
          if (!s || !s.title) continue;
          const meta = [s.publisher, s.year].filter(Boolean).join(", ");
          const head = meta ? `${s.title} (${meta})` : s.title;
          lines.push(s.url ? `    – ${head} — ${s.url}` : `    – ${head}`);
        }
      }
      lines.push("");
    }

    // Goldstandard-Sektion 8: Priorisierung nach Umsetzungshorizont.
    // Bezirksvertretungen erwarten klare Zeit-Buckets („was ist in 3
    // Monaten machbar?"). Wir berechnen die Priorisierung hier einmal
    // (deterministisch aus `recommendedMeasures.measures[]`) und teilen
    // das Ergebnis sowohl mit dem HTML-Renderer (HTML-Section unten) als
    // auch mit `structured.prioritization`, das DOCX/PDF/AI konsumieren.
    // null, wenn der includeMeasures-Toggle aus oder die Liste leer ist.
    const _prioritization = (includeMeasures && recommendedMeasures
        && UA.measures && typeof UA.measures.buildPrioritization === "function")
      ? UA.measures.buildPrioritization(recommendedMeasures)
      : null;
    if (_prioritization && _prioritization.meta && _prioritization.meta.totals.all > 0) {
      lines.push("Priorisierung (Umsetzungshorizont):");
      const renderBucket = (heading, bucket) => {
        if (bucket.length === 0) {
          lines.push(`  ${heading}: — keine Maßnahmen in diesem Horizont —`);
          return;
        }
        lines.push(`  ${heading}:`);
        for (const it of bucket) {
          lines.push(`    – ${it.label} (Vorlauf: ${it.leadTime})`);
        }
      };
      renderBucket("Kurzfristig (0–3 Monate)", _prioritization.kurzfristig);
      renderBucket("Mittelfristig (3–12 Monate)", _prioritization.mittelfristig);
      renderBucket("Langfristig (>12 Monate)", _prioritization.langfristig);
      // "unbekannt" bewusst NICHT rendern, um den Eindruck einer vierten
      // Kategorie zu vermeiden – falls leadTime fehlt, ist die Maßnahme
      // bereits in der Hauptliste mit "Vorlauf: —" sichtbar.
      lines.push("");
    }

    // Add POI information to text report
    if (poiAnalysis && (poiAnalysis.totalWithin > 0 || poiAnalysis.totalNear > 0)) {
      lines.push("POI-Analyse (Schulen, Kindergärten, Kitas):");
      
      if (poiAnalysis.totalWithin > 0) {
        lines.push(`Im Ausschnitt: ${poiAnalysis.totalWithin} POI(s)`);
        for (const [type, count] of Object.entries(poiAnalysis.withinByType)) {
          const typeLabel = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          lines.push(`  - ${typeLabel}: ${count}`);
        }
      }
      
      if (poiAnalysis.totalNear > 0) {
        lines.push(`In der Nähe (< 200m): ${poiAnalysis.totalNear} POI(s)`);
        for (const [type, count] of Object.entries(poiAnalysis.nearByType)) {
          const typeLabel = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          lines.push(`  - ${typeLabel}: ${count}`);
        }
      }
      
      if (poiAnalysis.totalWithin > 0 || poiAnalysis.totalNear > 0) {
        lines.push("Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.");
      }
      
      lines.push("");
    }

    // Add reference documents to text report
    if (refDocs && refDocs.documents && refDocs.documents.length > 0) {
      lines.push("Bezugsdokumente:");
      for (const doc of refDocs.documents) {
        lines.push(`- ${doc.title || "Ohne Titel"}`);
        if (doc.author) lines.push(`  Autor: ${doc.author}`);
        if (doc.date) lines.push(`  Datum: ${doc.date}`);
        if (doc.url) lines.push(`  URL: ${doc.url}`);
        if (doc.description) lines.push(`  ${doc.description}`);
      }
      lines.push("");
    }

    // Add political references to text report.
    // Issue 2 (e): Quellen vollständig — neben Titel/Typ/Datum/Gremium/
    // Nummer/URL auch referenceType (feinere Klassifikation), reason
    // (Begründung der Relevanz), snippet (Textauszug) und source
    // (Provider-Kürzel, transparenter Quellenhinweis).
    if (ctx.politicalReferences && ctx.politicalReferences.length > 0) {
      lines.push("Bisherige politische Befassung:");
      for (const ref of ctx.politicalReferences) {
        lines.push(`- ${ref.title || "Ohne Titel"}`);
        if (ref.referenceType && ref.referenceType !== ref.type) {
          lines.push(`  Klassifikation: ${ref.referenceType}`);
        }
        if (ref.type) lines.push(`  Typ: ${ref.type}`);
        if (ref.date) lines.push(`  Datum: ${ref.date}`);
        if (ref.gremium) lines.push(`  Gremium: ${ref.gremium}`);
        if (ref.number) lines.push(`  Nummer: ${ref.number}`);
        if (ref.snippet) lines.push(`  Auszug: ${String(ref.snippet).slice(0, 240)}`);
        if (ref.reason) lines.push(`  Relevanz: ${ref.reason}`);
        if (ref.url) lines.push(`  URL: ${ref.url}`);
        if (ref.source) lines.push(`  Quelle (Portal): ${ref.source}`);
      }
      lines.push("");
    }

    // Add cross-table (Beteiligungskombination × Schweregrad)
    if (crossTable.rows.length > 0) {
      lines.push("Beteiligungskombination × Schweregrad:");
      lines.push("  Kombination | Getötete | Schwerverletzt | Leichtverletzt | Summe");
      for (const r of crossTable.rows) {
        lines.push(`  ${r.label} | ${r.sev1} | ${r.sev2} | ${r.sev3} | ${r.total}`);
      }
      lines.push(`  Gesamt | ${crossTable.totals.sev1} | ${crossTable.totals.sev2} | ${crossTable.totals.sev3} | ${crossTable.totals.total}`);
      lines.push("");
    }

    // Add accident details using the active view strategy
    if (accidentDetails.groups.length > 0) {
      const view = UA.resolveAccidentView ? UA.resolveAccidentView(accidentDetails.viewId) : null;
      const colHeader = (accidentDetails.columns && accidentDetails.columns.length)
        ? accidentDetails.columns.join(" | ")
        : "# | Jahr | Beteiligte | Uhrzeit | Wochentag | Fahrbahnzustand | Koordinaten";
      lines.push("Einzelunfälle im Bereich:");
      for (const g of accidentDetails.groups) {
        const headerText = g.headers && g.headers.text ? g.headers.text : "";
        if (headerText) lines.push("  " + headerText);
        lines.push("  " + colHeader);
        g.rows.forEach((r, i) => {
          if (view && view.renderRow && view.renderRow.text) {
            lines.push(view.renderRow.text(r, i));
          } else {
            const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
            lines.push(`  ${i + 1} | ${r.year ?? "—"} | ${r.involved} | ${hour} | ${(UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—"))} | ${r.roadCondition} | ${formatCoords(r.lat, r.lon)}`);
          }
        });
        if (g.overflow > 0) {
          const label = g.overflowLabel || `weitere ${g.sevLabel}`;
          lines.push(`  … und ${g.overflow} ${label}`);
        }
      }
      lines.push("");
    }

    // Dunkelziffer-Pflichthinweis (#C3) – immer, kein Toggle.
    lines.push(DARK_FIGURE_NOTE.title + ":");
    lines.push("  " + DARK_FIGURE_NOTE.body);
    lines.push("  " + DARK_FIGURE_NOTE.sourceLabel);
    if (DARK_FIGURE_NOTE.sources && DARK_FIGURE_NOTE.sources.length > 0) {
      for (const src of DARK_FIGURE_NOTE.sources) {
        lines.push("  - " + src.label + (src.url ? " (" + src.url + ")" : ""));
      }
    }
    lines.push("");

    // PR-E: Quellen-Hinweis für die in PR-A/B/C/D dargestellten
    // Kontextdaten — nur wenn der Datensatz solche Felder trägt.
    const enrichNote = pickEnrichmentSourcesNote(ctx);
    if (enrichNote) {
      lines.push(enrichNote.title + ":");
      lines.push("  " + enrichNote.body);
      for (const src of enrichNote.sources) {
        lines.push("  - " + src.label + (src.url ? " (" + src.url + ")" : ""));
      }
      lines.push("");
    }

    lines.push(tpl(tBesch, vars).trim());
    lines.push("");
    // Task 6: Interner Hinweis ("automatisiert erzeugt (Vorentwurf)") wird
    // nicht mehr ausgegeben – `tHinw` ist nun leer (templates/hinweis.txt /
    // outro_internal_note.txt sind absichtlich entleert). Nur falls ein
    // Stadt-Override doch noch Inhalt liefert, behalten wir die Zeile.
    const hinwBody = tpl(tHinw || "", vars).trim();
    if (hinwBody) {
      lines.push(hinwBody);
      lines.push("");
    }
    lines.push(tpl(tLiz, vars).trim());

    const textOut = lines.join("\n").replace(/\n{3,}/g, "\n\n");

    // ---- Compute active filter mask for cross-table highlighting ----
    // Build a bitmask from the currently checked involvement checkboxes
    const activeFilterMask = (function () {
      if (!ctx.ui) return 0;
      let m = 0;
      if (ctx.ui.incBikeEl && ctx.ui.incBikeEl.checked) m |= 1;
      if (ctx.ui.incPedEl  && ctx.ui.incPedEl.checked)  m |= 2;
      if (ctx.ui.incCarEl  && ctx.ui.incCarEl.checked)  m |= 4;
      if (ctx.ui.incMotoEl && ctx.ui.incMotoEl.checked) m |= 8;
      if (ctx.ui.incGkfzEl && ctx.ui.incGkfzEl.checked) m |= 16;
      if (ctx.ui.incSonEl  && ctx.ui.incSonEl.checked)  m |= 32;
      return m;
    })();

    /**
     * Check if a cross-table row mask matches the active filter.
     * - "solo" mode: highlight rows whose mask is a single bit that is part of activeFilterMask
     * - "and" mode: highlight rows whose mask contains all bits from activeFilterMask
     * - "or" mode: highlight rows whose mask overlaps with activeFilterMask
     */
    function isActiveFilterRow(rowMask) {
      if (activeFilterMask === 0) return false;
      const mode = ctx.involvementMode || "or";
      if (mode === "solo") {
        // Solo: exactly one bit set, and that bit is in the active mask
        const isSingleBit = rowMask > 0 && (rowMask & (rowMask - 1)) === 0;
        return isSingleBit && (rowMask & activeFilterMask) !== 0;
      }
      if (mode === "and") {
        // AND: the row must contain ALL active filter bits
        return (rowMask & activeFilterMask) === activeFilterMask;
      }
      // OR: any overlap
      return (rowMask & activeFilterMask) !== 0;
    }

    // ---- HTML (Modal) ----
    const focusRows = dev.focus.length ? dev.focus : dev.rows.slice(0, 5);

    const fmtCI = (r) => `[${fmtPct(r.ciLow)} – ${fmtPct(r.ciHigh)}]`;
    const mkDevRow = (r) => {
      const sigStyle = r.isSignificant ? "" : " color:#999;";
      const sigTooltip = r.isSignificant ? "" : ` title="Nicht signifikant – kleine Datenmenge (95%-KI schließt Stadtwert ein)"`;
      const nsBadge = r.isSignificant ? "" : ` <span style="font-size:10px; color:#bbb;">n.s.</span>`;
      const factorCell = `${_fmtFactorDe(r.factor)}× <span style="font-weight:normal; font-size:11px; color:#777;">${fmtCI(r)}</span>${nsBadge}`;
      return `
      <tr>
        <td><span class="pill">${UA.escHtml(r.label)}</span></td>
        <td style="text-align:right;">${r.locCnt.toLocaleString()}</td>
        <td style="text-align:right;">${fmtPct(r.locR)}</td>
        <td style="text-align:right;">${fmtPct(r.baseR)}</td>
        <td style="text-align:right; font-weight:900;${sigStyle}"${sigTooltip}>${factorCell}</td>
      </tr>`;
    };

    const mkYearRow = (row) => `
      <tr>
        <td style="width:80px;"><strong>${row.year}</strong></td>
        <td style="text-align:right; width:110px;">${row.total.toLocaleString()}</td>
        <td>${row.classes.length ? UA.escHtml(row.classes.join(", ")) : "<span style=\"color:#777;\">—</span>"}</td>
      </tr>`;

    // Build POI section for HTML report
    let poiHtmlSection = "";
    if (poiAnalysis && (poiAnalysis.totalWithin > 0 || poiAnalysis.totalNear > 0)) {
      poiHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">POI-Analyse (Schulen, Kindergärten, Kitas)</div>
        <div style="margin-top:6px; color:#444;">`;
      
      if (poiAnalysis.totalWithin > 0) {
        poiHtmlSection += `<div><strong>Im Ausschnitt:</strong> ${poiAnalysis.totalWithin} POI(s)`;
        const typeLabels = [];
        for (const [type, count] of Object.entries(poiAnalysis.withinByType)) {
          const label = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          typeLabels.push(`${label}: ${count}`);
        }
        if (typeLabels.length > 0) {
          poiHtmlSection += ` (${UA.escHtml(typeLabels.join(", "))})`;
        }
        poiHtmlSection += `</div>`;
      }
      
      if (poiAnalysis.totalNear > 0) {
        poiHtmlSection += `<div><strong>In der Nähe (&lt; 200m):</strong> ${poiAnalysis.totalNear} POI(s)`;
        const typeLabels = [];
        for (const [type, count] of Object.entries(poiAnalysis.nearByType)) {
          const label = type === "school" ? "Schulen" : type === "kindergarten" ? "Kindergärten" : type === "childcare" ? "Kitas" : type;
          typeLabels.push(`${label}: ${count}`);
        }
        if (typeLabels.length > 0) {
          poiHtmlSection += ` (${UA.escHtml(typeLabels.join(", "))})`;
        }
        poiHtmlSection += `</div>`;
      }
      
      poiHtmlSection += `<div style="margin-top:6px; font-style:italic; color:#666; font-size:13px;">
        Hinweis: Das Vorhandensein von Schulen, Kindergärten oder Kitas im oder nahe dem Unfallbereich erfordert besondere Aufmerksamkeit hinsichtlich der Verkehrssicherheit für Kinder und Jugendliche.
      </div>`;
      poiHtmlSection += `</div>`;
    }

    // Build reference documents section for HTML report
    let refDocsHtmlSection = "";
    if (refDocs && refDocs.documents && refDocs.documents.length > 0) {
      refDocsHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Bezugsdokumente</div>
        <ul style="margin-top:6px;">`;
      for (const doc of refDocs.documents) {
        refDocsHtmlSection += `<li>`;
        if (doc.url) {
          refDocsHtmlSection += `<a href="${UA.escHtml(doc.url)}" target="_blank" rel="noopener">${UA.escHtml(doc.title || "Ohne Titel")}</a>`;
        } else {
          refDocsHtmlSection += `<strong>${UA.escHtml(doc.title || "Ohne Titel")}</strong>`;
        }
        if (doc.author || doc.date) {
          const meta = [];
          if (doc.author) meta.push(UA.escHtml(doc.author));
          if (doc.date) meta.push(UA.escHtml(doc.date));
          refDocsHtmlSection += ` <span style="color:#666; font-size:12px;">(${meta.join(", ")})</span>`;
        }
        if (doc.description) {
          refDocsHtmlSection += `<br><span style="color:#555; font-size:13px;">${UA.escHtml(doc.description)}</span>`;
        }
        refDocsHtmlSection += `</li>`;
      }
      refDocsHtmlSection += `</ul>`;
    }

    // Build economic-impact HTML section (PR-C / B2)
    let economicImpactHtmlSection = "";
    if (includeCosts && economicImpact && economicImpact.total > 0) {
      const fmt = (UA.costs && UA.costs.formatEUR) ? UA.costs.formatEUR : (n) => `${n} €`;
      const srcParts = (economicImpact.source && (economicImpact.source.publisher || economicImpact.source.year))
        ? [economicImpact.source.publisher, economicImpact.source.year].filter(Boolean).join(", ")
        : "";
      const srcUrl = (economicImpact.source && economicImpact.source.url) ? economicImpact.source.url : "";
      economicImpactHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Volkswirtschaftliche Bedeutung (Schätzung)</div>
        <table class="report" style="margin-top:6px;">
          <thead>
            <tr><th>Kategorie</th><th style="text-align:right;">Anzahl</th><th style="text-align:right;">Geschätzte Kosten</th></tr>
          </thead>
          <tbody>
            <tr><td>Getötete</td><td style="text-align:right;">${economicImpact.counts.fatal}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.breakdown.fatal))}</td></tr>
            <tr><td>Schwerverletzte</td><td style="text-align:right;">${economicImpact.counts.severe}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.breakdown.severe))}</td></tr>
            <tr><td>Leichtverletzte</td><td style="text-align:right;">${economicImpact.counts.light}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.breakdown.light))}</td></tr>
            <tr style="font-weight:700; border-top:2px solid #aaa;"><td>Gesamt im Datenzeitraum (${economicImpact.years} Jahr${economicImpact.years === 1 ? "" : "e"})</td><td style="text-align:right;">${economicImpact.counts.fatal + economicImpact.counts.severe + economicImpact.counts.light}</td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.total))}</td></tr>
            <tr style="font-weight:700;"><td>Pro Jahr</td><td></td><td style="text-align:right;">${UA.escHtml(fmt(economicImpact.annual))}</td></tr>
          </tbody>
        </table>
        <div style="margin-top:6px; color:#555; font-size:12px;">
          ${(() => { const tq = trendQualifierText(economicImpact.trendQualifier); return tq ? `<div><strong>Mehrjahres-Trend:</strong> ${UA.escHtml(tq)}.</div>` : ""; })()}
          ${srcParts ? `<div><strong>Quelle:</strong> ${UA.escHtml(srcParts)}${srcUrl ? ` (<a href="${UA.escHtml(srcUrl)}" target="_blank" rel="noopener">Link</a>)` : ""}</div>` : ""}
          ${economicImpact.disclaimer ? `<div style="font-style:italic; margin-top:4px;">${UA.escHtml(economicImpact.disclaimer)}</div>` : ""}
        </div>`;
    }

    // Orts- und musterbezogene Empfehlungen (UA.contextMeasures, Spec
    // Items 4–8). Wird VOR `measuresHtmlSection` ausgegeben, damit die
    // HTML-Vorschau dem TEXT-/DOCX-/PDF-Aufbau folgt: erst kontext-
    // spezifische Prüfaufträge mit Disclaimer, dann katalog-basierte
    // Maßnahmenliste. Bleibt leer, wenn keine Regel matched (Spec-Item 10).
    let contextualMeasuresHtmlSection = "";
    if (includeMeasures && contextualMeasures
        && Array.isArray(contextualMeasures.matchedRules)
        && contextualMeasures.matchedRules.length > 0) {
      const renderBucketHtmlCtx = (heading, items) => {
        if (!Array.isArray(items) || items.length === 0) return "";
        const lis = items.map(it => `<li>${UA.escHtml(it)}</li>`).join("");
        return `<div style="margin-top:6px;"><strong>${UA.escHtml(heading)}:</strong></div><ul style="margin:2px 0 0 18px;">${lis}</ul>`;
      };
      const rationaleHtml = contextualMeasures.rationale
        ? `<div style="margin-top:4px; font-style:italic; color:#444;">${UA.escHtml(contextualMeasures.rationale)}</div>`
        : "";
      contextualMeasuresHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Orts- und musterbezogene Empfehlungen</div>
        ${rationaleHtml}
        ${renderBucketHtmlCtx("Erforderliche Vor-Ort-Prüfung",     contextualMeasures.pruefauftraege)}
        ${renderBucketHtmlCtx("Kurzfristig prüfbar",               contextualMeasures.kurzfristig)}
        ${renderBucketHtmlCtx("Baulich/organisatorisch zu prüfen", contextualMeasures.mittelfristig)}`;
    }

    // Build recommended-measures HTML section (PR-D / B1+B3)
    let measuresHtmlSection = "";
    if (includeMeasures && hasRecommendationsOrFiltered(recommendedMeasures)) {
      const fmtCost = (UA.measures && UA.measures.formatCostRange) ? UA.measures.formatCostRange : (() => "—");
      const fmtRed = (UA.measures && UA.measures.formatReductionRange) ? UA.measures.formatReductionRange : (() => "—");
      const itemsHtml = recommendedMeasures.measures.map((item) => {
        const m = item.measure;
        const cost = fmtCost(m.costRange);
        const red = fmtRed(m.effect && m.effect.expectedReductionPct);
        const ev = (m.effect && m.effect.evidenceLevel) ? `Evidenz ${m.effect.evidenceLevel}` : "";
        const amort = (item.amortisation && item.amortisation.years)
          ? `<div style="color:#0a5; font-size:12px; margin-top:2px;"><strong>Amortisation:</strong> ca. ${item.amortisation.years[0].toFixed(1)} – ${item.amortisation.years[1].toFixed(1)} Jahre</div>`
          : "";
        const considerationsHtml = (Array.isArray(m.considerations) && m.considerations.length > 0)
          ? `<ul style="margin:4px 0 0 18px; padding:0; color:#555; font-size:12px;">${m.considerations.map(c => `<li>${UA.escHtml(c)}</li>`).join("")}</ul>`
          : "";
        // Goldstandard Items 5–6: explizite Cross-Reference auf den
        // URSACHEN-Block. Das macht die Maßnahme nachvollziehbar und
        // verhindert die Wahrnehmung „beliebige Liste".
        const derivedHtml = (Array.isArray(item.derivedFrom) && item.derivedFrom.length > 0)
          ? `<div style="color:#555; font-size:12px; margin-top:2px;"><strong>Abgeleitet aus:</strong> ${item.derivedFrom.map(d => UA.escHtml(d.label)).join(" · ")}</div>`
          : "";
        return `
          <li style="margin-bottom:10px;">
            <div style="font-weight:700;">${UA.escHtml(m.label)}</div>
            ${m.description ? `<div style="color:#444; font-size:13px; margin-top:2px;">${UA.escHtml(m.description)}</div>` : ""}
            <div style="color:#666; font-size:12px; margin-top:2px;">
              <strong>Kosten:</strong> ${UA.escHtml(cost)} pro ${UA.escHtml(m.perUnit || "Einheit")} ·
              <strong>Reduktion:</strong> ${UA.escHtml(red)} ·
              ${ev ? UA.escHtml(ev) + " · " : ""}<strong>Vorlauf:</strong> ${UA.escHtml(m.leadTime || "—")}
            </div>
            ${derivedHtml}
            ${amort}
            ${considerationsHtml}
          </li>`;
      }).join("");
      const sourcesHtml = (recommendedMeasures.sources && recommendedMeasures.sources.length > 0)
        ? `<div style="color:#666; font-size:12px; margin-top:6px;"><strong>Quellen:</strong> ${recommendedMeasures.sources.map(s => {
            const title = s.title || "";
            if (!title) return "";
            const meta = [s.publisher, s.year].filter(Boolean).map(v => UA.escHtml(String(v))).join(", ");
            const label = meta ? `${UA.escHtml(title)} (${meta})` : UA.escHtml(title);
            return s.url
              ? `<a href="${UA.escHtml(s.url)}" target="_blank" rel="noopener">${label}</a>`
              : label;
          }).filter(Boolean).join(" · ")}</div>`
        : "";
      // OSM-Datenstand-Hinweis vor der Liste, damit die Unsicherheit
      // sofort sichtbar ist und nicht erst unten als Fußnote.
      const cov = osmCoverageNote(recommendedMeasures.osmCoverage);
      const coverageHtml = cov
        ? `<div style="margin-top:6px; padding:6px 10px; background:#fff7e0; border:1px solid #f0c060; border-radius:4px; font-size:12px;"><strong>OSM-Datenstand:</strong> ${UA.escHtml(cov)}</div>`
        : "";
      // Wegen OSM-Voraussetzungen nicht empfohlene Vorschläge transparent listen.
      const filteredHtml = (Array.isArray(recommendedMeasures.filteredOut) && recommendedMeasures.filteredOut.length > 0)
        ? `<details style="margin-top:8px; color:#555; font-size:12px;">
            <summary style="cursor:pointer;"><strong>Wegen OSM-Voraussetzungen NICHT empfohlen</strong> (${recommendedMeasures.filteredOut.length})</summary>
            <ul style="margin:4px 0 0 18px; padding:0;">
              ${recommendedMeasures.filteredOut.map(f => `<li><strong>${UA.escHtml(f.label)}:</strong> ${UA.escHtml(f.reason || "Voraussetzungen nicht erfüllt")}</li>`).join("")}
            </ul>
          </details>`
        : "";
      const listHtml = (recommendedMeasures.measures.length > 0)
        ? `<ol style="margin-top:6px;">${itemsHtml}</ol>`
        : `<div style="margin-top:6px; color:#666; font-style:italic;">Keine Maßnahmen empfohlen (alle Vorschläge wurden gefiltert oder kein Muster ausreichend signifikant).</div>`;
      measuresHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Empfohlene Maßnahmen (automatischer Vorschlag)</div>
        ${coverageHtml}
        ${listHtml}
        ${filteredHtml}
        ${sourcesHtml}
        ${recommendedMeasures.disclaimer ? `<div style="color:#555; font-size:12px; font-style:italic; margin-top:4px;">${UA.escHtml(recommendedMeasures.disclaimer)}</div>` : ""}`;
    }

    // Goldstandard-Sektion 8: Priorisierung (HTML). Spiegelt die TEXT-
    // Sektion oben 1:1, aber als kompakte Liste pro Bucket. Ein leerer
    // Bucket wird explizit ausgewiesen, damit die Wahrnehmung nicht zu
    // „nur Langfristig möglich" verschoben wird.
    let prioritizationHtmlSection = "";
    if (_prioritization && _prioritization.meta && _prioritization.meta.totals.all > 0) {
      const renderBucketHtml = (heading, bucket) => {
        if (bucket.length === 0) {
          return `<div style="margin-top:6px;"><strong>${UA.escHtml(heading)}:</strong> <em style="color:#777;">— keine Maßnahmen in diesem Horizont —</em></div>`;
        }
        const items = bucket.map(it =>
          `<li>${UA.escHtml(it.label)} <span style="color:#666; font-size:12px;">(Vorlauf: ${UA.escHtml(it.leadTime)})</span></li>`
        ).join("");
        return `<div style="margin-top:6px;"><strong>${UA.escHtml(heading)}:</strong></div><ul style="margin:2px 0 0 0;">${items}</ul>`;
      };
      prioritizationHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Priorisierung (Umsetzungshorizont)</div>
        ${renderBucketHtml("Kurzfristig (0–3 Monate)", _prioritization.kurzfristig)}
        ${renderBucketHtml("Mittelfristig (3–12 Monate)", _prioritization.mittelfristig)}
        ${renderBucketHtml("Langfristig (>12 Monate)", _prioritization.langfristig)}`;
    }

    // Build accident-detail HTML section using the active view strategy.
    // Each group has pre-rendered headers (text/html/docx) and we wrap each row
    // with the strategy's renderRow.html callback.
    let accidentHtmlSection = "";
    if (accidentDetails.groups.length > 0) {
      const view = UA.resolveAccidentView ? UA.resolveAccidentView(accidentDetails.viewId) : null;
      const cols = (accidentDetails.columns && accidentDetails.columns.length)
        ? accidentDetails.columns
        : ["#", "Jahr", "Beteiligte", "Uhrzeit", "Wochentag", "Fahrbahnzustand", "Koordinaten"];
      const colsHtml = cols.map((c) => {
        const ta = (c === "Jahr" || c === "Uhrzeit") ? ' style="text-align:right;"' : "";
        return `<th${ta}>${UA.escHtml(c)}</th>`;
      }).join("");
      const groupsHtml = accidentDetails.groups.map(g => {
        const headerHtml = (g.headers && g.headers.html) ? g.headers.html : "";
        const rowsHtml = g.rows.map((r, i) => {
          if (view && view.renderRow && view.renderRow.html) return view.renderRow.html(r, i);
          // Defensive fallback
          const hour = r.hour != null ? String(r.hour).padStart(2, "0") + ":00" : "—";
          return `<tr><td>${i + 1}</td><td style="text-align:right;">${r.year ?? "—"}</td><td>${UA.escHtml(r.involved)}</td><td style="text-align:right;">${hour}</td><td>${UA.escHtml(UA.fmtWeekday ? UA.fmtWeekday(r) : (r.weekday || "—"))}</td><td>${UA.escHtml(r.roadCondition)}</td><td style="font-size:11px; color:#555;">${UA.escHtml(formatCoords(r.lat, r.lon))}</td></tr>`;
        }).join("");
        const overflowLabel = g.overflowLabel || `weitere ${g.sevLabel || ""}`;
        const overflowHtml = g.overflow > 0
          ? `<div style="color:#777; font-size:12px; margin-top:4px;">… und ${g.overflow} ${UA.escHtml(overflowLabel)}</div>`
          : "";
        return `${headerHtml}
        <table class="report" style="margin-top:4px;">
          <thead>
            <tr>${colsHtml}</tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${overflowHtml}`;
      }).join("");
      accidentHtmlSection = `
        <div style="margin-top:12px; font-weight:900;">Einzelunfälle im Bereich</div>
        ${groupsHtml}`;
    }

    // Pre-compute map-reference + executive summary HTML helpers (Task 7).
    const _mapRef0 = areaName
      ? `Die in Anlage 1 dokumentierte Karte zeigt die räumliche Verteilung der Vorfälle im Bereich ${areaName}.`
      : "Die in Anlage 1 dokumentierte Karte zeigt die räumliche Verteilung der Vorfälle im markierten Bereich.";
    // Task 6 – koordinaten-basierte Sätze zwischen Generalsatz und Lage-Detail.
    const _spatialSentences = deriveSpatialArgumentation(filteredPts);
    const _mapRef1 = (loc && (loc.details || loc.label))
      ? `Schwerpunkt der Häufung: ${loc.details || loc.label}.`
      : "";

    // Task 4 – HTML-Sektion "Ursachen und Maßnahmen".
    const _causesHtml = (() => {
      const cm = buildCausesMeasuresSection(dev.focus, recommendedMeasures);
      if (cm.length === 0) return "";
      const rowsHtml = cm.map(c => {
        // Cross-Reference per Maßnahmen-Nummer, falls verfügbar (siehe TEXT-Block).
        const right = (c.measureRefs && c.measureRefs.length > 0)
          ? c.measureRefs.map(e => `<strong>#${e.idx}</strong> ${UA.escHtml(e.label)}`).join("; ")
          : c.measures.map(m => UA.escHtml(m)).join("; ");
        return `<tr><td>${UA.escHtml(c.cause)}</td><td>${right}</td></tr>`;
      }).join("");
      return `
        <div style="margin-top:12px; font-weight:900;">Ursachen und Maßnahmen</div>
        <table class="report" style="margin-top:6px;">
          <thead><tr><th>Auffälliges Muster</th><th>Empfohlene Maßnahmen (siehe Liste unten)</th></tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>`;
    })();

    // Task 8 – HTML-Sektion "OSM-Schlussfolgerungen".
    const _osmInsightsHtml = (() => {
      const ins = deriveOsmInsights(osmContext);
      if (ins.length === 0) return "";
      return `<div style="margin-top:6px;"><strong>OSM-Schlussfolgerungen:</strong><ul style="margin:4px 0 0 18px;">${ins.map(s => `<li>${UA.escHtml(s)}</li>`).join("")}</ul></div>`;
    })();

    const htmlOut = `
      <div style="font:14px/1.35 system-ui;">
        <div style="font-weight:950; font-size:16px;">Report – Auffälligkeiten im markierten Bereich</div>
        <div style="color:#444; margin-top:4px;">
          <div><strong>Stadt:</strong> ${UA.escHtml(CITY_RAW)} | <strong>Bounds:</strong> <code>${UA.escHtml(bStr)}</code></div>
          <div><strong>Auswertung:</strong> lokal ${dev.local.total.toLocaleString()} Unfälle | Baseline ${dev.baseline.total.toLocaleString()} Unfälle</div>
          <div><strong>Datenzeitraum:</strong> ${range ? (range.minY + "–" + range.maxY) : "—"}</div>
          
          ${loc ? `
  <div><strong>Lage (Mittelpunkt):</strong> ${UA.escHtml(loc.details || loc.label)}
    &nbsp; <a href="${UA.escHtml(loc.osmUrl)}" target="_blank" rel="noopener">OSM</a>
  </div>
` : ``}
          
        </div>

        <div style="margin-top:12px; padding:10px 12px; background:#f6f7fb; border-left:4px solid #2a4a8a; border-radius:4px;">
          <div style="font-weight:950; font-size:14px;">KURZBEWERTUNG</div>
          <div style="margin-top:4px;">${UA.escHtml(_executiveSummary.classification)}</div>
          ${_executiveSummary.bullets.length > 0 ? `<ul style="margin:6px 0 0 18px;">${_executiveSummary.bullets.map(b => `<li>${UA.escHtml(b)}</li>`).join("")}</ul>` : ""}
          <div style="margin-top:6px; font-style:italic;">${UA.escHtml(_executiveSummary.urgency)}</div>
          <div style="margin-top:6px; color:#444;">${UA.escHtml(_mapRef0)}${_spatialSentences.length ? " " + _spatialSentences.map(s => UA.escHtml(s)).join(" ") : ""}${_mapRef1 ? " " + UA.escHtml(_mapRef1) : ""}</div>
        </div>

        <div style="margin-top:12px; font-weight:900;">Top-Abweichungen</div>
        <table class="report">
          <thead>
            <tr><th>Muster</th><th style="text-align:right;">lokal</th><th style="text-align:right;">lokal %</th><th style="text-align:right;">Stadt %</th><th style="text-align:right;">Faktor [95%-KI]</th></tr>
          </thead>
          <tbody>
            ${(() => {
              const visibleRows = focusRows.filter(r => r.locCnt > 0);
              const rowsHtml = visibleRows.map(mkDevRow).join("");
              const allNonSig = visibleRows.length > 0 && visibleRows.every(r => !r.isSignificant);
              const nonSigBanner = allNonSig
                ? `<tr><td colspan="5" style="color:#888; font-size:12px; font-style:italic;">Hinweis: Alle aufgeführten Abweichungen sind statistisch nicht signifikant (95%-KI schließt Stadtwert ein). Faktor-Werte bei kleinen Fallzahlen mit Vorsicht interpretieren.</td></tr>`
                : "";
              return rowsHtml ? (rowsHtml + nonSigBanner) : "<tr><td colspan=\"5\" style=\"color:#777;\">—</td></tr>";
            })()}
          </tbody>
        </table>

        ${_causesHtml}

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

        ${crossTable.rows.length > 0 ? `
        <div style="margin-top:12px; font-weight:900;">Beteiligungskombination × Schweregrad</div>
        <table class="report" style="margin-top:6px;">
          <thead>
            <tr><th>Kombination</th><th style="text-align:right;">Getötete</th><th style="text-align:right;">Schwerverletzt</th><th style="text-align:right;">Leichtverletzt</th><th style="text-align:right;">Summe</th></tr>
          </thead>
          <tbody>
            ${crossTable.rows.map(r => `<tr${isActiveFilterRow(r.mask) ? ' style="background-color:#FFFFCC; font-weight:600;"' : ''}><td>${UA.escHtml(r.label)}</td><td style="text-align:right;">${r.sev1}</td><td style="text-align:right;">${r.sev2}</td><td style="text-align:right;">${r.sev3}</td><td style="text-align:right; font-weight:700;">${r.total}</td></tr>`).join("")}
            <tr style="font-weight:700; border-top:2px solid #aaa;"><td>Gesamt</td><td style="text-align:right;">${crossTable.totals.sev1}</td><td style="text-align:right;">${crossTable.totals.sev2}</td><td style="text-align:right;">${crossTable.totals.sev3}</td><td style="text-align:right;">${crossTable.totals.total}</td></tr>
          </tbody>
        </table>
        ` : ""}

        ${economicImpactHtmlSection}

        ${contextualMeasuresHtmlSection}

        ${measuresHtmlSection}

        ${prioritizationHtmlSection}

        ${accidentHtmlSection}

        ${poiHtmlSection}
        
        ${refDocsHtmlSection}

        ${(() => {
          const polRefs = ctx.politicalReferences;
          if (!polRefs || !polRefs.length) return '';
          let html = `<div style="margin-top:12px; font-weight:900;">Bisherige politische Befassung</div><ul style="margin-top:6px;">`;
          for (const ref of polRefs) {
            const meta = [];
            if (ref.type) meta.push(UA.escHtml(ref.type));
            if (ref.date) meta.push(UA.escHtml(ref.date));
            if (ref.gremium) meta.push(UA.escHtml(ref.gremium));
            if (ref.number) meta.push(UA.escHtml(ref.number));
            html += `<li>`;
            if (ref.url) {
              html += `<a href="${UA.escHtml(ref.url)}" target="_blank" rel="noopener">${UA.escHtml(ref.title || 'Ohne Titel')}</a>`;
            } else {
              html += `<strong>${UA.escHtml(ref.title || 'Ohne Titel')}</strong>`;
            }
            if (meta.length) html += ` <span style="color:#666;font-size:12px;">(${meta.join(' · ')})</span>`;
            // Issue 2 (e): zusätzliche Felder konsistent ausgeben.
            if (ref.referenceType && ref.referenceType !== ref.type) {
              html += `<div style="font-size:11px;color:#777;margin-top:2px;"><em>Klassifikation:</em> ${UA.escHtml(ref.referenceType)}</div>`;
            }
            if (ref.snippet) {
              html += `<div style="font-size:11px;color:#555;margin-top:2px;line-height:1.4;">${UA.escHtml(String(ref.snippet).slice(0, 240))}</div>`;
            }
            if (ref.reason) {
              html += `<div style="font-size:11px;color:#666;margin-top:2px;"><em>Relevanz:</em> ${UA.escHtml(ref.reason)}</div>`;
            }
            if (ref.source) {
              html += `<div style="font-size:11px;color:#888;margin-top:2px;"><em>Portal:</em> ${UA.escHtml(ref.source)}</div>`;
            }
            html += `</li>`;
          }
          html += `</ul>`;
          return html;
        })()}

        <div style="margin-top:12px; padding:8px 10px; border:1px solid #f0c36d; background:#fff8e1; border-radius:6px; font-size:12px; color:#5a4400;">
          <div style="font-weight:700; margin-bottom:2px;">${UA.escHtml(DARK_FIGURE_NOTE.title)}</div>
          <div>${UA.escHtml(DARK_FIGURE_NOTE.body)}</div>
          <div style="margin-top:4px; font-style:italic;">${UA.escHtml(DARK_FIGURE_NOTE.sourceLabel)}</div>${(DARK_FIGURE_NOTE.sources && DARK_FIGURE_NOTE.sources.length > 0) ? `<ul style="margin:4px 0 0 0; padding-left:16px;">${DARK_FIGURE_NOTE.sources.map(s => `<li><a href="${UA.escHtml(s.url)}" target="_blank" rel="noopener">${UA.escHtml(s.label)}</a></li>`).join("")}</ul>` : (DARK_FIGURE_NOTE.sourceUrl ? `<a href="${UA.escHtml(DARK_FIGURE_NOTE.sourceUrl)}" target="_blank" rel="noopener">Link</a>` : "")}
        </div>

        ${(() => { const _en = pickEnrichmentSourcesNote(ctx); return _en ? `
        <div style="margin-top:8px; padding:8px 10px; border:1px solid #cfe3f7; background:#f4f9ff; border-radius:6px; font-size:12px; color:#26425e;">
          <div style="font-weight:700; margin-bottom:2px;">${UA.escHtml(_en.title)}</div>
          <div>${UA.escHtml(_en.body)}</div>
          <ul style="margin:4px 0 0 0; padding-left:16px;">${_en.sources.map(s => `<li><a href="${UA.escHtml(s.url)}" target="_blank" rel="noopener">${UA.escHtml(s.label)}</a></li>`).join("")}</ul>
        </div>
        ` : ``; })()}

        ${(yearlyTrend && yearlyTrend.years && yearlyTrend.years.length > 0) ? `
        <div style="margin-top:12px; font-weight:900;">Mehrjahres-Trend</div>
        <div style="margin:6px 0;">${(UA.trend && UA.trend.renderTrendSVG) ? UA.trend.renderTrendSVG(yearlyTrend) : ""}</div>
        <table class="report" style="font-size:12px;">
          <thead><tr><th>Jahr</th><th style="text-align:right;">Getötete</th><th style="text-align:right;">Schwerverletzte</th><th style="text-align:right;">Leichtverletzte</th><th style="text-align:right;">Summe</th></tr></thead>
          <tbody>
            ${yearlyTrend.years.map((y, i) => `<tr><td>${y}</td><td style="text-align:right;">${yearlyTrend.counts.fatal[i]}</td><td style="text-align:right;">${yearlyTrend.counts.severe[i]}</td><td style="text-align:right;">${yearlyTrend.counts.light[i]}</td><td style="text-align:right;">${yearlyTrend.counts.total[i]}</td></tr>`).join("")}
          </tbody>
        </table>
        <div style="font-size:12px; color:#555;">
          Klassifikation: <strong>${UA.escHtml(yearlyTrend.classification)}</strong>
          (Slope ${Number.isFinite(yearlyTrend.slope) ? yearlyTrend.slope.toFixed(2) : "—"}/Jahr,
          R² ${Number.isFinite(yearlyTrend.r2) ? yearlyTrend.r2.toFixed(2) : "—"},
          n=${yearlyTrend.nYears})
        </div>
        ` : ``}

        ${(heatmap && heatmap.total > 0 && UA.heatmap && UA.heatmap.renderHeatmapSVG) ? `
        <div style="margin-top:12px; font-weight:900;">Stunden-Heatmap (Werktag vs. Wochenende)</div>
        <div style="display:flex; align-items:flex-start; gap:14px; flex-wrap:wrap; margin-top:6px;">
          <div>${UA.heatmap.renderHeatmapSVG(heatmap)}</div>
          <div style="font-size:12px; color:#555; max-width:260px;">
            <div>Gesamt: <strong>${heatmap.total}</strong> Unfälle (Mo–Fr: ${heatmap.colTotals[0]}, Sa/So: ${heatmap.colTotals[1]}).</div>
            <div>Dunkelste Zelle: max. ${heatmap.max} Unfälle pro Stunde × Tagestyp.</div>
            <div style="margin-top:4px;">Lesart: jede Zelle zeigt, wie viele Unfälle der gewählten Auswertung in einer bestimmten Stunde an Werktagen bzw. am Wochenende registriert wurden.</div>
          </div>
        </div>
        ` : ``}

        ${(osmContext && osmContext.summary) ? `
        <div style="margin-top:12px; font-weight:900;">Verkehrsräumlicher Kontext (OSM)</div>
        <table class="report" style="font-size:12px; margin-top:4px;">
          <tbody>
            ${osmContext.summary.dominantMaxspeed != null ? `<tr><td>Vorherrschendes Tempolimit</td><td><strong>${osmContext.summary.dominantMaxspeed} km/h</strong> (n=${osmContext.summary.speedSampleSize} Wegabschnitte)</td></tr>` : ``}
            <tr><td>Radverkehrsanlagen</td><td>${osmContext.summary.cycleInfraWays > 0
              ? `${osmContext.summary.cycleInfraWays} Wegabschnitte mit Radinfrastruktur` + (osmContext.summary.cycleInfraShare != null ? ` (${Math.round(osmContext.summary.cycleInfraShare * 100)} % der klassifizierten Hauptachsen)` : ``)
              : `keine separaten Radverkehrsanlagen erkannt`}</td></tr>
            <tr><td>Knoten/Querungen</td><td>${osmContext.summary.trafficSignals} signalisierte Knoten · ${osmContext.summary.crossings} markierte Querungen</td></tr>
            ${osmContext.summary.avgLanes != null ? `<tr><td>Durchschnittliche Fahrstreifen</td><td>Ø ${osmContext.summary.avgLanes.toFixed(1)} (n=${osmContext.summary.lanesSampleSize})</td></tr>` : ``}
            ${osmContext.summary.avgWidthMeters != null ? `<tr><td>Durchschnittliche Fahrbahnbreite</td><td>Ø ${osmContext.summary.avgWidthMeters.toFixed(1)} m (n=${osmContext.summary.widthSampleSize})</td></tr>` : ``}
          </tbody>
        </table>
        <div style="font-size:11px; color:#666; margin-top:4px;">Quelle: <a href="${UA.escHtml(osmContext.source.url)}" target="_blank" rel="noopener">${UA.escHtml(osmContext.source.publisher)}</a> (${UA.escHtml(osmContext.source.license)}), via ${UA.escHtml(osmContext.source.retrievedVia)}.</div>
        ${_osmInsightsHtml}
        ` : (osmContext && osmContext.quality && osmContext.quality.error) ? `
        <div style="margin-top:12px; font-weight:900;">Verkehrsräumlicher Kontext (OSM)</div>
        <div style="font-size:12px; color:#777;">OSM-Kontextdaten konnten beim Export nicht geladen werden.</div>
        ` : ``}

        <div style="margin-top:10px; color:#555; font-size:12px;">
          <div><strong>Methodik:</strong> Verglichen wird die Verteilung exakter Beteiligungskombinationen im Ausschnitt vs. stadtweit – jeweils unter denselben Nicht-Beteiligungsfiltern (Schwere/Zeit/Zustand/Wochentag).</div>
          <div><strong>Hinweis:</strong> Heuristisch – ersetzt keine Unfallkommission/Ortsbegehung.</div>
        </div>
      </div>
    `;

    // Build active filters description for structured meta
    const filters = {};
    if (ctx.ui) {
      if (ctx.ui.severityEl) filters.severity = ctx.ui.severityEl.value;
      if (ctx.ui.roadConditionEl) filters.roadCondition = ctx.ui.roadConditionEl.value;
      if (ctx.ui.incBikeEl) filters.includeCyclist    = ctx.ui.incBikeEl.checked;
      if (ctx.ui.incPedEl)  filters.includePedestrian = ctx.ui.incPedEl.checked;
      if (ctx.ui.incCarEl)  filters.includeCar        = ctx.ui.incCarEl.checked;
      if (ctx.ui.incMotoEl) filters.includeMotorcycle  = ctx.ui.incMotoEl.checked;
      if (ctx.ui.incGkfzEl) filters.includeGkfz       = ctx.ui.incGkfzEl.checked;
      if (ctx.ui.incSonEl)  filters.includeSonstig    = ctx.ui.incSonEl.checked;
      if (ctx.ui.hFromEl)   filters.hourFrom          = Number(ctx.ui.hFromEl.value);
      if (ctx.ui.hToEl)     filters.hourTo            = Number(ctx.ui.hToEl.value);
      if (ctx.ui.dayTypeEl) filters.dayType           = ctx.ui.dayTypeEl.value;
    }
    if (ctx.involvementMode) filters.involvementMode = ctx.involvementMode;

    // Task 10: structured.meta.mode reflects exportMode (computed earlier).

    // Scope-Erklärung (PR 2 / Spec-Items 4 + 6):
    // Drei Scopes machen explizit, worauf sich welche Zahl bezieht. Sie werden
    // in `structured.meta` gespiegelt, damit alle Renderer (TEXT/HTML/DOCX/PDF)
    // sowie nachgelagerte AI-Assessments dieselbe Definition referenzieren.
    //
    //   - activeFilterScope: Was zählt als „Unfall im Ausschnitt"? – die
    //     Kombination aus Bounding-Box + UI-Filtern + Beteiligungsmaske, die
    //     der Anwender im Werkbank-UI gesetzt hat.
    //   - patternAnalysisScope: Auf welcher Population basieren die in den
    //     Auffälligkeiten gemeldeten Muster? – identisch mit
    //     activeFilterScope, jedoch zusätzlich mask>0 (Beteiligungsfilter
    //     greifen) und ohne Cap.
    //   - baselineScope: Welche Vergleichsgruppe definiert „normal" für die
    //     Top-Abweichungen? – stadtweite Population mit denselben Nicht-
    //     Beteiligungsfiltern (Schwere/Zeit/Zustand/Wochentag).
    const activeFilterScope = {
      bounds: bStr,
      areaName: areaName || null,
      filters,
      involvementMode: ctx.involvementMode || "or",
      activeFilterMask
    };
    const patternAnalysisScope = {
      basis: "Punkte im Ausschnitt mit Beteiligungsmaske > 0",
      bounds: bStr,
      filters,
      involvementMode: ctx.involvementMode || "or"
    };
    const baselineScope = {
      basis: "Stadtweite Population mit identischen Nicht-Beteiligungsfiltern",
      city: CITY_RAW,
      filters: {
        // Nur die nicht-beteiligungsbezogenen Filter sind in der Baseline
        // wirksam – dieselben, die topDeviations() für den Stadtbezug nutzt.
        severity: filters.severity,
        roadCondition: filters.roadCondition,
        hourFrom: filters.hourFrom,
        hourTo: filters.hourTo,
        dayType: filters.dayType
      }
    };

    const structured = {
      meta: {
        city: CITY_RAW,
        date: vars.date,
        bounds: bStr,
        areaName,
        link: vars.link,
        filters,
        gremium: gremiumMatch,
        activeFilterMask,
        involvementMode: ctx.involvementMode || "or",
        mode: exportMode,
        activeFilterScope,
        patternAnalysisScope,
        baselineScope
      },
      // Kanonische Gesamtzahl der dokumentierten Unfälle (== severity.total).
      // Wird vom Pre-Flight-Konsistenz-Gate (UA.validateExportConsistency)
      // gegen die in den Karten gerenderten Punkte geprüft, damit die im
      // Dokument behauptete Fallzahl ("262 Unfälle") mit der Markerzahl auf
      // der Karte übereinstimmt. Mismatch → Export bricht ab.
      totalAccidents: (sev && Number.isFinite(sev.total)) ? sev.total : 0,
      severity: sev,
      deviations: dev,
      yearTable: yr,
      poi: poiAnalysis,
      references: refDocs,
      politicalReferences: ctx.politicalReferences || [],
      patterns: matchedPatterns,
      crossTable,
      accidentDetails,
      economicImpact,
      recommendedMeasures,
      timeClusters: timeClusters,
      yearlyTrend,
      heatmap,
      osmContext,
      darkFigureNote: DARK_FIGURE_NOTE,
      // PR-E: only set when the dataset actually carries context data —
      // renderers (TEXT/HTML/DOCX/PDF) treat null as "no Anhang section".
      enrichmentSourcesNote: pickEnrichmentSourcesNote(ctx)
    };

    // Task 2: KURZBEWERTUNG / Executive Summary aus den bereits berechneten
    // Strukturdaten ableiten – deterministisch, ohne neue Analyse.
    structured.executiveSummary = buildExecutiveSummary(structured, { mode: exportMode });
    // Task 4: URSACHEN UND MASSNAHMEN-Mapping aus dev.focus + Maßnahmenkatalog.
    structured.causesMeasures = buildCausesMeasuresSection(dev.focus, recommendedMeasures);
    // Goldstandard-Sektion 8: Priorisierung nach Umsetzungshorizont
    // (Kurzfristig 0–3 Monate / Mittelfristig 3–12 Monate / Langfristig
    // >12 Monate). Bereits oben für TEXT/HTML berechnet (`_prioritization`),
    // hier nur durchreichen, damit DOCX/PDF/AI denselben Inhalt sehen.
    structured.prioritization = _prioritization || null;
    // Orts- und musterbezogene Empfehlungen: bereits oben berechnet
    // (`contextualMeasures`), hier nur durchreichen, damit DOCX/PDF/AI
    // denselben Inhalt sehen wie die TEXT-Sektion.
    structured.contextualMeasures = contextualMeasures || null;
    // Task 8: Analytische OSM-Schlussfolgerungen (0–3 Sätze).
    structured.osmInsights = deriveOsmInsights(osmContext);
    structured.visualContextHints = visualContextHints;
    // Task 7: Map-Reference-Sätze (Anlage 1 zeigt Konzentration im Bereich …).
    {
      const mapRefs = [];
      if (areaName) {
        mapRefs.push(`Die in Anlage 1 dokumentierte Karte zeigt die räumliche Verteilung der Vorfälle im Bereich ${areaName}.`);
      } else {
        mapRefs.push("Die in Anlage 1 dokumentierte Karte zeigt die räumliche Verteilung der Vorfälle im markierten Bereich.");
      }
      // Task 6: koordinaten-basierte räumliche Argumentation (Knotenpunkt /
      // Korridor / verteilte Schwerpunkte) – wird konsistent in TEXT, HTML,
      // DOCX und PDF gerendert.
      for (const s of deriveSpatialArgumentation(filteredPts)) {
        mapRefs.push(s);
      }
      if (loc && (loc.details || loc.label)) {
        mapRefs.push(`Schwerpunkt der Häufung: ${loc.details || loc.label}.`);
      }
      structured.mapReferences = mapRefs;
    }

    // Methodik-Scope-Block (PR 2 / Spec-Item 6): drei Sätze, die die in
    // structured.meta.* hinterlegten Scopes in eine renderfertige, für
    // Verwaltungspublikum verständliche Sprache übersetzen. DOCX/PDF
    // rendern dieses Block 1:1 unterhalb der „Hinweis zur Zählweise"-Box;
    // TEXT/HTML können denselben Inhalt anhängen (deferred — keine
    // Renderer-Anpassung im selben Patch nötig, da Roh-Text-Renderer dies
    // bereits über das Methodik-HTML-Snippet abdeckt).
    structured.methodikScope = {
      title: "Methodik – Auswertungsbereich",
      lines: [
        `Auswertungsbereich: Auswertung umfasst Unfälle innerhalb des markierten Bereichs (${bStr})${
          areaName ? ` – „${areaName}"` : ""
        } unter den oben aufgeführten Filtern.`,
        "Analyse auffälliger Unfallmuster: Auffälligkeiten und Top-Abweichungen werden auf der gefilterten Population im Ausschnitt (Unfälle mit erfasster Beteiligung) berechnet.",
        `Vergleich mit dem Stadtgebiet: Die in den Top-Abweichungen genannten Faktoren beziehen sich auf die stadtweite Population in ${CITY_RAW} unter denselben Nicht-Beteiligungsfiltern (Schwere/Zeit/Zustand/Wochentag).`
      ]
    };

    // Attach a serialized TrafficSituation snapshot to the export metadata so
    // downstream renderers (Word/PDF/AI) can access the domain model without
    // coupling to raw ctx internals (architecture integration, Issue #312/#341).
    if (ctx.trafficSituation
        && typeof UA.TrafficSituation !== 'undefined'
        && typeof UA.TrafficSituation.serialize === 'function') {
      try {
        structured.meta.trafficSituation = UA.TrafficSituation.serialize(ctx.trafficSituation);
      } catch (_) { /* non-fatal — metadata is optional */ }
    }

    return { text: textOut, html: htmlOut, structured };
  };


  // --------------------
  // Private: get points in export bounds (applies non-involvement filters to match the current UI view)
  // --------------------
  function getPointsInBounds(ctx) {
    const bounds = boundsForExport(ctx);
    const points = [];
    for (const p of ctx.allPts || []) {
      if (!p?.props) continue;
      if (typeof UA.matchesNonInvolvementFilters === "function") {
        if (!UA.matchesNonInvolvementFilters(ctx, p.props)) continue;
      }
      if (!inBounds(p, bounds)) continue;
      points.push(p);
    }
    return points;
  }

  // --------------------
  // Private: normalize city name for use in filenames
  // --------------------
  function safeCity(cityRaw) {
    if (typeof UA.normKey === "function") return UA.normKey(cityRaw) || "export";
    // Fallback: strip everything that is not alphanumeric or underscore
    return String(cityRaw || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "export";
  }

  // --------------------
  // Private: trigger file download
  // --------------------
  function triggerDownload(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    if (typeof window.saveAs === "function") {
      window.saveAs(blob, filename);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
    }
  }

  // --------------------
  // Public API: UA.exportToCSV(ctx)
  // --------------------
  UA.exportToCSV = function exportToCSV(ctx) {
    const points = getPointsInBounds(ctx);
    const CITY = ctx.CITY_RAW || "";
    const date = new Date().toISOString().slice(0, 10);

    const headers = ["lat", "lon", "year", "ukategorie", "IstRad", "IstFuss", "IstPKW", "IstKrad", "IstGkfz", "IstSonstig", "ustunde", "uwochentag", "strzustand"];
    const rows = [headers.join(",")];

    for (const p of points) {
      const pr = p.props || {};
      const row = [
        p.lat,
        p.lon,
        pr.year ?? "",
        pr.ukategorie ?? "",
        pr.IstRad ?? pr.istrad ?? "",
        pr.IstFuss ?? pr.istfuss ?? "",
        pr.IstPKW ?? pr.istpkw ?? "",
        pr.IstKrad ?? pr.istkrad ?? "",
        pr.IstGkfz ?? pr.istgkfz ?? "",
        pr.IstSonstig ?? pr.istsonstig ?? "",
        pr.ustunde ?? "",
        pr.uwochentag ?? "",
        pr.strzustand ?? ""
      ].map(v => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n")
          ? `"${s.replace(/"/g, '""')}"` : s;
      });
      rows.push(row.join(","));
    }

    const filename = `Unfallatlas_${safeCity(CITY)}_${date}.csv`;
    triggerDownload(rows.join("\n"), filename, "text/csv;charset=utf-8");
  };

  // --------------------
  // Public API: UA.exportToGeoJSON(ctx)
  // --------------------
  UA.exportToGeoJSON = function exportToGeoJSON(ctx) {
    const points = getPointsInBounds(ctx);
    const CITY = ctx.CITY_RAW || "";
    const date = new Date().toISOString().slice(0, 10);

    const features = points.map(p => {
      const pr = p.props || {};
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
        properties: {
          year: pr.year ?? null,
          ukategorie: pr.ukategorie ?? null,
          IstRad: pr.IstRad ?? pr.istrad ?? null,
          IstFuss: pr.IstFuss ?? pr.istfuss ?? null,
          IstPKW: pr.IstPKW ?? pr.istpkw ?? null,
          IstKrad: pr.IstKrad ?? pr.istkrad ?? null,
          IstGkfz: pr.IstGkfz ?? pr.istgkfz ?? null,
          IstSonstig: pr.IstSonstig ?? pr.istsonstig ?? null,
          ustunde: pr.ustunde ?? null,
          uwochentag: pr.uwochentag ?? null,
          strzustand: pr.strzustand ?? null
        }
      };
    });

    const geojson = { type: "FeatureCollection", features };
    const filename = `Unfallatlas_${safeCity(CITY)}_${date}.geojson`;
    triggerDownload(JSON.stringify(geojson, null, 2), filename, "application/geo+json;charset=utf-8");
  };

  // --------------------
  // Public API: UA.exportToKML(ctx)
  // --------------------
  UA.exportToKML = function exportToKML(ctx) {
    const points = getPointsInBounds(ctx);
    const CITY = ctx.CITY_RAW || "";
    const date = new Date().toISOString().slice(0, 10);

    function escXml(v) {
      return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    const SEV_LABEL = { "1": "Getötet", "2": "Schwerverletzt", "3": "Leichtverletzt" };

    const placemarks = points.map(p => {
      const pr = p.props || {};
      const year = pr.year ?? "";
      const ukategorie = pr.ukategorie ?? "";
      const sevLabel = SEV_LABEL[String(ukategorie)] || String(ukategorie);

      const involved = [];
      if (String(pr.IstRad ?? pr.istrad) === "1") involved.push("Rad");
      if (String(pr.IstFuss ?? pr.istfuss) === "1") involved.push("Fuß");
      if (String(pr.IstPKW ?? pr.istpkw) === "1") involved.push("PKW");
      if (String(pr.IstKrad ?? pr.istkrad) === "1") involved.push("Krad");
      if (String(pr.IstGkfz ?? pr.istgkfz) === "1") involved.push("Gkfz");
      if (String(pr.IstSonstig ?? pr.istsonstig) === "1") involved.push("Sonst.");

      const name = `${year} ${sevLabel}${involved.length ? " (" + involved.join("+") + ")" : ""}`;

      return `    <Placemark>
      <name>${escXml(name)}</name>
      <ExtendedData>
        <Data name="year"><value>${escXml(year)}</value></Data>
        <Data name="ukategorie"><value>${escXml(ukategorie)}</value></Data>
        <Data name="ustunde"><value>${escXml(pr.ustunde ?? "")}</value></Data>
        <Data name="uwochentag"><value>${escXml(pr.uwochentag ?? "")}</value></Data>
        <Data name="strzustand"><value>${escXml(pr.strzustand ?? "")}</value></Data>
      </ExtendedData>
      <Point><coordinates>${p.lon},${p.lat},0</coordinates></Point>
    </Placemark>`;
    }).join("\n");

    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${escXml("Unfallatlas " + CITY + " " + date)}</name>
    <description>Exportierte Unfalldaten</description>
${placemarks}
  </Document>
</kml>`;

    const filename = `Unfallatlas_${safeCity(CITY)}_${date}.kml`;
    triggerDownload(kml, filename, "application/vnd.google-earth.kml+xml;charset=utf-8");
  };


  // sehr kleine Cache-Strategie, damit beim Klicken nicht dauernd neue Requests kommen
  const _rgCache = new Map();
  const DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS = 6000;

  UA.reverseGeocode = async function reverseGeocode(lat, lon){
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    if (_rgCache.has(key)) return _rgCache.get(key);

    // Fallback-Text (wenn alles schief geht)
    const fallback = {
      label: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      details: "",
      osmUrl: `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lon)}#map=18/${encodeURIComponent(lat)}/${encodeURIComponent(lon)}`
    };

    try {
      // Nominatim (OSM) Reverse; kann je nach Browser/CORS/Policy manchmal blocken.
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
      const configuredTimeout = Number(UA.REVERSE_GEOCODE_TIMEOUT_MS);
      const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? configuredTimeout
        : DEFAULT_REVERSE_GEOCODE_TIMEOUT_MS;
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      let timer = null;
      let j;
      try {
        const request = (async () => {
          const r = await fetch(url, {
            method: "GET",
            cache: "no-store",
            headers: { "Accept": "application/json" },
            signal: controller ? controller.signal : undefined
          });
          if (!r.ok) throw new Error(`reverse status ${r.status}`);
          // The same deadline intentionally includes the complete response
          // body.  A server that sends headers and then stalls must not block
          // a PDF/video export forever.
          return r.json();
        })();
        const deadline = new Promise((_, reject) => {
          timer = setTimeout(() => {
            if (controller) controller.abort();
            reject(new Error(`Nominatim timeout after ${timeoutMs}ms (including body)`));
          }, timeoutMs);
        });
        j = await Promise.race([request, deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      // display_name ist meist am brauchbarsten
      const label = j.display_name || fallback.label;

      // optional: hübschere Kurzform aus address-Objekt
      const a = j.address || {};
      const parts = [
        a.road,
        a.house_number ? String(a.house_number) : "",
        a.postcode,
        a.city || a.town || a.village || a.municipality,
        a.suburb || a.neighbourhood
      ].filter(Boolean);

      const details = parts.length ? parts.join(", ") : "";

      const out = {
        label,
        details,
        osmUrl: fallback.osmUrl,
        // Pass through administrative fields useful for Gremien matching
        admin: {
          suburb: a.suburb || a.neighbourhood || null,
          city_district: a.city_district || null,
          borough: a.borough || null,
          quarter: a.quarter || null,
          city: a.city || a.town || a.village || a.municipality || null,
          state: a.state || null,
          postcode: a.postcode || null
        },
        // Address fields useful for political-context search (Issue 3):
        // expose road/suburb/city_district as a flat object so callers can
        // build a compact `locationHint` without re-parsing `details`.
        address: {
          road: a.road || null,
          house_number: a.house_number ? String(a.house_number) : null,
          suburb: a.suburb || a.neighbourhood || null,
          city_district: a.city_district || a.borough || a.quarter || null,
          city: a.city || a.town || a.village || a.municipality || null,
          postcode: a.postcode || null
        }
      };

      _rgCache.set(key, out);
      return out;
    } catch (e) {
      _rgCache.set(key, fallback);
      return fallback;
    }
  };

  // ---------------------------------------------------------------------
  // UA.ensureLocationHint(ctx) — Issue 3 (Vorgangs-Suche):
  // Stellt sicher, dass `ctx.locationHint` mit { street, district, suburb,
  // label } belegt ist, indem es bei Bedarf reverseGeocode auf den
  // Mittelpunkt der aktuellen Selektion / des Map-Centers anwendet.
  // Idempotent + benutzt den vorhandenen `_rgCache`. Liefert das
  // `locationHint`-Objekt zurück (oder null, wenn kein Center ableitbar).
  //
  // Wird aus dem politischen-Recherche-Panel (`UA.PoliticalContext.openPanel`)
  // aufgerufen, damit die Auto-Suche Stadt + Straße + Stadtbezirk kennt,
  // ohne dass vorher ein voller Export gerechnet werden musste.
  UA.ensureLocationHint = async function ensureLocationHint(ctx) {
    if (!ctx) return null;
    if (ctx.locationHint && (ctx.locationHint.street || ctx.locationHint.district || ctx.locationHint.suburb)) {
      return ctx.locationHint;
    }
    // Center bevorzugt aus selectionBounds, sonst aus Map.
    let center = null;
    try {
      if (ctx.selectionBounds && typeof ctx.selectionBounds.getCenter === "function") {
        const c = ctx.selectionBounds.getCenter();
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) center = { lat: c.lat, lng: c.lng };
      }
      if (!center && ctx.map && typeof ctx.map.getCenter === "function") {
        const c = ctx.map.getCenter();
        if (c && Number.isFinite(c.lat) && Number.isFinite(c.lng)) center = { lat: c.lat, lng: c.lng };
      }
    } catch (_) { /* defensive: kein Center → null */ }
    if (!center || typeof UA.reverseGeocode !== "function") return null;
    try {
      const loc = await UA.reverseGeocode(center.lat, center.lng);
      const a = (loc && loc.address) || {};
      const adm = (loc && loc.admin) || {};
      const street = a.road || null;
      const district = a.city_district || adm.city_district || adm.borough || adm.quarter || null;
      const suburb = a.suburb || adm.suburb || null;
      if (!street && !district && !suburb) {
        // Nichts brauchbares im Reverse-Geocoding-Ergebnis — keinen Hint
        // setzen, damit Aufrufer den Topic-only-Fallback nutzen.
        return null;
      }
      ctx.locationHint = {
        street: street || null,
        district: district || null,
        suburb: suburb || null,
        label: (loc && loc.label) || null
      };
      return ctx.locationHint;
    } catch (_) {
      return null;
    }
  };

  
  
})();
