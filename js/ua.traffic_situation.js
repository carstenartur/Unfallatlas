(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  // ----------------------------
  // TrafficSituation — first-class domain model
  //
  // A TrafficSituation is the primary unit of road-safety analysis in the
  // Unfallwerkbank.  It is a single serialisable object that captures
  // everything needed to analyse, render, export or share a specific
  // accident situation independently of the UI or rendering engine.
  //
  // Architecture overview:
  //
  //   TrafficSituation
  //   ├── core       (Viewport, Filters, Selection — UI-agnostic)
  //   ├── metadata   (city, timestamps, description)
  //   └── layers     (keyed map of optional, versioned LayerStates)
  //        ├── accident         — raw accident point data (GeoJSON)
  //        ├── poi              — points of interest (schools, playgrounds …)
  //        ├── contextRoad      — road-context enrichment (slope, traffic-proxy)
  //        ├── politicalContext — policy documents / parliamentary references
  //        ├── environmental    — weather, lighting, road surface context
  //        ├── aiAssessment     — AI-generated situation assessment
  //        ├── recommendation   — derived safety-measure recommendations
  //        ├── export           — export-specific options and artefacts
  //        └── presentation     — rendering hints (colours, zoom, layout)
  //
  // Design principles
  //   - No Leaflet dependency.  Every field is a plain JSON value.
  //   - Every layer is optional and independently reusable.
  //   - The object is fully serialisable via JSON.stringify / JSON.parse.
  //   - URLs can reference a TrafficSituation by its `id` field.
  //   - A TrafficSituation can be created from a MapScene (and vice-versa)
  //     for backward compatibility with existing URL and export code.
  //
  // Public API
  //   UA.TrafficSituation.create(overrides?)          → TrafficSituation
  //   UA.TrafficSituation.fromMapScene(scene, layers?) → TrafficSituation
  //   UA.TrafficSituation.toMapScene(ts)              → MapScene
  //   UA.TrafficSituation.addLayer(ts, layer)         → TrafficSituation (new)
  //   UA.TrafficSituation.removeLayer(ts, layerType)  → TrafficSituation (new)
  //   UA.TrafficSituation.getLayer(ts, layerType)     → LayerState | null
  //   UA.TrafficSituation.serialize(ts)               → plain JSON-safe object
  //   UA.TrafficSituation.deserialize(data)           → TrafficSituation
  //
  // Layer types (UA.TrafficSituation.LAYER_TYPES):
  //   ACCIDENT, POI, CONTEXT_ROAD, POLITICAL_CONTEXT, ENVIRONMENTAL,
  //   AI_ASSESSMENT, RECOMMENDATION, EXPORT, PRESENTATION
  // ----------------------------

  /** All recognised layer-type identifiers. */
  const LAYER_TYPES = Object.freeze({
    ACCIDENT:          'accident',
    POI:               'poi',
    CONTEXT_ROAD:      'contextRoad',
    POLITICAL_CONTEXT: 'politicalContext',
    ENVIRONMENTAL:     'environmental',
    AI_ASSESSMENT:     'aiAssessment',
    RECOMMENDATION:    'recommendation',
    EXPORT:            'export',
    PRESENTATION:      'presentation'
  });

  /** Current schema version of the TrafficSituation object. */
  const SCHEMA_VERSION = 1;

  // ---- internal helpers ----

  function _now() {
    return new Date().toISOString();
  }

  /** Deep-clone a plain JSON-safe value (no functions, no DOM). */
  function _clone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  /** Return a copy of `ts` with the layer map replaced by `nextLayers`. */
  function _withLayers(ts, nextLayers) {
    return Object.assign({}, ts, { layers: nextLayers });
  }

  // ---- default core section ----

  function _defaultCore() {
    return {
      viewport:        { center: null, zoom: null },
      selection:       null,
      filters: {
        severity:          'all',
        dayType:           'all',
        roadCondition:     'all',
        hourFrom:          0,
        hourTo:            23,
        maxPoints:         100000,
        viewportPaddingPct: 20,
        heatRadius:        25,
        includeCyclist:    true,
        includePedestrian: true,
        includeCar:        true,
        includeMotorcycle: false,
        includeGkfz:       false,
        includeSonstig:    false,
        involvementMode:   'or',
        contextFilters: {
          slopeClasses:    [],
          trafficClasses:  [],
          onlyMatchedWays: false
        }
      },
      layerVisibility: {
        showCluster:          true,
        showHeatmap:          true,
        showOnlyAboveAverage: false,
        showSchools:          true,
        showKindergartens:    true,
        showArgumentation:    true
      },
      accidentView:    'bySeverity'
    };
  }

  function _defaultMetadata(city) {
    const now = _now();
    return {
      created:     now,
      updated:     now,
      city:        city || '',
      description: ''
    };
  }

  // ---- deep-merge helpers ----

  function _mergeCore(base, overrides) {
    if (!overrides) return base;
    const result = Object.assign({}, base, overrides);
    if (overrides.viewport) {
      result.viewport = Object.assign({}, base.viewport, overrides.viewport);
    }
    if (overrides.filters) {
      result.filters = Object.assign({}, base.filters, overrides.filters);
      if (overrides.filters.contextFilters) {
        result.filters.contextFilters = Object.assign(
          {}, base.filters.contextFilters, overrides.filters.contextFilters
        );
      }
    }
    if (overrides.layerVisibility) {
      result.layerVisibility = Object.assign({}, base.layerVisibility, overrides.layerVisibility);
    }
    return result;
  }

  // ---- public API ----

  UA.TrafficSituation = {

    LAYER_TYPES: LAYER_TYPES,
    SCHEMA_VERSION: SCHEMA_VERSION,

    /**
     * Create a new TrafficSituation with sensible defaults.
     *
     * @param {object} [overrides]
     *   Optional top-level field overrides.  Supported keys:
     *     id, metadata (shallow-merged), core (deep-merged), layers (object).
     * @returns {TrafficSituation}
     */
    create: function createTrafficSituation(overrides) {
      const defaults = {
        version:  SCHEMA_VERSION,
        id:       null,
        metadata: _defaultMetadata(),
        core:     _defaultCore(),
        layers:   {}
      };

      if (!overrides) return defaults;

      const result = Object.assign({}, defaults, overrides);
      if (overrides.metadata) {
        result.metadata = Object.assign({}, defaults.metadata, overrides.metadata);
      }
      if (overrides.core) {
        result.core = _mergeCore(defaults.core, overrides.core);
      }
      if (overrides.layers) {
        result.layers = Object.assign({}, defaults.layers, overrides.layers);
      }
      return result;
    },

    /**
     * Build a TrafficSituation from an existing MapScene.
     * This allows incremental migration: existing code can keep producing
     * MapScenes while new code operates on TrafficSituations.
     *
     * @param {MapScene} scene   — a MapScene (from UA.MapScene.create / fromCtx)
     * @param {object}   [layers] — optional initial layers to attach
     * @returns {TrafficSituation}
     */
    fromMapScene: function fromMapScene(scene, layers) {
      if (!scene) return UA.TrafficSituation.create();

      const core = {
        viewport: {
          center: scene.center ? Object.assign({}, scene.center) : null,
          zoom:   scene.zoom != null ? scene.zoom : null
        },
        selection:       scene.selection ? Object.assign({}, scene.selection) : null,
        filters:         scene.filters   ? _clone(scene.filters)   : _defaultCore().filters,
        layerVisibility: scene.layers    ? _clone(scene.layers)    : _defaultCore().layerVisibility,
        accidentView:    scene.accidentView || 'bySeverity'
      };

      return UA.TrafficSituation.create({
        metadata: { city: scene.city || '' },
        core:     core,
        layers:   layers ? _clone(layers) : {}
      });
    },

    /**
     * Convert a TrafficSituation back to a MapScene-compatible object.
     * Useful when passing a TrafficSituation to code that still expects a
     * MapScene (e.g. UA.MapSceneUrlCodec, UA.PreviewMapRenderer).
     *
     * @param {TrafficSituation} ts
     * @returns {MapScene}
     */
    toMapScene: function toMapScene(ts) {
      if (!ts || !ts.core) {
        // fall back to UA.MapScene.create() if available, else plain defaults
        if (UA.MapScene && typeof UA.MapScene.create === 'function') {
          return UA.MapScene.create();
        }
        return null;
      }
      const core = ts.core;
      const scene = {
        city:            (ts.metadata && ts.metadata.city) || '',
        center:          core.viewport ? core.viewport.center : null,
        zoom:            core.viewport ? core.viewport.zoom   : null,
        selection:       core.selection    || null,
        filters:         _clone(core.filters         || {}),
        layers:          _clone(core.layerVisibility || {}),
        accidentView:    core.accidentView || 'bySeverity',
        exportOptions:   {},
        contextOverlays: { active: { slope: false, traffic: false } }
      };
      // Carry context-overlay state from the contextRoad layer if present.
      const ctxLayer = ts.layers && ts.layers[LAYER_TYPES.CONTEXT_ROAD];
      if (ctxLayer && ctxLayer.meta && ctxLayer.meta.contextOverlays) {
        scene.contextOverlays = _clone(ctxLayer.meta.contextOverlays);
      }
      return scene;
    },

    /**
     * Return a new TrafficSituation with the given layer added (or replaced).
     * The original `ts` is not mutated.
     *
     * @param {TrafficSituation} ts
     * @param {LayerState}       layer  — must have a `type` property
     * @returns {TrafficSituation}
     */
    addLayer: function addLayer(ts, layer) {
      if (!layer || !layer.type) throw new Error('TrafficSituation.addLayer: layer.type is required');
      const nextLayers = Object.assign({}, ts.layers, { [layer.type]: _clone(layer) });
      const nextMeta   = Object.assign({}, ts.metadata, { updated: _now() });
      return Object.assign({}, ts, { layers: nextLayers, metadata: nextMeta });
    },

    /**
     * Return a new TrafficSituation with the named layer removed.
     * The original `ts` is not mutated.  A no-op if the layer does not exist.
     *
     * @param {TrafficSituation} ts
     * @param {string}           layerType
     * @returns {TrafficSituation}
     */
    removeLayer: function removeLayer(ts, layerType) {
      if (!ts.layers || !(layerType in ts.layers)) return ts;
      const nextLayers = Object.assign({}, ts.layers);
      delete nextLayers[layerType];
      const nextMeta = Object.assign({}, ts.metadata, { updated: _now() });
      return Object.assign({}, ts, { layers: nextLayers, metadata: nextMeta });
    },

    /**
     * Return the LayerState for the given type, or null if not present.
     *
     * @param {TrafficSituation} ts
     * @param {string}           layerType
     * @returns {LayerState|null}
     */
    getLayer: function getLayer(ts, layerType) {
      return (ts && ts.layers && ts.layers[layerType]) || null;
    },

    /**
     * Serialise a TrafficSituation to a plain JSON-safe object.
     * Identical to the object itself because the model contains only plain
     * JSON values — provided here as an explicit API boundary.
     *
     * @param {TrafficSituation} ts
     * @returns {object}
     */
    serialize: function serialize(ts) {
      return _clone(ts);
    },

    /**
     * Deserialise a plain object (e.g. from JSON.parse) back into a
     * TrafficSituation, validating the schema version.
     *
     * @param {object} data
     * @returns {TrafficSituation}
     */
    deserialize: function deserialize(data) {
      if (!data || typeof data !== 'object') {
        throw new Error('TrafficSituation.deserialize: expected a plain object');
      }
      if (data.version !== SCHEMA_VERSION) {
        throw new Error(
          'TrafficSituation.deserialize: unsupported schema version ' + data.version +
          ' (expected ' + SCHEMA_VERSION + ')'
        );
      }
      // Re-create through create() to fill in any missing defaults.
      return UA.TrafficSituation.create(_clone(data));
    }
  };

})();
