(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});
  const MAX_ATTEMPTS = 2;
  const attempts = new Map();
  const criticalScripts = new Map([
    ['ua.map_v2.js', () => typeof UA.initLeaflet === 'function'],
  ]);

  function basename(url) {
    try {
      const pathname = new URL(url, document.baseURI).pathname;
      return pathname.slice(pathname.lastIndexOf('/') + 1);
    } catch (_) {
      return '';
    }
  }

  function parserBlockingRetry(source, attempt) {
    const url = new URL(source, document.baseURI);
    url.searchParams.set('ua_runtime_retry', String(attempt));
    url.searchParams.set('ua_runtime_nonce', `${Date.now()}-${attempt}`);
    const escaped = url.href
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '%3C');
    document.write(`<script src="${escaped}"><\/script>`);
  }

  function handleScriptFailure(event) {
    const script = event && event.target;
    if (!(script instanceof HTMLScriptElement) || !script.src) return;

    const name = basename(script.src);
    const ready = criticalScripts.get(name);
    if (!ready || ready()) return;

    const attempt = (attempts.get(name) || 0) + 1;
    attempts.set(name, attempt);
    UA.criticalRuntimeFailures = UA.criticalRuntimeFailures || [];
    UA.criticalRuntimeFailures.push({
      script: name,
      source: script.src,
      attempt,
      at: new Date().toISOString(),
    });

    if (attempt > MAX_ATTEMPTS || document.readyState !== 'loading') {
      console.error(`[critical-runtime] ${name} konnte nach ${attempt - 1} Wiederholungen nicht geladen werden.`);
      return;
    }

    console.warn(`[critical-runtime] ${name} fehlgeschlagen; parser-blockierender Versuch ${attempt}/${MAX_ATTEMPTS}.`);
    parserBlockingRetry(script.src, attempt);
  }

  // Resource load errors do not bubble. Capture phase is required. The branch
  // fallback may be injected more than once, so replace an older listener
  // instead of accumulating duplicate retry handlers.
  const previousHandler = window.__UA_CRITICAL_RUNTIME_ERROR_HANDLER__;
  if (typeof previousHandler === 'function') {
    window.removeEventListener('error', previousHandler, true);
  }
  window.__UA_CRITICAL_RUNTIME_ERROR_HANDLER__ = handleScriptFailure;
  window.addEventListener('error', handleScriptFailure, true);

  UA.criticalRuntimeRecovery = Object.freeze({
    maxAttempts: MAX_ATTEMPTS,
    attempts,
  });
})();
