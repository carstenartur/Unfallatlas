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

  function guarded(name, original) {
    if (typeof original !== 'function' || original._accidentCoverageGuarded) return original;
    const wrapped = function accidentCoverageGuardedExport(ctx) {
      assertCompleteAccidentCoverage(
        ctx,
        name === 'computeExportReport' ? 'Berichtsexport' : 'Datenexport'
      );
      return original.apply(this, arguments);
    };
    wrapped._accidentCoverageGuarded = true;
    wrapped._original = original;
    return wrapped;
  }

  function restoreReportFinalizer(name) {
    if (name !== 'computeExportReport') return;
    // The evidence-safe bridge intentionally yields while this bootstrap
    // accessor owns the property. As soon as the real guarded report function
    // exists, hand the ordinary data property back synchronously so no export
    // can observe an unfinalized or multiply wrapped intermediate state.
    UA.EvidenceSafeSemanticsBridge?.install?.();
  }

  function installFunctionHook(name) {
    if (typeof UA[name] === 'function') {
      UA[name] = guarded(name, UA[name]);
      restoreReportFinalizer(name);
      return;
    }

    let pending;
    try {
      Object.defineProperty(UA, name, {
        configurable: true,
        enumerable: true,
        get() { return pending; },
        set(value) {
          pending = guarded(name, value);
          Object.defineProperty(UA, name, {
            value: pending,
            writable: true,
            configurable: true,
            enumerable: true,
          });
          restoreReportFinalizer(name);
        },
      });
    } catch (_) {
      // Frozen test doubles can still call the explicit install function later.
    }
  }

  function install() {
    for (const name of GUARDED_EXPORTS) installFunctionHook(name);
  }

  UA.assertCompleteAccidentCoverage = assertCompleteAccidentCoverage;
  UA.installAccidentCoverageExportGuards = install;
  install();
})();
