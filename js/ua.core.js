(() => {
  const UA = (window.UA = window.UA || {});

  // ua.core.js is the first application module in the parser-ordered stack.
  // Install the recovery guard here, before later critical modules such as
  // ua.map_v2.js are requested. Eval-based unit tests have no currentScript and
  // therefore remain hermetic.
  const parserCoreScript = typeof document !== "undefined" ? document.currentScript : null;
  if (
    parserCoreScript
    && parserCoreScript.src
    && document.readyState === "loading"
    && typeof document.write === "function"
    && !window.__UA_CRITICAL_RUNTIME_ERROR_HANDLER__
  ) {
    const recoveryUrl = new URL("ua.critical-runtime-recovery.js?v=1", parserCoreScript.src).href
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "%3C");
    document.write(`<script src="${recoveryUrl}"><\/script>`);
  }

  // ---- Core build info (optional) ----
  UA.BUILD = UA.BUILD || "";

  // ---- URL helpers ----
  UA.qs = function qs() {
    return new URL(window.location.href).searchParams;
  };

  UA.qGet = function qGet(k, defVal) {
    const v = UA.qs().get(k);
    return (v === null || v === "") ? defVal : v;
  };

  UA.qBool = function qBool(k, defVal) {
    const v = UA.qs().get(k);
    if (v === null) return defVal;
    return v === "1" || v === "true" || v === "yes";
  };

  UA.qNum = function qNum(k, defVal) {
    const v = UA.qs().get(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : defVal;
  };

  UA.setQS = function setQS(updates, replace = false) {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(updates || {})) {
      if (v === null || v === undefined || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, String(v));
    }
    if (replace) window.location.replace(u.toString());
    else history.replaceState(null, "", u.toString());
    return u.toString();
  };

  // ---- small DOM helpers ----
  UA.setBtnState = function setBtnState(btn, on) {
    if (!btn) return;
    const pressed = !!on;
    btn.classList.toggle("active", pressed);
    if (typeof btn.setAttribute === "function") {
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  };

  UA.escHtml = function escHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  };

  UA.normKey = function normKey(s) {
    return String(s ?? "")
      .toLowerCase()
      .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_/, "")
      .replace(/_$/, "");
  };

  // ---- optional runtime module chains ----
  // Parser-loaded modules remain explicit in werkbank_v2.html. Small optional
  // stacks may register here so tests that eval the source do not trigger
  // network requests, while the built browser app loads them deterministically.
  UA.loadRuntimeScripts = function loadRuntimeScripts(urls) {
    return (urls || []).reduce((promise, url) => promise.then(() => new Promise((resolve, reject) => {
      const existing = Array.from(document.querySelectorAll("script[data-ua-runtime-module]"))
        .find((candidate) => candidate.dataset.uaRuntimeModule === url);
      if (existing) {
        if (existing.dataset.loaded === "true") resolve();
        else {
          existing.addEventListener("load", resolve, { once: true });
          existing.addEventListener("error", () => reject(new Error(`Runtime module failed: ${url}`)), { once: true });
        }
        return;
      }
      const script = document.createElement("script");
      script.src = url;
      script.async = false;
      script.dataset.uaRuntimeModule = url;
      script.addEventListener("load", () => {
        script.dataset.loaded = "true";
        resolve();
      }, { once: true });
      script.addEventListener("error", () => reject(new Error(`Runtime module failed: ${url}`)), { once: true });
      document.head.appendChild(script);
    })), Promise.resolve());
  };

  // Parser order must not decide whether optional task dialogs and document
  // exports are usable. Install assignment slots before their modules load, so
  // every later init function is idempotent and report buttons wait for the
  // fail-closed provenance adapter before capturing an exporter.
  function initOnceWrapper(owner, candidate, markerId) {
    if (typeof candidate !== "function") return candidate;
    if (candidate._uaInitOnce === true) return candidate;
    const wrapped = function initializeOnce(ctx) {
      const marker = document.getElementById(markerId);
      if (marker && marker.dataset.uaInitialized === "true") return undefined;
      if (marker) marker.dataset.uaInitialized = "true";
      try {
        return candidate.call(owner, ctx);
      } catch (error) {
        if (marker) delete marker.dataset.uaInitialized;
        throw error;
      }
    };
    wrapped._uaInitOnce = true;
    return wrapped;
  }

  function installFeatureInitSlot(namespace, markerId) {
    const owner = (UA[namespace] = UA[namespace] || {});
    let value = initOnceWrapper(owner, owner.init, markerId);
    Object.defineProperty(owner, "init", {
      configurable: true,
      enumerable: true,
      get() { return value; },
      set(candidate) { value = initOnceWrapper(owner, candidate, markerId); },
    });
  }

  installFeatureInitSlot("PoliticalContext", "btnPolCtxOpen");
  installFeatureInitSlot("Priorities", "btnPrioritiesOpen");

  let reportInitializer = UA.initReportExportUI;
  function wrapReportInitializer(candidate) {
    if (typeof candidate !== "function") return candidate;
    if (candidate._uaProvenanceDeferred === true) return candidate;
    const wrapped = function initializeReportExportAfterProvenance(ctx) {
      const marker = document.getElementById("btnExportWord") ||
        document.getElementById("btnExportPDF");
      const bind = () => {
        if (marker && marker.dataset.uaInitialized === "true") return undefined;
        if (marker) marker.dataset.uaInitialized = "true";
        try {
          return candidate.call(UA, ctx);
        } catch (error) {
          if (marker) delete marker.dataset.uaInitialized;
          throw error;
        }
      };
      const waitForReady = () => {
        const ready = UA.exportProvenanceReady;
        if (ready && typeof ready.then === "function") {
          return Promise.resolve(ready).then(bind, bind);
        }
        return bind();
      };
      if (document.readyState === "loading" && !UA.exportProvenanceReady) {
        return new Promise((resolve) => {
          document.addEventListener("DOMContentLoaded", () => resolve(waitForReady()), { once: true });
        });
      }
      return waitForReady();
    };
    wrapped._uaProvenanceDeferred = true;
    return wrapped;
  }
  Object.defineProperty(UA, "initReportExportUI", {
    configurable: true,
    enumerable: true,
    get() { return reportInitializer; },
    set(candidate) { reportInitializer = wrapReportInitializer(candidate); },
  });
  if (reportInitializer) UA.initReportExportUI = reportInitializer;

  function initializeDeferredUi(attempt = 0) {
    const ctx = typeof UA.getRuntimeContext === "function" ? UA.getRuntimeContext() : null;
    if (!ctx) {
      if (attempt < 50) setTimeout(() => initializeDeferredUi(attempt + 1), 0);
      return;
    }
    if (UA.PoliticalContext && typeof UA.PoliticalContext.init === "function") {
      UA.PoliticalContext.init(ctx);
    }
    if (UA.Priorities && typeof UA.Priorities.init === "function") {
      UA.Priorities.init(ctx);
    }
    if (typeof UA.initReportExportUI === "function") {
      UA.initReportExportUI(ctx);
    }
  }

  const ownScript = typeof document !== "undefined" ? document.currentScript : null;
  if (ownScript && ownScript.src) {
    const moduleUrl = (name) => new URL(name, ownScript.src).toString();
    const startExportProvenance = () => {
      const dataExportNames = ["exportToCSV", "exportToGeoJSON", "exportToKML"];
      const documentExportNames = ["exportToWord", "exportToPDF"];
      const originalsFor = (names) => Object.fromEntries(
        names
          .filter((name) => typeof UA[name] === "function")
          .map((name) => [name, UA[name]]),
      );
      // The data integration consumes and deletes its staging object before the
      // document integration is loaded. Keep the two ownership boundaries
      // separate so neither module can accidentally erase the other's originals.
      UA.__exportProvenanceOriginals = originalsFor(dataExportNames);
      UA.__documentProvenanceOriginals = originalsFor(documentExportNames);

      // Report-button handlers may capture an exporter while the optional
      // provenance stack is still loading. A plain rejecting placeholder would
      // remain captured forever even after UA.exportToWord/UA.exportToPDF had
      // been replaced. This proxy waits for readiness and then delegates to the
      // current provenanced function. If initialization fails or no replacement
      // is installed, it still fails closed.
      const blockedExportFor = (name) => {
        const proxy = function exportAfterProvenanceReady(...args) {
          const ready = UA.exportProvenanceReady;
          const failure = () => {
            const error = UA.exportProvenanceError ||
              new Error("Export ist gesperrt, bis die Quellenprovenienz geladen wurde.");
            if (typeof UA.showToast === "function") {
              UA.showToast("Export abgebrochen: Quellenprovenienz ist nicht verfügbar.");
            }
            throw error;
          };
          if (!ready || typeof ready.then !== "function") {
            return Promise.resolve().then(failure);
          }
          return ready.then(() => {
            const current = UA[name];
            if (typeof current === "function" && current !== proxy) {
              return current.apply(UA, args);
            }
            return failure();
          });
        };
        return proxy;
      };
      for (const name of [...dataExportNames, ...documentExportNames]) {
        UA[name] = blockedExportFor(name);
      }

      // Load the core manifest stack first. The document adapter must own the
      // Word/PDF boundary before pagination and link adapters install; relying
      // only on script side effects made that ordering timing-dependent in real
      // browsers even though every script returned HTTP 200.
      const coreModules = [
        moduleUrl("ua.source_manifest.js?v=2026-07-22"),
        moduleUrl("ua.artifact_provenance.js?v=2026-07-22"),
        moduleUrl("ua.zip.js?v=2026-07-22"),
        moduleUrl("ua.export_provenance.js?v=2026-07-22"),
        moduleUrl("ua.accident_year_provenance.js?v=2026-07-23"),
        moduleUrl("ua.kml_export_provenance.js?v=2026-07-22"),
        moduleUrl("ua.document_export_provenance.js?v=2026-07-22"),
      ];
      const documentAdapters = [
        moduleUrl("ua.document_export_prewarm.js?v=2026-07-22"),
        moduleUrl("ua.docx_source_links.js?v=2026-07-23"),
        moduleUrl("ua.docx_pagination.js?v=2026-07-23"),
        moduleUrl("ua.static_map_export_provenance.js?v=2026-07-23"),
        moduleUrl("ua.filtered_export_provenance.js?v=2026-07-23"),
      ];

      UA.exportProvenanceReady = UA.loadRuntimeScripts(coreModules)
        .then(() => {
          if (!UA.documentExportProvenance ||
              typeof UA.documentExportProvenance.install !== "function") {
            throw new Error("Document export provenance integration is unavailable");
          }
          // install() is idempotent. Calling it explicitly closes the race in
          // which its script executed before the data-export runtime published
          // the dependency that the module's optional auto-install checks.
          UA.documentExportProvenance.install(UA, window);
          return UA.loadRuntimeScripts(documentAdapters);
        })
        .catch((error) => {
          UA.exportProvenanceError = error;
          console.error("Export-Provenienz konnte nicht initialisiert werden", error);
          return null;
        });
    };
    const startRuntime = () => {
      startExportProvenance();
      initializeDeferredUi();
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startRuntime, { once: true });
    } else {
      startRuntime();
    }
  }
})();