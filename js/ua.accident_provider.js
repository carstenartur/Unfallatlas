(() => {
  'use strict';

  /**
   * js/ua.accident_provider.js
   *
   * Provider abstraction for accident data (Architecture Step 2 & 3).
   *
   * This module introduces a clean boundary between data-loading and the
   * rest of the application. No renderer, plugin or UI module should
   * fetch accident GeoJSON directly; all access must go through a
   * registered AccidentProvider.
   *
   * Architecture overview:
   *
   *   ProviderRegistry
   *   ├── StaticGeoJsonAccidentProvider
   *   │     loads out/output_all_years_<slug>.geojson (current behaviour)
   *   └── TiledAccidentProvider
   *         loads out/accidenttiles/<slug>/index.json
   *         then  out/accidenttiles/<slug>/<z>/<x>/<y>.json per bbox
   *
   * Provider interface (informal, enforced by validation helper):
   *   fetchForCity(slug)              → Promise<GeoJSON FeatureCollection>
   *   fetchForBbox(slug, bounds, zoom)→ Promise<GeoJSON FeatureCollection>
   *   getCapabilities(slug)           → { supportsFullCity, supportsTiles }
   *   canProvideForCity(slug)         → boolean | Promise<boolean>  (optional; defaults to true)
   *
   * Public API:
   *   UA.AccidentProvider.ProviderRegistry.register(name, provider) → void
   *   UA.AccidentProvider.ProviderRegistry.get(name)               → provider|null
   *   UA.AccidentProvider.ProviderRegistry.resolve(slug)           → provider
   *   UA.AccidentProvider.ProviderRegistry.list()                  → [{name,provider}]
   *   UA.AccidentProvider.createStaticProvider(options?)           → provider
   *   UA.AccidentProvider.createTiledProvider(options?)            → provider
   *   UA.AccidentProvider.PROVIDER_TYPES                           → frozen object
   *
   * Backward compatibility:
   *   UA.buildDataUrl / UA.loadCityData remain in ua.data_v2.js unchanged.
   *   Calling code may progressively adopt UA.AccidentProvider without a
   *   flag day: register the static provider at app start, and swap in
   *   the tiled provider for cities that have tiles available.
   *
   * Reference: the context-layers tiled loading in ua.context_layers.js
   * served as the design template for TiledAccidentProvider.
   */

  const UA = (window.UA = window.UA || {});

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  const PROVIDER_TYPES = Object.freeze({
    STATIC_GEOJSON: 'staticGeoJson',
    TILED:          'tiled',
    CUSTOM:         'custom',
  });

  /** Default zoom level for accident tiles — must match the tile producer. */
  const ACCIDENT_TILE_DEFAULT_ZOOM = 13;

  /** Supported tile-index schema versions for TiledAccidentProvider. */
  const SUPPORTED_TILE_SCHEMA_VERSIONS = [1];

  // ---------------------------------------------------------------------------
  // Slippy-tile coordinate helpers (mirrors ua.context_layers.js)
  // ---------------------------------------------------------------------------

  function _lonToTileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  }

  function _latToTileY(lat, z) {
    const rad = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
        Math.pow(2, z)
    );
  }

  /**
   * Compute the set of [x, y] tile coordinates intersecting a bounding box.
   *
   * `bounds` may be any of:
   *   - Leaflet LatLngBounds   (getSouth/getNorth/getWest/getEast methods)
   *   - Array [south, west, north, east]
   *   - Plain object { south, west, north, east }
   *
   * @param {*} bounds
   * @param {number} z – slippy-tile zoom
   * @returns {Array<[number,number]>}
   */
  function _tilesForBounds(bounds, z) {
    if (!bounds) return [];
    let south, north, west, east;
    if (typeof bounds.getSouth === 'function') {
      south = bounds.getSouth(); north = bounds.getNorth();
      west  = bounds.getWest();  east  = bounds.getEast();
    } else if (Array.isArray(bounds) && bounds.length === 4) {
      [south, west, north, east] = bounds;
    } else if (bounds && typeof bounds === 'object') {
      south = bounds.south; north = bounds.north;
      west  = bounds.west;  east  = bounds.east;
    }
    if (!Number.isFinite(south) || !Number.isFinite(north) ||
        !Number.isFinite(west)  || !Number.isFinite(east)) return [];
    const xMin = _lonToTileX(Math.min(west,  east),  z);
    const xMax = _lonToTileX(Math.max(west,  east),  z);
    const yMin = _latToTileY(Math.max(south, north), z);
    const yMax = _latToTileY(Math.min(south, north), z);
    const out = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) {
        out.push([x, y]);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  function _slugify(cityRaw) {
    if (UA.normKey && typeof UA.normKey === 'function') return UA.normKey(cityRaw);
    return String(cityRaw || '').toLowerCase().trim();
  }

  /**
   * Merge multiple GeoJSON FeatureCollection objects (or arrays of features)
   * into a single FeatureCollection. Preserves the `properties` block of the
   * first collection that carries one.
   *
   * @param {Array<object|null>} sources
   * @returns {object} GeoJSON FeatureCollection
   */
  function _mergeFeatureCollections(sources) {
    const allFeatures = [];
    let topLevelProps = null;
    for (const src of sources) {
      if (!src) continue;
      if (Array.isArray(src)) {
        for (const f of src) { if (f) allFeatures.push(f); }
      } else if (src.type === 'FeatureCollection' && Array.isArray(src.features)) {
        if (!topLevelProps && src.properties && typeof src.properties === 'object') {
          topLevelProps = src.properties;
        }
        for (const f of src.features) { if (f) allFeatures.push(f); }
      }
    }
    const result = { type: 'FeatureCollection', features: allFeatures };
    if (topLevelProps) result.properties = topLevelProps;
    return result;
  }

  // ---------------------------------------------------------------------------
  // Provider interface validation
  // ---------------------------------------------------------------------------

  /**
   * Validate that an object satisfies the AccidentProvider interface.
   * Throws a TypeError if the contract is not met.
   *
   * @param {object} provider
   * @param {string} [label]
   */
  function _assertProviderShape(provider, label) {
    const name = label || 'provider';
    if (!provider || typeof provider !== 'object') {
      throw new TypeError(`[AccidentProvider] ${name} must be an object`);
    }
    if (typeof provider.fetchForCity !== 'function') {
      throw new TypeError(`[AccidentProvider] ${name}.fetchForCity must be a function`);
    }
    if (typeof provider.fetchForBbox !== 'function') {
      throw new TypeError(`[AccidentProvider] ${name}.fetchForBbox must be a function`);
    }
    if (typeof provider.getCapabilities !== 'function') {
      throw new TypeError(`[AccidentProvider] ${name}.getCapabilities must be a function`);
    }
  }

  // ---------------------------------------------------------------------------
  // StaticGeoJsonAccidentProvider
  // ---------------------------------------------------------------------------

  /**
   * Loads the full per-city accident GeoJSON file in one request.
   * This is the current Unfallwerkbank behaviour, wrapped behind the
   * AccidentProvider interface so callers are decoupled from the file path.
   *
   * @param {object} [options]
   * @param {string} [options.baseUrl]      URL prefix (default: '')
   * @param {string} [options.filePattern]  filename template; use '{slug}'
   *                                        (default: 'out/output_all_years_{slug}.geojson')
   * @param {function} [options.fetch]      injectable fetch (for tests)
   * @returns {object} AccidentProvider
   */
  function createStaticProvider(options) {
    const opts = options || {};
    const _fetch     = (typeof opts.fetch === 'function') ? opts.fetch :
                       (typeof fetch === 'function')      ? fetch : null;
    const _rawBaseUrl = (typeof opts.baseUrl === 'string') ? opts.baseUrl : '';
    const baseUrl    = _rawBaseUrl && !_rawBaseUrl.endsWith('/') ? `${_rawBaseUrl}/` : _rawBaseUrl;
    const pattern    = (typeof opts.filePattern === 'string')
      ? opts.filePattern
      : null; // resolved per-call via UA.DataPaths when available

    function _url(slug) {
      // Use central path registry when available (ua.data_paths.js).
      if (!pattern && UA.DataPaths && typeof UA.DataPaths.accidentGeoJson === 'function') {
        return baseUrl + UA.DataPaths.accidentGeoJson(slug);
      }
      return baseUrl + (pattern || 'out/output_all_years_{slug}.geojson').replace('{slug}', slug);
    }

    /** Per-city in-flight cache so duplicate calls don't issue duplicate requests. */
    const _cache = new Map();

    function fetchForCity(cityRaw) {
      const slug = _slugify(cityRaw);
      if (_cache.has(slug)) return _cache.get(slug);
      if (!_fetch) return Promise.reject(new Error('[StaticGeoJsonAccidentProvider] fetch is not available'));
      const p = (async () => {
        const url = _url(slug);
        // Prefer UA.fetchJsonCompressed (loads .gz variant automatically) when available.
        if (typeof UA.fetchJsonCompressed === 'function') {
          return UA.fetchJsonCompressed(url, { fetch: _fetch });
        }
        // Fallback: direct fetch (legacy / test environments without ua.fetch_gz.js)
        let resp;
        try { resp = await _fetch(url, { cache: 'no-store' }); }
        catch (err) { throw new Error(`[StaticGeoJsonAccidentProvider] network error for ${url}: ${err.message}`); }
        if (!resp || !resp.ok) {
          throw new Error(`[StaticGeoJsonAccidentProvider] HTTP ${resp && resp.status} for ${url}`);
        }
        return resp.json();
      })();
      _cache.set(slug, p);
      // Remove failed entries so a retry can succeed
      p.catch(() => _cache.delete(slug));
      return p;
    }

    function fetchForBbox(cityRaw, _bounds, _zoom) {
      // Static provider does not support tile-level bbox loading.
      // Return the full city dataset for any bbox request — the caller
      // must filter by viewport if needed.
      return fetchForCity(cityRaw);
    }

    function getCapabilities(_cityRaw) {
      return Object.freeze({ supportsFullCity: true, supportsTiles: false });
    }

    function canProvideForCity(_cityRaw) { return true; }

    function clearCache() { _cache.clear(); }

    return Object.freeze({
      type: PROVIDER_TYPES.STATIC_GEOJSON,
      fetchForCity,
      fetchForBbox,
      getCapabilities,
      canProvideForCity,
      clearCache,
    });
  }

  // ---------------------------------------------------------------------------
  // TiledAccidentProvider
  // ---------------------------------------------------------------------------

  /**
   * Loads accident data lazily from a tile pyramid, analogous to the
   * context-layers tiled approach in ua.context_layers.js.
   *
   * Tile structure:
   *   out/accidenttiles/<slug>/index.json   ← manifest
   *   out/accidenttiles/<slug>/<z>/<x>/<y>.json  ← GeoJSON tile
   *
   * Manifest shape (schemaVersion: 1):
   *   {
   *     "schemaVersion": 1,
   *     "city": "<slug>",
   *     "z": 13,
   *     "tiles": [{ "x": 4200, "y": 2750, "count": 42 }, …],
   *     "totalCount": 12345,
   *     "generatedAt": "2026-01-01T00:00:00Z"
   *   }
   *
   * @param {object} [options]
   * @param {string} [options.baseUrl]          URL prefix (default: '')
   * @param {string} [options.tileRoot]         directory containing <slug>/ subdirs
   *                                            (default: 'out/accidenttiles')
   * @param {function} [options.fetch]          injectable fetch (for tests)
   * @returns {object} AccidentProvider
   */
  function createTiledProvider(options) {
    const opts      = options || {};
    const _fetch    = (typeof opts.fetch === 'function') ? opts.fetch :
                      (typeof fetch === 'function')      ? fetch : null;
    const _rawBaseUrl = (typeof opts.baseUrl === 'string') ? opts.baseUrl : '';
    const baseUrl   = _rawBaseUrl && !_rawBaseUrl.endsWith('/') ? `${_rawBaseUrl}/` : _rawBaseUrl;
    const tileRoot  = (typeof opts.tileRoot === 'string')
      ? opts.tileRoot.replace(/\/$/, '')
      : null; // resolved per-call via UA.DataPaths when available

    /** Per-city manifest cache: slug → Promise<manifest|null> */
    const _manifestCache = new Map();
    /** Per-city per-tile cache: slug → Map<"x/y" → Promise<GeoJSON|null>> */
    const _tileCache     = new Map();

    function _indexUrl(slug) {
      // Use central path registry when available (ua.data_paths.js).
      if (!tileRoot && UA.DataPaths && typeof UA.DataPaths.accidentTileIndex === 'function') {
        return baseUrl + UA.DataPaths.accidentTileIndex(slug);
      }
      return `${baseUrl}${tileRoot || 'out/accidenttiles'}/${slug}/index.json`;
    }

    function _tileUrl(slug, z, x, y) {
      // Use central path registry when available (ua.data_paths.js).
      if (!tileRoot && UA.DataPaths && typeof UA.DataPaths.accidentTile === 'function') {
        return baseUrl + UA.DataPaths.accidentTile(slug, z, x, y);
      }
      return `${baseUrl}${tileRoot || 'out/accidenttiles'}/${slug}/${z}/${x}/${y}.json`;
    }

    function _tileUrlFromManifest(slug, manifest, x, y) {
      if (manifest && manifest.tileUrlByKey instanceof Map) {
        const fromMap = manifest.tileUrlByKey.get(`${x}/${y}`);
        if (fromMap) return fromMap;
      }
      const z = (manifest && typeof manifest.z === 'number') ? manifest.z : ACCIDENT_TILE_DEFAULT_ZOOM;
      return _tileUrl(slug, z, x, y);
    }

    function _attachUrlIndex(slug, manifest) {
      if (!manifest || typeof manifest !== 'object') return manifest;
      const byKey = new Map();
      const z = typeof manifest.z === 'number' ? manifest.z : ACCIDENT_TILE_DEFAULT_ZOOM;
      for (const t of (manifest.tiles || [])) {
        if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
        const key = `${t.x}/${t.y}`;
        byKey.set(key, _tileUrl(slug, z, t.x, t.y));
      }
      manifest.tileUrlByKey = byKey;
      manifest.tileKeySet   = new Set(byKey.keys());
      return manifest;
    }

    function _loadManifest(slug) {
      if (_manifestCache.has(slug)) return _manifestCache.get(slug);
      if (!_fetch) return Promise.resolve(null);
      const p = (async () => {
        const indexUrl = _indexUrl(slug);
        let json = null;
        // Prefer UA.fetchJsonCompressed (loads .gz variant automatically) when available.
        if (typeof UA.fetchJsonCompressed === 'function') {
          try { json = await UA.fetchJsonCompressed(indexUrl, { fetch: _fetch, cache: 'force-cache' }); }
          catch (_) { return null; }
        } else {
          let resp;
          try { resp = await _fetch(indexUrl, { cache: 'force-cache' }); }
          catch (_) { return null; }
          if (!resp || !resp.ok) return null;
          try { json = await resp.json(); } catch (_) { return null; }
        }
        if (!json || typeof json !== 'object') return null;
        const ver = typeof json.schemaVersion === 'number' ? json.schemaVersion : null;
        if (ver !== null && !SUPPORTED_TILE_SCHEMA_VERSIONS.includes(ver)) {
          console.warn(
            `[TiledAccidentProvider] accidenttiles/${slug}/index.json ` +
            `schemaVersion=${ver} not in SUPPORTED_TILE_SCHEMA_VERSIONS=` +
            `${JSON.stringify(SUPPORTED_TILE_SCHEMA_VERSIONS)} — ignoring tile index.`
          );
          return null;
        }
        // Attach pre-built URL index for O(1) tile lookups
        _attachUrlIndex(slug, json);
        return json;
      })();
      _manifestCache.set(slug, p);
      p.catch(() => _manifestCache.delete(slug));
      return p;
    }

    function _cityTileCache(slug) {
      if (!_tileCache.has(slug)) _tileCache.set(slug, new Map());
      return _tileCache.get(slug);
    }

    function _fetchTile(slug, manifest, x, y) {
      const tileMap = _cityTileCache(slug);
      const key     = `${x}/${y}`;
      if (tileMap.has(key)) return tileMap.get(key);
      if (!_fetch) return Promise.resolve(null);
      const url = _tileUrlFromManifest(slug, manifest, x, y);
      const p = (async () => {
        // Prefer UA.fetchJsonCompressed (loads .gz variant automatically) when available.
        if (typeof UA.fetchJsonCompressed === 'function') {
          try { return await UA.fetchJsonCompressed(url, { fetch: _fetch, cache: 'force-cache' }); }
          catch (_) { tileMap.delete(key); return null; }
        }
        let resp;
        try { resp = await _fetch(url, { cache: 'force-cache' }); }
        catch (_) { tileMap.delete(key); return null; }
        if (!resp || !resp.ok) { tileMap.delete(key); return null; }
        let json = null;
        try { json = await resp.json(); } catch (_) { tileMap.delete(key); return null; }
        return json;
      })();
      tileMap.set(key, p);
      return p;
    }

    async function fetchForCity(cityRaw) {
      const slug     = _slugify(cityRaw);
      const manifest = await _loadManifest(slug);
      if (!manifest) {
        throw new Error(`[TiledAccidentProvider] No tile index found for city "${slug}"`);
      }
      const tiles = manifest.tiles || [];
      const tileFetches = tiles.map(({ x, y }) => _fetchTile(slug, manifest, x, y));
      const results = await Promise.all(tileFetches);
      return _mergeFeatureCollections(results.filter(Boolean));
    }

    async function fetchForBbox(cityRaw, bounds, zoom) {
      const slug     = _slugify(cityRaw);
      const manifest = await _loadManifest(slug);
      if (!manifest) {
        throw new Error(`[TiledAccidentProvider] No tile index found for city "${slug}"`);
      }
      const z    = (typeof zoom === 'number' && Number.isFinite(zoom))
        ? zoom
        : (typeof manifest.z === 'number' ? manifest.z : ACCIDENT_TILE_DEFAULT_ZOOM);
      const want = _tilesForBounds(bounds, z);
      if (want.length === 0) return _mergeFeatureCollections([]);

      // Limit to tiles the manifest knows about to avoid spurious 404s
      const known = manifest.tileKeySet || new Set();
      const fetches = [];
      for (const [x, y] of want) {
        if (!known.has(`${x}/${y}`)) continue;
        fetches.push(_fetchTile(slug, manifest, x, y));
      }
      const results = await Promise.all(fetches);
      return _mergeFeatureCollections(results.filter(Boolean));
    }

    async function getCapabilities(cityRaw) {
      const slug     = _slugify(cityRaw);
      const manifest = await _loadManifest(slug);
      return Object.freeze({
        supportsFullCity: true,
        supportsTiles:    !!(manifest),
        tileZoom:         (manifest && typeof manifest.z === 'number') ? manifest.z : ACCIDENT_TILE_DEFAULT_ZOOM,
        totalCount:       (manifest && Number.isFinite(manifest.totalCount)) ? manifest.totalCount : null,
      });
    }

    async function canProvideForCity(cityRaw) {
      const slug     = _slugify(cityRaw);
      const manifest = await _loadManifest(slug);
      return manifest !== null && typeof manifest === 'object';
    }

    function clearCache() {
      _manifestCache.clear();
      _tileCache.clear();
    }

    return Object.freeze({
      type: PROVIDER_TYPES.TILED,
      fetchForCity,
      fetchForBbox,
      getCapabilities,
      canProvideForCity,
      clearCache,
    });
  }

  // ---------------------------------------------------------------------------
  // ProviderRegistry
  // ---------------------------------------------------------------------------

  /**
   * A simple registry that maps provider names to AccidentProvider instances.
   *
   * Typical setup (app initialisation):
   *   UA.AccidentProvider.ProviderRegistry.register('static', UA.AccidentProvider.createStaticProvider());
   *   UA.AccidentProvider.ProviderRegistry.register('tiled',  UA.AccidentProvider.createTiledProvider());
   *
   * The registry is a singleton attached to UA.AccidentProvider.ProviderRegistry.
   * Individual provider instances are independent objects and can also be used
   * directly without the registry.
   */
  const _registryEntries = new Map(); // name → provider

  const ProviderRegistry = Object.freeze({
    /**
     * Register a provider under a name. Overwrites any previous registration
     * with the same name.
     *
     * @param {string} name
     * @param {object} provider – must satisfy the AccidentProvider interface
     */
    register(name, provider) {
      if (typeof name !== 'string' || !name) {
        throw new TypeError('[ProviderRegistry] name must be a non-empty string');
      }
      _assertProviderShape(provider, name);
      _registryEntries.set(name, provider);
    },

    /**
     * Return the provider registered under `name`, or null if not found.
     *
     * @param {string} name
     * @returns {object|null}
     */
    get(name) {
      return _registryEntries.get(name) || null;
    },

    /**
     * Return all registered providers as an array of `{ name, provider }` entries.
     *
     * @returns {Array<{name:string, provider:object}>}
     */
    list() {
      return Array.from(_registryEntries.entries()).map(([name, provider]) => ({ name, provider }));
    },

    /**
     * Resolve the "best" provider for a city.
     *
     * Resolution order:
     *   1. First registered tiled provider whose `canProvideForCity` returns
     *      true synchronously (async providers skip canProvideForCity check).
     *   2. First registered static provider whose `canProvideForCity` returns true.
     *   3. Any registered provider (first one).
     *   4. null — nothing is registered.
     *
     * For async `canProvideForCity` (e.g. TiledAccidentProvider), callers
     * should explicitly select a provider by name when they know it's
     * available, or use `resolveAsync` for a promise-based lookup.
     *
     * @param {string} cityRaw
     * @returns {object|null}
     */
    resolve(cityRaw) {
      if (_registryEntries.size === 0) return null;
      const entries = Array.from(_registryEntries.values());
      for (const p of entries) {
        if (p.type === PROVIDER_TYPES.TILED &&
            typeof p.canProvideForCity === 'function') {
          const result = p.canProvideForCity(cityRaw);
          // Only use synchronous true — skip async results
          if (result === true) return p;
        }
      }
      for (const p of entries) {
        if (p.type !== PROVIDER_TYPES.TILED &&
            typeof p.canProvideForCity === 'function') {
          const result = p.canProvideForCity(cityRaw);
          if (result === true) return p;
        }
      }
      return entries[0] || null;
    },

    /**
     * Resolve the best provider asynchronously, respecting async
     * `canProvideForCity` checks. Tries providers in registration order,
     * preferring tiled providers over static ones.
     *
     * @param {string} cityRaw
     * @returns {Promise<object|null>}
     */
    async resolveAsync(cityRaw) {
      if (_registryEntries.size === 0) return null;
      const entries = Array.from(_registryEntries.values());
      // Prefer tiled providers
      for (const p of entries) {
        if (p.type === PROVIDER_TYPES.TILED &&
            typeof p.canProvideForCity === 'function') {
          try {
            const ok = await Promise.resolve(p.canProvideForCity(cityRaw));
            if (ok) return p;
          } catch (_) { /* skip unavailable */ }
        }
      }
      // Fall back to any other provider
      for (const p of entries) {
        if (p.type !== PROVIDER_TYPES.TILED &&
            typeof p.canProvideForCity === 'function') {
          try {
            const ok = await Promise.resolve(p.canProvideForCity(cityRaw));
            if (ok) return p;
          } catch (_) { /* skip */ }
        }
      }
      return entries[0] || null;
    },

    /**
     * Remove all registered providers. Primarily useful in tests.
     */
    clear() {
      _registryEntries.clear();
    },
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  UA.AccidentProvider = Object.freeze({
    PROVIDER_TYPES,
    ACCIDENT_TILE_DEFAULT_ZOOM,
    SUPPORTED_TILE_SCHEMA_VERSIONS,
    ProviderRegistry,
    createStaticProvider,
    createTiledProvider,

    // Low-level helpers exposed for testing and advanced use
    _mergeFeatureCollections,
    _tilesForBounds,
    _assertProviderShape,
  });
})();
