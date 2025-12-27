// --------------------------------------------------
// URL helper
// --------------------------------------------------
UA.qGet = function (key, def) {
  try {
    const v = new URL(window.location.href).searchParams.get(key);
    return (v === null || v === "") ? def : v;
  } catch (e) {
    return def;
  }
};

UA.qBool = function (key, def) {
  const v = UA.qGet(key, null);
  if (v === null) return def;
  return v === "1" || v === "true" || v === "yes";
};

UA.qNum = function (key, def) {
  const v = Number(UA.qGet(key, NaN));
  return Number.isFinite(v) ? v : def;
};