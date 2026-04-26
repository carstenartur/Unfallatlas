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
        considerations: []
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
   * Empfehlungs-Engine.
   *
   * @param {number[]} detectedPatterns  Bit-Masken überrepräsentierter Muster
   * @param {object}   catalog           Bereits geladener Katalog
   * @param {object}   [opts]
   * @param {number}   [opts.limit=5]    Maximalzahl Empfehlungen
   * @param {object}   [opts.economicImpact]  Optional, ergibt Amortisations-Block
   *                   (Format: { annual: number } aus UA.costs.computeAnnualCost)
   * @returns {{
   *   measures: Array<{
   *     measure: object,
   *     score: number,
   *     matchedPatterns: number[],
   *     amortisation?: { years: [number, number]|null, lowYears: number|null, highYears: number|null }
   *   }>,
   *   sources: object[],
   *   disclaimer: string
   * }}
   */
  function recommendMeasures(detectedPatterns, catalog, opts) {
    const cat = catalog && Array.isArray(catalog.measures) ? catalog : FALLBACK;
    const limit = (opts && Number.isFinite(opts.limit)) ? opts.limit : 5;
    const annual = opts && opts.economicImpact && Number.isFinite(opts.economicImpact.annual)
      ? Number(opts.economicImpact.annual)
      : null;

    const scored = [];
    for (const m of cat.measures) {
      const s = scoreMeasure(m, detectedPatterns);
      if (s.score <= 0) continue;
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

    return {
      measures: scored.slice(0, limit),
      sources: cat.sources || [],
      disclaimer: cat.disclaimer || FALLBACK.disclaimer
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

  UA.measures = {
    loadBaseCatalog,
    loadCityOverride,
    loadCatalog,
    mergeCatalogs,
    recommendMeasures,
    scoreMeasure,
    formatCostRange,
    formatReductionRange,
    FALLBACK,
    _resetCache
  };
})();
