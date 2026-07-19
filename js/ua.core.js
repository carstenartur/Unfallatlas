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
})();
