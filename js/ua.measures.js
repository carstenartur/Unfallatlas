/**
 * UA.measures — Maßnahmenkatalog + automatische Empfehlung.
 *
 * Lädt `data/measures_catalog.json` (Basis) und optional einen Stadt-Override
 * (`templates/measures_<city>_catalog.json`). Stellt `recommendMeasures()`
 * bereit, das auf Basis detektierter überrepräsentierter Beteiligungs-Muster
 * (Bit-Masken aus PATTERN_MAP) passende Maßnahmen vorschlägt.
 *
 * Override-Format identisch zum Basiskatalog. Maßnahmen mit gleicher `id` aus
 * dem Override überschreiben die Basis-Einträge (Stadt kann z. B. lokale
 * Kosten / Leadtime hinterlegen). Neue `id`s werden ergänzt.
 *
 * Das verwandte Modul `server/ai/catalog/cityMeasureCatalog.js` ist server-
 * seitig und füttert die KI-Bewertung – hier geht es um den Frontend-Export
 * (Antrags-Sektion „Empfohlene Maßnahmen").
 */
(() => {
  const UA = (window.UA = window.UA || {});

  const CATALOG_URL = "data/measures_catalog.json";
  const TEMPLATE_DIR = "templates";

  // Hardcoded Mini-Fallback (für Tests / Offline). Die echten Inhalte liegen in der JSON-Datei.
  const FALLBACK = Object.freeze({
    version: 1,
    sources: [],
    disclaimer: "Wirkungswerte sind Erfahrungsspannen; kein Ersatz für ein Fachgutachten.",
    measures: [
      {
        id: "tempo_30",
        label: "Tempo-30-Anordnung",
        category: "regelung",
        costRange: [2000, 8000],
        perUnit: "Abschnitt",
        leadTime: "1–3 Monate",
        effect: { targetPatterns: [1, 2, 3, 5, 6], expectedReductionPct: [10, 25], evidenceLevel: "A" },
        description: "Anordnung von Tempo 30 zur Reduktion von Häufigkeit und Schwere.",
        considerations: [],
        // Konsistent zum Voll-Katalog: nur empfehlen, wenn aktuell > 30 km/h gilt.
        prerequisites: { currentSpeedLimitGt: 30 }
      }
    ]
  });

  let _baseCache = null;
  const _cityCache = new Map();

  function _resetCache() {
    _baseCache = null;
    _cityCache.clear();
  }

  /**
   * Lädt den Basiskatalog (mit Cache, Fallback bei Fehler).
   * @returns {Promise<object>}
   */
  async function loadBaseCatalog() {
    if (_baseCache) return _baseCache;
    try {
      const r = await fetch(CATALOG_URL, { cache: "no-store" });
      if (!r.ok) {
        _baseCache = FALLBACK;
        return _baseCache;
      }
      const data = await r.json();
      if (data && Array.isArray(data.measures)) {
        _baseCache = data;
      } else {
        _baseCache = FALLBACK;
      }
    } catch {
      _baseCache = FALLBACK;
    }
    return _baseCache;
  }

  /**
   * Lädt optional einen Stadt-Override-Katalog. `null` wenn nicht vorhanden.
   * @param {string} citySlug
   * @returns {Promise<object|null>}
   */
  async function loadCityOverride(citySlug) {
    if (!citySlug) return null;
    if (_cityCache.has(citySlug)) return _cityCache.get(citySlug);
    const url = `${TEMPLATE_DIR}/measures_${citySlug}_catalog.json`;
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) {
        _cityCache.set(citySlug, null);
        return null;
      }
      const data = await r.json();
      if (data && Array.isArray(data.measures)) {
        _cityCache.set(citySlug, data);
        return data;
      }
      _cityCache.set(citySlug, null);
      return null;
    } catch {
      _cityCache.set(citySlug, null);
      return null;
    }
  }

  /**
   * Mergt Stadt-Override über Basis-Maßnahmen (gleiche id → Override gewinnt;
   * neue id → ergänzen). Sources werden konkateniert (de-dupliziert per url+title).
   *
   * @param {object} base
   * @param {object|null} override
   * @returns {object} merged catalog
   */
  function mergeCatalogs(base, override) {
    if (!override) return base;
    const byId = new Map();
    for (const m of base.measures || []) byId.set(m.id, m);
    for (const m of override.measures || []) byId.set(m.id, m);
    const measures = Array.from(byId.values());

    const sourcesKey = (s) => `${s && s.url || ""}|${s && s.title || ""}`;
    const sources = [];
    const seenSources = new Set();
    for (const s of [...(base.sources || []), ...(override.sources || [])]) {
      const k = sourcesKey(s);
      if (seenSources.has(k)) continue;
      seenSources.add(k);
      sources.push(s);
    }

    return {
      version: base.version || 1,
      sources,
      disclaimer: override.disclaimer || base.disclaimer,
      measures
    };
  }

  /**
   * Lädt den effektiven Katalog (Basis ⊕ Override) für eine Stadt.
   * @param {string} [citySlug]
   * @returns {Promise<object>}
   */
  async function loadCatalog(citySlug) {
    const [base, override] = await Promise.all([
      loadBaseCatalog(),
      citySlug ? loadCityOverride(citySlug) : Promise.resolve(null)
    ]);
    return mergeCatalogs(base, override);
  }

  /**
   * Bewertet eine Maßnahme bezogen auf eine Liste detektierter Muster.
   * Score = Anzahl getroffener targetPatterns (>0 → Empfehlung).
   * @param {object} measure
   * @param {number[]} detectedPatterns  Liste von Bit-Masken
   * @returns {{ score: number, matchedPatterns: number[] }}
   */
  function scoreMeasure(measure, detectedPatterns) {
    const tgt = (measure && measure.effect && Array.isArray(measure.effect.targetPatterns))
      ? measure.effect.targetPatterns
      : [];
    const detSet = new Set((detectedPatterns || []).map(Number));
    const matched = tgt.filter(t => detSet.has(Number(t)));
    return { score: matched.length, matchedPatterns: matched };
  }

  /**
   * Prüft, ob eine Maßnahme angesichts des erkannten OSM-Kontexts
   * sinnvoll ist. Wenn keine Voraussetzungen definiert sind oder der
   * OSM-Kontext fehlt / die nötigen Felder unbekannt sind, gilt:
   * **kein Ausschluss** (die Empfehlung bleibt erhalten – wir wollen
   * keine fachliche Maßnahme nur wegen fehlender Daten unterdrücken).
   *
   * Unterstützte Voraussetzungen (alle optional, alle müssen passen):
   *  - `currentSpeedLimitGt`   : nur empfehlen, wenn dominanter
   *                              maxspeed > Schwelle (z. B. Tempo 30 nur,
   *                              wenn aktuell > 30 km/h gilt).
   *  - `minLaneWidthM`         : nur empfehlen, wenn durchschnittliche
   *                              Fahrbahnbreite ≥ Schwelle.
   *  - `noExistingBikeInfra`   : true → nur empfehlen, wenn der Anteil
   *                              vorhandener Radinfrastruktur klein ist
   *                              (`cycleInfraShare < BIKE_INFRA_THRESHOLD`).
   *  - `minTrafficSignals`     : nur empfehlen, wenn ≥ N signalisierte
   *                              Knoten im Bereich liegen (LSA-Anpassung
   *                              setzt eine bestehende LSA voraus).
   *  - `maxCrossings`          : nur empfehlen, wenn ≤ N markierte
   *                              Querungen vorhanden sind (eine zusätzliche
   *                              Fußquerung lohnt nicht, wenn es schon
   *                              mehrere gibt).
   *
   * @param {object} measure
   * @param {object|null} osmContext  vollständiges `structured.osmContext`
   *                                  (mit `summary` aus UA.osmContext)
   * @returns {{ ok: boolean, reason?: string }}
   */
  function passesPrerequisites(measure, osmContext) {
    const pre = measure && measure.prerequisites;
    if (!pre || typeof pre !== "object") return { ok: true };
    const summary = osmContext && osmContext.summary;
    // Ohne OSM-Daten: Voraussetzungen können nicht widerlegt werden →
    // Maßnahme bleibt drin (defensiv, vermeidet falsch-negative Filter).
    if (!summary || typeof summary !== "object") return { ok: true };

    if (Number.isFinite(Number(pre.currentSpeedLimitGt))) {
      const dom = Number(summary.dominantMaxspeed);
      // Nur ausschließen, wenn dominantMaxspeed bekannt ist (Sample > 0
      // und numerischer Wert da) und ≤ Schwelle. `null`/0-Sample → pass.
      if (Number.isFinite(dom) && summary.dominantMaxspeed != null
          && Number(summary.speedSampleSize || 0) > 0
          && dom <= Number(pre.currentSpeedLimitGt)) {
        return { ok: false, reason: `aktuelles Tempolimit ${dom} km/h ≤ ${pre.currentSpeedLimitGt}` };
      }
    }

    if (Number.isFinite(Number(pre.minLaneWidthM))) {
      const w = Number(summary.avgWidthMeters);
      // Nur ausschließen, wenn Breite bekannt (Sample > 0) und unter Schwelle.
      if (Number.isFinite(w) && Number(summary.widthSampleSize || 0) > 0 && w < Number(pre.minLaneWidthM)) {
        return { ok: false, reason: `Fahrbahnbreite ${w.toFixed(1)} m < ${pre.minLaneWidthM} m` };
      }
    }

    if (pre.noExistingBikeInfra === true) {
      const share = Number(summary.cycleInfraShare);
      // `cycleInfraShare` ist null, wenn keine klassifizierten Wege da sind →
      // dann nicht ausschließen. Sonst Schwelle 0,30 (mindestens 30 % der
      // klassifizierten Wege bereits mit Radinfrastruktur → unterdrücken).
      const BIKE_INFRA_THRESHOLD = 0.30;
      if (Number.isFinite(share) && share >= BIKE_INFRA_THRESHOLD) {
        return { ok: false, reason: `Radinfrastruktur bereits vorhanden (Anteil ${(share * 100).toFixed(0)} %)` };
      }
    }

    if (Number.isFinite(Number(pre.minTrafficSignals))) {
      // Anzahl signalisierter Knoten ist immer im Summary präsent (0 = bekannt
      // null). Wir prüfen direkt gegen die Schwelle — 0 schlägt eindeutig fehl.
      const sig = Number(summary.trafficSignals);
      if (Number.isFinite(sig) && sig < Number(pre.minTrafficSignals)) {
        return { ok: false, reason: `keine signalisierten Knoten im Bereich (n=${sig})` };
      }
    }

    if (Number.isFinite(Number(pre.maxCrossings))) {
      const cr = Number(summary.crossings);
      if (Number.isFinite(cr) && cr > Number(pre.maxCrossings)) {
        return { ok: false, reason: `bereits ${cr} markierte Querungen vorhanden` };
      }
    }

    return { ok: true };
  }

  /**
   * Context-based suppression. Some catalog measures only make sense
   * when no incompatible Ortskontext is active — e. g. „Sichtbeziehungen
   * herstellen / Bewuchs zurückschneiden" is *not* a credible main
   * recommendation in a Hauptbahnhof / Busbahnhof / Schienen setting
   * (QA-Spec Item 7).
   *
   * The catalog declares this via `prerequisites.suppressInContexts:
   * ["bahnhof","busbahnhof","straßenbahn_schienen","gleisquerung", …]`.
   * If ANY of those keys is present in the active context Set AND the
   * catalog does NOT also carry an explicit positive-evidence whitelist
   * (`prerequisites.requireContexts`), the measure is filtered out.
   *
   * `requireContexts: ["sichtbehinderung"]` lets a measure stay in
   * even if `suppressInContexts` would otherwise drop it — used to
   * surface „Bewuchs zurückschneiden" only when an explicit Sicht-Hint
   * (POI / OSM / Caller-Override) is present.
   *
   * @param {object} measure
   * @param {Set<string>|Iterable<string>|null} activeContexts
   * @returns {{ok:boolean, reason?:string}}
   */
  function passesContextSuppression(measure, activeContexts) {
    const pre = measure && measure.prerequisites;
    if (!pre || typeof pre !== "object") return { ok: true };
    const suppress = Array.isArray(pre.suppressInContexts) ? pre.suppressInContexts : null;
    if (!suppress || suppress.length === 0) return { ok: true };
    const ctx = (activeContexts instanceof Set) ? activeContexts
      : (activeContexts && typeof activeContexts[Symbol.iterator] === "function") ? new Set(activeContexts)
      : null;
    if (!ctx || ctx.size === 0) return { ok: true };
    const hits = suppress.filter(k => ctx.has(k));
    if (hits.length === 0) return { ok: true };
    // Positive-evidence whitelist: wenn der Caller einen Sicht-/Bewuchs-
    // Hinweis explizit setzt, bleibt die Maßnahme drin.
    const required = Array.isArray(pre.requireContexts) ? pre.requireContexts : null;
    if (required && required.some(k => ctx.has(k))) return { ok: true };
    return { ok: false, reason: `unpassend im Ortskontext: ${hits.join(", ")}` };
  }

  /**
   * Sammelt die OSM-Achsen, die im gegebenen Maßnahmen-Subset
   * tatsächlich genutzt werden ("welche Achsen sind hier überhaupt
   * relevant?"). Damit kann der Renderer entscheiden, ob der OSM-Kontext
   * für diese Empfehlungsliste ausreichend ist.
   *
   * @param {object[]} measures  Liste von Maßnahmen-Objekten
   * @returns {{ speed: boolean, width: boolean, bikeInfra: boolean, signals: boolean, crossings: boolean }}
   */
  function collectPrerequisiteAxes(measures) {
    const axes = { speed: false, width: false, bikeInfra: false, signals: false, crossings: false };
    for (const m of (measures || [])) {
      const pre = m && m.prerequisites;
      if (!pre || typeof pre !== "object") continue;
      if (Number.isFinite(Number(pre.currentSpeedLimitGt))) axes.speed = true;
      if (Number.isFinite(Number(pre.minLaneWidthM))) axes.width = true;
      if (pre.noExistingBikeInfra === true) axes.bikeInfra = true;
      if (Number.isFinite(Number(pre.minTrafficSignals))) axes.signals = true;
      if (Number.isFinite(Number(pre.maxCrossings))) axes.crossings = true;
    }
    return axes;
  }

  /**
   * Bewertet die OSM-Datenabdeckung für die übergebenen Achsen.
   * Liefert pro Achse, ob sie aus dem `osmContext.summary` belastbar
   * geprüft werden konnte — auf dieser Basis kann der Renderer den
   * "OSM-Voraussetzungen mangels Daten nicht geprüft"-Hinweis bauen.
   *
   * Verwendet dieselben Schwellen wie `passesPrerequisites`:
   *  - speed     : `dominantMaxspeed != null && speedSampleSize > 0`
   *  - width     : `avgWidthMeters != null && widthSampleSize > 0`
   *  - bikeInfra : `cycleInfraShare != null` (Share kann auch 0 sein)
   *  - signals   : `trafficSignals != null` (auch 0 ist eine Information)
   *  - crossings : `crossings != null`
   *
   * @param {object|null} osmContext   `structured.osmContext`
   * @param {object} axes              Ausgabe von `collectPrerequisiteAxes`
   * @returns {{
   *   present: boolean,
   *   error: string|null,
   *   axes: object,
   *   missingAxes: string[],
   *   hasGap: boolean
   * }}
   */
  function osmCoverage(osmContext, axes) {
    const want = axes || { speed: false, width: false, bikeInfra: false, signals: false, crossings: false };
    const error = (osmContext && osmContext.quality && osmContext.quality.error) || null;
    const summary = osmContext && osmContext.summary;
    const result = {
      present: !!summary,
      error,
      axes: { speed: false, width: false, bikeInfra: false, signals: false, crossings: false },
      missingAxes: [],
      hasGap: false
    };
    if (summary) {
      result.axes.speed = (summary.dominantMaxspeed != null
        && Number(summary.speedSampleSize || 0) > 0);
      result.axes.width = (summary.avgWidthMeters != null
        && Number(summary.widthSampleSize || 0) > 0);
      result.axes.bikeInfra = (summary.cycleInfraShare != null);
      result.axes.signals = (summary.trafficSignals != null);
      result.axes.crossings = (summary.crossings != null);
    }
    const labels = {
      speed: "Tempolimit",
      width: "Fahrbahnbreite",
      bikeInfra: "Radinfrastruktur",
      signals: "signalisierte Knoten",
      crossings: "markierte Querungen"
    };
    for (const k of ["speed", "width", "bikeInfra", "signals", "crossings"]) {
      if (want[k] && !result.axes[k]) {
        result.missingAxes.push(labels[k]);
        result.hasGap = true;
      }
    }
    return result;
  }

  /**
   * Empfehlungs-Engine.
   *
   * @param {number[]} detectedPatterns  Bit-Masken überrepräsentierter Muster
   * @param {object}   catalog           Bereits geladener Katalog
   * @param {object}   [opts]
   * @param {number}   [opts.limit=5]    Maximalzahl Empfehlungen
   * @param {object}   [opts.economicImpact]  Optional, ergibt Amortisations-Block
   *                   (Format: { annual: number } aus UA.costs.computeAnnualCost)
   * @param {object}   [opts.osmContext]      Optional, `structured.osmContext`.
   *                   Wird genutzt, um Maßnahmen mit `prerequisites`-Block zu
   *                   filtern (z. B. Tempo 30 nur, wenn aktuell > 30 km/h).
   * @returns {{
   *   measures: Array<{
   *     measure: object,
   *     score: number,
   *     matchedPatterns: number[],
   *     amortisation?: { years: [number, number]|null, lowYears: number|null, highYears: number|null }
   *   }>,
   *   sources: object[],
   *   disclaimer: string,
   *   filteredOut?: Array<{ id: string, label: string, reason: string }>
   * }}
   */
  function recommendMeasures(detectedPatterns, catalog, opts) {
    const cat = catalog && Array.isArray(catalog.measures) ? catalog : FALLBACK;
    const limit = (opts && Number.isFinite(opts.limit)) ? opts.limit : 5;
    const annual = opts && opts.economicImpact && Number.isFinite(opts.economicImpact.annual)
      ? Number(opts.economicImpact.annual)
      : null;
    const osmContext = (opts && opts.osmContext) || null;
    const activeContexts = (opts && opts.activeContexts) || null;

    const scored = [];
    const filteredOut = [];
    for (const m of cat.measures) {
      const s = scoreMeasure(m, detectedPatterns);
      if (s.score <= 0) continue;
      // OSM-Kontext-Voraussetzungen prüfen, bevor wir die Maßnahme aufnehmen.
      const pre = passesPrerequisites(m, osmContext);
      if (!pre.ok) {
        filteredOut.push({ id: m.id, label: m.label, reason: pre.reason || "Voraussetzungen nicht erfüllt" });
        continue;
      }
      // Kontextuelle Suppression (Spec-Item 7): „Bewuchs zurückschneiden"
      // entfällt im Bahnhofs-/Schienen-Kontext, sofern keine explizite
      // Sicht-Evidenz gesetzt ist.
      const supp = passesContextSuppression(m, activeContexts);
      if (!supp.ok) {
        filteredOut.push({ id: m.id, label: m.label, reason: supp.reason || "Im Ortskontext unpassend" });
        continue;
      }
      const entry = { measure: m, score: s.score, matchedPatterns: s.matchedPatterns };

      // Amortisation: für die untere bzw. obere Wirkungsspanne durchrechnen
      if (annual && Array.isArray(m.costRange) && m.effect && Array.isArray(m.effect.expectedReductionPct)) {
        const [costLow, costHigh] = m.costRange;
        const [redLow, redHigh] = m.effect.expectedReductionPct;
        // Best case: niedrige Kosten + hohe Wirkung → kürzeste Amortisation
        const best = (UA.costs && UA.costs.computeAmortisationYears)
          ? UA.costs.computeAmortisationYears(costLow, annual, redHigh / 100)
          : null;
        // Worst case: hohe Kosten + niedrige Wirkung
        const worst = (UA.costs && UA.costs.computeAmortisationYears)
          ? UA.costs.computeAmortisationYears(costHigh, annual, redLow / 100)
          : null;
        entry.amortisation = {
          lowYears: best,   // schnellste (best-case)
          highYears: worst, // langsamste (worst-case)
          years: (best != null && worst != null) ? [best, worst] : null
        };
      }
      scored.push(entry);
    }

    // Sortierung: 1) Score desc, 2) Untere Kostenkante asc (günstigste zuerst), 3) Label asc
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aCost = (a.measure.costRange && a.measure.costRange[0]) || 0;
      const bCost = (b.measure.costRange && b.measure.costRange[0]) || 0;
      if (aCost !== bCost) return aCost - bCost;
      return String(a.measure.label || "").localeCompare(String(b.measure.label || ""), "de");
    });

    // Welche OSM-Achsen sind im finalen Set + den weggefilterten relevant?
    // Wir betrachten **beide** Mengen, damit der Renderer auch dann auf
    // fehlende Daten hinweisen kann, wenn ein Vorschlag mangels Kontext
    // gar nicht erst gefiltert werden konnte.
    const reachedMeasures = scored.map(e => e.measure)
      .concat((cat.measures || []).filter(m => m.prerequisites && filteredOut.find(f => f.id === m.id)));
    const usedAxes = collectPrerequisiteAxes(reachedMeasures);
    const coverage = osmCoverage(osmContext, usedAxes);

    return {
      measures: scored.slice(0, limit),
      sources: cat.sources || [],
      disclaimer: cat.disclaimer || FALLBACK.disclaimer,
      filteredOut,
      // OSM-Datenabdeckung für diese Empfehlungsliste. Renderer können daraus
      // den "OSM-Voraussetzungen mangels Daten nicht geprüft"-Hinweis bauen.
      osmCoverage: coverage
    };
  }

  /**
   * Hilfs-Formatter: "25.000–80.000 €" oder "25 Tsd. – 80 Tsd. €" wenn `short`.
   * @param {[number,number]} range
   * @param {{ short?: boolean }} [opts]
   */
  function formatCostRange(range, opts) {
    if (!Array.isArray(range) || range.length !== 2) return "—";
    const fmt = (UA.costs && UA.costs.formatEUR)
      ? (v) => UA.costs.formatEUR(v, opts)
      : (v) => `${v} €`;
    const a = fmt(range[0]);
    const b = fmt(range[1]);
    // Determine each end's currency suffix ("Mio. €", "Tsd. €" or " €").
    // Only collapse the unit when both ends carry the same suffix — otherwise
    // we'd silently turn "80 Tsd." + "1,5 Mio. €" into "80 – 1,5 Mio. €" and
    // drop the "Tsd." on the lower bound. We return `m[0]` (the actual matched
    // text) instead of reconstructing the suffix so any whitespace variation
    // in the input is preserved verbatim.
    const suffixOf = (s) => {
      const m = s.match(/\s+(?:Mio\.|Tsd\.)\s*€\s*$/);
      if (m) return m[0];
      const m2 = s.match(/\s+€\s*$/);
      if (m2) return m2[0];
      return "";
    };
    const sa = suffixOf(a);
    const sb = suffixOf(b);
    if (sa && sa === sb) {
      // Strip suffix from `a` only; keep `b` fully so the unit appears once at the end.
      const aStripped = a.slice(0, a.length - sa.length).trimEnd();
      return `${aStripped} – ${b}`;
    }
    // Mixed (or no) units: keep both ends fully so the unit on each side stays visible.
    return `${a} – ${b}`;
  }

  /**
   * Format reduction percentage range as "10–25 %".
   */
  function formatReductionRange(range) {
    if (!Array.isArray(range) || range.length !== 2) return "—";
    return `${range[0]}–${range[1]} %`;
  }

  // --------------------------------------------------------------------
  // Priorisierung nach Umsetzungshorizont (Goldstandard-Sektion 8).
  // --------------------------------------------------------------------
  // Bezirksvertretungen brauchen nicht die volle Maßnahmen­liste, sondern
  // eine 30-Sekunden-Antwort darauf, *wann* welche Schritte realistisch
  // umsetzbar sind. Wir leiten die Zuordnung deterministisch aus der
  // `leadTime`-Spannweite jedes Maßnahmen-Eintrags im Katalog ab — kein
  // neuer Datenkanal, keine zusätzliche Quelle, keine Heuristik im
  // Renderer.
  //
  // Regel (entspricht 1:1 dem User-Goldstandard "0–3 / 3–12 / >12 Monate"):
  //   - Oberes Ende des Spans Y (aus "X–Y Monate") entscheidet.
  //   - Y ≤ 3   →  "kurzfristig"
  //   - Y ≤ 12  →  "mittelfristig"
  //   - Y > 12  →  "langfristig"
  //   - parsing fehlgeschlagen / leer →  "unbekannt"
  //
  // Liberales Parsing: akzeptiert Bindestrich, Halbgeviertstrich und
  // Geviertstrich („1-3", „1–3", „1—3 Monate") sowie einzelne Zahlen
  // („6 Monate" → Y=6).
  // --------------------------------------------------------------------
  const TIME_HORIZON_KEYS = Object.freeze(["kurzfristig", "mittelfristig", "langfristig", "unbekannt"]);

  function parseLeadTimeUpperMonths(leadTime) {
    if (typeof leadTime !== "string") return null;
    const s = leadTime.trim();
    if (!s) return null;
    // Match "<num>[ ]?[-–—][ ]?<num> Monate" or "<num> Monate".
    const range = s.match(/(\d+)\s*[-\u2013\u2014]\s*(\d+)/);
    if (range) {
      const upper = parseInt(range[2], 10);
      return Number.isFinite(upper) ? upper : null;
    }
    const single = s.match(/(\d+)/);
    if (single) {
      const n = parseInt(single[1], 10);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  function classifyTimeHorizon(leadTime) {
    const upper = parseLeadTimeUpperMonths(leadTime);
    if (upper === null) return "unbekannt";
    if (upper <= 3) return "kurzfristig";
    if (upper <= 12) return "mittelfristig";
    return "langfristig";
  }

  /**
   * Bucket recommendedMeasures.measures into the three Goldstandard time
   * horizons + a residual "unbekannt" slot. Preserves the input order
   * inside each bucket (which is the score/cost-sorted order produced by
   * `recommendMeasures`), so the renderers don't have to re-sort.
   *
   * The `meta.totals` block lets the renderer surface „Kurzfristig (n=2)"
   * counts and decide whether an empty bucket should be rendered as
   * „— keine Maßnahmen in diesem Horizont —" rather than silently
   * omitted (avoids the misleading impression that only long-term action
   * is possible).
   *
   * @param {object|null} recommendedMeasures  structured.recommendedMeasures shape from `recommendMeasures()`
   * @returns {{
   *   kurzfristig: Array,
   *   mittelfristig: Array,
   *   langfristig: Array,
   *   unbekannt: Array,
   *   meta: { totals: {kurzfristig:number,mittelfristig:number,langfristig:number,unbekannt:number,all:number} }
   * }}
   */
  function buildPrioritization(recommendedMeasures) {
    const buckets = { kurzfristig: [], mittelfristig: [], langfristig: [], unbekannt: [] };
    const items = (recommendedMeasures && Array.isArray(recommendedMeasures.measures))
      ? recommendedMeasures.measures
      : [];

    for (const item of items) {
      const m = (item && item.measure) || null;
      if (!m) continue;
      const horizon = classifyTimeHorizon(m.leadTime);
      buckets[horizon].push({
        id: m.id,
        label: m.label,
        leadTime: m.leadTime || "—",
        horizon,
        // Carry the original entry so renderers can pull description /
        // costRange / effect without a second lookup.
        entry: item
      });
    }

    return {
      kurzfristig: buckets.kurzfristig,
      mittelfristig: buckets.mittelfristig,
      langfristig: buckets.langfristig,
      unbekannt: buckets.unbekannt,
      meta: {
        totals: {
          kurzfristig: buckets.kurzfristig.length,
          mittelfristig: buckets.mittelfristig.length,
          langfristig: buckets.langfristig.length,
          unbekannt: buckets.unbekannt.length,
          all: buckets.kurzfristig.length + buckets.mittelfristig.length
            + buckets.langfristig.length + buckets.unbekannt.length
        }
      }
    };
  }

  UA.measures = {
    loadBaseCatalog,
    loadCityOverride,
    loadCatalog,
    mergeCatalogs,
    recommendMeasures,
    scoreMeasure,
    passesPrerequisites,
    passesContextSuppression,
    collectPrerequisiteAxes,
    osmCoverage,
    formatCostRange,
    formatReductionRange,
    classifyTimeHorizon,
    buildPrioritization,
    TIME_HORIZON_KEYS,
    FALLBACK,
    _resetCache
  };
})();
