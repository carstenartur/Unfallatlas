/* ua.core.js
 * Zentrale Basis-Utilities für die Unfallwerkbank
 * DARF UA NIE überschreiben
 */
(() => {
  const UA = (window.UA = window.UA || {});

  /* =========================
   * URL / Query Helpers
   * ========================= */

  UA.qs = function () {
    return new URLSearchParams(window.location.search);
  };

  UA.qGet = function (key, def = null) {
    const v = UA.qs().get(key);
    return v === null || v === "" ? def : v;
  };

  UA.qNum = function (key, def = null) {
    const v = UA.qGet(key, null);
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };

  UA.qBool = function (key, def = false) {
    const v = UA.qGet(key, null);
    if (v === null) return def;
    return v === "1" || v === "true" || v === "yes";
  };

  UA.setQS = function (updates = {}) {
    const url = new URL(window.location.href);
    for (const [k, v] of Object.entries(updates)) {
      if (v === null || v === undefined || v === "") {
        url.searchParams.delete(k);
      } else {
        url.searchParams.set(k, String(v));
      }
    }
    history.replaceState(null, "", url.toString());
    return url.toString();
  };

  /* =========================
   * DOM Helpers
   * ========================= */

  UA.q = function (sel, root = document) {
    return root.querySelector(sel);
  };

  UA.qa = function (sel, root = document) {
    return Array.from(root.querySelectorAll(sel));
  };

  UA.setBtnState = function (btn, on) {
    if (!btn) return;
    btn.classList.toggle("active", !!on);
  };

  /* =========================
   * String / Key Helpers
   * ========================= */

  UA.normKey = function (s) {
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

})();