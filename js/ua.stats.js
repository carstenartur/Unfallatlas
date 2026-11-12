(() => {
  const REFERENCE_METHOD = 'newcombe-wilson-95';
  const REFERENCE_LIMITATIONS = Object.freeze({
    inference: 'exploratory', multiplicityAdjustment: 'none',
    referenceIncludesLocal: false, localIntervalOnly: false,
    note: 'Die parallele Mustersuche bleibt explorativ. Die Newcombe-95-%-Intervalle berücksichtigen die Unsicherheit beider Gruppen und sind unbereinigt. Es gibt keine Mehrfachtestkorrektur. Räumliche und zeitliche Abhängigkeiten werden nicht modelliert.'
  });

  function patternReferenceStatus(status) {
    switch (status) {
      case 'empty-local': return 'Im Ausschnitt liegen unter den aktiven Filtern keine auswertbaren Fälle vor.';
      case 'empty-reference': return 'Im übrigen Stadtgebiet liegen unter denselben Filtern keine auswertbaren Fälle vor.';
      case 'unavailable': return 'Für den Vergleich fehlt ein nachweislich vollständiger Stadtbestand oder die Berechnung ist nicht verfügbar.';
      default: return '';
    }
  }

  function patternReferenceMethodology(deviations) {
    if (deviations?.reference?.method !== REFERENCE_METHOD) return null;
    return {
      referenceStatus: deviations.reference.status,
      referenceStatusNote: patternReferenceStatus(deviations.reference.status),
      limitations: REFERENCE_LIMITATIONS,
      localPopulation: 'Unfälle innerhalb der Auswahlgeometrie unter den aktiven Filtern',
      referencePopulation: 'Unfälle im übrigen Stadtgebiet unter denselben aktiven Filtern',
      formulas: {
        localShare: 'locR = locCnt / local.total',
        referenceShare: 'baseR = baseCnt / baseline.total',
        factor: 'factor = locR / baseR (nur bei positivem Referenzanteil)',
        difference: 'difference = locR − baseR',
        uncertainty: 'Newcombe-95-%-Konfidenzintervall der Anteilsdifferenz aus den Wilson-Intervallen beider Anteile (differenceCiLow/differenceCiHigh); ciLow/ciHigh beschreiben den lokalen Anteil',
        significance: 'isSignificant = true, wenn differenceCiLow > 0 (unbereinigter explorativer Einzelhinweis)'
      }
    };
  }

  /**
   * Wilson-Score-Konfidenzintervall (zweiseitig) für einen beobachteten Anteil.
   *
   * @param {number} k  Anzahl Treffer (lokale Zählung des Musters)
   * @param {number} n  Gesamtzahl Beobachtungen (lokale Gesamtunfälle)
   * @param {number} [z=1.96]  z-Wert für das gewünschte Konfidenzniveau (1,96 ≈ 95 %)
   * @returns {{ low: number, high: number }}  Untere und obere Grenze des Intervalls (Anteile, 0–1)
   *
   * Formel:  (p̂ + z²/2n ± z·√(p̂(1-p̂)/n + z²/4n²)) / (1 + z²/n)
   *
   * Randfall n=0: gibt { low: 0, high: 1 } zurück.
   * Randfall k=0: untere Grenze = 0.
   * Randfall k=n: obere Grenze = 1.
   */
  function wilsonScoreInterval(k, n, z) {
    if (z === undefined) z = 1.96;
    if (n <= 0) return { low: 0, high: 1 };
    const p = k / n;
    const z2 = z * z;
    const center = (p + z2 / (2 * n)) / (1 + z2 / n);
    const margin = (z / (1 + z2 / n)) * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
    return {
      low:  Math.max(0, center - margin),
      high: Math.min(1, center + margin)
    };
  }

  // Newcombe (1998), method 10, combining uncorrected Wilson bounds.
  function newcombeDifferenceInterval(localCount, localTotal, referenceCount, referenceTotal) {
    if (localTotal <= 0 || referenceTotal <= 0) return null;
    const local = localCount / localTotal;
    const reference = referenceCount / referenceTotal;
    const localWilson = wilsonScoreInterval(localCount, localTotal);
    const referenceWilson = wilsonScoreInterval(referenceCount, referenceTotal);
    const difference = local - reference;
    return {
      difference,
      low: Math.max(-1, difference - Math.hypot(local - localWilson.low, referenceWilson.high - reference)),
      high: Math.min(1, difference + Math.hypot(localWilson.high - local, reference - referenceWilson.low))
    };
  }

  const api = { wilsonScoreInterval, newcombeDifferenceInterval, patternReferenceMethod: REFERENCE_METHOD, patternReferenceMethodology };
  if (typeof module === 'object' && module.exports) Object.assign(module.exports, api);
  if (typeof window === 'object') Object.assign(window.UA = window.UA || {}, api);
})();
