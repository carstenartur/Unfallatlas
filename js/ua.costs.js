/** Modelled personal injury costs based on accident counts in Unfallatlas. */
(() => {
  const UA = (window.UA = window.UA || {});
  const COST_DATA_URL = "data/cost_factors_de.json";
  // Offline copy of the published factor file. A unit test checks exact parity.
  const FALLBACK = Object.freeze({
    "version": 2,
    "source": {
      "publisher": "Bundesanstalt für Straßenwesen (BASt)",
      "title": "Verkehrsbericht 2024 des Polizeipräsidiums Osthessen, S. 5, Fußnote 1",
      "year": 2023,
      "url": "https://www.polizei.hessen.de/sites/polizei.hessen.de/files/2026-01/ppoh_verkehrsbericht_2024.pdf#page=6"
    },
    "perPerson": {
      "fatal": {
        "value": 1225152,
        "unit": "EUR/Person",
        "label": "Getötete Person"
      },
      "severe": {
        "value": 131878,
        "unit": "EUR/Person",
        "label": "Schwerverletzte Person"
      },
      "light": {
        "value": 6082,
        "unit": "EUR/Person",
        "label": "Leichtverletzte Person"
      }
    },
    "disclaimer": "Die Rechnung setzt je Unfall eine Person der höchsten erfassten Verletzungsschwere an. Die Unfallstatistik zählt hier Unfälle. Weitere Betroffene und Sachschäden bleiben unberücksichtigt. Der Modellwert erlaubt keine Aussage über den tatsächlichen örtlichen Schaden oder die Einsparung durch eine Maßnahme."
  });
  const categories = [
    ["fatal", "Mit Getöteten"],
    ["severe", "Mit Schwerverletzten"],
    ["light", "Mit Leichtverletzten"]
  ];

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
      if (data?.version === 2 && Number.isInteger(data.source?.year) && /^https:\/\//.test(data.source.url)
          && data.source.publisher && data.source.title && data.disclaimer && categories.every(([key]) =>
            data.perPerson?.[key]?.unit === "EUR/Person" && Number.isFinite(data.perPerson[key].value) && data.perPerson[key].value > 0)) {
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
   * Berechnet einen Modellwert für Personenschäden aus gezählten Unfällen.
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

    // Older callers may supply their own rates under the previous field name.
    const f = factors?.perPerson || factors?.perAccident || FALLBACK.perPerson;
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

  function reportTable(impact) {
    if (!impact?.counts) return null;
    // Previously saved reports used unverified rates. Their crash counts still
    // allow a calculation using today's documented model and source.
    if (impact.modelVersion !== 2) {
      const { fatal, severe, light } = impact.counts;
      const calc = computeAnnualCost({ 1: fatal, 2: severe, 3: light }, impact.years, FALLBACK);
      impact = { ...calc, source: FALLBACK.source, disclaimer: FALLBACK.disclaimer };
    }
    if (!(impact.total > 0)) return null;
    const rows = categories.map(([key, label]) => [label, String(impact.counts[key]), formatEUR(impact.factors[key]), formatEUR(impact.breakdown[key])]);
    const count = categories.reduce((sum, [key]) => sum + impact.counts[key], 0);
    rows.push([`Gesamt (${impact.years} ${impact.years === 1 ? "Jahr" : "Jahre"})`, String(count), "", formatEUR(impact.total)]);
    rows.push(["Jahresmittel", "", "", formatEUR(impact.annual)]);
    return {
      title: "Modellrechnung für Personenschäden",
      headers: ["Unfallkategorie", "Unfälle", "Satz je Person", "Modellwert"],
      rows,
      note: impact.disclaimer,
      sourceLabel: `${impact.source.publisher}, Preisstand ${impact.source.year}. ${impact.source.title}`,
      sourceUrl: impact.source.url
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
    reportTable,
    computeAmortisationYears,
    FALLBACK,
    _resetCache
  };
})();
