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
  const SUPPORTED_TILE_SCHEMA_VERSIONS = Object.freeze([2]);
  const EXPLICIT_ID_KEYS = Object.freeze([
    'id', 'ID', 'objectid', 'OBJECTID', 'uid', 'UID',
    'unfall_id', 'UNFALL_ID', 'uidentstlae', 'UIDENTSTLAE',
  ]);
  const YEAR_KEYS = Object.freeze([
    'year', 'YEAR', 'ujahr', 'UJAHR', 'jahr', 'JAHR',
    'sourceYear', 'source_year',
  ]);
  const SHA256_INITIAL = Object.freeze([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const SHA256_ROUND = Object.freeze([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
    0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
    0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
    0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
    0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
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

  function rotateRight(value, count) {
    return (value >>> count) | (value << (32 - count));
  }

  function utf8Bytes(value) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
    const encoded = unescape(encodeURIComponent(value)); // eslint-disable-line no-undef
    return Uint8Array.from(encoded, character => character.charCodeAt(0));
  }

  function sha256(value) {
    const bytes = utf8Bytes(String(value));
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(paddedLength);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer);
    const bitLength = bytes.length * 8;
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);

    const state = SHA256_INITIAL.slice();
    const words = new Uint32Array(64);
    for (let offset = 0; offset < paddedLength; offset += 64) {
      for (let index = 0; index < 16; index += 1) {
        words[index] = view.getUint32(offset + index * 4);
      }
      for (let index = 16; index < 64; index += 1) {
        const previous15 = words[index - 15];
        const previous2 = words[index - 2];
        const sigma0 = rotateRight(previous15, 7)
          ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
        const sigma1 = rotateRight(previous2, 17)
          ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
        words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
      }

      let [a, b, c, d, e, f, g, h] = state;
      for (let index = 0; index < 64; index += 1) {
        const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
        const choose = (e & f) ^ (~e & g);
        const temp1 = (h + sum1 + choose + SHA256_ROUND[index] + words[index]) >>> 0;
        const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
        const majority = (a & b) ^ (a & c) ^ (b & c);
        const temp2 = (sum0 + majority) >>> 0;
        h = g;
        g = f;
        f = e;
        e = (d + temp1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (temp1 + temp2) >>> 0;
      }
      state[0] = (state[0] + a) >>> 0;
      state[1] = (state[1] + b) >>> 0;
      state[2] = (state[2] + c) >>> 0;
      state[3] = (state[3] + d) >>> 0;
      state[4] = (state[4] + e) >>> 0;
      state[5] = (state[5] + f) >>> 0;
      state[6] = (state[6] + g) >>> 0;
      state[7] = (state[7] + h) >>> 0;
    }
    return state.map(word => word.toString(16).padStart(8, '0')).join('');
  }

  function canonicalFeatureYear(properties) {
    for (const key of YEAR_KEYS) {
      const raw = properties[key];
      if (raw === undefined || raw === null) continue;
      const value = String(raw).trim();
      if (/^(?:18|19|20|21)\d{2}$/.test(value)) return value;
    }
    return null;
  }

  function explicitFeatureIdentity(key, value, properties) {
    const normalized = String(value).trim();
    const year = canonicalFeatureYear(properties);
    return year ? `${key}:${year}:${normalized}` : `${key}:${normalized}`;
  }

  function canonicalFeatureIdentity(feature) {
    const properties = feature && feature.properties && typeof feature.properties === 'object'
      ? feature.properties
      : {};
    if (feature && feature.id !== undefined && feature.id !== null && String(feature.id).trim()) {
      return explicitFeatureIdentity('feature.id', feature.id, properties);
    }
    for (const key of EXPLICIT_ID_KEYS) {
      if (properties[key] !== undefined && properties[key] !== null
          && String(properties[key]).trim()) {
        return explicitFeatureIdentity(key, properties[key], properties);
      }
    }
    return `derived:${sha256(JSON.stringify({
      geometry: feature && feature.geometry,
      properties,
    }))}`;
  }

  function identitiesForPayload(payload) {
    const features = Array.isArray(payload && payload.features) ? payload.features : [];
    return features.map(canonicalFeatureIdentity);
  }

  function assertValidManifest(slug, manifest) {
    const prefix = `[TiledAccidentProvider] invalid manifest for ${slug}`;
    if (!manifest || typeof manifest !== 'object') {
      throw new Error(`${prefix}: expected an object`);
    }
    if (!SUPPORTED_TILE_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
      throw new Error(`${prefix}: unsupported schemaVersion ${manifest.schemaVersion}`);
    }
    if (manifest.city !== slug) {
      throw new Error(`${prefix}: city ${manifest.city} does not match ${slug}`);
    }
    if (!Number.isInteger(manifest.z) || manifest.z < 0 || manifest.z > 22) {
      throw new Error(`${prefix}: z must be an integer from 0 to 22`);
    }
    if (!Number.isInteger(manifest.totalCount) || manifest.totalCount < 0) {
      throw new Error(`${prefix}: totalCount must be a non-negative integer`);
    }
    if (!Array.isArray(manifest.tiles)) {
      throw new Error(`${prefix}: tiles must be an array`);
    }

    const coordinateLimit = Math.pow(2, manifest.z);
    const keys = new Set();
    let declaredTotal = 0;
    manifest.tiles.forEach((tile, index) => {
      if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)
          || tile.x < 0 || tile.x >= coordinateLimit
          || tile.y < 0 || tile.y >= coordinateLimit) {
        throw new Error(`${prefix}: tile ${index} has invalid coordinates`);
      }
      if (!Number.isInteger(tile.count) || tile.count < 0) {
        throw new Error(`${prefix}: tile ${tile.x}/${tile.y} has invalid count`);
      }
      const key = tileKey(tile.x, tile.y);
      if (keys.has(key)) {
        throw new Error(`${prefix}: duplicate tile ${key}`);
      }
      keys.add(key);
      declaredTotal += tile.count;
    });
    if (declaredTotal !== manifest.totalCount) {
      throw new Error(
        `${prefix}: tile counts ${declaredTotal} do not equal totalCount ${manifest.totalCount}`
      );
    }
    return manifest;
  }

  function assertValidTilePayload(slug, manifest, descriptor, payload) {
    const key = descriptor.key;
    const prefix = `[TiledAccidentProvider] invalid tile ${slug}/${manifest.z}/${key}`;
    if (!payload || typeof payload !== 'object') {
      throw new Error(`${prefix}: expected an object`);
    }
    if (payload.schemaVersion !== manifest.schemaVersion
        || !SUPPORTED_TILE_SCHEMA_VERSIONS.includes(payload.schemaVersion)) {
      throw new Error(`${prefix}: schemaVersion does not match manifest`);
    }
    if (payload.city !== slug) {
      throw new Error(`${prefix}: city ${payload.city} does not match ${slug}`);
    }
    if (payload.z !== manifest.z || payload.x !== descriptor.x || payload.y !== descriptor.y) {
      throw new Error(`${prefix}: z/x/y metadata does not match requested tile`);
    }
    if (payload.type !== 'FeatureCollection' || !Array.isArray(payload.features)) {
      throw new Error(`${prefix}: expected a GeoJSON FeatureCollection`);
    }
    if (payload.features.length !== descriptor.count) {
      throw new Error(
        `${prefix}: feature count ${payload.features.length} does not match expectedCount `
        + `${descriptor.count}`
      );
    }
    if (!Array.isArray(payload.featureIdentities)
        || payload.featureIdentities.length !== payload.features.length
        || payload.featureIdentities.some(value => typeof value !== 'string' || !value)) {
      throw new Error(`${prefix}: featureIdentities must match features positionally`);
    }
    const identities = new Set(payload.featureIdentities);
    if (identities.size !== payload.featureIdentities.length) {
      throw new Error(`${prefix}: duplicate feature identity`);
    }
    const expectedIdentities = identitiesForPayload(payload);
    payload.featureIdentities.forEach((identity, index) => {
      if (identity !== expectedIdentities[index]) {
        throw new Error(`${prefix}: feature identity ${index} does not match its feature`);
      }
    });
    return payload;
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
        if (!manifest) return null;
        try {
          return attachIndexes(slug, assertValidManifest(slug, manifest));
        } catch (error) {
          console.warn(String(error && error.message ? error.message : error));
          return null;
        }
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

    function fetchTile(slug, manifest, descriptor) {
      const cache = cityTileCache(slug);
      const { key, x, y } = descriptor;
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
        if (!payload) {
          cache.delete(key);
          return null;
        }
        return assertValidTilePayload(slug, manifest, descriptor, payload);
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
          const payload = await fetchTile(slug, manifest, descriptor);
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
          featureIdentities: Object.freeze(item.payload.featureIdentities.slice()),
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
      if (result.missingTileKeys.length > 0 || result.loaded.length !== descriptors.length) {
        throw new Error(
          `[TiledAccidentProvider] incomplete full-city tile set for ${slug}: missing `
          + `${result.missingTileKeys.join(', ') || 'unknown tiles'}`
        );
      }
      const identities = new Set();
      let featureCount = 0;
      for (const tile of result.loaded) {
        featureCount += tile.featureCollection.features.length;
        for (const identity of tile.featureIdentities) {
          if (identities.has(identity)) {
            throw new Error(
              `[TiledAccidentProvider] duplicate full-city feature identity ${identity} for ${slug}`
            );
          }
          identities.add(identity);
        }
      }
      if (featureCount !== manifest.totalCount || identities.size !== manifest.totalCount) {
        throw new Error(
          `[TiledAccidentProvider] incomplete full-city tile set for ${slug}: expected `
          + `${manifest.totalCount} features, received ${featureCount}`
        );
      }
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
    _assertValidManifest: assertValidManifest,
    _assertValidTilePayload: assertValidTilePayload,
    _mergeFeatureCollections: mergeFeatureCollections,
    _tilesForBounds: tilesForBounds,
    _assertProviderShape: assertProviderShape,
  });

  registerDefaults();
})();
