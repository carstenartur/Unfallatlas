(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // LeafletRenderer — Leaflet implementation of the Renderer interface (Issue #310)
  //
  // Converts a SceneGraph into Leaflet layers on a given map or container.
  // Implements the full renderer interface:
  //
  //   renderer.render(sceneGraph)      — build layers from scratch
  //   renderer.update(sceneGraph)      — dispose current layers, re-render
  //   renderer.dispose()               — remove all managed layers
  //   renderer.captureSnapshot()       — delegate to UA.captureMapImage (Promise)
  //
  // Usage:
  //   const renderer = UA.LeafletRenderer.create(mapElement, { L: window.L });
  //   renderer.render(sceneGraph);
  //   …
  //   renderer.dispose();
  //
  // Supported node types
  //   POINT       → L.circleMarker
  //   POLYLINE    → L.polyline
  //   POLYGON     → L.polygon
  //   BILLBOARD   → L.marker (with DivIcon)
  //   LABEL       → L.marker (with DivIcon tooltip text)
  //   HEAT_FIELD  → deferred to UA.renderLayers / ctx (when available)
  //   CLUSTER     → deferred to UA.renderLayers / ctx (when available)
  //   ARROW       → L.polyline with arrowhead decoration
  //   HIGHLIGHT   → L.polygon with highlight style
  //   RASTER      → L.tileLayer (XYZ) or L.tileLayer.wms (WMS)
  //   CAMERA/LIGHT/MESH → no-op in 2D mode (logged as unsupported)
  // ----------------------------

  UA.LeafletRenderer = {

    /**
     * Create a new LeafletRenderer.
     *
     * @param {HTMLElement|null} container
     *   The DOM element to render into.  When `map` is provided in opts the
     *   container is ignored and the existing map instance is reused.
     *
     * @param {object} [opts]
     *   Optional configuration:
     *     L       {object}  — Leaflet library (defaults to window.L)
     *     map     {object}  — existing Leaflet map instance (overrides container)
     *     tileUrl {string}  — tile template URL (default: OSM)
     *     zoom    {number}  — initial zoom (default: 12)
     *     center  {object}  — initial center { lat, lon } (default: Hannover)
     *
     * @returns {Renderer}
     */
    create: function createLeafletRenderer(container, opts) {
      const o       = opts || {};
      const L       = o.L || (typeof window !== 'undefined' && window.L);
      if (!L) throw new Error('LeafletRenderer.create: Leaflet (L) is not available');

      let _map      = o.map || null;
      let _ownMap   = false;
      let _layers   = [];       // all managed Leaflet layer instances
      let _defaultBaseLayer = null;
      const _defaultTileUrl = o.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
      const _defaultTileOptions = { maxZoom: 19, attribution: '© OpenStreetMap-Mitwirkende' };

      // ---- Create or reuse Leaflet map ----
      if (!_map) {
        if (!container) {
          throw new Error('LeafletRenderer.create: container or map is required');
        }
        const center = o.center || { lat: 52.3759, lon: 9.732 };
        const zoom   = o.zoom   != null ? o.zoom : 12;
        const lon    = center.lon != null ? center.lon : center.lng;
        _map = L.map(container, { preferCanvas: true, zoomControl: true });
        _defaultBaseLayer = L.tileLayer(_defaultTileUrl, _defaultTileOptions);
        _defaultBaseLayer.addTo(_map);
        _map.setView([center.lat, lon], zoom);
        _ownMap = true;
      }

      // ---- Internal helpers ----

      function _addLayer(layer) {
        if (layer) {
          try { layer.addTo(_map); } catch (_) {}
          _layers.push(layer);
        }
        return layer;
      }

      function _clearLayers() {
        for (const l of _layers) {
          try { l.remove(); } catch (_) {}
        }
        _layers = [];
      }

      function _sceneHasRaster(sceneGraph) {
        if (!sceneGraph || !Array.isArray(sceneGraph.nodes)) return false;
        const NT = UA.SceneGraph && UA.SceneGraph.NODE_TYPES;
        const rasterType = NT ? NT.RASTER : 'raster';
        for (const node of sceneGraph.nodes) {
          if (node && node.type === rasterType) return true;
        }
        return false;
      }

      function _syncDefaultBaseLayer(hasRaster) {
        if (!_ownMap || !_map || typeof L.tileLayer !== 'function') return;
        if (hasRaster) {
          if (_defaultBaseLayer) {
            try { _defaultBaseLayer.remove(); } catch (_) {}
            _defaultBaseLayer = null;
          }
          return;
        }
        if (!_defaultBaseLayer) {
          _defaultBaseLayer = L.tileLayer(_defaultTileUrl, _defaultTileOptions);
          try { _defaultBaseLayer.addTo(_map); } catch (_) {}
        }
      }

      function _renderNode(node) {
        if (!node || !node.type) return;
        const NT = UA.SceneGraph && UA.SceneGraph.NODE_TYPES;
        const t  = node.type;

        if (t === (NT ? NT.POINT : 'point')) {
          _renderPoint(node);
        } else if (t === (NT ? NT.POLYLINE : 'polyline')) {
          _renderPolyline(node);
        } else if (t === (NT ? NT.POLYGON : 'polygon')) {
          _renderPolygon(node);
        } else if (t === (NT ? NT.BILLBOARD : 'billboard')) {
          _renderBillboard(node);
        } else if (t === (NT ? NT.LABEL : 'label')) {
          _renderLabel(node);
        } else if (t === (NT ? NT.ARROW : 'arrow')) {
          _renderArrow(node);
        } else if (t === (NT ? NT.HIGHLIGHT : 'highlight')) {
          _renderHighlight(node);
        } else if (t === (NT ? NT.RASTER : 'raster')) {
          _renderRaster(node);
        } else if (t === (NT ? NT.HEAT_FIELD : 'heatField') ||
                   t === (NT ? NT.CLUSTER    : 'cluster')) {
          // These are managed by the existing rendering pipeline
          // (UA.renderLayers / ctx heatmap/cluster layers) and are
          // intentionally skipped by the LeafletRenderer.
        }
        // CAMERA, LIGHT, MESH are 3D/AR nodes — no-op in 2D mode.

        // Recurse into children
        if (node.children && node.children.length) {
          for (const child of node.children) {
            _renderNode(child);
          }
        }
      }

      function _renderPoint(node) {
        const g = node.geometry || {};
        if (g.lat == null) return;
        const lon = g.lon != null ? g.lon : g.lng;
        if (lon == null) return;
        const s  = node.style || {};
        const cm = L.circleMarker([g.lat, lon], {
          color:       s.color       || '#e74c3c',
          radius:      s.radius      != null ? s.radius : 6,
          opacity:     s.opacity     != null ? s.opacity : 0.85,
          fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0.65,
          fillColor:   s.color       || '#e74c3c'
        });
        if (node.interaction && (node.interaction.selectable || node.interaction.hoverable)) {
          const data    = node.interaction.data || {};
          const tooltip = _escapeHtml((node.semantic && node.semantic.label) || JSON.stringify(data));
          cm.bindTooltip(tooltip);
        }
        _addLayer(cm);
      }

      function _renderPolyline(node) {
        const g    = node.geometry || {};
        const lls  = _coordsToLatLngs(g.coordinates);
        if (!lls || !lls.length) return;
        const s    = node.style   || {};
        const line = L.polyline(lls, {
          color:   s.color   || '#3498db',
          weight:  s.weight  != null ? s.weight : 2,
          opacity: s.opacity != null ? s.opacity : 0.8
        });
        _addLayer(line);
      }

      function _renderPolygon(node) {
        const g    = node.geometry || {};
        const lls  = _coordsToLatLngs(g.coordinates);
        if (!lls || !lls.length) return;
        const s    = node.style   || {};
        const poly = L.polygon(lls, {
          color:       s.color       || '#27ae60',
          fillColor:   s.fillColor   || s.color || '#27ae60',
          weight:      s.weight      != null ? s.weight : 1,
          opacity:     s.opacity     != null ? s.opacity : 0.8,
          fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0.3
        });
        _addLayer(poly);
      }

      function _renderBillboard(node) {
        const g = node.geometry || {};
        if (g.lat == null) return;
        const lon = g.lon != null ? g.lon : g.lng;
        if (lon == null) return;
        const s    = node.style || {};
        const size = Array.isArray(s.size) ? s.size : [32, 32];
        const icon = L.divIcon({
          className:   'ua-billboard-icon',
          html:        '<div style="width:' + size[0] + 'px;height:' + size[1] + 'px;' +
                       'background:#3498db;border-radius:50%;border:2px solid #fff;' +
                       'opacity:' + (s.opacity != null ? s.opacity : 1.0) + '"></div>',
          iconSize:    size,
          iconAnchor:  [size[0] / 2, size[1]]
        });
        const marker = L.marker([g.lat, lon], { icon: icon });
        if (node.semantic && node.semantic.label) {
          marker.bindTooltip(_escapeHtml(node.semantic.label));
        }
        _addLayer(marker);
      }

      function _renderLabel(node) {
        const g = node.geometry || {};
        if (g.lat == null) return;
        const lon = g.lon != null ? g.lon : g.lng;
        if (lon == null) return;
        const label = (node.semantic && node.semantic.label) || '';
        const s     = node.style || {};
        const icon  = L.divIcon({
          className: 'ua-label-icon',
          html:      '<div style="padding:' + (s.padding != null ? s.padding : 4) +
                     'px;background:' + (s.background || 'rgba(255,255,255,0.85)') +
                     ';color:' + (s.color || '#333') +
                     ';font:' + (s.font  || '12px sans-serif') +
                     ';border-radius:3px;white-space:nowrap">' +
                     _escapeHtml(label) + '</div>',
          iconSize:  null
        });
        _addLayer(L.marker([g.lat, lon], { icon: icon }));
      }

      function _renderArrow(node) {
        const g   = node.geometry || {};
        const lls = _coordsToLatLngs(g.coordinates);
        if (!lls || lls.length < 2) return;
        const s    = node.style || {};
        const line = L.polyline(lls, {
          color:   s.color   || '#e67e22',
          weight:  s.weight  != null ? s.weight : 2,
          opacity: s.opacity != null ? s.opacity : 0.9
        });
        _addLayer(line);
      }

      function _renderHighlight(node) {
        const g = node.geometry || {};
        if (g.south != null && g.north != null && g.west != null && g.east != null) {
          const s    = node.style || {};
          const rect = L.rectangle(
            [[g.south, g.west], [g.north, g.east]],
            {
              color:       s.color       || '#f39c12',
              fillColor:   s.fillColor   || s.color || '#f39c12',
              weight:      s.weight      != null ? s.weight : 3,
              opacity:     s.opacity     != null ? s.opacity : 1.0,
              fillOpacity: s.fillOpacity != null ? s.fillOpacity : 0.2
            }
          );
          _addLayer(rect);
          return;
        }
        // Fallback: treat as polygon
        _renderPolygon(node);
      }

      function _renderRaster(node) {
        const g = node.geometry || {};
        if (!g.url) return;
        const s       = node.style || {};
        const options = {
          maxZoom:     s.maxZoom  != null ? s.maxZoom : 19,
          opacity:     s.opacity  != null ? s.opacity : 1.0,
          attribution: (node.semantic && node.semantic.attribution) || ''
        };
        let layer;
        if (g.technicalType === 'WMS') {
          if (!L.tileLayer || typeof L.tileLayer.wms !== 'function') return;
          layer = L.tileLayer.wms(g.url, Object.assign({}, options, {
            layers:      g.layers      || '',
            format:      g.format      || 'image/png',
            transparent: !!g.transparent,
            uppercase:   true
          }));
        } else {
          if (typeof L.tileLayer !== 'function') return;
          const xyzOptions = Object.assign({}, options);
          if (g.subdomains) xyzOptions.subdomains = g.subdomains;
          layer = L.tileLayer(g.url, xyzOptions);
        }
        _addLayer(layer);
      }

      // ---- Coordinate helpers ----

      function _coordsToLatLngs(coords) {
        if (!Array.isArray(coords) || !coords.length) return null;
        // GeoJSON polygon rings: [[[lon, lat], ...], ...] — use the outer ring (index 0)
        if (Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
          return coords[0].map(c => [c[1], c[0]]);
        }
        // Flat ring: [[lon, lat], ...]
        if (Array.isArray(coords[0])) {
          return coords.map(c => [c[1], c[0]]);
        }
        return null;
      }

      function _escapeHtml(s) {
        if (!s) return '';
        return String(s)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      // ---- Public renderer interface ----

      return {
        name:         'LeafletRenderer',
        capabilities: Object.freeze(new Set([
          UA.Renderer ? UA.Renderer.CAPABILITIES.RENDER_2D     : 'render2d',
          UA.Renderer ? UA.Renderer.CAPABILITIES.SNAPSHOT       : 'snapshot'
        ])),

        /** Reference to the managed Leaflet map instance. */
        get map() { return _map; },

        /**
         * Render the scene graph from scratch.
         * Disposes any previously rendered layers first.
         *
         * @param {SceneGraph} sceneGraph
         * @returns {Promise<void>}
         */
        render: function render(sceneGraph) {
          _clearLayers();
          _syncDefaultBaseLayer(_sceneHasRaster(sceneGraph));
          if (!sceneGraph || !sceneGraph.nodes) return Promise.resolve();
          for (const node of sceneGraph.nodes) {
            _renderNode(node);
          }
          return Promise.resolve();
        },

        /**
         * Update the scene graph (alias for render — full re-render).
         * Future implementations may diff the graph for efficiency.
         *
         * @param {SceneGraph} sceneGraph
         * @returns {Promise<void>}
         */
        update: function update(sceneGraph) {
          return this.render(sceneGraph);
        },

        /**
         * Remove all managed layers from the map.
         * If the map was created internally it is also removed.
         */
        dispose: function dispose() {
          _clearLayers();
          if (_defaultBaseLayer) {
            try { _defaultBaseLayer.remove(); } catch (_) {}
            _defaultBaseLayer = null;
          }
          if (_ownMap && _map) {
            try { _map.remove(); } catch (_) {}
            _map   = null;
            _ownMap = false;
          }
        },

        /**
         * Capture a screenshot of the current map view.
         * Delegates to UA.captureMapImage when available.
         *
         * @returns {Promise<string>} data URL
         */
        captureSnapshot: function captureSnapshot() {
          if (typeof UA.captureMapImage === 'function' && _map) {
            return UA.captureMapImage({ map: _map }, {});
          }
          return Promise.resolve('data:image/png;base64,');
        }
      };
    }
  };

})();
