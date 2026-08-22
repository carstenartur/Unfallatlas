'use strict';

// This external bootstrap keeps the application compatible with a strict
// script-src 'self' Content Security Policy. It must load before ua.core.js.
window.UA = { BUILD: '2026-07-19 00:00 UTC' };

// Issue #644: load the central evidence-safe semantics contract, its
// fail-closed hardening layer, and the deterministic report bridge before the
// legacy analysis/export stack.
if (typeof document !== 'undefined') {
  const sources = [
    'ua.evidence_safe_semantics.js?v=2026-08-22',
    'ua.evidence_safe_semantics_hardening.js?v=2026-08-22',
    'ua.evidence_safe_semantics_bridge.js?v=2026-08-22',
  ];
  const current = document.currentScript;

  if (
    current
    && current.src
    && document.readyState === 'loading'
    && typeof document.write === 'function'
  ) {
    const tags = sources.map(source => {
      const url = new URL(source, current.src).href
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('<', '%3C');
      return `<script src="${url}"><\/script>`;
    }).join('');
    document.write(tags);
  } else {
    const parent = document.head || document.documentElement;
    sources.reduce((promise, source) => promise.then(() => new Promise((resolve, reject) => {
      const selector = `script[src*="${source.split('?')[0]}"]`;
      if (document.querySelector(selector)) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = `js/${source}`;
      script.async = false;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', reject, { once: true });
      parent.appendChild(script);
    })), Promise.resolve()).catch(error => {
      window.UA.evidenceSafeSemanticsLoadError = String(error && error.message || error);
    });
  }
}
