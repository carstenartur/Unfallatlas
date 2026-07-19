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

  // Guard-Flag für die deterministische URL-State-Hydration:
  // Solange `UA._hydrating === true` ist, schreibt `UA.setQS` NICHT
  // zurück in window.location. Das verhindert konkurrierende
  // setState-Aufrufe während der Init-Phase (Stadt-/Daten-Laden,
  // bindUi-Defaults, Event-Wiring), bei der ausschliesslich die
  // URL als Source of Truth gelesen werden soll.
  // `setHydrating(true)` darf von außen aufgerufen werden, um die
  // Hydration-Phase explizit einzurahmen.
  UA._hydrating = false;
  UA.setHydrating = (on) => { UA._hydrating = !!on; };
  UA.isHydrating  = () => !!UA._hydrating;

  UA.setQS = (updates, replace=false) => {
    const u = new URL(window.location.href);
    for (const [k,v] of Object.entries(updates)) {
      if (v === null || v === undefined || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, String(v));
    }
    // Während der Hydration KEINE Schreibrunde in die URL — wir
    // wollen die URL erst NACH dem vollständigen Hydrieren ein
    // einziges Mal normalisieren (siehe ua.app_v2.js main()).
    // Den (potenziell normalisierten) Ziel-String geben wir trotzdem
    // zurück, damit Aufrufer wie "Link kopieren" weiter funktionieren.
    if (UA._hydrating) return u.toString();
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

  UA.setBtnState = (btn, on) => {
    if (!btn) return;
    const pressed = !!on;
    btn.classList.toggle("active", pressed);
    if (typeof btn.setAttribute === "function") {
      btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  };

  // Shared modal primitive: focus containment, Escape/backdrop dismissal,
  // background inerting and deterministic focus return. Every task dialog
  // uses this controller so keyboard behaviour cannot drift per feature.
  const MODAL_FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function isUsableFocusTarget(element, boundary) {
    if (!element || !element.isConnected || typeof element.focus !== 'function' || element.disabled) return false;
    let current = element;
    while (current) {
      if (current.hidden || current.inert || current.getAttribute('aria-hidden') === 'true') return false;
      const inline = current.style || {};
      if (inline.display === 'none' || inline.visibility === 'hidden') return false;
      try {
        const computed = window.getComputedStyle && window.getComputedStyle(current);
        if (computed && (computed.display === 'none' || computed.visibility === 'hidden')) return false;
      } catch (_) { /* jsdom/minimal DOM */ }
      if (current === boundary || current === document.body) break;
      current = current.parentElement;
    }
    return true;
  }

  function resolveModalTarget(value, fallbackRoot) {
    const target = typeof value === 'function' ? value() : value;
    if (typeof target === 'string') return fallbackRoot.querySelector(target);
    return target || null;
  }

  function modalFocusableElements(overlay) {
    return [...overlay.querySelectorAll(MODAL_FOCUSABLE)]
      .filter(element => isUsableFocusTarget(element, overlay));
  }

  UA.createModalController = function createModalController(overlay, defaults) {
    if (!overlay) throw new Error('createModalController requires an overlay element');
    if (overlay._uaModalController) return overlay._uaModalController;

    let options = Object.assign({ closeOnBackdrop: true }, defaults || {});
    let returnFocus = null;
    let backgroundState = [];

    function focusInitial() {
      const initial = resolveModalTarget(options.initialFocus, overlay) || modalFocusableElements(overlay)[0];
      const focusTarget = initial || overlay;
      if (focusTarget === overlay && !overlay.hasAttribute('tabindex')) overlay.setAttribute('tabindex', '-1');
      try { focusTarget.focus({ preventScroll: true }); }
      catch (_) { focusTarget.focus(); }
    }

    const controller = {
      isOpen() {
        return overlay.style.display === 'flex';
      },
      open(overrides) {
        options = Object.assign({}, options, overrides || {});
        if (controller.isOpen()) {
          focusInitial();
          return;
        }
        if (UA._activeModalController && UA._activeModalController !== controller) {
          UA._activeModalController.close({ restoreFocus: false });
        }
        const configuredReturn = resolveModalTarget(options.returnFocus, document);
        const active = document.activeElement;
        returnFocus = configuredReturn || (
          active && active !== document.body && typeof active.focus === 'function' ? active : null
        );

        overlay.style.display = 'flex';
        overlay.removeAttribute('aria-hidden');
        overlay.dataset.modalOpen = 'true';
        UA._activeModalController = controller;

        // Move focus before applying aria-hidden to the previous task surface.
        // Chromium otherwise rejects aria-hidden when the triggering control is
        // still focused inside that subtree.
        focusInitial();

        backgroundState = [...document.body.children]
          .filter(element => element !== overlay && !['SCRIPT', 'STYLE'].includes(element.tagName))
          .map(element => ({
            element,
            inert: !!element.inert,
            ariaHidden: element.getAttribute('aria-hidden'),
          }));
        for (const state of backgroundState) {
          state.element.inert = true;
          state.element.setAttribute('aria-hidden', 'true');
        }
        document.documentElement.classList.add('ua-modal-open');
      },
      close(closeOptions) {
        if (!controller.isOpen()) return;
        const shouldRestore = !closeOptions || closeOptions.restoreFocus !== false;
        overlay.style.display = 'none';
        overlay.setAttribute('aria-hidden', 'true');
        delete overlay.dataset.modalOpen;
        for (const state of backgroundState) {
          state.element.inert = state.inert;
          if (state.ariaHidden === null) state.element.removeAttribute('aria-hidden');
          else state.element.setAttribute('aria-hidden', state.ariaHidden);
        }
        backgroundState = [];
        if (UA._activeModalController === controller) UA._activeModalController = null;
        document.documentElement.classList.remove('ua-modal-open');

        const preferredTarget = isUsableFocusTarget(returnFocus, document.body) ? returnFocus : null;
        const configuredFallback = resolveModalTarget(options.fallbackFocus, document);
        const fallbackTarget = isUsableFocusTarget(configuredFallback, document.body)
          ? configuredFallback
          : modalFocusableElements(document.body).find(element => !overlay.contains(element));
        const target = preferredTarget || fallbackTarget || null;
        returnFocus = null;
        if (shouldRestore && target) {
          try { target.focus({ preventScroll: true }); }
          catch (_) { target.focus(); }
        }
      },
    };

    overlay.addEventListener('click', event => {
      if (event.target === overlay && options.closeOnBackdrop !== false) controller.close();
    });
    document.addEventListener('keydown', event => {
      if (UA._activeModalController !== controller || !controller.isOpen()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        controller.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = modalFocusableElements(overlay);
      if (!focusable.length) {
        event.preventDefault();
        overlay.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !overlay.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }, true);

    overlay._uaModalController = controller;
    return controller;
  };

  UA.WEEKEND_SET = new Set(["1","7"]);
})();
