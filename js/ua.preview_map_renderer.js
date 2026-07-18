(() => {
  const UA = (window.UA = window.UA || {});

  // Static-data paths, compression and fetching are owned by
  // UA.DataResources / UA.contextLayers. This renderer must not construct
  // `out/...` paths, fetch context tiles, or replace context-layer loaders.

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