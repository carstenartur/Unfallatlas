'use strict';

// This external bootstrap keeps the application compatible with a strict
// script-src 'self' Content Security Policy. It must load before ua.core.js.
window.UA = { BUILD: '2026-07-19 00:00 UTC' };

// Issue #644: load the central evidence-safe semantics contract. The module
// is idempotent and retries installation while the legacy modules load.
if (typeof document !== 'undefined') {
  const semanticScript = document.createElement('script');
  semanticScript.src = 'js/ua.evidence_safe_semantics.js?v=2026-08-22';
  semanticScript.async = false;
  (document.head || document.documentElement).appendChild(semanticScript);
}
