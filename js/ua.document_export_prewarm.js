/**
 * Pre-computes the document SourceManifest while the export preview is open.
 *
 * Document exports otherwise have to fingerprint and sort every exported
 * accident point only after the PDF/DOCX button is clicked. On constrained
 * Docker runners that work can consume most of the browser download budget.
 * This integration starts the same snapshot at the export-dialog boundary and
 * passes the exact resulting manifest into the final renderer. No provenance is
 * skipped and no second source model is introduced.
 */
(function initDocumentExportPrewarm(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    const UA = (root.UA = root.UA || {});
    UA.documentExportPrewarm = api;
    if (UA.documentExportProvenanceRuntime) api.install(UA, root);
  }
})(typeof window !== "undefined" ? window : null, function createDocumentExportPrewarmApi() {
  "use strict";

  const arrayIds = new WeakMap();
  let nextArrayId = 1;

  class DocumentExportPrewarmError extends Error {
    constructor(code, message, details) {
      super(`${code}: ${message}`);
      this.name = "DocumentExportPrewarmError";
      this.code = code;
      this.details = details || null;
    }
  }

  function fail(code, message, details) {
    throw new DocumentExportPrewarmError(code, message, details);
  }

  function objectId(value) {
    if (!value || (typeof value !== "object" && typeof value !== "function")) return "none";
    if (!arrayIds.has(value)) arrayIds.set(value, nextArrayId++);
    return arrayIds.get(value);
  }

  function finite(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function boundsValue(ctx, UA) {
    const normalized = typeof UA?.exportProvenance?.boundsObject === "function"
      ? UA.exportProvenance.boundsObject(ctx)
      : null;
    if (normalized) return normalized;
    const bounds = ctx?.selectionBounds || ctx?.map?.getBounds?.();
    if (!bounds) return null;
    const south = finite(bounds.getSouth?.() ?? bounds.south);
    const west = finite(bounds.getWest?.() ?? bounds.west);
    const north = finite(bounds.getNorth?.() ?? bounds.north);
    const east = finite(bounds.getEast?.() ?? bounds.east);
    return [south, west, north, east].every(value => value != null)
      ? { south, west, north, east }
      : null;
  }

  function filtersValue(ctx, UA) {
    if (typeof UA?.exportProvenance?.scenarioFilters === "function") {
      return UA.exportProvenance.scenarioFilters(ctx);
    }
    const ui = ctx?.ui || {};
    return {
      severity: ui.severityEl?.value ?? null,
      roadCondition: ui.roadConditionEl?.value ?? null,
      dayType: ui.dayTypeEl?.value ?? null,
      hourFrom: ui.hFromEl?.value ?? null,
      hourTo: ui.hToEl?.value ?? null,
      involvementMode: ctx?.involvementMode ?? null,
      contextSlopeClasses: Array.from(ctx?.contextFilters?.slopeClasses || []).sort(),
      contextTrafficClasses: Array.from(ctx?.contextFilters?.trafficClasses || []).sort(),
      onlyMatchedWays: ctx?.contextFilters?.onlyMatchedWays === true,
    };
  }

  function stateSignature(ctx, UA) {
    if (!ctx || typeof ctx !== "object") fail("invalid_context", "document export context is required");
    const points = ctx.allPts || null;
    return JSON.stringify({
      city: String(ctx.CITY_RAW || ""),
      pointArray: objectId(points),
      pointCount: Array.isArray(points) ? points.length : 0,
      dataRetrievedAt: ctx.accidentDataRetrievedAt || ctx.dataRetrievedAt || null,
      bounds: boundsValue(ctx, UA),
      filters: filtersValue(ctx, UA),
    });
  }

  function install(UA, root) {
    if (!UA || !root) fail("invalid_environment", "Browser UA and window are required");
    if (UA.__documentExportPrewarmInstalled) return UA.documentExportPrewarmRuntime;
    const provenanceRuntime = UA.documentExportProvenanceRuntime;
    if (!provenanceRuntime || typeof provenanceRuntime.createSnapshot !== "function") {
      fail("missing_document_runtime", "document provenance runtime is unavailable");
    }
    const originals = {
      word: UA.exportToWord,
      pdf: UA.exportToPDF,
    };
    if (typeof originals.word !== "function" || typeof originals.pdf !== "function") {
      fail("missing_document_exporter", "PDF and DOCX exporters are required");
    }

    const cache = new WeakMap();
    function prewarm(ctx) {
      const signature = stateSignature(ctx, UA);
      const cached = cache.get(ctx);
      if (cached && cached.signature === signature) return cached.promise;
      const promise = Promise.resolve()
        .then(() => provenanceRuntime.createSnapshot(ctx))
        .then(snapshot => {
          if (stateSignature(ctx, UA) !== signature) {
            cache.delete(ctx);
            return prewarm(ctx);
          }
          return snapshot;
        })
        .catch(error => {
          const current = cache.get(ctx);
          if (current && current.promise === promise) cache.delete(ctx);
          throw error;
        });
      cache.set(ctx, { signature, promise });
      return promise;
    }

    let queue = Promise.resolve();
    const serialize = task => {
      const run = queue.then(task, task);
      queue = run.catch(() => undefined);
      return run;
    };

    function exportWithPrewarmedManifest(original, ctx, args) {
      return serialize(async () => {
        if (!ctx || typeof ctx !== "object" || ctx.exportSourceManifest) {
          return original.call(UA, ctx, ...args);
        }
        const snapshot = await prewarm(ctx);
        const hadOwn = Object.prototype.hasOwnProperty.call(ctx, "exportSourceManifest");
        const previous = ctx.exportSourceManifest;
        ctx.exportSourceManifest = snapshot.manifest;
        try {
          return await original.call(UA, ctx, ...args);
        } finally {
          if (hadOwn) ctx.exportSourceManifest = previous;
          else delete ctx.exportSourceManifest;
        }
      });
    }

    UA.exportToWord = function exportWordWithPrewarmedManifest(ctx, ...args) {
      return exportWithPrewarmedManifest(originals.word, ctx, args);
    };
    UA.exportToPDF = function exportPdfWithPrewarmedManifest(ctx, ...args) {
      return exportWithPrewarmedManifest(originals.pdf, ctx, args);
    };

    const openButton = root.document?.getElementById?.("btnOpenExport");
    if (openButton?.addEventListener) {
      openButton.addEventListener("click", () => {
        const ctx = typeof UA.getRuntimeContext === "function" ? UA.getRuntimeContext() : null;
        if (!ctx) return;
        prewarm(ctx).catch(error => {
          root.console?.warn?.("Dokument-Provenienz konnte nicht vorab erzeugt werden", error);
        });
      }, { capture: true });
    }

    UA.__documentExportPrewarmInstalled = true;
    UA.documentExportPrewarmRuntime = Object.freeze({
      originals,
      prewarm,
      stateSignature: ctx => stateSignature(ctx, UA),
    });
    return UA.documentExportPrewarmRuntime;
  }

  return Object.freeze({
    DocumentExportPrewarmError,
    stateSignature,
    install,
  });
});
