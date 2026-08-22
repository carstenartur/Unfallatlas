'use strict';

// This external bootstrap keeps the application compatible with a strict
// script-src 'self' Content Security Policy. It must load before ua.core.js.
window.UA = { BUILD: '2026-07-19 00:00 UTC' };

// Issue #644: load the central evidence-safe semantics contract and its
// fail-closed hardening layer. Both modules are idempotent and retry their
// installation while the legacy analysis/export modules load.
if (typeof document !== 'undefined') {
  const parent = document.head || document.documentElement;
  const load = (src) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    parent.appendChild(script);
    return script;
  };

  const semantics = load('js/ua.evidence_safe_semantics.js?v=2026-08-22');
  const loadHardening = () => {
    if (!document.querySelector('script[src*="ua.evidence_safe_semantics_hardening.js"]')) {
      load('js/ua.evidence_safe_semantics_hardening.js?v=2026-08-22');
    }
  };
  semantics.addEventListener('load', loadHardening, { once: true });
  semantics.addEventListener('error', loadHardening, { once: true });
}
