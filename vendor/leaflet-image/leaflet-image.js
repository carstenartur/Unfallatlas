(() => {
  'use strict';
  // These files exist only for legacy branch-root Pages publishing. The
  // canonical Actions build replaces this path with the exact locked
  // leaflet-image asset. Keep the emergency runtime guard parser-blocking so
  // a transient same-origin 5xx cannot let ua.app_v2.js run before a missing
  // critical module has been retried.
  const githubPagesHost = /(?:^|\.)github\.io$/i.test(String(location.hostname || ''));
  if (githubPagesHost && typeof window.fetch === 'function' && !window.__UA_STATIC_FETCH_GUARD__) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = function publicPreviewFetch(input, init) {
      let url;
      try { url = new URL(typeof input === 'string' ? input : input.url, location.href); }
      catch (_) { return originalFetch(input, init); }
      if (url.origin === location.origin && url.pathname === '/api/video-export-available') {
        return Promise.resolve(new Response('{"available":false,"reason":"static-public-preview"}', {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }));
      }
      return originalFetch(input, init);
    };
    window.__UA_STATIC_FETCH_GUARD__ = true;
  }
  document.write('<script src="js/ua.critical-runtime-recovery.js?v=1"><\/script>');
  document.write('<script src="js/ua.public-preview.js?v=branch-fallback-6"><\/script>');
})();
