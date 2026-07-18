(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const GUARDED_EXPORTS = [
    'computeExportReport',
    'exportToCSV',
    'exportToGeoJSON',
    'exportToKML',
  ];

  function assertCompleteAccidentCoverage(ctx, operation = 'Export') {
    const coverage = ctx && ctx.accidentDataCoverage;
    if (!coverage || coverage.complete !== false) return true;
    const loaded = Number.isFinite(coverage.loadedFeatureCount)
      ? coverage.loadedFeatureCount
      : 'unbekannt';
    const total = Number.isFinite(coverage.sourceTotalCount)
      ? coverage.sourceTotalCount
      : 'unbekannt';
    throw new Error(
      `${operation} ist im Unfall-Tile-Pilotmodus nicht verfügbar: `
      + `geladen ist nur der aktuelle Kartenausschnitt (${loaded} von ${total} Unfällen). `
      + `Entfernen Sie „accidentDataMode=viewport“ aus der URL, um die vollständige `
      + `Stadtdatei zu laden und eine belastbare Gesamtauswertung zu erzeugen.`
    );
  }

  function wrapExport(name) {
    const original = UA[name];
    if (typeof original !== 'function' || original._accidentCoverageGuarded) return;
    const wrapped = function accidentCoverageGuardedExport(ctx) {
      assertCompleteAccidentCoverage(ctx, name === 'computeExportReport' ? 'Berichtsexport' : 'Datenexport');
      return original.apply(this, arguments);
    };
    wrapped._accidentCoverageGuarded = true;
    wrapped._original = original;
    UA[name] = wrapped;
  }

  for (const name of GUARDED_EXPORTS) wrapExport(name);

  UA.assertCompleteAccidentCoverage = assertCompleteAccidentCoverage;
  UA.installAccidentCoverageExportGuards = function installAccidentCoverageExportGuards() {
    for (const name of GUARDED_EXPORTS) wrapExport(name);
  };
})();
