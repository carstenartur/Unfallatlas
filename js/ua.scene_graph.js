(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // SceneGraph — renderer-independent visualization model (Issue #310)
  //
  // The scene graph is the bridge between the analysis pipeline and any
  // renderer.  It contains plain, serialisable visual objects that are
  // independent of both Leaflet and the accident data source.
  //
  // Architecture:
  //
  //   TrafficSituation
  //        │
  //        ▼
  //   Analysis Pipeline
  //        │
  //        ▼
  //   Semantic Scene
  //        │
  //        ▼
  //   SceneGraph  ←── this module
  //        │
  //   ┌────┼────────────┐
  //   │    │            │
  //   ▼    ▼            ▼
  // Leaflet Cesium  RealityKit
  //   2D    3D         AR
  //
  // A SceneGraph is a tree of SceneNodes.  Each node is a plain object:
  //
  //   {
  //     id:          string          — unique identifier within the graph
  //     type:        NODE_TYPE       — visual object kind
  //     geometry:    object          — renderer-independent shape description
  //     style:       object          — visual properties (color, size, opacity …)
  //     semantic:    object          — what does this node represent
  //     interaction: object          — selection / hover / focus metadata
  //     lod:         object          — level-of-detail visibility rules
  //     children:    SceneNode[]     — sub-nodes (e.g. cluster → points)
  //   }
  //
  // Node types (UA.SceneGraph.NODE_TYPES):
  //   POINT, POLYLINE, POLYGON, MESH, BILLBOARD, LABEL,
  //   HEAT_FIELD, CLUSTER, ARROW, HIGHLIGHT, CAMERA, LIGHT, RASTER
  //
  // LOD levels (UA.SceneGraph.LOD_LEVELS):
  //   DISTANT, CITY, STREET, INTERSECTION, PEDESTRIAN
  //
  // Interaction events (UA.SceneGraph.INTERACTION_EVENTS):
  //   SELECTION, HOVER, FOCUS, VOICE, GESTURE, EYE_TRACKING
  //
  // Public API
  //   UA.SceneGraph.NODE_TYPES         — frozen constants
  //   UA.SceneGraph.LOD_LEVELS         — frozen constants
  //   UA.SceneGraph.INTERACTION_EVENTS — frozen constants
  //   UA.SceneGraph.create(overrides?) → SceneGraph
  //   UA.SceneGraph.createNode(type, opts?) → SceneNode
  //   UA.SceneGraph.addNode(graph, node) → SceneGraph (new)
  //   UA.SceneGraph.removeNode(graph, nodeId) → SceneGraph (new)
  //   UA.SceneGraph.getNode(graph, nodeId) → SceneNode | null
  //   UA.SceneGraph.fromTrafficSituation(ts) → SceneGraph
  // ----------------------------

  /** All recognised scene node type identifiers. */
  const NODE_TYPES = Object.freeze({
    POINT:      'point',
    POLYLINE:   'polyline',
    POLYGON:    'polygon',
    MESH:       'mesh',
    BILLBOARD:  'billboard',
    LABEL:      'label',
    HEAT_FIELD: 'heatField',
    CLUSTER:    'cluster',
    ARROW:      'arrow',
    HIGHLIGHT:  'highlight',
    CAMERA:     'camera',
    LIGHT:      'light',
    RASTER:     'raster'
  });

  /** Level-of-detail levels, from furthest to closest. */
  const LOD_LEVELS = Object.freeze({
    DISTANT:      'distant',
    CITY:         'city',
    STREET:       'street',
    INTERSECTION: 'intersection',
    PEDESTRIAN:   'pedestrian'
  });

  /** All recognised interaction event types. */
  const INTERACTION_EVENTS = Object.freeze({
    SELECTION:    'selection',
    HOVER:        'hover',
    FOCUS:        'focus',
    VOICE:        'voice',
    GESTURE:      'gesture',
    EYE_TRACKING: 'eyeTracking'
  });

  /** Current schema version for serialised scene graphs. */
  const SCHEMA_VERSION = 1;

  // ---- internal helpers ----

  let _nextId = 1;

  function _generateId(prefix) {
    return (prefix || 'node') + '-' + (_nextId++);
  }

  /** Deep-clone a plain JSON-safe value. */
  function _clone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  /**
   * Default style values for each node type.
   * Renderers may override any field.
   */
  function _defaultStyle(type) {
    switch (type) {
      case NODE_TYPES.POINT:
        return { color: '#e74c3c', radius: 6, opacity: 0.8, fillOpacity: 0.6 };
      case NODE_TYPES.POLYLINE:
        return { color: '#3498db', weight: 2, opacity: 0.8 };
      case NODE_TYPES.POLYGON:
        return { color: '#27ae60', fillColor: '#27ae60', weight: 1, opacity: 0.8, fillOpacity: 0.3 };
      case NODE_TYPES.HEAT_FIELD:
        return { radius: 25, blur: 15, maxOpacity: 0.8, gradient: { 0.4: '#00f', 0.65: '#0f0', 1.0: '#f00' } };
      case NODE_TYPES.CLUSTER:
        return { color: '#9b59b6', opacity: 0.9 };
      case NODE_TYPES.BILLBOARD:
        return { size: [32, 32], anchor: [0.5, 1.0], opacity: 1.0 };
      case NODE_TYPES.LABEL:
        return { font: '12px sans-serif', color: '#333', background: 'rgba(255,255,255,0.8)', padding: 4 };
      case NODE_TYPES.ARROW:
        return { color: '#e67e22', weight: 2, arrowSize: 8, opacity: 0.9 };
      case NODE_TYPES.HIGHLIGHT:
        return { color: '#f39c12', fillColor: '#f39c12', weight: 3, opacity: 1.0, fillOpacity: 0.2 };
      case NODE_TYPES.CAMERA:
        return {};
      case NODE_TYPES.LIGHT:
        return { intensity: 1.0, color: '#ffffff' };
      case NODE_TYPES.MESH:
        return { color: '#95a5a6', opacity: 0.9, wireframe: false };
      case NODE_TYPES.RASTER:
        return { opacity: 1.0, maxZoom: 19 };
      default:
        return {};
    }
  }

  /**
   * Default LOD rules: every node is visible at all LOD levels unless
   * the caller restricts it.
   */
  function _defaultLod() {
    return {
      minLevel: LOD_LEVELS.DISTANT,
      maxLevel: LOD_LEVELS.PEDESTRIAN,
      // Optional per-level overrides, e.g. { city: { visible: false } }
      overrides: {}
    };
  }

  /** Default interaction metadata. */
  function _defaultInteraction() {
    return {
      selectable: false,
      hoverable:  false,
      data:       null    // arbitrary payload surfaced to interaction handlers
    };
  }

  // ---- SceneGraph root helpers ----

  /**
   * Walk the nodes array and locate a node by id, recursing into children.
   */
  function _findNodeById(nodes, id) {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children && node.children.length) {
        const found = _findNodeById(node.children, id);
        if (found) return found;
      }
    }
    return null;
  }

  // ---- public API ----

  UA.SceneGraph = {

    NODE_TYPES:         NODE_TYPES,
    LOD_LEVELS:         LOD_LEVELS,
    INTERACTION_EVENTS: INTERACTION_EVENTS,
    SCHEMA_VERSION:     SCHEMA_VERSION,

    /**
     * Create an empty SceneGraph with sensible defaults.
     *
     * @param {object} [overrides]
     * @returns {SceneGraph}
     */
    create: function createSceneGraph(overrides) {
      const defaults = {
        version:  SCHEMA_VERSION,
        id:       null,
        lod:      LOD_LEVELS.CITY,    // active LOD level
        nodes:    [],                 // root-level nodes
        metadata: {
          title:            '',
          description:      '',
          created:          new Date().toISOString(),
          mapMode:          'standard',
          sourceAttribution: ''
        }
      };
      if (!overrides) return defaults;
      const result = Object.assign({}, defaults, overrides);
      if (overrides.metadata) {
        result.metadata = Object.assign({}, defaults.metadata, overrides.metadata);
      }
      if (overrides.nodes) {
        result.nodes = overrides.nodes.slice();
      }
      return result;
    },

    /**
     * Create a typed SceneNode with all required fields.
     *
     * @param {string} type   — one of NODE_TYPES
     * @param {object} [opts] — optional field overrides
     * @returns {SceneNode}
     */
    createNode: function createNode(type, opts) {
      if (!type) throw new Error('SceneGraph.createNode: type is required');
      const o = opts || {};
      return {
        id:          o.id       || _generateId(type),
        type:        type,
        geometry:    o.geometry || {},
        style:       Object.assign(_defaultStyle(type), o.style || {}),
        semantic:    o.semantic || { kind: type, label: '' },
        interaction: Object.assign(_defaultInteraction(), o.interaction || {}),
        lod:         Object.assign(_defaultLod(), o.lod || {}),
        children:    Array.isArray(o.children) ? o.children.slice() : []
      };
    },

    /**
     * Return a new SceneGraph with the given node appended to the root nodes.
     * The original graph is not mutated.
     *
     * @param {SceneGraph} graph
     * @param {SceneNode}  node
     * @returns {SceneGraph}
     */
    addNode: function addNode(graph, node) {
      if (!graph) throw new Error('SceneGraph.addNode: graph is required');
      if (!node || !node.type) throw new Error('SceneGraph.addNode: node.type is required');
      return Object.assign({}, graph, {
        nodes: graph.nodes.concat([_clone(node)])
      });
    },

    /**
     * Return a new SceneGraph with the node identified by nodeId removed from
     * the root nodes.  A no-op if the node does not exist at root level.
     * The original graph is not mutated.
     *
     * @param {SceneGraph} graph
     * @param {string}     nodeId
     * @returns {SceneGraph}
     */
    removeNode: function removeNode(graph, nodeId) {
      if (!graph || !nodeId) return graph;
      const exists = graph.nodes.some(n => n.id === nodeId);
      if (!exists) return graph;
      return Object.assign({}, graph, {
        nodes: graph.nodes.filter(n => n.id !== nodeId)
      });
    },

    /**
     * Return the SceneNode with the given id, or null if not found.
     * Searches root nodes and their children recursively.
     *
     * @param {SceneGraph} graph
     * @param {string}     nodeId
     * @returns {SceneNode|null}
     */
    getNode: function getNode(graph, nodeId) {
      if (!graph || !nodeId) return null;
      return _findNodeById(graph.nodes, nodeId);
    },

    /**
     * Build a SceneGraph from a TrafficSituation.
     *
     * This is the primary entry point of the rendering pipeline:
     *
     *   TrafficSituation → SceneGraph → Renderer
     *
     * The function converts the accident data and analysis results in the
     * TrafficSituation layers into renderer-independent scene nodes.
     * Renderers consume the resulting SceneGraph without any knowledge of
     * the TrafficSituation structure.
     *
     * Currently produced nodes
     *   - One POINT node per accident in the accident layer
     *   - One CLUSTER node per hotspot cluster (if present)
     *   - One HEAT_FIELD node when heatmap visibility is enabled
     *   - One BILLBOARD node per POI point (if present)
     *   - One LABEL node per recommendation (if present)
     *   - One RASTER node for the base tile layer (if present in the presentation layer)
     *
     * Scene-level metadata populated:
     *   - metadata.mapMode          — from the presentation layer (default: 'standard')
     *   - metadata.sourceAttribution — base-layer attribution string (for export/preview)
     *
     * @param {TrafficSituation} ts
     * @returns {SceneGraph}
     */
    fromTrafficSituation: function fromTrafficSituation(ts) {
      const SG = UA.SceneGraph;

      if (!ts) return SG.create();

      const meta = ts.metadata || {};

      // ---- Extract presentation/rendering hints ----
      const presentationLayer = ts.layers && ts.layers.presentation;
      const presentation = (presentationLayer && presentationLayer.data) || {};
      const mapMode = presentation.mapMode || 'standard';
      const sourceAttribution = presentation.baseLayerAttribution || '';

      let graph = SG.create({
        id:  ts.id || null,
        lod: _lodFromZoom(ts.core && ts.core.viewport && ts.core.viewport.zoom),
        metadata: {
          title:            meta.city || '',
          description:      meta.description || '',
          created:          meta.created || new Date().toISOString(),
          mapMode:          mapMode,
          sourceAttribution: sourceAttribution
        }
      });

      const layerVisibility = (ts.core && ts.core.layerVisibility) || {};

      // ---- RASTER base layer ----
      // When the presentation layer carries base-tile information, emit a
      // renderer-independent RASTER node so export/preview code can read the
      // tile URL and attribution from the scene graph without touching Leaflet.
      if (presentation.baseLayerUrl) {
        const rasterNode = SG.createNode(NODE_TYPES.RASTER, {
          geometry: {
            url:           presentation.baseLayerUrl,
            technicalType: presentation.baseLayerTechnicalType || 'XYZ',
            subdomains:    presentation.baseLayerSubdomains || null,
            layers:        presentation.baseLayerWmsLayers   || null,
            format:        presentation.baseLayerFormat      || null,
            transparent:   presentation.baseLayerTransparent != null
                             ? !!presentation.baseLayerTransparent : false
          },
          style: {
            opacity: presentation.baseLayerOpacity != null
                       ? presentation.baseLayerOpacity : 1.0,
            maxZoom: presentation.baseLayerMaxZoom != null
                       ? presentation.baseLayerMaxZoom : 19
          },
          semantic: {
            kind:            'baseLayer',
            label:           presentation.baseLayerLabel     || '',
            layerId:         presentation.baseLayerId        || null,
            provider:        presentation.baseLayerProvider  || null,
            attribution:     presentation.baseLayerAttribution || '',
            license:         presentation.baseLayerLicense   || null,
            officialForExport: presentation.baseLayerOfficialForExport !== false
          },
          lod: {
            minLevel: LOD_LEVELS.DISTANT,
            maxLevel: LOD_LEVELS.PEDESTRIAN,
            overrides: {}
          }
        });
        graph = SG.addNode(graph, rasterNode);
      }

      // ---- Accident points ----
      const accidentLayer = ts.layers && ts.layers.accident;
      if (accidentLayer && accidentLayer.data) {
        const features = _extractFeatures(accidentLayer.data);
        for (const f of features) {
          const coords = _extractCoords(f);
          if (!coords) continue;
          const props = f.properties || {};
          const severity = props.UKATEGORIE || props.severity || 0;
          const node = SG.createNode(NODE_TYPES.POINT, {
            geometry: { lat: coords[1], lon: coords[0] },
            style:    {
              color:       _severityColor(severity),
              radius:      _severityRadius(severity),
              opacity:     0.85,
              fillOpacity: 0.65
            },
            semantic: {
              kind:     'accident',
              label:    props.label || '',
              severity: severity,
              year:     props.UJAHR || props.year || null
            },
            interaction: {
              selectable: true,
              hoverable:  true,
              data:       props
            },
            lod: {
              minLevel: LOD_LEVELS.CITY,
              maxLevel: LOD_LEVELS.PEDESTRIAN,
              overrides: {}
            }
          });
          graph = SG.addNode(graph, node);
        }
      }

      // ---- Heatmap field ----
      if (layerVisibility.showHeatmap !== false) {
        const heatNode = SG.createNode(NODE_TYPES.HEAT_FIELD, {
          geometry: { source: 'accident' },
          semantic: { kind: 'heatmap', label: 'Unfall-Heatmap' },
          lod: {
            minLevel: LOD_LEVELS.DISTANT,
            maxLevel: LOD_LEVELS.STREET,
            overrides: {}
          }
        });
        graph = SG.addNode(graph, heatNode);
      }

      // ---- Cluster ----
      if (layerVisibility.showCluster !== false) {
        const clusterNode = SG.createNode(NODE_TYPES.CLUSTER, {
          geometry: { source: 'accident' },
          semantic: { kind: 'cluster', label: 'Unfall-Cluster' },
          lod: {
            minLevel: LOD_LEVELS.DISTANT,
            maxLevel: LOD_LEVELS.INTERSECTION,
            overrides: {}
          }
        });
        graph = SG.addNode(graph, clusterNode);
      }

      // ---- POI points ----
      const poiLayer = ts.layers && ts.layers.poi;
      if (poiLayer && poiLayer.data) {
        const features = _extractFeatures(poiLayer.data);
        for (const f of features) {
          const coords = _extractCoords(f);
          if (!coords) continue;
          const props = f.properties || {};
          const poiKind = props.amenity || props.kind || 'poi';
          const visible = (poiKind === 'school'       && layerVisibility.showSchools       !== false) ||
                          (poiKind === 'kindergarten' && layerVisibility.showKindergartens !== false) ||
                          (poiKind !== 'school' && poiKind !== 'kindergarten');
          if (!visible) continue;
          const node = SG.createNode(NODE_TYPES.BILLBOARD, {
            geometry:    { lat: coords[1], lon: coords[0] },
            semantic:    { kind: poiKind, label: props.name || '' },
            interaction: { selectable: true, hoverable: true, data: props },
            lod: {
              minLevel: LOD_LEVELS.CITY,
              maxLevel: LOD_LEVELS.PEDESTRIAN,
              overrides: {}
            }
          });
          graph = SG.addNode(graph, node);
        }
      }

      // ---- Recommendation labels ----
      const recLayer = ts.layers && ts.layers.recommendation;
      if (recLayer && recLayer.data) {
        const items = Array.isArray(recLayer.data) ? recLayer.data : [];
        for (const rec of items) {
          if (!rec || !rec.location) continue;
          const node = SG.createNode(NODE_TYPES.LABEL, {
            geometry:    { lat: rec.location.lat, lon: rec.location.lon != null ? rec.location.lon : rec.location.lng },
            semantic:    { kind: 'recommendation', label: rec.text || rec.title || '' },
            interaction: { selectable: true, hoverable: true, data: rec },
            lod: {
              minLevel: LOD_LEVELS.STREET,
              maxLevel: LOD_LEVELS.PEDESTRIAN,
              overrides: {}
            }
          });
          graph = SG.addNode(graph, node);
        }
      }

      return graph;
    }
  };

  // ---- private helpers ----

  /**
   * Map a Leaflet zoom level to a LOD level.
   * Zoom 0–9  → DISTANT, 10–12 → CITY, 13–15 → STREET,
   * 16–17     → INTERSECTION, 18+ → PEDESTRIAN
   */
  function _lodFromZoom(zoom) {
    if (zoom == null) return LOD_LEVELS.CITY;
    if (zoom <= 9)   return LOD_LEVELS.DISTANT;
    if (zoom <= 12)  return LOD_LEVELS.CITY;
    if (zoom <= 15)  return LOD_LEVELS.STREET;
    if (zoom <= 17)  return LOD_LEVELS.INTERSECTION;
    return LOD_LEVELS.PEDESTRIAN;
  }

  /** Extract features from a GeoJSON FeatureCollection or Feature array. */
  function _extractFeatures(data) {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      return data.features;
    }
    if (data.type === 'Feature') return [data];
    return [];
  }

  /** Extract [lon, lat] from a GeoJSON Feature's geometry. */
  function _extractCoords(feature) {
    if (!feature) return null;
    const geom = feature.geometry;
    if (!geom) return null;
    if (geom.type === 'Point' && Array.isArray(geom.coordinates)) {
      return geom.coordinates;
    }
    // Support plain {lat, lon} or {lat, lng} on the feature directly
    if (feature.lat != null) {
      const lon = feature.lon != null ? feature.lon : feature.lng;
      return [lon, feature.lat];
    }
    return null;
  }

  /**
   * Map a UKATEGORIE severity code to a CSS colour string.
   * 1 = fatal (Getötete), 2 = serious injury, 3 = slight injury.
   */
  function _severityColor(severity) {
    if (severity === 1 || severity === '1') return '#e74c3c'; // red
    if (severity === 2 || severity === '2') return '#e67e22'; // orange
    if (severity === 3 || severity === '3') return '#f1c40f'; // yellow
    return '#95a5a6'; // grey (unknown)
  }

  /** Map severity to circle radius. */
  function _severityRadius(severity) {
    if (severity === 1 || severity === '1') return 8;
    if (severity === 2 || severity === '2') return 6;
    return 5;
  }

})();
