(() => {
  'use strict';
  // This file is present only for legacy branch-root Pages publishing. The
  // canonical build ignores checked-in vendor files and copies exact lockfile
  // assets instead.
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
  document.write('<script src="js/ua.public-preview.js?v=branch-fallback-5"><\/script>');
})();
