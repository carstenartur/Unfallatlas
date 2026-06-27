(() => {
  'use strict';

  const UA = (window.UA = window.UA || {});

  const DATA_KEYS = Object.freeze({
    ACCIDENTS:            'accidents',
    VIEWPORT:             'viewport',
    SELECTION:            'selection',
    POIS:                 'pois',
    ROAD_CONTEXT:         'roadContext',
    POLITICAL_REFERENCES: 'politicalReferences',
    ENVIRONMENTAL_DATA:   'environmentalData',
    TRAFFIC_COUNTS:       'trafficCounts',
    CITY_MODEL_3D:        'cityModel3d',
    AI_FINDINGS:          'aiFindings',
    RECOMMENDATIONS:      'recommendations',
    SCENE_GRAPH:          'sceneGraph',
    EXPORTS:              'exports'
  });

  const CAPABILITIES = Object.freeze({
    HAS_ACCIDENT_DATA:         'hasAccidentData',
    HAS_VIEWPORT:              'hasViewport',
    HAS_POI_DATA:              'hasPoiData',
    HAS_ROAD_CONTEXT:          'hasRoadContext',
    HAS_SLOPE_DATA:            'hasSlopeData',
    HAS_SURFACE_DATA:          'hasSurfaceData',
    HAS_RAIL_DATA:             'hasRailData',
    HAS_POLITICAL_REFERENCES:  'hasPoliticalReferences',
    HAS_TRAFFIC_COUNTS:        'hasTrafficCounts',
    HAS_3D_CITY_MODEL:         'has3dCityModel',
    HAS_AI_ASSESSMENT:         'hasAiAssessment',
    HAS_RECOMMENDATIONS:       'hasRecommendations',
    HAS_SCENE_GRAPH:           'hasSceneGraph',
    HAS_EXPORTS:               'hasExports'
  });

  const PLUGIN_STATUSES = Object.freeze({
    COMPLETE: 'complete',
    PARTIAL:  'partial',
    SKIPPED:  'skipped',
    FAILED:   'failed'
  });

  function _clone(value) {
    if (value === null || value === undefined) return value;
    return JSON.parse(JSON.stringify(value));
  }

  function _unique(items) {
    return Array.from(new Set((Array.isArray(items) ? items : []).filter(Boolean)));
  }

  function _hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function _hasDataValue(value) {
    return value !== null && value !== undefined;
  }

  function _getAt(value, path) {
    let cur = value;
    for (const segment of path) {
      if (cur == null || typeof cur !== 'object' || !_hasOwn(cur, segment)) return undefined;
      cur = cur[segment];
    }
    return cur;
  }

  function _looksLikeEntry(value) {
    return !!value && typeof value === 'object' && _hasOwn(value, 'value');
  }

  function _normaliseEntry(value) {
    if (_looksLikeEntry(value)) {
      return {
        value:       _clone(value.value),
        provenance:  _clone(value.provenance || null),
        updatedAt:   value.updatedAt || null,
        sourcePlugin: value.sourcePlugin || null
      };
    }
    return {
      value:       _clone(value),
      provenance:  null,
      updatedAt:   null,
      sourcePlugin: null
    };
  }

  function _normaliseEntries(seed) {
    const entries = {};
    Object.keys(seed || {}).forEach((key) => {
      entries[key] = _normaliseEntry(seed[key]);
    });
    return entries;
  }

  function _normaliseProducedArtifacts(producedArtifacts, declaredArtifacts) {
    const keys = _unique(declaredArtifacts && declaredArtifacts.length
      ? declaredArtifacts
      : Object.keys(producedArtifacts || {}));
    const out = {};
    keys.forEach((key) => {
      if (_hasOwn(producedArtifacts || {}, key)) out[key] = _clone(producedArtifacts[key]);
    });
    return out;
  }

  function _defaultProvenance(plugin, ctx, extra) {
    return Object.assign({
      pluginId:    plugin.id,
      pluginName:  plugin.name,
      generatedAt: new Date().toISOString(),
      dependsOn:   _clone(plugin.dependsOn),
      inputs: {
        requiredData:            _clone(plugin.requiredData),
        optionalDataUsed:        plugin.optionalData.filter((key) => UA.AnalysisPipeline.hasData(ctx.dataRegistry, key)),
        requiredCapabilities:    _clone(plugin.requiredCapabilities),
        optionalCapabilitiesUsed: plugin.optionalCapabilities.filter((cap) => UA.AnalysisPipeline.hasCapability(ctx.capabilityRegistry, cap))
      }
    }, _clone(extra || {}));
  }

  function _buildDataRegistry(ts, seedEntries) {
    let registry = UA.AnalysisPipeline.createDataRegistry(seedEntries);
    if (!ts || typeof ts !== 'object') return registry;

    const LT = UA.TrafficSituation && UA.TrafficSituation.LAYER_TYPES;
    if (ts.core && ts.core.viewport && _hasDataValue(ts.core.viewport.center)) {
      registry = UA.AnalysisPipeline.setData(registry, DATA_KEYS.VIEWPORT, ts.core.viewport, {
        provenance: { source: 'trafficSituation.core.viewport' }
      });
    }
    if (ts.core && ts.core.selection) {
      registry = UA.AnalysisPipeline.setData(registry, DATA_KEYS.SELECTION, ts.core.selection, {
        provenance: { source: 'trafficSituation.core.selection' }
      });
    }
    if (!LT || !ts.layers) return registry;

    const mapping = [
      [LT.ACCIDENT, DATA_KEYS.ACCIDENTS],
      [LT.POI, DATA_KEYS.POIS],
      [LT.CONTEXT_ROAD, DATA_KEYS.ROAD_CONTEXT],
      [LT.POLITICAL_CONTEXT, DATA_KEYS.POLITICAL_REFERENCES],
      [LT.ENVIRONMENTAL, DATA_KEYS.ENVIRONMENTAL_DATA],
      [LT.AI_ASSESSMENT, DATA_KEYS.AI_FINDINGS],
      [LT.RECOMMENDATION, DATA_KEYS.RECOMMENDATIONS],
      [LT.EXPORT, DATA_KEYS.EXPORTS]
    ];

    mapping.forEach(([layerType, key]) => {
      const layer = ts.layers[layerType];
      if (!layer || !_hasDataValue(layer.data)) return;
      registry = UA.AnalysisPipeline.setData(registry, key, layer.data, {
        provenance: {
          source:    'trafficSituation.layers.' + layerType,
          layerType: layerType,
          layerMeta: _clone(layer.meta || null)
        }
      });
    });

    return registry;
  }

  function _buildCapabilityRegistry(dataRegistry, overrides) {
    const entries = (dataRegistry && dataRegistry.entries) || {};
    const roadContext = UA.AnalysisPipeline.getData(dataRegistry, DATA_KEYS.ROAD_CONTEXT);
    const environmental = UA.AnalysisPipeline.getData(dataRegistry, DATA_KEYS.ENVIRONMENTAL_DATA);
    const merged = Object.assign({}, overrides || {});

    function mark(name, available, sources) {
      const override = _hasOwn(merged, name) ? merged[name] : undefined;
      if (typeof override === 'boolean') {
        return { available: override, sources: override ? _unique(sources) : [] };
      }
      if (override && typeof override === 'object' && typeof override.available === 'boolean') {
        return {
          available: override.available,
          sources:   _unique(override.sources || sources || [])
        };
      }
      return { available: !!available, sources: available ? _unique(sources || []) : [] };
    }

    return Object.freeze({
      capabilities: Object.freeze({
        [CAPABILITIES.HAS_ACCIDENT_DATA]:        mark(CAPABILITIES.HAS_ACCIDENT_DATA, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.ACCIDENTS), [DATA_KEYS.ACCIDENTS]),
        [CAPABILITIES.HAS_VIEWPORT]:             mark(CAPABILITIES.HAS_VIEWPORT, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.VIEWPORT), [DATA_KEYS.VIEWPORT]),
        [CAPABILITIES.HAS_POI_DATA]:             mark(CAPABILITIES.HAS_POI_DATA, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.POIS), [DATA_KEYS.POIS]),
        [CAPABILITIES.HAS_ROAD_CONTEXT]:         mark(CAPABILITIES.HAS_ROAD_CONTEXT, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.ROAD_CONTEXT), [DATA_KEYS.ROAD_CONTEXT]),
        [CAPABILITIES.HAS_SLOPE_DATA]:           mark(CAPABILITIES.HAS_SLOPE_DATA, !!(
          roadContext && (_hasDataValue(roadContext.slope) || _hasDataValue(roadContext.slopes) || _hasDataValue(_getAt(roadContext, ['summary', 'slopeClasses'])))
        ), [DATA_KEYS.ROAD_CONTEXT]),
        [CAPABILITIES.HAS_SURFACE_DATA]:         mark(CAPABILITIES.HAS_SURFACE_DATA, !!(
          _hasDataValue(_getAt(roadContext, ['surface'])) || _hasDataValue(_getAt(environmental, ['surface']))
        ), [DATA_KEYS.ROAD_CONTEXT, DATA_KEYS.ENVIRONMENTAL_DATA]),
        [CAPABILITIES.HAS_RAIL_DATA]:            mark(CAPABILITIES.HAS_RAIL_DATA, !!(
          _hasDataValue(_getAt(roadContext, ['rail'])) || _hasDataValue(_getAt(roadContext, ['rails']))
        ), [DATA_KEYS.ROAD_CONTEXT]),
        [CAPABILITIES.HAS_POLITICAL_REFERENCES]: mark(CAPABILITIES.HAS_POLITICAL_REFERENCES, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.POLITICAL_REFERENCES), [DATA_KEYS.POLITICAL_REFERENCES]),
        [CAPABILITIES.HAS_TRAFFIC_COUNTS]:       mark(CAPABILITIES.HAS_TRAFFIC_COUNTS, !!(
          UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.TRAFFIC_COUNTS) || _hasDataValue(_getAt(roadContext, ['trafficCounts']))
        ), [DATA_KEYS.TRAFFIC_COUNTS, DATA_KEYS.ROAD_CONTEXT]),
        [CAPABILITIES.HAS_3D_CITY_MODEL]:        mark(CAPABILITIES.HAS_3D_CITY_MODEL, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.CITY_MODEL_3D), [DATA_KEYS.CITY_MODEL_3D]),
        [CAPABILITIES.HAS_AI_ASSESSMENT]:        mark(CAPABILITIES.HAS_AI_ASSESSMENT, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.AI_FINDINGS), [DATA_KEYS.AI_FINDINGS]),
        [CAPABILITIES.HAS_RECOMMENDATIONS]:      mark(CAPABILITIES.HAS_RECOMMENDATIONS, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.RECOMMENDATIONS), [DATA_KEYS.RECOMMENDATIONS]),
        [CAPABILITIES.HAS_SCENE_GRAPH]:          mark(CAPABILITIES.HAS_SCENE_GRAPH, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.SCENE_GRAPH), [DATA_KEYS.SCENE_GRAPH]),
        [CAPABILITIES.HAS_EXPORTS]:              mark(CAPABILITIES.HAS_EXPORTS, UA.AnalysisPipeline.hasData(dataRegistry, DATA_KEYS.EXPORTS), [DATA_KEYS.EXPORTS])
      }),
      dataKeys: Object.freeze(Object.keys(entries))
    });
  }

  function _topoSortPlugins(pluginsById) {
    const ordered = [];
    const visiting = new Set();
    const visited = new Set();

    function visit(plugin) {
      if (!plugin || visited.has(plugin.id)) return;
      if (visiting.has(plugin.id)) {
        throw new Error('AnalysisPipeline: plugin dependency cycle detected at ' + plugin.id);
      }
      visiting.add(plugin.id);
      plugin.dependsOn.forEach((depId) => {
        if (!pluginsById[depId]) {
          throw new Error('AnalysisPipeline: plugin ' + plugin.id + ' depends on unknown plugin ' + depId);
        }
        visit(pluginsById[depId]);
      });
      visiting.delete(plugin.id);
      visited.add(plugin.id);
      ordered.push(plugin);
    }

    Object.keys(pluginsById).forEach((id) => visit(pluginsById[id]));
    return ordered;
  }

  UA.AnalysisPipeline = {
    DATA_KEYS: DATA_KEYS,
    CAPABILITIES: CAPABILITIES,
    PLUGIN_STATUSES: PLUGIN_STATUSES,

    createDataRegistry: function createDataRegistry(seedEntries) {
      return Object.freeze({ entries: Object.freeze(_normaliseEntries(seedEntries || {})) });
    },

    setData: function setData(registry, key, value, meta) {
      const next = Object.assign({}, (registry && registry.entries) || {});
      const entry = _normaliseEntry(value);
      entry.provenance = _clone(meta && meta.provenance || entry.provenance);
      entry.updatedAt = (meta && meta.updatedAt) || entry.updatedAt || new Date().toISOString();
      entry.sourcePlugin = (meta && meta.sourcePlugin) || entry.sourcePlugin || null;
      next[key] = entry;
      return UA.AnalysisPipeline.createDataRegistry(next);
    },

    getData: function getData(registry, key) {
      const entry = registry && registry.entries && registry.entries[key];
      return entry ? _clone(entry.value) : null;
    },

    describeData: function describeData(registry, key) {
      const entry = registry && registry.entries && registry.entries[key];
      return entry ? _clone(entry) : null;
    },

    hasData: function hasData(registry, key) {
      const entry = registry && registry.entries && registry.entries[key];
      return !!(entry && _hasDataValue(entry.value));
    },

    listDataKeys: function listDataKeys(registry) {
      return Object.keys((registry && registry.entries) || {});
    },

    fromTrafficSituation: function fromTrafficSituation(ts, seedEntries) {
      return _buildDataRegistry(ts, seedEntries);
    },

    createCapabilityRegistry: function createCapabilityRegistry(overrides) {
      return _buildCapabilityRegistry(UA.AnalysisPipeline.createDataRegistry(), overrides);
    },

    deriveCapabilities: function deriveCapabilities(dataRegistry, overrides) {
      return _buildCapabilityRegistry(dataRegistry, overrides);
    },

    hasCapability: function hasCapability(capabilityRegistry, name) {
      return !!(capabilityRegistry
        && capabilityRegistry.capabilities
        && capabilityRegistry.capabilities[name]
        && capabilityRegistry.capabilities[name].available);
    },

    listCapabilities: function listCapabilities(capabilityRegistry) {
      return Object.keys((capabilityRegistry && capabilityRegistry.capabilities) || {});
    },

    createPlugin: function createPlugin(definition) {
      if (!definition || typeof definition !== 'object') {
        throw new Error('AnalysisPipeline.createPlugin: definition is required');
      }
      if (!definition.id) throw new Error('AnalysisPipeline.createPlugin: plugin.id is required');
      if (typeof definition.run !== 'function') throw new Error('AnalysisPipeline.createPlugin: plugin.run is required');
      return Object.freeze({
        id:                   definition.id,
        name:                 definition.name || definition.id,
        description:          definition.description || '',
        requiredData:         _unique(definition.requiredData),
        optionalData:         _unique(definition.optionalData),
        requiredCapabilities: _unique(definition.requiredCapabilities),
        optionalCapabilities: _unique(definition.optionalCapabilities),
        producedArtifacts:    _unique(definition.producedArtifacts),
        dependsOn:            _unique(definition.dependsOn),
        supportsPartialData:  definition.supportsPartialData === true,
        supports:             typeof definition.supports === 'function' ? definition.supports : function supports() { return true; },
        run:                  definition.run
      });
    },

    createPluginRegistry: function createPluginRegistry(plugins) {
      const byId = {};
      (plugins || []).forEach((plugin) => {
        const normalised = UA.AnalysisPipeline.createPlugin(plugin);
        if (_hasOwn(byId, normalised.id)) {
          throw new Error('AnalysisPipeline.createPluginRegistry: duplicate plugin id ' + normalised.id);
        }
        byId[normalised.id] = normalised;
      });
      return Object.freeze({ plugins: Object.freeze(byId) });
    },

    registerPlugin: function registerPlugin(registry, plugin) {
      const byId = Object.assign({}, (registry && registry.plugins) || {});
      const normalised = UA.AnalysisPipeline.createPlugin(plugin);
      if (_hasOwn(byId, normalised.id)) {
        throw new Error('AnalysisPipeline.registerPlugin: duplicate plugin id ' + normalised.id);
      }
      byId[normalised.id] = normalised;
      return Object.freeze({ plugins: Object.freeze(byId) });
    },

    listPlugins: function listPlugins(registry) {
      return Object.keys((registry && registry.plugins) || {}).map((id) => registry.plugins[id]);
    },

    createContext: function createContext(opts) {
      const options = opts || {};
      const dataRegistry = options.dataRegistry || UA.AnalysisPipeline.createDataRegistry();
      const capabilityRegistry = options.capabilityRegistry || UA.AnalysisPipeline.deriveCapabilities(dataRegistry);
      const resultMap = Object.assign({}, options.resultMap || {});
      return Object.freeze({
        trafficSituation: _clone(options.trafficSituation || null),
        dataRegistry: dataRegistry,
        capabilityRegistry: capabilityRegistry,
        resultMap: _clone(resultMap),
        getData: function getData(key) { return UA.AnalysisPipeline.getData(dataRegistry, key); },
        describeData: function describeData(key) { return UA.AnalysisPipeline.describeData(dataRegistry, key); },
        hasData: function hasData(key) { return UA.AnalysisPipeline.hasData(dataRegistry, key); },
        hasCapability: function hasCapability(name) { return UA.AnalysisPipeline.hasCapability(capabilityRegistry, name); },
        getResult: function getResult(pluginId) { return _clone(resultMap[pluginId] || null); }
      });
    },

    runPipeline: async function runPipeline(opts) {
      const options = opts || {};
      const registry = options.pluginRegistry || UA.AnalysisPipeline.createPluginRegistry(options.plugins || []);
      const pluginsById = (registry && registry.plugins) || {};
      const orderedPlugins = _topoSortPlugins(pluginsById);

      let dataRegistry = options.dataRegistry
        ? UA.AnalysisPipeline.createDataRegistry((options.dataRegistry && options.dataRegistry.entries) || options.dataRegistry)
        : UA.AnalysisPipeline.fromTrafficSituation(options.trafficSituation || null, options.seedData);

      if (options.dataRegistry && options.seedData) {
        Object.keys(options.seedData).forEach((key) => {
          dataRegistry = UA.AnalysisPipeline.setData(dataRegistry, key, options.seedData[key]);
        });
      }

      let capabilityRegistry = options.capabilityRegistry
        || UA.AnalysisPipeline.deriveCapabilities(dataRegistry, options.capabilityOverrides);

      const results = [];
      const resultMap = {};

      for (const plugin of orderedPlugins) {
        const context = UA.AnalysisPipeline.createContext({
          trafficSituation: options.trafficSituation || null,
          dataRegistry: dataRegistry,
          capabilityRegistry: capabilityRegistry,
          resultMap: resultMap
        });

        const missingRequiredData = plugin.requiredData.filter((key) => !UA.AnalysisPipeline.hasData(dataRegistry, key));
        const missingRequiredCapabilities = plugin.requiredCapabilities.filter((name) => !UA.AnalysisPipeline.hasCapability(capabilityRegistry, name));
        const missingOptionalData = plugin.optionalData.filter((key) => !UA.AnalysisPipeline.hasData(dataRegistry, key));
        const missingOptionalCapabilities = plugin.optionalCapabilities.filter((name) => !UA.AnalysisPipeline.hasCapability(capabilityRegistry, name));

        let result;
        if (await plugin.supports(context) === false) {
          result = {
            pluginId:                    plugin.id,
            pluginName:                  plugin.name,
            status:                      PLUGIN_STATUSES.SKIPPED,
            producedArtifacts:           {},
            missingOptionalData:         missingOptionalData,
            missingOptionalCapabilities: missingOptionalCapabilities,
            missingRequiredData:         missingRequiredData,
            missingRequiredCapabilities: missingRequiredCapabilities,
            warnings:                    ['Plugin support check returned false.'],
            confidence:                  null,
            completeness:                0,
            provenance:                  _defaultProvenance(plugin, context)
          };
        } else if (missingRequiredData.length || missingRequiredCapabilities.length) {
          result = {
            pluginId:                    plugin.id,
            pluginName:                  plugin.name,
            status:                      PLUGIN_STATUSES.SKIPPED,
            producedArtifacts:           {},
            missingOptionalData:         missingOptionalData,
            missingOptionalCapabilities: missingOptionalCapabilities,
            missingRequiredData:         missingRequiredData,
            missingRequiredCapabilities: missingRequiredCapabilities,
            warnings:                    ['Required inputs are unavailable.'],
            confidence:                  null,
            completeness:                0,
            provenance:                  _defaultProvenance(plugin, context)
          };
        } else if (!plugin.supportsPartialData && (missingOptionalData.length || missingOptionalCapabilities.length)) {
          result = {
            pluginId:                    plugin.id,
            pluginName:                  plugin.name,
            status:                      PLUGIN_STATUSES.SKIPPED,
            producedArtifacts:           {},
            missingOptionalData:         missingOptionalData,
            missingOptionalCapabilities: missingOptionalCapabilities,
            missingRequiredData:         [],
            missingRequiredCapabilities: [],
            warnings:                    ['Plugin does not support partial data.'],
            confidence:                  null,
            completeness:                0,
            provenance:                  _defaultProvenance(plugin, context)
          };
        } else {
          try {
            const raw = await plugin.run(context) || {};
            const producedArtifacts = _normaliseProducedArtifacts(raw.producedArtifacts || {}, plugin.producedArtifacts);
            const warnings = _unique((raw.warnings || []).map(String));
            const hasMissingOptional = missingOptionalData.length > 0 || missingOptionalCapabilities.length > 0;
            const status = raw.status || (hasMissingOptional ? PLUGIN_STATUSES.PARTIAL : PLUGIN_STATUSES.COMPLETE);
            const completeness = typeof raw.completeness === 'number'
              ? raw.completeness
              : (hasMissingOptional
                  ? Math.max(0, 1 - ((missingOptionalData.length + missingOptionalCapabilities.length)
                    / Math.max(1, plugin.optionalData.length + plugin.optionalCapabilities.length)))
                  : 1);
            result = {
              pluginId:                    plugin.id,
              pluginName:                  plugin.name,
              status:                      status,
              producedArtifacts:           producedArtifacts,
              missingOptionalData:         _unique((raw.missingOptionalData || []).concat(missingOptionalData)),
              missingOptionalCapabilities: _unique((raw.missingOptionalCapabilities || []).concat(missingOptionalCapabilities)),
              missingRequiredData:         _unique(raw.missingRequiredData || []),
              missingRequiredCapabilities: _unique(raw.missingRequiredCapabilities || []),
              warnings:                    warnings,
              confidence:                  typeof raw.confidence === 'number' ? raw.confidence : null,
              completeness:                Math.max(0, Math.min(1, completeness)),
              provenance:                  _defaultProvenance(plugin, context, raw.provenance)
            };

            if (status !== PLUGIN_STATUSES.SKIPPED && status !== PLUGIN_STATUSES.FAILED) {
              Object.keys(producedArtifacts).forEach((key) => {
                dataRegistry = UA.AnalysisPipeline.setData(dataRegistry, key, producedArtifacts[key], {
                  sourcePlugin: plugin.id,
                  provenance: Object.assign({}, result.provenance, {
                    artifactKey: key,
                    status: result.status
                  })
                });
              });
              capabilityRegistry = UA.AnalysisPipeline.deriveCapabilities(dataRegistry, options.capabilityOverrides);
            }
          } catch (err) {
            result = {
              pluginId:                    plugin.id,
              pluginName:                  plugin.name,
              status:                      PLUGIN_STATUSES.FAILED,
              producedArtifacts:           {},
              missingOptionalData:         missingOptionalData,
              missingOptionalCapabilities: missingOptionalCapabilities,
              missingRequiredData:         [],
              missingRequiredCapabilities: [],
              warnings:                    [err && err.message ? err.message : String(err)],
              confidence:                  null,
              completeness:                0,
              provenance:                  _defaultProvenance(plugin, context, {
                error: err && err.message ? err.message : String(err)
              })
            };
          }
        }

        results.push(result);
        resultMap[plugin.id] = _clone(result);
      }

      return {
        dataRegistry: dataRegistry,
        capabilityRegistry: capabilityRegistry,
        results: results,
        resultMap: resultMap,
        orderedPluginIds: orderedPlugins.map((plugin) => plugin.id)
      };
    }
  };

})();
