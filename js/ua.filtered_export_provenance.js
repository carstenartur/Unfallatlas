(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  if (UA.filteredExportProvenance) return;

  const WRAPPED = '_uaFilteredExportProvenanceWrapped';
  const POLICY = 'Beteiligungsfilter angewendet; Export enthält ausschließlich Unfälle der aktiven Beteiligungsauswahl';
  const DESCRIPTION = 'Auswahl im Exportbereich unter allen aktiven Filtern einschließlich Beteiligungsmodus; Exportfelder werden normalisiert.';
  const NAMES = ['exportToCSV', 'exportToGeoJSON', 'exportToKML', 'exportToWord', 'exportToPDF'];

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function correctManifest(manifest) {
    const corrected = clone(manifest);
    if (!corrected || typeof corrected !== 'object') return corrected;
    corrected.scenario = corrected.scenario || {};
    corrected.scenario.filters = corrected.scenario.filters || {};
    corrected.scenario.filters.dataExportInvolvementPolicy = POLICY;
    for (const transformation of corrected.transformations || []) {
      if (!transformation || transformation.transformationId !== 'filter-export-selection') continue;
      transformation.description = DESCRIPTION;
      transformation.parameters = transformation.parameters || {};
      transformation.parameters.filters = transformation.parameters.filters || {};
      transformation.parameters.filters.dataExportInvolvementPolicy = POLICY;
    }
    return corrected;
  }

  function chainContainsWrapper(fn) {
    const seen = new Set();
    let current = fn;
    for (let depth = 0; typeof current === 'function' && depth < 20 && !seen.has(current); depth += 1) {
      if (current[WRAPPED]) return true;
      seen.add(current);
      current = current._original || current.original || null;
    }
    return false;
  }

  async function scopedContextWithManifest(ctx) {
    if (!UA.AnalysisScope || typeof UA.AnalysisScope.createScopedContext !== 'function') {
      throw new Error('Filtered export provenance requires UA.AnalysisScope');
    }
    if (!UA.exportProvenance || typeof UA.exportProvenance.createManifest !== 'function') {
      throw new Error('Filtered export provenance requires UA.exportProvenance.createManifest');
    }
    const scoped = UA.AnalysisScope.createScopedContext(ctx);
    const generated = await UA.exportProvenance.createManifest(scoped, { UA, root: window });
    scoped.exportSourceManifest = correctManifest(generated);
    return scoped;
  }

  function wrap(original) {
    if (typeof original !== 'function' || chainContainsWrapper(original)) return original;
    const wrapped = async function exportWithFilteredManifest(ctx, ...args) {
      const scoped = await scopedContextWithManifest(ctx);
      return original.call(this, scoped, ...args);
    };
    wrapped[WRAPPED] = true;
    wrapped._original = original;
    return wrapped;
  }

  function install() {
    if (!UA.AnalysisScope || !UA.exportProvenance) return false;
    for (const name of NAMES) {
      if (typeof UA[name] === 'function') UA[name] = wrap(UA[name]);
    }
    return NAMES.every(name => typeof UA[name] !== 'function' || chainContainsWrapper(UA[name]));
  }

  UA.filteredExportProvenance = Object.freeze({
    POLICY,
    DESCRIPTION,
    correctManifest,
    scopedContextWithManifest,
    install,
  });

  const tryInstall = () => {
    try { install(); } catch (error) { window.console?.warn?.('Gefilterte Export-Provenienz konnte nicht installiert werden', error); }
  };
  tryInstall();
  const optional = UA.optionalModulePromises && UA.optionalModulePromises.analysisScope;
  if (optional && typeof optional.then === 'function') optional.then(tryInstall).catch(() => {});
  for (const delay of [0, 100, 500, 1500]) setTimeout(tryInstall, delay);
})();
