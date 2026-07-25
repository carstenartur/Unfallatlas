/**
 * UA.costs — Volkswirtschaftliche Unfallkosten (BASt-Größenordnungen).
 *
 * Lädt `data/cost_factors_de.json` und stellt reine Helfer bereit, um aus
 * Schweregradzählungen jährliche externe Kosten zu schätzen.
 *
 * Schweregradschlüssel folgen der Unfallatlas-Konvention (`ukategorie`):
 *   "1" → Getötete (fatal)
 *   "2" → Schwerverletzte (severe)
 *   "3" → Leichtverletzte (light)
 *
 * Alle Funktionen sind reine Berechnungen ohne DOM-Zugriff und gut testbar.
 */
(() => {
  const UA = (window.UA = window.UA || {});

  const COST_DATA_URL = "data/cost_factors_de.json";

  // Hardcoded fallback (BASt-Größenordnungen). Wird verwendet, wenn die JSON
  // nicht geladen werden kann (z. B. in Tests oder bei Offline-Nutzung).
  const FALLBACK = Object.freeze({
    version: 1,
    source: {
      publisher: "BASt – Bundesanstalt für Straßenwesen",
      title: "Volkswirtschaftliche Kosten von Straßenverkehrsunfällen (Fallback-Größenordnungen)",
      year: 2023,
      url: "https://www.bast.de/DE/Publikationen/Statistik/Unfaelle/volkswirtschaftliche_kosten.html"
    },
    perAccident: {
      fatal:  { value: 1300000, unit: "EUR", key: "ukategorie=1", label: "Getöteter" },
      severe: { value:  140000, unit: "EUR", key: "ukategorie=2", label: "Schwerverletzter" },
      light:  { value:    5000, unit: "EUR", key: "ukategorie=3", label: "Leichtverletzter" }
    },
    disclaimer: "Grobe Schätzung volkswirtschaftlicher Kosten nach BASt-Größenordnungen. Sachschäden ohne Personenschaden sind nicht erfasst. Kein Ersatz für ein Fachgutachten."
  });

  let _cached = null;

  /**
   * Lädt die Kostenfaktoren (mit einfachem in-Memory-Cache). Liefert immer
   * eine gültige Struktur — bei Fetch-Fehler wird der Fallback verwendet.
   *
   * @returns {Promise<object>} Kostenfaktoren-Konfiguration.
   */
  async function loadCostFactors() {
    if (_cached) return _cached;
    try {
      const r = await fetch(COST_DATA_URL, { cache: "no-store" });
      if (!r.ok) {
        _cached = FALLBACK;
        return _cached;
      }
      const data = await r.json();
      // Validiere Mindeststruktur, sonst Fallback
      if (data && data.perAccident && data.perAccident.fatal && data.perAccident.severe && data.perAccident.light) {
        _cached = data;
      } else {
        _cached = FALLBACK;
      }
    } catch {
      _cached = FALLBACK;
    }
    return _cached;
  }

  /**
   * Test-Helfer: Setzt den Cache zurück (nicht für produktive Nutzung gedacht).
   */
  function _resetCache() { _cached = null; }

  /**
   * Berechnet die jährlichen externen Kosten aus einer Schweregrad-Zählung.
   *
   * @param {{ "1"?: number, "2"?: number, "3"?: number }} severityCounts
   *        Anzahl der Unfälle pro Schweregrad (gesamt über `years` Jahre).
   * @param {number} years  Anzahl Jahre, über die die Zählung läuft (≥ 1).
   * @param {object} factors  Kostenfaktoren-Konfiguration (aus `loadCostFactors`).
   * @returns {{
   *   total: number,         // Gesamtsumme über alle Jahre (EUR)
   *   annual: number,        // Pro Jahr (EUR)
   *   years: number,         // Eingesetzte Jahresanzahl
   *   breakdown: { fatal: number, severe: number, light: number },
   *   counts:    { fatal: number, severe: number, light: number },
   *   factors:   { fatal: number, severe: number, light: number }
   * }}
   */
  function computeAnnualCost(severityCounts, years, factors) {
    const sc = severityCounts || {};
    const cFatal  = Number(sc["1"]) || 0;
    const cSevere = Number(sc["2"]) || 0;
    const cLight  = Number(sc["3"]) || 0;

    const f = (factors && factors.perAccident) || FALLBACK.perAccident;
    const vFatal  = Number(f.fatal && f.fatal.value)  || 0;
    const vSevere = Number(f.severe && f.severe.value) || 0;
    const vLight  = Number(f.light && f.light.value)  || 0;

    const total = cFatal * vFatal + cSevere * vSevere + cLight * vLight;
    const y = Number.isFinite(Number(years)) && Number(years) > 0 ? Number(years) : 1;
    const annual = total / y;

    return {
      total,
      annual,
      years: y,
      breakdown: {
        fatal:  cFatal  * vFatal,
        severe: cSevere * vSevere,
        light:  cLight  * vLight
      },
      counts:  { fatal: cFatal, severe: cSevere, light: cLight },
      factors: { fatal: vFatal, severe: vSevere, light: vLight }
    };
  }

  /**
   * Formatiert einen EUR-Betrag deutschlandüblich. Beträge ≥ 1 Mio werden
   * auf 1 Nachkommastelle in Mio. €, ≥ 10.000 auf volle 1.000 € gerundet,
   * sonst auf volle EUR.
   *
   * @param {number} value
   * @param {{ short?: boolean }} [opts]
   * @returns {string}
   */
  function formatEUR(value, opts) {
    const v = Number(value);
    if (!Number.isFinite(v)) return "—";
    const short = !!(opts && opts.short);

    if (short) {
      if (Math.abs(v) >= 1_000_000) {
        return formatGermanNumber(v / 1_000_000, 1) + " Mio. €";
      }
      if (Math.abs(v) >= 10_000) {
        return formatGermanNumber(Math.round(v / 1000), 0) + " Tsd. €";
      }
    }
    return formatGermanNumber(Math.round(v), 0) + " €";
  }

  function formatGermanNumber(n, decimals) {
    const sign = n < 0 ? "-" : "";
    const abs = Math.abs(n);
    const fixed = abs.toFixed(decimals);
    const [intPart, fracPart] = fixed.split(".");
    // Tausenderpunkt
    const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return sign + grouped + (fracPart ? "," + fracPart : "");
  }

  /**
   * Berechnet die Amortisationszeit einer Maßnahme in Jahren.
   *
   * amortisationYears = costMin / (annualCost * reductionPct)
   *
   * @param {number} measureCostEur   Investitionskosten der Maßnahme (EUR).
   * @param {number} annualCostEur    Jährliche externe Kosten im Bereich (EUR).
   * @param {number} reductionPct     Erwartete Reduktion (0..1).
   * @returns {number|null}  Amortisationszeit in Jahren oder null, wenn nicht berechenbar.
   */
  function computeAmortisationYears(measureCostEur, annualCostEur, reductionPct) {
    const cost = Number(measureCostEur);
    const annual = Number(annualCostEur);
    const red = Number(reductionPct);
    if (!Number.isFinite(cost) || cost <= 0) return null;
    if (!Number.isFinite(annual) || annual <= 0) return null;
    if (!Number.isFinite(red) || red <= 0) return null;
    return cost / (annual * red);
  }

  UA.costs = {
    loadCostFactors,
    computeAnnualCost,
    formatEUR,
    computeAmortisationYears,
    FALLBACK,
    _resetCache
  };
})();
