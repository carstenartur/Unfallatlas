(() => {
  'use strict';

  /**
   * Lazy context-data loader.
   *
   * All static resource names, cache modes and compression rules are owned by
   * UA.DataResources. This module only interprets the returned schemas and
   * maintains the in-memory tile cache.
   */

  const UA = (window.UA = window.UA || {});

  const PER_FEATURE_FIELDS = [
    'matched_way_id',
    'road_context_source',
    'elevation_m',
    'slope_percent',
    'slope_abs_percent',
    'slope_class',
    'slope_source',
    'slope_confidence',
    'traffic_proxy_class',
    'highway',
    'maxspeed',
    'lanes',
    'surface',
    'cycleway',
    'osm_incline',
    'road_slope_percent',
  ];

  const SAMPLE_SIZE = 200;
  const SUPPORTED_WAYS_SCHEMA_VERSIONS = [1, 2, 3];
  const CTX_TILE_DEFAULT_ZOOM = 13;
  const TILE_FETCH_CONCURRENCY = 6;
  const cache = new Map();
  const warnedUnsupportedSchema = new Set();

  const CAPABILITY_FIELDS = {
    hasElevation: ['elevation_m'],
    hasSlope: ['slope_percent', 'slope_abs_percent', 'slope_class', 'slope_source', 'slope_confidence'],
    hasOsmContext: ['matched_way_id', 'highway', 'maxspeed', 'lanes', 'surface', 'cycleway', 'osm_incline', 'road_slope_percent', 'road_context_source'],
    hasTrafficProxy: ['traffic_proxy_class'],
  };

  function requireResources() {
    if (!UA.DataResources || typeof UA.DataResources.fetchJson !== 'function') {
      throw new Error('[ua.context_layers] UA.DataResources must be loaded before context layers');
    }
    return UA.DataResources;
  }

  function citySlug(cityRaw) {
    return UA.normKey
      ? UA.normKey(cityRaw)
      : String(cityRaw || '').toLowerCase().trim();
  }

  function detect(geojson) {
    const out = { availableFields: [], hasDicts: false };
    if (!geojson || !Array.isArray(geojson.features)) return out;
    out.hasDicts = !!(geojson.properties && geojson.properties.enrichmentDicts);

    const seen = new Set();
    const features = geojson.features;
    const stride = Math.max(1, Math.floor(features.length / SAMPLE_SIZE));
    for (let i = 0; i < features.length && seen.size < PER_FEATURE_FIELDS.length; i += stride) {
      const properties = features[i] && features[i].properties;
      if (!properties) continue;
      for (const field of PER_FEATURE_FIELDS) {
        if (properties[field] !== undefined) seen.add(field);
      }
    }
    out.availableFields = PER_FEATURE_FIELDS.filter(field => seen.has(field));
    return out;
  }

  function capabilitiesFromDetection(detection) {
    const available = new Set((detection && detection.availableFields) || []);
    const result = {};
    let hasAny = false;
    for (const flag of Object.keys(CAPABILITY_FIELDS)) {
      result[flag] = CAPABILITY_FIELDS[flag].some(field => available.has(field));
      hasAny = hasAny || result[flag];
    }
    result.hasAny = hasAny;
    return result;
  }

  function lonToTileX(lon, z) {
    return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
  }

  function latToTileY(lat, z) {
    const radians = (lat * Math.PI) / 180;
    return Math.floor(
      ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2)
      * Math.pow(2, z)
    );
  }

  function tileIndexUrl(slug) {
    return requireResources().url('contextTileIndex', { city: slug });
  }

  function isExternalUrl(value) {
    return typeof value === 'string' && /^(?:https?:)?\/\//i.test(value.trim());
  }

  function declaredTileIndexUrl(slug, raw, meta) {
    const candidate = raw && typeof raw.tileIndexUrl === 'string'
      ? raw.tileIndexUrl
      : (meta && typeof meta.tileIndexPath === 'string' ? meta.tileIndexPath : null);
    // Relative producer paths are implementation details and map to the single
    // canonical registry resource. Only an explicit external URL is preserved.
    return isExternalUrl(candidate) ? candidate.trim() : tileIndexUrl(slug);
  }

  async function fetchManifest(slug, url) {
    const resources = requireResources();
    if (!isExternalUrl(url)) {
      return resources.fetchJson('contextTileIndex', { city: slug }, { optional: true });
    }
    return resources.fetchJsonUrl(url, {
      optional: true,
      cache: 'force-cache',
      compression: resources.COMPRESSION.GZIP_PREFERRED,
    });
  }

  function attachTileIndexes(manifest, slug) {
    if (!manifest || typeof manifest !== 'object') return manifest;
    const resources = requireResources();
    const urlByKey = new Map();
    const keySet = new Set();
    for (const tile of (manifest.tiles || [])) {
      if (!tile || !Number.isFinite(tile.x) || !Number.isFinite(tile.y)) continue;
      const key = `${tile.x}/${tile.y}`;
      keySet.add(key);
      urlByKey.set(key, resources.url('contextTile', {
        city: slug,
        x: tile.x,
        y: tile.y,
      }));
    }
    manifest.tileUrlByKey = urlByKey;
    manifest.tileKeySet = keySet;
    return manifest;
  }

  function unsupportedState(slug, meta, dicts, version) {
    if (!warnedUnsupportedSchema.has(slug)) {
      warnedUnsupportedSchema.add(slug);
      console.warn(
        `[ua.context_layers] context ways schemaVersion=${version} is not supported; `
        + `supported=${JSON.stringify(SUPPORTED_WAYS_SCHEMA_VERSIONS)}; city=${slug}`
      );
    }
    return {
      slug,
      ways: null,
      geometries: null,
      meta,
      dicts,
      coverage: null,
      tileIndex: null,
      tileIndexUrl: null,
      _tileCache: null,
    };
  }

  function load(ctx, cityRaw) {
    const slug = citySlug(cityRaw);
    if (cache.has(slug)) return cache.get(slug);

    const promise = (async () => {
      const resources = requireResources();
      const [raw, meta] = await Promise.all([
        resources.fetchJson('contextWays', { city: slug }, { optional: true }),
        resources.fetchJson('enrichmentMeta', { city: slug }, { optional: true }),
      ]);
      const fallbackDicts = (ctx && (ctx.geojsonProps?.enrichmentDicts || ctx.enrichmentDicts)) || null;

      let ways = null;
      let geometries = null;
      let coverage = null;
      let manifest = null;
      let manifestUrl = null;

      if (raw && typeof raw === 'object') {
        const declaredVersion = typeof raw.schemaVersion === 'number'
          ? raw.schemaVersion
          : (raw.ways && typeof raw.ways === 'object' ? null : 1);

        if (declaredVersion != null && !SUPPORTED_WAYS_SCHEMA_VERSIONS.includes(declaredVersion)) {
          return unsupportedState(slug, meta, fallbackDicts, declaredVersion);
        }

        if (declaredVersion === 3) {
          coverage = raw.coverage || 'full';
          ways = {};
          geometries = {};
          manifestUrl = declaredTileIndexUrl(slug, raw, meta);
          manifest = await fetchManifest(slug, manifestUrl);
        } else if (raw.ways && typeof raw.ways === 'object') {
          ways = raw.ways;
          geometries = raw.geometries && typeof raw.geometries === 'object'
            ? raw.geometries
            : null;
        } else {
          ways = raw;
        }
      }

      const sidecarRequestsV3 = !!(
        meta
        && Number(meta.schemaVersion) >= 3
        && typeof meta.tileIndexPath === 'string'
      );
      if (sidecarRequestsV3) {
        coverage = coverage || 'full';
        ways = {};
        geometries = {};
        manifestUrl = declaredTileIndexUrl(slug, raw, meta);
        if (!manifest) manifest = await fetchManifest(slug, manifestUrl);
      }

      manifest = attachTileIndexes(manifest, slug);
      const dicts = (manifest && manifest.dicts) || fallbackDicts;
      return {
        slug,
        ways,
        geometries,
        meta,
        dicts,
        coverage,
        tileIndex: manifest,
        tileIndexUrl: manifestUrl,
        _tileCache: manifest ? new Map() : null,
      };
    })();

    cache.set(slug, promise);
    promise.catch(() => cache.delete(slug));
    return promise;
  }

  function loadAtIdle(ctx, cityRaw) {
    return new Promise(resolve => {
      const fire = () => resolve(load(ctx, cityRaw));
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(fire, { timeout: 1500 });
      } else {
        setTimeout(fire, 0);
      }
    });
  }

  function resolveWay(state, wayId) {
    const row = state && state.ways && state.ways[wayId];
    if (!row) return null;
    const dicts = (state && state.dicts) || {};
    const result = {};
    for (const field of Object.keys(row)) {
      const value = row[field];
      const dictionary = dicts[field];
      result[field] = Array.isArray(dictionary)
        && Number.isInteger(value)
        && value >= 0
        && value < dictionary.length
        ? dictionary[value]
        : value;
    }
    return result;
  }

  function clearCache() {
    cache.clear();
  }

  function tilesForBounds(bounds, z) {
    if (!bounds) return [];
    let south;
    let north;
    let west;
    let east;
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

    const xMin = lonToTileX(Math.min(west, east), z);
    const xMax = lonToTileX(Math.max(west, east), z);
    const yMin = latToTileY(Math.max(south, north), z);
    const yMax = latToTileY(Math.min(south, north), z);
    const result = [];
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) result.push([x, y]);
    }
    return result;
  }

  function ingestTile(state, tile) {
    if (!tile || typeof tile !== 'object') return;
    if (!state.ways || typeof state.ways !== 'object') state.ways = {};
    if (!state.geometries || typeof state.geometries !== 'object') state.geometries = {};
    for (const [wayId, row] of Object.entries(tile.ways || {})) {
      if (!(wayId in state.ways)) state.ways[wayId] = row;
    }
    for (const [wayId, geometry] of Object.entries(tile.geometries || {})) {
      if (!(wayId in state.geometries)) state.geometries[wayId] = geometry;
    }
  }

  function fetchTile(state, x, y) {
    if (!state || !state._tileCache) return Promise.resolve(null);
    const key = `${x}/${y}`;
    if (state._tileCache.has(key)) return state._tileCache.get(key);

    const promise = requireResources()
      .fetchJson('contextTile', { city: state.slug, x, y })
      .then(tile => {
        ingestTile(state, tile);
        return tile;
      })
      .catch(error => {
        state._tileCache.delete(key);
        console.warn(
          `[ua.context_layers] context tile load failed for ${state.slug}/${key}: `
          + String(error && error.message ? error.message : error)
        );
        return null;
      });
    state._tileCache.set(key, promise);
    return promise;
  }

  async function runLimited(tasks, limit) {
    const count = Math.max(1, Math.min(Number(limit) || TILE_FETCH_CONCURRENCY, tasks.length || 1));
    let next = 0;
    const workers = Array.from({ length: count }, async () => {
      while (next < tasks.length) {
        const current = next++;
        await tasks[current]();
      }
    });
    await Promise.all(workers);
  }

  function loadTilesForBbox(state, bounds) {
    if (!state) return Promise.resolve({ ways: {}, geometries: {} });
    if (!state.tileIndex || !state._tileCache) {
      return Promise.resolve({
        ways: state.ways || {},
        geometries: state.geometries || {},
      });
    }

    const z = typeof state.tileIndex.z === 'number'
      ? state.tileIndex.z
      : CTX_TILE_DEFAULT_ZOOM;
    const wanted = tilesForBounds(bounds, z);
    const known = state.tileIndex.tileKeySet instanceof Set
      ? state.tileIndex.tileKeySet
      : new Set((state.tileIndex.tiles || []).map(tile => `${tile.x}/${tile.y}`));
    const tasks = wanted
      .filter(([x, y]) => known.has(`${x}/${y}`))
      .map(([x, y]) => () => fetchTile(state, x, y));

    return runLimited(tasks, TILE_FETCH_CONCURRENCY).then(() => ({
      ways: state.ways,
      geometries: state.geometries,
    }));
  }

  function resolveWayAcrossTiles(state, wayId) {
    if (!state || !wayId) return null;
    const direct = resolveWay(state, wayId);
    if (direct) return direct;
    if (UA._suppressContextTileFetchDuringRender) return null;

    const coordinates = state.tileIndex
      && state.tileIndex.wayIndex
      && state.tileIndex.wayIndex[wayId];
    if (Array.isArray(coordinates) && coordinates.length === 2 && state._tileCache) {
      try { fetchTile(state, coordinates[0], coordinates[1]); } catch (_) { /* noop */ }
    }
    return null;
  }

  UA.contextLayers = {
    detect,
    capabilitiesFromDetection,
    CAPABILITY_FIELDS,
    SUPPORTED_WAYS_SCHEMA_VERSIONS,
    CTX_TILE_DEFAULT_ZOOM,
    TILE_FETCH_CONCURRENCY,
    load,
    loadAtIdle,
    loadTilesForBbox,
    resolveWay,
    resolveWayAcrossTiles,
    clearCache,
    PER_FEATURE_FIELDS,
  };
})();