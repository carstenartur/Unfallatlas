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
    'traffic_measurement_type',
    'traffic_volume_value',
    'traffic_evidence',
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
    hasTrafficEvidence: ['traffic_evidence'],
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

  const tileScheduler = UA.DataBudget.createScheduler(TILE_FETCH_CONCURRENCY);

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

      if (ways && !manifest) {
        ways = Object.fromEntries(Object.entries(ways).map(([id, row]) => [id, limitStoredRoadQuality(row)]));
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

  function limitStoredRoadQuality(row) {
    return UA.elevationProvider?.limitStoredRoadQuality?.(row) || row;
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

  function ingestTile(state, tile) {
    if (!tile || typeof tile !== 'object') return;
    if (!state.ways || typeof state.ways !== 'object') state.ways = {};
    if (!state.geometries || typeof state.geometries !== 'object') state.geometries = {};
    for (const [wayId, row] of Object.entries(tile.ways || {})) {
      if (!(wayId in state.ways)) state.ways[wayId] = limitStoredRoadQuality(row);
    }
    for (const [wayId, geometry] of Object.entries(tile.geometries || {})) {
      if (!(wayId in state.geometries)) state.geometries[wayId] = geometry;
    }
  }

  function fetchTile(state, x, y) {
    if (!state || !state._tileCache) return Promise.resolve(null);
    const key = `${x}/${y}`;
    if (state._tileCache.has(key)) return state._tileCache.get(key);

    const promise = tileScheduler.run(() => requireResources()
      .fetchJson('contextTile', { city: state.slug, x, y }))
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
    const range = UA.SpatialGrid.tileRange(bounds, z);
    const known = state.tileIndex.tileKeySet instanceof Set
      ? state.tileIndex.tileKeySet
      : new Set((state.tileIndex.tiles || []).map(tile => `${tile.x}/${tile.y}`));
    const wanted = range ? [...known].map(key => key.split('/').map(Number))
      .filter(([x, y]) => x >= range.xMin && x <= range.xMax && y >= range.yMin && y <= range.yMax)
      .sort(([ax, ay], [bx, by]) => ax - bx || ay - by) : [];

    return Promise.all(wanted.map(([x, y]) => fetchTile(state, x, y))).then(() => ({
      ways: state.ways,
      geometries: state.geometries,
    }));
  }

  // The published tiles cover road ways. They do not inventory signal or crossing nodes.
  // Only look up IDs attached to accidents in the caller's report area. A tile may
  // contain thousands of unrelated ways and is stored at the way's assigned tile.
  async function matchedRoadEvidence(ctx, points) {
    const ids = new Set();
    for (const point of points) {
      const props = point.props;
      if (props?.road_context_source === 'osm' && /^[1-9]\d{0,15}$/.test(props.matched_way_id)) {
        ids.add(String(props.matched_way_id));
      }
    }
    if (!ids.size) return null;
    const slug = citySlug(ctx.CITY_RAW);
    const state = ctx.contextLayerState?.slug === slug ? ctx.contextLayerState : await load(ctx, slug);
    const index = state.tileIndex;
    const source = index || state.meta?.sources?.osm;
    if ((index && index.citySlug !== slug) || !/^OpenStreetMap\b/i.test(source?.source || '')
        || !/^\d{4}-\d{2}-\d{2}$/.test(source.extractDate)) return null;

    const tiles = new Map();
    for (const id of ids) {
      const location = index?.wayIndex?.[id];
      if (!state.ways?.[id] && Array.isArray(location) && location.length === 2
          && location.every(Number.isInteger) && index.tileKeySet.has(location.join('/'))) {
        tiles.set(location.join('/'), location);
      }
    }
    await Promise.all([...tiles.values()].map(([x, y]) => fetchTile(state, x, y)));
    const ways = [];
    for (const id of [...ids].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
      const row = resolveWay(state, id);
      if (typeof row?.highway !== 'string' || !row.highway) continue;
      const speed = Number(row.maxspeed);
      const lanes = Number(row.lanes);
      ways.push({
        id, highway: row.highway,
        maxspeed: Number.isFinite(speed) && speed > 0 ? speed : null,
        lanes: Number.isInteger(lanes) && lanes > 0 ? lanes : null,
      });
    }
    if (!ways.length) return null;
    const lines = [
      `Für ${ways.length} von ${ids.size} zugeordneten OSM-Wegen liegen Straßenmerkmale im veröffentlichten Stadtdatensatz vor. Die Zuordnung bezieht sich auf die ausgewerteten Unfälle im Ausschnitt.`,
    ];
    for (const [key, label, unit] of [['maxspeed', 'Kartierte Tempolimits', ' km/h'], ['lanes', 'Kartierte Fahrstreifenzahlen', '']]) {
      const counts = new Map();
      for (const way of ways) {
        const value = way[key];
        if (value != null) counts.set(value, (counts.get(value) || 0) + 1);
      }
      const values = [...counts].sort(([a], [b]) => a - b)
        .map(([value, count]) => `${value}${unit} (${count} ${count === 1 ? 'Weg' : 'Wege'})`);
      if (values.length) lines.push(label + ': ' + values.join(', ') + '.');
    }
    lines.push(`Quelle: © OpenStreetMap-Mitwirkende (ODbL 1.0), Datenstand ${source.extractDate}. Die Live-Abfrage für den gesamten Ausschnitt war nicht verfügbar. Ampeln und Querungen sind in diesen Wegdaten nicht erfasst.`);
    return { ways, requestedCount: ids.size, sourceDate: source.extractDate, lines };
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
    matchedRoadEvidence,
    clearCache,
    PER_FEATURE_FIELDS,
  };
})();