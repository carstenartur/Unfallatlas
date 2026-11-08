/* Explicit, geometry-bound names for the investigation area. */
(() => {
  'use strict';
  const UA = window.UA = window.UA || {};
  const clean = value => String(value || '').trim().slice(0, 240);
  const hydrating = () => UA.isHydrating?.() === true;
  const rounded = values => values.map(value => Number(Number(value).toFixed(6)));
  function geometryKey(ctx) {
    // URL serialization uses six decimals. Match that precision, including
    // freshly drawn bounds whose in-memory coordinates have more precision.
    const q = new URL(window.location.href).searchParams;
    const values = ['selSouth', 'selWest', 'selNorth', 'selEast'].map(k => q.has(k) ? Number(q.get(k)) : NaN);
    if (!ctx.selectionBounds && (hydrating() || !ctx.map) && values.every(Number.isFinite)) return JSON.stringify([ctx.CITY_RAW, ...rounded(values)]);
    const b = ctx.selectionBounds || ctx.map?.getBounds?.();
    if (!b) return '';
    return JSON.stringify([ctx.CITY_RAW, ...rounded([b.getSouth(), b.getWest(), b.getNorth(), b.getEast()])]);
  }
  const terms = value => [...new Set(String(value || '').split(/[,;\n]+/).map(clean).filter(Boolean))].slice(0, 6);
  function clear(ctx, changed = false) {
    delete ctx.areaNameOverride;
    delete ctx.confirmedAreaName;
    delete ctx.confirmedAreaSearchTerms;
    delete ctx._confirmedAreaGeometry;
    delete ctx._pendingAreaConfirmation;
    const q = new URL(window.location.href).searchParams;
    // UA.setQS suppresses writes during hydration; flush an invalid old name
    // once the actual view is ready, before its URL is published.
    ctx._areaNameNeedsUrlClear = hydrating() && ['areaName', 'areaSearchTerms', 'areaNameGeometry'].some(k => q.has(k));
    UA.setQS({ areaName: null, areaSearchTerms: null, areaNameGeometry: null });
    const status = document.getElementById('areaNameStatus');
    if (status) status.textContent = changed ? 'Bereich geändert oder Bestätigung nicht gebunden: Namen bitte erneut bestätigen.' : 'Kein Name bestätigt. Der Bericht verwendet neutrale Auswahlgrenzen.';
  }
  function validBinding(binding, ctx) {
    try {
      const value = JSON.parse(binding);
      return Array.isArray(value) && value.length === 5 && value[0] === ctx.CITY_RAW
        && value.slice(1).every(Number.isFinite) && value[1] < value[3] && value[2] < value[4];
    } catch (_) { return false; }
  }
  function reconcile(ctx) {
    if (ctx._pendingAreaConfirmation) {
      if (hydrating()) return false;
      const pending = ctx._pendingAreaConfirmation;
      if (pending.geometry !== geometryKey(ctx)) clear(ctx, true);
      else setConfirmed(ctx, pending.name, pending.searchTerms);
    }
    if (ctx._areaNameNeedsUrlClear) {
      if (hydrating()) return false;
      clear(ctx, true);
    }
    if (ctx._confirmedAreaGeometry && ctx._confirmedAreaGeometry !== geometryKey(ctx)) clear(ctx, true);
    return true;
  }
  function setConfirmed(ctx, name, searchTerms) {
    installPolitical();
    delete ctx._pendingAreaConfirmation;
    delete ctx._areaNameNeedsUrlClear;
    ctx.areaNameOverride = name;
    ctx.confirmedAreaSearchTerms = searchTerms;
    ctx._confirmedAreaGeometry = geometryKey(ctx);
    UA.setQS({ areaName: name, areaSearchTerms: searchTerms.join(';') || null, areaNameGeometry: ctx._confirmedAreaGeometry });
    const status = document.getElementById('areaNameStatus');
    if (status) status.textContent = `Bereichsname bestätigt: ${name}. Bestätigung gilt für diese Auswahlgrenzen.`;
  }
  function installPolitical() {
    const political = UA.PoliticalContext;
    if (typeof political?.buildSearchTerms === 'function' && !political.buildSearchTerms._uaAreaNameBound) {
      const build = political.buildSearchTerms;
      const wrapped = function(ctxValue) {
        reconcile(ctxValue);
        if (!ctxValue.areaNameOverride) return build.call(this, ctxValue);
        // Explicit confirmed places replace an unverified midpoint street.
        return [...new Set([ctxValue.areaNameOverride, ctxValue.CITY_RAW, ...(ctxValue.confirmedAreaSearchTerms || [])].map(clean).filter(Boolean))].slice(0, 8);
      };
      wrapped._uaAreaNameBound = true;
      political.buildSearchTerms = wrapped;
    }
  }
  function installViewSync() {
    const sync = UA.syncViewToUrl;
    if (typeof sync !== 'function' || sync._uaAreaNameBound) return;
    const wrapped = function(ctx, removeSelection, ...args) {
      if (removeSelection && (ctx._confirmedAreaGeometry || ctx._pendingAreaConfirmation)) clear(ctx, true);
      reconcile(ctx);
      return sync.call(this, ctx, removeSelection, ...args);
    };
    wrapped._uaAreaNameBound = true;
    wrapped._uaOriginal = sync;
    UA.syncViewToUrl = wrapped;
  }
  function bind(ctx, render) {
    const input = document.getElementById('areaNameInput');
    const searchInput = document.getElementById('areaSearchTermsInput');
    const confirm = document.getElementById('btnConfirmAreaName');
    const reset = document.getElementById('btnResetAreaName');
    if (!input || !confirm || !reset || confirm.dataset.uaBound) return;
    confirm.dataset.uaBound = 'true';
    installPolitical();
    installViewSync();
    const query = new URL(window.location.href).searchParams;
    const initial = clean(query.get('areaName'));
    input.value = initial;
    if (searchInput) searchInput.value = query.get('areaSearchTerms') || '';
    const geometry = query.get('areaNameGeometry');
    if (initial && validBinding(geometry, ctx)) {
      // bindExport precedes both selection and viewport hydration. Preserve
      // the original binding, then validate it against the actual ready view.
      ctx._pendingAreaConfirmation = { name: initial, searchTerms: terms(searchInput?.value), geometry };
      const status = document.getElementById('areaNameStatus');
      if (status) status.textContent = 'Bestätigung wird nach der Karteninitialisierung geprüft.';
      reconcile(ctx);
    } else clear(ctx, Boolean(initial));
    confirm.addEventListener('click', () => {
      const name = clean(input.value);
      if (!name) { input.setCustomValidity?.('Bitte Bereichsnamen eingeben oder neutrale Bezeichnung verwenden.'); input.reportValidity?.(); return; }
      input.setCustomValidity?.('');
      setConfirmed(ctx, name, terms(searchInput?.value));
      render();
    });
    reset.addEventListener('click', () => { clear(ctx); input.value = ''; if (searchInput) searchInput.value = ''; render(); });
    input.addEventListener('input', () => input.setCustomValidity?.(''));
    const original = UA.computeExportReport;
    if (typeof original === 'function' && !original._uaAreaNameBound) {
      const wrapped = async function(ctxValue, ...args) {
        installPolitical();
        if (!reconcile(ctx) || (ctxValue !== ctx && !reconcile(ctxValue))) throw new Error('Bereichsname wird nach der Karteninitialisierung geprüft.');
        return original.call(this, ctxValue, ...args);
      };
      wrapped._uaAreaNameBound = true; wrapped._uaOriginal = original;
      UA.computeExportReport = wrapped;
    }
  }
  function researchContext(ctx) {
    if (!ctx || !reconcile(ctx) || !ctx._confirmedAreaGeometry || !ctx.areaNameOverride) return null;
    // The name identifies the confirmed area; it does not verify a midpoint
    // street or district. Explicit place terms remain separate search inputs.
    return { location: ctx.areaNameOverride, street: '', district: '' };
  }
  UA.AreaNameControl = Object.freeze({ bind, reconcile, geometryKey, researchContext });
})();
