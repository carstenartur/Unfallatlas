(() => {
  const UA = (window.UA = window.UA || {});

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
        attribution: "\u00a9 OpenStreetMap-Mitwirkende"
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
