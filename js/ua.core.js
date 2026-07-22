(() => {
  const UA = (window.UA = window.UA || {});

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
      const blockedExport = () => {
        const error = UA.exportProvenanceError ||
          new Error("Export ist gesperrt, bis die Quellenprovenienz geladen wurde.");
        if (typeof UA.showToast === "function") {
          UA.showToast("Export abgebrochen: Quellenprovenienz ist nicht verfügbar.");
        }
        return Promise.reject(error);
      };
      for (const name of [...dataExportNames, ...documentExportNames]) UA[name] = blockedExport;

      UA.exportProvenanceReady = UA.loadRuntimeScripts([
        moduleUrl("ua.source_manifest.js?v=2026-07-22"),
        moduleUrl("ua.artifact_provenance.js?v=2026-07-22"),
        moduleUrl("ua.zip.js?v=2026-07-22"),
        moduleUrl("ua.export_provenance.js?v=2026-07-22"),
        moduleUrl("ua.kml_export_provenance.js?v=2026-07-22"),
        moduleUrl("ua.document_export_provenance.js?v=2026-07-22"),
      ]).catch((error) => {
        UA.exportProvenanceError = error;
        console.error("Export-Provenienz konnte nicht initialisiert werden", error);
        return null;
      });
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", startExportProvenance, { once: true });
    } else {
      startExportProvenance();
    }
  }
})();
