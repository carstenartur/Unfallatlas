(() => {
  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // LeafletMapAdapter
  //
  // Thin wrapper around a Leaflet map instance that encapsulates all
  // Leaflet-specific operations. Keeping Leaflet calls in one place
  // makes renderers independently testable (swap the adapter for a
  // stub in unit tests) and reduces coupling between rendering logic
  // and the specific Leaflet API version.
  //
  // Usage:
  //   const adapter = UA.LeafletMapAdapter.create(ctx.map);
  //   const newLayer = adapter.replaceLayer(ctx.clusterLayer, newCluster);
  //   adapter.bringLayerToFront(ctx.poiLayer);
  //   adapter.setView({ lat: 52.37, lon: 9.73 }, 12);
  //   await adapter.waitUntilStable({ timeoutMs: 15000 });
  // ----------------------------

  UA.LeafletMapAdapter = {
    /**
     * Create a new adapter bound to the given Leaflet map instance.
     */
    create: function createLeafletMapAdapter(map) {
      return {
        _map: map,

        /**
         * Remove `current` from the map (if set) and add `next` (if set).
         * Returns next so callers can do: ctx.layer = adapter.replaceLayer(ctx.layer, newLayer).
         */
        replaceLayer: function replaceLayer(current, next) {
          if (current) {
            try { current.remove(); } catch (_) {}
          }
          if (next && map) {
            try { next.addTo(map); } catch (_) {}
          }
          return next || null;
        },

        /**
         * Remove a layer from the map. Returns null for convenient assignment:
         *   ctx.layer = adapter.removeLayer(ctx.layer);
         */
        removeLayer: function removeLayer(layer) {
          if (layer) {
            try { layer.remove(); } catch (_) {}
          }
          return null;
        },

        /**
         * Call bringToFront() on a layer if the method exists (not all
         * Leaflet layer types support it).
         */
        bringLayerToFront: function bringLayerToFront(layer) {
          if (layer && typeof layer.bringToFront === 'function') {
            try { layer.bringToFront(); } catch (_) {}
          }
        },

        /**
         * Pan/zoom the map to the given center ({ lat, lon | lng }) and zoom.
         * Accepts both lon (our canonical field) and lng (Leaflet's convention).
         */
        setView: function setView(center, zoom) {
          if (!map || !center) return;
          const lng = center.lon != null ? center.lon : center.lng;
          if (!Number.isFinite(center.lat) || !Number.isFinite(lng)) return;
          try { map.setView([center.lat, lng], zoom); } catch (_) {}
        },

        /**
         * Fit the map to given bounds ({ south, west, north, east }).
         */
        fitBounds: function fitBounds(bounds, opts) {
          if (!map || !bounds) return;
          try {
            map.fitBounds(
              [[bounds.south, bounds.west], [bounds.north, bounds.east]],
              opts || { padding: [20, 20] }
            );
          } catch (_) {}
        },

        /**
         * Returns a Promise that resolves when the map is visually stable
         * (tiles loaded, layers rendered). Delegates to
         * UA.waitForMapFullyRendered if available.
         */
        waitUntilStable: function waitUntilStable(opts) {
          if (typeof UA.waitForMapFullyRendered === 'function') {
            return UA.waitForMapFullyRendered(map, opts || {});
          }
          return Promise.resolve(true);
        }
      };
    }
  };
})();
