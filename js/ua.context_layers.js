(() => {
  'use strict';

  /**
   * js/ua.context_layers.js
   *
   * Lazy loader for the optional "context layers" produced by the CI
   * enrichment step (scripts/enrich_geojson.js). The companion
   * ways_<city>.json + sidecar *.enrichment.meta.json are NOT fetched
   * during the application's startup path — only when the context-layers
   * UI panel is first opened, and even then behind a requestIdleCallback
   * guard so that the map stays responsive.
   *
   * The module is intentionally side-effect-free at load time. None of
   * the existing modules (ua.data_v2, ua.filters, ua.map_v2,
   * ua.export_v2, ua.report_v2) depend on it; reading the optional
   * per-feature enrichment fields (e.g. props.elevation_m) is a free
   * `?.` away wherever a renderer wants them.
   *
   * Public API:
   *   UA.contextLayers.detect(geojson)  → { availableFields[], hasDicts }
   *   UA.contextLayers.load(cityRaw)    → Promise<{ ways, meta, dicts }>
   *                                        (idempotent; cached per city)
   *   UA.contextLayers.resolveWay(state, wayId) → resolved way attrs
   *                                                with categorical
   *                                                int-codes mapped back
   *                                                to strings via dicts.
   */

  const UA = (window.UA = window.UA || {});

  // Per-feature fields the loader probes on a sample of features to
  // decide which UI toggles to render. Mirrors PER_FEATURE_FIELDS in
  // scripts/enrich_geojson.js.
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

  const SAMPLE_SIZE = 200; // enough to detect rare fields without
                           //  paying a full-pass cost on hot paths.

  function detect(geojson) {
    const out = { availableFields: [], hasDicts: false };
    if (!geojson || !Array.isArray(geojson.features)) return out;
    out.hasDicts = !!(geojson.properties && geojson.properties.enrichmentDicts);

    const seen = new Set();
    const feats = geojson.features;
    const stride = Math.max(1, Math.floor(feats.length / SAMPLE_SIZE));
    for (let i = 0; i < feats.length && seen.size < PER_FEATURE_FIELDS.length; i += stride) {
      const p = feats[i] && feats[i].properties;
      if (!p) continue;
      for (const f of PER_FEATURE_FIELDS) if (p[f] !== undefined) seen.add(f);
    }
    out.availableFields = PER_FEATURE_FIELDS.filter(f => seen.has(f));
    return out;
  }

  // Field groupings that drive the four high-level capability flags.
  // Kept here (next to PER_FEATURE_FIELDS / detect) so adding a new
  // context field is a one-line change in this module instead of
  // touching the data loader, the popup renderer and every test in
  // parallel.
  const CAPABILITY_FIELDS = {
    hasElevation:    ['elevation_m'],
    hasSlope:        ['slope_percent', 'slope_abs_percent', 'slope_class', 'slope_source', 'slope_confidence'],
    hasOsmContext:   ['matched_way_id', 'highway', 'maxspeed', 'lanes', 'surface', 'cycleway', 'osm_incline', 'road_slope_percent', 'road_context_source'],
    hasTrafficProxy: ['traffic_proxy_class'],
  };

  /**
   * Derive the high-level capability flags consumed by the UI (popup,
   * future panel, future filters) from a `detect()` result. Single
   * source of truth — the data loader, the popup renderer and the
   * tests all go through this helper so adding a field never drifts
   * between layers.
   *
   * @param {{ availableFields?: string[] }|null|undefined} detection
   * @returns {{ hasElevation:boolean, hasSlope:boolean, hasOsmContext:boolean, hasTrafficProxy:boolean, hasAny:boolean }}
   */
  function capabilitiesFromDetection(detection) {
    const available = new Set((detection && detection.availableFields) || []);
    const caps = {};
    let hasAny = false;
    for (const flag of Object.keys(CAPABILITY_FIELDS)) {
      const present = CAPABILITY_FIELDS[flag].some(f => available.has(f));
      caps[flag] = present;
      if (present) hasAny = true;
    }
    caps.hasAny = hasAny;
    return caps;
  }

  // Cache: cityKey → Promise<state>
  const cache = new Map();

  // Schema-version negotiation. The on-disk `ways_<city>.json` payload
  // ships with `schemaVersion` since v2 (the legacy v1 flat shape has
  // no version field at all and is detected by the absence of a
  // `ways` map — see the load() body). When a future producer bumps
  // the schema (e.g. to v3), older deployments must FAIL LOUD instead
  // of silently rendering an inconsistent half-state. The constant is
  // a single source of truth for both the loader and the test suite.
  const SUPPORTED_WAYS_SCHEMA_VERSIONS = [1, 2, 3];
  // Track which slugs have already produced an "unsupported version"
  // warning so we never spam the console — one warning per city is
  // enough to surface the regression on the operator's screen.
  const _warnedUnsupportedSchema = new Set();

  // Z=13 slippy-tile zoom — must match CTX_TILE_ZOOM in
  // scripts/enrich_geojson.js. The browser-side loader recomputes the
  // tile coords from the (manifest-stamped) zoom, but we keep the
  // constant local as the default for older manifests / unit tests
  // that don't carry the field.
  const CTX_TILE_DEFAULT_ZOOM = 13;

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

  function urls(cityRaw) {
    const slug = (UA.normKey ? UA.normKey(cityRaw) : String(cityRaw || '').toLowerCase());
    return {
      slug,
      // Use central path registry when available (ua.data_paths.js).
      ways: (UA.DataPaths && typeof UA.DataPaths.contextWays === 'function')
        ? UA.DataPaths.contextWays(slug)
        : `out/ways_${slug}.json`,
      meta: (UA.DataPaths && typeof UA.DataPaths.enrichmentMeta === 'function')
        ? UA.DataPaths.enrichmentMeta(slug)
        : `out/output_all_years_${slug}.enrichment.meta.json`,
    };
  }

  function _tileIndexUrlFromMetaPath(p) {
    if (typeof p !== 'string') return null;
    const trimmed = p.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
    if (!trimmed) return null;
    if (/^(https?:)?\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('out/')) return trimmed;
    return `out/${trimmed}`;
  }

  function _attachTileUrlIndex(manifest, tileIndexUrl) {
    if (!manifest || typeof manifest !== 'object') return manifest;
    const root = (typeof tileIndexUrl === 'string' && tileIndexUrl)
      ? tileIndexUrl.replace(/\/[^/]*$/, '')
      : null;
    const byKey = new Map();
    for (const t of (manifest.tiles || [])) {
      if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
      const key = `${t.x}/${t.y}`;
      byKey.set(key, root ? `${root}/${t.x}/${t.y}.json` : key);
    }
    manifest.tileUrlByKey = byKey;
    manifest.tileKeySet = new Set(byKey.keys());
    return manifest;
  }

  /**
   * Lazily fetch ways_<city>.json + *.enrichment.meta.json. Cached per
   * city. Both files are optional — if either 404s, the corresponding
   * field of the returned state is null and the panel falls back to
   * what the per-feature properties already carry.
   *
   * @param {object} ctx          Application context (for dicts lookup;
   *                              dicts are read from
   *                              `ctx.geojsonProps?.enrichmentDicts` —
   *                              i.e. the parsed FC.properties stashed
   *                              by the loader at fetch time. As a
   *                              compatibility fallback, an explicit
   *                              `ctx.enrichmentDicts` is also
   *                              accepted.)
   * @param {string} cityRaw      Raw city name (e.g. "Bonn").
   */
  function load(ctx, cityRaw) {
    const u = urls(cityRaw);
    if (cache.has(u.slug)) return cache.get(u.slug);

    const p = (async () => {
      // Use UA.fetchJsonCompressed (loads .gz variant automatically) when available;
      // fall back to direct fetch for backwards compatibility.
      const _fetchJson = (typeof UA.fetchJsonCompressed === 'function')
        ? url => UA.fetchJsonCompressed(url, { cache: 'force-cache' }).catch(() => null)
        : url => fetch(url, { cache: 'force-cache' })
                    .then(r => r && r.ok ? r.json().catch(() => null) : null)
                    .catch(() => null);

      const [raw, meta] = await Promise.all([
        _fetchJson(u.ways),
        _fetchJson(u.meta),
      ]);
      const dicts = (ctx && (ctx.geojsonProps?.enrichmentDicts || ctx.enrichmentDicts)) || null;
      const metaSchemaVersion = (meta && Number.isFinite(meta.schemaVersion)) ? Number(meta.schemaVersion) : null;
      const metaTileIndexUrl = _tileIndexUrlFromMetaPath(meta && meta.tileIndexPath);
      const shouldUseMetaV3 = !!(metaSchemaVersion != null && metaSchemaVersion >= 3 && metaTileIndexUrl);

      // ways_<city>.json supports two shapes:
      //   v2 (current): { schemaVersion: 2, ways: {…}, geometries: {…} }
      //   v1 (legacy):  { "<wayId>": {attrs}, ... }
      // The v2 shape is a strict superset; v1 is detected by the
      // absence of a `ways` map and the presence of object values.
      //
      // Schema-version negotiation: when `schemaVersion` is set but
      // unknown to this build (e.g. the producer ships v3 before the
      // front-end is updated), we fail loudly with a single console
      // warning per city and treat the file as missing — the popup
      // and overlays then degrade gracefully instead of half-rendering
      // an inconsistent state. v1 (no `schemaVersion` field) is
      // explicitly accepted via SUPPORTED_WAYS_SCHEMA_VERSIONS.
      let ways = null, geometries = null;
      let coverage = null;
      let tileIndex = null;
      let tileIndexUrl = null;
      if (raw && typeof raw === 'object') {
        const declaredVer = (typeof raw.schemaVersion === 'number')
          ? raw.schemaVersion
          : (raw.ways && typeof raw.ways === 'object' ? null : 1);
        if (declaredVer != null && !SUPPORTED_WAYS_SCHEMA_VERSIONS.includes(declaredVer)) {
          if (!_warnedUnsupportedSchema.has(u.slug)) {
            _warnedUnsupportedSchema.add(u.slug);
            console.warn(
              `[ua.context_layers] ways_${u.slug}.json schemaVersion=${declaredVer} ` +
              `is not in SUPPORTED_WAYS_SCHEMA_VERSIONS=${JSON.stringify(SUPPORTED_WAYS_SCHEMA_VERSIONS)} — ` +
              `front-end likely outdated; context overlays will be disabled for this city.`
            );
          }
          return { slug: u.slug, ways: null, geometries: null, meta, dicts };
        }
        if (declaredVer === 3) {
          // v3 envelope: thin pointer to per-tile context payloads.
          // The browser only fetches tiles intersecting the current
          // map viewport via `loadTilesForBbox`. `state.ways` /
          // `state.geometries` start empty and are populated lazily
          // from each loaded tile so the existing road-overlay /
          // popup code paths keep working unchanged on the merged
          // state.
          coverage     = raw.coverage || 'full';
          tileIndexUrl = (typeof raw.tileIndexUrl === 'string')
            ? raw.tileIndexUrl
            : ((UA.DataPaths && typeof UA.DataPaths.contextTileIndex === 'function')
                ? UA.DataPaths.contextTileIndex(u.slug)
                : `out/ctxtiles/${u.slug}/index.json`);
          ways         = {};
          geometries   = {};
          // Eagerly fetch the (small) manifest so the popup hydration
          // path can resolve a wayId → tile coordinates without an
          // extra round-trip per popup. The per-tile payloads remain
          // lazy.
          try {
            const manifest = await _fetchJson(tileIndexUrl);
            if (manifest && typeof manifest === 'object') {
              tileIndex = manifest;
            }
          } catch (_) { /* manifest optional — degrades gracefully */ }
        } else if (raw.ways && typeof raw.ways === 'object') {
          ways = raw.ways;
          geometries = (raw.geometries && typeof raw.geometries === 'object')
            ? raw.geometries : null;
        } else {
          // Legacy flat shape — every top-level value is a per-way attrs object.
          ways = raw;
        }
      }
      // Sidecar-driven v3 mode: if the sidecar says schema>=3 and points
      // at a tile manifest, prefer that even when ways_<slug>.json is a
      // legacy v1/v2 payload. This keeps deploys resilient when the sidecar
      // and ways file are temporarily out of sync.
      if (shouldUseMetaV3) {
        coverage = coverage || 'full';
        tileIndexUrl = metaTileIndexUrl;
        ways = {};
        geometries = {};
      }
      if (tileIndexUrl && (!ways || !geometries)) {
        if (!ways || typeof ways !== 'object') ways = {};
        if (!geometries || typeof geometries !== 'object') geometries = {};
      }
      if (tileIndexUrl && !tileIndex) {
        try {
          const manifest = await _fetchJson(tileIndexUrl);
          if (manifest && typeof manifest === 'object') tileIndex = manifest;
        } catch (_) { /* manifest optional — degrades gracefully */ }
      }
      // Prefer the dicts shipped with the tile manifest over the
      // per-FeatureCollection dicts: in v3 the per-tile attrs are
      // int-coded against the tile-manifest dicts (a superset of
      // anything the FC contains).
      tileIndex = _attachTileUrlIndex(tileIndex, tileIndexUrl);
      const effectiveDicts = (tileIndex && tileIndex.dicts) || dicts;
      return {
        slug: u.slug,
        ways, geometries, meta,
        dicts: effectiveDicts,
        coverage,
        tileIndex,
        tileIndexUrl,
        // Per-tile cache: "x/y" → Promise<{ways,geometries}>. Initialised
        // lazily so v1/v2 loads pay zero overhead.
        _tileCache: tileIndex ? new Map() : null,
      };
    })();

    cache.set(u.slug, p);
    return p;
  }

  /** Schedule load() at idle; resolves to the state immediately if
   *  requestIdleCallback is unavailable. */
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

  /** Resolve int-coded categorical fields on a way row back to strings
   *  via the dictionaries baked into the FeatureCollection. Pure; safe
   *  to call repeatedly. Returns a new object — never mutates input. */
  function resolveWay(state, wayId) {
    const w = state && state.ways && state.ways[wayId];
    if (!w) return null;
    const dicts = (state && state.dicts) || {};
    const out = {};
    for (const k of Object.keys(w)) {
      const dict = dicts[k];
      const v = w[k];
      out[k] = (Array.isArray(dict) && Number.isInteger(v) && v >= 0 && v < dict.length) ? dict[v] : v;
    }
    return out;
  }

  function clearCache() { cache.clear(); }

  // ---------------------------------------------------------------------
  // v3 tile-bbox loading (full-network coverage)
  //
  // The v3 envelope only carries a manifest pointer; the per-way attrs
  // and geometries live in per-Z/X/Y tile files. `loadTilesForBbox`
  // computes the tiles intersecting `bounds`, fetches the missing ones
  // (in-flight dedup via the per-state `_tileCache`), and merges them
  // into `state.ways` / `state.geometries` so the existing
  // `UA.contextRoadLayer.buildLayer` and `UA.contextLayers.resolveWay`
  // codepaths keep working unchanged.
  //
  // For v1/v2 inputs `loadTilesForBbox` is a no-op that resolves to the
  // already-loaded full state, so call sites don't need to branch.
  // ---------------------------------------------------------------------

  function _tilesForLeafletBounds(bounds, z) {
    if (!bounds) return [];
    let south, north, west, east;
    if (typeof bounds.getSouth === 'function') {
      south = bounds.getSouth(); north = bounds.getNorth();
      west  = bounds.getWest();  east  = bounds.getEast();
    } else if (Array.isArray(bounds) && bounds.length === 4) {
      // [south, west, north, east]
      [south, west, north, east] = bounds;
    } else if (bounds && typeof bounds === 'object') {
      south = bounds.south; north = bounds.north;
      west  = bounds.west;  east  = bounds.east;
    }
    if (!Number.isFinite(south) || !Number.isFinite(north) ||
        !Number.isFinite(west)  || !Number.isFinite(east)) return [];
    const xMin = _lonToTileX(Math.min(west, east), z);
    const xMax = _lonToTileX(Math.max(west, east), z);
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

  function _tileUrl(state, x, y) {
    if (state && state.tileIndex && state.tileIndex.tileUrlByKey instanceof Map) {
      const fromMap = state.tileIndex.tileUrlByKey.get(`${x}/${y}`);
      if (fromMap) return fromMap;
    }
    // Manifest URL is e.g. "out/ctxtiles/<slug>/index.json" → strip
    // the trailing /index.json segment to get the tile root.
    const manUrl = state && state.tileIndexUrl;
    if (typeof manUrl !== 'string' || !manUrl) return null;
    const root = manUrl.replace(/\/[^/]*$/, '');
    return `${root}/${x}/${y}.json`;
  }

  function _ingestTile(state, tile) {
    if (!tile || typeof tile !== 'object') return;
    if (tile.ways && typeof tile.ways === 'object') {
      for (const wayId of Object.keys(tile.ways)) {
        if (!(wayId in state.ways)) state.ways[wayId] = tile.ways[wayId];
      }
    }
    if (tile.geometries && typeof tile.geometries === 'object') {
      for (const wayId of Object.keys(tile.geometries)) {
        if (!(wayId in state.geometries)) state.geometries[wayId] = tile.geometries[wayId];
      }
    }
  }

  function _fetchTile(state, x, y) {
    const cacheMap = state._tileCache;
    const key = `${x}/${y}`;
    if (cacheMap.has(key)) return cacheMap.get(key);
    const url = _tileUrl(state, x, y);
    if (!url) return Promise.resolve(null);
    // On a transient failure (network blip, 5xx, partial deploy, JSON
    // parse error) we drop the cache entry so a later overlay rebuild
    // or popup hydration can retry — otherwise the first failed fetch
    // would permanently disable the tile for the rest of the session.
    const p = (async () => {
      let json = null;
      // Prefer UA.fetchJsonCompressed (loads .gz variant automatically) when available.
      if (typeof UA.fetchJsonCompressed === 'function') {
        try { json = await UA.fetchJsonCompressed(url, { cache: 'force-cache' }); }
        catch (_) { cacheMap.delete(key); return null; }
      } else {
        let resp;
        try { resp = await fetch(url, { cache: 'force-cache' }); }
        catch (_) { cacheMap.delete(key); return null; }
        if (!resp || !resp.ok) { cacheMap.delete(key); return null; }
        try { json = await resp.json(); } catch (_) { cacheMap.delete(key); return null; }
      }
      _ingestTile(state, json);
      return json;
    })();
    cacheMap.set(key, p);
    return p;
  }

  /**
   * Lazily fetch the per-tile context payloads intersecting `bounds`,
   * merge them into `state.ways` / `state.geometries`, and resolve
   * once every tile has been ingested. v1/v2 states resolve immediately
   * with the already-loaded data — call sites don't branch.
   *
   * @param {object} state              result of UA.contextLayers.load()
   * @param {L.LatLngBounds|object} bounds
   * @returns {Promise<{ways:object,geometries:object}>}
   */
  function loadTilesForBbox(state, bounds) {
    if (!state) return Promise.resolve({ ways: {}, geometries: {} });
    if (!state.tileIndex || !state._tileCache) {
      // v1/v2 state — already fully loaded.
      return Promise.resolve({
        ways:       state.ways || {},
        geometries: state.geometries || {},
      });
    }
    const z = (typeof state.tileIndex.z === 'number') ? state.tileIndex.z : CTX_TILE_DEFAULT_ZOOM;
    const want = _tilesForLeafletBounds(bounds, z);
    if (want.length === 0) {
      return Promise.resolve({ ways: state.ways, geometries: state.geometries });
    }
    // Limit to tiles the manifest actually lists — saves a round-trip
    // per empty area (e.g. when the user pans out over the sea).
    const known = new Set(
      (state.tileIndex.tiles || []).map(t => `${t.x}/${t.y}`)
    );
    const fetches = [];
    for (const [x, y] of want) {
      if (!known.has(`${x}/${y}`)) continue;
      fetches.push(_fetchTile(state, x, y));
    }
    return Promise.all(fetches).then(() => ({
      ways:       state.ways,
      geometries: state.geometries,
    }));
  }

  /**
   * Resolve a wayId across all loaded tiles. If the way isn't in the
   * already-loaded `state.ways` AND the manifest knows which tile it
   * lives in, kick off a fetch for that tile (fire-and-forget — the
   * popup re-renders when the tile arrives via the same race-tolerant
   * path the legacy hydration uses).
   *
   * Returns the resolved attrs **synchronously** when available, or
   * `null` otherwise.
   *
   * @param {object} state
   * @param {string} wayId
   * @returns {object|null}
   */
  function resolveWayAcrossTiles(state, wayId) {
    if (!state || !wayId) return null;
    const direct = resolveWay(state, wayId);
    if (direct) return direct;
    // v3: consult manifest's reverse index → trigger the (single) tile
    // fetch so the next popup open finds the way.
    const idx = state.tileIndex && state.tileIndex.wayIndex && state.tileIndex.wayIndex[wayId];
    if (Array.isArray(idx) && idx.length === 2 && state._tileCache) {
      const [x, y] = idx;
      // fire-and-forget; popup renderer re-runs after re-render
      try { _fetchTile(state, x, y); } catch (_) { /* noop */ }
    }
    return null;
  }

  UA.contextLayers = {
    detect,
    capabilitiesFromDetection,
    CAPABILITY_FIELDS,
    SUPPORTED_WAYS_SCHEMA_VERSIONS,
    CTX_TILE_DEFAULT_ZOOM,
    load,
    loadAtIdle,
    loadTilesForBbox,
    resolveWay,
    resolveWayAcrossTiles,
    clearCache,
    PER_FEATURE_FIELDS,
  };
})();
