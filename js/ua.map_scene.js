(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // MapScene — pure serialisable model
  //
  // Contains everything that uniquely describes a traffic-situation view:
  // city, viewport, filters, visible layers, accident view, export options
  // and context overlay state. No Leaflet dependencies.
  //
  // Use MapScene.create() to produce a default-filled instance and
  // MapScene.fromCtx() to snapshot the current mutable ctx.
  // ----------------------------

  UA.MapScene = {
    /**
     * Create a MapScene with sensible defaults, merged with any overrides.
     * The returned object is a plain value — no hidden state or prototypes.
     */
    create: function createMapScene(overrides) {
      const defaults = {
        city: "",
        // Geographic view
        center: null,  // { lat, lon } | null
        zoom: null,
        // Selection rectangle
        selection: null,  // { south, west, north, east } | null
        // Active filters (mirrors URL params)
        filters: {
          severity: "all",
          dayType: "all",
          roadCondition: "all",
          hourFrom: 0,
          hourTo: 23,
          maxPoints: 100000,
          viewportPaddingPct: 20,
          heatRadius: 25,
          includeCyclist: true,
          includePedestrian: true,
          includeCar: true,
          includeMotorcycle: false,
          includeGkfz: false,
          includeSonstig: false,
          involvementMode: "or",
          // Context (enrichment) filters
          contextFilters: {
            slopeClasses: [],
            trafficClasses: [],
            onlyMatchedWays: false
          }
        },
        // Layer visibility
        layers: {
          showCluster: true,
          showHeatmap: true,
          showOnlyAboveAverage: false,
          showSchools: true,
          showKindergartens: true,
          showArgumentation: true
        },
        // Accident classification strategy
        accidentView: "bySeverity",
        // Export / report options
        exportOptions: {},
        // Context map overlays (slope, traffic)
        contextOverlays: {
          active: { slope: false, traffic: false }
        }
      };

      if (!overrides) return defaults;

      // Deep-merge filters and layers; shallow-merge the rest.
      const result = Object.assign({}, defaults, overrides);
      if (overrides.filters) {
        result.filters = Object.assign({}, defaults.filters, overrides.filters);
        if (overrides.filters.contextFilters) {
          result.filters.contextFilters = Object.assign(
            {}, defaults.filters.contextFilters, overrides.filters.contextFilters
          );
        }
      }
      if (overrides.layers) {
        result.layers = Object.assign({}, defaults.layers, overrides.layers);
      }
      if (overrides.contextOverlays) {
        result.contextOverlays = Object.assign({}, defaults.contextOverlays, overrides.contextOverlays);
        if (overrides.contextOverlays.active) {
          result.contextOverlays.active = Object.assign(
            {}, defaults.contextOverlays.active, overrides.contextOverlays.active
          );
        }
      }
      return result;
    },

    /**
     * Snapshot the current mutable ctx into an immutable MapScene.
     * Safe to call even when ctx is partially initialised (ctx.map may be null).
     */
    fromCtx: function mapSceneFromCtx(ctx) {
      if (!ctx) return UA.MapScene.create();

      const map = ctx.map;
      let center = null;
      let zoom = null;
      if (map && typeof map.getCenter === 'function') {
        try {
          const c = map.getCenter();
          center = { lat: c.lat, lon: c.lng };
          zoom = map.getZoom();
        } catch (_) {}
      }

      let selection = null;
      if (ctx.selectionBounds) {
        try {
          selection = {
            south: ctx.selectionBounds.getSouth(),
            west:  ctx.selectionBounds.getWest(),
            north: ctx.selectionBounds.getNorth(),
            east:  ctx.selectionBounds.getEast()
          };
        } catch (_) {}
      }

      const ui = ctx.ui || {};
      const cf = ctx.contextFilters || {};

      return UA.MapScene.create({
        city: ctx.CITY_RAW || "",
        center,
        zoom,
        selection,
        filters: {
          severity:          ui.severityEl       ? ui.severityEl.value       : "all",
          dayType:           ui.dayTypeEl         ? ui.dayTypeEl.value         : "all",
          roadCondition:     ui.roadConditionEl   ? ui.roadConditionEl.value   : "all",
          hourFrom:          ui.hFromEl           ? Number(ui.hFromEl.value)   : 0,
          hourTo:            ui.hToEl             ? Number(ui.hToEl.value)     : 23,
          maxPoints:         ui.maxPointsEl       ? Number(ui.maxPointsEl.value) : 100000,
          viewportPaddingPct: ui.viewportPaddingEl ? Number(ui.viewportPaddingEl.value) : 20,
          heatRadius:        ui.heatRadiusEl      ? Number(ui.heatRadiusEl.value) : 25,
          includeCyclist:    ui.incBikeEl         ? ui.incBikeEl.checked       : true,
          includePedestrian: ui.incPedEl          ? ui.incPedEl.checked        : true,
          includeCar:        ui.incCarEl          ? ui.incCarEl.checked        : true,
          includeMotorcycle: ui.incMotoEl         ? ui.incMotoEl.checked       : false,
          includeGkfz:       ui.incGkfzEl         ? ui.incGkfzEl.checked       : false,
          includeSonstig:    ui.incSonEl          ? ui.incSonEl.checked        : false,
          involvementMode:   ctx.involvementMode  || "or",
          contextFilters: {
            slopeClasses:   cf.slopeClasses   ? Array.from(cf.slopeClasses)   : [],
            trafficClasses: cf.trafficClasses ? Array.from(cf.trafficClasses) : [],
            onlyMatchedWays: !!cf.onlyMatchedWays
          }
        },
        layers: {
          showCluster:          !!ctx.showCluster,
          showHeatmap:          !!ctx.showHeatmap,
          showOnlyAboveAverage: !!ctx.showOnlyAboveAverage,
          showSchools:          !!ctx.showSchools,
          showKindergartens:    !!ctx.showKindergartens,
          showArgumentation:    !!ctx.showArgumentation
        },
        accidentView:   ctx.accidentView   || "bySeverity",
        exportOptions:  ctx.exportOptions  || {},
        contextOverlays: ctx.contextOverlays || { active: { slope: false, traffic: false } }
      });
    }
  };
})();
