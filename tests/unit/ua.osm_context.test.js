/**
 * Unit tests for UA.osmContext (#C4 OSM-Kontext-Anreicherung).
 */

describe('UA.osmContext', () => {
  let UA;

  beforeEach(() => {
    const fs = require('fs');
    const path = require('path');
    const mockWindow = {};
    const p = path.resolve(__dirname, '../../js/ua.osm_context.js');
    (function (window) { eval(fs.readFileSync(p, 'utf8')); })(mockWindow);
    UA = mockWindow.UA;
    UA.osmContext.clearCache();
  });

  // ── parseMaxspeed ──────────────────────────────────────────────────────────
  describe('parseMaxspeed', () => {
    test('returns numeric km/h for plain numeric strings', () => {
      expect(UA.osmContext.parseMaxspeed('30')).toBe(30);
      expect(UA.osmContext.parseMaxspeed('50')).toBe(50);
      expect(UA.osmContext.parseMaxspeed('30 km/h')).toBe(30);
      expect(UA.osmContext.parseMaxspeed('30km/h')).toBe(30);
    });
    test('converts mph to km/h (rounded)', () => {
      expect(UA.osmContext.parseMaxspeed('30 mph')).toBe(48);
    });
    test('treats walk/none/signals as null but distinguishes walk', () => {
      expect(UA.osmContext.parseMaxspeed('walk')).toBe(7);
      expect(UA.osmContext.parseMaxspeed('none')).toBeNull();
      expect(UA.osmContext.parseMaxspeed('signals')).toBeNull();
      expect(UA.osmContext.parseMaxspeed('')).toBeNull();
      expect(UA.osmContext.parseMaxspeed(undefined)).toBeNull();
    });
  });

  // ── hasCycleInfra ──────────────────────────────────────────────────────────
  describe('hasCycleInfra', () => {
    test('detects highway=cycleway and bicycle=designated', () => {
      expect(UA.osmContext.hasCycleInfra({ highway: 'cycleway' })).toBe(true);
      expect(UA.osmContext.hasCycleInfra({ highway: 'residential', bicycle: 'designated' })).toBe(true);
    });
    test('detects cycleway:* tags with positive values', () => {
      expect(UA.osmContext.hasCycleInfra({ highway: 'primary', 'cycleway:right': 'lane' })).toBe(true);
      expect(UA.osmContext.hasCycleInfra({ highway: 'primary', cycleway: 'track' })).toBe(true);
    });
    test('returns false for "no" / "separate" cycleway values', () => {
      expect(UA.osmContext.hasCycleInfra({ highway: 'primary', cycleway: 'no' })).toBe(false);
      expect(UA.osmContext.hasCycleInfra({ highway: 'primary', cycleway: 'separate' })).toBe(false);
    });
    test('returns false for plain residential streets', () => {
      expect(UA.osmContext.hasCycleInfra({ highway: 'residential', name: 'Hauptstr' })).toBe(false);
      expect(UA.osmContext.hasCycleInfra(null)).toBe(false);
    });
  });

  // ── buildQuery ─────────────────────────────────────────────────────────────
  describe('buildQuery', () => {
    test('embeds the bbox in (south,west,north,east) order and asks for tags', () => {
      const q = UA.osmContext.buildQuery({ south: 52.0, west: 9.7, north: 52.5, east: 9.9 });
      expect(q).toContain('(52,9.7,52.5,9.9)');
      expect(q).toContain('way["highway"]');
      expect(q).toContain('node["highway"="traffic_signals"]');
      expect(q).toContain('node["highway"="crossing"]');
      expect(q).toContain('out tags;');
      expect(q).toMatch(/\[out:json\]\[timeout:\d+\];/);
    });
    test('respects custom timeoutMs (clamped to ≥5 seconds in seconds unit)', () => {
      const q = UA.osmContext.buildQuery({ south: 0, west: 0, north: 1, east: 1 }, { timeoutMs: 2000 });
      expect(q).toMatch(/\[timeout:5\]/);
      const q2 = UA.osmContext.buildQuery({ south: 0, west: 0, north: 1, east: 1 }, { timeoutMs: 12000 });
      expect(q2).toMatch(/\[timeout:12\]/);
    });
  });

  // ── aggregate ──────────────────────────────────────────────────────────────
  describe('aggregate', () => {
    test('summarises maxspeed mix and picks the most common limit', () => {
      const els = [
        { type: 'way', tags: { highway: 'primary',     maxspeed: '50' } },
        { type: 'way', tags: { highway: 'primary',     maxspeed: '50' } },
        { type: 'way', tags: { highway: 'residential', maxspeed: '30' } },
        { type: 'way', tags: { highway: 'residential', maxspeed: '30' } },
        { type: 'way', tags: { highway: 'residential', maxspeed: '30' } },
        { type: 'way', tags: { highway: 'residential' } } // no maxspeed
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.summary.dominantMaxspeed).toBe(30);
      expect(out.summary.speedSampleSize).toBe(5);
      expect(out.summary.speedHistogram).toEqual({ 30: 3, 50: 2 });
      expect(out.summary.wayCount).toBe(6);
    });

    test('counts cycleway/bicycle-designated infrastructure', () => {
      const els = [
        { type: 'way', tags: { highway: 'cycleway' } },
        { type: 'way', tags: { highway: 'primary',     'cycleway:right': 'track' } },
        { type: 'way', tags: { highway: 'residential', bicycle: 'designated' } },
        { type: 'way', tags: { highway: 'residential' } }
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.summary.cycleInfraWays).toBe(3);
      expect(out.summary.cycleInfraShare).not.toBeNull();
      expect(out.summary.cycleInfraShare).toBeGreaterThan(0);
    });

    test('counts traffic signals and crossings (only as nodes)', () => {
      const els = [
        { type: 'node', tags: { highway: 'traffic_signals' } },
        { type: 'node', tags: { highway: 'traffic_signals' } },
        { type: 'node', tags: { highway: 'crossing', crossing: 'marked' } },
        { type: 'way',  tags: { highway: 'residential' } }
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.summary.trafficSignals).toBe(2);
      expect(out.summary.crossings).toBe(1);
      expect(out.summary.wayCount).toBe(1);
    });

    test('averages lanes/width while ignoring outliers and irrelevant classes', () => {
      const els = [
        { type: 'way', tags: { highway: 'primary',     lanes: '2', width: '7.5' } },
        { type: 'way', tags: { highway: 'primary',     lanes: '4', width: '12'  } },
        { type: 'way', tags: { highway: 'service',     lanes: '1' } },           // ignored (service)
        { type: 'way', tags: { highway: 'cycleway',    width: '2.0' } },         // ignored (cycleway)
        { type: 'way', tags: { highway: 'residential', lanes: '99', width: '500' } } // out of range
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.summary.lanesSampleSize).toBe(2);
      expect(out.summary.avgLanes).toBe(3);
      expect(out.summary.widthSampleSize).toBe(2);
      expect(out.summary.avgWidthMeters).toBeCloseTo(9.75, 5);
    });

    test('returns the OSM source attribution', () => {
      const out = UA.osmContext.aggregate([]);
      expect(out.source).toEqual(expect.objectContaining({
        publisher: 'OpenStreetMap-Mitwirkende',
        license: 'ODbL 1.0'
      }));
    });

    test('counts station nodes for bahnhof / busbahnhof contexts', () => {
      const els = [
        { type: 'node', tags: { railway: 'station', name: 'Hbf' } },
        { type: 'node', tags: { public_transport: 'station' } },
        { type: 'node', tags: { amenity: 'bus_station' } },
        { type: 'node', tags: { amenity: 'bus_station' } }
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.contexts.trainStations).toBe(2); // railway=station + public_transport=station
      expect(out.contexts.busStations).toBe(2);
    });

    test('counts tram/light_rail ways but excludes them from highway statistics', () => {
      const els = [
        { type: 'way', tags: { railway: 'tram' } },
        { type: 'way', tags: { railway: 'light_rail' } },
        { type: 'way', tags: { highway: 'primary', maxspeed: '50' } }
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.contexts.tramTrackWays).toBe(2);
      expect(out.summary.wayCount).toBe(1);     // only highway=primary
      expect(out.summary.dominantMaxspeed).toBe(50);
    });

    test('detects cobblestone / sett surfaces', () => {
      const els = [
        { type: 'way', tags: { highway: 'residential', surface: 'cobblestone' } },
        { type: 'way', tags: { highway: 'residential', surface: 'sett' } },
        { type: 'way', tags: { highway: 'residential', surface: 'unhewn_cobblestone' } },
        { type: 'way', tags: { highway: 'residential', surface: 'asphalt' } }
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.contexts.cobblestoneWays).toBe(3);
    });

    test('detects shared foot/cycle areas via segregation tags', () => {
      const els = [
        { type: 'way', tags: { highway: 'path',     foot: 'designated', bicycle: 'designated' } },
        { type: 'way', tags: { highway: 'footway',  bicycle: 'yes' } },
        { type: 'way', tags: { highway: 'cycleway', foot: 'designated' } },
        { type: 'way', tags: { highway: 'footway',  bicycle: 'no' } }      // not mixed
      ];
      const out = UA.osmContext.aggregate(els);
      expect(out.contexts.mixedFootCycleWays).toBe(3);
    });

    test('zero counters when no relevant tags are present', () => {
      const out = UA.osmContext.aggregate([
        { type: 'way', tags: { highway: 'primary' } }
      ]);
      expect(out.contexts).toEqual({
        trainStations: 0,
        busStations: 0,
        tramTrackWays: 0,
        cobblestoneWays: 0,
        mixedFootCycleWays: 0
      });
    });
  });

  // ── buildQuery extension for tram/station/cobblestone ──────────────────────
  describe('buildQuery extensions', () => {
    test('embeds station + tram queries alongside the highway query', () => {
      const q = UA.osmContext.buildQuery({ south: 0, west: 0, north: 1, east: 1 });
      expect(q).toMatch(/node\["amenity"="bus_station"\]/);
      expect(q).toMatch(/node\["railway"="station"\]/);
      expect(q).toMatch(/node\["public_transport"="station"\]/);
      expect(q).toMatch(/way\["railway"="tram"\]/);
      expect(q).toMatch(/way\["railway"="light_rail"\]/);
    });
  });

  // ── summarizeForText ───────────────────────────────────────────────────────
  describe('summarizeForText', () => {
    test('returns null on missing input', () => {
      expect(UA.osmContext.summarizeForText(null)).toBeNull();
      expect(UA.osmContext.summarizeForText({})).toBeNull();
    });
    test('produces a single-line German summary covering all known fields', () => {
      const ctx = UA.osmContext.aggregate([
        { type: 'way', tags: { highway: 'primary', maxspeed: '50', lanes: '2' } },
        { type: 'way', tags: { highway: 'cycleway' } },
        { type: 'node', tags: { highway: 'traffic_signals' } }
      ]);
      const txt = UA.osmContext.summarizeForText(ctx);
      expect(txt).toMatch(/Tempolimit 50 km\/h/);
      expect(txt).toMatch(/Radinfrastruktur an 1 Wegabschnitt/);
      expect(txt).toMatch(/1 signalisierte Knoten/);
      expect(txt.endsWith('.')).toBe(true);
    });

    test('appends station / tram / surface context fragments when present', () => {
      const ctx = UA.osmContext.aggregate([
        { type: 'way',  tags: { highway: 'primary' } },
        { type: 'node', tags: { railway: 'station' } },
        { type: 'node', tags: { amenity: 'bus_station' } },
        { type: 'way',  tags: { railway: 'tram' } },
        { type: 'way',  tags: { highway: 'residential', surface: 'cobblestone' } },
        { type: 'way',  tags: { highway: 'footway', bicycle: 'yes' } }
      ]);
      const txt = UA.osmContext.summarizeForText(ctx);
      expect(txt).toMatch(/Bahnhof|Haltepunkt/);
      expect(txt).toMatch(/Busbahnhof/);
      expect(txt).toMatch(/Schienen/);
      expect(txt).toMatch(/Pflaster|Kopfstein/);
      expect(txt).toMatch(/gemeinsame Fuß-\/Radfläche/);
    });
  });

  // ── fetchOsmContext: cache + graceful failures ─────────────────────────────
  describe('fetchOsmContext', () => {
    test('returns null for an invalid bbox', async () => {
      const out = await UA.osmContext.fetchOsmContext({ south: NaN, west: 0, north: 1, east: 1 });
      expect(out).toBeNull();
    });

    test('builds a POST to the configured endpoint with the Overpass query in the body', async () => {
      let captured = null;
      const fakeFetch = async (url, init) => {
        captured = { url, init };
        return {
          ok: true,
          async json() {
            return { elements: [{ type: 'node', tags: { highway: 'traffic_signals' } }] };
          }
        };
      };
      const out = await UA.osmContext.fetchOsmContext(
        { south: 52, west: 9.7, north: 52.5, east: 9.9 },
        { fetch: fakeFetch, endpoint: 'https://example.test/overpass' }
      );
      expect(captured.url).toBe('https://example.test/overpass');
      expect(captured.init.method).toBe('POST');
      expect(captured.init.body).toContain('data=');
      expect(decodeURIComponent(captured.init.body)).toContain('way["highway"]');
      expect(out.summary.trafficSignals).toBe(1);
      expect(out.bbox.south).toBe(52);
      expect(out.quality.elementCount).toBe(1);
    });

    test('caches identical bboxes — second call does not hit the network', async () => {
      let calls = 0;
      const fakeFetch = async () => {
        calls++;
        return { ok: true, async json() { return { elements: [] }; } };
      };
      await UA.osmContext.fetchOsmContext({ south: 52, west: 9.7, north: 52.5, east: 9.9 },
        { fetch: fakeFetch, endpoint: 'https://example.test/overpass' });
      await UA.osmContext.fetchOsmContext({ south: 52, west: 9.7, north: 52.5, east: 9.9 },
        { fetch: fakeFetch, endpoint: 'https://example.test/overpass' });
      expect(calls).toBe(1);
    });

    test('returns a quality.error stub on HTTP failure (does NOT throw)', async () => {
      const fakeFetch = async () => ({ ok: false, status: 504, async json() { return {}; } });
      const out = await UA.osmContext.fetchOsmContext(
        { south: 52.1, west: 9.71, north: 52.51, east: 9.91 },
        { fetch: fakeFetch, endpoint: 'https://example.test/overpass' }
      );
      expect(out).not.toBeNull();
      expect(out.quality.error).toMatch(/HTTP 504/);
      expect(out.summary).toBeUndefined();
    });

    test('returns a quality.error stub on network error', async () => {
      const fakeFetch = async () => { throw new Error('boom'); };
      const out = await UA.osmContext.fetchOsmContext(
        { south: 52.2, west: 9.72, north: 52.52, east: 9.92 },
        { fetch: fakeFetch, endpoint: 'https://example.test/overpass' }
      );
      expect(out).not.toBeNull();
      expect(out.quality.error).toBe('boom');
    });
  });
});
