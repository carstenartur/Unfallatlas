'use strict';

const fs   = require('fs');
const path = require('path');

function loadModule(filePath, win) {
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, filePath), 'utf8')); // eslint-disable-line no-eval
  })(win);
}

function makeUA() {
  const win = { UA: {}, location: { href: 'http://localhost/' } };
  loadModule('../../js/ua.map_scene.js', win);
  loadModule('../../js/ua.traffic_situation.js', win);
  loadModule('../../js/ua.analysis_pipeline.js', win);
  return win.UA;
}

describe('UA.AnalysisPipeline', () => {
  let UA;

  beforeEach(() => { UA = makeUA(); });

  test('exposes documented constant registries', () => {
    expect(UA.AnalysisPipeline.DATA_KEYS.ACCIDENTS).toBe('accidents');
    expect(UA.AnalysisPipeline.DATA_KEYS.ROAD_CONTEXT).toBe('roadContext');
    expect(UA.AnalysisPipeline.DATA_KEYS.OSM_CONTEXT).toBe('osmContext');
    expect(UA.AnalysisPipeline.DATA_KEYS.MAP_SNAPSHOT).toBe('mapSnapshot');
    expect(UA.AnalysisPipeline.DATA_KEYS.ORTHOPHOTO).toBe('orthophoto');
    expect(UA.AnalysisPipeline.CAPABILITIES.HAS_ACCIDENT_DATA).toBe('hasAccidentData');
    expect(UA.AnalysisPipeline.CAPABILITIES.HAS_AI_ASSESSMENT).toBe('hasAiAssessment');
    expect(UA.AnalysisPipeline.CAPABILITIES.HAS_OSM_DATA).toBe('hasOsmData');
    expect(UA.AnalysisPipeline.CAPABILITIES.HAS_MAP_SNAPSHOT).toBe('hasMapSnapshot');
    expect(UA.AnalysisPipeline.CAPABILITIES.HAS_ORTHOPHOTO).toBe('hasOrthophoto');
    expect(UA.AnalysisPipeline.PLUGIN_STATUSES.PARTIAL).toBe('partial');
    expect(Object.isFrozen(UA.AnalysisPipeline.DATA_KEYS)).toBe(true);
    expect(Object.isFrozen(UA.AnalysisPipeline.CAPABILITIES)).toBe(true);
  });

  test('builds data and capability registries from a TrafficSituation', () => {
    const LT = UA.TrafficSituation.LAYER_TYPES;
    const ts = UA.TrafficSituation.create({
      core: {
        viewport: { center: { lat: 52.1, lon: 9.7 }, zoom: 14 },
        selection: { south: 52.0, west: 9.6, north: 52.2, east: 9.8 }
      },
      layers: {
        [LT.ACCIDENT]: {
          type: LT.ACCIDENT,
          version: 1,
          enabled: true,
          data: { type: 'FeatureCollection', features: [{ id: 'u1' }] },
          meta: { source: 'accidents.geojson' }
        },
        [LT.POI]: {
          type: LT.POI,
          version: 1,
          enabled: true,
          data: [{ kind: 'school', id: 'poi-1' }],
          meta: {}
        },
        [LT.CONTEXT_ROAD]: {
          type: LT.CONTEXT_ROAD,
          version: 1,
          enabled: true,
          data: {
            slope: { maxPct: 4.2 },
            surface: { dominant: 'asphalt' },
            rails: [{ id: 'rail-1' }],
            trafficCounts: [{ aadt: 12000 }]
          },
          meta: {}
        },
        [LT.AI_ASSESSMENT]: {
          type: LT.AI_ASSESSMENT,
          version: 1,
          enabled: true,
          data: { summary: 'AI says hello' },
          meta: {}
        }
      }
    });

    const dataRegistry = UA.AnalysisPipeline.fromTrafficSituation(ts);
    const capabilityRegistry = UA.AnalysisPipeline.deriveCapabilities(dataRegistry);

    expect(UA.AnalysisPipeline.getData(dataRegistry, UA.AnalysisPipeline.DATA_KEYS.ACCIDENTS))
      .toEqual({ type: 'FeatureCollection', features: [{ id: 'u1' }] });
    expect(UA.AnalysisPipeline.getData(dataRegistry, UA.AnalysisPipeline.DATA_KEYS.VIEWPORT))
      .toEqual({ center: { lat: 52.1, lon: 9.7 }, zoom: 14 });
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_ACCIDENT_DATA)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_VIEWPORT)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_POI_DATA)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_ROAD_CONTEXT)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_SLOPE_DATA)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_SURFACE_DATA)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_RAIL_DATA)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_TRAFFIC_COUNTS)).toBe(true);
    expect(UA.AnalysisPipeline.hasCapability(capabilityRegistry, UA.AnalysisPipeline.CAPABILITIES.HAS_AI_ASSESSMENT)).toBe(true);

    expect(UA.AnalysisPipeline.hasData(dataRegistry, UA.AnalysisPipeline.DATA_KEYS.TRAFFIC_COUNTS)).toBe(true);
    expect(UA.AnalysisPipeline.getData(dataRegistry, UA.AnalysisPipeline.DATA_KEYS.TRAFFIC_COUNTS))
      .toEqual([{ aadt: 12000 }]);

    const accidentEntry = UA.AnalysisPipeline.describeData(dataRegistry, UA.AnalysisPipeline.DATA_KEYS.ACCIDENTS);
    expect(accidentEntry.provenance.source).toBe('trafficSituation.layers.accident');
  });

  test('runs a partial-data plugin and records missing optional inputs plus provenance', async () => {
    const LT = UA.TrafficSituation.LAYER_TYPES;
    const ts = UA.TrafficSituation.create({
      core: { viewport: { center: { lat: 52.3, lon: 9.8 }, zoom: 15 } },
      layers: {
        [LT.ACCIDENT]: {
          type: LT.ACCIDENT,
          version: 1,
          enabled: true,
          data: { clusters: [{ id: 'c-1', severity: 'high' }] },
          meta: {}
        }
      }
    });

    const pluginRegistry = UA.AnalysisPipeline.createPluginRegistry([
      {
        id: 'request-draft',
        name: 'Request Draft',
        requiredData: [
          UA.AnalysisPipeline.DATA_KEYS.ACCIDENTS,
          UA.AnalysisPipeline.DATA_KEYS.VIEWPORT
        ],
        optionalData: [
          UA.AnalysisPipeline.DATA_KEYS.POIS,
          UA.AnalysisPipeline.DATA_KEYS.ROAD_CONTEXT
        ],
        requiredCapabilities: [
          UA.AnalysisPipeline.CAPABILITIES.HAS_ACCIDENT_DATA,
          UA.AnalysisPipeline.CAPABILITIES.HAS_VIEWPORT
        ],
        optionalCapabilities: [
          UA.AnalysisPipeline.CAPABILITIES.HAS_POI_DATA,
          UA.AnalysisPipeline.CAPABILITIES.HAS_ROAD_CONTEXT
        ],
        producedArtifacts: ['requestDraft'],
        supportsPartialData: true,
        run: async (ctx) => {
          expect(ctx.trafficSituation.core.viewport.zoom).toBe(15);
          expect(ctx.getData(UA.AnalysisPipeline.DATA_KEYS.ACCIDENTS))
            .toEqual({ clusters: [{ id: 'c-1', severity: 'high' }] });
          expect(ctx.exportOptions).toBeUndefined();
          return {
            producedArtifacts: {
              requestDraft: {
                title: 'Entwurf',
                text: 'Auf Basis der Unfalldaten liegt ein erster Entwurf vor.'
              }
            },
            confidence: 0.63,
            warnings: ['POI/OSM enrichment missing.']
          };
        }
      }
    ]);

    const out = await UA.AnalysisPipeline.runPipeline({
      trafficSituation: ts,
      pluginRegistry: pluginRegistry
    });

    expect(out.orderedPluginIds).toEqual(['request-draft']);
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toEqual(expect.objectContaining({
      pluginId: 'request-draft',
      status: 'partial',
      confidence: 0.63,
      missingOptionalData: expect.arrayContaining(['pois', 'roadContext']),
      missingOptionalCapabilities: expect.arrayContaining(['hasPoiData', 'hasRoadContext'])
    }));
    expect(out.results[0].provenance.pluginId).toBe('request-draft');
    expect(out.results[0].provenance.inputs.optionalDataUsed).toEqual([]);
    expect(UA.AnalysisPipeline.getData(out.dataRegistry, 'requestDraft')).toEqual({
      title: 'Entwurf',
      text: 'Auf Basis der Unfalldaten liegt ein erster Entwurf vor.'
    });
  });

  test('skips plugins cleanly when required inputs are missing', async () => {
    const pluginRegistry = UA.AnalysisPipeline.createPluginRegistry([
      {
        id: 'political-brief',
        requiredData: [UA.AnalysisPipeline.DATA_KEYS.POLITICAL_REFERENCES],
        requiredCapabilities: [UA.AnalysisPipeline.CAPABILITIES.HAS_POLITICAL_REFERENCES],
        producedArtifacts: ['brief'],
        supportsPartialData: true,
        run: () => {
          throw new Error('should not run');
        }
      }
    ]);

    const out = await UA.AnalysisPipeline.runPipeline({
      trafficSituation: UA.TrafficSituation.create(),
      pluginRegistry: pluginRegistry
    });

    expect(out.results).toEqual([
      expect.objectContaining({
        pluginId: 'political-brief',
        status: 'skipped',
        missingRequiredData: ['politicalReferences'],
        missingRequiredCapabilities: ['hasPoliticalReferences']
      })
    ]);
    expect(UA.AnalysisPipeline.hasData(out.dataRegistry, 'brief')).toBe(false);
  });

  test('runs plugins in dependency order and exposes produced artifacts to later plugins', async () => {
    const LT = UA.TrafficSituation.LAYER_TYPES;
    const ts = UA.TrafficSituation.create({
      core: { viewport: { center: { lat: 52.4, lon: 9.7 }, zoom: 13 } },
      layers: {
        [LT.ACCIDENT]: {
          type: LT.ACCIDENT,
          version: 1,
          enabled: true,
          data: { count: 12 },
          meta: {}
        }
      }
    });

    const pluginRegistry = UA.AnalysisPipeline.createPluginRegistry([
      {
        id: 'export-writer',
        dependsOn: ['measure-engine'],
        requiredData: [UA.AnalysisPipeline.DATA_KEYS.RECOMMENDATIONS],
        producedArtifacts: [UA.AnalysisPipeline.DATA_KEYS.EXPORTS],
        supportsPartialData: true,
        run: (ctx) => ({
          producedArtifacts: {
            exports: {
              summary: `Export with ${ctx.getData(UA.AnalysisPipeline.DATA_KEYS.RECOMMENDATIONS).items.length} recommendation(s)`
            }
          },
          confidence: 0.9
        })
      },
      {
        id: 'measure-engine',
        requiredCapabilities: [UA.AnalysisPipeline.CAPABILITIES.HAS_ACCIDENT_DATA],
        producedArtifacts: [UA.AnalysisPipeline.DATA_KEYS.RECOMMENDATIONS],
        supportsPartialData: true,
        run: () => ({
          producedArtifacts: {
            recommendations: { items: [{ id: 'm-1', title: 'Tempo 30 prüfen' }] }
          },
          confidence: 0.7
        })
      }
    ]);

    const out = await UA.AnalysisPipeline.runPipeline({
      trafficSituation: ts,
      pluginRegistry: pluginRegistry
    });

    expect(out.orderedPluginIds).toEqual(['measure-engine', 'export-writer']);
    expect(out.results.map((r) => r.status)).toEqual(['complete', 'complete']);
    expect(UA.AnalysisPipeline.getData(out.dataRegistry, UA.AnalysisPipeline.DATA_KEYS.RECOMMENDATIONS))
      .toEqual({ items: [{ id: 'm-1', title: 'Tempo 30 prüfen' }] });
    expect(UA.AnalysisPipeline.getData(out.dataRegistry, UA.AnalysisPipeline.DATA_KEYS.EXPORTS))
      .toEqual({ summary: 'Export with 1 recommendation(s)' });
  });

  test('produces a failed result when plugin.supports() throws instead of aborting the pipeline', async () => {
    const pluginRegistry = UA.AnalysisPipeline.createPluginRegistry([
      {
        id: 'throws-on-supports',
        requiredData: [],
        producedArtifacts: [],
        supports: () => { throw new Error('supports boom'); },
        run: () => ({ producedArtifacts: {} })
      },
      {
        id: 'runs-after',
        requiredData: [],
        producedArtifacts: ['afterArtifact'],
        run: () => ({ producedArtifacts: { afterArtifact: { ok: true } } })
      }
    ]);

    const out = await UA.AnalysisPipeline.runPipeline({
      trafficSituation: UA.TrafficSituation.create(),
      pluginRegistry: pluginRegistry
    });

    expect(out.results).toHaveLength(2);
    const failedResult = out.results.find((r) => r.pluginId === 'throws-on-supports');
    expect(failedResult.status).toBe('failed');
    expect(failedResult.warnings[0]).toContain('supports boom');

    const afterResult = out.results.find((r) => r.pluginId === 'runs-after');
    expect(afterResult.status).toBe('complete');
    expect(UA.AnalysisPipeline.getData(out.dataRegistry, 'afterArtifact')).toEqual({ ok: true });
  });

  test('OSM, map-snapshot and orthophoto capabilities are available when data is seeded', () => {
    const DR = UA.AnalysisPipeline;
    let dataRegistry = DR.createDataRegistry({
      [DR.DATA_KEYS.OSM_CONTEXT]:  { summary: 'road type: residential' },
      [DR.DATA_KEYS.MAP_SNAPSHOT]: { dataUrl: 'data:image/png;base64,abc' },
      [DR.DATA_KEYS.ORTHOPHOTO]:   { provider: 'DOP20', year: 2023 }
    });
    const caps = DR.deriveCapabilities(dataRegistry);

    expect(DR.hasCapability(caps, DR.CAPABILITIES.HAS_OSM_DATA)).toBe(true);
    expect(DR.hasCapability(caps, DR.CAPABILITIES.HAS_MAP_SNAPSHOT)).toBe(true);
    expect(DR.hasCapability(caps, DR.CAPABILITIES.HAS_ORTHOPHOTO)).toBe(true);

    // Absent when not seeded.
    dataRegistry = DR.createDataRegistry();
    const emptyCaps = DR.deriveCapabilities(dataRegistry);
    expect(DR.hasCapability(emptyCaps, DR.CAPABILITIES.HAS_OSM_DATA)).toBe(false);
    expect(DR.hasCapability(emptyCaps, DR.CAPABILITIES.HAS_MAP_SNAPSHOT)).toBe(false);
    expect(DR.hasCapability(emptyCaps, DR.CAPABILITIES.HAS_ORTHOPHOTO)).toBe(false);
  });

  test('capability overrides can force HAS_OSM_DATA true even without seeded data', () => {
    const DR = UA.AnalysisPipeline;
    const dataRegistry = DR.createDataRegistry();
    const caps = DR.deriveCapabilities(dataRegistry, {
      [DR.CAPABILITIES.HAS_OSM_DATA]: true
    });
    expect(DR.hasCapability(caps, DR.CAPABILITIES.HAS_OSM_DATA)).toBe(true);
  });
});
