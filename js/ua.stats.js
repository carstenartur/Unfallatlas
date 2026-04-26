(() => {
  const UA = (window.UA = window.UA || {});

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

  UA.wilsonScoreInterval = wilsonScoreInterval;
})();
