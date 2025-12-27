/* js/ua.core.js
 * Basis-Helfer + globaler Namespace "UA"
 * Muss als ERSTES geladen werden!
 */
(() => {
  // IMPORTANT: niemals UA überschreiben, immer "merge"
  const UA = (window.UA = window.UA || {});

  // --- kleine Utilities
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
      .replaceAll("ä", "ae")
      .replaceAll("ö", "oe")
      .replaceAll("ü", "ue")
      .replaceAll("ß", "ss")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_/, "")
      .replace(/_$/, "");
  };

  // --- Querystring helpers
  function _qs() {
    return new URL(window.location.href).searchParams;
  }

  UA.qGet = function qGet(k, def) {
    const v = _qs().get(k);
    return v === null || v === "" ? def : v;
  };

  UA.qBool = function qBool(k, def) {
    const v = _qs().get(k);
    if (v === null) return def;
    return v === "1" || v === "true" || v === "yes";
  };

  UA.qNum = function qNum(k, def) {
    const v = _qs().get(k);
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

  // --- UI helper
  UA.setBtnState = function setBtnState(btn, on) {
    if (!btn) return;
    btn.classList.toggle("active", !!on);
  };

  // --- Debug marker (hilft beim Prüfen, ob core wirklich geladen ist)
  UA.__coreLoaded = true;
})();