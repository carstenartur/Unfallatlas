(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // MapStore — central action dispatcher
  //
  // All UI interactions should call store.dispatch(action, payload)
  // instead of directly calling UA.renderLayers(). The store routes
  // every action through a RenderScheduler so that:
  //   - viewport changes are debounced (350 ms) into a single render,
  //   - asynchronous context/tile loads cannot overwrite newer renders,
  //   - the rendering order is deterministic.
  // ----------------------------

  UA.MapStore = {
    create: function createMapStore(ctx) {
      const scheduler = UA.RenderScheduler.create({ debounceMs: 0 });

      function fullRender() {
        if (typeof UA.applyFilters === 'function') UA.applyFilters(ctx);
        if (typeof UA.applyViewportFilter === 'function') UA.applyViewportFilter(ctx);
        ctx._dataChanged = true;
        if (typeof UA.renderLayers === 'function') UA.renderLayers(ctx);
        if (typeof UA.saveCityState === 'function') UA.saveCityState(ctx);
      }

      async function viewportRender(epoch) {
        let accidentDataChanged = false;
        if (ctx.accidentDataMode === 'viewport'
            && typeof UA.requestAccidentViewport === 'function') {
          try {
            const result = await UA.requestAccidentViewport(ctx);
            if (scheduler.isStale(epoch)) return;
            if (result && result.committed
                && typeof UA.commitAccidentViewportResult === 'function') {
              accidentDataChanged = UA.commitAccidentViewportResult(ctx, result);
            }
          } catch (error) {
            if (scheduler.isStale(epoch)) return;
            console.warn('MapStore: accident viewport refresh failed:', error);
          }
        }

        if (scheduler.isStale(epoch)) return;
        if (accidentDataChanged && typeof UA.applyFilters === 'function') {
          UA.applyFilters(ctx);
        }
        if (typeof UA.applyViewportFilter === 'function') UA.applyViewportFilter(ctx);
        ctx._dataChanged = true;
        if (typeof UA.renderLayers === 'function') UA.renderLayers(ctx);
        if (typeof UA.syncViewToUrl === 'function') UA.syncViewToUrl(ctx);
      }

      function layerRender() {
        ctx._dataChanged = true;
        if (typeof UA.renderLayers === 'function') UA.renderLayers(ctx);
      }

      const store = {
        _scheduler: scheduler,
        _ctx: ctx,

        dispatch: function dispatch(action, payload) {
          const p = payload || {};

          switch (action) {
            case 'filtersChanged':
              scheduler.schedule(fullRender);
              break;

            case 'layerToggled':
              scheduler.schedule(layerRender);
              break;

            case 'viewportChanged':
              // Invalidate an already running provider request immediately when
              // the map moves. The controller and scheduler epochs then agree:
              // only the final debounced viewport may commit data to ctx.
              if (ctx.accidentDataMode === 'viewport'
                  && ctx.accidentViewportController
                  && typeof ctx.accidentViewportController.invalidate === 'function') {
                ctx.accidentViewportController.invalidate();
              }
              scheduler.scheduleRaf(
                function (epoch) {
                  void viewportRender(epoch).catch(error => {
                    if (!scheduler.isStale(epoch)) {
                      console.error('MapStore viewport render failed:', error);
                    }
                  });
                },
                p.debounceMs != null ? p.debounceMs : 350
              );
              break;

            case 'cityLoaded':
              fullRender();
              break;

            case 'selectionChanged':
              scheduler.schedule(fullRender);
              break;

            case 'exportModeChanged':
              scheduler.schedule(layerRender);
              break;

            case 'contextLayerLoaded':
              scheduler.schedule(function (epoch) {
                if (scheduler.isStale(epoch)) return;
                fullRender();
              });
              break;

            default:
              console.warn('MapStore: unknown action "' + action + '"');
              break;
          }
        },

        cancelPending: function cancelPending() {
          scheduler.cancel();
          if (ctx.accidentViewportController
              && typeof ctx.accidentViewportController.invalidate === 'function') {
            ctx.accidentViewportController.invalidate();
          }
        }
      };

      return store;
    }
  };
})();
