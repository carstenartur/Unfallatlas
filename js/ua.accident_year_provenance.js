/**
 * Adapts the accident-data year vocabulary at the provenance boundary.
 *
 * Unfallatlas source files and deterministic fixtures may expose the accident
 * year as `ujahr`/`UJAHR`, while newer normalized rows use `year`. The shared
 * SourceManifest must consume both without treating a missing value as year 0
 * (`Number(null) === 0`). This module keeps that compatibility concern outside
 * individual renderers and makes every live export use the same adapted context.
 */
(function initAccidentYearProvenance(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.accidentYearProvenance = api;
    if (UA.exportProvenanceRuntime) api.install(UA, root);
  }
})(typeof window !== "undefined" ? window : null, function createAccidentYearProvenanceApi() {
  "use strict";

  const UNKNOWN_YEAR_SENTINEL = "__unknown_accident_year__";
  const YEAR_KEYS = Object.freeze([
    "year",
    "ujahr",
    "UJAHR",
    "uJahr",
    "jahr",
    "Jahr",
  ]);

  class AccidentYearProvenanceError extends Error {
    constructor(code, message, details) {
      super(`${code}: ${message}`);
      this.name = "AccidentYearProvenanceError";
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new AccidentYearProvenanceError(code, message, details);
  }

  function normalizedYear(value) {
    if (value == null) return null;
    if (typeof value === "string" && !value.trim()) return null;
    const number = Number(value);
    return Number.isInteger(number) && number >= 1900 && number <= 2100
      ? number
      : null;
  }

  function accidentYear(properties) {
    const props = properties || {};
    for (const key of YEAR_KEYS) {
      const year = normalizedYear(props[key]);
      if (year != null) return year;
    }
    return null;
  }

  function adaptPoint(point) {
    if (!point || typeof point !== "object" || !point.props || typeof point.props !== "object") {
      return point;
    }
    const year = accidentYear(point.props);
    const current = normalizedYear(point.props.year);
    if (year != null && current === year) return point;
    const nextYear = year == null ? UNKNOWN_YEAR_SENTINEL : year;
    return {
      ...point,
      props: {
        ...point.props,
        year: nextYear,
      },
    };
  }

  const contexts = new WeakMap();

  function adaptContext(ctx) {
    if (!ctx || typeof ctx !== "object") {
      fail("invalid_context", "export provenance requires a context object");
    }
    if (ctx.exportSourceManifest) return ctx;
    const sourcePoints = Array.isArray(ctx.allPts) ? ctx.allPts : [];
    const cached = contexts.get(ctx);
    if (cached && cached.sourcePoints === sourcePoints) return cached.context;

    let changed = false;
    const adaptedPoints = sourcePoints.map((point) => {
      const adapted = adaptPoint(point);
      if (adapted !== point) changed = true;
      return adapted;
    });
    if (!changed) {
      contexts.set(ctx, { sourcePoints, context: ctx });
      return ctx;
    }

    // Prototype delegation keeps mutable runtime state (filters, map, selection,
    // retrieval timestamps) live while owning only the schema-adapted point list.
    const adapted = Object.create(ctx);
    Object.defineProperty(adapted, "allPts", {
      value: adaptedPoints,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    contexts.set(ctx, { sourcePoints, context: adapted });
    return adapted;
  }

  async function withBoundManifest(ctx, createManifest, exporter, UA, root, args) {
    if (!ctx || typeof ctx !== "object" || ctx.exportSourceManifest) {
      return exporter.call(UA, ctx, ...args);
    }
    const manifest = await createManifest(ctx, { UA, root });
    const hadOwn = Object.prototype.hasOwnProperty.call(ctx, "exportSourceManifest");
    const previous = ctx.exportSourceManifest;
    ctx.exportSourceManifest = manifest;
    try {
      return await exporter.call(UA, ctx, ...args);
    } finally {
      if (hadOwn) ctx.exportSourceManifest = previous;
      else delete ctx.exportSourceManifest;
    }
  }

  function install(UA, root) {
    if (!UA || !root) fail("invalid_environment", "Browser UA and window are required");
    if (UA.__accidentYearProvenanceInstalled) return UA.accidentYearProvenanceRuntime;

    const baseRuntime = UA.exportProvenanceRuntime;
    if (!baseRuntime || typeof baseRuntime.createManifest !== "function") {
      fail("missing_runtime", "UA.exportProvenanceRuntime.createManifest is unavailable");
    }
    const baseCreateManifest = baseRuntime.createManifest;
    const createManifest = (ctx, environment = {}) =>
      baseCreateManifest(adaptContext(ctx), {
        UA: environment.UA || UA,
        root: environment.root || root,
      });

    const dataExporters = {
      csv: UA.exportToCSV,
      geojson: UA.exportToGeoJSON,
    };
    if (typeof dataExporters.csv !== "function" || typeof dataExporters.geojson !== "function") {
      fail("missing_exporter", "CSV and GeoJSON provenance exporters are required");
    }

    UA.exportProvenanceRuntime = Object.freeze({
      ...baseRuntime,
      createManifest,
    });
    if (UA.exportProvenance) {
      UA.exportProvenance = Object.freeze({
        ...UA.exportProvenance,
        createManifest,
        normalizedYear,
        accidentYear,
        adaptContext,
      });
    }

    UA.exportToCSV = function exportCsvWithNormalizedAccidentYear(ctx, ...args) {
      return withBoundManifest(ctx, createManifest, dataExporters.csv, UA, root, args);
    };
    UA.exportToGeoJSON = function exportGeoJsonWithNormalizedAccidentYear(ctx, ...args) {
      return withBoundManifest(ctx, createManifest, dataExporters.geojson, UA, root, args);
    };

    UA.__accidentYearProvenanceInstalled = true;
    UA.accidentYearProvenanceRuntime = Object.freeze({
      baseRuntime,
      dataExporters,
      createManifest,
      normalizedYear,
      accidentYear,
      adaptPoint,
      adaptContext,
    });
    return UA.accidentYearProvenanceRuntime;
  }

  return Object.freeze({
    UNKNOWN_YEAR_SENTINEL,
    YEAR_KEYS,
    AccidentYearProvenanceError,
    normalizedYear,
    accidentYear,
    adaptPoint,
    adaptContext,
    install,
  });
});
