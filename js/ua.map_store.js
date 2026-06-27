(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // MapStore — central action dispatcher
  //
  // All UI interactions should call store.dispatch(action, payload)
  // instead of directly calling UA.renderLayers(). The store routes
  // every action through a RenderScheduler so that:
  //   - rapid UI events are debounced into a single render,
  //   - asynchronous context loads cannot overwrite newer renders,
  //   - the rendering order is deterministic.
  //
  // Supported actions:
  //   filtersChanged      — filter/involvement/selection UI changed
  //   layerToggled        — cluster/heatmap/POI visibility toggled
  //   viewportChanged     — map pan or zoom ended
  //   cityLoaded          — new city data loaded (synchronous render)
  //   selectionChanged    — draw rectangle created or cleared
  //   exportModeChanged   — export options changed
  //   contextLayerLoaded  — async context overlay data arrived
  //
  // Usage:
  //   // In main():
  //   ctx.store = UA.MapStore.create(ctx);
  //
  //   // In a UI handler:
  //   ctx.store.dispatch('layerToggled');
  // ----------------------------

  UA.MapStore = {
    /**
     * Create a new MapStore bound to ctx.
     * Requires UA.RenderScheduler, UA.applyFilters,
     * UA.applyViewportFilter, UA.renderLayers, UA.syncViewToUrl,
     * UA.saveCityState to exist at call-time (or at dispatch-time
     * for lazily-loaded modules).
     */
    create: function createMapStore(ctx) {
      const scheduler = UA.RenderScheduler.create({ debounceMs: 0 });

      // ---- helpers ----

      function fullRender() {
        if (typeof UA.applyFilters       === 'function') UA.applyFilters(ctx);
        if (typeof UA.applyViewportFilter === 'function') UA.applyViewportFilter(ctx);
        ctx._dataChanged = true;
        if (typeof UA.renderLayers       === 'function') UA.renderLayers(ctx);
        if (typeof UA.saveCityState      === 'function') UA.saveCityState(ctx);
      }

      function viewportRender() {
        if (typeof UA.applyViewportFilter === 'function') UA.applyViewportFilter(ctx);
        ctx._dataChanged = true;
        if (typeof UA.renderLayers       === 'function') UA.renderLayers(ctx);
        if (typeof UA.syncViewToUrl      === 'function') UA.syncViewToUrl(ctx);
      }

      function layerRender() {
        ctx._dataChanged = true;
        if (typeof UA.renderLayers === 'function') UA.renderLayers(ctx);
      }

      // ---- store ----

      const store = {
        _scheduler: scheduler,
        _ctx: ctx,

        /**
         * Dispatch an action. The action name determines the render path
         * and debounce strategy.
         *
         * payload is optional and action-specific:
         *   viewportChanged: { debounceMs?: number }
         */
        dispatch: function dispatch(action, payload) {
          const p = payload || {};

          switch (action) {

            case 'filtersChanged':
              // Filter changes invalidate the full point set; re-run
              // applyFilters + applyViewportFilter + renderLayers.
              scheduler.schedule(fullRender);
              break;

            case 'layerToggled':
              // Toggling a layer only needs a renderLayers call — no need
              // to re-run applyFilters.
              scheduler.schedule(layerRender);
              break;

            case 'viewportChanged':
              // Viewport changes are debounced (default 350 ms) and
              // rendered through rAF to avoid layout thrashing.
              scheduler.scheduleRaf(
                viewportRender,
                p.debounceMs != null ? p.debounceMs : 350
              );
              break;

            case 'cityLoaded':
              // After a city switch the data is already in ctx; render
              // immediately (synchronous) so the map shows the new data
              // without an extra tick.
              fullRender();
              break;

            case 'selectionChanged':
              // Selection changes (draw/clear) need a full recompute
              // because the selection rectangle affects the viewport filter.
              scheduler.schedule(fullRender);
              break;

            case 'exportModeChanged':
              // Export-mode changes only affect how existing points are
              // visualised — no filter recompute needed.
              scheduler.schedule(layerRender);
              break;

            case 'contextLayerLoaded':
              // Async context data arrived. Run the full pipeline in case
              // context-filter state changed between the async start and now.
              scheduler.schedule(function (epoch) {
                // Stale check: if a newer dispatch has already run, skip.
                if (scheduler.isStale(epoch)) return;
                fullRender();
              });
              break;

            default:
              console.warn('MapStore: unknown action "' + action + '"');
              break;
          }
        },

        /**
         * Abort any pending scheduled render. Useful when tearing down ctx
         * (e.g. city reload, page unload).
         */
        cancelPending: function cancelPending() {
          scheduler.cancel();
        }
      };

      return store;
    }
  };
})();
