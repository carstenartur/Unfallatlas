/* ua.core.js
 * Core-Helfer + globaler UA-Namespace
 * Muss VOR allen anderen ua.* Modulen geladen werden.
 */
(function () {
  'use strict';

  // Global Namespace
  const UA = (window.UA = window.UA || {});

  // --- Basic helpers ---------------------------------------------------------

  UA.normKey = function normKey(s) {
    return String(s ?? "")
      .toLowerCase()
      .replaceAll("ä", "ae").replaceAll("ö", "oe").replaceAll("ü", "ue").replaceAll("ß", "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_/, "")
      .replace(/_$/, "");
  };

  UA.escHtml = function escHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  };

  UA.qs = function qs() {
    return new URL(window.location.href).searchParams;
  };

  UA.qGet = function qGet(k, def) {
    try {
      const v = UA.qs().get(k);
      return (v === null || v === "") ? def : v;
    } catch (e) {
      return def;
    }
  };

  UA.qBool = function qBool(k, def) {
    const v = UA.qGet(k, null);
    if (v === null) return def;
    return v === "1" || v === "true" || v === "yes";
  };

  UA.qNum = function qNum(k, def) {
    const v = UA.qGet(k, null);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : def;
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

  // Optional: defensive assert helper (useful in modules)
  UA.assert = function assert(cond, msg) {
    if (!cond) throw new Error(msg || "UA.assert failed");
  };

  // Optional: tiny logger
  UA.log = function log(...args) {
    // keep quiet by default; enable by setting UA_DEBUG=1 in console
    try {
      if (window.UA_DEBUG) console.log("[UA]", ...args);
    } catch {}
  };

})();