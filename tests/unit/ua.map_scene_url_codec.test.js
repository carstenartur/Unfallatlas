'use strict';

const fs = require('fs');
const path = require('path');

function loadModules(extraWin) {
  const win = Object.assign({ UA: {}, location: { href: 'http://localhost/' } }, extraWin || {});
  const load = (file) => {
    (function (window) {
      eval(fs.readFileSync(path.resolve(__dirname, '../../js/' + file), 'utf8'));
    })(win);
  };
  load('ua.map_scene.js');
  load('ua.map_scene_url_codec.js');
  return win.UA;
}

describe('UA.MapSceneUrlCodec', () => {
  let UA;
  beforeEach(() => { UA = loadModules(); });

  describe('encode / decode round-trip', () => {
    test('default scene encodes to empty string (all defaults omitted)', () => {
      const scene = UA.MapScene.create({ city: '' });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      // A truly default scene with no city should produce an empty (or near-empty) string
      // Only non-default values are included; checkboxes that equal their defaults are omitted
      const params = new URLSearchParams(encoded);
      // No city → not included
      expect(params.has('city')).toBe(false);
      // Default boolean values should not be present
      expect(params.has('showCluster')).toBe(false);
      expect(params.has('showHeatmap')).toBe(false);
    });

    test('city is preserved', () => {
      const scene = UA.MapScene.create({ city: 'Hannover' });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      const decoded = UA.MapSceneUrlCodec.decode(encoded);
      expect(decoded.city).toBe('Hannover');
    });

    test('viewport center and zoom survive round-trip', () => {
      const scene = UA.MapScene.create({
        center: { lat: 53.5753, lon: 9.9928 },
        zoom: 15
      });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      const decoded = UA.MapSceneUrlCodec.decode(encoded);
      expect(decoded.center.lat).toBeCloseTo(53.5753);
      expect(decoded.center.lon).toBeCloseTo(9.9928);
      expect(decoded.zoom).toBe(15);
    });

    test('selection rectangle survives round-trip', () => {
      const scene = UA.MapScene.create({
        selection: { south: 51.0, west: 6.0, north: 51.5, east: 7.0 }
      });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      const decoded = UA.MapSceneUrlCodec.decode(encoded);
      expect(decoded.selection).toEqual({ south: 51.0, west: 6.0, north: 51.5, east: 7.0 });
    });

    test('non-default filters survive round-trip', () => {
      const scene = UA.MapScene.create({
        filters: {
          severity: '1',
          dayType: 'weekend',
          roadCondition: 'wet',
          hourFrom: 8,
          hourTo: 20,
          involvementMode: 'and',
          includeCyclist: false,
          includeCar: false
        }
      });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      const decoded = UA.MapSceneUrlCodec.decode(encoded);
      expect(decoded.filters.severity).toBe('1');
      expect(decoded.filters.dayType).toBe('weekend');
      expect(decoded.filters.roadCondition).toBe('wet');
      expect(decoded.filters.hourFrom).toBe(8);
      expect(decoded.filters.hourTo).toBe(20);
      expect(decoded.filters.involvementMode).toBe('and');
      expect(decoded.filters.includeCyclist).toBe(false);
      expect(decoded.filters.includeCar).toBe(false);
    });

    test('layer visibility toggles survive round-trip', () => {
      const scene = UA.MapScene.create({
        layers: {
          showCluster: false,
          showHeatmap: false,
          showOnlyAboveAverage: true
        }
      });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      const decoded = UA.MapSceneUrlCodec.decode(encoded);
      expect(decoded.layers.showCluster).toBe(false);
      expect(decoded.layers.showHeatmap).toBe(false);
      expect(decoded.layers.showOnlyAboveAverage).toBe(true);
    });

    test('accidentView survives round-trip', () => {
      const scene = UA.MapScene.create({ accidentView: 'byInvolvement' });
      const decoded = UA.MapSceneUrlCodec.decode(UA.MapSceneUrlCodec.encode(scene));
      expect(decoded.accidentView).toBe('byInvolvement');
    });

    test('contextFilters (slope/traffic classes) survive round-trip', () => {
      const scene = UA.MapScene.create({
        filters: {
          contextFilters: {
            slopeClasses:    ['steep', 'very_steep'],
            trafficClasses:  ['high'],
            onlyMatchedWays: true
          }
        }
      });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      const decoded = UA.MapSceneUrlCodec.decode(encoded);
      expect(decoded.filters.contextFilters.slopeClasses.sort()).toEqual(['steep', 'very_steep']);
      expect(decoded.filters.contextFilters.trafficClasses).toEqual(['high']);
      expect(decoded.filters.contextFilters.onlyMatchedWays).toBe(true);
    });

    test('contextOverlays (mapLayer) survive round-trip', () => {
      const scene = UA.MapScene.create({
        contextOverlays: { active: { slope: true, traffic: false } }
      });
      const encoded = UA.MapSceneUrlCodec.encode(scene);
      const decoded = UA.MapSceneUrlCodec.decode(encoded);
      expect(decoded.contextOverlays.active.slope).toBe(true);
      expect(decoded.contextOverlays.active.traffic).toBe(false);
    });

    test('full MapScene survives round-trip', () => {
      const scene = UA.MapScene.create({
        city: 'Bonn',
        center: { lat: 50.73, lon: 7.10 },
        zoom: 13,
        selection: { south: 50.7, west: 7.05, north: 50.75, east: 7.15 },
        filters: {
          severity: '2', dayType: 'weekday', involvementMode: 'solo',
          hourFrom: 6, hourTo: 22, includeCyclist: true, includeCar: true,
          includeMotorcycle: true,
          contextFilters: { slopeClasses: ['gentle'], trafficClasses: [], onlyMatchedWays: false }
        },
        layers: { showCluster: true, showHeatmap: false, showArgumentation: false },
        accidentView: 'byInvolvement',
        contextOverlays: { active: { slope: false, traffic: true } }
      });
      const decoded = UA.MapSceneUrlCodec.decode(UA.MapSceneUrlCodec.encode(scene));
      expect(decoded.city).toBe('Bonn');
      expect(decoded.center.lat).toBeCloseTo(50.73);
      expect(decoded.filters.severity).toBe('2');
      expect(decoded.layers.showHeatmap).toBe(false);
      expect(decoded.accidentView).toBe('byInvolvement');
      expect(decoded.contextOverlays.active.traffic).toBe(true);
    });
  });

  describe('decode edge cases', () => {
    test('decode with leading "?" works', () => {
      const decoded = UA.MapSceneUrlCodec.decode('?city=Berlin&zoom=12');
      expect(decoded.city).toBe('Berlin');
      expect(decoded.zoom).toBe(12);
    });

    test('decode with empty string returns defaults', () => {
      const decoded = UA.MapSceneUrlCodec.decode('');
      expect(decoded.city).toBe('');
      expect(decoded.filters.severity).toBe('all');
      expect(decoded.layers.showCluster).toBe(true);
    });

    test('invalid selSouth/selNorth gives null selection', () => {
      // south >= north → invalid
      const decoded = UA.MapSceneUrlCodec.decode('?selSouth=52&selWest=9&selNorth=51&selEast=10');
      expect(decoded.selection).toBeNull();
    });

    test('missing centerLon gives null center', () => {
      const decoded = UA.MapSceneUrlCodec.decode('?centerLat=52.37');
      expect(decoded.center).toBeNull();
    });
  });
});
