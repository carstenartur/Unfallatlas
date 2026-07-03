(() => {
  const UA = (window.UA = window.UA || {});

  // ---------------------------------------------------------------------------
  // Context tile performance guards
  // ---------------------------------------------------------------------------
  (function installContextTilePerformanceGuards() {
    const cl = UA.contextLayers;
    if (!cl || cl._contextTilePerformanceGuards) return;

    const TILE_FETCH_CONCURRENCY = 6;
    const CTX_TILE_DEFAULT_ZOOM = cl.CTX_TILE_DEFAULT_ZOOM || 13;
    const originalResolveWayAcrossTiles = cl.resolveWayAcrossTiles;
    const originalLoadTilesForBbox = cl.loadTilesForBbox;

    function lonToTileX(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
    function latToTileY(lat, z) {
      const rad = (lat * Math.PI) / 180;
      return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z));
    }
    function tilesForBounds(bounds, z) {
      if (!bounds) return [];
      let south, north, west, east;
      if (typeof bounds.getSouth === 'function') {
        south = bounds.getSouth(); north = bounds.getNorth(); west = bounds.getWest(); east = bounds.getEast();
      } else if (Array.isArray(bounds) && bounds.length === 4) {
        [south, west, north, east] = bounds;
      } else if (bounds && typeof bounds === 'object') {
        south = bounds.south; north = bounds.north; west = bounds.west; east = bounds.east;
      }
      if (!Number.isFinite(south) || !Number.isFinite(north) || !Number.isFinite(west) || !Number.isFinite(east)) return [];
      const xMin = lonToTileX(Math.min(west, east), z);
      const xMax = lonToTileX(Math.max(west, east), z);
      const yMin = latToTileY(Math.max(south, north), z);
      const yMax = latToTileY(Math.min(south, north), z);
      const out = [];
      for (let x = xMin; x <= xMax; x++) for (let y = yMin; y <= yMax; y++) out.push([x, y]);
      return out;
    }
    function ensureTileIndexes(tileIndex, tileIndexUrl) {
      if (!tileIndex || typeof tileIndex !== 'object') return { keySet: new Set(), urlByKey: new Map() };
      const root = (typeof tileIndexUrl === 'string' && tileIndexUrl) ? tileIndexUrl.replace(/\/[^/]*$/, '') : null;
      let keySet = tileIndex.tileKeySet instanceof Set ? tileIndex.tileKeySet : null;
      let urlByKey = tileIndex.tileUrlByKey instanceof Map ? tileIndex.tileUrlByKey : null;
      if (keySet && urlByKey) return { keySet, urlByKey };
      keySet = keySet || new Set();
      urlByKey = urlByKey || new Map();
      for (const t of (tileIndex.tiles || [])) {
        if (!t || !Number.isFinite(t.x) || !Number.isFinite(t.y)) continue;
        const key = `${t.x}/${t.y}`;
        keySet.add(key);
        if (!urlByKey.has(key)) urlByKey.set(key, root ? `${root}/${t.x}/${t.y}.json` : key);
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
        for (const wayId of Object.keys(tile.ways)) if (!(wayId in state.ways)) state.ways[wayId] = tile.ways[wayId];
      }
      if (tile.geometries && typeof tile.geometries === 'object') {
        for (const wayId of Object.keys(tile.geometries)) if (!(wayId in state.geometries)) state.geometries[wayId] = tile.geometries[wayId];
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
        try { resp = await fetch(url, { cache: 'force-cache' }); } catch (_) { state._tileCache.delete(key); return null; }
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
          try { await tasks[i](); } catch (_) {}
        }
      });
      await Promise.all(workers);
    }

    cl.loadTilesForBbox = function loadTilesForBboxPerfGuarded(state, bounds) {
      if (!state || !state.tileIndex || !state._tileCache) {
        return originalLoadTilesForBbox ? originalLoadTilesForBbox(state, bounds) : Promise.resolve({ ways: (state && state.ways) || {}, geometries: (state && state.geometries) || {} });
      }
      const z = (typeof state.tileIndex.z === 'number') ? state.tileIndex.z : CTX_TILE_DEFAULT_ZOOM;
      const want = tilesForBounds(bounds, z);
      if (want.length === 0) return Promise.resolve({ ways: state.ways || {}, geometries: state.geometries || {} });
      const { keySet } = ensureTileIndexes(state.tileIndex, state.tileIndexUrl);
      const tasks = [];
      for (const [x, y] of want) if (keySet.has(`${x}/${y}`)) tasks.push(() => fetchTile(state, x, y));
      return runLimited(tasks, TILE_FETCH_CONCURRENCY).then(() => ({ ways: state.ways || {}, geometries: state.geometries || {} }));
    };

    cl.resolveWayAcrossTiles = function resolveWayAcrossTilesPerfGuarded(state, wayId) {
      if (!state || !wayId) return null;
      if (typeof cl.resolveWay === 'function') {
        const direct = cl.resolveWay(state, wayId);
        if (direct) return direct;
      }
      if (UA._suppressContextTileFetchDuringRender) return null;
      const idx = state.tileIndex && state.tileIndex.wayIndex && state.tileIndex.wayIndex[wayId];
      if (Array.isArray(idx) && idx.length === 2 && state._tileCache) {
        const [x, y] = idx;
        try { fetchTile(state, x, y); } catch (_) {}
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
      if ((attempt || 0) < 50 && typeof setTimeout === 'function') setTimeout(() => patchRenderLayersWhenReady((attempt || 0) + 1), 0);
    }
    patchRenderLayersWhenReady(0);

    cl._contextTilePerformanceGuards = Object.freeze({ TILE_FETCH_CONCURRENCY, tilesForBounds, ensureTileIndexes, fetchTile });
  })();

  // ---------------------------------------------------------------------------
  // Direct map mode control
  // ---------------------------------------------------------------------------
  (function installDirectMapModeControlHook() {
    if (UA._directMapModeControlHooked) return;
    UA._directMapModeControlHooked = true;

    const CONTROL_MODES = ['standard', 'orthophoto', 'hybrid'];
    const CONTROL_LABELS = Object.freeze({ standard: 'Karte', orthophoto: 'Luftbild', hybrid: 'Hybrid' });

    function resolveMode(raw) {
      return (typeof UA.resolveMapMode === 'function') ? UA.resolveMapMode(raw) : (raw || 'standard');
    }

    function syncControl(ctx) {
      const ctrl = ctx && ctx.directMapModeControl;
      const container = ctrl && ctrl._uaContainer;
      if (!container || typeof container.querySelectorAll !== 'function') return;
      const active = resolveMode(ctx.mapMode || 'standard');
      for (const btn of Array.from(container.querySelectorAll('button[data-map-mode]'))) {
        const on = btn.getAttribute('data-map-mode') === active;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.style.background = on ? '#2c5aa0' : '#fff';
        btn.style.color = on ? '#fff' : '#222';
        btn.style.borderColor = on ? '#2c5aa0' : 'rgba(0,0,0,.22)';
      }
    }

    UA.installDirectMapModeControl = function installDirectMapModeControl(ctx) {
      if (!ctx || !ctx.map || !window.L || !window.L.control || ctx.directMapModeControl) {
        syncControl(ctx);
        return ctx && ctx.directMapModeControl;
      }
      const ctrl = window.L.control({ position: 'topleft' });
      ctrl.onAdd = function onAdd() {
        const c = window.L.DomUtil.create('div', 'map-mode-switch-control leaflet-bar');
        ctrl._uaContainer = c;
        if (window.L.DomEvent) {
          try { window.L.DomEvent.disableClickPropagation(c); } catch (_) {}
          try { window.L.DomEvent.disableScrollPropagation(c); } catch (_) {}
        }
        c.setAttribute('role', 'group');
        c.setAttribute('aria-label', 'Kartenhintergrund wählen');
        c.style.display = 'flex';
        c.style.gap = '4px';
        c.style.padding = '5px';
        c.style.background = 'rgba(255,255,255,.94)';
        c.style.borderRadius = '6px';
        c.style.boxShadow = '0 1px 4px rgba(0,0,0,.25)';

        for (const mode of CONTROL_MODES) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = CONTROL_LABELS[mode] || mode;
          btn.setAttribute('data-map-mode', mode);
          btn.setAttribute('aria-label', CONTROL_LABELS[mode] || mode);
          btn.style.padding = '5px 8px';
          btn.style.border = '1px solid rgba(0,0,0,.22)';
          btn.style.borderRadius = '5px';
          btn.style.font = '12px/1.2 system-ui, sans-serif';
          btn.style.fontWeight = '700';
          btn.style.cursor = 'pointer';
          btn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            ctx.mapMode = mode;
            if (typeof UA.applyMapMode === 'function') UA.applyMapMode(ctx);
            if (typeof UA.syncMapModeButtons === 'function') UA.syncMapModeButtons(ctx);
            if (typeof UA.renderMapLayerStatus === 'function') UA.renderMapLayerStatus(ctx);
            if (typeof UA.syncAllToUrl === 'function') {
              try { UA.syncAllToUrl(ctx); } catch (_) {}
            }
            syncControl(ctx);
          });
          c.appendChild(btn);
        }
        setTimeout(() => syncControl(ctx), 0);
        return c;
      };
      try { ctrl.addTo(ctx.map); ctx.directMapModeControl = ctrl; }
      catch (_) { return null; }
      return ctrl;
    };

    function wrapInitLeaflet(fn) {
      if (typeof fn !== 'function' || fn._directMapModeControlWrapped) return fn;
      const wrapped = function initLeafletWithDirectMapMode(ctx) {
        const ret = fn.apply(this, arguments);
        try { UA.installDirectMapModeControl(ctx); } catch (_) {}
        return ret;
      };
      wrapped._directMapModeControlWrapped = true;
      wrapped._originalInitLeaflet = fn;
      return wrapped;
    }

    function wrapApplyMapMode(fn) {
      if (typeof fn !== 'function' || fn._directMapModeControlWrapped) return fn;
      const wrapped = function applyMapModeWithDirectControlSync(ctx) {
        const ret = fn.apply(this, arguments);
        try { syncControl(ctx); } catch (_) {}
        return ret;
      };
      wrapped._directMapModeControlWrapped = true;
      wrapped._originalApplyMapMode = fn;
      return wrapped;
    }

    function installFunctionHook(name, wrapper) {
      if (typeof UA[name] === 'function') { UA[name] = wrapper(UA[name]); return; }
      let pending;
      try {
        Object.defineProperty(UA, name, {
          configurable: true,
          enumerable: true,
          get() { return pending; },
          set(fn) {
            pending = wrapper(fn);
            Object.defineProperty(UA, name, { value: pending, writable: true, configurable: true, enumerable: true });
          }
        });
      } catch (_) {}
    }

    installFunctionHook('initLeaflet', wrapInitLeaflet);
    installFunctionHook('applyMapMode', wrapApplyMapMode);
    UA.syncDirectMapModeControl = syncControl;
  })();

  // ----------------------------
  // PreviewMapRenderer
  // ----------------------------
  UA.PreviewMapRenderer = {
    render: async function renderPreview(opts) {
      const { container, scene, trafficSituation, pts, onReady, waitOpts } = opts || {};
      const resolvedScene = scene || (trafficSituation && UA.TrafficSituation && typeof UA.TrafficSituation.toMapScene === 'function' ? UA.TrafficSituation.toMapScene(trafficSituation) : null);
      if (!container) throw new Error("PreviewMapRenderer.render: `container` is required");
      if (!resolvedScene) throw new Error("PreviewMapRenderer.render: `scene` or `trafficSituation` is required");
      if (typeof window === 'undefined' || !window.L) throw new Error("PreviewMapRenderer.render: Leaflet (window.L) is not available");
      const L = window.L;

      const f = resolvedScene.filters || {};
      const l = resolvedScene.layers || {};
      const cf = f.contextFilters || {};
      const previewCtx = {
        CITY_RAW: resolvedScene.city || "",
        allPts: Array.isArray(pts) ? pts : [],
        filteredAll: [], filteredCapped: [], viewportPts: [],
        involvementMode: f.involvementMode || "or",
        showCluster: l.showCluster !== false,
        showHeatmap: l.showHeatmap !== false,
        showOnlyAboveAverage: !!l.showOnlyAboveAverage,
        showSchools: l.showSchools !== false,
        showKindergartens: l.showKindergartens !== false,
        showArgumentation: l.showArgumentation !== false,
        accidentView: resolvedScene.accidentView || "bySeverity",
        exportOptions: Object.assign({}, resolvedScene.exportOptions || {}),
        contextOverlays: resolvedScene.contextOverlays || { active: { slope: false, traffic: false } },
        ui: { statEl: { textContent: '' }, heatRadiusEl: { value: String(f.heatRadius != null ? f.heatRadius : 25) } },
        severity: f.severity || "all",
        dayType: f.dayType || "all",
        roadCondition: f.roadCondition || "all",
        hourFrom: f.hourFrom != null ? f.hourFrom : 0,
        hourTo: f.hourTo != null ? f.hourTo : 23,
        maxPoints: f.maxPoints != null ? f.maxPoints : 100000,
        viewportPaddingPct: f.viewportPaddingPct != null ? f.viewportPaddingPct : 20,
        includeCyclist: f.includeCyclist !== false,
        includePedestrian: f.includePedestrian !== false,
        includeCar: f.includeCar !== false,
        includeMotorcycle: !!f.includeMotorcycle,
        includeGkfz: !!f.includeGkfz,
        includeSonstig: !!f.includeSonstig,
        contextFilters: { slopeClasses: new Set(cf.slopeClasses || []), trafficClasses: new Set(cf.trafficClasses || []), onlyMatchedWays: !!cf.onlyMatchedWays }
      };

      const center = resolvedScene.center || { lat: 52.3759, lon: 9.732 };
      const lon = center.lon != null ? center.lon : center.lng;
      const zoom = resolvedScene.zoom != null ? resolvedScene.zoom : 12;
      const interactiveMaxZoom = UA.MAP_INTERACTIVE_MAX_ZOOM || 22;

      const previewMap = L.map(container, { preferCanvas: true, zoomControl: true, maxZoom: interactiveMaxZoom });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxNativeZoom: 19,
        maxZoom: interactiveMaxZoom,
        attribution: "© OpenStreetMap-Mitwirkende"
      }).addTo(previewMap);
      previewMap.setView([center.lat, lon], zoom);
      previewCtx.map = previewMap;

      if (typeof UA.applyFilters === 'function') UA.applyFilters(previewCtx);
      if (typeof UA.applyViewportFilter === 'function') UA.applyViewportFilter(previewCtx);
      previewCtx._dataChanged = true;
      if (typeof UA.renderLayers === 'function') UA.renderLayers(previewCtx);

      const adapter = UA.LeafletMapAdapter ? UA.LeafletMapAdapter.create(previewMap) : null;
      if (adapter) await adapter.waitUntilStable(waitOpts || { timeoutMs: 15000 });
      else if (typeof UA.waitForMapFullyRendered === 'function') await UA.waitForMapFullyRendered(previewMap, waitOpts || { timeoutMs: 15000 });

      if (typeof onReady === 'function') {
        try { onReady(previewCtx, previewMap); } catch (e) { console.warn('PreviewMapRenderer.onReady callback error:', e); }
      }
      return { ctx: previewCtx, map: previewMap };
    }
  };
})();