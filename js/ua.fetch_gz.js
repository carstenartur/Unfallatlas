(() => {
  'use strict';

  /**
   * js/ua.fetch_gz.js
   *
   * Browser-side utility for fetching and decompressing gzip-encoded
   * static data artefacts from GitHub Pages.
   *
   * Why this exists
   * ---------------
   * GitHub Pages serves `.gz` files as raw binary without setting
   * `Content-Encoding: gzip`, so the browser's transparent decompression
   * does NOT activate. The application must therefore fetch the `.gz` URL
   * explicitly and decompress the response body itself using the Web
   * `DecompressionStream` API (available in all modern browsers).
   *
   * Public API
   * ----------
   *   UA.fetchJsonGz(urlGz, options?)
   *     Fetch a `.gz` URL and return the decompressed, parsed JSON value.
   *     Throws on network error, HTTP error, or decompression failure.
   *
   *   UA.fetchJsonCompressed(url, options?)
   *     Loads `${url}.gz` (appending the suffix if not already present).
   *     If options.gzipOnly is false (default: false), falls back to the
   *     raw URL when the .gz fetch fails — useful for local development
   *     where the data may not have been compressed yet.
   *     Set options.gzipOnly = true (or set UNFALLATLAS_DATA_MODE via a
   *     meta tag; see below) to disable the fallback and hard-fail when
   *     the .gz artefact is missing.
   *
   *     Context tiles under `out/ctxtiles/<city>/<x>/<y>.json` are always
   *     gzip-only by repository policy. They never fall back to raw JSON;
   *     doing so previously left the controls and legends visible while all
   *     road-tile requests returned 404 and no streets were rendered.
   *
   * Configuring gzip-only mode for Pages / CI smoke tests
   * -------------------------------------------------------
   * Add a meta tag to the HTML to disable the raw fallback globally:
   *   <meta name="unfallatlas:data-mode" content="gzip-only">
   * Or pass { gzipOnly: true } per call.
   *
   * Dependency injection for tests
   * --------------------------------
   * Both functions accept an `options.fetch` and `options.decompress`
   * override so unit tests can supply their own implementations without
   * patching globals.
   *
   *   await UA.fetchJsonGz(url, {
   *     fetch:      myFakeFetch,
   *     decompress: async (arrayBuffer) => decompressedBuffer,
   *   });
   */

  const UA = (window.UA = window.UA || {});

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Detect the global data mode. Checks (in order):
   *   1. `<meta name="unfallatlas:data-mode" content="gzip-only">` in <head>
   *   2. Falls back to 'default' (= allow raw fallback)
   *
   * @returns {'gzip-only'|'default'}
   */
  function _globalDataMode() {
    try {
      const el = document.querySelector('meta[name="unfallatlas:data-mode"]');
      if (el && el.getAttribute('content') === 'gzip-only') return 'gzip-only';
    } catch (_) { /* headless / test environment */ }
    return 'default';
  }

  /**
   * Context-tile payloads are normalized to gzip-only by every production
   * workflow (`scripts/static-data-policy.js`). Keep this path-level contract
   * independent of an HTML meta tag so local static servers, Docker and Pages
   * all resolve the same files.
   */
  function _isImplicitGzipOnlyUrl(url) {
    const clean = String(url || '').replace(/[?#].*$/, '').replace(/\\/g, '/');
    return /(?:^|\/)out\/ctxtiles\/[^/]+\/(?:\d+\/)?\d+\/\d+\.json$/i.test(clean);
  }

  /**
   * Decompress an `ArrayBuffer` containing gzip data using the native
   * `DecompressionStream` API and return a decoded UTF-8 string.
   *
   * @param {ArrayBuffer} buf
   * @returns {Promise<string>}
   */
  async function _decompressGzip(buf) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        '[ua.fetch_gz] DecompressionStream is not available in this browser. ' +
        'Please upgrade to a modern browser (Chrome 80+, Firefox 113+, Safari 16.4+).'
      );
    }
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(new Uint8Array(buf));
    writer.close();

    const reader = ds.readable.getReader();
    const chunks = [];
    let done, value;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      ({ done, value } = await reader.read());
      if (done) break;
      chunks.push(value);
    }
    // Concatenate Uint8Array chunks and decode as UTF-8
    let totalLength = 0;
    for (const c of chunks) totalLength += c.length;
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    return new TextDecoder('utf-8').decode(merged);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch a `.gz` URL and return the decompressed, parsed JSON value.
   *
   * @param {string} urlGz   The URL of the .gz file to fetch.
   * @param {{
   *   fetch?:      (url: string, init?: RequestInit) => Promise<Response>,
   *   decompress?: (buf: ArrayBuffer) => Promise<string>,
   *   cache?:      RequestCache,
   * }} [options]
   * @returns {Promise<*>}  Parsed JSON value.
   */
  UA.fetchJsonGz = async function fetchJsonGz(urlGz, options) {
    const opts       = options  || {};
    const _fetch     = (typeof opts.fetch === 'function')      ? opts.fetch      : fetch;
    const _decomp    = (typeof opts.decompress === 'function') ? opts.decompress : _decompressGzip;
    const cacheMode  = opts.cache || 'no-store';

    let resp;
    try {
      resp = await _fetch(urlGz, { cache: cacheMode });
    } catch (err) {
      throw new Error(`[fetchJsonGz] network error for ${urlGz}: ${err.message}`);
    }
    if (!resp || !resp.ok) {
      throw new Error(`[fetchJsonGz] HTTP ${resp && resp.status} for ${urlGz}`);
    }

    let buf;
    try {
      buf = await resp.arrayBuffer();
    } catch (err) {
      throw new Error(`[fetchJsonGz] failed to read response body from ${urlGz}: ${err.message}`);
    }

    let text;
    try {
      text = await _decomp(buf);
    } catch (err) {
      throw new Error(`[fetchJsonGz] decompression failed for ${urlGz}: ${err.message}`);
    }

    try {
      return JSON.parse(text);
    } catch (err) {
      throw new Error(`[fetchJsonGz] JSON parse error for ${urlGz}: ${err.message}`);
    }
  };

  /**
   * Fetch a JSON resource, loading the `.gz` variant automatically.
   *
   * The function appends `.gz` to the provided `url` (unless it already
   * ends with `.gz`) and decompresses the response. If `options.gzipOnly`
   * is false (the default) and the `.gz` fetch fails, it falls back to
   * the raw URL for local-development convenience. Context-tile payloads
   * are an explicit exception and are always gzip-only.
   *
   * @param {string} url   Logical URL (without .gz suffix).
   * @param {{
   *   fetch?:      (url: string, init?: RequestInit) => Promise<Response>,
   *   decompress?: (buf: ArrayBuffer) => Promise<string>,
   *   gzipOnly?:   boolean,
   *   cache?:      RequestCache,
   * }} [options]
   * @returns {Promise<*>}  Parsed JSON value.
   */
  UA.fetchJsonCompressed = async function fetchJsonCompressed(url, options) {
    const opts     = options || {};
    const urlGz    = url.endsWith('.gz') ? url : `${url}.gz`;
    const gzipOnly = opts.gzipOnly !== undefined
      ? opts.gzipOnly
      : (_globalDataMode() === 'gzip-only' || _isImplicitGzipOnlyUrl(url));

    try {
      return await UA.fetchJsonGz(urlGz, opts);
    } catch (gzErr) {
      if (gzipOnly) throw gzErr;
      // Fallback to raw URL (local development / transitional period)
      const _fetch    = (typeof opts.fetch === 'function') ? opts.fetch : fetch;
      const cacheMode = opts.cache || 'no-store';
      let resp;
      try {
        resp = await _fetch(url, { cache: cacheMode });
      } catch (rawErr) {
        // Throw the original .gz error so the caller sees the primary failure
        throw gzErr;
      }
      if (!resp || !resp.ok) {
        throw gzErr; // surface the .gz error, not a secondary raw error
      }
      return resp.json();
    }
  };

  // Export the policy probe only for unit tests / diagnostics. It is pure and
  // does not expose mutable application state.
  UA._isImplicitGzipOnlyUrl = _isImplicitGzipOnlyUrl;
})();
