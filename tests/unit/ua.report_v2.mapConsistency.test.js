/**
 * Unit tests for the map↔table consistency helpers added to ua.report_v2.js
 * (Tasks 1, 3, 5, 6, 7 of the PDF map-generation spec).
 */

describe('UA.report_v2 – map/table consistency helpers', () => {
  let UA;

  beforeEach(() => {
    // Provide minimal window globals so the IIFE module loads cleanly.
    window.UA = {};
    window.leafletImage = () => {};
    window.docx = require('docx');
    const pdfMakeLib = require('pdfmake/build/pdfmake');
    const pdfFonts = require('pdfmake/build/vfs_fonts');
    pdfMakeLib.vfs = pdfFonts;
    window.pdfMake = pdfMakeLib;
    window.saveAs = jest.fn();

    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../js/ua.report_v2.js'), 'utf8');
    eval(src);
    UA = window.UA;
  });

  afterEach(() => {
    delete window.UA;
    delete window.leafletImage;
    delete window.docx;
    delete window.pdfMake;
    delete window.saveAs;
  });

  describe('mapVerificationSentence (Task 6)', () => {
    test('produces the exact mandated German sentence', () => {
      expect(UA.mapVerificationSentence(16)).toBe(
        'Die dargestellten Punkte entsprechen exakt den in der Tabelle aufgeführten Unfällen (n = 16).'
      );
    });
    test('clamps invalid input to 0', () => {
      expect(UA.mapVerificationSentence(NaN)).toContain('(n = 0)');
      expect(UA.mapVerificationSentence(undefined)).toContain('(n = 0)');
      expect(UA.mapVerificationSentence(-3)).toContain('(n = 0)');
      expect(UA.mapVerificationSentence(7.9)).toContain('(n = 7)');
    });
  });

  describe('countPointsInBounds (Task 5)', () => {
    test('counts only points that lie inside the bbox', () => {
      const points = [
        { lat: 52.5, lon: 13.4 },         // inside
        { lat: 52.50001, lon: 13.40001 }, // inside
        { lat: 53.0, lon: 13.4 },         // outside (north)
        { lat: 52.5, lon: 14.0 },         // outside (east)
        { lat: NaN, lon: 13.4 }           // ignored
      ];
      const bounds = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };
      expect(UA._countPointsInBounds(points, bounds)).toBe(2);
    });
    test('returns 0 for missing/invalid bounds or points', () => {
      expect(UA._countPointsInBounds([], { south: 0, west: 0, north: 1, east: 1 })).toBe(0);
      expect(UA._countPointsInBounds([{ lat: 1, lon: 1 }], null)).toBe(0);
      expect(UA._countPointsInBounds(null, { south: 0, west: 0, north: 1, east: 1 })).toBe(0);
    });
  });

  describe('boundsToBbox', () => {
    test('reads a Leaflet-style bounds object via getters', () => {
      const ll = {
        getSouth: () => 52.4, getWest: () => 13.3,
        getNorth: () => 52.6, getEast: () => 13.5
      };
      expect(UA._boundsToBbox(ll)).toEqual({ south: 52.4, west: 13.3, north: 52.6, east: 13.5 });
    });
    test('passes through a plain bbox object', () => {
      const bbox = { south: 52.4, west: 13.3, north: 52.6, east: 13.5 };
      expect(UA._boundsToBbox(bbox)).toEqual(bbox);
    });
    test('returns null for unusable input', () => {
      expect(UA._boundsToBbox(null)).toBeNull();
      expect(UA._boundsToBbox({ south: 1 })).toBeNull();
    });
  });

  describe('buildWerkbankUrl (Tasks 1, 3) – per-map override', () => {
    test('per-cluster override produces a unique URL with cluster bbox + center + zoom', () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: {
          getCenter: () => ({ lat: 52.37, lng: 9.73 }),
          getZoom: () => 12
        },
        selectionBounds: {
          getSouth: () => 52.30, getWest: () => 9.70,
          getNorth: () => 52.40, getEast: () => 9.80
        }
      };
      const overviewUrl = UA.buildWerkbankUrl(ctx);
      const clusterUrl = UA.buildWerkbankUrl(ctx, {
        bounds: { south: 52.371, west: 9.731, north: 52.372, east: 9.732 },
        center: { lat: 52.3715, lon: 9.7315 },
        zoom: 18
      });
      // Tasks 1 + 3: cluster URL must override bbox, center and zoom and
      // therefore differ from the overview URL.
      expect(clusterUrl).not.toBe(overviewUrl);

      const overviewParams = new URL(overviewUrl).searchParams;
      const clusterParams = new URL(clusterUrl).searchParams;

      expect(overviewParams.get('selSouth')).toBe('52.300000');
      expect(clusterParams.get('selSouth')).toBe('52.371000');
      expect(clusterParams.get('selWest')).toBe('9.731000');
      expect(clusterParams.get('selNorth')).toBe('52.372000');
      expect(clusterParams.get('selEast')).toBe('9.732000');
      expect(clusterParams.get('centerLat')).toBe('52.371500');
      expect(clusterParams.get('centerLon')).toBe('9.731500');
      expect(clusterParams.get('zoom')).toBe('18');
    });

    test('two distinct cluster overrides yield two distinct URLs (no duplicates)', () => {
      const ctx = {
        CITY_RAW: 'Hannover',
        map: { getCenter: () => ({ lat: 52.37, lng: 9.73 }), getZoom: () => 12 }
      };
      const a = UA.buildWerkbankUrl(ctx, {
        bounds: { south: 52.371, west: 9.731, north: 52.372, east: 9.732 },
        center: { lat: 52.3715, lon: 9.7315 }, zoom: 18
      });
      const b = UA.buildWerkbankUrl(ctx, {
        bounds: { south: 52.380, west: 9.740, north: 52.381, east: 9.741 },
        center: { lat: 52.3805, lon: 9.7405 }, zoom: 17
      });
      expect(a).not.toBe(b);
    });
  });
});
