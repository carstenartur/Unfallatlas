'use strict';

const fs = require('fs');
const path = require('path');

function loadMapScene(extraWin) {
  const win = Object.assign({ UA: {}, location: { href: 'http://localhost/' } }, extraWin || {});
  (function (window) {
    eval(fs.readFileSync(path.resolve(__dirname, '../../js/ua.map_scene.js'), 'utf8'));
  })(win);
  return win.UA;
}

describe('UA.MapScene', () => {
  let UA;
  beforeEach(() => { UA = loadMapScene(); });

  describe('create', () => {
    test('returns a default MapScene with expected shapes', () => {
      const scene = UA.MapScene.create();
      expect(scene.city).toBe('');
      expect(scene.center).toBeNull();
      expect(scene.zoom).toBeNull();
      expect(scene.selection).toBeNull();
      expect(scene.accidentView).toBe('bySeverity');
      expect(scene.filters.severity).toBe('all');
      expect(scene.filters.involvementMode).toBe('or');
      expect(scene.filters.includeCyclist).toBe(true);
      expect(scene.filters.contextFilters.slopeClasses).toEqual([]);
      expect(scene.layers.showCluster).toBe(true);
      expect(scene.layers.showHeatmap).toBe(true);
      expect(scene.layers.showOnlyAboveAverage).toBe(false);
      expect(scene.contextOverlays.active.slope).toBe(false);
    });

    test('merges overrides without mutating defaults', () => {
      const scene = UA.MapScene.create({ city: 'Berlin', filters: { severity: '1' } });
      expect(scene.city).toBe('Berlin');
      expect(scene.filters.severity).toBe('1');
      // other filter defaults preserved
      expect(scene.filters.dayType).toBe('all');
      expect(scene.filters.includeCyclist).toBe(true);
      // layers defaults preserved
      expect(scene.layers.showCluster).toBe(true);
    });

    test('deep-merges layers', () => {
      const scene = UA.MapScene.create({ layers: { showCluster: false } });
      expect(scene.layers.showCluster).toBe(false);
      expect(scene.layers.showHeatmap).toBe(true); // default preserved
    });

    test('deep-merges contextOverlays.active', () => {
      const scene = UA.MapScene.create({ contextOverlays: { active: { slope: true } } });
      expect(scene.contextOverlays.active.slope).toBe(true);
      expect(scene.contextOverlays.active.traffic).toBe(false); // default preserved
    });

    test('deep-merges filters.contextFilters', () => {
      const scene = UA.MapScene.create({
        filters: { contextFilters: { slopeClasses: ['steep'] } }
      });
      expect(scene.filters.contextFilters.slopeClasses).toEqual(['steep']);
      expect(scene.filters.contextFilters.onlyMatchedWays).toBe(false); // default preserved
    });

    test('returns independent objects on each call', () => {
      const a = UA.MapScene.create();
      const b = UA.MapScene.create();
      a.city = 'X';
      expect(b.city).toBe('');
    });
  });

  describe('fromCtx', () => {
    test('returns default scene for null ctx', () => {
      const scene = UA.MapScene.fromCtx(null);
      expect(scene.city).toBe('');
    });

    test('extracts city from ctx.CITY_RAW', () => {
      const scene = UA.MapScene.fromCtx({ CITY_RAW: 'Hamburg' });
      expect(scene.city).toBe('Hamburg');
    });

    test('extracts center and zoom from ctx.map', () => {
      const map = {
        getCenter: () => ({ lat: 53.55, lng: 9.99 }),
        getZoom:   () => 14
      };
      const scene = UA.MapScene.fromCtx({ map });
      expect(scene.center).toEqual({ lat: 53.55, lon: 9.99 });
      expect(scene.zoom).toBe(14);
    });

    test('returns null center when map has no getCenter', () => {
      const scene = UA.MapScene.fromCtx({ map: {} });
      expect(scene.center).toBeNull();
    });

    test('extracts selection from ctx.selectionBounds', () => {
      const selectionBounds = {
        getSouth: () => 51.0,
        getWest:  () => 10.0,
        getNorth: () => 52.0,
        getEast:  () => 11.0
      };
      const scene = UA.MapScene.fromCtx({ selectionBounds });
      expect(scene.selection).toEqual({ south: 51.0, west: 10.0, north: 52.0, east: 11.0 });
    });

    test('extracts layer visibility from ctx', () => {
      const scene = UA.MapScene.fromCtx({
        showCluster: false, showHeatmap: true, showOnlyAboveAverage: true
      });
      expect(scene.layers.showCluster).toBe(false);
      expect(scene.layers.showHeatmap).toBe(true);
      expect(scene.layers.showOnlyAboveAverage).toBe(true);
    });

    test('extracts contextFilters as plain arrays', () => {
      const ctx = {
        contextFilters: {
          slopeClasses:    new Set(['steep', 'very_steep']),
          trafficClasses:  new Set(['high']),
          onlyMatchedWays: true
        }
      };
      const scene = UA.MapScene.fromCtx(ctx);
      expect(scene.filters.contextFilters.slopeClasses.sort()).toEqual(['steep', 'very_steep']);
      expect(scene.filters.contextFilters.trafficClasses).toEqual(['high']);
      expect(scene.filters.contextFilters.onlyMatchedWays).toBe(true);
    });

    test('extracts UI filter values', () => {
      const ui = {
        severityEl:      { value: '1' },
        dayTypeEl:       { value: 'weekend' },
        roadConditionEl: { value: 'wet' },
        hFromEl:         { value: '8' },
        hToEl:           { value: '18' },
        maxPointsEl:     { value: '5000' },
        viewportPaddingEl: { value: '10' },
        heatRadiusEl:    { value: '30' },
        incBikeEl:       { checked: true },
        incPedEl:        { checked: false },
        incCarEl:        { checked: true },
        incMotoEl:       { checked: false },
        incGkfzEl:       { checked: false },
        incSonEl:        { checked: false }
      };
      const scene = UA.MapScene.fromCtx({ ui, involvementMode: 'and' });
      expect(scene.filters.severity).toBe('1');
      expect(scene.filters.dayType).toBe('weekend');
      expect(scene.filters.hourFrom).toBe(8);
      expect(scene.filters.hourTo).toBe(18);
      expect(scene.filters.maxPoints).toBe(5000);
      expect(scene.filters.involvementMode).toBe('and');
    });
  });
});
