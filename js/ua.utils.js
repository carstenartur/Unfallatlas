(() => {
  const UA = (window.UA = window.UA || {});

  UA.qs = () => new URL(window.location.href).searchParams;
  UA.qGet = (k, def) => {
    const v = UA.qs().get(k);
    return (v === null || v === "") ? def : v;
  };
  UA.qBool = (k, def) => {
    const v = UA.qs().get(k);
    if (v === null) return def;
    return v === "1" || v === "true" || v === "yes";
  };
  UA.qNum = (k, def) => {
    const v = UA.qs().get(k);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : def;
  };

  UA.setQS = (updates, replace=false) => {
    const u = new URL(window.location.href);
    for (const [k,v] of Object.entries(updates)) {
      if (v === null || v === undefined || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, String(v));
    }
    if (replace) window.location.replace(u.toString());
    else history.replaceState(null, "", u.toString());
    return u.toString();
  };

  UA.escHtml = (s) => String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;");

  UA.normKey = (s) => String(s ?? "")
    .toLowerCase()
    .replaceAll("ä","ae").replaceAll("ö","oe").replaceAll("ü","ue").replaceAll("ß","ss")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_/, "")
    .replace(/_$/, "");

  UA.setBtnState = (btn, on) => btn.classList.toggle("active", !!on);

  UA.WEEKEND_SET = new Set(["1","7"]);
})();