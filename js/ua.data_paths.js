(() => {
  'use strict';

  /**
   * Central registry for every static application resource.
   *
   * A resource definition owns both the logical file name and its transport
   * policy. Callers must not concatenate `out/...` paths or decide between raw
   * and gzip variants themselves.
   *
   * Preferred API:
   *   UA.DataResources.url('accidentGeoJson', { city: 'Bonn' })
   *   UA.DataResources.fetchJson('contextTile', { city: 'Bonn', x: 4256, y: 2754 })
   *
   * UA.DataPaths remains as a compatibility facade for older modules. It is
   * deliberately implemented entirely through the registry.
   */

  const UA = (window.UA = window.UA || {});

  const COMPRESSION = Object.freeze({
    RAW: 'raw',
    GZIP_PREFERRED: 'gzip-preferred',
    GZIP_ONLY: 'gzip-only',
  });

  function slug(cityRaw) {
    if (UA.normKey && typeof UA.normKey === 'function') return UA.normKey(cityRaw);
    return String(cityRaw || '').toLowerCase().trim();
  }

  function integer(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new TypeError(`[DataResources] ${label} must be a non-negative integer`);
    }
    return parsed;
  }

  const definitions = Object.freeze({
    accidentGeoJson: Object.freeze({
      compression: COMPRESSION.GZIP_PREFERRED,
      cache: 'no-store',
      path: ({ city }) => `out/output_all_years_${slug(city)}.geojson`,
    }),
    poiGeoJson: Object.freeze({
      compression: COMPRESSION.GZIP_PREFERRED,
      cache: 'force-cache',
      path: ({ city }) => `out/poi_${slug(city)}.geojson`,
    }),
    contextWays: Object.freeze({
      compression: COMPRESSION.GZIP_PREFERRED,
      cache: 'force-cache',
      path: ({ city }) => `out/ways_${slug(city)}.json`,
    }),
    enrichmentMeta: Object.freeze({
      compression: COMPRESSION.GZIP_PREFERRED,
      cache: 'force-cache',
      path: ({ city }) => `out/output_all_years_${slug(city)}.enrichment.meta.json`,
    }),
    contextTileIndex: Object.freeze({
      compression: COMPRESSION.GZIP_PREFERRED,
      cache: 'force-cache',
      path: ({ city }) => `out/ctxtiles/${slug(city)}/index.json`,
    }),
    // Context schema v3 stores tiles as <city>/<x>/<y>.json. The zoom is
    // recorded in the manifest, not repeated in the directory structure.
    contextTile: Object.freeze({
      compression: COMPRESSION.GZIP_ONLY,
      cache: 'force-cache',
      path: ({ city, x, y }) =>
        `out/ctxtiles/${slug(city)}/${integer(x, 'x')}/${integer(y, 'y')}.json`,
    }),
    accidentTileIndex: Object.freeze({
      compression: COMPRESSION.GZIP_PREFERRED,
      cache: 'force-cache',
      path: ({ city }) => `out/accidenttiles/${slug(city)}/index.json`,
    }),
    accidentTile: Object.freeze({
      compression: COMPRESSION.GZIP_PREFERRED,
      cache: 'force-cache',
      path: ({ city, z, x, y }) =>
        `out/accidenttiles/${slug(city)}/${integer(z, 'z')}/${integer(x, 'x')}/${integer(y, 'y')}.json`,
    }),
  });

  function resolve(kind, params) {
    const definition = definitions[kind];
    if (!definition) throw new TypeError(`[DataResources] unknown resource kind: ${kind}`);
    const logicalUrl = definition.path(params || {});
    return Object.freeze({
      kind,
      logicalUrl,
      gzipUrl: logicalUrl.endsWith('.gz') ? logicalUrl : `${logicalUrl}.gz`,
      compression: definition.compression,
      cache: definition.cache,
    });
  }

  async function fetchRawJson(url, options) {
    const opts = options || {};
    const fetchImpl = (typeof opts.fetch === 'function')
      ? opts.fetch
      : (typeof fetch === 'function' ? fetch : null);
    if (!fetchImpl) throw new Error('fetch is not available');
    const response = await fetchImpl(url, { cache: opts.cache || 'no-store' });
    if (!response || !response.ok) {
      throw new Error(`HTTP ${response && response.status} for ${url}`);
    }
    return response.json();
  }

  async function fetchJsonUrl(logicalUrl, options) {
    const opts = options || {};
    const compression = opts.compression || COMPRESSION.GZIP_PREFERRED;
    const cache = opts.cache || 'no-store';
    try {
      if (compression === COMPRESSION.GZIP_ONLY) {
        if (typeof UA.fetchJsonGz !== 'function') {
          throw new Error('gzip loader is not available');
        }
        const gzipUrl = String(logicalUrl).endsWith('.gz')
          ? String(logicalUrl)
          : `${logicalUrl}.gz`;
        return await UA.fetchJsonGz(gzipUrl, {
          fetch: opts.fetch,
          decompress: opts.decompress,
          cache,
        });
      }

      if (compression === COMPRESSION.GZIP_PREFERRED
          && typeof UA.fetchJsonCompressed === 'function') {
        return await UA.fetchJsonCompressed(logicalUrl, {
          fetch: opts.fetch,
          decompress: opts.decompress,
          cache,
          gzipOnly: opts.gzipOnly,
        });
      }

      return await fetchRawJson(logicalUrl, { ...opts, cache });
    } catch (error) {
      if (opts.optional === true) return null;
      const message = String(error && error.message ? error.message : error);
      throw new Error(`[DataResources] failed to load ${logicalUrl}: ${message}`);
    }
  }

  function fetchJson(kind, params, options) {
    const descriptor = resolve(kind, params);
    // A resource's declared compression mode is authoritative. In particular,
    // callers cannot accidentally enable a raw fallback for context tiles.
    return fetchJsonUrl(descriptor.logicalUrl, {
      ...(options || {}),
      cache: (options && options.cache) || descriptor.cache,
      compression: descriptor.compression,
    });
  }

  const DataResources = Object.freeze({
    COMPRESSION,
    definitions,
    resolve,
    url(kind, params) { return resolve(kind, params).logicalUrl; },
    fetchJson,
    fetchJsonUrl,
  });

  const DataPaths = Object.freeze({
    accidentGeoJson(cityRaw) {
      return DataResources.url('accidentGeoJson', { city: cityRaw });
    },
    poiGeoJson(cityRaw) {
      return DataResources.url('poiGeoJson', { city: cityRaw });
    },
    contextWays(cityRaw) {
      return DataResources.url('contextWays', { city: cityRaw });
    },
    enrichmentMeta(cityRaw) {
      return DataResources.url('enrichmentMeta', { city: cityRaw });
    },
    contextTileIndex(cityRaw) {
      return DataResources.url('contextTileIndex', { city: cityRaw });
    },
    contextTile(cityRaw, zOrX, xOrY, maybeY) {
      // Compatibility with the historical (city,z,x,y) signature. Context v3
      // never stored z in the path; when four arguments are supplied the zoom
      // is intentionally ignored and x/y are taken from the last two values.
      const x = maybeY === undefined ? zOrX : xOrY;
      const y = maybeY === undefined ? xOrY : maybeY;
      return DataResources.url('contextTile', { city: cityRaw, x, y });
    },
    accidentTileIndex(cityRaw) {
      return DataResources.url('accidentTileIndex', { city: cityRaw });
    },
    accidentTile(cityRaw, z, x, y) {
      return DataResources.url('accidentTile', { city: cityRaw, z, x, y });
    },
  });

  UA.DataResources = DataResources;
  UA.DataPaths = DataPaths;

  // Optional missing-data recovery UI. Loading it here keeps the existing HTML
  // entry point unchanged and makes the same button available on GitHub Pages
  // and in the Docker server. Minimal test/document doubles may not implement
  // the complete DOM API, so guard every primitive.
  if (typeof document !== 'undefined'
      && typeof document.querySelector === 'function'
      && typeof document.createElement === 'function'
      && document.head
      && typeof document.head.appendChild === 'function'
      && !document.querySelector('script[data-ua-context-generation]')) {
    const script = document.createElement('script');
    script.src = 'js/ua.context_generation.js?v=2026-07-18';
    script.async = true;
    script.dataset.uaContextGeneration = '1';
    document.head.appendChild(script);
  }
})();