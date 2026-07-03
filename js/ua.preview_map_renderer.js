(() => {
  const UA = (window.UA = window.UA || {});

  // ---------------------------------------------------------------------------
  // Context tile performance guards
  // ---------------------------------------------------------------------------
  // This file is loaded after ua.context_layers.js and before ua.map_v2.js in
  // werkbank_v2.html. That makes it a safe place for lightweight guards that
  // improve the v3 context-tile runtime without changing the public API:
  //
  // 1. loadTilesForBbox no longer rebuilds a huge Set from manifest.tiles on
  //    every viewport refresh; it reuses/caches tileIndex.tileKeySet.
  // 2. context tile requests are concurrency-limited so a zoomed-out viewport
  //    cannot start a large JSON parse/network storm in one frame.
  // 3. marker rendering suppresses resolveWayAcrossTiles fire-and-forget tile
  //    fetches. Popups can still use already-loaded tile data, but renderLayers
  //    itself no longer triggers background tile loads for every visible marker.
  (function installContextTilePerformanceGuards() {
    const cl = UA.contextLayers;
    if (!cl || cl._contextTilePerformanceGuards) return;

    const TILE_FETCH_CONCURRENCY = 6;
    const CTX_TILE_DEFAULT_ZOOM = cl.CTX_TILE_DEFAULT_ZOOM || 13;
    const originalResolveWayAcrossTiles = cl.resolveWayAcrossTiles;
    const originalLoadTilesForBbox = cl.loadTilesForBbox;

    function lonToTileX(lon, z) {
      return Math.floor(((lon + 180) / 360) * Math.pow(2, z));
    }

    function latToTileY(lat, z) {
      const rad = (lat * Math.PI) / 180;
      return Math.floor(
        ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) *
          Math.pow(2, z)
      );
    }

    function tilesForBounds(bounds, z) {
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
      const xMin = lonToTileX(Math.min(west, east), z);
      const xMax = lonToTileX(Math.max(west, east), z);
      const yMin = latToTileY(Math.max(south, north), z);
      const yMax = latToTileY(Math.min(south, north), z);
      const out = [];
      for (let x = xMin; x <= xMax; x++) {
        for (let y = yMin; y <= yMax; y++) out.push([x, y]);
      }
      return out;
    }

    function ensureTileIndexes(tileIndex, tileIndexUrl) {
      if (!tileIndex || typeof tileIndex !== 'object') return { keySet: new Set(), urlByKey: new Map() };
      const root = (typeof tileIndexUrl === 'string' && tileIndexUrl)
        ? tileIndexUrl.replace(/\/[^/]*$/, '')
        : null;
      let keySet = tileIndex.tileKeySet instanceof Set ? tileIndex.tileKeySet : null;
      let urlByKey = tileIndex.tileUrlByKey instanceof Map ? tileIndex.tileUrlByKey : null;
      if (keySet && urlByKey) return { keySet, urlByKey };
      keySet = keySet || new Set();
      urlByKey = urlByKey || new Map();
      for (const t of (tileIndex.tiles || [])) {
        if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
        const key = `${t.x}/${t.y}`;
        keySet.add(key);
        if (!urlByKey.has(key)) {
          urlByKey.set(key, root ? `${root}/${t.x}/${t.y}.json` : key);
        }
      }
      tileIndex.tileKeySet = keySet;
      tileIndex.tileUrlByKey = urlByKey;
      return { keySet, urlByKey };
    }

    function tileUrl(state, x, y) {
      const idx = ensureTileIndexes(state && state.tileIndex, state && state.tileIndexUrl);
      const fromMap = idx.urlByKey.get(`${x}/${y}`);
      if (fromMap) return fromMap;
      const manUrl = state && state.tileIndexUrl;
      if (typeof manUrl !== 'string' || !manUrl) return null;
      const root = manUrl.replace(/\/[^/]*$/, '');
      return `${root}/${x}/${y}.json`;
    }

    function ingestTile(state, tile) {
      if (!state || !tile || typeof tile !== 'object') return;
      if (!state.ways || typeof state.ways !== 'object') state.ways = {};
      if (!state.geometries || typeof state.geometries !== 'object') state.geometries = {};
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

    function fetchTile(state, x, y) {
      if (!state || !state._tileCache) return Promise.resolve(null);
      const key = `${x}/${y}`;
      if (state._tileCache.has(key)) return state._tileCache.get(key);
      const url = tileUrl(state, x, y);
      if (!url || typeof fetch !== 'function') return Promise.resolve(null);
      const p = (async () => {
        let resp;
        try { resp = await fetch(url, { cache: 'force-cache' }); }
        catch (_) { state._tileCache.delete(key); return null; }
        if (!resp || !resp.ok) { state._tileCache.delete(key); return null; }
        let json = null;
        try { json = await resp.json(); } catch (_) { state._tileCache.delete(key); return null; }
        ingestTile(state, json);
        return json;
      })();
      state._tileCache.set(key, p);
      return p;
    }

    async function runLimited(tasks, limit) {
      const n = Math.max(1, Math.min(Number(limit) || TILE_FETCH_CONCURRENCY, tasks.length || 1));
      let next = 0;
      const workers = Array.from({ length: n }, async () => {
        while (next < tasks.length) {
          const i = next++;
          try { await tasks[i](); } catch (_) { /* individual tile failures are non-fatal */ }
        }
      });
      await Promise.all(workers);
    }

    cl.loadTilesForBbox = function loadTilesForBboxPerfGuarded(state, bounds) {
      if (!state || !state.tileIndex || !state._tileCache) {
        return originalLoadTilesForBbox
          ? originalLoadTilesForBbox(state, bounds)
          : Promise.resolve({ ways: (state && state.ways) || {}, geometries: (state && state.geometries) || {} });
      }
      const z = (typeof state.tileIndex.z === 'number') ? state.tileIndex.z : CTX_TILE_DEFAULT_ZOOM;
      const want = tilesForBounds(bounds, z);
      if (want.length === 0) return Promise.resolve({ ways: state.ways || {}, geometries: state.geometries || {} });
      const { keySet } = ensureTileIndexes(state.tileIndex, state.tileIndexUrl);
      const tasks = [];
      for (const [x, y] of want) {
        if (!keySet.has(`${x}/${y}`)) continue;
        tasks.push(() => fetchTile(state, x, y));
      }
      return runLimited(tasks, TILE_FETCH_CONCURRENCY).then(() => ({
        ways: state.ways || {},
        geometries: state.geometries || {}
      }));
    };

    cl.resolveWayAcrossTiles = function resolveWayAcrossTilesPerfGuarded(state, wayId) {
      if (!state || !wayId) return null;
      if (typeof cl.resolveWay === 'function') {
        const direct = cl.resolveWay(state, wayId);
        if (direct) return direct;
      }
      // renderLayers creates thousands of markers. Do not let popup prebinding
      // fetch tiles for each marker while the base map is still painting.
      if (UA._suppressContextTileFetchDuringRender) return null;
      const idx = state.tileIndex && state.tileIndex.wayIndex && state.tileIndex.wayIndex[wayId];
      if (Array.isArray(idx) && idx.length === 2 && state._tileCache) {
        const [x, y] = idx;
        try { fetchTile(state, x, y); } catch (_) { /* noop */ }
      } else if (originalResolveWayAcrossTiles) {
        return originalResolveWayAcrossTiles(state, wayId);
      }
      return null;
    };

    function patchRenderLayersWhenReady(attempt) {
      if (typeof UA.renderLayers === 'function' && !UA.renderLayers._contextTilePerfGuarded) {
        const originalRenderLayers = UA.renderLayers;
        const wrapped = function renderLayersWithContextTileGuard(ctx) {
          const prev = !!UA._suppressContextTileFetchDuringRender;
          UA._suppressContextTileFetchDuringRender = true;
          try { return originalRenderLayers.apply(this, arguments); }
          finally { UA._suppressContextTileFetchDuringRender = prev; }
        };
        wrapped._contextTilePerfGuarded = true;
        wrapped._originalRenderLayers = originalRenderLayers;
        UA.renderLayers = wrapped;
        return;
      }
      if ((attempt || 0) < 50 && typeof setTimeout === 'function') {
        setTimeout(() => patchRenderLayersWhenReady((attempt || 0) + 1), 0);
      }
    }
    patchRenderLayersWhenReady(0);

    cl._contextTilePerformanceGuards = Object.freeze({
      TILE_FETCH_CONCURRENCY,
      tilesForBounds,
      ensureTileIndexes,
      fetchTile
    });
  })();

  // ----------------------------
  // PreviewMapRenderer
  //
  // Renders a complete traffic situation described by a MapScene into
  // a given DOM container without touching the live interactive map.
  // Suitable for:
  //   - preview thumbnails in the export modal
  //   - Word/PDF export map images
  //   - future server-side rendering
  //   - embedding a single traffic situation on an arbitrary web page
  //
  // The live ctx is never mutated. All rendering happens in a private
  // previewCtx derived from the MapScene.
  //
  // Usage:
  //   const { ctx: previewCtx, map: previewMap } =
  //     await UA.PreviewMapRenderer.render({
  //       container: document.getElementById('previewContainer'),
  //       scene:     UA.MapScene.fromCtx(ctx),
  //       pts:       ctx.allPts
  //     });
  //
  //   // Capture the image:
  //   const dataUrl = await UA.captureMapImage(previewCtx, previewMap);
  //
  //   // Tear down when done:
  //   previewMap.remove();
  // ----------------------------

  UA.PreviewMapRenderer = {
    /**
     * Render a MapScene into a DOM container.
     *
     * Required options:
     *   container {HTMLElement} — the element to render the Leaflet map into.
     *   scene     {MapScene}   — optional scene to render.
     *   trafficSituation {TrafficSituation} — optional alternative to `scene`.
     *                          Provide either `scene` or `trafficSituation`.
     *
     * Optional options:
     *   pts       {Array}    — pre-loaded accident point array (ctx.allPts).
     *                          When omitted the renderer starts with an empty
     *                          dataset (useful for tile-only previews).
     *   onReady   {Function} — callback(previewCtx, previewMap) fired once the
     *                          map is visually stable.
     *   waitOpts  {Object}   — options forwarded to waitUntilStable / waitForMapFullyRendered.
     *
     * Returns a Promise resolving to { ctx: previewCtx, map: previewMap }.
     */
    render: async function renderPreview(opts) {
      const { container, scene, trafficSituation, pts, onReady, waitOpts } = opts || {};
      const resolvedScene = scene
        || (
          trafficSituation
          && UA.TrafficSituation
          && typeof UA.TrafficSituation.toMapScene === 'function'
          ? UA.TrafficSituation.toMapScene(trafficSituation)
          : null
        );
      if (!container) throw new Error("PreviewMapRenderer.render: `container` is required");
      if (!resolvedScene) throw new Error("PreviewMapRenderer.render: `scene` or `trafficSituation` is required");
      if (typeof window === 'undefined' || !window.L) {
        throw new Error("PreviewMapRenderer.render: Leaflet (window.L) is not available");
      }
      const L = window.L;

      // ---- Build a minimal context for renderLayers ----
      const f = resolvedScene.filters || {};
      const l = resolvedScene.layers  || {};
      const cf = f.contextFilters || {};

      const previewCtx = {
        CITY_RAW:             resolvedScene.city || "",
        allPts:               Array.isArray(pts) ? pts : [],
        filteredAll:          [],
        filteredCapped:       [],
        viewportPts:          [],
        involvementMode:      f.involvementMode || "or",
        showCluster:          l.showCluster          !== false,
        showHeatmap:          l.showHeatmap          !== false,
        showOnlyAboveAverage: !!l.showOnlyAboveAverage,
        showSchools:          l.showSchools          !== false,
        showKindergartens:    l.showKindergartens    !== false,
        showArgumentation:    l.showArgumentation    !== false,
        accidentView:         resolvedScene.accidentView || "bySeverity",
        exportOptions:        Object.assign({}, resolvedScene.exportOptions || {}),
        contextOverlays:      resolvedScene.contextOverlays  || { active: { slope: false, traffic: false } },
        // Provide a stub statEl so UA.updateStats does not throw
        ui: {
          statEl:             { textContent: '' },
          heatRadiusEl:       { value: String(f.heatRadius != null ? f.heatRadius : 25) }
        },
        // Expose filter values as direct ctx properties so UA.applyFilters
        // can read them without needing DOM elements
        severity:           f.severity      || "all",
        dayType:            f.dayType       || "all",
        roadCondition:      f.roadCondition || "all",
        hourFrom:           f.hourFrom      != null ? f.hourFrom      : 0,
        hourTo:             f.hourTo        != null ? f.hourTo        : 23,
        maxPoints:          f.maxPoints     != null ? f.maxPoints     : 100000,
        viewportPaddingPct: f.viewportPaddingPct != null ? f.viewportPaddingPct : 20,
        includeCyclist:    f.includeCyclist    !== false,
        includePedestrian: f.includePedestrian !== false,
        includeCar:        f.includeCar        !== false,
        includeMotorcycle: !!f.includeMotorcycle,
        includeGkfz:       !!f.includeGkfz,
        includeSonstig:    !!f.includeSonstig,
        contextFilters: {
          slopeClasses:    new Set(cf.slopeClasses   || []),
          trafficClasses:  new Set(cf.trafficClasses || []),
          onlyMatchedWays: !!cf.onlyMatchedWays
        }
      };

      // ---- Create a detached Leaflet map ----
      const center = resolvedScene.center || { lat: 52.3759, lon: 9.732 };
      const lon = center.lon != null ? center.lon : center.lng;
      const zoom = resolvedScene.zoom != null ? resolvedScene.zoom : 12;

      const previewMap = L.map(container, { preferCanvas: true, zoomControl: true });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap-Mitwirkende"
      }).addTo(previewMap);
      previewMap.setView([center.lat, lon], zoom);
      previewCtx.map = previewMap;

      // ---- Apply filters and render ----
      if (typeof UA.applyFilters        === 'function') UA.applyFilters(previewCtx);
      if (typeof UA.applyViewportFilter === 'function') UA.applyViewportFilter(previewCtx);
      previewCtx._dataChanged = true;
      if (typeof UA.renderLayers        === 'function') UA.renderLayers(previewCtx);

      // ---- Wait until the map is visually stable ----
      const adapter = UA.LeafletMapAdapter
        ? UA.LeafletMapAdapter.create(previewMap)
        : null;

      if (adapter) {
        await adapter.waitUntilStable(waitOpts || { timeoutMs: 15000 });
      } else if (typeof UA.waitForMapFullyRendered === 'function') {
        await UA.waitForMapFullyRendered(previewMap, waitOpts || { timeoutMs: 15000 });
      }

      if (typeof onReady === 'function') {
        try { onReady(previewCtx, previewMap); } catch (e) {
          console.warn('PreviewMapRenderer.onReady callback error:', e);
        }
      }

      return { ctx: previewCtx, map: previewMap };
    }
  };
})();