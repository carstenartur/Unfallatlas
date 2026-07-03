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
  loadModule('../../js/ua.pilot_plugin.js', win);
  return win.UA;
}

describe('UA.PilotPlugin (accident-statistics)', () => {
  let UA;

  beforeEach(() => { UA = makeUA(); });

  test('exposes SEVERITY_KEYS, computeAccidentStatistics and ACCIDENT_STATISTICS plugin definition', () => {
    expect(UA.PilotPlugin.SEVERITY_KEYS.FATAL).toBe('fatal');
    expect(UA.PilotPlugin.SEVERITY_KEYS.SERIOUS).toBe('serious');
    expect(UA.PilotPlugin.SEVERITY_KEYS.SLIGHT).toBe('slight');
    expect(UA.PilotPlugin.SEVERITY_KEYS.UNKNOWN).toBe('unknown');
    expect(typeof UA.PilotPlugin.computeAccidentStatistics).toBe('function');
    expect(UA.PilotPlugin.ACCIDENT_STATISTICS.id).toBe('accident-statistics');
  });

  describe('computeAccidentStatistics', () => {
    test('counts features from a GeoJSON FeatureCollection', () => {
      const data = {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: { UKATEGORIE: '1' }, geometry: null },
          { type: 'Feature', properties: { UKATEGORIE: '2' }, geometry: null },
          { type: 'Feature', properties: { UKATEGORIE: '3' }, geometry: null },
          { type: 'Feature', properties: { UKATEGORIE: '3' }, geometry: null }
        ]
      };
      const stats = UA.PilotPlugin.computeAccidentStatistics(data);
      expect(stats.total).toBe(4);
      expect(stats.bySeverity.fatal).toBe(1);
      expect(stats.bySeverity.serious).toBe(1);
      expect(stats.bySeverity.slight).toBe(2);
      expect(stats.bySeverity.unknown).toBe(0);
    });

    test('counts features from a plain array', () => {
      const data = [
        { severity: 'fatal' },
        { severity: 'slight' },
        { severity: 'slight' }
      ];
      const stats = UA.PilotPlugin.computeAccidentStatistics(data);
      expect(stats.total).toBe(3);
      expect(stats.bySeverity.fatal).toBe(1);
      expect(stats.bySeverity.slight).toBe(2);
    });

    test('counts extracted point arrays that keep feature properties under props', () => {
      const data = [
        { lat: 52.3, lon: 9.7, props: { UKATEGORIE: '1' } },
        { lat: 52.31, lon: 9.71, props: { UKATEGORIE: '2' } },
        { lat: 52.32, lon: 9.72, props: { UKATEGORIE: '3' } }
      ];
      const stats = UA.PilotPlugin.computeAccidentStatistics(data);
      expect(stats.total).toBe(3);
      expect(stats.bySeverity.fatal).toBe(1);
      expect(stats.bySeverity.serious).toBe(1);
      expect(stats.bySeverity.slight).toBe(1);
      expect(stats.bySeverity.unknown).toBe(0);
    });

    test('handles cluster-based data using cluster count', () => {
      const data = {
        clusters: [
          { id: 'c-1', count: 5 },
          { id: 'c-2', count: 3 }
        ]
      };
      const stats = UA.PilotPlugin.computeAccidentStatistics(data);
      expect(stats.total).toBe(8);
      expect(stats.bySeverity.fatal).toBe(0);
      expect(stats.bySeverity.serious).toBe(0);
      expect(stats.bySeverity.slight).toBe(0);
      expect(stats.bySeverity.unknown).toBe(8);
    });

    test('returns zero total for empty or null input', () => {
      expect(UA.PilotPlugin.computeAccidentStatistics(null).total).toBe(0);
      expect(UA.PilotPlugin.computeAccidentStatistics([]).total).toBe(0);
      expect(UA.PilotPlugin.computeAccidentStatistics({ features: [] }).total).toBe(0);
    });
  });

  describe('ACCIDENT_STATISTICS plugin in the pipeline', () => {
    test('runs to completion with full accident data and produces accidentStatistics artifact', async () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      const ts = UA.TrafficSituation.create({
        core: { viewport: { center: { lat: 52.1, lon: 9.7 }, zoom: 14 } },
        layers: {
          [LT.ACCIDENT]: {
            type: LT.ACCIDENT,
            version: 1,
            enabled: true,
            data: {
              type: 'FeatureCollection',
              features: [
                { type: 'Feature', properties: { UKATEGORIE: '1' }, geometry: null },
                { type: 'Feature', properties: { UKATEGORIE: '3' }, geometry: null }
              ]
            },
            meta: {}
          }
        }
      });

      const registry = UA.AnalysisPipeline.createPluginRegistry([UA.PilotPlugin.ACCIDENT_STATISTICS]);
      const out = await UA.AnalysisPipeline.runPipeline({ trafficSituation: ts, pluginRegistry: registry });

      expect(out.results).toHaveLength(1);
      expect(out.results[0].status).toBe('complete'); // all required + optional data present
      const artifactStats = UA.AnalysisPipeline.getData(out.dataRegistry, 'accidentStatistics');
      expect(artifactStats.total).toBe(2);
      expect(artifactStats.bySeverity.fatal).toBe(1);
      expect(artifactStats.bySeverity.slight).toBe(1);
    });

    test('runs to completion with accident data and no viewport (supportsPartialData=true)', async () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      const ts = UA.TrafficSituation.create({
        layers: {
          [LT.ACCIDENT]: {
            type: LT.ACCIDENT,
            version: 1,
            enabled: true,
            data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { UKATEGORIE: '2' }, geometry: null }] },
            meta: {}
          }
        }
      });

      const registry = UA.AnalysisPipeline.createPluginRegistry([UA.PilotPlugin.ACCIDENT_STATISTICS]);
      const out = await UA.AnalysisPipeline.runPipeline({ trafficSituation: ts, pluginRegistry: registry });

      expect(out.results[0].status).toBe('partial');
      expect(out.results[0].missingOptionalData).toContain('viewport');
      const artifactStats = UA.AnalysisPipeline.getData(out.dataRegistry, 'accidentStatistics');
      expect(artifactStats.total).toBe(1);
      expect(artifactStats.viewport).toBeUndefined();
    });

    test('skips cleanly when accident data is absent', async () => {
      const ts = UA.TrafficSituation.create();
      const registry = UA.AnalysisPipeline.createPluginRegistry([UA.PilotPlugin.ACCIDENT_STATISTICS]);
      const out = await UA.AnalysisPipeline.runPipeline({ trafficSituation: ts, pluginRegistry: registry });

      expect(out.results[0].status).toBe('skipped');
      expect(out.results[0].missingRequiredData).toContain('accidents');
      expect(UA.AnalysisPipeline.hasData(out.dataRegistry, 'accidentStatistics')).toBe(false);
    });

    test('includes viewport in the artifact when viewport data is present', async () => {
      const LT = UA.TrafficSituation.LAYER_TYPES;
      const ts = UA.TrafficSituation.create({
        core: { viewport: { center: { lat: 51.5, lon: 7.0 }, zoom: 12 } },
        layers: {
          [LT.ACCIDENT]: {
            type: LT.ACCIDENT,
            version: 1,
            enabled: true,
            data: { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { UKATEGORIE: '3' }, geometry: null }] },
            meta: {}
          }
        }
      });

      const registry = UA.AnalysisPipeline.createPluginRegistry([UA.PilotPlugin.ACCIDENT_STATISTICS]);
      const out = await UA.AnalysisPipeline.runPipeline({ trafficSituation: ts, pluginRegistry: registry });

      const artifactStats = UA.AnalysisPipeline.getData(out.dataRegistry, 'accidentStatistics');
      expect(artifactStats.viewport).toEqual({ center: { lat: 51.5, lon: 7.0 }, zoom: 12 });
    });
  });
});
