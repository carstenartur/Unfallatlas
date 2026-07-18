(() => {
  'use strict';

  /**
   * Accident data provider boundary.
   *
   * Providers select logical resources and spatial coverage. `UA.DataResources`
   * remains the sole owner of physical paths, cache and compression policy.
   */

  const UA = (window.UA = window.UA || {});

  const PROVIDER_TYPES = Object.freeze({
    STATIC_GEOJSON: 'staticGeoJson',
    TILED: 'tiled',
    CUSTOM: 'custom',
  });
  const ACCIDENT_TILE_DEFAULT_ZOOM = 13;
  const ACCIDENT_TILE_DEFAULT_CACHE_SIZE = 96;
  const SUPPORTED_TILE_SCHEMA_VERSIONS = Object.freeze([1]);
  const EXPLICIT_ID_KEYS = Object.freeze([
    'id', 'ID', 'objectid', 'OBJECTID', 'uid', 'UID',
    'unfall_id', 'UNFALL_ID', 'uidentstlae', 'UIDENTSTLAE',
  ]);

  function resources() {
    if (!UA.DataResources) {
      throw new Error('UA.DataResources must be loaded before ua.accident_provider.js');
    }
    return UA.DataResources;
  }

  function slugify(cityRaw) {
    if (UA.normKey && typeof UA.normKey === 'function') return UA.normKey(cityRaw);
    return String(cityRaw || '').toLowerCase().trim();
  }

  function normalizeBaseUrl(raw) {
    const value = typeof raw === 'string' ? raw : '';
    return value && !value.endsWith('/') ? `${value}/` : value;
  }

  function lonToTileX(lon, zoom) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
  }

  function latToTileY(lat, zoom) {
    const bounded = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const radians = bounded * Math.PI / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2)
        * Math.pow(2, zoom)
    );
  }

  function tileKey(x, y) {
    return `${x}/${y}`;
  }

  function compareTileKeys(left, right) {
    const [lx, ly] = String(left).split('/').map(Number);
    const [rx, ry] = String(right).split('/').map(Number);
    return lx - rx || ly - ry;
  }

  function tilesForBounds(bounds, zoom) {
    if (!bounds) return [];
    let south, north, west, east;
    if (typeof bounds.getSouth === 'function') {
      south = bounds.getSouth();
      north = bounds.getNorth();
      west = bounds.getWest();
      east = bounds.getEast();
    } else if (Array.isArray(bounds) && bounds.length === 4) {
      [south, west, north, east] = bounds;
    } else if (typeof bounds === 'object') {
      ({ south, north, west, east } = bounds);
    }
    if (![south, north, west, east].every(Number.isFinite)) return [];

    const xMin = lonToTileX(Math.min(west, east), zoom);
    const xMax = lonToTileX(Math.max(west, east), zoom);
    const yMin = latToTileY(Math.max(south, north), zoom);
    const yMax = latToTileY(Math.min(south, north), zoom);
    const result = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) result.push([x, y]);
    }
    return result;
  }

  function canonicalFeatureIdentity(feature) {
    if (feature && feature.id !== undefined && feature.id !== null && String(feature.id).trim()) {
      return `feature.id:${String(feature.id)}`;
    }
    const properties = feature && feature.properties && typeof feature.properties === 'object'
      ? feature.properties
      : {};
    for (const key of EXPLICIT_ID_KEYS) {
      if (properties[key] !== undefined && properties[key] !== null
          && String(properties[key]).trim()) {
        return `${key}:${String(properties[key])}`;
      }
    }
    return `derived:${JSON.stringify({
      geometry: feature && feature.geometry,
      properties,
    })}`;
  }

  function identitiesForPayload(payload) {
    const features = Array.isArray(payload && payload.features) ? payload.features : [];
    if (Array.isArray(payload && payload.featureIdentities)
        && payload.featureIdentities.length === features.length
        && payload.featureIdentities.every(value => typeof value === 'string' && value)) {
      return payload.featureIdentities.slice();
    }
    return features.map(canonicalFeatureIdentity);
  }

  function mergeFeatureCollections(sources) {
    const features = [];
    let properties = null;
    for (const source of sources || []) {
      if (!source) continue;
      if (Array.isArray(source)) {
        for (const feature of source) if (feature) features.push(feature);
      } else if (source.type === 'FeatureCollection' && Array.isArray(source.features)) {
        if (!properties && source.properties && typeof source.properties === 'object') {
          properties = source.properties;
        }
        for (const feature of source.features) if (feature) features.push(feature);
      }
    }
    const result = { type: 'FeatureCollection', features };
    if (properties) result.properties = properties;
    return result;
  }

  function assertProviderShape(provider, label = 'provider') {
    if (!provider || typeof provider !== 'object') {
      throw new TypeError(`[AccidentProvider] ${label} must be an object`);
    }
    for (const method of ['fetchForCity', 'fetchForBbox', 'getCapabilities']) {
      if (typeof provider[method] !== 'function') {
        throw new TypeError(`[AccidentProvider] ${label}.${method} must be a function`);
      }
    }
  }

  function fetchCustomJson(url, options, policy) {
    return resources().fetchJsonUrl(url, {
      fetch: options.fetch,
      decompress: options.decompress,
      cache: options.cache || 'force-cache',
      compression: policy.compression,
      optional: policy.optional === true,
    });
  }

  function createStaticProvider(options = {}) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const pattern = typeof options.filePattern === 'string' ? options.filePattern : null;
    const cache = new Map();

    function customUrl(slug) {
      if (!baseUrl && !pattern) return null;
      const logical = pattern
        ? pattern.replace('{slug}', slug)
        : resources().url('accidentGeoJson', { city: slug });
      return `${baseUrl}${logical}`;
    }

    function fetchForCity(cityRaw) {
      const slug = slugify(cityRaw);
      if (cache.has(slug)) return cache.get(slug);
      const promise = (async () => {
        const url = customUrl(slug);
        if (url) {
          return fetchCustomJson(url, options, {
            compression: resources().COMPRESSION.GZIP_PREFERRED,
          });
        }
        return resources().fetchJson('accidentGeoJson', { city: slug }, {
          fetch: options.fetch,
          decompress: options.decompress,
        });
      })();
      cache.set(slug, promise);
      promise.catch(() => cache.delete(slug));
      return promise;
    }

    return Object.freeze({
      type: PROVIDER_TYPES.STATIC_GEOJSON,
      fetchForCity,
      fetchForBbox: fetchForCity,
      getCapabilities() {
        return Object.freeze({
          supportsFullCity: true,
          supportsTiles: false,
          coverage: 'full-city',
        });
      },
      canProvideForCity() { return true; },
      clearCache() { cache.clear(); },
    });
  }

  function createTiledProvider(options = {}) {
    const baseUrl = normalizeBaseUrl(options.baseUrl);
    const tileRoot = typeof options.tileRoot === 'string'
      ? options.tileRoot.replace(/\/$/, '')
      : null;
    const parsedCacheSize = Number(options.maxCachedTiles);
    const maxCachedTiles = Number.isInteger(parsedCacheSize) && parsedCacheSize > 0
      ? parsedCacheSize
      : ACCIDENT_TILE_DEFAULT_CACHE_SIZE;
    const manifestCache = new Map();
    const tileCache = new Map();
    let accessClock = 0;

    function customIndexUrl(slug) {
      if (!baseUrl && !tileRoot) return null;
      if (tileRoot) return `${baseUrl}${tileRoot}/${slug}/index.json`;
      return `${baseUrl}${resources().url('accidentTileIndex', { city: slug })}`;
    }

    function customTileUrl(slug, zoom, x, y) {
      if (tileRoot) return `${baseUrl}${tileRoot}/${slug}/${zoom}/${x}/${y}.json`;
      return `${baseUrl}${resources().url('accidentTile', {
        city: slug, z: zoom, x, y,
      })}`;
    }

    function attachIndexes(slug, manifest) {
      const zoom = Number.isInteger(manifest.z)
        ? manifest.z
        : ACCIDENT_TILE_DEFAULT_ZOOM;
      const tileKeySet = new Set();
      const tileByKey = new Map();
      const tileUrlByKey = new Map();
      for (const tile of manifest.tiles || []) {
        if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)) continue;
        const key = tileKey(tile.x, tile.y);
        tileKeySet.add(key);
        tileByKey.set(key, Object.freeze({
          key,
          x: tile.x,
          y: tile.y,
          count: Number.isInteger(tile.count) ? tile.count : null,
        }));
        if (baseUrl || tileRoot) {
          tileUrlByKey.set(key, customTileUrl(slug, zoom, tile.x, tile.y));
        }
      }
      manifest.tileKeySet = tileKeySet;
      manifest.tileByKey = tileByKey;
      manifest.tileUrlByKey = tileUrlByKey;
      return manifest;
    }

    function loadManifest(cityRaw) {
      const slug = slugify(cityRaw);
      if (manifestCache.has(slug)) return manifestCache.get(slug);
      const promise = (async () => {
        const customUrl = customIndexUrl(slug);
        const manifest = customUrl
          ? await fetchCustomJson(customUrl, options, {
              compression: resources().COMPRESSION.GZIP_ONLY,
              optional: true,
            })
          : await resources().fetchJson('accidentTileIndex', { city: slug }, {
              fetch: options.fetch,
              decompress: options.decompress,
              optional: true,
            });
        if (!manifest || typeof manifest !== 'object') return null;
        if (!SUPPORTED_TILE_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
          console.warn(
            `[TiledAccidentProvider] unsupported accident tile schema `
            + `${manifest.schemaVersion} for ${slug}`
          );
          return null;
        }
        if (manifest.city && manifest.city !== slug) {
          console.warn(
            `[TiledAccidentProvider] manifest city ${manifest.city} does not match requested ${slug}`
          );
        }
        if (!Array.isArray(manifest.tiles) || !Number.isInteger(manifest.z)) return null;
        return attachIndexes(slug, manifest);
      })();
      manifestCache.set(slug, promise);
      promise.catch(() => manifestCache.delete(slug));
      return promise;
    }

    function cityTileCache(slug) {
      if (!tileCache.has(slug)) tileCache.set(slug, new Map());
      return tileCache.get(slug);
    }

    function touch(entry) {
      entry.lastAccess = ++accessClock;
      return entry;
    }

    function fetchTile(slug, manifest, x, y) {
      const cache = cityTileCache(slug);
      const key = tileKey(x, y);
      if (cache.has(key)) return touch(cache.get(key)).promise;

      const entry = { lastAccess: ++accessClock, promise: null };
      const promise = (async () => {
        const customUrl = manifest.tileUrlByKey && manifest.tileUrlByKey.get(key);
        const payload = customUrl
          ? await fetchCustomJson(customUrl, options, {
              compression: resources().COMPRESSION.GZIP_ONLY,
              optional: true,
            })
          : await resources().fetchJson('accidentTile', {
              city: slug,
              z: manifest.z,
              x,
              y,
            }, {
              fetch: options.fetch,
              decompress: options.decompress,
              optional: true,
            });
        if (!payload || payload.type !== 'FeatureCollection'
            || !Array.isArray(payload.features)) {
          cache.delete(key);
          return null;
        }
        return payload;
      })();
      entry.promise = promise;
      cache.set(key, entry);
      promise.catch(() => cache.delete(key));
      return promise;
    }

    function trimTileCache(slug, pinnedKeys = new Set()) {
      const cache = tileCache.get(slug);
      if (!cache || cache.size <= maxCachedTiles) return;
      const candidates = Array.from(cache.entries())
        .filter(([key]) => !pinnedKeys.has(key))
        .sort((left, right) => left[1].lastAccess - right[1].lastAccess);
      for (const [key] of candidates) {
        if (cache.size <= maxCachedTiles) break;
        cache.delete(key);
      }
    }

    function requestedTiles(manifest, bounds) {
      return tilesForBounds(bounds, manifest.z)
        .map(([x, y]) => manifest.tileByKey.get(tileKey(x, y)))
        .filter(Boolean)
        .sort((left, right) => left.x - right.x || left.y - right.y);
    }

    async function fetchTileDescriptors(slug, manifest, descriptors) {
      const settled = await Promise.all(descriptors.map(async descriptor => {
        try {
          const payload = await fetchTile(slug, manifest, descriptor.x, descriptor.y);
          return { descriptor, payload, error: null };
        } catch (error) {
          return { descriptor, payload: null, error };
        }
      }));
      const loaded = [];
      const missingTileKeys = [];
      for (const item of settled) {
        if (!item.payload) {
          missingTileKeys.push(item.descriptor.key);
          continue;
        }
        loaded.push(Object.freeze({
          key: item.descriptor.key,
          x: item.descriptor.x,
          y: item.descriptor.y,
          expectedCount: item.descriptor.count,
          featureCollection: item.payload,
          featureIdentities: Object.freeze(identitiesForPayload(item.payload)),
        }));
      }
      return { loaded, missingTileKeys };
    }

    async function fetchTileSetForBbox(cityRaw, bounds) {
      const slug = slugify(cityRaw);
      const manifest = await loadManifest(slug);
      if (!manifest) {
        throw new Error(`[TiledAccidentProvider] No tile index found for city "${slug}"`);
      }
      const descriptors = requestedTiles(manifest, bounds);
      const requestedTileKeys = descriptors.map(descriptor => descriptor.key);
      const result = await fetchTileDescriptors(slug, manifest, descriptors);
      return Object.freeze({
        city: slug,
        tileZoom: manifest.z,
        requestedTileKeys: Object.freeze(requestedTileKeys),
        loadedTileKeys: Object.freeze(result.loaded.map(tile => tile.key)),
        missingTileKeys: Object.freeze(result.missingTileKeys.sort(compareTileKeys)),
        tiles: Object.freeze(result.loaded),
        manifestTileCount: manifest.tileByKey.size,
        sourceTotalCount: Number.isInteger(manifest.totalCount) ? manifest.totalCount : null,
        sourceFingerprint: manifest.sourceFingerprint || null,
      });
    }

    async function fetchForCity(cityRaw) {
      const slug = slugify(cityRaw);
      const manifest = await loadManifest(slug);
      if (!manifest) {
        throw new Error(`[TiledAccidentProvider] No tile index found for city "${slug}"`);
      }
      const descriptors = Array.from(manifest.tileByKey.values())
        .sort((left, right) => left.x - right.x || left.y - right.y);
      const result = await fetchTileDescriptors(slug, manifest, descriptors);
      trimTileCache(slug, new Set(descriptors.map(descriptor => descriptor.key)));
      return mergeFeatureCollections(
        result.loaded.map(tile => tile.featureCollection)
      );
    }

    async function fetchForBbox(cityRaw, bounds) {
      const result = await fetchTileSetForBbox(cityRaw, bounds);
      return mergeFeatureCollections(result.tiles.map(tile => tile.featureCollection));
    }

    async function getCapabilities(cityRaw) {
      const manifest = await loadManifest(cityRaw);
      return Object.freeze({
        supportsFullCity: Boolean(manifest),
        supportsTiles: Boolean(manifest),
        coverage: manifest ? 'viewport-partial' : null,
        tileZoom: manifest ? manifest.z : ACCIDENT_TILE_DEFAULT_ZOOM,
        tileCount: manifest ? manifest.tileByKey.size : null,
        totalCount: manifest && Number.isInteger(manifest.totalCount)
          ? manifest.totalCount
          : null,
        sourceFingerprint: manifest ? manifest.sourceFingerprint || null : null,
      });
    }

    function retainForViewport(cityRaw, tileKeys) {
      const activeKeys = Array.isArray(tileKeys) ? tileKeys : [];
      trimTileCache(slugify(cityRaw), new Set(activeKeys));
    }

    function getCacheSnapshot(cityRaw) {
      const slugs = cityRaw == null ? Array.from(tileCache.keys()) : [slugify(cityRaw)];
      const cities = {};
      for (const slug of slugs.sort()) {
        const cache = tileCache.get(slug);
        cities[slug] = Object.freeze({
          manifestCached: manifestCache.has(slug),
          tileKeys: Object.freeze(cache
            ? Array.from(cache.keys()).sort(compareTileKeys)
            : []),
        });
      }
      return Object.freeze({ maxCachedTiles, cities: Object.freeze(cities) });
    }

    function clearCache(cityRaw) {
      if (cityRaw == null) {
        manifestCache.clear();
        tileCache.clear();
        return;
      }
      const slug = slugify(cityRaw);
      manifestCache.delete(slug);
      tileCache.delete(slug);
    }

    return Object.freeze({
      type: PROVIDER_TYPES.TILED,
      fetchForCity,
      fetchForBbox,
      fetchTileSetForBbox,
      getCapabilities,
      async canProvideForCity(cityRaw) {
        return Boolean(await loadManifest(cityRaw));
      },
      getManifest: loadManifest,
      retainForViewport,
      getCacheSnapshot,
      clearCache,
    });
  }

  const entries = new Map();
  const ProviderRegistry = Object.freeze({
    register(name, provider) {
      if (typeof name !== 'string' || !name) {
        throw new TypeError('[ProviderRegistry] name must be a non-empty string');
      }
      assertProviderShape(provider, name);
      entries.set(name, provider);
    },
    get(name) { return entries.get(name) || null; },
    list() {
      return Array.from(entries.entries()).map(([name, provider]) => ({ name, provider }));
    },
    resolve(cityRaw) {
      if (entries.size === 0) return null;
      const providers = Array.from(entries.values());
      for (const provider of providers) {
        if (provider.type !== PROVIDER_TYPES.TILED) continue;
        try {
          if (provider.canProvideForCity(cityRaw) === true) return provider;
        } catch (_) {}
      }
      for (const provider of providers) {
        if (provider.type === PROVIDER_TYPES.TILED) continue;
        try {
          if (typeof provider.canProvideForCity !== 'function'
              || provider.canProvideForCity(cityRaw) === true) return provider;
        } catch (_) {}
      }
      return providers[0] || null;
    },
    async resolveAsync(cityRaw) {
      if (entries.size === 0) return null;
      const providers = Array.from(entries.values());
      for (const tiledFirst of [true, false]) {
        for (const provider of providers) {
          if ((provider.type === PROVIDER_TYPES.TILED) !== tiledFirst) continue;
          try {
            if (typeof provider.canProvideForCity !== 'function'
                || await Promise.resolve(provider.canProvideForCity(cityRaw))) {
              return provider;
            }
          } catch (_) {}
        }
      }
      return providers[0] || null;
    },
    clear() { entries.clear(); },
  });

  function registerDefaults() {
    ProviderRegistry.register('tiled', createTiledProvider());
    ProviderRegistry.register('static', createStaticProvider());
  }

  UA.AccidentProvider = Object.freeze({
    PROVIDER_TYPES,
    ACCIDENT_TILE_DEFAULT_ZOOM,
    ACCIDENT_TILE_DEFAULT_CACHE_SIZE,
    SUPPORTED_TILE_SCHEMA_VERSIONS,
    ProviderRegistry,
    createStaticProvider,
    createTiledProvider,
    registerDefaults,
    _canonicalFeatureIdentity: canonicalFeatureIdentity,
    _identitiesForPayload: identitiesForPayload,
    _mergeFeatureCollections: mergeFeatureCollections,
    _tilesForBounds: tilesForBounds,
    _assertProviderShape: assertProviderShape,
  });

  registerDefaults();
})();
