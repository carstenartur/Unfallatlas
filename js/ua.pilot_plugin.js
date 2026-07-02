/**
 * ua.pilot_plugin.js — Accident-Statistics pilot plugin.
 *
 * Demonstrates the AnalysisPipeline plugin contract by wrapping a small,
 * deterministic accident-statistics analysis as a first-class plugin.
 *
 * Produces an `accidentStatistics` artifact with total count and a severity
 * breakdown derived from the `accidents` data-registry entry (GeoJSON
 * FeatureCollection or raw points array).  Viewport data is used optionally
 * to annotate the result with the current map context.
 *
 * This plugin does NOT change any existing UI behaviour: it is purely additive
 * and is never wired into the existing export / report pipeline.
 *
 * Usage (standalone):
 *   const registry = UA.AnalysisPipeline.createPluginRegistry([
 *     UA.PilotPlugin.ACCIDENT_STATISTICS
 *   ]);
 *   const result = await UA.AnalysisPipeline.runPipeline({ trafficSituation, pluginRegistry: registry });
 */
(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  // Severity bucket keys as they appear on accident GeoJSON feature properties.
  const SEVERITY_KEYS = Object.freeze({
    FATAL:    'fatal',
    SERIOUS:  'serious',
    SLIGHT:   'slight',
    UNKNOWN:  'unknown'
  });

  /**
   * Derive a normalised severity label from a feature's properties.
   * Accepts the most common field names found in the Unfallatlas dataset.
   *
   * @param {object} props  Feature properties object (may be null/undefined).
   * @returns {string}  One of SEVERITY_KEYS values.
   */
  function _severityOf(props) {
    if (!props) return SEVERITY_KEYS.UNKNOWN;
    const raw = (props.UKATEGORIE || props.severity || props.unfallkat || '');
    switch (String(raw).trim()) {
      case '1': case 'fatal':   case 'getötet':  return SEVERITY_KEYS.FATAL;
      case '2': case 'serious': case 'schwer':   return SEVERITY_KEYS.SERIOUS;
      case '3': case 'slight':  case 'leicht':   return SEVERITY_KEYS.SLIGHT;
      default:                                    return SEVERITY_KEYS.UNKNOWN;
    }
  }

  /**
   * Compute accident statistics from raw accident data.
   * Accepts a GeoJSON FeatureCollection, an array of features/points,
   * or an object with a `features` or `clusters` array.
   *
   * @param {*} data  Raw accidents data from the DataRegistry.
   * @returns {{ total: number, bySeverity: object }}
   */
  function computeAccidentStatistics(data) {
    const bySeverity = {
      [SEVERITY_KEYS.FATAL]:   0,
      [SEVERITY_KEYS.SERIOUS]: 0,
      [SEVERITY_KEYS.SLIGHT]:  0,
      [SEVERITY_KEYS.UNKNOWN]: 0
    };

    let features = [];
    if (Array.isArray(data)) {
      features = data;
    } else if (data && typeof data === 'object') {
      if (Array.isArray(data.features)) {
        features = data.features;
      } else if (Array.isArray(data.clusters)) {
        // Cluster-based data: use provided total or cluster length only.
        const total = typeof data.total === 'number'
          ? data.total
          : data.clusters.reduce((s, c) => s + (typeof c.count === 'number' ? c.count : 1), 0);
        return { total, bySeverity };
      }
    }

    features.forEach((feature) => {
      const props = feature && (feature.properties || feature);
      const sev = _severityOf(props);
      bySeverity[sev] = (bySeverity[sev] || 0) + 1;
    });

    const total = Object.values(bySeverity).reduce((s, n) => s + n, 0);
    return { total, bySeverity };
  }

  /**
   * Accident Statistics pilot plugin definition.
   *
   * Required data:   accidents
   * Optional data:   viewport
   * Produced:        accidentStatistics
   */
  const ACCIDENT_STATISTICS = Object.freeze({
    id:                  'accident-statistics',
    name:                'Accident Statistics',
    description:         'Computes total accident count and severity breakdown from accident data.',
    requiredData:        ['accidents'],
    optionalData:        ['viewport'],
    requiredCapabilities: ['hasAccidentData'],
    optionalCapabilities: ['hasViewport'],
    producedArtifacts:   ['accidentStatistics'],
    supportsPartialData: true,

    run: function run(ctx) {
      const accidentData = ctx.getData('accidents');
      const stats = computeAccidentStatistics(accidentData);

      const result = {
        total:       stats.total,
        bySeverity:  stats.bySeverity
      };

      if (ctx.hasData('viewport')) {
        result.viewport = ctx.getData('viewport');
      }

      return {
        producedArtifacts: { accidentStatistics: result },
        confidence: stats.total > 0 ? 1 : 0.5
      };
    }
  });

  UA.PilotPlugin = {
    SEVERITY_KEYS:              SEVERITY_KEYS,
    computeAccidentStatistics:  computeAccidentStatistics,
    ACCIDENT_STATISTICS:        ACCIDENT_STATISTICS
  };

})();
