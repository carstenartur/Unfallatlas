/* js/ua.core.js */
(() => {
  // Never overwrite UA, only extend it
  const UA = (window.UA = window.UA || {});

  // --- URL helpers ---
  UA.qs = function qs() {
    return new URL(window.location.href).searchParams;
  };

  UA.qGet = function qGet(k, def) {
    const v = UA.qs().get(k);
    return (v === null || v === "") ? def : v;
  };

  UA.qBool = function qBool(k, def) {
    const v = UA.qs().get(k);
    if (v === null) return def;
    return v === "1" || v === "true" || v === "yes";
  };

  UA.qNum = function qNum(k, def) {
    const v = UA.qs().get(k);
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

  // --- tiny UI helper ---
  UA.setBtnState = function setBtnState(btn, on) {
    if (!btn) return;
    btn.classList.toggle("active", !!on);
  };

  // --- string helpers ---
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

  // --- basic assertions / diagnostics (optional but helpful) ---
  UA.assert = function assert(cond, msg) {
    if (!cond) throw new Error(msg || "Assertion failed");
  };

  UA.diag = function diag() {
    // Helpful when debugging on mobile Safari:
    // shows whether core functions exist at runtime
    return {
      hasQS: typeof UA.qs === "function",
      hasQGet: typeof UA.qGet === "function",
      hasSetBtnState: typeof UA.setBtnState === "function",
      build: UA.BUILD || ""
    };
  };
})();